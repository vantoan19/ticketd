//! Freshness and availability of synchronized sources.
//!
//! Two facts are persisted so a restart or an offline launch tells the truth:
//!
//! - per ticket, `source_sync.failing_since`: the time of the first failed
//!   attempt in the current streak (NULL once a refresh confirms the ticket);
//! - per provider, `source_status`: the last run's attempt time, last success,
//!   current error and streak start, and the earliest time the source asked to
//!   be contacted again (rate limit). This exists even when no ticket is
//!   tracked yet, so a failed first discovery is not mistaken for "nothing
//!   matched".
//!
//! # Source unavailable
//!
//! An externally owned ticket is *Source unavailable* exactly when its latest
//! recorded refresh attempt failed with a code for which
//! [`FailureCode::is_unavailable`] is true, and it stays so until a later attempt confirms the ticket. The state
//! is derived from `source_sync.last_error_code` and is never stored as its own
//! flag, so it cannot drift from the error that caused it. It never changes the
//! ticket's content, status or ownership, and it has no grace period.
//! A rate limit is *delayed*, not unavailable.

use std::collections::{BTreeSet, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{FailureScope, RefreshFailure, SourceFailure, contract::FailureCode};
use crate::{Error, Workspace};

/// Used when a rate-limited source does not say how long to wait.
pub(super) const DEFAULT_RATE_LIMIT_SECS: u64 = 300;

/// Why and since when a ticket cannot be refreshed. Present only while it can't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceUnavailable {
    pub code: String,
    pub message: String,
    /// When the first failed attempt of the current streak happened.
    pub since: String,
}

/// How a source is doing, decided here so clients only choose the wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceHealth {
    /// No refresh has run yet.
    Waiting,
    /// The last run read the source and every tracked ticket.
    Synced,
    /// The source asked to be contacted later (rate limiting).
    Delayed,
    /// The last run could not read the source as a whole.
    Unavailable,
    /// The source was read, but some tickets or some of the discovery rules
    /// (a repository) could not be.
    Partial,
}

/// The last refresh outcome of one source, as persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceStatus {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub health: SourceHealth,
    pub last_attempt_at: Option<String>,
    /// The last run in which the source could be read.
    pub last_refreshed_at: Option<String>,
    /// Unique issues checked in the last accepted whole-provider read. Unknown
    /// for older workspaces or until the first successful or partial run.
    #[serde(default)]
    pub last_checked_tickets: Option<u32>,
    /// Tickets currently owned by this source, including tickets in the trash.
    #[serde(default)]
    pub tracked_tickets: u32,
    /// Why the last run could not read the source, if it could not.
    pub error: Option<SourceFailure>,
    /// When the current streak of failed runs began.
    pub failing_since: Option<String>,
    /// The earliest time the source asked to be contacted again.
    pub retry_after: Option<String>,
    /// Tracked tickets that currently read Source unavailable.
    pub unavailable_tickets: u32,
    /// The parts of the discovery rules the last run could not read, when it
    /// read the rest.
    pub partial_message: Option<String>,
}

/// Step 25: the failure streak per ticket and the per-source status.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "ALTER TABLE source_sync ADD COLUMN failing_since TEXT; \
         CREATE TABLE source_status (\
            provider TEXT PRIMARY KEY, \
            last_attempt_at TEXT, \
            last_refreshed_at TEXT, \
            error_code TEXT, \
            error_message TEXT, \
            failing_since TEXT, \
            retry_after TEXT);",
    )?;
    Ok(())
}

pub(crate) fn migrate_run_counts(connection: &Connection) -> Result<(), Error> {
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('source_status') WHERE name = 'last_checked_tickets')",
        [],
        |row| row.get(0),
    )?;
    if !present {
        connection
            .execute_batch("ALTER TABLE source_status ADD COLUMN last_checked_tickets INTEGER")?;
    }
    Ok(())
}

/// Format version 82: `read_partitions`, the parts of a source (for GitHub, its
/// repositories) that have been read, as a JSON list, so the first read of each
/// can be told from the ones that follow. NULL for a source last read before
/// this was kept; [`read_partitions`] says what counts as read then. It replaces
/// `refreshed_configuration`, which only unreleased builds kept.
pub(crate) fn migrate_read_partitions(connection: &Connection) -> Result<(), Error> {
    let has = |column: &str| {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('source_status') WHERE name = ?1)",
            [column],
            |row| row.get::<_, bool>(0),
        )
    };
    if has("refreshed_configuration")? {
        connection
            .execute_batch("ALTER TABLE source_status DROP COLUMN refreshed_configuration")?;
    }
    if !has("read_partitions")? {
        connection.execute_batch("ALTER TABLE source_status ADD COLUMN read_partitions TEXT")?;
    }
    Ok(())
}

/// The parts of `provider` that have been read. For a source read before they
/// were kept, those are the parts tickets were already imported from
/// (`imported`): a part nothing came from is read again as if for the first time.
pub(crate) fn read_partitions(
    connection: &Connection,
    connection_id: &str,
    imported: Option<&HashSet<String>>,
) -> Result<HashSet<String>, Error> {
    let stored: Option<(Option<String>, bool)> = connection
        .query_row(
            "SELECT read_partitions, last_refreshed_at IS NOT NULL FROM source_connection_status WHERE connection_id = ?1",
            [connection_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match stored {
        Some((Some(kept), _)) => serde_json::from_str(&kept)?,
        Some((None, true)) => imported.cloned().unwrap_or_default(),
        Some((None, false)) | None => HashSet::new(),
    })
}

/// What one provider's run found, for [`record_run`].
pub(crate) struct ProviderRun {
    pub provider: String,
    pub connection_id: String,
    pub failure: Option<SourceFailure>,
    pub retry_after_secs: Option<u64>,
    /// Discovery rules the run skipped because they could not be read.
    pub skipped: Vec<String>,
    /// The parts of the source the run read in full, and the ones it skipped.
    pub read_partitions: Vec<String>,
    pub skipped_partitions: Vec<String>,
    pub checked_tickets: u32,
}

/// Records each provider's run in the refresh write transaction. A run that
/// started before the one already recorded is older news and changes nothing.
/// A successful run leaves as read the parts it read, and the parts it skipped
/// that `read_before` holds: a part that cannot be read for a while stays read,
/// one that was never read stays unread, and one no longer asked for is
/// forgotten, so adding it again is a first read again.
pub(crate) fn record_run(
    connection: &Connection,
    run: &ProviderRun,
    read_before: &HashSet<String>,
    now: &str,
) -> Result<(), Error> {
    match &run.failure {
        None => {
            let read: BTreeSet<&String> = run
                .read_partitions
                .iter()
                .chain(
                    run.skipped_partitions
                        .iter()
                        .filter(|part| read_before.contains(*part)),
                )
                .collect();
            let read = serde_json::to_string(&read)?;
            let partial = (!run.skipped.is_empty()).then(|| run.skipped.join("; "));
            connection.execute(
                "INSERT INTO source_connection_status (connection_id, last_attempt_at, last_refreshed_at, partial_message, last_checked_tickets, read_partitions) VALUES (?1, ?2, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(connection_id) DO UPDATE SET last_attempt_at = ?2, last_refreshed_at = ?2, \
                 error_code = NULL, error_message = NULL, failing_since = NULL, retry_after = NULL, partial_message = ?3, last_checked_tickets = ?4, \
                 read_partitions = ?5 \
                 WHERE source_connection_status.last_attempt_at IS NULL OR source_connection_status.last_attempt_at <= ?2",
                params![run.connection_id, now, partial, run.checked_tickets, read],
            )?;
        }
        Some(failure) => {
            let retry = (FailureCode::parse(&failure.code) == Some(FailureCode::RateLimited))
                .then(|| run.retry_after_secs.unwrap_or(DEFAULT_RATE_LIMIT_SECS));
            connection.execute(
                "INSERT INTO source_connection_status (connection_id, last_attempt_at, error_code, error_message, failing_since, retry_after) \
                 VALUES (?1, ?2, ?3, ?4, ?2, CASE WHEN ?5 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || ?5 || ' seconds') END) \
                 ON CONFLICT(connection_id) DO UPDATE SET last_attempt_at = ?2, error_code = ?3, error_message = ?4, \
                 failing_since = COALESCE(failing_since, ?2), partial_message = NULL, \
                 retry_after = CASE WHEN ?5 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || ?5 || ' seconds') END \
                 WHERE source_connection_status.last_attempt_at IS NULL OR source_connection_status.last_attempt_at <= ?2",
                params![run.connection_id, now, failure.code, failure.message, retry],
            )?;
        }
    }
    Ok(())
}

pub(super) fn record_hold(
    connection: &Connection,
    id: &str,
    now: &str,
    seconds: u64,
) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO source_connection_status (connection_id, retry_after)
         VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || ?3 || ' seconds'))
         ON CONFLICT(connection_id) DO UPDATE SET retry_after = excluded.retry_after
         WHERE retry_after IS NULL OR retry_after < excluded.retry_after",
        params![id, now, seconds],
    )?;
    Ok(())
}

impl super::RefreshReport {
    /// The source could not be read as a whole (discovery failed, it is unreachable,
    /// rate limiting, or rejecting credentials), as opposed to single issues that
    /// are gone or inaccessible. Schedulers back off on this and not on the latter.
    pub fn interrupted_by_source(&self) -> bool {
        self.failures.iter().any(RefreshFailure::interrupts)
    }

    /// The longest wait a rate-limited source asked for, in seconds.
    pub fn retry_after_secs(&self) -> Option<u64> {
        self.failures
            .iter()
            .filter_map(|f| f.retry_after_secs)
            .max()
    }
}

impl RefreshFailure {
    pub(super) fn interrupts(&self) -> bool {
        match self.scope {
            FailureScope::Source => true,
            FailureScope::Ticket => {
                // An unknown code is not trusted to be harmless.
                FailureCode::parse(&self.code).is_none_or(FailureCode::interrupts_source)
            }
            FailureScope::Partition | FailureScope::Conversation => false,
        }
    }
}

fn health_of(
    error: Option<&SourceFailure>,
    attempted: bool,
    unavailable_tickets: u32,
    partial: bool,
) -> SourceHealth {
    match error {
        Some(failure) if FailureCode::parse(&failure.code) == Some(FailureCode::RateLimited) => {
            SourceHealth::Delayed
        }
        Some(_) => SourceHealth::Unavailable,
        None if !attempted => SourceHealth::Waiting,
        None if unavailable_tickets > 0 || partial => SourceHealth::Partial,
        None => SourceHealth::Synced,
    }
}

impl Workspace {
    /// Each saved or previously run source's persisted status, by provider.
    pub fn source_statuses(&self) -> Result<Vec<SourceStatus>, Error> {
        self.read(Self::read_source_statuses)
    }

    fn read_source_statuses(&self) -> Result<Vec<SourceStatus>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT c.provider, s.last_attempt_at, s.last_refreshed_at, s.error_code, s.error_message,
                    s.failing_since, s.retry_after, s.partial_message, s.last_checked_tickets, c.id
             FROM source_connections c LEFT JOIN source_connection_status s ON s.connection_id = c.id
             UNION ALL
             SELECT p.provider, s.last_attempt_at, s.last_refreshed_at, s.error_code, s.error_message,
                    s.failing_since, s.retry_after, s.partial_message, s.last_checked_tickets, NULL
             FROM (SELECT provider FROM source_status UNION SELECT provider FROM external_identities) p
             LEFT JOIN source_status s ON s.provider = p.provider
             WHERE NOT EXISTS (SELECT 1 FROM source_connections c WHERE c.provider = p.provider)
             ORDER BY 1, 10",
        )?;
        let sources = super::configured_sources(&self.connection)?;
        let mut counts = std::collections::HashMap::<(String, Option<String>), (u32, u32)>::new();
        for ticket in super::tracking::tracked(&self.connection, None)? {
            let id = ticket
                .connection(&sources)
                .map(|source| source.saved.id.clone());
            let count = counts.entry((ticket.provider, id.clone())).or_default();
            count.0 += 1;
            if id.is_none()
                || ticket
                    .error_code
                    .as_deref()
                    .and_then(FailureCode::parse)
                    .is_some_and(|code| code != FailureCode::NotConfigured && code.is_unavailable())
            {
                count.1 += 1;
            }
        }
        let rows = statement
            .query_map([], |row| {
                let code: Option<String> = row.get(3)?;
                let message: Option<String> = row.get(4)?;
                let attempted: Option<String> = row.get(1)?;
                let provider: String = row.get(0)?;
                let connection_id: Option<String> = row.get(9)?;
                let (tracked_tickets, unavailable_tickets) = counts
                    .get(&(provider.clone(), connection_id.clone()))
                    .copied()
                    .unwrap_or_default();
                let partial_message: Option<String> = row.get(7)?;
                let error = code.map(|code| SourceFailure {
                    code,
                    message: message.unwrap_or_default(),
                });
                Ok(SourceStatus {
                    provider,
                    connection_id,
                    health: health_of(
                        error.as_ref(),
                        attempted.is_some(),
                        unavailable_tickets,
                        partial_message.is_some(),
                    ),
                    last_attempt_at: attempted,
                    last_refreshed_at: row.get(2)?,
                    last_checked_tickets: row.get(8)?,
                    tracked_tickets,
                    error,
                    failing_since: row.get(5)?,
                    retry_after: row.get(6)?,
                    unavailable_tickets,
                    partial_message,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The latest time, in seconds since the Unix epoch, before which any source
    /// asked not to be contacted again. `None` when no hold is recorded.
    pub fn source_hold_until(&self) -> Result<Option<u64>, Error> {
        let epoch: Option<i64> = self.connection.query_row(
            "SELECT MAX(CAST(strftime('%s', retry_after) AS INTEGER)) FROM source_connection_status WHERE retry_after IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(epoch.and_then(|seconds| u64::try_from(seconds).ok()))
    }
}
