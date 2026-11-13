//! Change capture: every write to synced content marks its owning record dirty
//! in the writing transaction, whichever process made the write.

use rusqlite::{Connection, params, types::FromSql};
use serde::{Deserialize, Serialize};

use crate::{Error, Workspace};

/// The kinds of record that are synced as a unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Ticket,
    Document,
    Plan,
    Project,
    Attachment,
    Automation,
    AutomationAgent,
}

impl RecordKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ticket => "ticket",
            Self::Document => "document",
            Self::Plan => "plan",
            Self::Project => "project",
            Self::Attachment => "attachment",
            Self::Automation => "automation",
            Self::AutomationAgent => "automation_agent",
        }
    }
}

impl FromSql for RecordKind {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        match value.as_str()? {
            "ticket" => Ok(Self::Ticket),
            "document" => Ok(Self::Document),
            "plan" => Ok(Self::Plan),
            "project" => Ok(Self::Project),
            "attachment" => Ok(Self::Attachment),
            "automation" => Ok(Self::Automation),
            "automation_agent" => Ok(Self::AutomationAgent),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        }
    }
}

/// A record changed locally since it was last uploaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirtyRecord {
    pub kind: RecordKind,
    /// The record's GUID.
    pub id: String,
    /// Moves every time the record is marked again; `clear_dirty` checks it.
    pub mark: i64,
}

use RecordKind::{Attachment, Automation, AutomationAgent, Document, Plan, Project, Ticket};

/// Each table holding synced content, the record that owns a row, and the
/// column holding that record's GUID. A relationship belongs to one record only:
/// `blocked_by` to the blocked ticket, `parent` to the child, a tag to its record.
///
/// Left out on purpose: device-local tables (inbox, checkouts, upload queues,
/// credentials, whether an Automation is on), indexes derived from bodies, the
/// bare `tags` vocabulary, and what a tracker refresh rewrites (`source_sync`,
/// `source_conversation`).
const CAPTURED: [(&str, RecordKind, &str); 23] = [
    ("tickets", Ticket, "id"),
    ("activities", Ticket, "ticket_id"),
    ("evidence", Ticket, "ticket_id"),
    ("ticket_tags", Ticket, "ticket_id"),
    ("dependencies", Ticket, "dependent_id"),
    ("ticket_parents", Ticket, "child_id"),
    ("contextual_relationships", Ticket, "source_id"),
    ("ticket_follows", Ticket, "ticket_id"),
    ("ticket_reminders", Ticket, "ticket_id"),
    ("ticket_attachments", Ticket, "ticket_id"),
    ("ticket_documents", Ticket, "ticket_id"),
    ("duplicate_tickets", Ticket, "source_id"),
    ("external_identities", Ticket, "ticket_id"),
    ("external_ownership", Ticket, "ticket_id"),
    ("documents", Document, "id"),
    ("document_tags", Document, "document_id"),
    ("document_pins", Document, "document_id"),
    ("plans", Plan, "id"),
    ("plan_documents", Plan, "plan_id"),
    ("projects", Project, "id"),
    ("attachments", Attachment, "id"),
    ("automations", Automation, "id"),
    ("automation_agents", AutomationAgent, "id"),
];

pub(crate) const TRIGGER_EVENTS: [&str; 3] = ["insert", "update", "delete"];

/// The tables with capture triggers, named `sync_capture_<table>_<event>`, each
/// with the format version its triggers came with.
pub(crate) fn captured_tables() -> impl Iterator<Item = (&'static str, i64)> {
    CAPTURED.iter().map(|(table, kind, _)| {
        let since = match kind {
            Automation | AutomationAgent => 70,
            Ticket | Document | Plan | Project | Attachment => 58,
        };
        (*table, since)
    })
}

/// Safe to run again after a later migration rebuilds a captured table.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_dirty (kind TEXT NOT NULL, id TEXT NOT NULL, mark INTEGER NOT NULL, PRIMARY KEY(kind, id));
         CREATE TABLE IF NOT EXISTS sync_capture (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL, marks INTEGER NOT NULL, origin TEXT);
         INSERT OR IGNORE INTO sync_capture (id, applying, marks) VALUES (1, 0, 0);",
    )?;
    for (table, kind, owner) in CAPTURED {
        // A table of a later format version gets its triggers when that version
        // runs this again.
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )?;
        if !exists {
            continue;
        }
        let kind = kind.as_str();
        // An upsert, not INSERT OR REPLACE: a conflict clause on the statement that
        // fired the trigger (INSERT OR IGNORE INTO ticket_tags) would override it.
        let mark = |row: &str| {
            format!(
                "UPDATE sync_capture SET marks = marks + 1;
                 INSERT INTO sync_dirty (kind, id, mark) VALUES ('{kind}', {row}.{owner}, (SELECT marks FROM sync_capture))
                 ON CONFLICT(kind, id) DO UPDATE SET mark = excluded.mark;"
            )
        };
        // Delivering a due reminder is this device's inbox state, not a change to the reminder.
        let update = if table == "ticket_reminders" {
            "UPDATE OF due_at"
        } else {
            "UPDATE"
        };
        for (name, event, marks) in [
            ("insert", "INSERT", mark("NEW")),
            ("update", update, mark("OLD") + &mark("NEW")),
            ("delete", "DELETE", mark("OLD")),
        ] {
            connection.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS sync_capture_{table}_{name} AFTER {event} ON \"{table}\"
                 WHEN (SELECT applying FROM sync_capture) = 0 BEGIN {marks} END;"
            ))?;
        }
    }
    Ok(())
}

impl Workspace {
    /// Records changed locally and not yet cleared, oldest change first.
    pub fn dirty_records(&self) -> Result<Vec<DirtyRecord>, Error> {
        let mut statement = self
            .connection
            .prepare("SELECT kind, id, mark FROM sync_dirty ORDER BY mark")?;
        Ok(statement
            .query_map([], |row| {
                Ok(DirtyRecord {
                    kind: row.get(0)?,
                    id: row.get(1)?,
                    mark: row.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    /// The mark of the newest local change ever captured in this Workspace.
    /// It only grows, also when marks are cleared, so a host can tell with one
    /// small read that something changed since it last looked.
    pub fn change_mark(&self) -> Result<i64, Error> {
        Ok(self
            .connection
            .query_row("SELECT marks FROM sync_capture", [], |row| row.get(0))?)
    }

    /// Clear a mark once its record is uploaded. Returns false, leaving the
    /// record dirty, when it changed again after `record` was read.
    pub fn clear_dirty(&mut self, record: &DirtyRecord) -> Result<bool, Error> {
        Ok(self.connection.execute(
            "DELETE FROM sync_dirty WHERE kind = ?1 AND id = ?2 AND mark = ?3",
            params![record.kind.as_str(), record.id, record.mark],
        )? == 1)
    }

    /// Run `apply` as one transaction whose writes are not captured, for
    /// applying incoming files. `device` names the desktop the incoming change
    /// was made on, for version history. Capture is switched off inside the
    /// transaction only, so it is back on however `apply` ends, and a write
    /// another process makes meanwhile is still captured.
    pub fn applying_incoming<T>(
        &mut self,
        device: Option<&str>,
        apply: impl FnOnce(&mut Workspace) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.connection.execute_batch("SAVEPOINT sync_incoming")?;
        let result = (|| {
            let before: (i64, Option<String>) = self.connection.query_row(
                "SELECT applying, origin FROM sync_capture",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            self.connection.execute(
                "UPDATE sync_capture SET applying = 1, origin = ?1",
                [device],
            )?;
            let logged = crate::events::head(&self.connection)?;
            let applied = apply(self)?;
            crate::events::fold_into_creation(&self.connection, logged)?;
            self.connection.execute(
                "UPDATE sync_capture SET applying = ?1, origin = ?2",
                params![before.0, before.1],
            )?;
            self.connection.execute_batch("RELEASE sync_incoming")?;
            Ok(applied)
        })();
        if result.is_err() {
            self.connection
                .execute_batch("ROLLBACK TO sync_incoming; RELEASE sync_incoming")?;
        }
        result
    }
}

/// Mark a record the way a captured write would, for a change the engine made
/// while capture was off that still has to be uploaded.
pub(crate) fn mark_dirty(connection: &Connection, kind: RecordKind, id: &str) -> Result<(), Error> {
    connection.execute("UPDATE sync_capture SET marks = marks + 1", [])?;
    connection.execute(
        "INSERT INTO sync_dirty (kind, id, mark) VALUES (?1, ?2, (SELECT marks FROM sync_capture))
         ON CONFLICT(kind, id) DO UPDATE SET mark = excluded.mark",
        params![kind.as_str(), id],
    )?;
    Ok(())
}
