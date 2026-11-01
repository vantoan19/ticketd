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
    PublishRequest, SourceError, SourceFailure,
    tracking::{self, Origin},
};
use crate::{Error, Status, Ticket, Workspace, history, notes, transaction_write_lock};

/// How long an `in_flight` attempt is trusted to still be running. The HTTP
/// transport gives up after 30 seconds, so a live create finishes well inside it.
const LEASE_SECONDS: i64 = 120;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

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
    /// Whether the provider may already hold an issue for this attempt.
    pub fn may_have_created(self) -> bool {
        matches!(self, Self::InFlight | Self::Unresolved | Self::Succeeded)
    }

    pub fn blocks_create(self) -> bool {
        matches!(self, Self::InFlight | Self::Unresolved)
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

impl PublicationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ineligible { .. } => "publication_ineligible",
            Self::Failed { .. } => "publication_failed",
            Self::Unresolved { .. } => "publication_unresolved",
            Self::NothingToResolve { .. } => "publication_nothing_to_resolve",
            Self::StillRunning { .. } => "publication_still_running",
            Self::Unverified { .. } => "publication_unverified",
            Self::Mismatch { .. } => "publication_mismatch",
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
    /// Issues in the destination that may be this publication's result.
    pub candidates: Vec<PublishedIssue>,
    /// `None` when no search ran or it failed; `Some(true)` when the whole
    /// window was read.
    pub candidates_complete: Option<bool>,
    pub lookup_failure: Option<SourceFailure>,
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

fn published(issue: &ExternalIssue) -> PublishedIssue {
    PublishedIssue {
        identity: issue.reference.identity.clone(),
        locator: issue.reference.locator.clone(),
        display: issue.display.clone(),
        url: issue.url.clone(),
    }
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
     a.display, a.url, (a.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

fn attempt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PublicationAttempt> {
    let status: String = row.get(6)?;
    let expired: bool = row.get(15)?;
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
        _ => AttemptState::Succeeded,
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
) -> Result<Option<PublicationAttempt>, Error> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
                 WHERE a.ticket_id = ?1 AND a.status IN ('in_flight', 'unresolved')"
            ),
            [ticket_id],
            attempt_from_row,
        )
        .optional()?)
}

fn latest_succeeded(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Option<PublicationAttempt>, Error> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
                 WHERE a.ticket_id = ?1 AND a.status = 'succeeded' ORDER BY a.started_at DESC LIMIT 1"
            ),
            [ticket_id],
            attempt_from_row,
        )
        .optional()?)
}

/// Fills `Ticket.publication` with the attempt that blocks publishing, if any.
pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    ticket.publication = open_attempt(connection, &ticket.id)?;
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
            "SELECT o.authority, i.provider, i.display FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id WHERE i.ticket_id = ?1",
            [&ticket.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match owned {
        Some((authority, _, display)) if authority == "external" => {
            return Ok(ineligible(
                IneligibleReason::ExternallyOwned,
                format!(
                    "{reference} is already {display} on {provider_name} and is owned there; it is published only once"
                ),
            ));
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
    if !matches!(
        ticket.status,
        Status::Todo | Status::InProgress | Status::InReview
    ) {
        return Ok(ineligible(
            IneligibleReason::Status,
            format!(
                "{reference} is {}; only Todo, In progress and In review tickets can be published, so finished, canceled and duplicate tickets stay local",
                ticket.status
            ),
        ));
    }
    if let Some(attempt) = open_attempt(connection, &ticket.id)? {
        let message = match attempt.state {
            AttemptState::InFlight => {
                format!(
                    "{reference} is already being published to {}",
                    attempt.destination
                )
            }
            _ => format!(
                "an earlier attempt to publish {reference} to {} may have created an issue on {provider_name}; resolve it before creating another",
                attempt.destination
            ),
        };
        return Ok(ineligible(IneligibleReason::AttemptOpen, message));
    }
    Ok(Eligibility::Eligible)
}

fn clock(connection: &Connection, now: Option<&str>) -> Result<String, Error> {
    Ok(match now {
        Some(now) => now.to_owned(),
        None => connection.query_row(&format!("SELECT {NOW}"), [], |row| row.get(0))?,
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
        let mut eligibility = eligibility(&self.connection, &ticket, &descriptor.name)?;
        if matches!(eligibility, Eligibility::Eligible) {
            if !engine.can_publish(provider) {
                eligibility = ineligible(
                    IneligibleReason::Unsupported,
                    format!("{} cannot create issues from ticketd", descriptor.name),
                );
            } else if target.is_none() {
                eligibility = ineligible(
                    IneligibleReason::SourceNotConnected,
                    format!(
                        "connect {} in Settings (or `ticketd source save {provider}`) before publishing",
                        descriptor.name
                    ),
                );
            }
        }
        Ok(PublicationPreview {
            reference: ticket.reference,
            provider: provider.to_owned(),
            provider_name: descriptor.name,
            destination,
            destinations,
            title: ticket.title,
            body: ticket.body,
            eligibility,
            attempt: open_attempt(&self.connection, &ticket.id)?,
        })
    }

    /// Every publication attempt for `reference`, newest first.
    pub fn publication_attempts(&self, reference: &str) -> Result<Vec<PublicationAttempt>, Error> {
        let ticket = subject(&self.connection, reference)?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
             WHERE a.ticket_id = ?1 ORDER BY a.started_at DESC, a.rowid DESC"
        ))?;
        let attempts = statement
            .query_map([&ticket.id], attempt_from_row)?
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
            if let Some(attempt) = latest_succeeded(&transaction, &ticket.id)?
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
            if let Eligibility::Ineligible { reason, message } =
                eligibility(&transaction, &ticket, &descriptor.name)?
            {
                return Err(refuse(reason, message));
            }
            if !engine.can_publish(provider) {
                return Err(refuse(
                    IneligibleReason::Unsupported,
                    format!("{} cannot create issues from ticketd", descriptor.name),
                ));
            }
            let Some(target) = target else {
                return Err(refuse(
                    IneligibleReason::SourceNotConnected,
                    format!(
                        "connect {} in Settings (or `ticketd source save {provider}`) before publishing",
                        descriptor.name
                    ),
                ));
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
                config: target.config,
            }
        };

        // The remote write. Nothing is held open: another process may read or
        // write the workspace meanwhile and sees the attempt in flight.
        let result = engine.publish(provider, &started.config, &started.request);
        match result {
            Ok(issue) => self.finish_created(&started, provider, &descriptor.name, &issue, options),
            Err(error) if error.ruled_out_creation() => {
                // If this write fails the attempt stays in flight, which is the
                // safe direction: it blocks until it can be resolved.
                let _ = self.settle(
                    &started.attempt_id,
                    "failed",
                    Some(&failure(&error)),
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
                let message = format!("{}.", error.to_string().trim_end_matches('.'));
                let _ = self.settle(
                    &started.attempt_id,
                    "unresolved",
                    Some(&failure(&error)),
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
    /// effort) and the attempt stays unresolved.
    fn finish_created(
        &mut self,
        started: &Started,
        provider: &str,
        provider_name: &str,
        issue: &ExternalIssue,
        options: &PublishOptions,
    ) -> Result<PublishOutcome, Error> {
        let linked = self.link_created(started, provider, issue, options.now.as_deref());
        let (code, message) = match linked {
            Ok(Linked::Done(attempt)) => {
                let attempt = *attempt;
                return Ok(PublishOutcome {
                    ticket: self.show_ticket(&started.reference)?,
                    attempt,
                    replayed: false,
                });
            }
            Ok(Linked::Conflict) => (
                "identity_conflict",
                format!(
                    "{provider_name} created {}, but discovery had already imported that issue as another ticket, so it was not attached here.",
                    issue.display
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
            "unresolved",
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
        provider: &str,
        issue: &ExternalIssue,
        now: Option<&str>,
    ) -> Result<Linked, Error> {
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let still_open: bool = transaction.query_row(
            "SELECT status = 'in_flight' FROM publication_attempts WHERE id = ?1",
            [&started.attempt_id],
            |row| row.get(0),
        )?;
        if !still_open {
            return Ok(Linked::SettledElsewhere);
        }
        let identity = &issue.reference.identity;
        let taken: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM external_identities WHERE provider = ?1 AND external_id = ?2)",
            params![identity.provider, identity.id],
            |row| row.get(0),
        )?;
        if taken {
            return Ok(Linked::Conflict);
        }
        let now = clock(&transaction, now)?;
        let attempt = complete_attempt(
            &transaction,
            &Sent {
                attempt_id: &started.attempt_id,
                ticket_id: &started.ticket_id,
                title: &started.request.title,
                body: &started.request.body,
                destination: &started.request.destination,
            },
            provider,
            issue,
            &now,
        )?;
        transaction.commit()?;
        Ok(Linked::Done(Box::new(attempt)))
    }

    /// Moves an attempt that is still open to `failed` or `unresolved`, keeping
    /// the created issue when one is known. Never overwrites a settled attempt.
    fn settle(
        &mut self,
        attempt_id: &str,
        status: &str,
        failure: Option<&SourceFailure>,
        issue: Option<&ExternalIssue>,
        now: Option<&str>,
    ) -> Result<(), Error> {
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let now = clock(&transaction, now)?;
        transaction.execute(
            "UPDATE publication_attempts SET status = ?2, updated_at = ?3, failure_code = ?4, failure_message = ?5, \
             external_id = COALESCE(?6, external_id), locator = COALESCE(?7, locator), display = COALESCE(?8, display), url = COALESCE(?9, url) \
             WHERE id = ?1 AND status IN ('in_flight', 'unresolved')",
            params![
                attempt_id,
                status,
                now,
                failure.map(|f| f.code.as_str()),
                failure.map(|f| f.message.as_str()),
                issue.map(|i| i.reference.identity.id.as_str()),
                issue.map(|i| i.reference.locator.as_str()),
                issue.map(|i| i.display.as_str()),
                issue.map(|i| i.url.as_str()),
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn latest_attempt(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Option<PublicationAttempt>, Error> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id \
                 WHERE a.ticket_id = ?1 ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1"
            ),
            [ticket_id],
            attempt_from_row,
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
        let ticket = subject(&self.connection, reference)?;
        let Some(attempt) = open_attempt(&self.connection, &ticket.id)? else {
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
            Some("identity_conflict") => {
                "That issue was already imported as another ticket, so it was not attached here."
                    .to_owned()
            }
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
        let unknown = if attempt.issue.is_some() {
            "Nothing about the issue itself; it is only not attached to this ticket yet.".to_owned()
        } else {
            format!("whether {name} created an issue for this attempt.")
        };

        let mut candidates = Vec::new();
        let mut candidates_complete = None;
        let mut lookup_failure = None;
        if search
            && !running
            && attempt.issue.is_none()
            && let Some(saved) = self.saved_source(&attempt.provider)?
        {
            match engine.find_published(&attempt.provider, &saved.config, &search_for(&attempt)) {
                Ok(found) => {
                    candidates = found.matches.iter().map(published).collect();
                    candidates_complete = Some(found.complete);
                }
                Err(error) => lookup_failure = Some(failure(&error)),
            }
        }

        let not_created_available = !running && attempt.issue.is_none() && candidates.is_empty();
        let actions = vec![
            ResolutionAction {
                kind: ActionKind::Attach,
                available: !running,
                label: "Attach the created issue".into(),
                detail: if running {
                    "Wait for the request to finish first.".into()
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
            candidates_complete,
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
        let Some(attempt) = open_attempt(&self.connection, &ticket.id)? else {
            return self.settled_instead(&ticket, &options.resolution, None);
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
                        attempt.provider
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
                        .map_err(unverified)?,
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
                self.attach_verified(&ticket, &attempt, &found, options.now.as_deref())
            }
            Resolution::NotCreated => self.rule_out(
                engine,
                &ticket,
                &attempt,
                &saved.config,
                options.now.as_deref(),
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
    ) -> Result<PublishOutcome, Error> {
        let settled = |attempt: &PublicationAttempt, message: &str| {
            Error::Publication(PublicationError::Settled {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                message: message.to_owned(),
            })
        };
        let Some(latest) = latest_attempt(&self.connection, &ticket.id)? else {
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
            _ => Err(PublicationError::NothingToResolve {
                reference: ticket.reference.clone(),
            }
            .into()),
        }
    }

    /// Attaches an issue the source has verified, if the attempt is still open.
    fn attach_verified(
        &mut self,
        ticket: &Subject,
        attempt: &PublicationAttempt,
        issue: &ExternalIssue,
        now: Option<&str>,
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
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        // Compare-and-set: the attempt must still be the same open attempt.
        let still_open = open_attempt(&transaction, &ticket.id)?
            .is_some_and(|open| open.id == attempt.id && open.state != AttemptState::InFlight);
        if !still_open {
            drop(transaction);
            return self.settled_instead(
                ticket,
                &Resolution::Attach { issue: None },
                Some(identity),
            );
        }
        let owned: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM external_identities WHERE provider = ?1 AND external_id = ?2)",
            params![identity.provider, identity.id],
            |row| row.get(0),
        )?;
        let linked: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM external_identities WHERE ticket_id = ?1)",
            [&ticket.id],
            |row| row.get(0),
        )?;
        if owned || linked {
            // Discovery (or another path) owns it first. Keep what was learned and
            // leave the attempt unresolved; never attach one identity twice.
            let now = clock(&transaction, now)?;
            let message = format!(
                "{} is already linked to a ticket, so it was not attached here.",
                issue.display
            );
            transaction.execute(
                "UPDATE publication_attempts SET status = 'unresolved', updated_at = ?2, failure_code = 'identity_conflict', failure_message = ?3, \
                 external_id = ?4, locator = ?5, display = ?6, url = ?7 WHERE id = ?1 AND status IN ('in_flight', 'unresolved') AND (external_id IS NULL OR external_id = ?4)",
                params![
                    attempt.id,
                    now,
                    message,
                    identity.id,
                    issue.reference.locator,
                    issue.display,
                    issue.url
                ],
            )?;
            transaction.commit()?;
            return Err(PublicationError::Unresolved {
                reference: ticket.reference.clone(),
                attempt_id: attempt.id.clone(),
                message,
            }
            .into());
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
            },
            &attempt.provider,
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
        config: &ConfigValues,
        now: Option<&str>,
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
            .find_published(&attempt.provider, config, &search_for(attempt))
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
            return self.settled_instead(ticket, &Resolution::NotCreated, None);
        }
        let settled = transaction.query_row(
            &format!(
                "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?1"
            ),
            [&attempt.id],
            attempt_from_row,
        )?;
        transaction.commit()?;
        Ok(PublishOutcome {
            ticket: self.show_ticket(&ticket.reference)?,
            attempt: settled,
            replayed: false,
        })
    }
}

/// Failure code of an attempt a person confirmed was never created.
const RULED_OUT: &str = "ruled_out";

fn search_for(attempt: &PublicationAttempt) -> PublicationSearch {
    PublicationSearch {
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
}

enum Linked {
    Done(Box<PublicationAttempt>),
    /// Discovery imported the created issue as a different ticket first.
    Conflict,
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
}

/// Links the confirmed issue to the attempt's ticket, transfers ownership and
/// marks the attempt `succeeded`, inside the caller's write transaction. The
/// caller has already checked that the attempt is still open and that the
/// issue's identity is unowned. Shared by the publisher and by resolution.
fn complete_attempt(
    transaction: &Connection,
    sent: &Sent<'_>,
    provider: &str,
    issue: &ExternalIssue,
    now: &str,
) -> Result<PublicationAttempt, Error> {
    let identity = &issue.reference.identity;
    // Edits made after the text was sent are not on the provider. Keep them as a
    // local note instead of letting the next refresh drop them.
    let (title, body): (String, String) = transaction.query_row(
        "SELECT title, body FROM tickets WHERE id = ?1",
        [sent.ticket_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if title != sent.title || body != sent.body {
        let note = format!(
            "Edited while publishing to {}. The published issue holds the previewed text; these are the later local edits.\n\nTitle: {title}\n\n{body}",
            sent.destination
        );
        notes::add(transaction, sent.ticket_id, &note, Some(provider))?;
        transaction.execute(
            "UPDATE tickets SET title = ?2, body = ?3 WHERE id = ?1",
            params![sent.ticket_id, sent.title, sent.body],
        )?;
    }
    tracking::link(transaction, sent.ticket_id, issue, Origin::Published, now)?;
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
    history::record(
        transaction,
        sent.ticket_id,
        "source",
        "",
        &issue.display,
        Some(provider),
    )?;
    Ok(transaction.query_row(
        &format!(
            "SELECT {ATTEMPT_COLUMNS} FROM publication_attempts a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?1"
        ),
        [sent.attempt_id],
        attempt_from_row,
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

fn failure(error: &SourceError) -> SourceFailure {
    SourceFailure {
        code: error.code().to_owned(),
        message: error.to_string(),
    }
}
