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
//! recorded refresh attempt failed with a code for which [`is_unavailable_code`]
//! is true, and it stays so until a later attempt confirms the ticket. The state
//! is derived from `source_sync.last_error_code` and is never stored as its own
//! flag, so it cannot drift from the error that caused it. It never changes the
//! ticket's content, status, ownership or history, and it has no grace period.
//! A rate limit is *delayed*, not unavailable.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::{RefreshFailure, SourceFailure};
use crate::{Error, Workspace};

/// Used when a rate-limited source does not say how long to wait.
pub const DEFAULT_RATE_LIMIT_SECS: u64 = 300;

/// Failure codes after which a ticket reads Source unavailable: the source cannot
/// be reached, rejected the credential, denied access, no longer has the issue,
/// answered with something unusable, or is not configured.
pub fn is_unavailable_code(code: &str) -> bool {
    matches!(
        code,
        "unavailable"
            | "unauthenticated"
            | "forbidden"
            | "not_found"
            | "protocol"
            | "not_configured"
    )
}

/// Why and since when a ticket cannot be refreshed. Present only while it can't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceUnavailable {
    pub code: String,
    pub message: String,
    /// When the first failed attempt of the current streak happened.
    pub since: String,
}

/// The last refresh outcome of one source, as persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceStatus {
    pub provider: String,
    pub last_attempt_at: Option<String>,
    /// The last run in which the source could be read.
    pub last_refreshed_at: Option<String>,
    /// Why the last run could not read the source, if it could not.
    pub error: Option<SourceFailure>,
    /// When the current streak of failed runs began.
    pub failing_since: Option<String>,
    /// The earliest time the source asked to be contacted again.
    pub retry_after: Option<String>,
    /// Tracked tickets that currently read Source unavailable.
    pub unavailable_tickets: u32,
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
            retry_after TEXT); \
         PRAGMA user_version = 25;",
    )?;
    Ok(())
}

/// What one provider's run found, for [`record_run`].
pub(crate) struct ProviderRun {
    pub provider: String,
    pub failure: Option<SourceFailure>,
    pub retry_after_secs: Option<u64>,
}

/// Records each provider's run in the refresh write transaction.
pub(crate) fn record_run(
    connection: &Connection,
    run: &ProviderRun,
    now: &str,
) -> Result<(), Error> {
    match &run.failure {
        None => {
            connection.execute(
                "INSERT INTO source_status (provider, last_attempt_at, last_refreshed_at) VALUES (?1, ?2, ?2) \
                 ON CONFLICT(provider) DO UPDATE SET last_attempt_at = ?2, last_refreshed_at = ?2, \
                 error_code = NULL, error_message = NULL, failing_since = NULL, retry_after = NULL",
                params![run.provider, now],
            )?;
        }
        Some(failure) => {
            let retry = (failure.code == "rate_limited")
                .then(|| run.retry_after_secs.unwrap_or(DEFAULT_RATE_LIMIT_SECS));
            connection.execute(
                "INSERT INTO source_status (provider, last_attempt_at, error_code, error_message, failing_since, retry_after) \
                 VALUES (?1, ?2, ?3, ?4, ?2, CASE WHEN ?5 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || ?5 || ' seconds') END) \
                 ON CONFLICT(provider) DO UPDATE SET last_attempt_at = ?2, error_code = ?3, error_message = ?4, \
                 failing_since = COALESCE(failing_since, ?2), \
                 retry_after = CASE WHEN ?5 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || ?5 || ' seconds') END",
                params![run.provider, now, failure.code, failure.message, retry],
            )?;
        }
    }
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
    fn interrupts(&self) -> bool {
        self.reference.is_none()
            || matches!(
                self.code.as_str(),
                "rate_limited" | "unavailable" | "unauthenticated" | "protocol"
            )
    }
}

impl Workspace {
    /// Each saved or previously run source's persisted status, by provider.
    pub fn source_statuses(&self) -> Result<Vec<SourceStatus>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT p.provider, s.last_attempt_at, s.last_refreshed_at, s.error_code, s.error_message, \
                    s.failing_since, s.retry_after, \
                    (SELECT COUNT(*) FROM external_identities i \
                       JOIN external_ownership o ON o.ticket_id = i.ticket_id AND o.authority = 'external' \
                       JOIN source_sync y ON y.ticket_id = i.ticket_id \
                      WHERE i.provider = p.provider AND y.last_error_code IN \
                       ('unavailable','unauthenticated','forbidden','not_found','protocol','not_configured')) \
             FROM (SELECT provider FROM source_configurations UNION SELECT provider FROM source_status \
                   UNION SELECT provider FROM external_identities) p \
             LEFT JOIN source_status s ON s.provider = p.provider \
             ORDER BY p.provider",
        )?;
        let rows = statement
            .query_map([], |row| {
                let code: Option<String> = row.get(3)?;
                let message: Option<String> = row.get(4)?;
                Ok(SourceStatus {
                    provider: row.get(0)?,
                    last_attempt_at: row.get(1)?,
                    last_refreshed_at: row.get(2)?,
                    error: code.map(|code| SourceFailure {
                        code,
                        message: message.unwrap_or_default(),
                    }),
                    failing_since: row.get(5)?,
                    retry_after: row.get(6)?,
                    unavailable_tickets: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The latest time, in seconds since the Unix epoch, before which any source
    /// asked not to be contacted again. `None` when no hold is recorded.
    pub fn source_hold_until(&self) -> Result<Option<u64>, Error> {
        let epoch: Option<i64> = self.connection.query_row(
            "SELECT MAX(CAST(strftime('%s', retry_after) AS INTEGER)) FROM source_status WHERE retry_after IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(epoch.and_then(|seconds| u64::try_from(seconds).ok()))
    }
}
