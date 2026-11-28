//! One-time publication of a locally owned ticket as an ordinary external issue.
//!
//! Creating the issue and recording it locally cannot be one atomic step, so the
//! workflow is built around a durable **publication attempt**:
//!
//! 1. A short write transaction checks eligibility and inserts the attempt as
//!    `in_flight`, with the exact title, description, destination and host. At
//!    most one attempt per ticket may be open (a unique partial index), which is
//!    what coordinates concurrent and replayed requests.
//! 2. No transaction is open while the connector makes the remote create call.
//! 3. A second short write settles the attempt, in the same transaction that
//!    links the confirmed external issue and transfers ownership:
//!    - `succeeded`: the connector returned the created issue.
//!    - `failed`: the provider definitely refused ([`SourceError::ruled_out_creation`]),
//!      so nothing exists. The ticket stays local and a new attempt is allowed.
//!    - `unresolved`: the outcome is unknown (timeout, dropped connection, server
//!      error, unreadable answer, or a confirmed issue that could not be recorded).
//!      The issue may exist. The ticket stays local, **blocked from another
//!      create**, until the attempt is resolved.
//!
//! A crash between the steps leaves the attempt `in_flight`. An `in_flight`
//! attempt whose lease has run out is read as `unresolved` (see
//! [`PublicationAttempt::state`]) and blocks exactly like one.
//!
//! Attempt lifecycle for a resolver (the recovery workflow):
//!
//! | stored `status` | meaning | blocks create |
//! |---|---|---|
//! | `in_flight` | create call may be running; after `lease_expires_at` it is unresolved | yes |
//! | `unresolved` | outcome unknown; `issue_*` columns are set when the issue is known | yes |
//! | `failed` | provider refused; nothing was created | no |
//! | `succeeded` | issue linked and ownership transferred | no |
//!
//! Resolving means moving an open attempt (`in_flight` past its lease, or
//! `unresolved`) to `succeeded` (linking the verified issue with
//! `tracking::link` in the same transaction) or `failed`, always with a
//! compare-and-set on the stored status, in one write transaction that holds no
//! network call.

use std::{collections::BTreeMap, fs::File};

use fs2::FileExt;
use pulldown_cmark::{Event, Parser, Tag};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    Capability, ConfiguredSource, DestinationRules, Engine, ExternalIdentity, ExternalIssue,
    ExternalRef, PublicationSearch, PublishRequest, SourceError, SourceFailure, clock,
    configured_source,
    tracking::{self, Origin, failure_of},
};
use crate::{Error, Status, Ticket, Workspace, activities, history};

/// How long an `in_flight` attempt is trusted to still be running. The HTTP
/// transport gives up after 30 seconds, so a live create finishes well inside it.
const LEASE_SECONDS: i64 = 120;
// The process host must finish or cancel the call before this dispatch window expires.
const DISPATCH_SECONDS: u64 = 300;
const DISPATCH_LEASE_SECONDS: i64 = 360;

/// Where a publication attempt stands. `InFlight` and `Unresolved` block another
/// create; `Failed` and `Succeeded` are final.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptState {
    InFlight,
    Unresolved,
    Failed,
    Succeeded,
}

impl AttemptState {
    /// The stored `status` of an attempt settled into this state by a write.
    fn stored(self) -> &'static str {
        match self {
            Self::InFlight => "in_flight",
            Self::Unresolved => "unresolved",
            Self::Failed => "failed",
            Self::Succeeded => "succeeded",
        }
    }
}

/// The external issue an attempt is known to have created. Present on a
/// succeeded attempt and on an unresolved one whose issue was seen but could not
/// be recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedIssue {
    pub identity: ExternalIdentity,
    pub locator: String,
    pub display: String,
    pub url: String,
    // Read back when resolving an attempt; the interface needs only the display.
    #[serde(skip)]
    partition: String,
}

/// One try at creating an external issue for a ticket. Holds exactly what was
/// (or would be) sent; never a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationAttempt {
    pub id: String,
    pub reference: String,
    pub provider: String,
    pub destination: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_label: Option<String>,
    /// The site that received the create request, or a legacy hostname hint.
    #[serde(default)]
    pub destination_host: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    destination_site_unconfirmed: bool,
    pub title: String,
    pub body: String,
    /// The effective state: a stored `in_flight` attempt past its lease reads
    /// as `unresolved`.
    pub state: AttemptState,
    pub started_at: String,
    #[serde(skip)]
    lease_expires_at: String,
    pub updated_at: String,
    pub failure: Option<SourceFailure>,
    pub issue: Option<PublishedIssue>,
}

impl PublicationAttempt {
    fn display_destination(&self) -> &str {
        self.destination_label
            .as_deref()
            .unwrap_or(&self.destination)
    }
}

/// Why a ticket cannot be published now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IneligibleReason {
    Trashed,
    /// A source already owns the ticket.
    ExternallyOwned,
    /// The ticket was taken over from a source: it keeps that identity as
    /// provenance, so publishing again is not offered.
    ProvenanceRetained,
    /// Done, Canceled and Duplicate tickets are not published in this version.
    Status,
    /// No saved configuration for the provider, so there is nowhere to publish.
    SourceNotConnected,
    /// The provider cannot create issues.
    Unsupported,
    /// An earlier attempt is running or its outcome is unknown.
    AttemptOpen,
    /// Workspace attachment links cannot be read by external readers.
    InternalAttachments,
    /// The chosen destination is not well formed for the provider (for GitHub,
    /// not `owner/name`), so publishing would be refused.
    InvalidDestination,
    /// The source lists the destinations it may publish to and the chosen one is
    /// not among them, so ticket text cannot be sent anywhere else.
    DestinationNotAllowed,
    /// Executing with a destination chosen by Project remote needs a reviewed preview.
    PreviewRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Eligibility {
    Eligible,
    Ineligible {
        reason: IneligibleReason,
        message: String,
    },
}

/// Local context explicitly excluded from publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationLocalData {
    pub activities: u64,
    pub plan: Option<String>,
    pub tags: Vec<String>,
    pub subtickets: Vec<String>,
    #[serde(default)]
    pub attachments: u64,
}

/// A workspace-only file link that external readers cannot resolve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationAttachmentLink {
    pub uri: String,
    /// Known only for identities in this workspace; foreign IDs are never resolved locally.
    pub display_name: Option<String>,
}

/// What publishing would send, shown before anything is created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationPreview {
    pub reference: String,
    pub provider: String,
    pub provider_name: String,
    /// The destination that would be used; `None` when the person must choose.
    pub destination: Option<String>,
    /// Destinations the saved configuration suggests.
    pub destinations: Vec<String>,
    /// Display labels keyed by canonical destination.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub destination_labels: BTreeMap<String, String>,
    /// Sent exactly as shown.
    pub title: String,
    pub body: String,
    /// Identifies this title, description and destination. Hand it back in
    /// [`PublishOptions::expected_fingerprint`] to publish exactly this.
    pub fingerprint: String,
    pub local: PublicationLocalData,
    #[serde(default)]
    pub internal_attachments: Vec<PublicationAttachmentLink>,
    pub eligibility: Eligibility,
    /// The open attempt blocking publication, if any.
    pub attempt: Option<PublicationAttempt>,
}

#[derive(Debug, Clone, Default)]
pub struct PublishOptions {
    /// The saved connection ID. Defaults to the sole connection that can publish.
    pub connection: Option<String>,
    /// Connector-defined destination such as `owner/name`. Defaults to the
    /// listed Project remote, or to the sole listed destination.
    pub destination: Option<String>,
    /// The time to record, as RFC 3339; the database clock when absent.
    pub now: Option<String>,
    /// The [`PublicationPreview::fingerprint`] the person reviewed. When given,
    /// publishing is refused if the title, description or destination changed
    /// since, so exactly what was previewed is what is sent. Required when
    /// publishing to the destination selected by Project remote.
    pub expected_fingerprint: Option<String>,
    /// Who asked, recorded on the history and on any note it keeps.
    pub agent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishOutcome {
    pub ticket: Ticket,
    pub attempt: PublicationAttempt,
    /// The ticket had already been published; nothing was sent this time.
    pub replayed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PublicationError {
    #[error("{message}")]
    Ineligible {
        reference: String,
        reason: IneligibleReason,
        message: String,
    },
    /// The create call failed in a way that proves nothing was created.
    #[error("{reference} was not published and remains a local ticket: {source}")]
    Failed {
        reference: String,
        attempt_id: String,
        #[source]
        source: SourceError,
    },
    /// The outcome is unknown. The ticket stays local and cannot be published
    /// again until the attempt is resolved.
    #[error(
        "{reference}: {message} The issue may already exist, so publishing again is blocked until this is resolved"
    )]
    Unresolved {
        reference: String,
        attempt_id: String,
        message: String,
    },
    /// The ticket's title or description, or the destination, no longer match
    /// what the person previewed. Nothing was sent.
    #[error(
        "{reference} changed since it was previewed, so nothing was sent; review the preview again."
    )]
    ChangedSincePreview { reference: String },
    /// The named issue does not hold the title and description that were sent, so
    /// it may be an unrelated issue. Attaching it replaces this ticket's text with
    /// the issue's, which only a person who has seen the difference may accept
    /// ([`ResolveOptions::accept_different_content`]). Nothing was changed.
    #[error(
        "{}: {} does not hold what ticketd sent: {}. Attaching it would replace this ticket's text with the issue's; confirm only if it is the issue this publication created",
        .0.reference,
        .0.issue.display,
        difference(.0.title_differs, .0.body_differs, &.0.issue_title, &.0.sent_title)
    )]
    DifferentContent(Box<ContentDifference>),
    /// Resolution was asked for a ticket with no uncertain attempt.
    #[error("{reference} has no uncertain publication to resolve")]
    NothingToResolve { reference: String },
    /// The create call may still be running; wait for it to finish or expire.
    #[error("{reference} is still being published; wait until that finishes before resolving it")]
    StillRunning {
        reference: String,
        attempt_id: String,
    },
    /// The source could not give the evidence needed. The attempt stays
    /// unresolved: this is not proof that anything was or was not created.
    #[error(
        "{reference}: this could not be verified ({source}). The attempt stays unresolved; nothing was changed"
    )]
    Unverified {
        reference: String,
        attempt_id: String,
        #[source]
        source: SourceError,
    },
    /// The named issue cannot be the result of this attempt, or the answer asked
    /// for contradicts what is known.
    #[error("{reference}: {message}")]
    Mismatch {
        reference: String,
        attempt_id: String,
        message: String,
    },
    /// Issues that look like this attempt's result exist, so "nothing was
    /// created" cannot be concluded. Confirm one of them instead.
    #[error(
        "{reference}: the destination already holds {} that may be this publication ({}); confirm one of them instead of treating the attempt as failed",
        issues.len(),
        issues.iter().map(|i| i.display.as_str()).collect::<Vec<_>>().join(", ")
    )]
    Candidates {
        reference: String,
        attempt_id: String,
        issues: Vec<PublishedIssue>,
    },
    /// Another resolution settled the attempt first; nothing was changed here.
    #[error("{reference}: {message}")]
    Settled {
        reference: String,
        attempt_id: String,
        message: String,
    },
}

/// How an issue named for attaching differs from what an attempt sent.
#[derive(Debug)]
pub struct ContentDifference {
    pub reference: String,
    pub attempt_id: String,
    pub issue: PublishedIssue,
    pub title_differs: bool,
    pub body_differs: bool,
    /// What the issue holds now, and the title that was sent.
    pub issue_title: String,
    pub sent_title: String,
}

/// What differs between an issue and the sent text, for a person to read.
fn difference(title: bool, body: bool, issue_title: &str, sent_title: &str) -> String {
    let mut parts = Vec::new();
    if title {
        parts.push(format!(
            "its title is \u{201c}{issue_title}\u{201d} where ticketd sent \u{201c}{sent_title}\u{201d}"
        ));
    }
    if body {
        parts.push("its description is not the one that was sent".to_owned());
    }
    parts.join(", and ")
}

impl PublicationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ineligible { .. } => "publication_ineligible",
            Self::ChangedSincePreview { .. } => "publication_changed",
            Self::Failed { .. } => "publication_failed",
            Self::Unresolved { .. } => "publication_unresolved",
            Self::NothingToResolve { .. } => "publication_nothing_to_resolve",
            Self::StillRunning { .. } => "publication_still_running",
            Self::Unverified { .. } => "publication_unverified",
            Self::Mismatch { .. } => "publication_mismatch",
            Self::DifferentContent { .. } => "publication_different_content",
            Self::Candidates { .. } => "publication_candidates",
            Self::Settled { .. } => "publication_settled",
        }
    }
}

/// How a person settles an uncertain attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resolution {
    /// The issue was created. `issue` names it (a number, `owner/name#number` or
    /// a link in the destination); it may be left out when the attempt already
    /// recorded the issue. The source verifies it before it is attached.
    Attach { issue: Option<String> },
    /// Verify a named issue for an unbound GitHub attempt on its confirmed
    /// original host, using an explicitly chosen saved connection.
    AttachUsingConnection { issue: String, connection: String },
    /// Nothing was created. Accepted only when the source's recent issues are
    /// read completely and none could be this publication's.
    NotCreated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolveOptions {
    pub resolution: Resolution,
    /// The time to record, as RFC 3339; the database clock when absent.
    pub now: Option<String>,
    /// Who asked, recorded on the history of the outcome.
    pub agent: Option<String>,
    /// Attach an issue whose title or description differs from what was sent.
    /// The issue's text then replaces the ticket's, and the ticket's own is kept
    /// as a note. Without it such an attach is refused.
    #[serde(default)]
    pub accept_different_content: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Attach,
    NotCreated,
}

/// One way forward for an uncertain attempt, with why it is or is not offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolutionAction {
    pub kind: ActionKind,
    pub available: bool,
    pub label: String,
    pub detail: String,
}

/// What a person needs to settle an uncertain attempt: what ticketd knows, what
/// it cannot know, and the safe next actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationReview {
    pub attempt: PublicationAttempt,
    /// The original connection on this device, when its binding still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub provider_name: String,
    pub known: Vec<String>,
    pub unknown: String,
    /// Why publishing is blocked and why another try is not safe yet.
    pub note: String,
    pub actions: Vec<ResolutionAction>,
    /// Issues in the destination whose title or description equals what was sent.
    /// While any exists, "not created" is refused.
    pub candidates: Vec<PublicationCandidate>,
    /// Other issues the connected account created in the window. They may be
    /// edited results of the attempt, so they block "not created" and can be attached.
    pub other_recent: Vec<PublicationCandidate>,
    /// `None` when no search ran or it failed; `Some(true)` when the whole
    /// window was read and enough time has passed for a just-created issue to be
    /// listed (see `search_ready_at`).
    pub candidates_complete: Option<bool>,
    /// When a search first counts for a "not created" verdict (RFC 3339); a search
    /// that ran earlier cannot see an issue GitHub has not listed yet.
    pub search_ready_at: Option<String>,
    pub lookup_failure: Option<SourceFailure>,
}

/// Why an issue is listed as possibly this publication's result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateReason {
    /// Its title or description equals what was sent.
    ContentMatch,
    /// The connected account created it in the window.
    CreatedByAccount,
}

/// An issue the destination holds that may be this publication's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationCandidate {
    pub identity: ExternalIdentity,
    pub locator: String,
    pub display: String,
    pub url: String,
    pub title: String,
    pub created_at: String,
    pub reason: CandidateReason,
}

fn candidate(issue: &ExternalIssue, reason: CandidateReason) -> PublicationCandidate {
    PublicationCandidate {
        identity: issue.reference.identity.clone(),
        locator: issue.reference.locator.clone(),
        display: issue.display.clone(),
        url: issue.url.clone(),
        title: issue.title.clone(),
        created_at: issue.created_at.clone(),
        reason,
    }
}

/// A search counts for a "not created" verdict only this long after the create
/// call could last have reached the provider: the provider's listing lags behind
/// a creation by a few seconds.
const LISTING_LAG_SECONDS: i64 = 60;

/// When a search first counts for a verdict, as RFC 3339.
fn search_ready_at(dispatch_expires_at: &str) -> Option<String> {
    parse_time(dispatch_expires_at).map(|time| {
        (time + chrono::Duration::seconds(LISTING_LAG_SECONDS))
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    })
}

fn ready_text(dispatch_expires_at: &str) -> String {
    search_ready_at(dispatch_expires_at)
        .as_deref()
        .and_then(parse_time)
        .map_or_else(
            || "a few minutes from now".to_owned(),
            |time| format!("{} UTC", time.with_timezone(&chrono::Utc).format("%H:%M")),
        )
}

fn search_settled(dispatch_expires_at: &str, now: &str) -> bool {
    search_ready_at(dispatch_expires_at)
        .as_deref()
        .and_then(parse_time)
        .zip(parse_time(now))
        .is_some_and(|(ready, now)| now >= ready)
}

/// The wording of text for comparison: line endings and outer blanks are not
/// differences (GitHub normalizes both).
fn plain(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_owned()
}

/// An issue created before the attempt began cannot be its result. A few
/// minutes of tolerance absorbs clock differences with the provider.
const CLOCK_TOLERANCE_SECONDS: i64 = 300;

fn parse_time(text: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(text).ok()
}

/// The earliest instant the attempt could have created an issue.
fn search_start(started_at: &str) -> String {
    parse_time(started_at)
        .map(|time| time - chrono::Duration::seconds(CLOCK_TOLERANCE_SECONDS))
        .map(|time| {
            time.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
        .unwrap_or_else(|| started_at.to_owned())
}

fn predates(issue_created_at: &str, started_at: &str) -> bool {
    match (parse_time(issue_created_at), parse_time(started_at)) {
        (Some(created), Some(started)) => {
            created < started - chrono::Duration::seconds(CLOCK_TOLERANCE_SECONDS)
        }
        _ => false,
    }
}

/// A stable fingerprint (FNV-1a, 64 bit) of what a publication would send. It
/// detects change between a preview and the send; it is not a security measure.
fn fingerprint(
    engine: &Engine,
    provider: &str,
    connection: &str,
    ticket: &Subject,
    destination: Option<&str>,
) -> Result<String, Error> {
    let repository = destination
        .map(|destination| engine.repository_for_destination(provider, destination))
        .transpose()?
        .flatten();
    let site = if destination.is_some() && provider == super::github::PROVIDER {
        engine.issue_site(provider)?
    } else {
        None
    };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in [
        connection,
        ticket.title.as_str(),
        ticket.body.as_str(),
        destination.unwrap_or(""),
    ]
    .into_iter()
    .chain(repository.as_deref())
    .chain(site)
    {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    Ok(format!("{hash:016x}"))
}

fn configured_destination_site(
    engine: &Engine,
    provider: &str,
    destination: &str,
) -> Result<Option<String>, SourceError> {
    if provider == super::github::PROVIDER {
        return Ok(engine.issue_site(provider)?.map(str::to_owned));
    }
    Ok(engine
        .repository_for_destination(provider, destination)?
        .and_then(|repository| repository.split_once('/').map(|(host, _)| host.to_owned())))
}

fn host_configuration_error(message: String) -> SourceError {
    SourceError::InvalidConfiguration(vec![super::FieldIssue::for_field("source", message)])
}

fn confirmed_site(input: &str) -> Option<String> {
    if input.contains(['/', '?', '#', '@', '\\'])
        || input.contains(|ch: char| ch.is_whitespace() || ch.is_control())
    {
        return None;
    }
    let hostname = super::github::site_host(input);
    let host = url::Host::parse(hostname).ok()?;
    if hostname == input {
        Some(host.to_string())
    } else {
        let port = input.strip_prefix(hostname)?.strip_prefix(':')?;
        if !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let port = port.parse::<u16>().ok()?;
        Some(format!("{host}:{port}"))
    }
}

fn check_recovery_host(engine: &Engine, attempt: &PublicationAttempt) -> Result<(), SourceError> {
    if attempt.destination_site_unconfirmed {
        return Err(host_configuration_error(format!(
            "The original port of this publication is unverified. Verify its original site and run `ticketd source resolve {} --confirm-host HOST` with the nondefault port if it had one.",
            attempt.reference
        )));
    }
    let current = configured_destination_site(engine, &attempt.provider, &attempt.destination)?;
    let message = match (attempt.destination_host.as_deref(), current.as_deref()) {
        (Some(original), Some(current)) if original == current => return Ok(()),
        // Connectors that have no repository mapping do not use a host here.
        (None, None) if attempt.provider != super::github::PROVIDER => return Ok(()),
        (Some(original), Some(current)) => format!(
            "This publication was sent to {original}, but the current source uses {current}. Connect to {original} before resolving it."
        ),
        (Some(original), None) => format!(
            "The current source host could not be identified. Connect to {original} before resolving this publication."
        ),
        (None, _) => format!(
            "The original host of this publication is unknown. After verifying it, connect to that host and run `ticketd source resolve {} --confirm-host HOST`.",
            attempt.reference
        ),
    };
    Err(host_configuration_error(message))
}

fn published(issue: &ExternalIssue) -> PublishedIssue {
    PublishedIssue {
        identity: issue.reference.identity.clone(),
        locator: issue.reference.locator.clone(),
        partition: issue.reference.partition.clone(),
        display: issue.display.clone(),
        url: issue.url.clone(),
    }
}

/// Whether an open publication attempt may be waiting for exactly this issue.
/// Discovery leaves such an issue alone: importing it as a ticket of its own
/// would race the attempt that is about to claim it (a lost response is the case
/// this exists for) and leave the original ticket blocked. Once the attempt is
/// attached or ruled out, the next refresh imports the issue if it is still new.
pub(crate) fn awaited_by_open_attempt(
    connection: &Connection,
    engine: &Engine,
    issue: &ExternalIssue,
) -> Result<bool, Error> {
    let provider = &issue.reference.identity.provider;
    let is_github = provider == super::github::PROVIDER;
    let (issue_site, issue_repository) = if is_github {
        // GitHub identity keeps the port; Project remotes map repositories by hostname.
        (
            super::github::issue_id_site(&issue.reference.identity.id),
            super::github::split_locator(&issue.reference.locator)
                .ok()
                .map(|(repository, _)| repository),
        )
    } else {
        issue
            .repository
            .as_deref()
            .and_then(|remote| remote.split_once('/'))
            .map_or((None, None), |(host, repository)| {
                (Some(host), Some(repository))
            })
    };
    let mut statement = connection.prepare(
        "SELECT a.title, a.body, COALESCE(g.tracker_started_at, c.tracker_started_at, a.started_at),
                a.destination, s.derived_configuration, a.destination_host, a.destination_site_unconfirmed
         FROM publication_attempts a LEFT JOIN publication_connections c ON c.attempt_id = a.id
         LEFT JOIN source_connections s ON s.id = c.connection_id
         LEFT JOIN github_publication_context g ON g.attempt_id = a.id
         WHERE a.provider = ?1 AND a.status IN ('in_flight', 'unresolved')",
    )?;
    let attempts = statement
        .query_map([provider], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (title, body, started_at, destination, configuration, destination_host, unconfirmed) in
        attempts
    {
        if issue_site
            .zip(destination_host.as_deref())
            .is_some_and(|(observed, recorded)| {
                let observed = if is_github && unconfirmed {
                    super::github::site_host(observed)
                } else {
                    observed
                };
                observed != recorded
            })
        {
            continue;
        }
        if let Some(issue_repository) = issue_repository {
            let same_repository = if is_github {
                engine.same_destination(provider, &destination, issue_repository)?
            } else if let Some((_, repository)) = engine
                .repository_for_destination(provider, &destination)?
                .as_deref()
                .and_then(|remote| remote.split_once('/'))
            {
                engine.same_destination(provider, repository, issue_repository)?
            } else {
                true
            };
            if !same_repository {
                continue;
            }
        }
        let partition = &issue.reference.partition;
        if let Some(configuration) = configuration
            && !partition.is_empty()
        {
            let configuration: super::DerivedConfiguration = serde_json::from_str(&configuration)?;
            let rules = &configuration.publication;
            // Only use a partition as evidence when the connector's saved
            // discovery parts actually identify the publication destination.
            if configuration
                .partitions
                .iter()
                .any(|part| same_destination(rules, part, &destination))
                && !same_destination(rules, partition, &destination)
            {
                continue;
            }
        }
        if !predates(&issue.created_at, &started_at)
            && (plain(&issue.title) == plain(&title)
                || (!plain(&body).is_empty() && plain(&issue.body) == plain(&body)))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Step 26: publication attempts.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE publication_attempts (\
            id TEXT PRIMARY KEY, \
            ticket_id TEXT NOT NULL REFERENCES tickets(id), \
            provider TEXT NOT NULL, \
            destination TEXT NOT NULL, \
            title TEXT NOT NULL, \
            body TEXT NOT NULL, \
            status TEXT NOT NULL CHECK (status IN ('in_flight', 'unresolved', 'failed', 'succeeded')), \
            started_at TEXT NOT NULL, \
            lease_expires_at TEXT NOT NULL, \
            updated_at TEXT NOT NULL, \
            failure_code TEXT, \
            failure_message TEXT, \
            external_id TEXT, \
            locator TEXT, \
            display TEXT, \
            url TEXT, \
            CHECK ((external_id IS NULL) = (locator IS NULL))); \
         CREATE UNIQUE INDEX publication_attempts_open ON publication_attempts(ticket_id) WHERE status IN ('in_flight', 'unresolved'); \
         CREATE INDEX publication_attempts_ticket ON publication_attempts(ticket_id, started_at);",
    )?;
    Ok(())
}

/// Format 89: preserve the host that received a publication request.
pub(crate) fn migrate_destination_host(connection: &Connection) -> Result<(), Error> {
    crate::format::add_column_if_missing(
        connection,
        "publication_attempts",
        "destination_host",
        "TEXT",
    )?;
    // An unresolved attempt with a recorded issue has the response from its
    // original create call. A succeeded attempt may instead reflect an attachment
    // made during recovery, so its issue URL does not establish the original host.
    let mut statement = connection.prepare(
        "SELECT id, destination, external_id, locator, url FROM publication_attempts \
         WHERE provider = ?1 AND status = 'unresolved' AND destination_host IS NULL \
               AND external_id IS NOT NULL AND url IS NOT NULL",
    )?;
    let attempts = statement
        .query_map([super::github::PROVIDER], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, destination, external_id, locator, url) in attempts {
        if let Some(remote) = super::github::repository_from_issue_url(&locator, &url)
            && let Some((host, repository)) = remote.split_once('/')
            && repository.eq_ignore_ascii_case(&destination)
            && super::github::issue_id_host(&external_id) == Some(host)
        {
            connection.execute(
                "UPDATE publication_attempts SET destination_host = ?2 WHERE id = ?1",
                params![id, host],
            )?;
        }
    }
    Ok(())
}

/// Format 97: keep complete GitHub destinations, including nondefault ports.
pub(crate) fn migrate_github_destination_sites(connection: &Connection) -> Result<(), Error> {
    use super::github::{PROVIDER, issue_id_site, issue_site_from_url, site_host, split_locator};

    crate::format::add_column_if_missing(
        connection,
        "publication_attempts",
        "destination_site_unconfirmed",
        "INTEGER NOT NULL DEFAULT 0 CHECK (destination_site_unconfirmed IN (0, 1))",
    )?;
    let mut statement = connection.prepare(
        "SELECT a.id, a.destination_host, a.status, a.destination, a.external_id,
                a.locator, a.url, c.site
         FROM publication_attempts a
         LEFT JOIN publication_connections p ON p.attempt_id = a.id
         LEFT JOIN source_connections c
              ON c.id = p.connection_id AND c.provider = a.provider AND c.contract_version >= 2
         WHERE a.provider = ?1 AND a.status IN ('unresolved', 'in_flight')",
    )?;
    let attempts = statement
        .query_map([PROVIDER], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, recorded, status, destination, external_id, locator, url, binding) in attempts {
        let recorded = recorded.as_deref();
        let exact = recorded.filter(|site| *site != site_host(site));
        // Contract 1 bindings were inferred during migration. Their configured
        // site may reflect the current endpoint instead of the original port.
        let bound = binding
            .as_deref()
            .map(|site| if site.is_empty() { "github.com" } else { site })
            .filter(|site| recorded == Some(site_host(site)));
        let response = if status == "unresolved"
            && let (Some(id), Some(locator), Some(url)) = (external_id, locator, url)
            && let Ok((repository, _)) = split_locator(&locator)
            && repository.eq_ignore_ascii_case(&destination)
        {
            issue_site_from_url(&locator, &url).filter(|site| {
                issue_id_site(&id) == Some(site)
                    && recorded.is_none_or(|old| old == site_host(site))
            })
        } else {
            None
        };
        if let Some(site) = exact.or(bound).or(response.as_deref()) {
            record_publication_site(connection, &id, site)?;
        } else if recorded.is_some() {
            connection.execute(
                "UPDATE publication_attempts SET destination_site_unconfirmed = 1 WHERE id = ?1",
                [&id],
            )?;
        }
    }
    Ok(())
}

fn record_publication_site(
    connection: &Connection,
    attempt: &str,
    site: &str,
) -> Result<(), Error> {
    use super::github::{
        PROVIDER, issue_id_site, legacy_reference_partition, scope_host_only_issue_id,
        scope_legacy_issue_id, split_locator, unverified_issue_id,
    };
    connection.execute(
        "UPDATE publication_attempts
         SET destination_host = ?2, destination_site_unconfirmed = 0 WHERE id = ?1",
        params![attempt, site],
    )?;
    // A positive create response belongs to the site we verified. Older
    // responses used hostname-only IDs, even if the selected site had a port.
    let recorded: Option<(String, String, String)> = connection
        .query_row(
            "SELECT external_id, locator, destination FROM publication_attempts
             WHERE id = ?1 AND provider = ?2 AND status = 'unresolved'
               AND external_id IS NOT NULL AND locator IS NOT NULL",
            params![attempt, PROVIDER],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((external_id, locator, destination)) = recorded
        && let Ok((repository, _)) = split_locator(&locator)
        && repository.eq_ignore_ascii_case(&destination)
    {
        let external_id = scope_host_only_issue_id(&external_id, site)
            .or_else(|| {
                unverified_issue_id(&external_id)
                    .and_then(|id| scope_legacy_issue_id(id, Some(site)))
            })
            .unwrap_or(external_id);
        if issue_id_site(&external_id) == Some(site) {
            let partition = legacy_reference_partition(PROVIDER, &external_id, &locator);
            connection.execute(
                "UPDATE publication_attempts SET external_id = ?2, partition = ?3 WHERE id = ?1",
                params![attempt, external_id, partition],
            )?;
        }
    }
    Ok(())
}

const ATTEMPT_COLUMNS: &str =
    "a.id, t.reference, a.provider, a.destination, a.title, a.body, a.status, \
     a.started_at, a.updated_at, a.failure_code, a.failure_message, a.external_id, a.locator, \
     a.display, a.url, a.lease_expires_at, a.partition,
     (SELECT j.value FROM publication_connections p
      JOIN source_connections c ON c.id = p.connection_id
      JOIN json_each(c.derived_configuration, '$.publication.destination_labels') j
      WHERE p.attempt_id = a.id AND j.type = 'text'
        AND (j.key = a.destination OR (
            json_extract(c.derived_configuration, '$.publication.case_insensitive')
            AND j.key = a.destination COLLATE NOCASE
        ))
      LIMIT 1), a.destination_host, a.destination_site_unconfirmed";

/// Whether a lease has run out at `now`. Expiry is judged against the one
/// effective clock of the call (the caller's `now`, else the database clock),
/// the same instant that wrote the lease and compares it elsewhere.
fn lease_expired(lease: &str, now: &str) -> bool {
    match (parse_time(lease), parse_time(now)) {
        (Some(lease), Some(now)) => lease <= now,
        _ => lease <= now,
    }
}

fn attempt_from_row(row: &rusqlite::Row<'_>, now: &str) -> rusqlite::Result<PublicationAttempt> {
    let status: String = row.get(6)?;
    let lease: String = row.get(15)?;
    let expired = lease_expired(&lease, now);
    let provider: String = row.get(2)?;
    let failure: Option<String> = row.get(9)?;
    let message: Option<String> = row.get(10)?;
    let external_id: Option<String> = row.get(11)?;
    let locator: Option<String> = row.get(12)?;
    let display: Option<String> = row.get(13)?;
    let url: Option<String> = row.get(14)?;
    let partition: Option<String> = row.get(16)?;
    let mut failure = failure.map(|code| SourceFailure {
        code,
        message: message.unwrap_or_default(),
    });
    let state = match status.as_str() {
        "in_flight" if expired => {
            failure = Some(SourceFailure {
                code: "interrupted".into(),
                message:
                    "ticketd stopped or lost contact before learning whether the issue was created"
                        .into(),
            });
            AttemptState::Unresolved
        }
        "in_flight" => AttemptState::InFlight,
        "unresolved" => AttemptState::Unresolved,
        "failed" => AttemptState::Failed,
        "succeeded" => AttemptState::Succeeded,
        other => {
            // An unknown status is corruption, not a success.
            return Err(rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                format!("unknown publication attempt status '{other}'").into(),
            ));
        }
    };
    Ok(PublicationAttempt {
        id: row.get(0)?,
        reference: row.get::<_, String>(1)?,
        issue: external_id.zip(locator).map(|(id, locator)| {
            let partition = partition
                .or_else(|| super::legacy_reference_partition(&provider, &id, &locator))
                .unwrap_or_default();
            PublishedIssue {
                identity: ExternalIdentity {
                    provider: provider.clone(),
                    id,
                },
                partition,
                locator,
                display: display.unwrap_or_default(),
                url: url.unwrap_or_default(),
            }
        }),
        provider,
        destination: row.get(3)?,
        destination_label: row.get(17)?,
        destination_host: row.get(18)?,
        destination_site_unconfirmed: row.get(19)?,
        title: row.get(4)?,
        body: row.get(5)?,
        state,
        started_at: row.get(7)?,
        lease_expires_at: lease,
        updated_at: row.get(8)?,
        failure,
    })
}

fn open_attempt(
    connection: &Connection,
    ticket_id: &str,
    now: Option<&str>,
) -> Result<Option<PublicationAttempt>, Error> {
    let now = clock(connection, now)?;
    Ok(connection
        .prepare_cached(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
             WHERE a.ticket_id = ?1 AND a.status IN ('in_flight', 'unresolved')"
        ))?
        .query_row([ticket_id], |row| attempt_from_row(row, &now))
        .optional()?)
}

fn latest_succeeded(
    connection: &Connection,
    ticket_id: &str,
    now: Option<&str>,
) -> Result<Option<PublicationAttempt>, Error> {
    let now = clock(connection, now)?;
    Ok(connection
        .query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
                 WHERE a.ticket_id = ?1 AND a.status = 'succeeded' ORDER BY a.started_at DESC LIMIT 1"
            ),
            [ticket_id],
            |row| attempt_from_row(row, &now),
        )
        .optional()?)
}

/// Fills `Ticket.publication` with the attempt that blocks publishing, if any.
pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    ticket.publication = open_attempt(connection, &ticket.id, None)?;
    Ok(())
}

struct Subject {
    id: String,
    reference: String,
    title: String,
    body: String,
    status: Status,
    trashed: bool,
    project_remote: Option<String>,
    project_id: Option<String>,
}

fn subject(connection: &Connection, reference: &str) -> Result<Subject, Error> {
    connection
        .query_row(
            "SELECT t.id, t.reference, t.title, t.body, t.status, t.trashed, p.remote, t.project_id \
             FROM tickets t LEFT JOIN projects p ON p.id = t.project_id WHERE t.reference = ?1",
            [reference],
            |row| {
                let status: String = row.get(4)?;
                Ok(Subject {
                    id: row.get(0)?,
                    reference: row.get::<_, String>(1)?,
                    title: row.get(2)?,
                    body: row.get(3)?,
                    status: status.parse().map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    trashed: row.get(5)?,
                    project_remote: row.get(6)?,
                    project_id: row.get(7)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::NotFound(reference.to_owned()))
}

fn ineligible(reason: IneligibleReason, message: String) -> Eligibility {
    Eligibility::Ineligible { reason, message }
}

/// Everything about a ticket that decides whether it may be published, read
/// inside the transaction that acts on it.
fn eligibility(
    connection: &Connection,
    ticket: &Subject,
    now: Option<&str>,
) -> Result<Eligibility, Error> {
    let reference = &ticket.reference;
    if ticket.trashed {
        return Ok(ineligible(
            IneligibleReason::Trashed,
            format!("{reference} is in the trash; restore it to publish it"),
        ));
    }
    let owned: Option<(String, String, String, String)> = connection
        .query_row(
            "SELECT o.authority, i.origin, i.display, i.provider FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id WHERE i.ticket_id = ?1",
            [&ticket.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    match owned {
        Some((authority, origin, display, provider)) if authority == "external" => {
            let provider_name = super::provider_display_name(connection, &provider)?;
            let message = if origin == "imported" {
                format!(
                    "{reference} was imported from {display} on {provider_name}; only local tickets are published"
                )
            } else {
                format!(
                    "{reference} is already {display} on {provider_name} and is owned there; it is published only once"
                )
            };
            return Ok(ineligible(IneligibleReason::ExternallyOwned, message));
        }
        Some((_, _, display, provider)) => {
            let provider_name = super::provider_display_name(connection, &provider)?;
            return Ok(ineligible(
                IneligibleReason::ProvenanceRetained,
                format!(
                    "{reference} was {display} on {provider_name} before ownership was taken over, so it is not published again"
                ),
            ));
        }
        None => {}
    }
    if !ticket.status.is_local_progress() {
        return Ok(ineligible(
            IneligibleReason::Status,
            format!(
                "{reference} is {}; only Todo, In progress and In review tickets can be published, so finished, canceled and duplicate tickets stay local",
                ticket.status
            ),
        ));
    }
    if let Some(attempt) = open_attempt(connection, &ticket.id, now)? {
        let provider_name = super::provider_display_name(connection, &attempt.provider)?;
        let message = match attempt.state {
            AttemptState::InFlight => {
                format!(
                    "{reference} is already being published to {}",
                    attempt.display_destination()
                )
            }
            AttemptState::Unresolved | AttemptState::Failed | AttemptState::Succeeded => format!(
                "an earlier attempt to publish {reference} to {} may have created an issue on {provider_name}; resolve it before creating another",
                attempt.display_destination()
            ),
        };
        return Ok(ineligible(IneligibleReason::AttemptOpen, message));
    }
    let links = publication_attachment_links(connection, &ticket.body)?;
    if !links.is_empty() {
        let mut affected = Vec::new();
        for link in links {
            affected.push(match link.display_name {
                Some(name) => format!("{name} ({})", link.uri),
                None => link.uri,
            });
        }
        return Ok(ineligible(
            IneligibleReason::InternalAttachments,
            format!(
                "{reference} cannot be published: workspace-only attachment links in the outgoing description cannot be opened outside ticketd: {}. Remove these links from the description or replace them with URLs accessible to your readers, then preview again. Export Markdown with files to share the content separately. Direct local attachments stay in ticketd and are not automatically published; nothing was sent",
                affected.join(", ")
            ),
        ));
    }
    Ok(Eligibility::Eligible)
}

fn publication_attachment_links(
    connection: &Connection,
    body: &str,
) -> Result<Vec<PublicationAttachmentLink>, Error> {
    let mut links = crate::embedded_attachments::destinations(body);
    // Source-mode HTML and URI scheme casing must not bypass the Markdown preflight.
    for event in Parser::new(body) {
        match event {
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                if dest_url
                    .to_ascii_lowercase()
                    .starts_with("ticketd://attachment/")
                {
                    links.insert(dest_url.into_string());
                }
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                for (at, _) in html
                    .to_ascii_lowercase()
                    .match_indices("ticketd://attachment/")
                {
                    let uri = html[at..]
                        .split(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>'))
                        .next()
                        .unwrap_or_default();
                    links.insert(uri.to_owned());
                }
            }
            _ => {}
        }
    }
    links
        .into_iter()
        .map(|uri| {
            let display_name = connection
                .query_row(
                    "SELECT a.display_name FROM attachments a JOIN attachment_workspace w \
             ON ?1 = 'ticketd://attachment/' || w.id || '/' || a.id",
                    [&uri],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(PublicationAttachmentLink { uri, display_name })
        })
        .collect()
}

/// What must exist before anything can be published to `provider`: a connector
/// that can create issues and a saved configuration to publish with.
fn require_target<'a>(
    can_publish: bool,
    provider_name: &str,
    target: Option<&'a ConfiguredSource>,
) -> Result<&'a ConfiguredSource, (IneligibleReason, String)> {
    if !can_publish {
        return Err((
            IneligibleReason::Unsupported,
            format!("{provider_name} cannot create issues from ticketd"),
        ));
    }
    target.ok_or_else(|| {
        (
            IneligibleReason::SourceNotConnected,
            format!("connect {provider_name} in Settings › Ticket sources before publishing"),
        )
    })
}

fn publication_target(
    connection: &Connection,
    selected: &str,
    ticket: &Subject,
    destination: Option<&str>,
) -> Result<Option<ConfiguredSource>, Error> {
    let saved = configured_source(connection, selected)?;
    if saved.is_some() || selected != super::GITHUB_INTEGRATION {
        return Ok(saved);
    }
    let requested = destination
        .map(str::trim)
        .filter(|value| value.split('/').count() == 3)
        .map(|value| {
            super::github_integration::normalize_repository(value)
                .ok_or(Error::InvalidProjectRemote)
        })
        .transpose()?;
    let saved = github_publication_repositories(connection, ticket)?;
    let default = ticket.project_remote.as_deref().or(match saved.as_slice() {
        [only] => Some(only.as_str()),
        _ => None,
    });
    let host = requested
        .as_deref()
        .or(default)
        .and_then(|value| value.split_once('/'))
        .map_or("github.com", |(host, _)| host);
    let repositories: Vec<String> = saved
        .iter()
        .filter_map(|value| value.split_once('/'))
        .filter(|(site, _)| site == &host)
        .map(|(_, name)| name.to_owned())
        .collect();
    let project = if ticket.project_id.is_none() {
        let full = requested.clone().or_else(|| {
            let bare = destination.map(str::trim).filter(|value| !value.is_empty());
            bare.map(|bare| format!("{host}/{bare}"))
                .or_else(|| default.map(str::to_owned))
        });
        if let Some(full) = full {
            super::github_integration::project_route(connection, &full)?.map(|project| project.id)
        } else {
            None
        }
    } else {
        ticket.project_id.clone()
    };
    Ok(Some(super::github_integration::workflow_target(
        connection,
        host,
        project.as_deref(),
        &repositories,
    )?))
}

fn github_publication_repositories(
    connection: &Connection,
    ticket: &Subject,
) -> Result<Vec<String>, Error> {
    let mut statement =
        connection.prepare("SELECT repository FROM github_repository_rules ORDER BY repository")?;
    let mut repositories = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(remote) = &ticket.project_remote
        && !repositories
            .iter()
            .any(|name| name.eq_ignore_ascii_case(remote))
    {
        repositories.push(remote.to_owned());
    }
    Ok(repositories)
}

fn publication_basis<'a>(source: Option<&'a ConfiguredSource>, selected: &'a str) -> &'a str {
    source
        .filter(|source| super::github_integration::is_integration_target(source))
        .map_or(selected, |source| source.revision.as_str())
}

fn github_destination<'a>(
    source: Option<&ConfiguredSource>,
    destination: Option<&'a str>,
) -> Option<&'a str> {
    destination.map(str::trim).map(|value| {
        if source.is_some_and(super::github_integration::is_integration_target)
            && value.split('/').count() == 3
        {
            value.split_once('/').map_or(value, |(_, name)| name)
        } else {
            value
        }
    })
}

fn default_publication_connection(
    connection: &Connection,
    engine: &Engine,
) -> Result<String, Error> {
    let mut connected: Vec<_> = super::configured_sources(connection)?
        .into_iter()
        .filter(|source| engine.can_publish(&source.saved.provider))
        .map(|source| source.saved.id)
        .collect();
    if engine.can_publish(super::GITHUB_INTEGRATION)
        && !connected.iter().any(|id| id == super::GITHUB_INTEGRATION)
        && (connected.is_empty()
            || connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM github_repository_rules)",
                [],
                |row| row.get::<_, bool>(0),
            )?)
    {
        connected.push(super::GITHUB_INTEGRATION.into());
    }
    match connected.as_slice() {
        [id] => Ok(id.clone()),
        _ => Err(
            SourceError::InvalidConfiguration(vec![super::FieldIssue::for_field(
                "connection",
                if connected.is_empty() {
                    "add a source connection that can publish first".to_owned()
                } else {
                    if connected.iter().any(|id| id == super::GITHUB_INTEGRATION) {
                        let extension_ids: Vec<_> = connected
                            .iter()
                            .filter(|id| id.as_str() != super::GITHUB_INTEGRATION)
                            .cloned()
                            .collect();
                        format!(
                            "choose --provider github or select --connection from: {}",
                            extension_ids.join(", ")
                        )
                    } else {
                        format!("select --connection from: {}", connected.join(", "))
                    }
                },
            )])
            .into(),
        ),
    }
}

impl Workspace {
    /// Selects the connection for a preview when the choice is unambiguous.
    pub fn default_publication_provider(&self, engine: &Engine) -> Result<String, Error> {
        default_publication_connection(&self.connection, engine)
    }

    /// What publishing `reference` would send and whether it is allowed. Makes no
    /// network call and writes nothing.
    pub fn preview_publication(
        &self,
        engine: &Engine,
        reference: &str,
        provider: &str,
        destination: Option<&str>,
    ) -> Result<PublicationPreview, Error> {
        let connection_id = provider;
        let ticket = subject(&self.connection, reference)?;
        let target = publication_target(&self.connection, connection_id, &ticket, destination)?;
        let destination = github_destination(target.as_ref(), destination);
        let provider = target
            .as_ref()
            .map_or(connection_id, |source| source.saved.provider.as_str());
        let descriptor = engine.descriptor(provider)?;
        let scoped = target.as_ref().map(|source| source.bind(engine));
        let scoped = scoped.as_ref().unwrap_or(engine);
        if let Some(source) = &target {
            source.verify_effective_site(scoped)?;
        }
        let rules = target.as_ref().map(|source| &source.derived.publication);
        let destinations = rules
            .map(|rules| rules.destinations.clone())
            .unwrap_or_default();
        let choice = chosen_destination(
            scoped,
            provider,
            destination,
            ticket.project_remote.as_deref(),
            &destinations,
        )?;
        let destination = choice.value().map(str::to_owned);
        let mut eligibility = eligibility(&self.connection, &ticket, None)?;
        if matches!(eligibility, Eligibility::Eligible)
            && let Err((reason, message)) = require_target(
                descriptor.capabilities.contains(&Capability::Publish),
                &descriptor.name,
                target.as_ref(),
            )
        {
            eligibility = ineligible(reason, message);
        }
        // The same check the publish makes, so a preview never promises what the
        // publish refuses.
        if matches!(eligibility, Eligibility::Eligible)
            && let Some(chosen) = &destination
            && let Some(rules) = rules
            && let Some((reason, message)) = destination_refusal(rules, chosen)
        {
            eligibility = ineligible(reason, message);
        }
        let fingerprint = fingerprint(
            scoped,
            provider,
            publication_basis(target.as_ref(), connection_id),
            &ticket,
            destination.as_deref(),
        )?;
        let (destination, destinations) = if target
            .as_ref()
            .is_some_and(super::github_integration::is_integration_target)
        {
            let destinations = github_publication_repositories(&self.connection, &ticket)?;
            if destinations.is_empty()
                && destination.is_none()
                && matches!(eligibility, Eligibility::Eligible)
            {
                eligibility = ineligible(
                    IneligibleReason::SourceNotConnected,
                    "Set a Project remote or add a GitHub repository in Settings › Ticket sources."
                        .into(),
                );
            }
            let site = scoped.issue_site(provider)?.unwrap_or("github.com");
            (
                destination.map(|name| format!("{site}/{name}")),
                destinations,
            )
        } else {
            (destination, destinations)
        };
        Ok(PublicationPreview {
            reference: ticket.reference,
            provider: provider.to_owned(),
            provider_name: descriptor.name,
            fingerprint,
            destination,
            destinations,
            destination_labels: rules.map(|rules| rules.destination_labels.clone()).unwrap_or_default(),
            title: ticket.title,
            internal_attachments: publication_attachment_links(&self.connection, &ticket.body)?,
            body: ticket.body,
            local: PublicationLocalData {
                activities: self.connection.query_row("SELECT COUNT(*) FROM activities WHERE ticket_id = ?1", [&ticket.id], |row| row.get(0))?,
                plan: self.connection.query_row("SELECT e.name FROM tickets t JOIN plans e ON e.id = t.plan_id WHERE t.id = ?1", [&ticket.id], |row| row.get(0)).optional()?,
                tags: crate::tags::for_ticket(&self.connection, &ticket.id)?,
                subtickets: {
                    let mut statement = self.connection.prepare("SELECT t.reference FROM ticket_parents p JOIN tickets t ON t.id = p.child_id WHERE p.parent_id = ?1 ORDER BY t.number")?;
                    statement.query_map([&ticket.id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?
                },
                attachments: self.connection.query_row("SELECT COUNT(*) FROM ticket_attachments WHERE ticket_id = ?1", [&ticket.id], |row| row.get(0))?,
            },
            eligibility,
            attempt: open_attempt(&self.connection, &ticket.id, None)?,
        })
    }

    /// Every publication attempt for `reference`, newest first.
    pub fn publication_attempts(&self, reference: &str) -> Result<Vec<PublicationAttempt>, Error> {
        let ticket = subject(&self.connection, reference)?;
        let now = clock(&self.connection, None)?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
             WHERE a.ticket_id = ?1 ORDER BY a.started_at DESC, a.rowid DESC"
        ))?;
        let attempts = statement
            .query_map([&ticket.id], |row| attempt_from_row(row, &now))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(attempts)
    }

    /// Publishes a locally owned Todo, In progress or In review ticket as one
    /// ordinary issue, then makes the issue's source its owner.
    ///
    /// The attempt is saved before the connector is called and no transaction is
    /// open during the call. Ownership transfers only when the created issue is
    /// returned and recorded. See the module documentation for the three
    /// outcomes; a definite failure is [`PublicationError::Failed`], an unknown
    /// outcome is [`PublicationError::Unresolved`], and asking again for a
    /// ticket that was already published returns it with `replayed` set.
    pub fn publish_ticket(
        &mut self,
        engine: &Engine,
        reference: &str,
        options: &PublishOptions,
    ) -> Result<PublishOutcome, Error> {
        // `Err` from the scope's operation is an attempt that already published the
        // ticket: it is replayed.
        let (started, provider_name) = match crate::write_scope::run(
            &self.connection,
            |transaction| {
                let ticket = subject(transaction, reference)?;
                if let Some(attempt) =
                    latest_succeeded(transaction, &ticket.id, options.now.as_deref())?
                    && matches!(
                        tracking::authority(transaction, &ticket.id)?,
                        tracking::Authority::External { .. }
                    )
                {
                    return Ok(Err(attempt));
                }
                let default;
                let connection_id = match options.connection.as_deref() {
                    Some(id) => id,
                    None => {
                        default = default_publication_connection(transaction, engine)?;
                        default.as_str()
                    }
                };
                let configured = publication_target(
                    transaction,
                    connection_id,
                    &ticket,
                    options.destination.as_deref(),
                )?;
                let requested =
                    github_destination(configured.as_ref(), options.destination.as_deref());
                let provider = configured
                    .as_ref()
                    .map_or(connection_id, |source| source.saved.provider.as_str());
                let descriptor = engine.descriptor(provider)?;
                let can_publish = descriptor.capabilities.contains(&Capability::Publish);
                let refuse = |reason, message| {
                    Error::Publication(PublicationError::Ineligible {
                        reference: ticket.reference.clone(),
                        reason,
                        message,
                    })
                };
                if let Eligibility::Ineligible { reason, message } =
                    eligibility(transaction, &ticket, options.now.as_deref())?
                {
                    return Err(refuse(reason, message));
                }
                // Read the saved destinations under the same lock as the attempt.
                let target =
                    match require_target(can_publish, &descriptor.name, configured.as_ref()) {
                        Ok(target) => target,
                        Err((reason, message)) => return Err(refuse(reason, message)),
                    };
                let scoped = target.bind(engine);
                target.verify_effective_site(&scoped)?;
                let rules = &target.derived.publication;
                let choice = chosen_destination(
                    &scoped,
                    provider,
                    requested,
                    ticket.project_remote.as_deref(),
                    &rules.destinations,
                )?;
                let destination = choice.value();
                if let Some(destination) = destination {
                    check_destination(rules, destination)?;
                    if !destination_allowed(rules, destination) {
                        return Err(refuse(
                            IneligibleReason::DestinationNotAllowed,
                            not_allowed_message(destination, &rules.destinations),
                        ));
                    }
                }
                // A cleared Project remote can also invalidate the preview by leaving no choice.
                if let Some(expected) = &options.expected_fingerprint
                    && *expected
                        != fingerprint(
                            &scoped,
                            provider,
                            publication_basis(Some(target), connection_id),
                            &ticket,
                            destination,
                        )?
                {
                    return Err(PublicationError::ChangedSincePreview {
                        reference: ticket.reference,
                    }
                    .into());
                }
                if let DestinationChoice::ProjectRemote(destination) = &choice
                    && options.expected_fingerprint.is_none()
                {
                    return Err(refuse(
                        IneligibleReason::PreviewRequired,
                        format!(
                            "preview {} and supply its fingerprint to publish to the default repository {destination}",
                            ticket.reference
                        ),
                    ));
                }
                let destination = match choice {
                    DestinationChoice::ProjectRemote(destination)
                    | DestinationChoice::Other(destination) => destination,
                    DestinationChoice::Unselected => {
                        return Err(SourceError::InvalidConfiguration(vec![
                            super::FieldIssue::for_field("destination", "choose where to publish"),
                        ])
                        .into());
                    }
                };
                let destination_host =
                    configured_destination_site(&scoped, provider, &destination)?;
                if provider == super::github::PROVIDER && destination_host.is_none() {
                    return Err(host_configuration_error(
                        "A valid GitHub host is required to publish this ticket.".into(),
                    )
                    .into());
                }
                let now = clock(transaction, options.now.as_deref())?;
                let attempt_id = Uuid::new_v4().to_string();
                transaction.execute(
                "INSERT INTO publication_attempts (id, ticket_id, provider, destination, title, body, status, started_at, lease_expires_at, updated_at, destination_host) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'in_flight', ?7, strftime('%Y-%m-%dT%H:%M:%fZ', ?7, ?8), ?7, ?9)",
                params![
                    attempt_id,
                    ticket.id,
                    provider,
                    destination,
                    ticket.title,
                    ticket.body,
                    now,
                    format!("+{LEASE_SECONDS} seconds"),
                    destination_host,
                ],
            )?;
                if super::github_integration::is_integration_target(target) {
                    transaction.execute(
                        "INSERT INTO github_publication_context (attempt_id, host) VALUES (?1, ?2)",
                        params![attempt_id, destination_host],
                    )?;
                } else {
                    transaction.execute(
                        "INSERT INTO publication_connections (attempt_id, connection_id) VALUES (?1, ?2)",
                        params![attempt_id, connection_id],
                    )?;
                }
                let started = Started {
                    attempt_id,
                    reference: ticket.reference,
                    ticket_id: ticket.id,
                    request: PublishRequest {
                        title: ticket.title,
                        body: ticket.body,
                        destination,
                    },
                    source: target.clone(),
                    agent: options.agent.clone(),
                };
                Ok(Ok((started, descriptor.name)))
            },
        )? {
            Ok(started) => started,
            Err(attempt) => {
                return Ok(PublishOutcome {
                    ticket: self.show_ticket(reference)?,
                    attempt,
                    replayed: true,
                });
            }
        };

        // The dispatch guard protects this attempt while other processes can
        // continue reading and writing the Workspace.
        let _dispatch_guard;
        let (result, sent) = match started.source.check(engine) {
            Ok((scoped, checked)) => {
                let claim = if destination_refusal(
                    &checked.derived.publication,
                    &started.request.destination,
                )
                .is_some()
                {
                    Err(SourceError::NotSent(
                        "the selected destination is no longer available. Preview publication again".into(),
                    ))
                } else {
                    match self.publication_guard(&started.reference, &started.attempt_id, true) {
                        Ok(guard) => {
                            _dispatch_guard = guard;
                            self.claim_dispatch(
                                &started,
                                &checked.connection,
                                options.now.as_deref(),
                            )
                        }
                        Err(error @ Error::Publication(PublicationError::StillRunning { .. })) => {
                            return Err(error);
                        }
                        Err(error) => {
                            tracing::warn!(
                                source_id = %started.source.saved.id,
                                error_kind = error.kind().code(),
                                "could not lock a publication before dispatch"
                            );
                            Err(SourceError::NotSent(
                                "the Workspace could not lock the publication before sending"
                                    .into(),
                            ))
                        }
                    }
                };
                match claim {
                    Ok(deadline) => (
                        scoped.publish_before(
                            &started.source.saved.provider,
                            &started.source.saved.config,
                            &started.request,
                            Some(deadline),
                        ),
                        true,
                    ),
                    Err(error) => (Err(error), false),
                }
            }
            Err(error) => (Err(error), false),
        };
        match result {
            Ok(issue) => self.finish_created(&started, &provider_name, &issue, options),
            Err(error) if !sent || error.ruled_out_creation() => {
                // If this write fails the attempt stays in flight, which is the
                // safe direction: it blocks until it can be resolved.
                let _ = self.settle(
                    &started.attempt_id,
                    AttemptState::Failed,
                    Some(&failure_of(&error)),
                    None,
                    options.now.as_deref(),
                );
                Err(PublicationError::Failed {
                    reference: started.reference,
                    attempt_id: started.attempt_id,
                    source: error,
                }
                .into())
            }
            Err(error) => {
                // Blind retrying is exactly what is blocked now, so the provider's
                // own "retry later" advice is dropped from what is recorded.
                let mut failure = failure_of(&error);
                failure.message = without_retry_advice(&failure.message);
                let message = format!("{}.", failure.message.trim_end_matches('.'));
                let _ = self.settle(
                    &started.attempt_id,
                    AttemptState::Unresolved,
                    Some(&failure),
                    None,
                    options.now.as_deref(),
                );
                Err(PublicationError::Unresolved {
                    reference: started.reference,
                    attempt_id: started.attempt_id,
                    message,
                }
                .into())
            }
        }
    }

    /// Links the confirmed issue and settles the attempt in one write. If that
    /// write cannot happen, the issue is still recorded on the attempt (best
    /// plan) and the attempt stays unresolved.
    fn finish_created(
        &mut self,
        started: &Started,
        provider_name: &str,
        issue: &ExternalIssue,
        options: &PublishOptions,
    ) -> Result<PublishOutcome, Error> {
        let linked = self.link_created(started, issue, options.now.as_deref());
        let (code, message) = match linked {
            Ok(Linked::Done(attempt)) => {
                let attempt = *attempt;
                return Ok(PublishOutcome {
                    ticket: self.show_ticket(&started.reference)?,
                    attempt,
                    replayed: false,
                });
            }
            Ok(Linked::Conflict { origin }) => (
                "identity_conflict",
                format!(
                    "{provider_name} created {}, but that issue was already {} as another ticket, so it was not attached here.",
                    issue.display,
                    if origin == "published" {
                        "published"
                    } else {
                        "imported"
                    }
                ),
            ),
            Ok(Linked::SettledElsewhere) => (
                "settled_elsewhere",
                format!(
                    "{provider_name} created {}, but this attempt was settled by another process meanwhile.",
                    issue.display
                ),
            ),
            Err(error) => (
                "local_persistence_failed",
                format!(
                    "{provider_name} created {} ({}), but ticketd could not record it: {error}.",
                    issue.display, issue.url
                ),
            ),
        };
        // Keep what we learned: the created issue's identity, so resolving never
        // has to guess. A no-op when the attempt was settled elsewhere.
        let _ = self.settle(
            &started.attempt_id,
            AttemptState::Unresolved,
            Some(&SourceFailure {
                code: code.into(),
                message: message.clone(),
            }),
            Some(issue),
            options.now.as_deref(),
        );
        Err(PublicationError::Unresolved {
            reference: started.reference.clone(),
            attempt_id: started.attempt_id.clone(),
            message,
        }
        .into())
    }

    fn link_created(
        &mut self,
        started: &Started,
        issue: &ExternalIssue,
        now: Option<&str>,
    ) -> Result<Linked, Error> {
        crate::write_scope::run(&self.connection, |transaction| {
            let (still_open, started_at): (bool, String) = transaction.query_row(
                "SELECT status = 'in_flight', started_at FROM publication_attempts WHERE id = ?1",
                [&started.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if !still_open {
                return Ok(Linked::SettledElsewhere);
            }
            let identity = &issue.reference.identity;
            // Discovery may have imported the created issue as a ticket of its own
            // first. That ticket is adopted (see `adoptable`); anything else owning
            // the identity is a conflict.
            let adopt = match identity_owner(transaction, identity)? {
                None => None,
                Some(owner) if adoptable(&owner, &started_at, issue) => Some(owner.ticket_id),
                Some(owner) => {
                    return Ok(Linked::Conflict {
                        origin: owner.origin,
                    });
                }
            };
            let now = clock(transaction, now)?;
            let attempt = complete_attempt(
                transaction,
                &Sent {
                    attempt_id: &started.attempt_id,
                    ticket_id: &started.ticket_id,
                    title: &started.request.title,
                    body: &started.request.body,
                    destination: &started.request.destination,
                    agent: started.agent.as_deref(),
                    adopt: adopt.as_deref(),
                    attached: None,
                    recovery_connection: None,
                },
                issue,
                &now,
            )?;
            Ok(Linked::Done(Box::new(attempt)))
        })
    }

    /// Dispatch is exclusive. Resolvers share the guard so they can still race
    /// through verification and compare-and-set without racing a live sender.
    fn publication_guard(
        &self,
        reference: &str,
        attempt_id: &str,
        dispatch: bool,
    ) -> Result<File, Error> {
        let locks = self
            .attachment_directory()?
            .join(".publication-dispatch-locks");
        std::fs::create_dir_all(&locks)?;
        let guard = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(locks.join(format!("{:x}.lock", Sha256::digest(attempt_id.as_bytes()))))?;
        let locked = if dispatch {
            FileExt::try_lock_exclusive(&guard)
        } else {
            FileExt::try_lock_shared(&guard)
        };
        match locked {
            Ok(()) => Ok(guard),
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                Err(PublicationError::StillRunning {
                    reference: reference.to_owned(),
                    attempt_id: attempt_id.to_owned(),
                }
                .into())
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Recheck the lease and source revision immediately before handing off the write.
    fn claim_dispatch(
        &mut self,
        started: &Started,
        connection: &super::ConnectionInfo,
        now: Option<&str>,
    ) -> Result<std::time::Instant, SourceError> {
        let tracker_time = connection
            .tracker_time
            .as_deref()
            .filter(|time| parse_time(time).is_some());
        if connection.publication_requires_tracker_time && tracker_time.is_none() {
            return Err(SourceError::NotSent(
                "the source did not confirm its clock for publication recovery".into(),
            ));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(DISPATCH_SECONDS);
        let claimed = crate::write_scope::run(&self.connection, |transaction| {
            let now = clock(transaction, now)?;
            let attempt = &started.attempt_id;
            // Recovery compares the observed lease. A successful dispatch must
            // change it even if the wall clock moved backward during preflight.
            let integrated = super::github_integration::is_integration_target(&started.source);
            if integrated {
                let ticket = subject(transaction, &started.reference)?;
                let host = started.source.github_site();
                let destination = format!("{host}/{}", started.request.destination);
                let current = publication_target(
                    transaction,
                    super::GITHUB_INTEGRATION,
                    &ticket,
                    Some(&destination),
                )?
                .ok_or(Error::InvalidProjectRemote)?;
                if current.revision != started.source.revision {
                    return Ok(false);
                }
            }
            let changed = transaction.execute(
                "UPDATE publication_attempts AS a
                 SET lease_expires_at = MAX(
                     strftime('%Y-%m-%dT%H:%M:%fZ', ?2, ?3),
                     strftime('%Y-%m-%dT%H:%M:%fZ', a.lease_expires_at, '+1 second')
                 )
                 WHERE a.id = ?1 AND a.status = 'in_flight'
                   AND julianday(a.lease_expires_at) > julianday(?2)
                   AND (?5 OR EXISTS (
                       SELECT 1 FROM publication_connections p
                       JOIN source_connections c ON c.id = p.connection_id
                       WHERE p.attempt_id = a.id AND c.revision = ?4
                   ))",
                params![
                    attempt,
                    now,
                    format!("+{DISPATCH_LEASE_SECONDS} seconds"),
                    started.source.revision,
                    integrated,
                ],
            )?;
            if changed == 0 {
                return Ok(false);
            }
            super::record_verified_account(transaction, &started.source, connection)?;
            if integrated {
                transaction.execute(
                    "UPDATE github_publication_context SET tracker_started_at = ?2, login = ?3, account_key = ?4 WHERE attempt_id = ?1",
                    params![attempt, tracker_time, connection.account, connection.account_key()],
                )?;
            } else {
                transaction.execute(
                    "UPDATE publication_connections SET tracker_started_at = ?2 WHERE attempt_id = ?1",
                    params![attempt, tracker_time],
                )?;
            }
            Ok(true)
        });
        match claimed {
            Ok(true) => Ok(deadline),
            Ok(false) => Err(SourceError::NotSent(
                "the publication or its connection changed before the request could be sent".into(),
            )),
            Err(error) => {
                tracing::warn!(
                    source_id = %started.source.saved.id,
                    error_kind = error.kind().code(),
                    "could not claim a publication before dispatch"
                );
                Err(SourceError::NotSent(
                    "the publication could not be recorded before sending".into(),
                ))
            }
        }
    }

    /// Moves an attempt that is still open to `failed` or `unresolved`, keeping
    /// the created issue when one is known. A settled attempt is never
    /// overwritten, with one exception: a creation that arrives after a person
    /// confirmed "not created" (a stalled request answered late) reopens that
    /// attempt as unresolved with the issue recorded, so the issue is not lost.
    fn settle(
        &mut self,
        attempt_id: &str,
        status: AttemptState,
        failure: Option<&SourceFailure>,
        issue: Option<&ExternalIssue>,
        now: Option<&str>,
    ) -> Result<(), Error> {
        crate::write_scope::run(&self.connection, |transaction| {
            let now = clock(transaction, now)?;
            let first_unknown: Option<(String, String)> = if status == AttemptState::Unresolved {
                transaction.query_row("SELECT ticket_id, destination FROM publication_attempts WHERE id = ?1 AND status = 'in_flight'", [attempt_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?
            } else {
                None
            };
            transaction.execute(
            "UPDATE publication_attempts SET status = ?2, updated_at = ?3, failure_code = ?4, failure_message = ?5, \
             external_id = COALESCE(?6, external_id), locator = COALESCE(?7, locator), display = COALESCE(?8, display), url = COALESCE(?9, url), \
             partition = COALESCE(?11, partition), \
             lease_expires_at = CASE WHEN status = 'in_flight' AND ?2 = 'unresolved'
                  THEN MAX(lease_expires_at, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', started_at, ?12))
                  ELSE lease_expires_at END \
             WHERE id = ?1 AND (status IN ('in_flight', 'unresolved') \
                OR (status = 'failed' AND failure_code = ?10 AND ?6 IS NOT NULL \
                    AND NOT EXISTS (SELECT 1 FROM publication_attempts o \
                                    WHERE o.ticket_id = publication_attempts.ticket_id AND o.status IN ('in_flight', 'unresolved'))))",
            params![
                attempt_id,
                status.stored(),
                now,
                failure.map(|f| f.code.as_str()),
                failure.map(|f| f.message.as_str()),
                issue.map(|i| i.reference.identity.id.as_str()),
                issue.map(|i| i.reference.locator.as_str()),
                issue.map(|i| i.display.as_str()),
                issue.map(|i| i.url.as_str()),
                RULED_OUT,
                issue.map(|i| i.reference.partition.as_str()),
                format!("+{LEASE_SECONDS} seconds"),
            ],
        )?;
            if let Some((ticket, destination)) = first_unknown {
                history::record(
                    transaction,
                    &ticket,
                    "publication_unresolved",
                    attempt_id,
                    &destination,
                    None,
                )?;
            }
            Ok(())
        })
    }
}

fn latest_attempt(
    connection: &Connection,
    ticket_id: &str,
    now: Option<&str>,
) -> Result<Option<PublicationAttempt>, Error> {
    let now = clock(connection, now)?;
    Ok(connection
        .query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
                 WHERE a.ticket_id = ?1 ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1"
            ),
            [ticket_id],
            |row| attempt_from_row(row, &now),
        )
        .optional()?)
}

enum AttachmentProof<'a> {
    Lookup(&'a Engine),
    Verified(&'a ExternalIssue),
    None,
}

/// Resolution of uncertain attempts. Each resolution is verified outside any
/// transaction, then settled in one write that compares the attempt's stored
/// status with what was read, so competing resolvers, a running publisher and
/// discovery can never both win.
impl Workspace {
    /// Records an independently verified original site for a legacy unresolved
    /// attempt. The connector must already use that site. This performs no
    /// network calls and leaves the attempt unresolved.
    pub fn confirm_publication_host(
        &mut self,
        engine: &Engine,
        reference: &str,
        original_host: &str,
    ) -> Result<PublicationAttempt, Error> {
        crate::write_scope::run(&self.connection, |transaction| {
            let ticket = subject(transaction, reference)?;
            let now = clock(transaction, None)?;
            let Some(attempt) = open_attempt(transaction, &ticket.id, Some(&now))? else {
                return Err(PublicationError::NothingToResolve {
                    reference: ticket.reference,
                }
                .into());
            };
            if attempt.state == AttemptState::InFlight {
                return Err(PublicationError::StillRunning {
                    reference: ticket.reference,
                    attempt_id: attempt.id,
                }
                .into());
            }
            let mismatch = |message| PublicationError::Mismatch {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                message,
            };
            if let Some(host) = &attempt.destination_host
                && !attempt.destination_site_unconfirmed
            {
                return Err(mismatch(format!(
                    "The original publication host is already recorded as {host}."
                ))
                .into());
            }
            // A legacy attempt may have no device-local binding. Confirming its
            // host narrows discovery holds without giving another connection
            // permission to settle the attempt.
            let source = publication_connection(transaction, &attempt)?;
            let scoped_integration;
            let source = if attempt.provider == super::GITHUB_INTEGRATION
                && source
                    .as_ref()
                    .is_none_or(super::github_integration::is_integration_target)
            {
                let host = super::github_integration::normalized_host(original_host)?;
                scoped_integration = super::github_integration::workflow_target(
                    transaction,
                    &host,
                    ticket.project_id.as_deref(),
                    &[],
                )?;
                Some(scoped_integration)
            } else {
                source
            };
            let scoped = source.as_ref().map(|source| source.bind(engine));
            let scoped = scoped.as_ref().unwrap_or(engine);
            if let Some(source) = source {
                source.verify_effective_site(scoped)?;
            }
            let Some(current) =
                configured_destination_site(scoped, &attempt.provider, &attempt.destination)?
            else {
                return Err(
                    mismatch("The current source host could not be identified.".into()).into(),
                );
            };
            if confirmed_site(original_host).as_deref() != Some(current.as_str()) {
                return Err(mismatch(format!(
                    "The confirmed original host must match the current source, which uses {current}."
                ))
                .into());
            }
            if let Some(original) = &attempt.destination_host
                && original != super::github::site_host(&current)
            {
                return Err(mismatch(format!(
                    "The original publication hostname was recorded as {original}."
                ))
                .into());
            }
            record_publication_site(transaction, &attempt.id, &current)?;
            if attempt.provider == super::GITHUB_INTEGRATION {
                transaction.execute(
                    "UPDATE github_publication_context SET host = ?2 WHERE attempt_id = ?1 AND host IN (?2, ?3)",
                    params![attempt.id, current, super::github::site_host(&current)],
                )?;
            }
            transaction.execute(
                "UPDATE publication_attempts SET updated_at = ?2 WHERE id = ?1",
                params![attempt.id, now],
            )?;
            open_attempt(transaction, &ticket.id, Some(&now))?.ok_or_else(|| {
                PublicationError::NothingToResolve {
                    reference: ticket.reference.clone(),
                }
                .into()
            })
        })
    }

    /// What is known about the uncertain attempt on `reference`, what is not, and
    /// what may safely be done next. With `search`, also asks the source for
    /// issues that may be this publication's result (a network call; a failure is
    /// reported, never read as "none").
    pub fn review_publication(
        &self,
        engine: &Engine,
        reference: &str,
        search: bool,
    ) -> Result<PublicationReview, Error> {
        self.review_publication_at(engine, reference, search, None)
    }

    /// [`Workspace::review_publication`] judged at `now` (RFC 3339; the database
    /// clock when absent).
    pub fn review_publication_at(
        &self,
        engine: &Engine,
        reference: &str,
        search: bool,
        now: Option<&str>,
    ) -> Result<PublicationReview, Error> {
        let now = clock(&self.connection, now)?;
        let ticket = subject(&self.connection, reference)?;
        let Some(attempt) = open_attempt(&self.connection, &ticket.id, Some(&now))? else {
            return Err(PublicationError::NothingToResolve {
                reference: ticket.reference,
            }
            .into());
        };
        let name = super::provider_display_name(&self.connection, &attempt.provider)?;
        let running = attempt.state == AttemptState::InFlight;
        let destination = match &attempt.destination_host {
            Some(host) => format!("{host}/{}", attempt.destination),
            None => attempt.display_destination().to_owned(),
        };
        let mut known = vec![format!(
            "ticketd asked {name} to create \"{}\" in {destination}.",
            attempt.title
        )];
        if let Some(issue) = &attempt.issue {
            known.push(format!(
                "{} ({}) was created for it.",
                issue.display, issue.url
            ));
        }
        known.push(match attempt.failure.as_ref().map(|f| f.code.as_str()) {
            _ if running => "The request is still in progress.".to_owned(),
            Some("unavailable" | "protocol") => {
                "The request was sent, but no usable answer came back.".to_owned()
            }
            Some("interrupted") => {
                "ticketd stopped or lost contact before the answer arrived.".to_owned()
            }
            Some("local_persistence_failed") => format!(
                "{name} confirmed the issue, but ticketd could not record it on this ticket."
            ),
            Some("identity_conflict") => attempt
                .failure
                .as_ref()
                .map(|f| f.message.clone())
                .unwrap_or_default(),
            Some(_) => attempt
                .failure
                .as_ref()
                .map(|f| f.message.clone())
                .unwrap_or_default(),
            None => String::new(),
        });
        known.retain(|line| !line.is_empty());
        known.push(format!(
            "{} is still a local ticket with all its progress and organization.",
            ticket.reference
        ));
        known.push(
            "If its title or description change meanwhile, attaching the issue keeps the later text as a local note and restores the text that was sent."
                .to_owned(),
        );
        let unknown = if attempt.issue.is_some() {
            "Nothing about the issue itself; it is only not attached to this ticket yet.".to_owned()
        } else {
            format!("whether {name} created an issue for this attempt.")
        };

        let mut candidates = Vec::new();
        let mut other_recent = Vec::new();
        let mut candidates_complete = None;
        let settled = search_settled(&attempt.lease_expires_at, &now);
        let source = publication_connection(&self.connection, &attempt)?;
        let host_failure = source.as_ref().and_then(|source| {
            let scoped = source.bind(engine);
            check_recovery_host(&scoped, &attempt)
                .and_then(|()| source.verify_effective_site(&scoped))
                .err()
                .map(|error| failure_of(&error))
        });
        let mut lookup_failure = host_failure.clone();
        if search && !running && attempt.issue.is_none() && host_failure.is_none() {
            let search_result = match source.as_ref() {
                Some(source) => match verified_publication_engine(engine, source) {
                    Ok((engine, account)) => {
                        let search = search_for(&self.connection, &attempt, account.account_key())?;
                        check_recovery_host(&engine, &attempt).and_then(|()| {
                            engine.find_published(&attempt.provider, &source.saved.config, &search)
                        })
                    }
                    Err(error) => Err(error),
                },
                None => Err(publication_connection_missing()),
            };
            match search_result {
                Ok(found) => {
                    candidates = found
                        .matches
                        .iter()
                        .map(|issue| candidate(issue, CandidateReason::ContentMatch))
                        .collect();
                    other_recent = found
                        .recent
                        .iter()
                        .map(|issue| candidate(issue, CandidateReason::CreatedByAccount))
                        .collect();
                    candidates_complete = Some(found.complete && settled);
                }
                Err(error) => lookup_failure = Some(failure_of(&error)),
            }
        }

        // "Nothing was created" needs a complete, successful search that found
        // nothing. A search that failed or read only part of the window proves
        // nothing, so the action is not offered then.
        let search_blocks = lookup_failure.is_some() || candidates_complete == Some(false);
        let not_created_available = !running
            && source.is_some()
            && attempt.issue.is_none()
            && candidates.is_empty()
            && other_recent.is_empty()
            && !search_blocks;
        let conflict = attempt
            .failure
            .as_ref()
            .filter(|f| f.code == "identity_conflict");
        let actions = vec![
            ResolutionAction {
                kind: ActionKind::Attach,
                available: !running
                    && (source.is_some()
                        || (attempt.provider == super::GITHUB_INTEGRATION
                            && attempt.destination_host.is_some()
                            && !attempt.destination_site_unconfirmed))
                    && host_failure.is_none()
                    && conflict.is_none(),
                label: "Attach the created issue".into(),
                detail: if running {
                    "Wait for the request to finish first.".into()
                } else if source.is_none() {
                    unbound_attach_help(&attempt)
                } else if let Some(failure) = &host_failure {
                    failure.message.clone()
                } else if let Some(conflict) = conflict {
                    format!("Not possible: {}", conflict.message)
                } else if attempt.issue.is_some() {
                    format!(
                        "Confirm {} and finish publishing. {name} is asked to verify it first.",
                        attempt
                            .issue
                            .as_ref()
                            .map(|i| i.display.as_str())
                            .unwrap_or_default()
                    )
                } else {
                    format!(
                        "Name the issue in {} (a number or link). {name} is asked to verify it before anything is attached.",
                        attempt.display_destination()
                    )
                },
            },
            ResolutionAction {
                kind: ActionKind::NotCreated,
                available: not_created_available,
                label: "Confirm nothing was created".into(),
                detail: if running {
                    "Wait for the request to finish first.".into()
                } else if source.is_none() {
                    "The original publication connection is unavailable on this desktop.".into()
                } else if let Some(failure) = &host_failure {
                    failure.message.clone()
                } else if attempt.issue.is_some() {
                    "Not possible: the issue is known to exist.".into()
                } else if !candidates.is_empty() || !other_recent.is_empty() {
                    "Not possible: issues that may be this publication already exist.".into()
                } else if lookup_failure.is_some() {
                    format!(
                        "Not possible right now: {name} could not be searched, which does not mean nothing was created."
                    )
                } else if candidates_complete == Some(false) && !settled {
                    format!(
                        "Not possible yet: {name} may not list a just-created issue for a minute or so. Look again after {}.",
                        ready_text(&attempt.lease_expires_at)
                    )
                } else if candidates_complete == Some(false) {
                    format!(
                        "Not possible: {name} could not verify that no issue was created in {}.",
                        attempt.display_destination()
                    )
                } else {
                    format!(
                        "Only when {name}'s recent issues in {} can be read completely and none could be the created issue.",
                        attempt.display_destination()
                    )
                },
            },
        ];
        Ok(PublicationReview {
            connection_id: source.filter(|source| !super::github_integration::is_integration_target(source)).map(|source| source.saved.id),
            provider_name: name,
            known,
            unknown,
            note: "Publishing again is blocked: if the issue exists, creating another would duplicate it. It becomes available only after nothing is confirmed to have been created.".into(),
            actions,
            candidates,
            other_recent,
            candidates_complete,
            search_ready_at: search_ready_at(&attempt.lease_expires_at),
            lookup_failure,
            attempt,
        })
    }

    /// Settles the uncertain attempt on `reference`. See [`Resolution`].
    ///
    /// Evidence that cannot be obtained (unreachable source, lost credentials, an
    /// incomplete read) leaves the attempt unresolved and is reported as
    /// [`PublicationError::Unverified`]. Asking again after the attempt was
    /// settled returns the ticket with `replayed` set.
    pub fn resolve_publication(
        &mut self,
        engine: &Engine,
        reference: &str,
        options: &ResolveOptions,
    ) -> Result<PublishOutcome, Error> {
        let ticket = subject(&self.connection, reference)?;
        let Some(attempt) = open_attempt(&self.connection, &ticket.id, options.now.as_deref())?
        else {
            return self.settled_instead(
                &ticket,
                &options.resolution,
                AttachmentProof::Lookup(engine),
                options.now.as_deref(),
            );
        };
        if attempt.state == AttemptState::InFlight {
            return Err(PublicationError::StillRunning {
                reference: ticket.reference,
                attempt_id: attempt.id,
            }
            .into());
        }
        let _recovery_guard = self.publication_guard(&ticket.reference, &attempt.id, false)?;
        let unverified = |source| {
            Error::Publication(PublicationError::Unverified {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                source,
            })
        };
        let original_source = publication_connection(&self.connection, &attempt)?;
        let recovery = original_source.is_none();
        let source = match (original_source, &options.resolution) {
            (Some(source), Resolution::AttachUsingConnection { connection, .. })
                if source.saved.id != *connection =>
            {
                return Err(unverified(publication_connection_error(format!(
                    "use the original connection {} for this attempt",
                    source.saved.id
                ))));
            }
            (Some(source), _) => source,
            (None, Resolution::AttachUsingConnection { connection, .. })
                if attempt.provider == super::github::PROVIDER =>
            {
                configured_source(&self.connection, connection)?
                    .filter(|source| source.saved.provider == attempt.provider)
                    .ok_or_else(|| {
                        unverified(publication_connection_error(
                            "choose a saved GitHub connection on the original host",
                        ))
                    })?
            }
            (None, Resolution::Attach { .. }) if attempt.provider == super::GITHUB_INTEGRATION => {
                let host = attempt.destination_host.as_deref().ok_or_else(|| {
                    unverified(host_configuration_error(
                        "Verify the original GitHub host before attaching an issue.".into(),
                    ))
                })?;
                super::github_integration::workflow_target(
                    &self.connection,
                    host,
                    ticket.project_id.as_deref(),
                    std::slice::from_ref(&attempt.destination),
                )?
            }
            (None, _) => return Err(unverified(publication_connection_missing())),
        };
        check_recovery_host(&source.bind(engine), &attempt).map_err(unverified)?;
        let (engine, account) = verified_publication_engine(engine, &source).map_err(unverified)?;
        check_recovery_host(&engine, &attempt).map_err(unverified)?;
        let issue = match &options.resolution {
            Resolution::Attach { issue } => issue.as_deref(),
            Resolution::AttachUsingConnection { issue, .. } => Some(issue.as_str()),
            Resolution::NotCreated => {
                return self.rule_out(
                    &engine,
                    &ticket,
                    &attempt,
                    &source,
                    account.account_key(),
                    options,
                );
            }
        };
        let found = Self::lookup_publication_issue(&engine, &attempt, &source, issue)?;
        if recovery {
            verify_unbound_issue(&attempt, &found, &account.account).map_err(unverified)?;
        }
        self.attach_verified(
            &ticket,
            &attempt,
            &found,
            options,
            recovery.then_some(&source),
        )
    }

    fn lookup_publication_issue(
        engine: &Engine,
        attempt: &PublicationAttempt,
        source: &ConfiguredSource,
        issue: Option<&str>,
    ) -> Result<ExternalIssue, Error> {
        let unverified = |source| PublicationError::Unverified {
            reference: attempt.reference.clone(),
            attempt_id: attempt.id.clone(),
            source,
        };
        let mismatch = |message| PublicationError::Mismatch {
            reference: attempt.reference.clone(),
            attempt_id: attempt.id.clone(),
            message,
        };
        let config = &source.saved.config;
        match (
            issue.map(str::trim).filter(|text| !text.is_empty()),
            &attempt.issue,
        ) {
            (Some(text), _) => engine
                .locate(&attempt.provider, config, &attempt.destination, text)
                .map_err(|error| {
                    match error {
                        SourceError::InvalidConfiguration(issues) => mismatch(
                            issues
                                .iter()
                                .map(|issue| format!("the issue {}", issue.message))
                                .collect::<Vec<_>>()
                                .join("; "),
                        ),
                        other => unverified(other),
                    }
                    .into()
                }),
            (None, Some(known)) => engine
                .fetch(
                    &attempt.provider,
                    config,
                    &ExternalRef {
                        identity: known.identity.clone(),
                        locator: known.locator.clone(),
                        partition: known.partition.clone(),
                    },
                )
                .map_err(|error| unverified(error).into()),
            (None, None) => Err(mismatch(format!(
                "name the issue that was created in {} (a number or link); ticketd never guesses it from the title",
                attempt.display_destination()
            ))
            .into()),
        }
    }

    /// The outcome when no attempt is open: a replay of the same resolution, a
    /// settled attempt that disagrees, or nothing to resolve.
    fn settled_instead(
        &self,
        ticket: &Subject,
        resolution: &Resolution,
        proof: AttachmentProof<'_>,
        now: Option<&str>,
    ) -> Result<PublishOutcome, Error> {
        let settled = |attempt: &PublicationAttempt, message: &str| {
            Error::Publication(PublicationError::Settled {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                message: message.to_owned(),
            })
        };
        let Some(latest) = latest_attempt(&self.connection, &ticket.id, now)? else {
            return Err(PublicationError::NothingToResolve {
                reference: ticket.reference.clone(),
            }
            .into());
        };
        let replay = |attempt: PublicationAttempt| -> Result<PublishOutcome, Error> {
            Ok(PublishOutcome {
                ticket: self.show_ticket(&ticket.reference)?,
                attempt,
                replayed: true,
            })
        };
        match (resolution, latest.state) {
            (
                Resolution::Attach { .. } | Resolution::AttachUsingConnection { .. },
                AttemptState::Succeeded,
            ) => {
                if self.matches_settled_attachment(&latest, resolution, proof)? {
                    replay(latest)
                } else {
                    Err(settled(
                        &latest,
                        "this publication was already completed. The attachment request could not be matched to the recorded issue and connection",
                    ))
                }
            }
            (Resolution::NotCreated, AttemptState::Failed)
                if latest.failure.as_ref().is_some_and(|f| f.code == RULED_OUT) =>
            {
                replay(latest)
            }
            (_, AttemptState::Succeeded) => Err(settled(
                &latest,
                "this publication was already completed; nothing was changed",
            )),
            (_, AttemptState::Failed)
                if latest.failure.as_ref().is_some_and(|f| f.code == RULED_OUT) =>
            {
                Err(settled(
                    &latest,
                    "this publication was already confirmed as not created; nothing was changed",
                ))
            }
            (_, AttemptState::InFlight | AttemptState::Unresolved | AttemptState::Failed) => {
                Err(PublicationError::NothingToResolve {
                    reference: ticket.reference.clone(),
                }
                .into())
            }
        }
    }

    fn matches_settled_attachment(
        &self,
        attempt: &PublicationAttempt,
        resolution: &Resolution,
        proof: AttachmentProof<'_>,
    ) -> Result<bool, Error> {
        let Some(recorded) = &attempt.issue else {
            return Ok(false);
        };
        let requested = match resolution {
            Resolution::Attach { issue } => issue.as_deref(),
            Resolution::AttachUsingConnection { issue, connection } => {
                let binding: bool = self.connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM publication_connections WHERE attempt_id = ?1 AND connection_id = ?2)",
                    params![attempt.id, connection],
                    |row| row.get(0),
                )?;
                if !binding {
                    return Ok(false);
                }
                Some(issue.as_str())
            }
            Resolution::NotCreated => return Ok(false),
        };
        let matches = |issue: &ExternalIssue| {
            recorded.identity == issue.reference.identity
                && super::legacy_issue_origin_matches(&attempt.provider, &recorded.url, &issue.url)
        };
        if let AttachmentProof::Verified(issue) = proof {
            return Ok(matches(issue));
        }
        let Some(requested) = requested.map(str::trim).filter(|issue| !issue.is_empty()) else {
            return Ok(true);
        };
        let AttachmentProof::Lookup(engine) = proof else {
            return Ok(false);
        };
        // A named replay can require a provider read. Only the no-open-attempt
        // path supplies an engine, so the read stays outside the write scope.
        let Some(source) = publication_connection(&self.connection, attempt)? else {
            return Ok(false);
        };
        if check_recovery_host(&source.bind(engine), attempt).is_err() {
            return Ok(false);
        }
        let Ok((scoped, _)) = verified_publication_engine(engine, &source) else {
            return Ok(false);
        };
        Ok(
            Self::lookup_publication_issue(&scoped, attempt, &source, Some(requested))
                .is_ok_and(|issue| matches(&issue)),
        )
    }

    /// Attaches an issue the source has verified, if the attempt is still open.
    fn attach_verified(
        &mut self,
        ticket: &Subject,
        attempt: &PublicationAttempt,
        issue: &ExternalIssue,
        options: &ResolveOptions,
        recovery: Option<&ConfiguredSource>,
    ) -> Result<PublishOutcome, Error> {
        let now = options.now.as_deref();
        let agent = options.agent.as_deref();
        let identity = &issue.reference.identity;
        let mismatch = |message: String| {
            Error::Publication(PublicationError::Mismatch {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                message,
            })
        };
        let started_at = tracker_started_at(&self.connection, &attempt.id)?
            .unwrap_or_else(|| attempt.started_at.clone());
        if attempt.issue.is_none() && predates(&issue.created_at, &started_at) {
            return Err(mismatch(format!(
                "{} was created before this publication began, so it cannot be its result",
                issue.display
            )));
        }
        // An issue ticketd itself created is the result by construction. Any other
        // must hold the text that was sent, or a person must say it is the one: a
        // title match is not identity, and its text will replace this ticket's.
        let title_differs = plain(&issue.title) != plain(&attempt.title);
        let body_differs = plain(&issue.body) != plain(&attempt.body);
        let different = attempt.issue.is_none() && (title_differs || body_differs);
        if different && !options.accept_different_content {
            return Err(
                PublicationError::DifferentContent(Box::new(ContentDifference {
                    reference: ticket.reference.clone(),
                    attempt_id: attempt.id.clone(),
                    issue: published(issue),
                    title_differs,
                    body_differs,
                    issue_title: issue.title.clone(),
                    sent_title: attempt.title.clone(),
                }))
                .into(),
            );
        }
        crate::write_scope::run(&self.connection, |transaction| {
            // Compare-and-set: the attempt must still be the same open attempt.
            let Some(open) =
                open_attempt(transaction, &ticket.id, now)?.filter(|open| open.id == attempt.id)
            else {
                return self.settled_instead(
                    ticket,
                    &options.resolution,
                    AttachmentProof::Verified(issue),
                    now,
                );
            };
            if open.lease_expires_at != attempt.lease_expires_at {
                return Err(PublicationError::Unverified {
                    reference: ticket.reference.clone(),
                    attempt_id: attempt.id.clone(),
                    source: SourceError::Unavailable(
                        "the dispatch window changed while verifying the issue. Review the attempt and try again"
                            .into(),
                    ),
                }
                .into());
            }
            if open.state == AttemptState::InFlight {
                return Err(PublicationError::StillRunning {
                    reference: ticket.reference.clone(),
                    attempt_id: attempt.id.clone(),
                }
                .into());
            }
            if let Some(known) = &open.issue
                && (&known.identity != identity
                    || !super::legacy_issue_origin_matches(
                        &identity.provider,
                        &known.url,
                        &issue.url,
                    ))
            {
                return Err(mismatch(format!(
                    "this attempt already created {}, not {}",
                    known.display, issue.display
                )));
            }
            if let Some(source) = recovery
                && if super::github_integration::is_integration_target(source) {
                    let current = subject(transaction, &ticket.reference)?;
                    let host = attempt
                        .destination_host
                        .as_deref()
                        .ok_or(Error::InvalidProjectRemote)?;
                    super::github_integration::workflow_target(
                        transaction,
                        host,
                        current.project_id.as_deref(),
                        &[],
                    )?
                    .revision
                        != source.revision
                } else {
                    !configured_source(transaction, &source.saved.id)?
                        .is_some_and(|current| current.revision == source.revision)
                }
            {
                return Err(PublicationError::Unverified {
                    reference: ticket.reference.clone(),
                    attempt_id: attempt.id.clone(),
                    source: publication_connection_error(
                        "the selected connection changed while verifying the issue. Review the attempt and try again",
                    ),
                }
                .into());
            }
            // The ticket may have moved on while the issue was being verified (the
            // person finished or trashed it): attaching would give an externally owned
            // Done ticket an open issue. Re-check what publishing checked.
            let current = subject(transaction, &ticket.reference)?;
            if current.trashed || !current.status.is_local_progress() {
                return Err(mismatch(format!(
                    "{} is {}; make it a Todo, In progress or In review ticket again before attaching {}",
                    current.reference,
                    if current.trashed {
                        "in the trash".to_owned()
                    } else {
                        current.status.to_string()
                    },
                    issue.display
                )));
            }
            let owner = identity_owner(transaction, identity)?;
            let adopt = match &owner {
                Some(owner) if adoptable(owner, &attempt.started_at, issue) => {
                    Some(owner.ticket_id.clone())
                }
                _ => None,
            };
            let linked: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM external_identities WHERE ticket_id = ?1)",
                [&ticket.id],
                |row| row.get(0),
            )?;
            if (owner.is_some() && adopt.is_none()) || linked {
                // Something else owns it. A person's choice that cannot be honored
                // changes nothing: the attempt keeps what it knew, so the review still
                // offers every action. Never attach one identity twice.
                let message = match &owner {
                    Some(owner) => format!(
                        "{} is already linked to another ticket (it was {} there), so it cannot be attached here",
                        issue.display,
                        if owner.origin == "published" {
                            "published"
                        } else {
                            "imported"
                        }
                    ),
                    None => format!(
                        "{} is already linked to an issue of its own, so it cannot be attached here",
                        ticket.reference
                    ),
                };
                return Err(mismatch(message));
            }
            let now = clock(transaction, now)?;
            let settled = complete_attempt(
                transaction,
                &Sent {
                    attempt_id: &attempt.id,
                    ticket_id: &ticket.id,
                    title: &attempt.title,
                    body: &attempt.body,
                    destination: &attempt.destination,
                    agent,
                    adopt: adopt.as_deref(),
                    attached: Some(different),
                    recovery_connection: recovery
                        .filter(|source| !super::github_integration::is_integration_target(source))
                        .map(|source| source.saved.id.as_str()),
                },
                issue,
                &now,
            )?;
            Ok(PublishOutcome {
                ticket: self.show_ticket(&ticket.reference)?,
                attempt: settled,
                replayed: false,
            })
        })
    }

    /// Accepts "nothing was created" only on positive evidence: the source read
    /// the whole window and nothing in it could be this publication's result.
    fn rule_out(
        &mut self,
        engine: &Engine,
        ticket: &Subject,
        attempt: &PublicationAttempt,
        source: &ConfiguredSource,
        verified_account: &str,
        options: &ResolveOptions,
    ) -> Result<PublishOutcome, Error> {
        let now = options.now.as_deref();
        let agent = options.agent.as_deref();
        let publication = Error::Publication;
        if let Some(issue) = &attempt.issue {
            return Err(publication(PublicationError::Mismatch {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                message: format!(
                    "{} was created by this attempt, so it cannot be treated as not created; attach it instead",
                    issue.display
                ),
            }));
        }
        let unverified = |source| {
            publication(PublicationError::Unverified {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                source,
            })
        };
        let too_soon = || {
            unverified(SourceError::Unavailable(format!(
                "the issues in {} would be read too soon to be conclusive, because a just-created issue may not be listed yet; look again after {}",
                attempt.display_destination(),
                ready_text(&attempt.lease_expires_at)
            )))
        };
        // A listing that starts before the delay ends may return afterward.
        // That read still cannot prove that the provider listed every new issue.
        if !search_settled(&attempt.lease_expires_at, &clock(&self.connection, now)?) {
            return Err(too_soon());
        }
        let search = search_for(&self.connection, attempt, verified_account)?;
        let found = engine
            .find_published(&attempt.provider, &source.saved.config, &search)
            .map_err(unverified)?;
        if !found.matches.is_empty() || !found.recent.is_empty() {
            return Err(publication(PublicationError::Candidates {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                issues: found
                    .matches
                    .iter()
                    .chain(&found.recent)
                    .map(published)
                    .collect(),
            }));
        }
        if !found.complete {
            return Err(unverified(SourceError::Unavailable(format!(
                "the source could not verify that no issue was created in {}",
                attempt.display_destination()
            ))));
        }
        crate::write_scope::run(&self.connection, |transaction| {
            let now = clock(transaction, now)?;
            if !search_settled(&attempt.lease_expires_at, &now) {
                return Err(too_soon());
            }
            let changed = transaction.execute(
            "UPDATE publication_attempts SET status = 'failed', updated_at = ?2, failure_code = ?3, failure_message = ?4 \
             WHERE id = ?1 AND status IN ('in_flight', 'unresolved') AND external_id IS NULL \
             AND lease_expires_at = ?5
             AND (status = 'unresolved' OR julianday(lease_expires_at) <= julianday(?2))",
            params![
                attempt.id,
                now,
                RULED_OUT,
                format!(
                    "Confirmed not created: the recent issues in {} were read completely and none could be the result.",
                    attempt.display_destination()
                ),
                attempt.lease_expires_at,
            ],
        )?;
            if changed == 0 {
                if open_attempt(transaction, &ticket.id, Some(&now))?.is_some_and(|open| {
                    open.id == attempt.id && open.lease_expires_at != attempt.lease_expires_at
                }) {
                    return Err(unverified(SourceError::Unavailable(
                        "the dispatch window changed during the search. Review the attempt and search again".into(),
                    )));
                }
                return self.settled_instead(
                    ticket,
                    &Resolution::NotCreated,
                    AttachmentProof::None,
                    Some(&now),
                );
            }
            history::record(
                transaction,
                &ticket.id,
                "publication",
                "unresolved",
                "not created",
                agent,
            )?;
            let settled = transaction.query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?1"
            ),
            [&attempt.id],
            |row| attempt_from_row(row, &now),
        )?;
            Ok(PublishOutcome {
                ticket: self.show_ticket(&ticket.reference)?,
                attempt: settled,
                replayed: false,
            })
        })
    }
}

fn without_retry_advice(message: &str) -> String {
    message
        .trim_end_matches('.')
        .trim_end_matches("; retry later")
        .to_owned()
}

/// Failure code of an attempt a person confirmed was never created.
const RULED_OUT: &str = "ruled_out";

fn tracker_started_at(connection: &Connection, id: &str) -> Result<Option<String>, Error> {
    Ok(connection
        .query_row(
            "SELECT tracker_started_at FROM github_publication_context WHERE attempt_id = ?1
             UNION ALL SELECT tracker_started_at FROM publication_connections WHERE attempt_id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .flatten())
}

fn search_for(
    connection: &Connection,
    attempt: &PublicationAttempt,
    account: &str,
) -> Result<PublicationSearch, Error> {
    Ok(PublicationSearch {
        account: Some(account.to_owned()),
        request: PublishRequest {
            title: attempt.title.clone(),
            body: attempt.body.clone(),
            destination: attempt.destination.clone(),
        },
        since: search_start(&attempt.started_at),
        tracker_since: tracker_started_at(connection, &attempt.id)?
            .as_deref()
            .map(search_start),
    })
}

fn publication_connection(
    connection: &Connection,
    attempt: &PublicationAttempt,
) -> Result<Option<super::ConfiguredSource>, Error> {
    if attempt.provider == super::GITHUB_INTEGRATION {
        type Context = (String, Option<String>, Option<String>);
        let context: Option<Context> = connection.query_row(
            "SELECT host, login, account_key FROM github_publication_context WHERE attempt_id = ?1",
            [&attempt.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        if let Some((host, Some(login), account_key)) = context {
            return Ok(Some(super::github_integration::recovery_target(
                &host,
                Some(login),
                account_key,
                &attempt.destination,
            )));
        }
    }
    let id: Option<String> = connection
        .query_row(
            "SELECT connection_id FROM publication_connections WHERE attempt_id = ?1",
            [&attempt.id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(id
        .map(|id| configured_source(connection, &id))
        .transpose()?
        .flatten()
        .filter(|source| source.saved.provider == attempt.provider))
}

fn publication_connection_missing() -> SourceError {
    publication_connection_error(
        "the connection originally used for this publication is unavailable on this desktop",
    )
}

fn publication_connection_error(message: impl Into<String>) -> SourceError {
    SourceError::InvalidConfiguration(vec![super::FieldIssue::for_field("connection", message)])
}

fn unbound_attach_help(attempt: &PublicationAttempt) -> String {
    if attempt.provider != super::github::PROVIDER {
        return "The original publication connection is unavailable on this desktop.".into();
    }
    if attempt.destination_host.is_none() || attempt.destination_site_unconfirmed {
        return format!(
            "Verify the original host and any nondefault port. Record the site with `ticketd source resolve {} --confirm-host HOST`.",
            attempt.reference
        );
    }
    format!(
        "The original GitHub login is unavailable. Attach the verified issue with `ticketd source resolve {} --issue ISSUE`.",
        attempt.reference
    )
}

fn verify_unbound_issue(
    attempt: &PublicationAttempt,
    issue: &ExternalIssue,
    account: &str,
) -> Result<(), SourceError> {
    let matches_repository = attempt.destination_host.as_deref().is_some_and(|site| {
        super::github::issue_id_site(&issue.reference.identity.id) == Some(site)
    }) && super::github::split_locator(&issue.reference.locator)
        .is_ok_and(|(repository, _)| repository.eq_ignore_ascii_case(&attempt.destination));
    if !matches_repository {
        return Err(host_configuration_error(
            "the issue is not in the original publication repository".into(),
        ));
    }
    if attempt.issue.is_none() {
        // The old attempt has no authenticated account to restore. For positive
        // attachment, compare the creator the tracker reports today with the
        // selected connection's verified login.
        let same_creator = issue
            .author
            .as_ref()
            .is_some_and(|author| author != "ghost" && author.eq_ignore_ascii_case(account));
        if !same_creator || parse_time(&issue.created_at).is_none() {
            return Err(publication_connection_error(
                "GitHub did not verify that the selected account created this issue at a known time",
            ));
        }
    }
    Ok(())
}

fn verified_publication_engine(
    engine: &Engine,
    source: &super::ConfiguredSource,
) -> Result<(Engine, super::ConnectionInfo), SourceError> {
    source
        .check(engine)
        .map(|(scoped, checked)| (scoped, checked.connection))
}

/// An attempt that has been persisted and is about to call the connector.
struct Started {
    attempt_id: String,
    reference: String,
    ticket_id: String,
    request: PublishRequest,
    source: super::ConfiguredSource,
    agent: Option<String>,
}

enum Linked {
    Done(Box<PublicationAttempt>),
    /// Discovery imported the created issue as a different ticket first.
    Conflict {
        /// How the other ticket got the identity: `published` or `imported`.
        origin: String,
    },
    /// Another process settled the attempt (for example after its lease ran out).
    SettledElsewhere,
}

/// What an open attempt sent, as stored on it.
struct Sent<'a> {
    attempt_id: &'a str,
    ticket_id: &'a str,
    title: &'a str,
    body: &'a str,
    destination: &'a str,
    /// Who asked for the publication or resolution; `None` is the person.
    agent: Option<&'a str>,
    /// A ticket discovery imported for the created issue before it was attached.
    /// It gives its identity to the published ticket and goes to the trash.
    adopt: Option<&'a str>,
    /// `Some(different)` when a person attached an issue they named: `different`
    /// says its text differs from what was sent, so it replaces the ticket's.
    /// `None` for the issue the publication itself created.
    attached: Option<bool>,
    recovery_connection: Option<&'a str>,
}

/// The ticket that holds an external identity, as far as adoption needs to know.
struct Owner {
    ticket_id: String,
    origin: String,
    authority: String,
    linked_at: String,
    issue_url: String,
}

fn identity_owner(
    connection: &Connection,
    identity: &ExternalIdentity,
) -> Result<Option<Owner>, Error> {
    Ok(connection
        .query_row(
            "SELECT i.ticket_id, i.origin, o.authority, i.linked_at, i.url FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id \
             WHERE i.provider = ?1 AND i.external_id = ?2",
            params![identity.provider, identity.id],
            |row| {
                Ok(Owner {
                    ticket_id: row.get(0)?,
                    origin: row.get(1)?,
                    authority: row.get(2)?,
                    linked_at: row.get(3)?,
                    issue_url: row.get(4)?,
                })
            },
        )
        .optional()?)
}

/// Discovery imported the created issue after the attempt began, as a ticket the
/// source still owns. That ticket is the same issue seen from the other side, so
/// the published ticket takes its identity over instead of the two blocking each
/// other forever.
fn adoptable(owner: &Owner, attempt_started_at: &str, issue: &ExternalIssue) -> bool {
    super::legacy_issue_origin_matches(
        &issue.reference.identity.provider,
        &owner.issue_url,
        &issue.url,
    ) && owner.origin == "imported"
        && owner.authority == "external"
        && matches!(
            (parse_time(&owner.linked_at), parse_time(attempt_started_at)),
            (Some(linked), Some(started)) if linked >= started
        )
}

/// Moves the identity, ownership, sync state and source conversation of the
/// imported ticket `from` to `to` and trashes `from`. Nothing on `from` is
/// deleted, so no local work is lost; it stays in the trash.
fn adopt_identity(
    transaction: &Connection,
    from: &str,
    to: &str,
    agent: Option<&str>,
) -> Result<(), Error> {
    // The rows reference each other by ticket id; they are consistent again by
    // the time the transaction commits.
    transaction.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    for table in [
        "external_identities",
        "external_ownership",
        "source_sync",
        "source_conversation",
        "external_duplicate_targets",
    ] {
        transaction.execute(
            &format!("UPDATE {table} SET ticket_id = ?1 WHERE ticket_id = ?2"),
            params![to, from],
        )?;
    }
    transaction.execute(
        "UPDATE external_identities SET origin = 'published' WHERE ticket_id = ?1",
        [to],
    )?;
    transaction.execute("UPDATE tickets SET trashed = 1 WHERE id = ?1", [from])?;
    history::record(transaction, from, "trash", "active", "trashed", agent)?;
    Ok(())
}

/// Links the confirmed issue to the attempt's ticket, transfers ownership and
/// marks the attempt `succeeded`, inside the caller's write transaction. The
/// caller has already checked that the attempt is still open and that the
/// issue's identity is unowned. Shared by the publisher and by resolution.
fn complete_attempt(
    transaction: &Connection,
    sent: &Sent<'_>,
    issue: &ExternalIssue,
    now: &str,
) -> Result<PublicationAttempt, Error> {
    let identity = &issue.reference.identity;
    // The issue holds what the provider has; the ticket takes that text over (the
    // next refresh would do it anyway). Whatever local text it replaces is kept as
    // a note in this same write, so nothing a person wrote is lost.
    let (title, body): (String, String) = transaction.query_row(
        "SELECT title, body FROM tickets WHERE id = ?1",
        [sent.ticket_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let replaced_by_issue = sent.attached == Some(true);
    let mut issue_title = crate::ticket_change::imported_title(&issue.title);
    if issue_title.is_empty() {
        issue_title.clone_from(&issue.display);
    }
    let (new_title, new_body) = if replaced_by_issue {
        (issue_title.as_str(), issue.body.as_str())
    } else {
        (sent.title, sent.body)
    };
    if title != new_title || body != new_body {
        let note = if replaced_by_issue {
            format!(
                "Replaced when attaching {} to this ticket. The issue's title and description now apply; this was the ticket's text before.\n\nTitle: {title}\n\n{body}",
                issue.display
            )
        } else {
            format!(
                "Edited while publishing to {}. The published issue holds the previewed text; these are the later local edits.\n\nTitle: {title}\n\n{body}",
                sent.destination
            )
        };
        activities::add(transaction, sent.ticket_id, &note, sent.agent)?;
        transaction.execute(
            "UPDATE tickets SET title = ?2, body = ?3 WHERE id = ?1",
            params![sent.ticket_id, new_title, new_body],
        )?;
        crate::document_links::index_external_body(transaction, sent.ticket_id, new_body)?;
    }
    match sent.adopt {
        Some(from) => adopt_identity(transaction, from, sent.ticket_id, sent.agent)?,
        None => tracking::link(transaction, sent.ticket_id, issue, Origin::Published, now)?,
    }
    let connection_id: Option<String> = transaction
        .query_row(
            "SELECT connection_id FROM publication_connections WHERE attempt_id = ?1",
            [sent.attempt_id],
            |row| row.get(0),
        )
        .optional()?;
    // An explicit recovery can select how to refresh the verified issue
    // without attributing the historical create to that connection.
    if let Some(connection_id) = connection_id.as_deref().or(sent.recovery_connection) {
        // Adoption cascades discovery's affinity. The connection that confirmed
        // publication takes precedence over the one that happened to import it.
        transaction.execute(
            "UPDATE source_connection_tickets SET connection_id = ?2
             WHERE ticket_id = ?1 AND connection_id <> ?2",
            params![sent.ticket_id, connection_id],
        )?;
        super::bind_ticket(transaction, sent.ticket_id, connection_id)?;
    }
    // An issue that is already closed (attached after the fact) brings its
    // closure with it, as a refresh would apply it.
    tracking::map_closure(transaction, sent.ticket_id, issue)?;
    transaction.execute(
        "UPDATE publication_attempts SET status = 'succeeded', updated_at = ?2, failure_code = NULL, failure_message = NULL, \
         external_id = ?3, locator = ?4, display = ?5, url = ?6, partition = ?7 WHERE id = ?1",
        params![
            sent.attempt_id,
            now,
            identity.id,
            issue.reference.locator,
            issue.display,
            issue.url,
            issue.reference.partition,
        ],
    )?;
    // An attach is recorded apart from a publication: the person linked an issue
    // after an uncertain publication rather than ticketd creating it.
    history::record(
        transaction,
        sent.ticket_id,
        "source",
        if sent.attached.is_some() {
            "attached"
        } else {
            ""
        },
        &issue.display,
        sent.agent,
    )?;
    Ok(transaction.query_row(
        &format!(
            "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?1"
        ),
        [sent.attempt_id],
        |row| attempt_from_row(row, now),
    )?)
}

pub(super) fn check_destination(rules: &DestinationRules, chosen: &str) -> Result<(), SourceError> {
    if let Some(validation) = &rules.validation
        && !validation.format.is_valid(chosen)
    {
        return Err(SourceError::InvalidConfiguration(vec![
            super::FieldIssue::for_field("destination", validation.message.clone()),
        ]));
    }
    Ok(())
}

fn destination_allowed(rules: &DestinationRules, chosen: &str) -> bool {
    rules.destinations.is_empty()
        || rules
            .destinations
            .iter()
            .any(|destination| same_destination(rules, destination, chosen))
}

fn same_destination(rules: &DestinationRules, left: &str, right: &str) -> bool {
    if rules.case_insensitive {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// The same checks publication makes before it records an attempt.
fn destination_refusal(
    rules: &DestinationRules,
    chosen: &str,
) -> Option<(IneligibleReason, String)> {
    if let Err(error) = check_destination(rules, chosen) {
        let message = error
            .issues()
            .first()
            .map_or_else(|| error.to_string(), |issue| issue.message.clone());
        return Some((
            IneligibleReason::InvalidDestination,
            format!("cannot publish to '{chosen}': {message}"),
        ));
    }
    (!destination_allowed(rules, chosen)).then(|| {
        (
            IneligibleReason::DestinationNotAllowed,
            not_allowed_message(chosen, &rules.destinations),
        )
    })
}

fn not_allowed_message(chosen: &str, allowed: &[String]) -> String {
    format!(
        "cannot publish to '{chosen}': this source only publishes to {}",
        allowed.join(", ")
    )
}

enum DestinationChoice {
    ProjectRemote(String),
    Other(String),
    Unselected,
}

impl DestinationChoice {
    fn value(&self) -> Option<&str> {
        match self {
            Self::ProjectRemote(destination) | Self::Other(destination) => Some(destination),
            Self::Unselected => None,
        }
    }
}

fn chosen_destination(
    engine: &Engine,
    provider: &str,
    requested: Option<&str>,
    project_remote: Option<&str>,
    suggested: &[String],
) -> Result<DestinationChoice, Error> {
    if let Some(destination) = requested.map(str::trim).filter(|d| !d.is_empty()) {
        return Ok(DestinationChoice::Other(destination.to_owned()));
    }
    if let Some(remote) = project_remote {
        for destination in suggested {
            if engine
                .repository_for_destination(provider, destination)?
                .is_some_and(|repository| repository.eq_ignore_ascii_case(remote))
            {
                return Ok(DestinationChoice::ProjectRemote(destination.clone()));
            }
        }
    }
    Ok(match suggested {
        [only] => DestinationChoice::Other(only.clone()),
        _ => DestinationChoice::Unselected,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_discovery_holds_an_issue_at_its_complete_publication_site() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
        let ticket = workspace.create_ticket("Candidate").unwrap();
        workspace.connection.execute(
            "INSERT INTO publication_attempts (
                id, ticket_id, provider, destination, destination_host, title, body, status,
                started_at, lease_expires_at, updated_at
             ) VALUES ('attempt', ?1, 'github', 'o/r', 'git.example.test:8443', 'Candidate', '', 'unresolved',
                '2026-01-01T00:00:00Z', '2026-01-01T00:06:00Z', '2026-01-01T00:06:00Z')",
            [&ticket.id],
        ).unwrap();
        let engine = Engine::builtin();
        let mut issue: ExternalIssue = serde_json::from_value(serde_json::json!({
            "reference": {
                "identity": {"provider": "github", "id": "@git.example.test:8443:12"},
                "locator": "o/r#7",
                "partition": "@git.example.test:8443/o/r"
            },
            "display": "o/r#7",
            "url": "https://git.example.test:8443/o/r/issues/7",
            "repository": "git.example.test/o/r",
            "title": "Candidate",
            "body": "",
            "state": {"category": "open", "name": "Open"},
            "assignees": [],
            "labels": [],
            "author": "octo",
            "created_at": "2026-01-01T00:01:00Z",
            "updated_at": "2026-01-01T00:01:00Z"
        }))
        .unwrap();
        let held = |issue: &ExternalIssue| {
            awaited_by_open_attempt(&workspace.connection, &engine, issue).unwrap()
        };
        assert!(held(&issue));
        let attempt = workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .remove(0);
        assert!(verify_unbound_issue(&attempt, &issue, "octo").is_ok());
        issue.reference.identity.id = "@git.example.test:9443:12".into();
        assert!(!held(&issue));
        assert!(verify_unbound_issue(&attempt, &issue, "octo").is_err());

        // A legacy hostname without a confirmed port can still be this site.
        workspace
            .connection
            .execute(
                "UPDATE publication_attempts
             SET destination_host = 'git.example.test', destination_site_unconfirmed = 1
             WHERE id = 'attempt'",
                [],
            )
            .unwrap();
        assert!(held(&issue));
        issue.reference.identity.id = "@other.example.test:9443:12".into();
        assert!(!held(&issue));
    }
}
