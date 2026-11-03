//! One-time publication of a locally owned ticket as an ordinary external issue.
//!
//! Creating the issue and recording it locally cannot be one atomic step, so the
//! workflow is built around a durable **publication attempt**:
//!
//! 1. A short write transaction checks eligibility and inserts the attempt as
//!    `in_flight`, with the exact title, description and destination to send. At
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

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    ConfigValues, Engine, ExternalIdentity, ExternalIssue, ExternalRef, PublicationSearch,
    PublishRequest, SourceError, SourceFailure, clock,
    tracking::{self, Origin, failure_of},
};
use crate::{Error, Status, Ticket, Workspace, history, notes, transaction_write_lock};

/// How long an `in_flight` attempt is trusted to still be running. The HTTP
/// transport gives up after 30 seconds, so a live create finishes well inside it.
const LEASE_SECONDS: i64 = 120;

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
}

/// One try at creating an external issue for a ticket. Holds exactly what was
/// (or would be) sent; never a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationAttempt {
    pub id: String,
    pub reference: String,
    pub provider: String,
    pub destination: String,
    pub title: String,
    pub body: String,
    /// The effective state: a stored `in_flight` attempt past its lease reads
    /// as `unresolved`.
    pub state: AttemptState,
    pub started_at: String,
    pub updated_at: String,
    pub failure: Option<SourceFailure>,
    pub issue: Option<PublishedIssue>,
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
    pub notes: u64,
    pub plan: Option<String>,
    pub tags: Vec<String>,
    pub subtickets: Vec<String>,
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
    /// Sent exactly as shown.
    pub title: String,
    pub body: String,
    /// Identifies this title, description and destination. Hand it back in
    /// [`PublishOptions::expected_fingerprint`] to publish exactly this.
    pub fingerprint: String,
    pub local: PublicationLocalData,
    pub eligibility: Eligibility,
    /// The open attempt blocking publication, if any.
    pub attempt: Option<PublicationAttempt>,
}

#[derive(Debug, Clone, Default)]
pub struct PublishOptions {
    pub provider: String,
    /// Connector-defined destination such as `owner/name`. Defaults to the
    /// only suggested destination.
    pub destination: Option<String>,
    /// The time to record, as RFC 3339; the database clock when absent.
    pub now: Option<String>,
    /// The [`PublicationPreview::fingerprint`] the person reviewed. When given,
    /// publishing is refused if the title, description or destination changed
    /// since, so exactly what was previewed is what is sent.
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
    pub provider_name: String,
    pub known: Vec<String>,
    pub unknown: String,
    /// Why publishing is blocked and why another try is not safe yet.
    pub note: String,
    pub actions: Vec<ResolutionAction>,
    /// Issues in the destination whose title or description equals what was sent.
    /// While any exists, "not created" is refused.
    pub candidates: Vec<PublicationCandidate>,
    /// Other issues the connected account created in the window. For information:
    /// they do not block "not created" and can still be attached.
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
fn search_ready_at(started_at: &str) -> Option<String> {
    parse_time(started_at).map(|time| {
        (time + chrono::Duration::seconds(LEASE_SECONDS + LISTING_LAG_SECONDS))
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    })
}

fn ready_text(started_at: &str) -> String {
    search_ready_at(started_at)
        .as_deref()
        .and_then(parse_time)
        .map_or_else(
            || "a few minutes from now".to_owned(),
            |time| format!("{} UTC", time.with_timezone(&chrono::Utc).format("%H:%M")),
        )
}

fn search_settled(started_at: &str, now: &str) -> bool {
    match (
        search_ready_at(started_at).as_deref().and_then(parse_time),
        parse_time(now),
    ) {
        (Some(ready), Some(now)) => now >= ready,
        _ => true,
    }
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
fn fingerprint(title: &str, body: &str, destination: Option<&str>) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in [title, body, destination.unwrap_or("")] {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

fn published(issue: &ExternalIssue) -> PublishedIssue {
    PublishedIssue {
        identity: issue.reference.identity.clone(),
        locator: issue.reference.locator.clone(),
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
    issue: &ExternalIssue,
) -> Result<bool, Error> {
    let mut statement = connection.prepare(
        "SELECT title, body, started_at FROM publication_attempts \
         WHERE provider = ?1 AND status IN ('in_flight', 'unresolved')",
    )?;
    let attempts = statement
        .query_map([&issue.reference.identity.provider], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(attempts.iter().any(|(title, body, started_at)| {
        !predates(&issue.created_at, started_at)
            && (plain(&issue.title) == plain(title)
                || (!plain(body).is_empty() && plain(&issue.body) == plain(body)))
    }))
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
         CREATE INDEX publication_attempts_ticket ON publication_attempts(ticket_id, started_at); \
         PRAGMA user_version = 26;",
    )?;
    Ok(())
}

const ATTEMPT_COLUMNS: &str = "a.id, t.number, a.provider, a.destination, a.title, a.body, a.status, \
     a.started_at, a.updated_at, a.failure_code, a.failure_message, a.external_id, a.locator, \
     a.display, a.url, a.lease_expires_at";

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
        reference: format!("T-{}", row.get::<_, i64>(1)?),
        issue: external_id
            .zip(locator)
            .map(|(id, locator)| PublishedIssue {
                identity: ExternalIdentity {
                    provider: provider.clone(),
                    id,
                },
                locator,
                display: display.unwrap_or_default(),
                url: url.unwrap_or_default(),
            }),
        provider,
        destination: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        state,
        started_at: row.get(7)?,
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
        .query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
                 WHERE a.ticket_id = ?1 AND a.status IN ('in_flight', 'unresolved')"
            ),
            [ticket_id],
            |row| attempt_from_row(row, &now),
        )
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
}

fn subject(connection: &Connection, reference: &str) -> Result<Subject, Error> {
    let number = reference
        .strip_prefix("T-")
        .and_then(|value| value.parse::<i64>().ok());
    connection
        .query_row(
            "SELECT id, number, title, body, status, trashed FROM tickets WHERE number = ?1",
            [number],
            |row| {
                let status: String = row.get(4)?;
                Ok(Subject {
                    id: row.get(0)?,
                    reference: format!("T-{}", row.get::<_, i64>(1)?),
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
    provider_name: &str,
    now: Option<&str>,
) -> Result<Eligibility, Error> {
    let reference = &ticket.reference;
    if ticket.trashed {
        return Ok(ineligible(
            IneligibleReason::Trashed,
            format!("{reference} is in the trash; restore it to publish it"),
        ));
    }
    let owned: Option<(String, String, String)> = connection
        .query_row(
            "SELECT o.authority, i.origin, i.display FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id WHERE i.ticket_id = ?1",
            [&ticket.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match owned {
        Some((authority, origin, display)) if authority == "external" => {
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
        Some((_, _, display)) => {
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
        let message = match attempt.state {
            AttemptState::InFlight => {
                format!(
                    "{reference} is already being published to {}",
                    attempt.destination
                )
            }
            AttemptState::Unresolved | AttemptState::Failed | AttemptState::Succeeded => format!(
                "an earlier attempt to publish {reference} to {} may have created an issue on {provider_name}; resolve it before creating another",
                attempt.destination
            ),
        };
        return Ok(ineligible(IneligibleReason::AttemptOpen, message));
    }
    Ok(Eligibility::Eligible)
}

/// What must exist before anything can be published to `provider`: a connector
/// that can create issues and a saved configuration to publish with.
fn require_target<'a>(
    engine: &Engine,
    provider: &str,
    provider_name: &str,
    target: Option<&'a Target>,
) -> Result<&'a Target, (IneligibleReason, String)> {
    if !engine.can_publish(provider) {
        return Err((
            IneligibleReason::Unsupported,
            format!("{provider_name} cannot create issues from ticketd"),
        ));
    }
    target.ok_or_else(|| {
        (
            IneligibleReason::SourceNotConnected,
            format!("connect {provider_name} in Settings before publishing"),
        )
    })
}

/// A saved configuration's destination choices and the one to use.
struct Target {
    config: ConfigValues,
    destinations: Vec<String>,
}

impl Workspace {
    fn publication_target(&self, engine: &Engine, provider: &str) -> Result<Option<Target>, Error> {
        let Some(saved) = self.saved_source(provider)? else {
            return Ok(None);
        };
        let destinations = engine.publish_destinations(provider, &saved.config)?;
        Ok(Some(Target {
            config: saved.config,
            destinations,
        }))
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
        let descriptor = engine.descriptor(provider)?;
        let ticket = subject(&self.connection, reference)?;
        let target = self.publication_target(engine, provider)?;
        let destinations = target
            .as_ref()
            .map(|t| t.destinations.clone())
            .unwrap_or_default();
        let destination = chosen_destination(destination, &destinations);
        let mut eligibility = eligibility(&self.connection, &ticket, &descriptor.name, None)?;
        if matches!(eligibility, Eligibility::Eligible)
            && let Err((reason, message)) =
                require_target(engine, provider, &descriptor.name, target.as_ref())
        {
            eligibility = ineligible(reason, message);
        }
        Ok(PublicationPreview {
            reference: ticket.reference,
            provider: provider.to_owned(),
            provider_name: descriptor.name,
            fingerprint: fingerprint(&ticket.title, &ticket.body, destination.as_deref()),
            destination,
            destinations,
            title: ticket.title,
            body: ticket.body,
            local: PublicationLocalData {
                notes: self.connection.query_row("SELECT COUNT(*) FROM notes WHERE ticket_id = ?1", [&ticket.id], |row| row.get(0))?,
                plan: self.connection.query_row("SELECT e.name FROM tickets t JOIN plans e ON e.id = t.plan_id WHERE t.id = ?1", [&ticket.id], |row| row.get(0)).optional()?,
                tags: crate::tags::for_ticket(&self.connection, &ticket.id)?,
                subtickets: {
                    let mut statement = self.connection.prepare("SELECT 'T-' || t.number FROM ticket_parents p JOIN tickets t ON t.id = p.child_id WHERE p.parent_id = ?1 ORDER BY t.number")?;
                    statement.query_map([&ticket.id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?
                },
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
        let provider = options.provider.as_str();
        let descriptor = engine.descriptor(provider)?;
        let target = self.publication_target(engine, provider)?;
        let started = {
            let transaction = self.connection.savepoint()?;
            transaction_write_lock(&transaction)?;
            let ticket = subject(&transaction, reference)?;
            if let Some(attempt) =
                latest_succeeded(&transaction, &ticket.id, options.now.as_deref())?
                && matches!(
                    tracking::authority(&transaction, &ticket.id)?,
                    tracking::Authority::External { .. }
                )
            {
                transaction.commit()?;
                return Ok(PublishOutcome {
                    ticket: self.show_ticket(reference)?,
                    attempt,
                    replayed: true,
                });
            }
            let refuse = |reason, message| {
                Error::Publication(PublicationError::Ineligible {
                    reference: ticket.reference.clone(),
                    reason,
                    message,
                })
            };
            if let Eligibility::Ineligible { reason, message } = eligibility(
                &transaction,
                &ticket,
                &descriptor.name,
                options.now.as_deref(),
            )? {
                return Err(refuse(reason, message));
            }
            let target = match require_target(engine, provider, &descriptor.name, target.as_ref()) {
                Ok(target) => target,
                Err((reason, message)) => return Err(refuse(reason, message)),
            };
            let Some(destination) =
                chosen_destination(options.destination.as_deref(), &target.destinations)
            else {
                return Err(Error::Source(SourceError::InvalidConfiguration(vec![
                    super::FieldIssue {
                        field: "destination".into(),
                        message: "choose where to publish".into(),
                    },
                ])));
            };
            // Send exactly what was previewed, or nothing.
            if let Some(expected) = &options.expected_fingerprint
                && *expected != fingerprint(&ticket.title, &ticket.body, Some(&destination))
            {
                return Err(PublicationError::ChangedSincePreview {
                    reference: ticket.reference,
                }
                .into());
            }
            let now = clock(&transaction, options.now.as_deref())?;
            let attempt_id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO publication_attempts (id, ticket_id, provider, destination, title, body, status, started_at, lease_expires_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'in_flight', ?7, strftime('%Y-%m-%dT%H:%M:%fZ', ?7, ?8), ?7)",
                params![
                    attempt_id,
                    ticket.id,
                    provider,
                    destination,
                    ticket.title,
                    ticket.body,
                    now,
                    format!("+{LEASE_SECONDS} seconds"),
                ],
            )?;
            transaction.commit()?;
            Started {
                attempt_id,
                reference: ticket.reference,
                ticket_id: ticket.id,
                request: PublishRequest {
                    title: ticket.title,
                    body: ticket.body,
                    destination,
                },
                config: target.config.clone(),
                agent: options.agent.clone(),
            }
        };

        // The remote write. Nothing is held open: another process may read or
        // write the workspace meanwhile and sees the attempt in flight.
        let result = engine.publish(provider, &started.config, &started.request);
        match result {
            Ok(issue) => self.finish_created(&started, &descriptor.name, &issue, options),
            Err(error) if error.ruled_out_creation() => {
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
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
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
        let adopt = match identity_owner(&transaction, identity)? {
            None => None,
            Some(owner) if adoptable(&owner, &started_at) => Some(owner.ticket_id),
            Some(owner) => {
                return Ok(Linked::Conflict {
                    origin: owner.origin,
                });
            }
        };
        let now = clock(&transaction, now)?;
        let attempt = complete_attempt(
            &transaction,
            &Sent {
                attempt_id: &started.attempt_id,
                ticket_id: &started.ticket_id,
                title: &started.request.title,
                body: &started.request.body,
                destination: &started.request.destination,
                agent: started.agent.as_deref(),
                adopt: adopt.as_deref(),
                attached: None,
            },
            issue,
            &now,
        )?;
        transaction.commit()?;
        Ok(Linked::Done(Box::new(attempt)))
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
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let now = clock(&transaction, now)?;
        let first_unknown: Option<(String, String)> = if status == AttemptState::Unresolved {
            transaction.query_row("SELECT ticket_id, destination FROM publication_attempts WHERE id = ?1 AND status = 'in_flight'", [attempt_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?
        } else {
            None
        };
        transaction.execute(
            "UPDATE publication_attempts SET status = ?2, updated_at = ?3, failure_code = ?4, failure_message = ?5, \
             external_id = COALESCE(?6, external_id), locator = COALESCE(?7, locator), display = COALESCE(?8, display), url = COALESCE(?9, url) \
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
            ],
        )?;
        if let Some((ticket, destination)) = first_unknown {
            history::record(
                &transaction,
                &ticket,
                "publication_unresolved",
                attempt_id,
                &destination,
                None,
            )?;
        }
        transaction.commit()?;
        Ok(())
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

/// Resolution of uncertain attempts. Each resolution is verified outside any
/// transaction, then settled in one write that compares the attempt's stored
/// status with what was read, so competing resolvers, a running publisher and
/// discovery can never both win.
impl Workspace {
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
        let name = engine.descriptor(&attempt.provider)?.name;
        let running = attempt.state == AttemptState::InFlight;
        let mut known = vec![format!(
            "ticketd asked {name} to create \"{}\" in {}.",
            attempt.title, attempt.destination
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
        let mut lookup_failure = None;
        let settled = search_settled(&attempt.started_at, &now);
        if search
            && !running
            && attempt.issue.is_none()
            && let Some(saved) = self.saved_source(&attempt.provider)?
        {
            match engine.find_published(
                &attempt.provider,
                &saved.config,
                &search_for(&attempt, Some(&saved.account)),
            ) {
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
        let not_created_available =
            !running && attempt.issue.is_none() && candidates.is_empty() && !search_blocks;
        let conflict = attempt
            .failure
            .as_ref()
            .filter(|f| f.code == "identity_conflict");
        let actions = vec![
            ResolutionAction {
                kind: ActionKind::Attach,
                available: !running && conflict.is_none(),
                label: "Attach the created issue".into(),
                detail: if running {
                    "Wait for the request to finish first.".into()
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
                        attempt.destination
                    )
                },
            },
            ResolutionAction {
                kind: ActionKind::NotCreated,
                available: not_created_available,
                label: "Confirm nothing was created".into(),
                detail: if running {
                    "Wait for the request to finish first.".into()
                } else if attempt.issue.is_some() {
                    "Not possible: the issue is known to exist.".into()
                } else if !candidates.is_empty() {
                    "Not possible: issues that may be this publication already exist.".into()
                } else if lookup_failure.is_some() {
                    format!(
                        "Not possible right now: {name} could not be searched, which does not mean nothing was created."
                    )
                } else if candidates_complete == Some(false) && !settled {
                    format!(
                        "Not possible yet: {name} may not list a just-created issue for a minute or so. Look again after {}.",
                        ready_text(&attempt.started_at)
                    )
                } else if candidates_complete == Some(false) {
                    format!(
                        "Not possible: only part of the recent issues in {} could be read.",
                        attempt.destination
                    )
                } else {
                    format!(
                        "Only when {name}'s recent issues in {} can be read completely and none matches. Anything less leaves this unresolved.",
                        attempt.destination
                    )
                },
            },
        ];
        Ok(PublicationReview {
            provider_name: name,
            known,
            unknown,
            note: "Publishing again is blocked: if the issue exists, creating another would duplicate it. It becomes available only after nothing is confirmed to have been created.".into(),
            actions,
            candidates,
            other_recent,
            candidates_complete,
            search_ready_at: search_ready_at(&attempt.started_at),
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
                None,
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
        let unverified = |source| {
            Error::Publication(PublicationError::Unverified {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                source,
            })
        };
        let Some(saved) = self.saved_source(&attempt.provider)? else {
            return Err(unverified(SourceError::InvalidConfiguration(vec![
                super::FieldIssue {
                    field: "source".into(),
                    message: format!(
                        "connect {} again before resolving this publication",
                        super::provider_display_name(&attempt.provider)
                    ),
                },
            ])));
        };
        match &options.resolution {
            Resolution::Attach { issue } => {
                let found = match (
                    issue.as_deref().map(str::trim).filter(|t| !t.is_empty()),
                    &attempt.issue,
                ) {
                    (Some(text), _) => engine
                        .locate(&attempt.provider, &saved.config, &attempt.destination, text)
                        .map_err(|error| match error {
                            // A mistake in what was typed (another repository, not an
                            // issue number), not a failure to verify anything.
                            SourceError::InvalidConfiguration(issues) => {
                                Error::Publication(PublicationError::Mismatch {
                                    reference: ticket.reference.clone(),
                                    attempt_id: attempt.id.clone(),
                                    message: issues
                                        .iter()
                                        .map(|issue| format!("the issue {}", issue.message))
                                        .collect::<Vec<_>>()
                                        .join("; "),
                                })
                            }
                            other => unverified(other),
                        })?,
                    (None, Some(known)) => engine
                        .fetch(
                            &attempt.provider,
                            &saved.config,
                            &ExternalRef {
                                identity: known.identity.clone(),
                                locator: known.locator.clone(),
                            },
                        )
                        .map_err(unverified)?,
                    (None, None) => {
                        return Err(PublicationError::Mismatch {
                            reference: ticket.reference,
                            attempt_id: attempt.id,
                            message: format!(
                                "name the issue that was created in {} (a number or link); ticketd never guesses it from the title",
                                attempt.destination
                            ),
                        }
                        .into());
                    }
                };
                self.attach_verified(
                    &ticket,
                    &attempt,
                    &found,
                    options.now.as_deref(),
                    options.agent.as_deref(),
                    options.accept_different_content,
                )
            }
            Resolution::NotCreated => self.rule_out(
                engine,
                &ticket,
                &attempt,
                &saved,
                options.now.as_deref(),
                options.agent.as_deref(),
            ),
        }
    }

    /// The outcome when no attempt is open: a replay of the same resolution, a
    /// settled attempt that disagrees, or nothing to resolve.
    fn settled_instead(
        &self,
        ticket: &Subject,
        resolution: &Resolution,
        identity: Option<&ExternalIdentity>,
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
            (Resolution::Attach { .. }, AttemptState::Succeeded) => {
                let same = identity.is_none_or(|id| {
                    latest
                        .issue
                        .as_ref()
                        .is_some_and(|issue| &issue.identity == id)
                });
                if same {
                    replay(latest)
                } else {
                    Err(settled(
                        &latest,
                        "this publication was already completed with a different issue; nothing was changed",
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

    /// Attaches an issue the source has verified, if the attempt is still open.
    fn attach_verified(
        &mut self,
        ticket: &Subject,
        attempt: &PublicationAttempt,
        issue: &ExternalIssue,
        now: Option<&str>,
        agent: Option<&str>,
        accept_different_content: bool,
    ) -> Result<PublishOutcome, Error> {
        let identity = &issue.reference.identity;
        let mismatch = |message: String| {
            Error::Publication(PublicationError::Mismatch {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                message,
            })
        };
        if let Some(known) = &attempt.issue
            && &known.identity != identity
        {
            return Err(mismatch(format!(
                "this attempt already created {}, not {}",
                known.display, issue.display
            )));
        }
        if attempt.issue.is_none() && predates(&issue.created_at, &attempt.started_at) {
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
        if different && !accept_different_content {
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
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        // Compare-and-set: the attempt must still be the same open attempt.
        let still_open = open_attempt(&transaction, &ticket.id, now)?
            .is_some_and(|open| open.id == attempt.id && open.state != AttemptState::InFlight);
        if !still_open {
            drop(transaction);
            return self.settled_instead(
                ticket,
                &Resolution::Attach { issue: None },
                Some(identity),
                now,
            );
        }
        // The ticket may have moved on while the issue was being verified (the
        // person finished or trashed it): attaching would give an externally owned
        // Done ticket an open issue. Re-check what publishing checked.
        let current = subject(&transaction, &ticket.reference)?;
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
        let owner = identity_owner(&transaction, identity)?;
        let adopt = match &owner {
            Some(owner) if adoptable(owner, &attempt.started_at) => Some(owner.ticket_id.clone()),
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
        let now = clock(&transaction, now)?;
        let settled = complete_attempt(
            &transaction,
            &Sent {
                attempt_id: &attempt.id,
                ticket_id: &ticket.id,
                title: &attempt.title,
                body: &attempt.body,
                destination: &attempt.destination,
                agent,
                adopt: adopt.as_deref(),
                attached: Some(different),
            },
            issue,
            &now,
        )?;
        transaction.commit()?;
        Ok(PublishOutcome {
            ticket: self.show_ticket(&ticket.reference)?,
            attempt: settled,
            replayed: false,
        })
    }

    /// Accepts "nothing was created" only on positive evidence: the source read
    /// the whole window and nothing in it could be this publication's result.
    fn rule_out(
        &mut self,
        engine: &Engine,
        ticket: &Subject,
        attempt: &PublicationAttempt,
        saved: &super::SavedSource,
        now: Option<&str>,
        agent: Option<&str>,
    ) -> Result<PublishOutcome, Error> {
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
        let found = engine
            .find_published(
                &attempt.provider,
                &saved.config,
                &search_for(attempt, Some(&saved.account)),
            )
            .map_err(unverified)?;
        if !found.matches.is_empty() {
            return Err(publication(PublicationError::Candidates {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                issues: found.matches.iter().map(published).collect(),
            }));
        }
        if !found.complete {
            return Err(unverified(SourceError::Unavailable(format!(
                "only part of the recent issues in {} could be read",
                attempt.destination
            ))));
        }
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let now = clock(&transaction, now)?;
        // The listing lags a creation by a few seconds, so a read this soon after
        // the create call could last have landed may miss the issue it made.
        if !search_settled(&attempt.started_at, &now) {
            drop(transaction);
            return Err(unverified(SourceError::Unavailable(format!(
                "the issues in {} were read too soon to be conclusive, because a just-created issue may not be listed yet; look again after {}",
                attempt.destination,
                ready_text(&attempt.started_at)
            ))));
        }
        let changed = transaction.execute(
            "UPDATE publication_attempts SET status = 'failed', updated_at = ?2, failure_code = ?3, failure_message = ?4 \
             WHERE id = ?1 AND status IN ('in_flight', 'unresolved') AND external_id IS NULL \
             AND (status = 'unresolved' OR lease_expires_at <= ?2)",
            params![
                attempt.id,
                now,
                RULED_OUT,
                format!(
                    "Confirmed not created: the recent issues in {} were read completely and none matched, so a new attempt is safe.",
                    attempt.destination
                ),
            ],
        )?;
        if changed == 0 {
            drop(transaction);
            return self.settled_instead(ticket, &Resolution::NotCreated, None, Some(&now));
        }
        history::record(
            &transaction,
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
        transaction.commit()?;
        Ok(PublishOutcome {
            ticket: self.show_ticket(&ticket.reference)?,
            attempt: settled,
            replayed: false,
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

fn search_for(attempt: &PublicationAttempt, account: Option<&str>) -> PublicationSearch {
    PublicationSearch {
        account: account.map(str::to_owned),
        request: PublishRequest {
            title: attempt.title.clone(),
            body: attempt.body.clone(),
            destination: attempt.destination.clone(),
        },
        since: search_start(&attempt.started_at),
    }
}

/// An attempt that has been persisted and is about to call the connector.
struct Started {
    attempt_id: String,
    reference: String,
    ticket_id: String,
    request: PublishRequest,
    config: ConfigValues,
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
}

/// The ticket that holds an external identity, as far as adoption needs to know.
struct Owner {
    ticket_id: String,
    origin: String,
    authority: String,
    linked_at: String,
}

fn identity_owner(
    connection: &Connection,
    identity: &ExternalIdentity,
) -> Result<Option<Owner>, Error> {
    Ok(connection
        .query_row(
            "SELECT i.ticket_id, i.origin, o.authority, i.linked_at FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id \
             WHERE i.provider = ?1 AND i.external_id = ?2",
            params![identity.provider, identity.id],
            |row| {
                Ok(Owner {
                    ticket_id: row.get(0)?,
                    origin: row.get(1)?,
                    authority: row.get(2)?,
                    linked_at: row.get(3)?,
                })
            },
        )
        .optional()?)
}

/// Discovery imported the created issue after the attempt began, as a ticket the
/// source still owns. That ticket is the same issue seen from the other side, so
/// the published ticket takes its identity over instead of the two blocking each
/// other forever.
fn adoptable(owner: &Owner, attempt_started_at: &str) -> bool {
    owner.origin == "imported"
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
    let (new_title, new_body) = if replaced_by_issue {
        (issue.title.as_str(), issue.body.as_str())
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
        notes::add(transaction, sent.ticket_id, &note, sent.agent)?;
        transaction.execute(
            "UPDATE tickets SET title = ?2, body = ?3 WHERE id = ?1",
            params![sent.ticket_id, new_title, new_body],
        )?;
    }
    match sent.adopt {
        Some(from) => adopt_identity(transaction, from, sent.ticket_id, sent.agent)?,
        None => tracking::link(transaction, sent.ticket_id, issue, Origin::Published, now)?,
    }
    // An issue that is already closed (attached after the fact) brings its
    // closure with it, as a refresh would apply it.
    tracking::map_closure(transaction, sent.ticket_id, issue)?;
    transaction.execute(
        "UPDATE publication_attempts SET status = 'succeeded', updated_at = ?2, failure_code = NULL, failure_message = NULL, \
         external_id = ?3, locator = ?4, display = ?5, url = ?6 WHERE id = ?1",
        params![
            sent.attempt_id,
            now,
            identity.id,
            issue.reference.locator,
            issue.display,
            issue.url
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

fn chosen_destination(requested: Option<&str>, suggested: &[String]) -> Option<String> {
    match requested.map(str::trim).filter(|d| !d.is_empty()) {
        Some(destination) => Some(destination.to_owned()),
        None => match suggested {
            [only] => Some(only.clone()),
            _ => None,
        },
    }
}
