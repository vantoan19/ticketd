//! Ready and Blocked: the one place that decides whether a ticket can be picked up.
//!
//! A ticket is Ready when it is Todo, not in the trash, not held by its source, and every
//! blocking dependency is Done. It is Blocked under the same conditions except that some
//! blocker is not Done. Every other ticket (started, finished, trashed, or held) has
//! neither indicator. A ticket is held when its source closed the issue for a reason
//! ticketd does not recognize, so it awaits a local decision.
//!
//! Two shapes share the rule, and tests drive both through the workspace:
//!
//! - [`of`] judges one ticket on a connection, and [`judge`] judges facts already in memory
//!   (the duplicate review evaluates hypothetical statuses);
//! - [`ready_sql`], [`blocked_sql`] and [`indicator_sql`] build SQL for set queries
//!   (filters, counts, graph nodes) so they need no per-row query.
//!
//! The external text of the indicator, "Ready" or "Blocked", is written only here.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{Error, Status};

const READY: &str = "Ready";
const BLOCKED: &str = "Blocked";

/// Whether a ticket can be picked up now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    /// Todo with every blocker Done.
    Ready,
    /// Todo with an unresolved blocker.
    Blocked,
    /// Started, finished, in the trash, or held by its source: no Ready or Blocked
    /// indicator, matching the Ready list.
    NoReadyState,
}

impl Readiness {
    /// The indicator shown to people and sent over the bridge: "Ready", "Blocked" or none.
    pub(crate) fn indicator(self) -> Option<String> {
        match self {
            Self::Ready => Some(READY.into()),
            Self::Blocked => Some(BLOCKED.into()),
            Self::NoReadyState => None,
        }
    }
}

/// Whether a blocker with this status is still unresolved. Only Done resolves one; In review,
/// Canceled and Duplicate blockers stay unresolved until the relationship is removed.
pub(crate) fn unresolved(blocker: Status) -> bool {
    !blocker.satisfies_dependency()
}

/// The blockers, by reference, that are unresolved.
pub(crate) fn unresolved_blockers(
    blockers: impl IntoIterator<Item = (String, Status)>,
) -> Vec<String> {
    blockers
        .into_iter()
        .filter(|(_, status)| unresolved(*status))
        .map(|(reference, _)| reference)
        .collect()
}

/// The rule, given a ticket's facts and the statuses of its blockers.
pub(crate) fn judge(
    status: Status,
    trashed: bool,
    held: bool,
    blockers: impl IntoIterator<Item = Status>,
) -> Readiness {
    if trashed || held || status != Status::Todo {
        Readiness::NoReadyState
    } else if blockers.into_iter().any(unresolved) {
        Readiness::Blocked
    } else {
        Readiness::Ready
    }
}

/// The readiness of the ticket `id`, read from the connection's current state.
pub(crate) fn of(connection: &Connection, id: &str) -> Result<Readiness, Error> {
    let (status, trashed, held): (String, bool, bool) = connection
        .prepare_cached(&format!(
            "SELECT t.status, t.trashed, {} FROM tickets t WHERE t.id = ?1",
            crate::source::held_sql("t.id")
        ))?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    let status: Status = status.parse()?;
    if trashed || held || status != Status::Todo {
        return Ok(Readiness::NoReadyState);
    }
    let mut statement = connection.prepare_cached(
        "SELECT b.status FROM dependencies d JOIN tickets b ON b.id = d.blocker_id WHERE d.dependent_id = ?1",
    )?;
    let blockers = statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|blocker| blocker.parse::<Status>())
        .collect::<Result<Vec<_>, _>>()?;
    Ok(judge(status, trashed, held, blockers))
}

/// The indicator of the ticket `id`: see [`Readiness::indicator`].
pub(crate) fn indicator(connection: &Connection, id: &str) -> Result<Option<String>, Error> {
    Ok(of(connection, id)?.indicator())
}

/// SQL that is true for a ticket, named by its table `alias`, that is Todo, not in the
/// trash and not held: the tickets that have a Ready or Blocked indicator at all.
fn has_indicator_sql(alias: &str) -> String {
    format!(
        "({alias}.status = '{}' AND {alias}.trashed = 0 AND NOT {})",
        Status::Todo,
        crate::source::held_sql(&format!("{alias}.id"))
    )
}

/// SQL that is true when the ticket named by `alias` has a blocker that is unresolved.
fn has_unresolved_blocker_sql(alias: &str) -> String {
    let resolving: Vec<String> = Status::ALL
        .into_iter()
        .filter(|status| !unresolved(*status))
        .map(|status| format!("'{status}'"))
        .collect();
    format!(
        "EXISTS (SELECT 1 FROM dependencies rd JOIN tickets rb ON rb.id = rd.blocker_id \
         WHERE rd.dependent_id = {alias}.id AND rb.status NOT IN ({}))",
        resolving.join(", ")
    )
}

/// SQL that is true for a Ready ticket named by its table `alias`.
pub(crate) fn ready_sql(alias: &str) -> String {
    format!(
        "({} AND NOT {})",
        has_indicator_sql(alias),
        has_unresolved_blocker_sql(alias)
    )
}

/// SQL that is true for a Blocked ticket named by its table `alias`.
pub(crate) fn blocked_sql(alias: &str) -> String {
    format!(
        "({} AND {})",
        has_indicator_sql(alias),
        has_unresolved_blocker_sql(alias)
    )
}

/// SQL for the indicator text of the ticket named by `alias`: 'Ready', 'Blocked' or NULL.
pub(crate) fn indicator_sql(alias: &str) -> String {
    format!(
        "CASE WHEN {} THEN '{READY}' WHEN {} THEN '{BLOCKED}' END",
        ready_sql(alias),
        blocked_sql(alias)
    )
}
