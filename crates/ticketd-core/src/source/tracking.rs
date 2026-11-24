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
    Conversation, DerivedConfiguration, Engine, ExternalIdentity, ExternalIssue, ExternalRef,
    ExternalState, SourceError, StateCategory,
    contract::FailureCode,
    conversation,
    freshness::{self, ProviderRun, SourceUnavailable},
};
use crate::{Error, Status, Ticket, Workspace, duplicates, history};

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
        /// Where the canonical issue can be opened, when the source said.
        #[serde(default)]
        url: Option<String>,
        /// The source no longer supplied this target (a failed lookup or lost
        /// access), so it is the last one it named, not a confirmed one.
        #[serde(default)]
        last_known: bool,
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
    /// What people call the provider, such as "GitHub".
    pub provider_name: String,
    /// An optional provider mark, cached with the ticket for other desktops.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_icon_svg: Option<String>,
    /// Where the issue lives, such as "owner/repo" (empty when the locator has no place).
    pub place: String,
    /// Formatted place label for the state line.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub place_label: String,
    /// A duplicate's short number when its target is in the same place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_number: Option<String>,
    /// The provider's short number for the issue, such as "#98" (empty when it has none).
    pub number: String,
    /// The provider's stable id for the issue (never a display value).
    pub id: String,
    pub locator: String,
    pub display: String,
    pub url: String,
    pub origin: Origin,
    /// Last complete discovery membership observation; unknown until a full walk succeeds.
    #[serde(default)]
    pub discovery_matches: Option<bool>,
    #[serde(default)]
    pub ownership_changed_at: Option<String>,
    pub ownership: Ownership,
    /// The external state last observed.
    pub state: ExternalState,
    /// The source identity that opened the issue. `None` until a refresh reads it.
    #[serde(default)]
    pub author: Option<String>,
    /// When the issue was opened at the source. `None` until a refresh reads it.
    #[serde(default)]
    pub created_at: Option<String>,
    /// The latest source closure time, only when the matching conversation is fresh.
    #[serde(default)]
    pub closed_at: Option<String>,
    /// The observed state category is unknown and did not change the status.
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
    /// The statuses a person may choose for this ticket now (empty when none can be
    /// changed here), so no client repeats the rule.
    pub status_choices: Vec<Status>,
    pub duplicate_target: Option<DuplicateTarget>,
}

/// Existing source availability fields, without the rest of a source payload.
#[derive(Debug, Serialize)]
pub struct SourceAvailability {
    pub unavailable: Option<SourceUnavailable>,
}
fn unavailable(
    authority: &str,
    code: Option<&str>,
    message: Option<&str>,
    since: Option<&str>,
    attempted: Option<&str>,
) -> Option<SourceUnavailable> {
    code.filter(|code| {
        authority == "external" && FailureCode::parse(code).is_some_and(FailureCode::is_unavailable)
    })
    .map(|code| SourceUnavailable {
        code: code.to_owned(),
        message: message.unwrap_or_default().to_owned(),
        since: since.or(attempted).unwrap_or_default().to_owned(),
    })
}
pub(crate) fn availability_projection(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Option<SourceAvailability>, Error> {
    let mut query = connection.prepare_cached(
        "SELECT o.authority, s.last_error_code, s.last_error_message, s.failing_since,
                s.last_attempt_at, i.provider, i.locator, i.partition, i.linked_at
         FROM external_identities i
         JOIN external_ownership o ON o.ticket_id = i.ticket_id
         JOIN source_sync s ON s.ticket_id = i.ticket_id WHERE i.ticket_id = ?1",
    )?;
    let mut rows = query.query([ticket_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let authority: String = row.get(0)?;
    let provider: String = row.get(5)?;
    let part = match row.get::<_, Option<String>>(7)? {
        Some(part) => part,
        None => super::legacy_reference_partition(&provider, &row.get::<_, String>(6)?)
            .unwrap_or_default(),
    };
    let attempted: Option<String> = row.get(4)?;
    let unavailable = if authority != "external" {
        None
    } else if let Some(since) = super::connection_removed_at(connection, ticket_id)? {
        Some(SourceUnavailable {
            code: super::CONNECTION_REMOVED.into(),
            message: "Connection removed".into(),
            since,
        })
    } else if super::selected_connection(connection, ticket_id, &provider, &part)?.is_none() {
        Some(SourceUnavailable {
            code: FailureCode::NotConfigured.as_str().into(),
            message: "Not connected on this desktop".into(),
            since: match attempted {
                Some(time) => time,
                None => row.get(8)?,
            },
        })
    } else {
        let code: Option<String> = row.get(1)?;
        unavailable(
            &authority,
            code.as_deref()
                .filter(|code| *code != FailureCode::NotConfigured.as_str()),
            row.get::<_, Option<String>>(2)?.as_deref(),
            row.get::<_, Option<String>>(3)?.as_deref(),
            attempted.as_deref(),
        )
    };
    Ok(Some(SourceAvailability { unavailable }))
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

const ALL_STATUSES: [Status; 6] = [
    Status::Todo,
    Status::InProgress,
    Status::InReview,
    Status::Done,
    Status::Canceled,
    Status::Duplicate,
];

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
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
         CREATE INDEX external_duplicate_targets_identity ON external_duplicate_targets(provider, external_id);",
    )?;
    Ok(())
}

/// Format version 85: who opened the issue and when, as the source last said. Tickets
/// tracked before this version have neither until their next refresh. Each column is
/// added only when missing, so a workspace reopened after its tables were rebuilt
/// still migrates.
pub(crate) fn migrate_issue_opening(connection: &Connection) -> Result<(), Error> {
    for column in ["external_author", "external_created_at"] {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('source_sync') WHERE name = ?1)",
            [column],
            |row| row.get(0),
        )?;
        if !present {
            connection
                .execute_batch(&format!("ALTER TABLE source_sync ADD COLUMN {column} TEXT"))?;
        }
    }
    Ok(())
}

/// The issue's author and opening time as stored: an empty value is unknown.
fn opening(issue: &ExternalIssue) -> (Option<&str>, Option<&str>) {
    fn known(value: &str) -> Option<&str> {
        (!value.trim().is_empty()).then_some(value)
    }
    (
        issue.author.as_deref().and_then(known),
        known(&issue.created_at),
    )
}

/// The ownership of a ticket as write guards need it.
pub(crate) enum Authority {
    Local,
    External {
        provider: String,
        open: bool,
        /// The reported state category is unknown.
        closure_unrecognized: bool,
    },
}

/// SQL that is true for the ticket whose id is `id_expr` and whose issue the
/// source owns and reports with an unknown category. Such a ticket keeps
/// its status, is flagged, and awaits a local decision, so it is never
/// offered as Ready work.
pub(crate) fn held_sql(id_expr: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM external_ownership ho JOIN source_sync hs ON hs.ticket_id = ho.ticket_id \
         WHERE ho.ticket_id = {id_expr} AND ho.authority = 'external' \
         AND hs.state_category = 'unknown')"
    )
}

/// Whether a ticket is currently externally owned. Call inside the write
/// transaction that depends on the answer.
pub(crate) fn authority(connection: &Connection, id: &str) -> Result<Authority, Error> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT i.provider, s.state_category FROM external_ownership o \
             JOIN external_identities i ON i.ticket_id = o.ticket_id \
             JOIN source_sync s ON s.ticket_id = o.ticket_id \
             WHERE o.ticket_id = ?1 AND o.authority = 'external'",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        None => Authority::Local,
        Some((provider, category)) => Authority::External {
            provider,
            open: category == "open",
            closure_unrecognized: category == "unknown",
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
    let Authority::External {
        provider,
        open,
        closure_unrecognized,
    } = authority(connection, &ticket.id)?
    else {
        return Ok(());
    };
    let reference = ticket.reference.clone();
    if title.is_some_and(|title| title != ticket.title)
        || body.is_some_and(|body| body != ticket.body)
    {
        return Err(Error::ExternalContent {
            reference,
            provider: super::provider_display_name(connection, &provider)?,
        });
    }
    // Open: Todo, In progress and In review are local. For an unknown state,
    // Done or Canceled is the person's own decision (the flag stays).
    let allowed =
        (open && status.is_local_progress()) || (closure_unrecognized && status.ends_work());
    if status != ticket.status && !allowed {
        return Err(Error::ExternalStatus {
            reference,
            provider: super::provider_display_name(connection, &provider)?,
            open,
            closure_unrecognized,
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
        Authority::External {
            provider,
            open,
            closure_unrecognized,
        } => Err(Error::ExternalStatus {
            reference: reference.to_owned(),
            provider: super::provider_display_name(connection, &provider)?,
            open,
            closure_unrecognized,
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
    discovery_matches: Option<bool>,
    ownership_changed_at: Option<String>,
    category: String,
    name: Option<String>,
    refreshed: Option<String>,
    attempted: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
    conversation_error_code: Option<String>,
    conversation_error_message: Option<String>,
    author: Option<String>,
    created_at: Option<String>,
    provider_name: Option<String>,
    provider_icon_svg: Option<String>,
}

pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    let row: Option<SourceRow> = connection
        .prepare_cached(
            "SELECT i.provider, i.external_id, i.locator, i.display, i.url, i.origin, o.authority, \
                    s.state_category, s.state_name, s.last_refreshed_at, \
                    s.last_attempt_at, s.last_error_code, s.last_error_message, \
                    s.conversation_error_code, s.conversation_error_message, s.discovery_matches, o.changed_at, \
                    s.external_author, s.external_created_at, i.provider_name, i.provider_icon_svg \
             FROM external_identities i \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id \
             JOIN source_sync s ON s.ticket_id = i.ticket_id \
             WHERE i.ticket_id = ?1",
        )?
        .query_row(
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
                    category: row.get(7)?,
                    name: row.get(8)?,
                    refreshed: row.get(9)?,
                    attempted: row.get(10)?,
                    error_code: row.get(11)?,
                    error_message: row.get(12)?,
                    conversation_error_code: row.get(13)?,
                    conversation_error_message: row.get(14)?,
                    discovery_matches: row.get(15)?,
                    ownership_changed_at: row.get(16)?,
                    author: row.get(17)?,
                    created_at: row.get(18)?,
                    provider_name: row.get(19)?,
                    provider_icon_svg: row.get(20)?,
                })
            },
        )
        .optional()?;
    let Some(row) = row else {
        ticket.source = None;
        return Ok(());
    };
    let state = ExternalState {
        category: StateCategory::parse(&row.category),
        name: row.name,
    };
    let ownership = if row.authority == "external" {
        Ownership::External
    } else {
        Ownership::Local
    };
    let external = ownership == Ownership::External;
    let status_choices: Vec<Status> = if external {
        match state.category {
            StateCategory::Open => ALL_STATUSES
                .into_iter()
                .filter(|status| status.is_local_progress())
                .collect(),
            StateCategory::Unknown => ALL_STATUSES
                .into_iter()
                .filter(|status| status.ends_work())
                .collect(),
            StateCategory::Completed | StateCategory::NotPlanned | StateCategory::Duplicate => {
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let duplicate_target = duplicate_target(connection, &ticket.id)?;
    let closed_at = conversation::closed_at(connection, &ticket.id)?;
    let unavailable =
        availability_projection(connection, &ticket.id)?.and_then(|value| value.unavailable);
    let description = super::cached_description(connection, &row.provider)?;
    let (provider_name, place, number, place_label) = super::display_parts(
        description.as_deref(),
        &row.provider,
        &row.locator,
        &row.display,
    );
    let duplicate_number = match &duplicate_target {
        Some(DuplicateTarget::External {
            identity,
            locator,
            display,
            ..
        }) if identity.provider == row.provider && !place.is_empty() => {
            let (_, target_place, target_number, _) =
                super::display_parts(description.as_deref(), &row.provider, locator, display);
            (place == target_place && !target_number.is_empty()).then_some(target_number)
        }
        _ => None,
    };
    ticket.source = Some(TicketSource {
        provider_name: row.provider_name.unwrap_or(provider_name),
        provider_icon_svg: row.provider_icon_svg.or_else(|| {
            description.and_then(|description| description.presentation.icon_svg.clone())
        }),
        place,
        place_label,
        number,
        duplicate_number,
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
        discovery_matches: row.discovery_matches,
        ownership_changed_at: row.ownership_changed_at,
        closure_unrecognized: state.category == StateCategory::Unknown,
        status_locked: external && status_choices.is_empty(),
        status_choices,
        state,
        author: row.author,
        created_at: row.created_at,
        closed_at,
        last_refreshed_at: row.refreshed,
        last_attempt_at: row.attempted,
        unavailable,
        last_error: row
            .error_code
            .filter(|code| code != FailureCode::NotConfigured.as_str())
            .map(|code| SourceFailure {
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
            "SELECT provider, external_id, locator, display, url, last_known FROM external_duplicate_targets WHERE ticket_id = ?1",
            [ticket_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, bool>(5)?,
                ))
            },
        )
        .optional()?;
    Ok(match row {
        None => None,
        Some((Some(provider), Some(id), locator, display, url, last_known)) => {
            let identity = ExternalIdentity { provider, id };
            let (ticket, problem) = resolve_target(connection, ticket_id, &identity)?;
            Some(DuplicateTarget::External {
                identity,
                locator: locator.unwrap_or_default(),
                display: display.unwrap_or_default(),
                ticket,
                problem,
                url,
                last_known,
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
            "SELECT reference FROM tickets WHERE id = ?1",
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

/// Apply status transitions from the typed category. Display names can change
/// without a transition, and unknown observations preserve established status.
pub(crate) fn status_for(
    previous: Option<StateCategory>,
    observed: StateCategory,
    current: Status,
) -> Status {
    if previous == Some(observed) {
        return current;
    }
    match observed {
        StateCategory::Open
            if previous == Some(StateCategory::Unknown) && current.is_local_progress() =>
        {
            current
        }
        StateCategory::Open => Status::Todo,
        StateCategory::Completed => Status::Done,
        StateCategory::NotPlanned => Status::Canceled,
        StateCategory::Duplicate => Status::Duplicate,
        StateCategory::Unknown => current,
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
    conversation_engine: Option<Engine>,
    retry_limit: Option<(String, u64)>,
    configurations: HashMap<String, Option<CheckedConfiguration>>,
    discovery: Vec<(String, HashSet<String>)>,
    issues: Vec<ExternalIssue>,
    /// Conversations read this time, by (provider, external id). An issue absent
    /// here keeps the conversation it already has.
    conversations: HashMap<(String, String), Conversation>,
    failures: Vec<Found>,
    /// How each fully refreshed provider fared, for its persisted status.
    runs: Vec<ProviderRun>,
    /// The part of its source each discovered issue belongs to, by (provider,
    /// external id).
    partitions: HashMap<(String, String), String>,
    /// Per provider, the parts tickets were already imported from.
    imported_partitions: HashMap<String, HashSet<String>>,
}

struct CheckedConfiguration {
    revision: String,
    derived: Option<DerivedConfiguration>,
}

pub(super) struct Tracked {
    pub(super) ticket_id: String,
    reference: String,
    pub(super) provider: String,
    external_id: String,
    locator: String,
    pub(super) partition: String,
    affinity: Option<String>,
    pub(super) error_code: Option<String>,
    removed: bool,
}

impl Tracked {
    pub(super) fn connection<'a>(
        &self,
        sources: &'a [super::ConfiguredSource],
    ) -> Option<&'a super::ConfiguredSource> {
        if self.removed {
            return None;
        }
        super::select_connection(
            sources,
            self.affinity.as_deref(),
            &self.provider,
            &self.partition,
        )
    }
}

pub(crate) fn failure_of(error: &SourceError) -> SourceFailure {
    SourceFailure {
        code: error.code().to_owned(),
        message: error.to_string(),
    }
}

fn rate_limit_hold(
    error: &SourceError,
    received_at: &dyn Fn() -> Option<String>,
) -> Option<(String, u64)> {
    let SourceError::RateLimited { retry_after_secs } = error else {
        return None;
    };
    let now = received_at()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    Some((
        now,
        retry_after_secs.unwrap_or(freshness::DEFAULT_RATE_LIMIT_SECS),
    ))
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
        self.refresh_selected(engine, options, None)
    }

    /// The connection that would refresh the externally owned ticket on this device.
    pub fn ticket_source_connection(&self, reference: &str) -> Result<Option<String>, Error> {
        let tracked = tracked(&self.connection, Some(reference))?;
        let Some(ticket) = tracked.first() else {
            return Ok(None);
        };
        super::selected_connection(
            &self.connection,
            &ticket.ticket_id,
            &ticket.provider,
            &ticket.partition,
        )
    }

    /// Refreshes a single connection and the tickets routed to it.
    pub fn refresh_connection(
        &mut self,
        engine: &Engine,
        id: &str,
        options: &RefreshOptions,
    ) -> Result<RefreshReport, Error> {
        self.source_connection(id)?;
        self.refresh_selected(engine, options, Some(&[id.to_owned()]))
    }

    pub(super) fn refresh_selected(
        &mut self,
        engine: &Engine,
        options: &RefreshOptions,
        selected: Option<&[String]>,
    ) -> Result<RefreshReport, Error> {
        self.refresh_selected_with_clock(engine, options, selected, &|| options.now.clone())
    }

    pub(super) fn refresh_selected_with_clock(
        &mut self,
        engine: &Engine,
        options: &RefreshOptions,
        selected: Option<&[String]>,
        received_at: &(dyn Fn() -> Option<String> + Sync),
    ) -> Result<RefreshReport, Error> {
        engine.check_refresh_canceled()?;
        let started = super::clock(&self.connection, options.now.as_deref())?;
        let tracked = tracked(&self.connection, options.ticket.as_deref())?;
        let sources = super::configured_sources(&self.connection)?;
        let routed = |ticket: &Tracked| {
            ticket
                .connection(&sources)
                .map(|source| source.saved.id.as_str())
        };
        if let (Some(selected), Some(ticket)) = (selected, tracked.first())
            && options.ticket.is_some()
            && !routed(ticket).is_some_and(|id| selected.iter().any(|selection| selection == id))
        {
            return Err(
                SourceError::InvalidConfiguration(vec![super::FieldIssue::for_field(
                    "connection",
                    "this ticket is routed to a different connection or has no covering connection",
                )])
                .into(),
            );
        }
        if let (Some(_), Some(ticket)) = (&options.ticket, tracked.first())
            && ticket.removed
        {
            return Ok(RefreshReport {
                imported: Vec::new(),
                updated: Vec::new(),
                unchanged: 0,
                failures: vec![RefreshFailure {
                    provider: ticket.provider.clone(),
                    connection_id: None,
                    reference: Some(ticket.reference.clone()),
                    scope: FailureScope::Ticket,
                    code: super::CONNECTION_REMOVED.into(),
                    message: "Add a connection and refresh discovery to resume synchronization"
                        .into(),
                    retry_after_secs: None,
                }],
                refreshed_at: started,
            });
        }
        let jobs: Vec<_> = sources
            .iter()
            .filter(|source| {
                selected.is_none_or(|ids| ids.contains(&source.saved.id))
                    && (options.ticket.is_none()
                        || tracked
                            .iter()
                            .any(|ticket| routed(ticket) == Some(&source.saved.id)))
            })
            .collect();
        let gather = |source: &super::ConfiguredSource| {
            gather_connection(
                engine,
                options,
                &tracked,
                &sources,
                &source.saved.provider,
                Some(source),
                received_at,
            )
        };
        let mut gathered = Vec::new();
        let mut conversations = HashSet::new();
        for pair in jobs.chunks(2) {
            engine.check_refresh_canceled()?;
            let batches = if let [first, second] = pair {
                std::thread::scope(|scope| {
                    let first_worker = scope.spawn(|| gather(first));
                    let second_batch = gather(second);
                    let first_batch = first_worker.join().map_err(|_| {
                        Error::Source(SourceError::Protocol(
                            "a source refresh worker stopped".into(),
                        ))
                    })?;
                    Ok::<_, Error>(vec![(*first, first_batch?), (*second, second_batch?)])
                })?
            } else {
                pair.iter()
                    .map(|source| Ok((*source, gather(source)?)))
                    .collect::<Result<Vec<_>, Error>>()?
            };
            for (source, mut batch) in batches {
                engine.check_refresh_canceled()?;
                if let Some(scoped) = batch.conversation_engine.take() {
                    gather_conversations(
                        &self.connection,
                        &scoped,
                        source,
                        &tracked,
                        &mut conversations,
                        &mut batch,
                        received_at,
                    )?;
                }
                gathered.push((Some(source.saved.id.as_str()), batch));
            }
        }
        if selected.is_none() {
            let missing: HashSet<_> = tracked
                .iter()
                .filter(|ticket| !ticket.removed && routed(ticket).is_none())
                .map(|ticket| ticket.provider.as_str())
                .collect();
            for provider in missing {
                engine.check_refresh_canceled()?;
                let batch = gather_connection(
                    engine,
                    options,
                    &tracked,
                    &sources,
                    provider,
                    None,
                    received_at,
                )?;
                gathered.push((None, batch));
            }
        }
        engine.check_refresh_canceled()?;
        self.in_write_scope(|workspace| {
            let mut report = RefreshReport {
                imported: Vec::new(),
                updated: Vec::new(),
                unchanged: 0,
                failures: Vec::new(),
                refreshed_at: started.clone(),
            };
            for (source_id, batch) in gathered {
                engine.check_refresh_canceled()?;
                let batch = workspace.apply_refresh(batch, &started, &tracked, source_id)?;
                report.imported.extend(batch.imported);
                report.updated.extend(batch.updated);
                report.unchanged = report.unchanged.saturating_add(batch.unchanged);
                report.failures.extend(batch.failures);
            }
            engine.check_refresh_canceled()?;
            Ok(report)
        })
    }
}

fn gather_connection(
    engine: &Engine,
    options: &RefreshOptions,
    tracked: &[Tracked],
    sources: &[super::ConfiguredSource],
    provider: &str,
    configured: Option<&super::ConfiguredSource>,
    received_at: &dyn Fn() -> Option<String>,
) -> Result<Gathered, Error> {
    engine.check_refresh_canceled()?;
    let source_id = configured.map(|source| source.saved.id.as_str());
    let assigned = |ticket: &Tracked| {
        !ticket.removed
            && ticket
                .connection(sources)
                .map(|source| source.saved.id.as_str())
                == source_id
    };
    let _source =
        tracing::info_span!("source", source_id = source_id.unwrap_or(provider)).entered();
    let provider = provider.to_owned();
    let mut gathered = Gathered {
        conversation_engine: None,
        retry_limit: None,
        issues: Vec::new(),
        conversations: HashMap::new(),
        failures: Vec::new(),
        runs: Vec::new(),
        discovery: Vec::new(),
        configurations: HashMap::new(),
        partitions: HashMap::new(),
        imported_partitions: HashMap::new(),
    };
    let config = configured.map(|source| &source.saved.config);
    let mut seen: HashSet<String> = HashSet::new();
    // Set when the source as a whole cannot be read, so asking for more
    // tickets would only repeat the failure.
    let mut blocked: Option<SourceFailure> = None;
    let mut discovery_failed: Option<SourceFailure> = None;
    let mut skipped: Vec<String> = Vec::new();
    let mut read_partitions: Vec<String> = Vec::new();
    let mut skipped_partitions: Vec<String> = Vec::new();
    let mut scoped = None;
    let checked = configured.map(|source| {
        let derived = match source.check(engine) {
            Ok((prepared, checked)) => {
                scoped = Some(prepared);
                Some(checked.derived)
            }
            Err(error) => {
                gathered.retry_limit = rate_limit_hold(&error, received_at);
                let failure = failure_of(&error);
                gathered.failures.push(Found {
                    scope: FailureScope::Source,
                    reference: None,
                    provider: provider.clone(),
                    failure: failure.clone(),
                });
                blocked = Some(failure);
                None
            }
        };
        CheckedConfiguration {
            revision: source.revision.clone(),
            derived,
        }
    });
    engine.check_refresh_canceled()?;
    let engine = scoped.as_ref();
    if let (None, Some(config), Some(derived), Some(engine)) = (
        &options.ticket,
        config,
        checked
            .as_ref()
            .and_then(|checked| checked.derived.as_ref()),
        engine,
    ) {
        // A part read under narrower rules is new to a broader discovery.
        let scope = &derived.discovery_scope;
        let scoped = |part: &str| {
            let mut part = part.replace('%', "%25").replace('?', "%3F");
            if !scope.is_empty() {
                part.push('?');
                part.push_str(scope);
            }
            part
        };
        gathered.imported_partitions.insert(
            provider.clone(),
            tracked
                .iter()
                .filter(|ticket| ticket.provider == provider && assigned(ticket))
                .map(|ticket| scoped(&ticket.partition))
                .collect(),
        );
        let result = engine.discover(&provider, config, |issue| {
            if tracked
                .iter()
                .find(|ticket| {
                    ticket.provider == provider && ticket.external_id == issue.reference.identity.id
                })
                .is_some_and(|ticket| {
                    if ticket.removed || ticket.affinity.is_none() {
                        !derived.partitions.contains(&issue.reference.partition)
                    } else {
                        !assigned(ticket)
                    }
                })
            {
                return ControlFlow::Continue(());
            }
            seen.insert(issue.reference.identity.id.clone());
            gathered.partitions.insert(
                (provider.clone(), issue.reference.identity.id.clone()),
                scoped(&issue.reference.partition),
            );
            gathered.issues.push(issue);
            ControlFlow::Continue(())
        });
        engine.check_refresh_canceled()?;
        match result {
            Ok(summary) => {
                if summary.complete && summary.skipped.is_empty() {
                    gathered.discovery.push((provider.clone(), seen.clone()));
                }
                skipped_partitions = summary
                    .skipped
                    .iter()
                    .map(|part| scoped(&part.partition))
                    .collect();
                read_partitions = derived.partitions.iter().map(|part| scoped(part)).collect();
                read_partitions.retain(|part| !skipped_partitions.contains(part));
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
                gathered.retry_limit = rate_limit_hold(&error, received_at);
                discovery_failed = Some(failure.clone());
                if error.failure_code().interrupts_source() {
                    blocked = Some(failure);
                }
            }
        }
    }
    for ticket in tracked
        .iter()
        .filter(|t| t.provider == provider && assigned(t))
    {
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
        let (Some(config), Some(engine)) = (config, engine) else {
            gathered.failures.push(Found {
                scope: FailureScope::Ticket,
                reference,
                provider: provider.clone(),
                failure: SourceFailure {
                    code: FailureCode::NotConfigured.as_str().into(),
                    message: format!("{provider} is not connected on this desktop for this ticket"),
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
            partition: ticket.partition.clone(),
        };
        engine.check_refresh_canceled()?;
        // Count an issue once whether it was discovered or fetched, and
        // include attempted reads that returned a ticket-level failure.
        seen.insert(ticket.external_id.clone());
        match engine.fetch(&provider, config, &external) {
            Ok(issue) => gathered.issues.push(issue),
            Err(error) => {
                let failure = failure_of(&error);
                if error.failure_code().interrupts_source() {
                    gathered.retry_limit = rate_limit_hold(&error, received_at);
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
    if blocked.is_none() {
        gathered.conversation_engine = scoped;
    }
    gathered.configurations.insert(provider.clone(), checked);
    if options.ticket.is_none() && config.is_some() {
        gathered.runs.push(ProviderRun {
            provider: provider.clone(),
            connection_id: source_id.unwrap_or(&provider).to_owned(),
            failure: discovery_failed.or(blocked),
            skipped,
            read_partitions,
            skipped_partitions,
            checked_tickets: u32::try_from(seen.len()).unwrap_or(u32::MAX),
        });
    }
    Ok(gathered)
}

/// Reads the conversation of each gathered issue whose
/// stored conversation is older than the issue itself. A failure keeps what
/// was stored and leaves the issue due again next time. It is recorded as a
/// conversation failure only: the issue itself was read, so it never makes a
/// ticket unavailable. Only a failure of the source as a whole stops further
/// reads.
fn gather_conversations(
    connection: &Connection,
    engine: &Engine,
    source: &super::ConfiguredSource,
    tracked: &[Tracked],
    conversations: &mut HashSet<(String, String)>,
    gathered: &mut Gathered,
    received_at: &dyn Fn() -> Option<String>,
) -> Result<(), Error> {
    let due: Vec<ExternalIssue> = gathered.issues.clone();
    for issue in due {
        engine.check_refresh_canceled()?;
        let identity = &issue.reference.identity;
        // Overlapping discovery can return the same new issue before either
        // batch is applied. The first eligible connection will take its route.
        if !issue_can_refresh(
            connection,
            &issue,
            &gathered.partitions,
            Some(&source.saved.id),
            false,
        )? || !conversations.insert((identity.provider.clone(), identity.id.clone()))
        {
            continue;
        }
        if !conversation::needs_reading(
            connection,
            &identity.provider,
            &identity.id,
            &issue.updated_at,
        )? {
            continue;
        }
        match engine.conversation(&identity.provider, &source.saved.config, &issue.reference) {
            Ok(Some(mut read)) => {
                // REST timeline closes may omit a reason. Only the latest
                // state event can borrow the issue's currently observed closure.
                // An unreadable time makes the latest event unknown, and
                // offsets must be compared as instants, not text.
                let latest = read
                    .events
                    .iter()
                    .enumerate()
                    .filter(|(_, event)| {
                        matches!(
                            event.kind,
                            super::ExternalEventKind::Closed(_)
                                | super::ExternalEventKind::Reopened
                        )
                    })
                    .map(|(index, event)| {
                        chrono::DateTime::parse_from_rfc3339(&event.created_at)
                            .map(|time| (index, time))
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .ok()
                    .and_then(|events| events.into_iter().max_by(|a, b| a.1.cmp(&b.1)))
                    .map(|(index, _)| index);
                if issue.state.category != StateCategory::Open
                    && let Some(index) = latest
                    && let Some(event) = read.events.get_mut(index)
                    && matches!(event.kind, super::ExternalEventKind::Closed(_))
                {
                    if event.kind == super::ExternalEventKind::Closed(StateCategory::Unknown) {
                        event.kind = super::ExternalEventKind::Closed(issue.state.category);
                    }
                    if event.kind == super::ExternalEventKind::Closed(StateCategory::Duplicate)
                        && event.subject.is_none()
                    {
                        event.subject = issue
                            .duplicate_of
                            .as_ref()
                            .map(|target| target.locator.clone());
                    }
                }
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
                if error.failure_code() == FailureCode::RateLimited {
                    gathered.retry_limit = rate_limit_hold(&error, received_at);
                }
                if error.failure_code().interrupts_source() {
                    break;
                }
            }
        }
    }
    Ok(())
}

pub(super) fn tracked(connection: &Connection, only: Option<&str>) -> Result<Vec<Tracked>, Error> {
    let mut statement = connection.prepare(
            "SELECT t.id, t.reference, i.provider, i.external_id, i.locator, i.partition, c.connection_id, s.last_error_code, r.ticket_id IS NOT NULL FROM external_identities i \
             LEFT JOIN source_connection_tickets c ON c.ticket_id = i.ticket_id \
             LEFT JOIN source_sync s ON s.ticket_id = i.ticket_id \
             LEFT JOIN source_connection_removals r ON r.ticket_id = i.ticket_id \
             JOIN external_ownership o ON o.ticket_id = i.ticket_id AND o.authority = 'external' \
             JOIN tickets t ON t.id = i.ticket_id \
             WHERE (?1 IS NULL OR t.reference = ?1) ORDER BY t.number",
        )?;
    let rows = statement
        .query_map([only], |row| {
            let provider: String = row.get(2)?;
            let locator: String = row.get(4)?;
            let stored_partition: Option<String> = row.get(5)?;
            Ok(Tracked {
                ticket_id: row.get(0)?,
                reference: row.get(1)?,
                partition: stored_partition
                    .or_else(|| super::legacy_reference_partition(&provider, &locator))
                    .unwrap_or_default(),
                provider,
                external_id: row.get(3)?,
                locator,
                affinity: row.get(6)?,
                error_code: row.get(7)?,
                removed: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if let (Some(reference), true) = (only, rows.is_empty()) {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tickets WHERE reference = ?1)",
            [reference],
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

/// The route is checked again inside the write, after a possible removal or
/// another connection's discovery. A removed ticket can only be claimed by
/// actual discovery under the connection's current covering rules.
fn issue_can_refresh(
    connection: &Connection,
    issue: &ExternalIssue,
    discovery: &HashMap<(String, String), String>,
    source_id: Option<&str>,
    replaced_config: bool,
) -> Result<bool, Error> {
    let reference = &issue.reference;
    let identity = &reference.identity;
    let Some(id) = ticket_for_identity(connection, identity)? else {
        return Ok(!replaced_config);
    };
    let (url, partition, bound): (String, Option<String>, bool) = connection.query_row(
        "SELECT i.url, i.partition, c.connection_id IS NOT NULL
         FROM external_identities i LEFT JOIN source_connection_tickets c ON c.ticket_id = i.ticket_id
         WHERE i.ticket_id = ?1",
        [&id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if !super::legacy_issue_origin_matches(&identity.provider, &url, &issue.url) {
        tracing::warn!(
            source_id = source_id.unwrap_or_default(),
            error_kind = "identity_conflict",
            "source issue identity belongs to a different site"
        );
        return Ok(false);
    }
    let removed = super::connection_removed_at(connection, &id)?.is_some();
    let discovered = discovery.contains_key(&(identity.provider.clone(), identity.id.clone()));
    if !replaced_config && discovered && (removed || !bound) {
        return Ok(source_id
            .map(|id| super::configured_source(connection, id))
            .transpose()?
            .flatten()
            .is_some_and(|source| {
                source.saved.provider == identity.provider
                    && source.derived.partitions.contains(&reference.partition)
            }));
    }
    if removed {
        return Ok(false);
    }
    Ok(super::selected_connection(
        connection,
        &id,
        &identity.provider,
        partition.as_deref().unwrap_or(&reference.partition),
    )?
    .as_deref()
        == source_id)
}

impl Workspace {
    fn apply_refresh(
        &mut self,
        gathered: Gathered,
        now: &str,
        tracked: &[Tracked],
        source_id: Option<&str>,
    ) -> Result<RefreshReport, Error> {
        crate::write_scope::run(&self.connection, |transaction| {
            // Configuration can change while the connector is on the network.
            // Re-read it under the same write lock as the results: old discovery
            // cannot import new tickets or describe the rules saved afterwards.
            let mut replaced = HashSet::new();
            for (provider, checked) in &gathered.configurations {
                let current = source_id
                    .map(|id| super::configured_source(transaction, id))
                    .transpose()?
                    .flatten();
                if current.as_ref().map(|source| &source.revision)
                    != checked.as_ref().map(|check| &check.revision)
                {
                    replaced.insert(provider.clone());
                    continue;
                }
                if let (Some(current), Some(derived)) = (
                    current,
                    checked.as_ref().and_then(|check| check.derived.as_ref()),
                ) {
                    let changed = transaction.execute(
                        "UPDATE source_connections SET derived_configuration = ?2, derived_checked_at = ?3 \
                         WHERE id = ?1 AND (derived_checked_at IS NULL OR julianday(derived_checked_at) <= julianday(?3))",
                        params![current.saved.id, serde_json::to_string(derived)?, now],
                    )?;
                    if !super::same_discovery(&current.derived, derived) {
                        if changed != 0 {
                            super::clear_discovery_matches(transaction, &current)?;
                        } else {
                            // A newer check already established different discovery rules.
                            replaced.insert(provider.clone());
                        }
                    }
                }
            }
            let mut applied = Applied::default();
            // Workspace events: what a source brings in is logged with actor `sync`, and a
            // first import logs nothing. That is every issue new to this Workspace that
            // comes from a part of its source (for GitHub, a repository) no run has read
            // yet under the discovery rules it is read with now: the backlog of a new
            // source, of a repository added to one, or shown by a loosened filter is not
            // news. An issue that arrives in the same refresh as such a change cannot be
            // told from that backlog and is silent too. A part counts as read once a
            // successful run read it, so a first read
            // that fails partway, or that skips a repository it cannot see, stays silent
            // for it the next time too. Changes to tickets already here, and issues that
            // arrive in a part already read, log as `sync`. The write scope folds the
            // events of an imported ticket into its one `ticket.created`.
            let own_actor = crate::events::actor(transaction)?;
            let mut read_before: HashMap<&str, HashSet<String>> = HashMap::new();
            for provider in gathered
                .issues
                .iter()
                .map(|issue| &issue.reference.identity.provider)
                .chain(gathered.runs.iter().map(|run| &run.provider))
            {
                if !read_before.contains_key(provider.as_str()) {
                    let read = freshness::read_partitions(
                        transaction,
                        source_id.unwrap_or(provider),
                        gathered.imported_partitions.get(provider),
                    )?;
                    read_before.insert(provider, read);
                }
            }
            for issue in &gathered.issues {
                let existing = ticket_for_identity(transaction, &issue.reference.identity)?;
                let replaced_config = replaced.contains(&issue.reference.identity.provider);
                if replaced_config && existing.is_none() {
                    continue;
                }
                if !issue_can_refresh(
                    transaction,
                    issue,
                    &gathered.partitions,
                    source_id,
                    replaced_config,
                )? {
                    continue;
                }
                let key = (
                    issue.reference.identity.provider.clone(),
                    issue.reference.identity.id.clone(),
                );
                // Only discovery brings in an issue that is not here yet.
                let first_import =
                    gathered.partitions.get(&key).is_some_and(|part| {
                        !read_before
                            .get(key.0.as_str())
                            .is_some_and(|read| read.contains(part))
                    }) && ticket_for_identity(transaction, &issue.reference.identity)?.is_none();
                crate::events::set_actor(
                    transaction,
                    Some(if first_import {
                        crate::events::Acting::Silent
                    } else {
                        crate::events::Acting::Sync
                    }),
                )?;
                apply_issue(
                    transaction,
                    issue,
                    gathered.conversations.get(&key),
                    now,
                    &mut applied,
                )?;
                if let Some(source_id) = source_id
                    && !replaced_config
                    && gathered.partitions.contains_key(&key)
                    && let Some(ticket_id) =
                        ticket_for_identity(transaction, &issue.reference.identity)?
                {
                    super::bind_ticket(transaction, &ticket_id, source_id)?;
                }
            }
            crate::events::set_actor(transaction, own_actor)?;
            for (provider, seen) in &gathered.discovery {
                if replaced.contains(provider) {
                    continue;
                }
                let mut statement = transaction.prepare("SELECT i.ticket_id, i.external_id, i.locator, i.partition FROM external_identities i JOIN external_ownership o ON o.ticket_id = i.ticket_id WHERE i.provider = ?1 AND o.authority = 'external'")?;
                let identities = statement
                    .query_map([provider], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                for (id, external_id, locator, part) in identities {
                    let part = part
                        .or_else(|| super::legacy_reference_partition(provider, &locator))
                        .unwrap_or_default();
                    if super::selected_connection(transaction, &id, provider, &part)?.as_deref()
                        != source_id
                    {
                        continue;
                    }
                    transaction.execute("UPDATE source_sync SET discovery_matches = ?2 WHERE ticket_id = ?1 AND (last_attempt_at IS NULL OR last_attempt_at <= ?3)", params![id, seen.contains(&external_id), now])?;
                }
            }
            let by_reference: HashMap<&str, &Tracked> =
                tracked.iter().map(|t| (t.reference.as_str(), t)).collect();
            let mut failures = Vec::new();
            for found in &gathered.failures {
                if replaced.contains(&found.provider) {
                    continue;
                }
                let ticket = found.reference.as_deref().and_then(|r| by_reference.get(r));
                if let Some(ticket) = ticket {
                    if super::selected_connection(
                        transaction,
                        &ticket.ticket_id,
                        &ticket.provider,
                        &ticket.partition,
                    )?
                    .as_deref()
                        != source_id
                    {
                        continue;
                    }
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
                            if FailureCode::parse(&found.failure.code)
                                .is_some_and(FailureCode::is_unavailable)
                            {
                                let first: bool = transaction.query_row("SELECT failing_since IS NULL AND (last_refreshed_at IS NULL OR last_refreshed_at <= ?2) FROM source_sync WHERE ticket_id = ?1", params![ticket.ticket_id, now], |row| row.get(0))?;
                                if first {
                                    history::record(
                                        transaction,
                                        &ticket.ticket_id,
                                        "source_unavailable",
                                        "",
                                        &found.failure.code,
                                        Some(&found.provider),
                                    )?;
                                }
                            }
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
                    connection_id: source_id.map(str::to_owned),
                    reference: found.reference.clone(),
                    code: found.failure.code.clone(),
                    message: found.failure.message.clone(),
                    retry_after_secs: (found.failure.code == FailureCode::RateLimited.as_str())
                        .then(|| gathered.retry_limit.as_ref().map(|(_, seconds)| *seconds))
                        .flatten(),
                    scope: found.scope,
                });
            }
            for run in &gathered.runs {
                if replaced.contains(&run.provider) {
                    continue;
                }
                let none = HashSet::new();
                let read = read_before.get(run.provider.as_str()).unwrap_or(&none);
                freshness::record_run(transaction, run, read, now)?;
            }
            if let (Some(id), Some((received, seconds))) = (source_id, gathered.retry_limit)
                && replaced.is_empty()
            {
                freshness::record_hold(transaction, id, &received, seconds)?;
            }
            Ok(RefreshReport {
                imported: applied.imported,
                updated: applied.updated,
                unchanged: applied.unchanged,
                failures,
                refreshed_at: now.to_owned(),
            })
        })
    }
}

/// A tracked ticket as the refresh write reads it back.
struct Existing {
    id: String,
    reference: String,
    title: String,
    body: String,
    status: Status,
    authority: Option<String>,
    locator: String,
    partition: Option<String>,
    display: String,
    url: String,
    state_category: Option<String>,
    state_name: Option<String>,
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
            "SELECT t.id, t.reference, t.title, t.body, t.status, o.authority, i.locator, i.display, i.url, \
                    s.state_category, s.state_name, \
                    COALESCE(s.external_updated_at, ''), i.partition \
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
                    reference: row.get(1)?,
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
                    state_category: row.get(9)?,
                    state_name: row.get(10)?,
                    updated_at: row.get(11)?,
                    partition: row.get(12)?,
                })
            },
        )
        .optional()?;
    // A provider's title may hold line breaks or run very long; the ticket keeps the
    // same one-line, bounded title a person could write (see `imported_title`).
    let imported = crate::ticket_change::imported_title(&issue.title);
    let title = match imported.as_str() {
        "" => issue.display.as_str(),
        title => title,
    };
    let category = issue.state.category;
    match existing {
        None => {
            if super::publication::awaited_by_open_attempt(connection, issue)? {
                return Ok(());
            }
            let status = status_for(None, category, Status::Todo);
            let id = Uuid::new_v4().to_string();
            let reference = crate::device::issue_reference(connection)?;
            connection.execute(
                "INSERT INTO tickets (id, reference, title, status, body) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, reference, title, status.to_string(), issue.body],
            )?;
            crate::document_links::index_external_body(connection, &id, &issue.body)?;
            link(connection, &id, issue, Origin::Imported, now)?;
            history::record(
                connection,
                &id,
                "source_import",
                &status.to_string(),
                &issue.display,
                Some(&issue.reference.identity.provider),
            )?;
            if status == Status::Duplicate {
                set_duplicate_target(connection, &id, issue)?;
            }
            if let Some(read) = read {
                conversation::store(connection, &id, read, &issue.updated_at)?;
            }
            applied.imported.push(reference);
        }
        // Taken over (or otherwise local): the identity is remembered so discovery
        // neither creates another ticket nor resumes synchronization.
        Some(Existing { authority, .. }) if authority.as_deref() != Some("external") => {}
        Some(Existing {
            id,
            reference,
            title: old_title,
            body: old_body,
            status,
            locator,
            partition,
            display,
            url,
            state_category,
            state_name,
            updated_at,
            ..
        }) => {
            // An overlapping run can deliver an observation older than one already
            // applied (the slower of two refreshes). Confirmed source state never
            // moves backwards, and an old observation confirms nothing now.
            let older = match (
                chrono::DateTime::parse_from_rfc3339(&issue.updated_at),
                chrono::DateTime::parse_from_rfc3339(&updated_at),
            ) {
                (Ok(incoming), Ok(current)) => incoming < current,
                (Err(_), Ok(_)) => true,
                (Ok(_), Err(_)) => false,
                (Err(_), Err(_)) => !updated_at.is_empty() && issue.updated_at < updated_at,
            };
            if older {
                return Ok(());
            }
            let previous = state_category.as_deref().map(StateCategory::parse);
            let next = status_for(previous, category, status);
            let mut changed = false;
            if old_title != title || old_body != issue.body {
                connection.execute(
                    "UPDATE tickets SET title = ?2, body = ?3 WHERE id = ?1",
                    params![id, title, issue.body],
                )?;
                crate::document_links::index_external_body(connection, &id, &issue.body)?;
                changed = true;
            }
            if next != status {
                if status == Status::Duplicate {
                    duplicates::clear(connection, &id, Some(&identity.provider))?;
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
            changed |= previous != Some(category) || state_name != issue.state.name;
            let identity_changed =
                locator != issue.reference.locator || display != issue.display || url != issue.url;
            if identity_changed || partition.as_deref() != Some(&issue.reference.partition) {
                connection.execute(
                    "UPDATE external_identities SET locator = ?2, display = ?3, url = ?4, partition = ?5 WHERE ticket_id = ?1",
                    params![id, issue.reference.locator, issue.display, issue.url, issue.reference.partition],
                )?;
                changed |= identity_changed;
            }
            // Who opened the issue and when is provenance, not a change to the
            // ticket; it also fills tickets tracked before it was stored.
            let (author, created_at) = opening(issue);
            connection.execute(
                "UPDATE source_sync SET state_category = ?2, state_name = ?3, external_updated_at = ?4, \
                 last_refreshed_at = ?5, last_attempt_at = ?5, last_error_code = NULL, last_error_message = NULL, failing_since = NULL, \
                 external_author = COALESCE(?6, external_author), external_created_at = COALESCE(?7, external_created_at) \
                 WHERE ticket_id = ?1",
                params![id, category.as_str(), issue.state.name, issue.updated_at, now, author, created_at],
            )?;
            super::cache_ticket_presentation(connection, &id, &identity.provider)?;
            if let Some(read) = read {
                changed |= conversation::store(connection, &id, read, &issue.updated_at)?;
                connection.execute(
                    "UPDATE source_sync SET conversation_error_code = NULL, conversation_error_message = NULL WHERE ticket_id = ?1",
                    [&id],
                )?;
            }
            if changed {
                applied.updated.push(reference);
            } else {
                applied.unchanged += 1;
            }
        }
    }
    Ok(())
}

/// Records the canonical issue of an externally closed duplicate, with a history
/// row whenever what is shown changes. It never invents a local link.
///
/// - A named target replaces the stored one (a target naming the issue itself is
///   not a canonical issue and counts as unnamed).
/// - A definite withdrawal clears it to an explicit unknown.
/// - A missing answer (a failed lookup, lost access) keeps the last known target
///   and marks it `last_known`, so it is never shown as confirmed.
///
/// Returns whether the stored target changed.
fn set_duplicate_target(
    connection: &Connection,
    id: &str,
    issue: &ExternalIssue,
) -> Result<bool, Error> {
    type Stored = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
    );
    let named = issue
        .duplicate_of
        .as_ref()
        .filter(|target| target.identity != issue.reference.identity);
    let stored: Option<Stored> = connection
        .query_row(
            "SELECT provider, external_id, locator, url, last_known FROM external_duplicate_targets WHERE ticket_id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let stored_display = stored
        .as_ref()
        .and_then(|(_, _, locator, _, _)| locator.clone())
        .unwrap_or_default();
    let record = |to: &str| {
        history::record(
            connection,
            id,
            "external_duplicate",
            &stored_display,
            to,
            Some(&issue.reference.identity.provider),
        )
    };
    match (named, issue.duplicate_withdrawn) {
        (Some(target), _) => {
            let wanted: Stored = (
                Some(target.identity.provider.clone()),
                Some(target.identity.id.clone()),
                Some(target.locator.clone()),
                issue.duplicate_of_url.clone(),
                false,
            );
            if stored.as_ref() == Some(&wanted) {
                return Ok(false);
            }
            connection.execute(
                "INSERT INTO external_duplicate_targets (ticket_id, provider, external_id, locator, display, url, last_known) \
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, 0) \
                 ON CONFLICT(ticket_id) DO UPDATE SET provider = excluded.provider, external_id = excluded.external_id, locator = excluded.locator, display = excluded.display, url = excluded.url, last_known = 0",
                params![id, target.identity.provider, target.identity.id, target.locator, issue.duplicate_of_url],
            )?;
            if stored_display != target.locator {
                record(&target.locator)?;
            }
            Ok(true)
        }
        (None, true) => {
            if matches!(&stored, Some((None, None, ..))) {
                return Ok(false);
            }
            connection.execute(
                "INSERT INTO external_duplicate_targets (ticket_id) VALUES (?1) \
                 ON CONFLICT(ticket_id) DO UPDATE SET provider = NULL, external_id = NULL, locator = NULL, display = NULL, url = NULL, last_known = 0",
                [id],
            )?;
            if !stored_display.is_empty() {
                record("")?;
            }
            Ok(true)
        }
        (None, false) => match stored {
            None => {
                connection.execute(
                    "INSERT INTO external_duplicate_targets (ticket_id) VALUES (?1)",
                    [id],
                )?;
                Ok(true)
            }
            // A named target we hold stays, now flagged as not re-confirmed.
            Some((Some(_), Some(_), _, _, false)) => {
                connection.execute(
                    "UPDATE external_duplicate_targets SET last_known = 1 WHERE ticket_id = ?1",
                    [id],
                )?;
                Ok(true)
            }
            Some(_) => Ok(false),
        },
    }
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
    let next = status_for(Some(StateCategory::Open), issue.state.category, current);
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
    let category = issue.state.category;
    connection.execute(
        "INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, linked_at, partition) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
            now,
            issue.reference.partition,
        ],
    )?;
    super::cache_ticket_presentation(connection, ticket_id, &identity.provider)?;
    connection.execute(
        "INSERT INTO external_ownership (ticket_id, authority, changed_at) VALUES (?1, 'external', ?2)",
        params![ticket_id, now],
    )?;
    let (author, created_at) = opening(issue);
    connection.execute(
        "INSERT INTO source_sync (ticket_id, state_category, state_name, external_updated_at, last_refreshed_at, last_attempt_at, external_author, external_created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)",
        params![ticket_id, category.as_str(), issue.state.name, issue.updated_at, now, author, created_at],
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
