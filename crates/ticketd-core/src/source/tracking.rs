//! Externally sourced tickets: persisted identity, ownership and synchronization
//! state, and the workflows that import and refresh them.
//!
//! Three questions are stored apart on purpose, each in its own table keyed by
//! `ticket_id`, so later work extends one without touching the others:
//!
//! - `external_identities` is **provenance**: which external issue a ticket is
//!   (or was). It is written once when a ticket is linked and is never deleted,
//!   so discovery can always match an issue to its ticket, even after the
//!   ticket stops being externally owned.
//! - `external_ownership` is **authority**: who may change the ticket's
//!   content now (`external` or `local`). Only `external` rows are
//!   synchronized and read-only. Taking ownership flips the row to `local`.
//! - `source_sync` is **synchronization state**: the external state last
//!   observed and when the ticket was last refreshed or last failed to refresh.
//!
//! Imported title and description live in `tickets.title` / `tickets.body`, so
//! search and listing work unchanged; the core refuses local edits to them
//! while ownership is `external`.
//!
//! Refresh fetches through the [`Engine`] first and applies everything in one
//! short savepoint afterwards, so no network call happens while the database
//! is locked.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ops::ControlFlow,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    ClosureReason, Conversation, Engine, ExternalIdentity, ExternalIssue, ExternalRef,
    ExternalState, SourceError,
    contract::FailureCode,
    conversation,
    freshness::{self, ProviderRun, SourceUnavailable},
};
use crate::{Error, Status, Ticket, Workspace, duplicates, history, transaction_write_lock};

/// Who may change a ticket's content now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ownership {
    /// The source owns title, description and closure; ticketd synchronizes them inward.
    External,
    /// ticketd owns the ticket. Any external identity is provenance only.
    Local,
}

/// How a ticket came to have an external identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Imported,
    Published,
}

/// A failed refresh as recorded for freshness. Never contains a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceFailure {
    pub code: String,
    pub message: String,
}

/// The canonical issue of an externally closed duplicate. It is information, not
/// a local relationship: nothing here points at a local ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DuplicateTarget {
    /// The source closed the issue as a duplicate without naming an accessible target.
    Unknown,
    External {
        identity: ExternalIdentity,
        locator: String,
        display: String,
        /// The local ticket this reference resolves to once discovery has imported
        /// the canonical issue, followed through duplicate designations to the final
        /// canonical ticket. Resolution is by identity at read time and never imports.
        #[serde(default)]
        ticket: Option<String>,
        /// Set when following the reference would loop back to this ticket; the
        /// reference is then shown but never resolved.
        #[serde(default)]
        problem: Option<TargetProblem>,
    },
}

/// Why an external duplicate target was not resolved to a local ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetProblem {
    /// Following the canonical chain returns to this ticket.
    Cycle,
}

/// The external side of a ticket, as the clients see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketSource {
    pub provider: String,
    /// The provider's stable id for the issue (never a display value).
    pub id: String,
    pub locator: String,
    pub display: String,
    pub url: String,
    pub origin: Origin,
    pub ownership: Ownership,
    /// The external state last observed.
    pub state: ExternalState,
    /// The source closed the issue with a reason ticketd does not recognize, so
    /// the closure was flagged and no outcome was guessed.
    pub closure_unrecognized: bool,
    /// The last time a refresh confirmed this ticket against the source.
    pub last_refreshed_at: Option<String>,
    pub last_attempt_at: Option<String>,
    /// Set when the most recent attempt failed; cleared by the next success.
    pub last_error: Option<SourceFailure>,
    /// Set when the latest read of the issue's comments and events failed. The
    /// issue itself was read, so this never makes the ticket unavailable; the
    /// conversation shown is what an earlier read stored.
    pub conversation_error: Option<SourceFailure>,
    /// Set while the ticket reads Source unavailable (see the `freshness` module for
    /// the exact rule): its latest attempt failed in a way that says the source
    /// cannot be read. Clients show a warning and never hide or complete the ticket.
    pub unavailable: Option<SourceUnavailable>,
    /// Title and description follow the source and cannot be edited here.
    pub content_locked: bool,
    /// Status follows the source's closure and cannot be changed here. While an
    /// externally owned issue is open, only Todo, In progress and In review are local.
    pub status_locked: bool,
    pub duplicate_target: Option<DuplicateTarget>,
}

/// Restricts a ticket list to externally owned or local tickets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceFilter {
    /// Tickets with no current external owner, including ones whose ownership was taken.
    Local,
    /// Tickets currently owned by this provider.
    Provider(String),
}

/// How many tickets each source filter would show, for the other filters in force.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceCounts {
    pub all: u64,
    pub local: u64,
    pub providers: BTreeMap<String, u64>,
}

/// What a refresh was asked to cover.
#[derive(Debug, Default, Clone)]
pub struct RefreshOptions {
    /// Refresh only this externally owned ticket (by reference), without discovery.
    pub ticket: Option<String>,
    /// The time to record, as RFC 3339; the database clock when absent.
    pub now: Option<String>,
}

/// What a refresh failure is about, which decides what it may affect.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureScope {
    /// The source as a whole (discovery failed).
    #[default]
    Source,
    /// One tracked ticket could not be read.
    Ticket,
    /// One part of the discovery rules (a repository) could not be read; the rest ran.
    Partition,
    /// An issue was read but its comments and events were not.
    Conversation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshFailure {
    pub provider: String,
    /// The ticket that could not be refreshed; absent when discovery itself failed
    /// or the issue has no ticket yet.
    pub reference: Option<String>,
    #[serde(default)]
    pub scope: FailureScope,
    pub code: String,
    pub message: String,
    /// For a rate limit, how long the source asked to wait, when it said.
    #[serde(default)]
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshReport {
    /// References of tickets created by this refresh.
    pub imported: Vec<String>,
    /// References whose content, state or status changed.
    pub updated: Vec<String>,
    /// Tracked tickets confirmed with nothing to change.
    pub unchanged: u32,
    pub failures: Vec<RefreshFailure>,
    /// The time recorded as the last refresh of every confirmed ticket.
    pub refreshed_at: String,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE external_identities (\
            ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), \
            provider TEXT NOT NULL, \
            external_id TEXT NOT NULL, \
            locator TEXT NOT NULL, \
            display TEXT NOT NULL, \
            url TEXT NOT NULL, \
            origin TEXT NOT NULL CHECK (origin IN ('imported', 'published')), \
            linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), \
            UNIQUE (provider, external_id)); \
         CREATE TABLE external_ownership (\
            ticket_id TEXT PRIMARY KEY REFERENCES external_identities(ticket_id), \
            authority TEXT NOT NULL CHECK (authority IN ('external', 'local')), \
            changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))); \
         CREATE TABLE source_sync (\
            ticket_id TEXT PRIMARY KEY REFERENCES external_identities(ticket_id), \
            external_state TEXT NOT NULL CHECK (external_state IN ('open', 'closed')), \
            closure_reason TEXT CHECK (closure_reason IS NULL OR closure_reason IN ('completed', 'not_planned', 'duplicate', 'unknown')), \
            external_updated_at TEXT NOT NULL DEFAULT '', \
            last_refreshed_at TEXT, \
            last_attempt_at TEXT, \
            last_error_code TEXT, \
            last_error_message TEXT); \
         CREATE TABLE external_duplicate_targets (\
            ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), \
            provider TEXT, \
            external_id TEXT, \
            locator TEXT, \
            display TEXT, \
            CHECK ((provider IS NULL) = (external_id IS NULL))); \
         CREATE INDEX external_duplicate_targets_identity ON external_duplicate_targets(provider, external_id); \
         PRAGMA user_version = 23;",
    )?;
    Ok(())
}

fn state_parts(state: ExternalState) -> (&'static str, Option<&'static str>) {
    match state {
        ExternalState::Open => ("open", None),
        ExternalState::Closed { reason } => (
            "closed",
            Some(match reason {
                ClosureReason::Completed => "completed",
                ClosureReason::NotPlanned => "not_planned",
                ClosureReason::Duplicate => "duplicate",
                ClosureReason::Unknown => "unknown",
            }),
        ),
    }
}

fn state_from_parts(state: &str, reason: Option<&str>) -> ExternalState {
    if state == "open" {
        return ExternalState::Open;
    }
    ExternalState::Closed {
        reason: match reason {
            Some("completed") => ClosureReason::Completed,
            Some("not_planned") => ClosureReason::NotPlanned,
            Some("duplicate") => ClosureReason::Duplicate,
            _ => ClosureReason::Unknown,
        },
    }
}

/// The ownership of a ticket as write guards need it.
pub(crate) enum Authority {
    Local,
    External { provider: String, open: bool },
}

/// Whether a ticket is currently externally owned. Call inside the write
/// transaction that depends on the answer.
pub(crate) fn authority(connection: &Connection, id: &str) -> Result<Authority, Error> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT i.provider, s.external_state FROM external_ownership o \
             JOIN external_identities i ON i.ticket_id = o.ticket_id \
             JOIN source_sync s ON s.ticket_id = o.ticket_id \
             WHERE o.ticket_id = ?1 AND o.authority = 'external'",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        None => Authority::Local,
        Some((provider, state)) => Authority::External {
            provider,
            open: state == "open",
        },
    })
}

/// Rejects title or description edits and status changes the source's authority forbids.
pub(crate) fn guard_change(
    connection: &Connection,
    ticket: &Ticket,
    title: Option<&str>,
    body: Option<&str>,
    status: Status,
) -> Result<(), Error> {
    let Authority::External { provider, open } = authority(connection, &ticket.id)? else {
        return Ok(());
    };
    let reference = ticket.reference.clone();
    if title.is_some_and(|title| title != ticket.title)
        || body.is_some_and(|body| body != ticket.body)
    {
        return Err(Error::ExternalContent {
            reference,
            provider,
        });
    }
    if status != ticket.status && !(open && status.is_local_progress()) {
        return Err(Error::ExternalStatus {
            reference,
            provider,
            open,
        });
    }
    Ok(())
}

/// Rejects marking an externally owned ticket as a duplicate (or undoing one):
/// its duplicate status is the source's closure.
pub(crate) fn guard_duplicate(
    connection: &Connection,
    id: &str,
    reference: &str,
) -> Result<(), Error> {
    match authority(connection, id)? {
        Authority::Local => Ok(()),
        Authority::External { provider, open } => Err(Error::ExternalStatus {
            reference: reference.to_owned(),
            provider,
            open,
        }),
    }
}

/// One ticket's external side as stored, before it is shaped for clients.
struct SourceRow {
    provider: String,
    id: String,
    locator: String,
    display: String,
    url: String,
    origin: String,
    authority: String,
    state: String,
    reason: Option<String>,
    refreshed: Option<String>,
    attempted: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
    failing_since: Option<String>,
    conversation_error_code: Option<String>,
    conversation_error_message: Option<String>,
}

pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    let row: Option<SourceRow> = connection
        .query_row(
            "SELECT i.provider, i.external_id, i.locator, i.display, i.url, i.origin, o.authority, \
                    s.external_state, s.closure_reason, s.last_refreshed_at, \
                    s.last_attempt_at, s.last_error_code, s.last_error_message, s.failing_since, \
                    s.conversation_error_code, s.conversation_error_message \
             FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id \
             JOIN source_sync s ON s.ticket_id = i.ticket_id \
             WHERE i.ticket_id = ?1",
            [&ticket.id],
            |row| {
                Ok(SourceRow {
                    provider: row.get(0)?,
                    id: row.get(1)?,
                    locator: row.get(2)?,
                    display: row.get(3)?,
                    url: row.get(4)?,
                    origin: row.get(5)?,
                    authority: row.get(6)?,
                    state: row.get(7)?,
                    reason: row.get(8)?,
                    refreshed: row.get(9)?,
                    attempted: row.get(10)?,
                    error_code: row.get(11)?,
                    error_message: row.get(12)?,
                    failing_since: row.get(13)?,
                    conversation_error_code: row.get(14)?,
                    conversation_error_message: row.get(15)?,
                })
            },
        )
        .optional()?;
    let Some(row) = row else {
        ticket.source = None;
        return Ok(());
    };
    let state = state_from_parts(&row.state, row.reason.as_deref());
    let ownership = if row.authority == "external" {
        Ownership::External
    } else {
        Ownership::Local
    };
    let external = ownership == Ownership::External;
    let duplicate_target = duplicate_target(connection, &ticket.id)?;
    let unavailable = match &row.error_code {
        Some(code)
            if external && FailureCode::parse(code).is_some_and(FailureCode::is_unavailable) =>
        {
            Some(SourceUnavailable {
                code: code.clone(),
                message: row.error_message.clone().unwrap_or_default(),
                since: row
                    .failing_since
                    .clone()
                    .or_else(|| row.attempted.clone())
                    .unwrap_or_default(),
            })
        }
        _ => None,
    };
    ticket.source = Some(TicketSource {
        provider: row.provider,
        id: row.id,
        locator: row.locator,
        display: row.display,
        url: row.url,
        origin: if row.origin == "published" {
            Origin::Published
        } else {
            Origin::Imported
        },
        ownership,
        closure_unrecognized: matches!(
            state,
            ExternalState::Closed {
                reason: ClosureReason::Unknown
            }
        ),
        status_locked: external && !matches!(state, ExternalState::Open),
        state,
        last_refreshed_at: row.refreshed,
        last_attempt_at: row.attempted,
        unavailable,
        last_error: row.error_code.map(|code| SourceFailure {
            code,
            message: row.error_message.unwrap_or_default(),
        }),
        conversation_error: row.conversation_error_code.map(|code| SourceFailure {
            code,
            message: row.conversation_error_message.unwrap_or_default(),
        }),
        content_locked: external,
        duplicate_target,
    });
    Ok(())
}

/// The canonical issue recorded for a ticket the source closed as a duplicate,
/// resolved against the tickets ticketd knows. `None` when none is recorded.
pub(crate) fn duplicate_target(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Option<DuplicateTarget>, Error> {
    let row = connection
        .query_row(
            "SELECT provider, external_id, locator, display FROM external_duplicate_targets WHERE ticket_id = ?1",
            [ticket_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    Ok(match row {
        None => None,
        Some((Some(provider), Some(id), locator, display)) => {
            let identity = ExternalIdentity { provider, id };
            let (ticket, problem) = resolve_target(connection, ticket_id, &identity)?;
            Some(DuplicateTarget::External {
                identity,
                locator: locator.unwrap_or_default(),
                display: display.unwrap_or_default(),
                ticket,
                problem,
            })
        }
        Some(_) => Some(DuplicateTarget::Unknown),
    })
}

/// Follows an external canonical reference to the final local canonical ticket:
/// the ticket holding that identity, then onward through its own duplicate
/// designation (local or external) as far as the chain is known. A chain that
/// reaches `ticket_id` again is a cycle and resolves to nothing.
fn resolve_target(
    connection: &Connection,
    ticket_id: &str,
    identity: &ExternalIdentity,
) -> Result<(Option<String>, Option<TargetProblem>), Error> {
    let mut visited = std::collections::HashSet::from([ticket_id.to_owned()]);
    let mut last = None;
    let mut current = ticket_for_identity(connection, identity)?;
    while let Some(id) = current {
        if !visited.insert(id.clone()) {
            return Ok((None, Some(TargetProblem::Cycle)));
        }
        let next: Option<String> = connection
            .query_row(
                "SELECT canonical_id FROM duplicate_tickets WHERE source_id = ?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        current = match next {
            Some(next) => Some(next),
            None => {
                let external: Option<(Option<String>, Option<String>)> = connection
                    .query_row(
                        "SELECT provider, external_id FROM external_duplicate_targets WHERE ticket_id = ?1",
                        [&id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                match external {
                    Some((Some(provider), Some(external_id))) => ticket_for_identity(
                        connection,
                        &ExternalIdentity {
                            provider,
                            id: external_id,
                        },
                    )?,
                    _ => None,
                }
            }
        };
        last = Some(id);
    }
    let reference = match last {
        Some(id) => Some(connection.query_row(
            "SELECT 'T-' || number FROM tickets WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )?),
        None => None,
    };
    Ok((reference, None))
}

fn ticket_for_identity(
    connection: &Connection,
    identity: &ExternalIdentity,
) -> Result<Option<String>, Error> {
    Ok(connection
        .query_row(
            "SELECT ticket_id FROM external_identities WHERE provider = ?1 AND external_id = ?2",
            params![identity.provider, identity.id],
            |row| row.get(0),
        )
        .optional()?)
}

/// The status an observed external state implies, given the state last observed
/// and the ticket's current status. `None` means the status is not decided by
/// the source and stays as it is.
pub(crate) fn status_for(
    previous: Option<ExternalState>,
    observed: ExternalState,
    current: Status,
) -> Status {
    let mapped = |reason: ClosureReason| match reason {
        ClosureReason::Completed => Some(Status::Done),
        ClosureReason::NotPlanned => Some(Status::Canceled),
        ClosureReason::Duplicate => Some(Status::Duplicate),
        ClosureReason::Unknown => None,
    };
    match (previous, observed) {
        // A new import starts open issues at Todo; an unrecognized closure is
        // flagged and gets the neutral starting status, never Done.
        (None, ExternalState::Open) => Status::Todo,
        (None, ExternalState::Closed { reason }) => mapped(reason).unwrap_or(Status::Todo),
        // Open stays open: local progress is preserved.
        (Some(ExternalState::Open), ExternalState::Open) => current,
        // Reopened.
        (Some(ExternalState::Closed { .. }), ExternalState::Open) => Status::Todo,
        (Some(before), ExternalState::Closed { .. }) if before == observed => current,
        (Some(_), ExternalState::Closed { reason }) => mapped(reason).unwrap_or(current),
    }
}

/// One thing a refresh could not do, before it is applied.
struct Found {
    scope: FailureScope,
    /// The ticket it concerns; `None` for the source as a whole or for an issue
    /// that has no ticket yet.
    reference: Option<String>,
    provider: String,
    failure: SourceFailure,
}

/// An issue found by the connector, or the reason a tracked one could not be read.
struct Gathered {
    issues: Vec<ExternalIssue>,
    /// Conversations read this time, by (provider, external id). An issue absent
    /// here keeps the conversation it already has.
    conversations: HashMap<(String, String), Conversation>,
    failures: Vec<Found>,
    /// How each fully refreshed provider fared, for its persisted status.
    runs: Vec<ProviderRun>,
}

struct Tracked {
    ticket_id: String,
    reference: String,
    provider: String,
    external_id: String,
    locator: String,
}

pub(crate) fn failure_of(error: &SourceError) -> SourceFailure {
    SourceFailure {
        code: error.code().to_owned(),
        message: error.to_string(),
    }
}

fn retry_secs(error: &SourceError) -> Option<u64> {
    match error {
        SourceError::RateLimited { retry_after_secs } => *retry_after_secs,
        _ => None,
    }
}

#[derive(Default)]
struct Applied {
    imported: Vec<String>,
    updated: Vec<String>,
    unchanged: u32,
}

impl Workspace {
    /// Imports issues matching each saved source's discovery rules and refreshes
    /// every externally owned ticket, whether or not it still matches them.
    ///
    /// Connectors are called first, with no database transaction open. Everything
    /// they returned is then applied in one short atomic write, which re-reads
    /// each ticket's ownership: a concurrent refresh, local edit or takeover
    /// changes what is applied, never the identity of a ticket. A provider that
    /// cannot be read leaves saved content untouched and records the failed
    /// attempt without advancing the last refresh time.
    ///
    /// Every observation carries the time the run started. A run that finishes
    /// late never overwrites what a run that started later already recorded.
    pub fn refresh_sources(
        &mut self,
        engine: &Engine,
        options: &RefreshOptions,
    ) -> Result<RefreshReport, Error> {
        let started = match options.now.as_deref() {
            Some(now) => now.to_owned(),
            None => self.connection.query_row(
                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                [],
                |row| row.get(0),
            )?,
        };
        let tracked = self.tracked(options.ticket.as_deref())?;
        let mut gathered = Gathered {
            issues: Vec::new(),
            conversations: HashMap::new(),
            failures: Vec::new(),
            runs: Vec::new(),
        };
        let saved = self.saved_sources()?;
        let providers: Vec<String> = if options.ticket.is_some() {
            tracked
                .iter()
                .map(|t| t.provider.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        } else {
            let mut all: Vec<String> = saved.iter().map(|s| s.provider.clone()).collect();
            for t in &tracked {
                if !all.contains(&t.provider) {
                    all.push(t.provider.clone());
                }
            }
            all
        };
        for provider in providers {
            let config = saved.iter().find(|s| s.provider == provider);
            let first_issue = gathered.issues.len();
            let mut seen: HashSet<String> = HashSet::new();
            // Set when the source as a whole cannot be read, so asking for more
            // tickets would only repeat the failure.
            let mut blocked: Option<SourceFailure> = None;
            let mut retry_after_secs: Option<u64> = None;
            let mut discovery_failed: Option<SourceFailure> = None;
            let mut skipped: Vec<String> = Vec::new();
            if let (None, Some(source)) = (&options.ticket, config) {
                let result = engine.discover(&provider, &source.config, |issue| {
                    seen.insert(issue.reference.identity.id.clone());
                    gathered.issues.push(issue);
                    ControlFlow::Continue(())
                });
                match result {
                    Ok(summary) => {
                        for part in summary.skipped {
                            skipped.push(part.message.clone());
                            gathered.failures.push(Found {
                                scope: FailureScope::Partition,
                                reference: None,
                                provider: provider.clone(),
                                failure: SourceFailure {
                                    code: part.code,
                                    message: part.message,
                                },
                            });
                        }
                    }
                    Err(error) => {
                        let failure = failure_of(&error);
                        gathered.failures.push(Found {
                            scope: FailureScope::Source,
                            reference: None,
                            provider: provider.clone(),
                            failure: failure.clone(),
                        });
                        retry_after_secs = retry_secs(&error);
                        discovery_failed = Some(failure.clone());
                        if error.failure_code().interrupts_source() {
                            blocked = Some(failure);
                        }
                    }
                }
            }
            for ticket in tracked.iter().filter(|t| t.provider == provider) {
                if seen.contains(&ticket.external_id) {
                    continue;
                }
                let reference = Some(ticket.reference.clone());
                if let Some(cause) = &blocked {
                    // Not asked, because the source as a whole could not be read.
                    // The cause is the source's, and is said to be, never passed
                    // off as this issue's own answer.
                    gathered.failures.push(Found {
                        scope: FailureScope::Ticket,
                        reference,
                        provider: provider.clone(),
                        failure: SourceFailure {
                            code: cause.code.clone(),
                            message: format!(
                                "not refreshed because the source could not be read: {}",
                                cause.message
                            ),
                        },
                    });
                    continue;
                }
                let Some(source) = config else {
                    gathered.failures.push(Found {
                        scope: FailureScope::Ticket,
                        reference,
                        provider: provider.clone(),
                        failure: SourceFailure {
                            code: FailureCode::NotConfigured.as_str().into(),
                            message: format!(
                                "no saved configuration for {provider}; save the source to refresh this ticket"
                            ),
                        },
                    });
                    continue;
                };
                let external = ExternalRef {
                    identity: ExternalIdentity {
                        provider: provider.clone(),
                        id: ticket.external_id.clone(),
                    },
                    locator: ticket.locator.clone(),
                };
                match engine.fetch(&provider, &source.config, &external) {
                    Ok(issue) => gathered.issues.push(issue),
                    Err(error) => {
                        let failure = failure_of(&error);
                        if error.failure_code().interrupts_source() {
                            retry_after_secs = retry_secs(&error);
                            blocked = Some(failure.clone());
                        }
                        gathered.failures.push(Found {
                            scope: FailureScope::Ticket,
                            reference,
                            provider: provider.clone(),
                            failure,
                        });
                    }
                }
            }
            if let (Some(source), None) = (config, &blocked) {
                self.gather_conversations(
                    engine,
                    &source.config,
                    &tracked,
                    first_issue,
                    &mut gathered,
                )?;
            }
            if options.ticket.is_none() && config.is_some() {
                gathered.runs.push(ProviderRun {
                    provider: provider.clone(),
                    failure: discovery_failed.or(blocked),
                    retry_after_secs,
                    skipped,
                });
            }
        }
        self.apply_refresh(gathered, &started, &tracked)
    }

    /// Reads the conversation of each issue gathered since `first_issue` whose
    /// stored conversation is older than the issue itself. A failure keeps what
    /// was stored and leaves the issue due again next time. It is recorded as a
    /// conversation failure only: the issue itself was read, so it never makes a
    /// ticket unavailable. Only a failure of the source as a whole stops further
    /// reads.
    fn gather_conversations(
        &self,
        engine: &Engine,
        config: &super::ConfigValues,
        tracked: &[Tracked],
        first_issue: usize,
        gathered: &mut Gathered,
    ) -> Result<(), Error> {
        let due: Vec<ExternalIssue> = gathered.issues[first_issue..].to_vec();
        for issue in due {
            let identity = &issue.reference.identity;
            if !conversation::needs_reading(
                &self.connection,
                &identity.provider,
                &identity.id,
                &issue.updated_at,
            )? {
                continue;
            }
            match engine.conversation(&identity.provider, config, &issue.reference) {
                Ok(Some(read)) => {
                    gathered
                        .conversations
                        .insert((identity.provider.clone(), identity.id.clone()), read);
                }
                Ok(None) => break,
                Err(error) => {
                    let failure = failure_of(&error);
                    let known = tracked
                        .iter()
                        .find(|t| t.provider == identity.provider && t.external_id == identity.id);
                    gathered.failures.push(Found {
                        scope: FailureScope::Conversation,
                        reference: known.map(|t| t.reference.clone()),
                        provider: identity.provider.clone(),
                        failure: SourceFailure {
                            code: failure.code,
                            message: format!(
                                "comments of {} could not be read: {}",
                                issue.display, failure.message
                            ),
                        },
                    });
                    if error.failure_code().interrupts_source() {
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    fn tracked(&self, only: Option<&str>) -> Result<Vec<Tracked>, Error> {
        let number = match only {
            Some(reference) => Some(
                reference
                    .strip_prefix("T-")
                    .and_then(|n| n.parse::<i64>().ok())
                    .ok_or_else(|| Error::NotFound(reference.to_owned()))?,
            ),
            None => None,
        };
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.number, i.provider, i.external_id, i.locator FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id AND o.authority = 'external' \
             JOIN tickets t ON t.id = i.ticket_id \
             WHERE (?1 IS NULL OR t.number = ?1) ORDER BY t.number",
        )?;
        let rows = statement
            .query_map([number], |row| {
                Ok(Tracked {
                    ticket_id: row.get(0)?,
                    reference: format!("T-{}", row.get::<_, i64>(1)?),
                    provider: row.get(2)?,
                    external_id: row.get(3)?,
                    locator: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if let (Some(reference), true) = (only, rows.is_empty()) {
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM tickets WHERE number = ?1)",
                [number],
                |row| row.get(0),
            )?;
            return Err(if exists {
                Error::NotSynchronized(reference.to_owned())
            } else {
                Error::NotFound(reference.to_owned())
            });
        }
        Ok(rows)
    }

    fn apply_refresh(
        &mut self,
        gathered: Gathered,
        now: &str,
        tracked: &[Tracked],
    ) -> Result<RefreshReport, Error> {
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let mut applied = Applied::default();
        for issue in &gathered.issues {
            let key = (
                issue.reference.identity.provider.clone(),
                issue.reference.identity.id.clone(),
            );
            apply_issue(
                &transaction,
                issue,
                gathered.conversations.get(&key),
                now,
                &mut applied,
            )?;
        }
        let by_reference: HashMap<&str, &Tracked> =
            tracked.iter().map(|t| (t.reference.as_str(), t)).collect();
        let mut failures = Vec::new();
        for found in &gathered.failures {
            let ticket = found.reference.as_deref().and_then(|r| by_reference.get(r));
            if let Some(ticket) = ticket {
                match found.scope {
                    FailureScope::Conversation => {
                        transaction.execute(
                            "UPDATE source_sync SET conversation_error_code = ?2, conversation_error_message = ?3 \
                             WHERE ticket_id = ?1 \
                             AND EXISTS (SELECT 1 FROM external_ownership WHERE ticket_id = ?1 AND authority = 'external')",
                            params![ticket.ticket_id, found.failure.code, found.failure.message],
                        )?;
                    }
                    FailureScope::Ticket | FailureScope::Source => {
                        // Truthful freshness: the attempt and its error are recorded,
                        // the last successful refresh and saved content are not touched.
                        // An attempt that started before the ticket was last confirmed
                        // is older news and records nothing.
                        transaction.execute(
                            "UPDATE source_sync SET last_attempt_at = ?2, last_error_code = ?3, last_error_message = ?4, \
                             failing_since = COALESCE(failing_since, ?2) WHERE ticket_id = ?1 \
                             AND (last_refreshed_at IS NULL OR last_refreshed_at <= ?2) \
                             AND EXISTS (SELECT 1 FROM external_ownership WHERE ticket_id = ?1 AND authority = 'external')",
                            params![ticket.ticket_id, now, found.failure.code, found.failure.message],
                        )?;
                    }
                    FailureScope::Partition => {}
                }
            }
            failures.push(RefreshFailure {
                provider: found.provider.clone(),
                reference: found.reference.clone(),
                code: found.failure.code.clone(),
                message: found.failure.message.clone(),
                retry_after_secs: gathered
                    .runs
                    .iter()
                    .find(|run| {
                        run.provider == found.provider
                            && found.failure.code == FailureCode::RateLimited.as_str()
                    })
                    .and_then(|run| run.retry_after_secs),
                scope: found.scope,
            });
        }
        for run in &gathered.runs {
            freshness::record_run(&transaction, run, now)?;
        }
        transaction.commit()?;
        Ok(RefreshReport {
            imported: applied.imported,
            updated: applied.updated,
            unchanged: applied.unchanged,
            failures,
            refreshed_at: now.to_owned(),
        })
    }
}

/// A tracked ticket as the refresh write reads it back.
struct Existing {
    id: String,
    number: i64,
    title: String,
    body: String,
    status: Status,
    authority: Option<String>,
    locator: String,
    display: String,
    url: String,
    /// `external_state:closure_reason` as last observed.
    state: String,
    /// The source's own update time of the issue last applied.
    updated_at: String,
}

/// Applies one observed issue inside the refresh write transaction.
fn apply_issue(
    connection: &Connection,
    issue: &ExternalIssue,
    read: Option<&Conversation>,
    now: &str,
    applied: &mut Applied,
) -> Result<(), Error> {
    let identity = &issue.reference.identity;
    let existing: Option<Existing> = connection
        .query_row(
            "SELECT t.id, t.number, t.title, t.body, t.status, o.authority, i.locator, i.display, i.url, \
                    COALESCE(s.external_state || ':' || COALESCE(s.closure_reason, ''), ''), \
                    COALESCE(s.external_updated_at, '') \
             FROM external_identities i \
             JOIN tickets t ON t.id = i.ticket_id \
             LEFT JOIN external_ownership o ON o.ticket_id = i.ticket_id \
             LEFT JOIN source_sync s ON s.ticket_id = i.ticket_id \
             WHERE i.provider = ?1 AND i.external_id = ?2",
            params![identity.provider, identity.id],
            |row| {
                let status: String = row.get(4)?;
                Ok(Existing {
                    id: row.get(0)?,
                    number: row.get(1)?,
                    title: row.get(2)?,
                    body: row.get(3)?,
                    status: status.parse().map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    authority: row.get(5)?,
                    locator: row.get(6)?,
                    display: row.get(7)?,
                    url: row.get(8)?,
                    state: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()?;
    let title = match issue.title.trim() {
        "" => issue.display.as_str(),
        title => title,
    };
    let (state, reason) = state_parts(issue.state);
    match existing {
        None => {
            if super::publication::awaited_by_open_attempt(connection, issue)? {
                return Ok(());
            }
            let status = status_for(None, issue.state, Status::Todo);
            let id = Uuid::new_v4().to_string();
            connection.execute(
                "INSERT INTO tickets (id, title, status, body) VALUES (?1, ?2, ?3, ?4)",
                params![id, title, status.to_string(), issue.body],
            )?;
            let number = connection.last_insert_rowid();
            link(connection, &id, issue, Origin::Imported, now)?;
            if status == Status::Duplicate {
                set_duplicate_target(connection, &id, issue)?;
            }
            if let Some(read) = read {
                conversation::store(connection, &id, read, &issue.updated_at)?;
            }
            applied.imported.push(format!("T-{number}"));
        }
        // Taken over (or otherwise local): the identity is remembered so discovery
        // neither creates another ticket nor resumes synchronization.
        Some(Existing { authority, .. }) if authority.as_deref() != Some("external") => {}
        Some(Existing {
            id,
            number,
            title: old_title,
            body: old_body,
            status,
            locator,
            display,
            url,
            state: old_state,
            updated_at,
            ..
        }) => {
            // An overlapping run can deliver an observation older than one already
            // applied (the slower of two refreshes). Confirmed source state never
            // moves backwards, and an old observation confirms nothing now.
            if !updated_at.is_empty() && issue.updated_at.as_str() < updated_at.as_str() {
                return Ok(());
            }
            let previous = old_state
                .split_once(':')
                .map(|(s, r)| state_from_parts(s, (!r.is_empty()).then_some(r)));
            let next = status_for(previous, issue.state, status);
            let mut changed = false;
            if old_title != title || old_body != issue.body {
                connection.execute(
                    "UPDATE tickets SET title = ?2, body = ?3 WHERE id = ?1",
                    params![id, title, issue.body],
                )?;
                changed = true;
            }
            if next != status {
                if status == Status::Duplicate {
                    duplicates::clear(connection, &id, Some(&identity.provider))?;
                    connection.execute(
                        "DELETE FROM external_duplicate_targets WHERE ticket_id = ?1",
                        [&id],
                    )?;
                }
                connection.execute(
                    "UPDATE tickets SET status = ?2 WHERE id = ?1",
                    params![id, next.to_string()],
                )?;
                history::record(
                    connection,
                    &id,
                    "status",
                    &status.to_string(),
                    &next.to_string(),
                    Some(&identity.provider),
                )?;
                changed = true;
            }
            // The source may name a different canonical issue, or withdraw it, while
            // the issue stays a duplicate.
            if next == Status::Duplicate && set_duplicate_target(connection, &id, issue)? {
                changed = true;
            }
            let observed = format!("{state}:{}", reason.unwrap_or(""));
            if observed != old_state {
                changed = true;
            }
            if locator != issue.reference.locator || display != issue.display || url != issue.url {
                connection.execute(
                    "UPDATE external_identities SET locator = ?2, display = ?3, url = ?4 WHERE ticket_id = ?1",
                    params![id, issue.reference.locator, issue.display, issue.url],
                )?;
                changed = true;
            }
            connection.execute(
                "UPDATE source_sync SET external_state = ?2, closure_reason = ?3, external_updated_at = ?4, \
                 last_refreshed_at = ?5, last_attempt_at = ?5, last_error_code = NULL, last_error_message = NULL, failing_since = NULL \
                 WHERE ticket_id = ?1",
                params![id, state, reason, issue.updated_at, now],
            )?;
            if let Some(read) = read {
                changed |= conversation::store(connection, &id, read, &issue.updated_at)?;
                connection.execute(
                    "UPDATE source_sync SET conversation_error_code = NULL, conversation_error_message = NULL WHERE ticket_id = ?1",
                    [&id],
                )?;
            }
            if changed {
                applied.updated.push(format!("T-{number}"));
            } else {
                applied.unchanged += 1;
            }
        }
    }
    Ok(())
}

/// Records the canonical issue of an externally closed duplicate: the one the
/// connector supplied, or an explicit unknown target. It never invents a local
/// link. A target naming the issue itself is not a canonical issue and is kept
/// as unknown. A known target is replaced by a different one but never by silence.
/// Returns whether the stored target changed.
fn set_duplicate_target(
    connection: &Connection,
    id: &str,
    issue: &ExternalIssue,
) -> Result<bool, Error> {
    let target = issue
        .duplicate_of
        .as_ref()
        .filter(|target| target.identity != issue.reference.identity);
    let stored: Option<(Option<String>, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT provider, external_id, locator FROM external_duplicate_targets WHERE ticket_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let wanted = target.map(|t| {
        (
            Some(t.identity.provider.clone()),
            Some(t.identity.id.clone()),
            Some(t.locator.clone()),
        )
    });
    let wanted = wanted.unwrap_or((None, None, None));
    if stored.as_ref() == Some(&wanted) {
        return Ok(false);
    }
    // A later observation that supplies no accessible target (permissions or
    // visibility changed) does not erase an identity we already hold.
    if target.is_none() && matches!(&stored, Some((Some(_), Some(_), _))) {
        return Ok(false);
    }
    match target {
        Some(target) => connection.execute(
            "INSERT INTO external_duplicate_targets (ticket_id, provider, external_id, locator, display) \
             VALUES (?1, ?2, ?3, ?4, ?4) \
             ON CONFLICT(ticket_id) DO UPDATE SET provider = excluded.provider, external_id = excluded.external_id, locator = excluded.locator, display = excluded.display",
            params![id, target.identity.provider, target.identity.id, target.locator],
        )?,
        None => connection.execute(
            "INSERT INTO external_duplicate_targets (ticket_id) VALUES (?1) \
             ON CONFLICT(ticket_id) DO UPDATE SET provider = NULL, external_id = NULL, locator = NULL, display = NULL",
            [id],
        )?,
    };
    Ok(true)
}

/// Applies the closure of an issue that was already closed when it was linked
/// (a resolved publication attached after the fact): the status it implies, and
/// the canonical target of a duplicate, with the same history a refresh writes.
pub(crate) fn map_closure(
    connection: &Connection,
    ticket_id: &str,
    issue: &ExternalIssue,
) -> Result<(), Error> {
    let current: String = connection.query_row(
        "SELECT status FROM tickets WHERE id = ?1",
        [ticket_id],
        |row| row.get(0),
    )?;
    let current: Status = current.parse().map_err(|error: std::io::Error| {
        Error::Database(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(error),
        ))
    })?;
    let next = status_for(Some(ExternalState::Open), issue.state, current);
    if next == current {
        return Ok(());
    }
    connection.execute(
        "UPDATE tickets SET status = ?2 WHERE id = ?1",
        params![ticket_id, next.to_string()],
    )?;
    history::record(
        connection,
        ticket_id,
        "status",
        &current.to_string(),
        &next.to_string(),
        Some(&issue.reference.identity.provider),
    )?;
    if next == Status::Duplicate {
        set_duplicate_target(connection, ticket_id, issue)?;
    }
    Ok(())
}

/// Gives `ticket_id` its external identity, external ownership and first sync
/// state in one step. Import uses it; publication (a ticket gaining authority
/// from a confirmed external issue) uses it with [`Origin::Published`].
pub(crate) fn link(
    connection: &Connection,
    ticket_id: &str,
    issue: &ExternalIssue,
    origin: Origin,
    now: &str,
) -> Result<(), Error> {
    let identity = &issue.reference.identity;
    let (state, reason) = state_parts(issue.state);
    connection.execute(
        "INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, linked_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            ticket_id,
            identity.provider,
            identity.id,
            issue.reference.locator,
            issue.display,
            issue.url,
            match origin {
                Origin::Imported => "imported",
                Origin::Published => "published",
            },
            now
        ],
    )?;
    connection.execute(
        "INSERT INTO external_ownership (ticket_id, authority, changed_at) VALUES (?1, 'external', ?2)",
        params![ticket_id, now],
    )?;
    connection.execute(
        "INSERT INTO source_sync (ticket_id, external_state, closure_reason, external_updated_at, last_refreshed_at, last_attempt_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![ticket_id, state, reason, issue.updated_at, now],
    )?;
    Ok(())
}

impl Workspace {
    /// How many non-trashed tickets each source filter would show, with every
    /// other condition of `filter` applied and its own `source` ignored.
    pub fn count_by_source(&self, filter: &crate::TicketFilter) -> Result<SourceCounts, Error> {
        let mut unscoped = filter.clone();
        unscoped.source = None;
        let (conditions, values) = self.filter_conditions(&unscoped)?;
        let sql = format!(
            "SELECT i.provider, COUNT(*) FROM tickets t \
             LEFT JOIN external_ownership o ON o.ticket_id = t.id AND o.authority = 'external' \
             LEFT JOIN external_identities i ON i.ticket_id = o.ticket_id \
             WHERE t.trashed = 0{conditions} GROUP BY i.provider"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, u64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut counts = SourceCounts::default();
        for (provider, count) in rows {
            counts.all += count;
            match provider {
                Some(provider) => {
                    counts.providers.insert(provider, count);
                }
                None => counts.local += count,
            }
        }
        Ok(counts)
    }
}
