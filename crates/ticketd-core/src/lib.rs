//! Shared ticket workflows for the desktop and CLI.
mod backlinks;
pub use backlinks::Backlink;
mod backup;
mod context;
mod export;
pub use context::{ContextOptions, TicketContext};

mod efforts;
mod retry;
pub use retry::{WriteRequest, WriteResult};
mod graph;
mod hierarchy;
pub use graph::{DependencyGraph, GraphEdge, GraphNode};
mod projects;
mod relationships;
mod search;
pub use search::{Availability, TicketFilter};
mod tags;
pub use efforts::{Effort, EffortCounts, EffortView};

use std::{
    path::Path,
    time::{Duration, Instant},
};

use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod history;
mod notes;
pub use history::{HistoryEntry, Status};
pub use notes::{Note, NotePatch};
pub use projects::Project;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("backup or restore failed: {0}")]
    Backup(String),
    #[error(
        "backup or restore failed: workspace is in use; close other ticketd operations and retry: {source}"
    )]
    RestoreLock {
        #[source]
        source: std::io::Error,
    },
    #[error("backup or restore failed: restore failed: {source}; safety backup: {}", safety.display())]
    Restore {
        safety: std::path::PathBuf,
        #[source]
        source: Box<Error>,
    },
    #[error("workspace migration failed: {source}; the original data remains unchanged. Backup: {}. Restore it with `ticketd restore-workspace <backup>` or use the previous application version", backup.display())]
    Migration {
        backup: std::path::PathBuf,
        #[source]
        source: Box<Error>,
    },
    #[error("request ID was already used for different content: {0}")]
    RequestConflict(String),
    #[error("request serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("batch operation {index}: {source}")]
    BatchOperation {
        index: usize,
        #[source]
        source: Box<Error>,
    },
    #[error("invalid batch: {0}")]
    InvalidBatch(String),
    #[error("effort name must not be empty")]
    EmptyEffortName,
    #[error("effort '{0}' was not found")]
    EffortNotFound(String),
    #[error(
        "checkout matches multiple projects; specify --project explicitly or remove a registration"
    )]
    AmbiguousProject,
    #[error("checkout path must be valid Unicode")]
    InvalidCheckoutPath,
    #[error("project name and path must not be empty")]
    EmptyProject,
    #[error("project '{0}' was not found")]
    ProjectNotFound(String),
    #[error("dependency would create a cycle or self-link")]
    DependencyCycle,
    #[error("parent assignment would create a cycle or more than one level of subtickets")]
    InvalidHierarchy,
    #[error("tag name must not be empty")]
    EmptyTag,
    #[error("ticket '{0}' is in trash; restore it before editing")]
    Trashed(String),
    #[error("a related ticket is missing from the workspace")]
    MissingRelatedTicket,
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
    pub trashed: bool,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub body: String,
    pub tags: Vec<String>,
    pub effort_id: Option<String>,
    pub project_id: Option<String>,
    pub availability: Option<String>,
    pub prerequisites: Vec<relationships::Prerequisite>,
    pub parent: Option<hierarchy::RelatedTicket>,
    pub children: Vec<hierarchy::RelatedTicket>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TicketPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub status: Option<Status>,
    pub editing_agent: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_project_patch"
    )]
    pub project_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_project_patch"
    )]
    pub effort_id: Option<Option<String>>,
}

fn deserialize_project_patch<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

fn wait_for_migration_lock(deadline: Instant) -> Result<(), Error> {
    if Instant::now() >= deadline {
        return Err(Error::Backup(
            "workspace is in use and cannot be migrated; close other ticketd operations and retry"
                .into(),
        ));
    }
    std::thread::sleep(Duration::from_millis(25));
    Ok(())
}

pub struct Workspace {
    connection: Connection,
    _lock: std::fs::File,
}

impl Workspace {
    pub fn open_default() -> Result<Self, Error> {
        Self::open(default_path()?)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        use fs2::FileExt;
        let path = path.as_ref();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let lock = backup::lock_file(path)?;
            if let Err(error) = FileExt::try_lock_shared(&lock) {
                if error.raw_os_error() != fs2::lock_contended_error().raw_os_error() {
                    return Err(error.into());
                }
                wait_for_migration_lock(deadline)?;
                continue;
            }
            let connection = Connection::open(path)?;
            connection.busy_timeout(Duration::from_secs(10))?;
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            if version > 13 {
                return Err(Error::NewerSchema(version));
            }
            if version == 13 {
                connection.pragma_update(None, "foreign_keys", "ON")?;
                return Ok(Self {
                    connection,
                    _lock: lock,
                });
            }
            drop(connection);
            drop(lock);
            let lock = backup::lock_file(path)?;
            if let Err(error) = FileExt::try_lock_exclusive(&lock) {
                if error.raw_os_error() != fs2::lock_contended_error().raw_os_error() {
                    return Err(error.into());
                }
                wait_for_migration_lock(deadline)?;
                continue;
            }
            let mut connection = Connection::open(path)?;
            connection.busy_timeout(Duration::from_secs(10))?;
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            if version > 13 {
                return Err(Error::NewerSchema(version));
            }
            if version < 13 {
                let backup = if version > 0 {
                    Some(Self::migration_backup(&connection, path).map_err(|source| {
                        Error::Backup(format!("cannot create a pre-migration backup for {}: {source}; check available disk space and directory permissions, then retry", path.display()))
                    })?)
                } else {
                    None
                };
                let result = Self::migrate(&mut connection, version);
                if let Err(source) = result {
                    return Err(match backup {
                        Some(backup) => Error::Migration {
                            backup,
                            source: Box::new(source),
                        },
                        None => source,
                    });
                }
            }
            // Release exclusive ownership before acquiring the lifetime shared lock,
            // then recheck: restore may have run in between.
        }
    }

    fn migrate(connection: &mut Connection, version: i64) -> Result<(), Error> {
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
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
            projects::migrate(&transaction)?;
        }
        if version < 8 {
            efforts::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 8)?;
        }
        if version < 9 {
            hierarchy::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 9)?;
        }
        if version < 10 {
            projects::migrate_checkouts(&transaction)?;
            transaction.pragma_update(None, "user_version", 10)?;
        }
        if version < 11 {
            transaction.execute_batch("ALTER TABLE tickets ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 11;")?;
        }
        if version < 12 {
            transaction.execute_batch("CREATE TABLE request_outcomes (id TEXT PRIMARY KEY, request TEXT NOT NULL, outcome TEXT NOT NULL); PRAGMA user_version = 12;")?;
        }
        if version < 13 {
            transaction.execute_batch("CREATE INDEX ticket_history_ticket_id ON ticket_history(ticket_id); PRAGMA user_version = 13;")?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn create_ticket(&mut self, title: &str) -> Result<Ticket, Error> {
        self.create_ticket_in_project(title, None)
    }

    pub fn create_ticket_in_project(
        &mut self,
        title: &str,
        project_id: Option<&str>,
    ) -> Result<Ticket, Error> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::EmptyTitle);
        }
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        if let Some(id) = project_id {
            projects::find(&transaction, id)?;
        }
        let id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO tickets (id, title, status, project_id) VALUES (?1, ?2, 'Todo', ?3)",
            params![id, title, project_id],
        )?;
        let number = transaction.last_insert_rowid();
        if let Some(project_id) = project_id {
            history::record(&transaction, &id, "project", "", project_id, None)?;
        }
        transaction.commit()?;
        Ok(Ticket {
            id,
            trashed: false,
            reference: format!("T-{number}"),
            title: title.to_owned(),
            status: Status::Todo,
            body: String::new(),
            tags: Vec::new(),
            effort_id: None,
            project_id: project_id.map(str::to_owned),
            availability: Some("Ready".into()),
            prerequisites: Vec::new(),
            parent: None,
            children: Vec::new(),
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
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let ticket = transaction
            .query_row(
                "SELECT id, number, title, status, body, project_id, effort_id, trashed FROM tickets WHERE number = ?1",
                [number],
                ticket_from_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(reference.to_owned()))?;
        ensure_editable(&transaction, &ticket.id)?;
        if let Some(ref effort_id) = patch.effort_id {
            if let Some(id) = effort_id {
                efforts::get(&transaction, id)?;
            }
            if *effort_id != ticket.effort_id {
                transaction.execute(
                    "UPDATE tickets SET effort_id = ?1 WHERE number = ?2",
                    params![effort_id, number],
                )?;
                history::record(
                    &transaction,
                    &ticket.id,
                    "effort",
                    ticket.effort_id.as_deref().unwrap_or(""),
                    effort_id.as_deref().unwrap_or(""),
                    patch.editing_agent.as_deref(),
                )?;
            }
        }
        if let Some(ref project_id) = patch.project_id {
            if let Some(id) = project_id {
                projects::find(&transaction, id)?;
            }
            if *project_id != ticket.project_id {
                transaction.execute(
                    "UPDATE tickets SET project_id = ?1 WHERE number = ?2",
                    params![project_id, number],
                )?;
                history::record(
                    &transaction,
                    &ticket.id,
                    "project",
                    ticket.project_id.as_deref().unwrap_or(""),
                    project_id.as_deref().unwrap_or(""),
                    patch.editing_agent.as_deref(),
                )?;
            }
        }
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
            "SELECT id, number, title, status, body, project_id, effort_id, trashed FROM tickets WHERE number = ?1",
            [number],
            ticket_from_row,
        )?;
        updated.tags = tags::for_ticket(&transaction, &updated.id)?;
        relationships::populate(&transaction, &mut updated)?;
        hierarchy::populate(&transaction, &mut updated)?;
        transaction.commit()?;
        Ok(updated)
    }

    pub fn set_trashed(
        &mut self,
        reference: &str,
        trashed: bool,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id = relationships::id(&tx, reference)?;
        let old: bool =
            tx.query_row("SELECT trashed FROM tickets WHERE id = ?1", [&id], |row| {
                row.get(0)
            })?;
        if old != trashed {
            tx.execute(
                "UPDATE tickets SET trashed = ?1 WHERE id = ?2",
                params![trashed, id],
            )?;
            history::record(
                &tx,
                &id,
                "trash",
                if old { "trashed" } else { "active" },
                if trashed { "trashed" } else { "active" },
                agent,
            )?;
        }
        tx.commit()?;
        self.show_ticket(reference)
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
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id_ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &id_ticket)?;
        let result = notes::add(&tx, &id_ticket, content, agent)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn edit_note(
        &mut self,
        reference: &str,
        id: &str,
        patch: NotePatch,
    ) -> Result<Note, Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id_ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &id_ticket)?;
        let result = notes::edit(&tx, &id_ticket, id, patch)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn delete_note(&mut self, reference: &str, id: &str) -> Result<(), Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id_ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &id_ticket)?;
        notes::delete(&tx, &id_ticket, id)?;
        tx.commit()?;
        Ok(())
    }
    pub fn notes(&self, reference: &str, limit: u32, offset: u32) -> Result<Vec<Note>, Error> {
        let ticket = self.show_ticket(reference)?;
        notes::read(&self.connection, &ticket.id, limit, offset)
    }

    pub fn list_tickets(&self) -> Result<Vec<Ticket>, Error> {
        self.list_by_trash(false)
    }

    pub fn list_trash(&self) -> Result<Vec<Ticket>, Error> {
        self.list_by_trash(true)
    }

    fn list_by_trash(&self, trashed: bool) -> Result<Vec<Ticket>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT id, number, title, status, body, project_id, effort_id, trashed FROM tickets WHERE trashed = ?1 ORDER BY number DESC",
        )?;
        let mut tickets = statement
            .query_map([trashed], ticket_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for ticket in &mut tickets {
            ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
            relationships::populate(&self.connection, ticket)?;
            hierarchy::populate(&self.connection, ticket)?;
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
                "SELECT id, number, title, status, body, project_id, effort_id, trashed FROM tickets WHERE number = ?1",
                [number],
                ticket_from_row,
            )
            .optional()?;
        let mut ticket = ticket.ok_or_else(|| Error::NotFound(reference.to_owned()))?;
        ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
        relationships::populate(&self.connection, &mut ticket)?;
        hierarchy::populate(&self.connection, &mut ticket)?;
        Ok(ticket)
    }
}

fn ticket_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        id: row.get(0)?,
        trashed: row.get(7)?,
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
        project_id: row.get(5)?,
        effort_id: row.get(6)?,
        availability: None,
        prerequisites: Vec::new(),
        parent: None,
        children: Vec::new(),
    })
}

// All ticket mutations must check this inside the same write transaction.
pub(crate) fn ensure_editable(connection: &Connection, id: &str) -> Result<(), Error> {
    let (trashed, number): (bool, i64) = connection.query_row(
        "SELECT trashed, number FROM tickets WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if trashed {
        return Err(Error::Trashed(format!("T-{number}")));
    }
    Ok(())
}

// A savepoint used independently acquires the write lock before reading invariants.
fn transaction_write_lock(connection: &Connection) -> Result<(), Error> {
    connection.execute("UPDATE tickets SET number = number WHERE 0", [])?;
    Ok(())
}

mod batch;
pub use batch::{BatchOperation, TicketChange};

fn default_path() -> Result<std::path::PathBuf, Error> {
    let dirs = ProjectDirs::from("", "", "ticketd").ok_or(Error::NoDataDirectory)?;
    std::fs::create_dir_all(dirs.data_dir())?;
    Ok(dirs.data_dir().join("workspace.sqlite3"))
}
