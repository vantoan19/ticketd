use std::{fmt, str::FromStr};

use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Status {
    Todo,
    #[serde(rename = "In progress")]
    InProgress,
    #[serde(rename = "In review")]
    InReview,
    Done,
    Canceled,
    /// Work that another ticket already covers; always paired with a canonical ticket.
    Duplicate,
}

impl Status {
    pub(crate) const ALL: [Self; 6] = [
        Self::Todo,
        Self::InProgress,
        Self::InReview,
        Self::Done,
        Self::Canceled,
        Self::Duplicate,
    ];

    /// Only Done satisfies a dependency on a ticket; In review, Canceled and Duplicate still block.
    pub fn satisfies_dependency(self) -> bool {
        self == Self::Done
    }

    /// Todo, In progress and In review are the statuses a person may set while an
    /// issue is open at its source, and the only ones that can be published.
    /// Written as an exhaustive match so a new status cannot fall into either side.
    pub fn is_local_progress(self) -> bool {
        match self {
            Self::Todo | Self::InProgress | Self::InReview => true,
            Self::Done | Self::Canceled | Self::Duplicate => false,
        }
    }

    /// Done and Canceled end work on a ticket. The local choices a person has
    /// when the source closed an issue with a reason ticketd does not recognize.
    pub fn ends_work(self) -> bool {
        match self {
            Self::Done | Self::Canceled => true,
            Self::Todo | Self::InProgress | Self::InReview | Self::Duplicate => false,
        }
    }

    /// Position in workflow order: the order work is listed in.
    pub(crate) fn workflow_rank(self) -> u8 {
        match self {
            Self::InProgress => 0,
            Self::InReview => 1,
            Self::Todo => 2,
            Self::Done => 3,
            Self::Canceled => 4,
            Self::Duplicate => 5,
        }
    }

    /// SQL `CASE` ordering a `status` column by [`Self::workflow_rank`].
    pub(crate) fn workflow_order_sql(column: &str) -> String {
        let arms: String = [
            Self::InProgress,
            Self::InReview,
            Self::Todo,
            Self::Done,
            Self::Canceled,
            Self::Duplicate,
        ]
        .into_iter()
        .map(|status| format!(" WHEN '{status}' THEN {}", status.workflow_rank()))
        .collect();
        format!("CASE {column}{arms} END")
    }
}

/// SQL for a blocker, named by its table alias, that does not yet satisfy a
/// dependency. Set-based readiness queries (counts, search, graph) use it; it is
/// the SQL form of [`Status::satisfies_dependency`], which [`readiness`] and
/// [`unresolved_blockers`] use for one ticket held in memory.
pub(crate) fn unresolved_blocker_sql(alias: &str) -> String {
    format!("{alias}.status != 'Done'")
}

/// Whether a ticket can be picked up now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    /// Todo with every blocker Done.
    Ready,
    /// Todo with an unresolved blocker.
    Blocked,
    /// Started, finished, or in the trash: no Ready or Blocked indicator, matching the
    /// Ready list, which leaves trashed tickets out.
    NoReadyState,
}

/// The one in-memory readiness rule, given the statuses of a ticket's blockers.
pub(crate) fn readiness(
    status: Status,
    trashed: bool,
    blockers: impl IntoIterator<Item = Status>,
) -> Readiness {
    if trashed || status != Status::Todo {
        Readiness::NoReadyState
    } else if blockers.into_iter().all(Status::satisfies_dependency) {
        Readiness::Ready
    } else {
        Readiness::Blocked
    }
}

/// The "Ready" or "Blocked" indicator of the ticket `id`, read from its blockers' current
/// statuses through [`readiness`]; none when the ticket has no Ready state.
pub(crate) fn availability(
    connection: &Connection,
    id: &str,
    status: Status,
    trashed: bool,
) -> Result<Option<String>, Error> {
    let unresolved: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM dependencies d JOIN tickets b ON b.id = d.blocker_id WHERE d.dependent_id = ?1 AND b.status <> 'Done')",
        [id], |row| row.get(0),
    )?;
    // A ticket whose issue the source closed for an unrecognized reason awaits a
    // local decision; it is neither Ready nor Blocked.
    if crate::source::closure_held(connection, id)? {
        return Ok(None);
    }
    Ok(
        match readiness(status, trashed, unresolved.then_some(Status::Todo)) {
            Readiness::Ready => Some("Ready".into()),
            Readiness::Blocked => Some("Blocked".into()),
            Readiness::NoReadyState => None,
        },
    )
}

/// The blockers, with their statuses, that do not satisfy a dependency.
pub(crate) fn unresolved_blockers(
    blockers: impl IntoIterator<Item = (String, Status)>,
) -> Vec<String> {
    blockers
        .into_iter()
        .filter(|(_, status)| !status.satisfies_dependency())
        .map(|(reference, _)| reference)
        .collect()
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Todo => "Todo",
            Self::InProgress => "In progress",
            Self::InReview => "In review",
            Self::Done => "Done",
            Self::Canceled => "Canceled",
            Self::Duplicate => "Duplicate",
        })
    }
}

impl FromStr for Status {
    type Err = std::io::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "Todo" => Ok(Self::Todo),
            "In progress" => Ok(Self::InProgress),
            "In review" => Ok(Self::InReview),
            "Done" => Ok(Self::Done),
            "Canceled" => Ok(Self::Canceled),
            "Duplicate" => Ok(Self::Duplicate),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid status: {value}"),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub kind: String,
    pub from_value: String,
    pub to_value: String,
    pub timestamp: String,
    pub editing_agent: Option<String>,
}

pub(crate) fn migrate(transaction: &Transaction<'_>) -> Result<(), Error> {
    transaction.execute_batch("CREATE TABLE ticket_history (number INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, from_value TEXT NOT NULL, to_value TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), editing_agent TEXT); PRAGMA user_version = 3;")?;
    Ok(())
}

pub(crate) fn record(
    transaction: &Connection,
    ticket_id: &str,
    kind: &str,
    from: &str,
    to: &str,
    agent: Option<&str>,
) -> Result<(), Error> {
    transaction.execute("INSERT INTO ticket_history (ticket_id, kind, from_value, to_value, editing_agent) VALUES (?1, ?2, ?3, ?4, ?5)", params![ticket_id, kind, from, to, agent])?;
    if matches!(kind, "status" | "parent" | "dependency") || kind.starts_with("relationship:") {
        crate::inbox::record(transaction, ticket_id, kind, from, to, agent)?;
    }
    Ok(())
}

pub(crate) fn read(connection: &Connection, ticket_id: &str) -> Result<Vec<HistoryEntry>, Error> {
    let mut statement = connection.prepare("SELECT kind, from_value, to_value, timestamp, editing_agent FROM ticket_history WHERE ticket_id = ?1 ORDER BY number")?;
    let entries = statement
        .query_map([ticket_id], |row| {
            Ok(HistoryEntry {
                kind: row.get(0)?,
                from_value: row.get(1)?,
                to_value: row.get(2)?,
                timestamp: row.get(3)?,
                editing_agent: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries)
}
