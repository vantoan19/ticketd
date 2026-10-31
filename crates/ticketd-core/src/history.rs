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
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Todo => "Todo",
            Self::InProgress => "In progress",
            Self::InReview => "In review",
            Self::Done => "Done",
            Self::Canceled => "Canceled",
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
    if kind == "status" || kind == "relationship:duplicate" {
        crate::inbox::record(transaction, ticket_id, kind, from, to)?;
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
