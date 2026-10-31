//! Shared ticket workflows for the desktop and CLI.
mod tags;

use std::{path::Path, time::Duration};

use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("tag name must not be empty")]
    EmptyTag,
    #[error("ticket title must not be empty")]
    EmptyTitle,
    #[error("ticket '{0}' was not found")]
    NotFound(String),
    #[error("could not determine the application data directory")]
    NoDataDirectory,
    #[error("could not access workspace directory: {0}")]
    Directory(#[from] std::io::Error),
    #[error("workspace database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("workspace schema version {0} is newer than this application supports")]
    NewerSchema(i64),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    pub reference: String,
    pub title: String,
    pub status: String,
    pub tags: Vec<String>,
}

pub struct Workspace {
    connection: Connection,
}

impl Workspace {
    pub fn open_default() -> Result<Self, Error> {
        let dirs = ProjectDirs::from("", "", "ticketd").ok_or(Error::NoDataDirectory)?;
        std::fs::create_dir_all(dirs.data_dir())?;
        Self::open(dirs.data_dir().join("workspace.sqlite3"))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(10))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let version: i64 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 2 {
            return Err(Error::NewerSchema(version));
        }
        if version == 0 {
            transaction.execute_batch("CREATE TABLE tickets (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL); PRAGMA user_version = 1;")?;
        }
        if version < 2 {
            tags::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 2)?;
        }
        transaction.commit()?;
        Ok(Self { connection })
    }

    pub fn create_ticket(&mut self, title: &str) -> Result<Ticket, Error> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::EmptyTitle);
        }
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO tickets (id, title, status) VALUES (?1, ?2, 'Todo')",
            params![id, title],
        )?;
        Ok(Ticket {
            id,
            reference: format!("T-{}", self.connection.last_insert_rowid()),
            title: title.to_owned(),
            status: "Todo".to_owned(),
            tags: Vec::new(),
        })
    }

    pub fn list_tickets(&self) -> Result<Vec<Ticket>, Error> {
        let mut statement = self
            .connection
            .prepare("SELECT id, number, title, status FROM tickets ORDER BY number DESC")?;
        let mut tickets = statement
            .query_map([], ticket_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for ticket in &mut tickets {
            ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
        }
        Ok(tickets)
    }

    pub fn show_ticket(&self, reference: &str) -> Result<Ticket, Error> {
        let number = reference
            .strip_prefix("T-")
            .and_then(|value| value.parse::<i64>().ok());
        let ticket = self
            .connection
            .query_row(
                "SELECT id, number, title, status FROM tickets WHERE number = ?1",
                [number],
                ticket_from_row,
            )
            .optional()?;
        let mut ticket = ticket.ok_or_else(|| Error::NotFound(reference.to_owned()))?;
        ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
        Ok(ticket)
    }
}

fn ticket_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        id: row.get(0)?,
        reference: format!("T-{}", row.get::<_, i64>(1)?),
        title: row.get(2)?,
        status: row.get(3)?,
        tags: Vec::new(),
    })
}
