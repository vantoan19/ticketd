//! Local version history of tickets and Documents: the previous row is saved whenever a
//! field a person would compare changes, whichever write path or incoming sync changed it.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::{DocumentPatch, Error, Status, TicketPatch, Workspace, relationships};

/// How long an earlier version is kept after a newer one replaced it.
const RETENTION_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Ticket,
    Document,
}

impl RecordKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ticket => "ticket",
            Self::Document => "document",
        }
    }
}

/// One earlier version in a record's history, without its content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionSummary {
    pub id: i64,
    /// UTC time the change that replaced this version was saved.
    pub replaced_at: String,
    /// The fields that change altered: `title`, `body`, `status`, `trashed`.
    pub changed: Vec<String>,
    /// The desktop whose change replaced this version, when it arrived by sync;
    /// `None` for a change made on this device.
    pub device: Option<String>,
}

/// An earlier version of a ticket or Document, for comparison with the current record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    pub id: i64,
    pub kind: RecordKind,
    /// The GUID of the ticket or Document.
    pub record_id: String,
    pub replaced_at: String,
    pub changed: Vec<String>,
    /// The desktop whose change replaced this version, when it arrived by sync;
    /// `None` for a change made on this device.
    pub device: Option<String>,
    /// A Document may have no title; a ticket always has one.
    pub title: Option<String>,
    pub body: String,
    /// Tickets only.
    pub status: Option<Status>,
    pub trashed: bool,
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), Error> {
    // ponytail: every saved change keeps a full copy of the body, so a long Document
    // autosaved for 30 days stores many copies. Thin out bursts if size becomes a problem.
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS record_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK (kind IN ('ticket', 'document')),
            record_id TEXT NOT NULL,
            replaced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            changed TEXT NOT NULL,
            title TEXT,
            body TEXT NOT NULL,
            status TEXT,
            trashed INTEGER NOT NULL,
            device TEXT);
        CREATE INDEX IF NOT EXISTS record_versions_record ON record_versions(kind, record_id);
        DROP TRIGGER IF EXISTS record_version_ticket;
        DROP TRIGGER IF EXISTS record_version_document;
        CREATE TRIGGER record_version_ticket AFTER UPDATE ON tickets
        WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body
            OR OLD.status IS NOT NEW.status OR OLD.trashed IS NOT NEW.trashed
        BEGIN
            INSERT INTO record_versions (kind, record_id, changed, title, body, status, trashed, device)
            VALUES ('ticket', OLD.id, trim(
                CASE WHEN OLD.title IS NOT NEW.title THEN 'title ' ELSE '' END
                || CASE WHEN OLD.body IS NOT NEW.body THEN 'body ' ELSE '' END
                || CASE WHEN OLD.status IS NOT NEW.status THEN 'status ' ELSE '' END
                || CASE WHEN OLD.trashed IS NOT NEW.trashed THEN 'trashed' ELSE '' END),
                OLD.title, OLD.body, OLD.status, OLD.trashed, (SELECT origin FROM sync_capture));
        END;
        CREATE TRIGGER record_version_document AFTER UPDATE ON documents
        WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body
            OR OLD.trashed IS NOT NEW.trashed
        BEGIN
            INSERT INTO record_versions (kind, record_id, changed, title, body, trashed, device)
            VALUES ('document', OLD.id, trim(
                CASE WHEN OLD.title IS NOT NEW.title THEN 'title ' ELSE '' END
                || CASE WHEN OLD.body IS NOT NEW.body THEN 'body ' ELSE '' END
                || CASE WHEN OLD.trashed IS NOT NEW.trashed THEN 'trashed' ELSE '' END),
                OLD.title, OLD.body, OLD.trashed, (SELECT origin FROM sync_capture));
        END;
        PRAGMA user_version = 57;",
    )?;
    Ok(())
}

fn changed_fields(changed: &str) -> Vec<String> {
    changed.split_whitespace().map(str::to_owned).collect()
}

fn read(connection: &Connection, id: i64) -> Result<Version, Error> {
    let (kind, record_id, replaced_at, changed, title, body, status, trashed, device) = connection
        .query_row(
            "SELECT kind, record_id, replaced_at, changed, title, body, status, trashed, device FROM record_versions WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get::<_, String>(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| Error::NotFound(format!("version {id}")))?;
    Ok(Version {
        id,
        kind: if kind == "ticket" {
            RecordKind::Ticket
        } else {
            RecordKind::Document
        },
        record_id,
        replaced_at,
        changed: changed_fields(&changed),
        device,
        title,
        body,
        status: status.map(|status| status.parse()).transpose()?,
        trashed,
    })
}

impl Workspace {
    /// The earlier versions of a ticket (by Ticket reference) or Document (by id), newest
    /// first. The current version is the record itself and is not listed.
    pub fn versions(
        &self,
        kind: RecordKind,
        reference: &str,
    ) -> Result<Vec<VersionSummary>, Error> {
        let record_id = match kind {
            RecordKind::Ticket => relationships::id(&self.connection, reference)?,
            RecordKind::Document => self.show_document(reference)?.id,
        };
        let mut statement = self.connection.prepare(
            "SELECT id, replaced_at, changed, device FROM record_versions WHERE kind = ?1 AND record_id = ?2 ORDER BY id DESC",
        )?;
        let versions = statement
            .query_map(params![kind.as_str(), record_id], |row| {
                Ok(VersionSummary {
                    id: row.get(0)?,
                    replaced_at: row.get(1)?,
                    changed: changed_fields(&row.get::<_, String>(2)?),
                    device: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(versions)
    }

    /// One earlier version with its content.
    pub fn version(&self, id: i64) -> Result<Version, Error> {
        read(&self.connection, id)
    }

    /// Make an earlier version's title, body and status current again. This is an ordinary
    /// edit, so the content it replaces becomes a version too. Trash is left as it is:
    /// restoring from the trash stays its own explicit action.
    pub fn restore_version(&mut self, id: i64) -> Result<(), Error> {
        let version = read(&self.connection, id)?;
        match version.kind {
            RecordKind::Ticket => {
                let reference: String = self.connection.query_row(
                    "SELECT reference FROM tickets WHERE id = ?1",
                    [&version.record_id],
                    |row| row.get(0),
                )?;
                let patch = TicketPatch {
                    title: version.title,
                    body: Some(version.body),
                    // Duplicate needs its canonical ticket and is set by its own workflow.
                    status: version.status.filter(|status| *status != Status::Duplicate),
                    ..Default::default()
                };
                self.change_ticket(&reference, patch)?;
            }
            RecordKind::Document => {
                let patch = DocumentPatch {
                    title: Some(version.title),
                    body: Some(version.body),
                    expected_updated_at: None,
                };
                self.change_document(&version.record_id, patch)?;
            }
        }
        Ok(())
    }

    /// Remove versions replaced more than 30 days before `now` (the database clock when
    /// omitted) and return how many were removed. Current records are never touched.
    pub fn expire_versions(&mut self, now: Option<&str>) -> Result<usize, Error> {
        let now = crate::source::clock(&self.connection, now)?;
        Ok(self.connection.execute(
            "DELETE FROM record_versions WHERE julianday(replaced_at) < julianday(?1) - ?2",
            params![now, RETENTION_DAYS],
        )?)
    }
}
