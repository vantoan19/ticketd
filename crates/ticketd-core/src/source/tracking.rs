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
    ClosureReason, Engine, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState, SourceError,
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
    },
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshFailure {
    pub provider: String,
    /// The ticket that could not be refreshed; absent when discovery itself failed.
    pub reference: Option<String>,
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
    if status != ticket.status {
        let local_progress = matches!(status, Status::Todo | Status::InProgress | Status::InReview);
        if !(open && local_progress) {
            return Err(Error::ExternalStatus {
                reference,
                provider,
                open,
            });
        }
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

pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = connection
        .query_row(
            "SELECT i.provider, i.external_id, i.locator, i.display, i.url, i.origin, o.authority, \
                    s.external_state, s.closure_reason, s.external_updated_at, s.last_refreshed_at, \
                    s.last_attempt_at, s.last_error_code, s.last_error_message, s.failing_since \
             FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id \
             JOIN source_sync s ON s.ticket_id = i.ticket_id \
             WHERE i.ticket_id = ?1",
            [&ticket.id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                ))
            },
        )
        .optional()?;
    let Some((
        provider,
        id,
        locator,
        display,
        url,
        origin,
        authority,
        state,
        reason,
        _updated,
        refreshed,
        attempted,
        error_code,
        error_message,
        failing_since,
    )) = row
    else {
        ticket.source = None;
        return Ok(());
    };
    let state = state_from_parts(&state, reason.as_deref());
    let ownership = if authority == "external" {
        Ownership::External
    } else {
        Ownership::Local
    };
    let external = ownership == Ownership::External;
    let duplicate_target = connection
        .query_row(
            "SELECT provider, external_id, locator, display FROM external_duplicate_targets WHERE ticket_id = ?1",
            [&ticket.id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
        .map(|(provider, id, locator, display)| match (provider, id) {
            (Some(provider), Some(id)) => DuplicateTarget::External {
                identity: ExternalIdentity { provider, id },
                locator: locator.unwrap_or_default(),
                display: display.unwrap_or_default(),
            },
            _ => DuplicateTarget::Unknown,
        });
    let unavailable = match (&error_code, failing_since) {
        (Some(code), since) if external && freshness::is_unavailable_code(code) => {
            Some(SourceUnavailable {
                code: code.clone(),
                message: error_message.clone().unwrap_or_default(),
                since: since.or_else(|| attempted.clone()).unwrap_or_default(),
            })
        }
        _ => None,
    };
    ticket.source = Some(TicketSource {
        provider,
        id,
        locator,
        display,
        url,
        origin: if origin == "published" {
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
        last_refreshed_at: refreshed,
        last_attempt_at: attempted,
        unavailable,
        last_error: error_code.map(|code| SourceFailure {
            code,
            message: error_message.unwrap_or_default(),
        }),
        content_locked: external,
        duplicate_target,
    });
    Ok(())
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

/// An issue found by the connector, or the reason a tracked one could not be read.
struct Gathered {
    issues: Vec<ExternalIssue>,
    failures: Vec<(Option<String>, String, SourceFailure)>,
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

fn failure_of(error: &SourceError) -> SourceFailure {
    SourceFailure {
        code: error.code().to_owned(),
        message: error.to_string(),
    }
}

/// Failures that say the provider as a whole cannot be read right now, so
/// asking again for every other ticket would only repeat them.
fn retry_secs(error: &SourceError) -> Option<u64> {
    match error {
        SourceError::RateLimited { retry_after_secs } => *retry_after_secs,
        _ => None,
    }
}

fn provider_wide(error: &SourceError) -> bool {
    !matches!(
        error,
        SourceError::NotFound(_) | SourceError::Forbidden(_) | SourceError::Unsupported(_)
    )
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
    pub fn refresh_sources(
        &mut self,
        engine: &Engine,
        options: &RefreshOptions,
    ) -> Result<RefreshReport, Error> {
        let tracked = self.tracked(options.ticket.as_deref())?;
        let mut gathered = Gathered {
            issues: Vec::new(),
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
            let mut seen: HashSet<String> = HashSet::new();
            let mut blocked: Option<SourceFailure> = None;
            let mut retry_after_secs: Option<u64> = None;
            let mut discovery_failed: Option<SourceFailure> = None;
            if options.ticket.is_none() {
                match config {
                    None => {}
                    Some(source) => {
                        let result = engine.discover(&provider, &source.config, |issue| {
                            seen.insert(issue.reference.identity.id.clone());
                            gathered.issues.push(issue);
                            ControlFlow::Continue(())
                        });
                        if let Err(error) = result {
                            let failure = failure_of(&error);
                            gathered
                                .failures
                                .push((None, provider.clone(), failure.clone()));
                            retry_after_secs = retry_secs(&error);
                            discovery_failed = Some(failure.clone());
                            if provider_wide(&error) {
                                blocked = Some(failure);
                            }
                        }
                    }
                }
            }
            for ticket in tracked.iter().filter(|t| t.provider == provider) {
                if seen.contains(&ticket.external_id) {
                    continue;
                }
                let reference = Some(ticket.reference.clone());
                if let Some(failure) = &blocked {
                    gathered
                        .failures
                        .push((reference, provider.clone(), failure.clone()));
                    continue;
                }
                let Some(source) = config else {
                    gathered.failures.push((
                        reference,
                        provider.clone(),
                        SourceFailure {
                            code: "not_configured".into(),
                            message: format!(
                                "no saved configuration for {provider}; save the source to refresh this ticket"
                            ),
                        },
                    ));
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
                        if provider_wide(&error) {
                            retry_after_secs = retry_secs(&error);
                            blocked = Some(failure.clone());
                        }
                        gathered
                            .failures
                            .push((reference, provider.clone(), failure));
                    }
                }
            }
            if options.ticket.is_none() && config.is_some() {
                gathered.runs.push(ProviderRun {
                    provider: provider.clone(),
                    failure: discovery_failed.or(blocked),
                    retry_after_secs,
                });
            }
        }
        self.apply_refresh(gathered, options.now.as_deref(), &tracked)
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
        now: Option<&str>,
        tracked: &[Tracked],
    ) -> Result<RefreshReport, Error> {
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let now = match now {
            Some(now) => now.to_owned(),
            None => {
                transaction.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
                    row.get(0)
                })?
            }
        };
        let mut applied = Applied::default();
        for issue in &gathered.issues {
            apply_issue(&transaction, issue, &now, &mut applied)?;
        }
        let by_reference: HashMap<&str, &Tracked> =
            tracked.iter().map(|t| (t.reference.as_str(), t)).collect();
        let mut failures = Vec::new();
        for (reference, provider, failure) in &gathered.failures {
            if let Some(ticket) = reference.as_deref().and_then(|r| by_reference.get(r)) {
                {
                    // Truthful freshness: the attempt and its error are recorded,
                    // the last successful refresh and saved content are not touched.
                    transaction.execute(
                        "UPDATE source_sync SET last_attempt_at = ?2, last_error_code = ?3, last_error_message = ?4, \
                         failing_since = COALESCE(failing_since, ?2) WHERE ticket_id = ?1",
                        params![ticket.ticket_id, now, failure.code, failure.message],
                    )?;
                }
            }
            failures.push(RefreshFailure {
                provider: provider.clone(),
                reference: reference.clone(),
                code: failure.code.clone(),
                message: failure.message.clone(),
                retry_after_secs: gathered
                    .runs
                    .iter()
                    .find(|run| run.provider == *provider && failure.code == "rate_limited")
                    .and_then(|run| run.retry_after_secs),
            });
        }
        for run in &gathered.runs {
            freshness::record_run(&transaction, run, &now)?;
        }
        transaction.commit()?;
        Ok(RefreshReport {
            imported: applied.imported,
            updated: applied.updated,
            unchanged: applied.unchanged,
            failures,
            refreshed_at: now,
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
            if next == Status::Duplicate && previous != Some(issue.state) {
                set_duplicate_target(connection, &id, issue)?;
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
/// connector supplied, or an explicit unknown target. It never invents a local link.
fn set_duplicate_target(
    connection: &Connection,
    id: &str,
    issue: &ExternalIssue,
) -> Result<(), Error> {
    match &issue.duplicate_of {
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
