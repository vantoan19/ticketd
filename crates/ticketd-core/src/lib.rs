//! Shared ticket workflows for the desktop and CLI.
mod efforts;
mod relationships;
mod tags;
pub use efforts::{Effort, EffortCounts, EffortView};

use std::{path::Path, time::Duration};

use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod history;
mod notes;
pub use history::{HistoryEntry, Status};
pub use notes::{Note, NotePatch};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("effort name must not be empty")]
    EmptyEffortName,
    #[error("effort '{0}' was not found")]
    EffortNotFound(String),
    #[error("dependency would create a cycle or self-link")]
    DependencyCycle,
    #[error("tag name must not be empty")]
    EmptyTag,
    #[error("ticket title must not be empty")]
    EmptyTitle,
    #[error("ticket '{0}' was not found")]
    NotFound(String),
    #[error("note '{0}' was not found")]
    NoteNotFound(String),
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
    pub status: Status,
    pub body: String,
    pub tags: Vec<String>,
    pub effort_id: Option<String>,
    pub availability: Option<String>,
    pub prerequisites: Vec<relationships::Prerequisite>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TicketPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub status: Option<Status>,
    pub editing_agent: Option<String>,
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
        if version > 7 {
            return Err(Error::NewerSchema(version));
        }
        if version == 0 {
            transaction.execute_batch("CREATE TABLE tickets (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL); PRAGMA user_version = 1;")?;
        }
        if version < 2 {
            transaction.execute_batch("ALTER TABLE tickets ADD COLUMN body TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 2;")?;
        }
        if version < 3 {
            history::migrate(&transaction)?;
        }
        if version < 4 {
            tags::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 4)?;
        }
        if version < 5 {
            notes::migrate(&transaction)?;
        }
        if version < 6 {
            relationships::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 6)?;
        }
        if version < 7 {
            efforts::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 7)?;
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
            status: Status::Todo,
            body: String::new(),
            tags: Vec::new(),
            effort_id: None,
            availability: Some("Ready".into()),
            prerequisites: Vec::new(),
        })
    }

    pub fn change_ticket(&mut self, reference: &str, patch: TicketPatch) -> Result<Ticket, Error> {
        let title = patch.title.as_deref().map(str::trim);
        if title == Some("") {
            return Err(Error::EmptyTitle);
        }
        let number = reference
            .strip_prefix("T-")
            .and_then(|value| value.parse::<i64>().ok());
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let ticket = transaction
            .query_row(
                "SELECT id, number, title, status, body, effort_id FROM tickets WHERE number = ?1",
                [number],
                ticket_from_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(reference.to_owned()))?;
        let status = patch.status.unwrap_or(ticket.status);
        transaction.execute("UPDATE tickets SET title = COALESCE(?1, title), body = COALESCE(?2, body), status = ?3 WHERE number = ?4", params![title, patch.body, status.to_string(), number])?;
        if status != ticket.status {
            history::record(
                &transaction,
                &ticket.id,
                "status",
                &ticket.status.to_string(),
                &status.to_string(),
                patch.editing_agent.as_deref(),
            )?;
        }
        let mut updated = transaction.query_row(
            "SELECT id, number, title, status, body, effort_id FROM tickets WHERE number = ?1",
            [number],
            ticket_from_row,
        )?;
        updated.tags = tags::for_ticket(&transaction, &updated.id)?;
        relationships::populate(&transaction, &mut updated)?;
        transaction.commit()?;
        Ok(updated)
    }

    pub fn ticket_history(&self, reference: &str) -> Result<Vec<HistoryEntry>, Error> {
        let ticket = self.show_ticket(reference)?;
        history::read(&self.connection, &ticket.id)
    }

    pub fn add_note(
        &mut self,
        reference: &str,
        content: &str,
        agent: Option<&str>,
    ) -> Result<Note, Error> {
        let ticket = self.show_ticket(reference)?;
        notes::add(&self.connection, &ticket.id, content, agent)
    }
    pub fn edit_note(
        &mut self,
        reference: &str,
        id: &str,
        patch: NotePatch,
    ) -> Result<Note, Error> {
        let ticket = self.show_ticket(reference)?;
        notes::edit(&self.connection, &ticket.id, id, patch)
    }
    pub fn delete_note(&mut self, reference: &str, id: &str) -> Result<(), Error> {
        let ticket = self.show_ticket(reference)?;
        notes::delete(&self.connection, &ticket.id, id)
    }
    pub fn notes(&self, reference: &str, limit: u32, offset: u32) -> Result<Vec<Note>, Error> {
        let ticket = self.show_ticket(reference)?;
        notes::read(&self.connection, &ticket.id, limit, offset)
    }

    pub fn list_tickets(&self) -> Result<Vec<Ticket>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT id, number, title, status, body, effort_id FROM tickets ORDER BY number DESC",
        )?;
        let mut tickets = statement
            .query_map([], ticket_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for ticket in &mut tickets {
            ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
            relationships::populate(&self.connection, ticket)?;
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
                "SELECT id, number, title, status, body, effort_id FROM tickets WHERE number = ?1",
                [number],
                ticket_from_row,
            )
            .optional()?;
        let mut ticket = ticket.ok_or_else(|| Error::NotFound(reference.to_owned()))?;
        ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
        relationships::populate(&self.connection, &mut ticket)?;
        Ok(ticket)
    }
}

fn ticket_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        id: row.get(0)?,
        reference: format!("T-{}", row.get::<_, i64>(1)?),
        title: row.get(2)?,
        status: row.get::<_, String>(3)?.parse().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        body: row.get(4)?,
        tags: Vec::new(),
        effort_id: row.get(5)?,
        availability: None,
        prerequisites: Vec::new(),
    })
}
