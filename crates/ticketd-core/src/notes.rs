use crate::Error;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    pub editing_agent: Option<String>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct NotePatch {
    pub content: Option<String>,
    pub editing_agent: Option<String>,
}
pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE notes (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL REFERENCES tickets(id), content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), editing_agent TEXT); PRAGMA user_version = 5;")?;
    Ok(())
}
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        content: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        editing_agent: row.get(4)?,
    })
}
pub(crate) fn get(conn: &Connection, ticket: &str, id: &str) -> Result<Note, Error> {
    conn.query_row("SELECT id, content, created_at, updated_at, editing_agent FROM notes WHERE ticket_id = ?1 AND id = ?2", params![ticket,id], row).optional()?.ok_or_else(|| Error::NoteNotFound(id.to_owned()))
}
pub(crate) fn add(
    conn: &Connection,
    ticket: &str,
    content: &str,
    agent: Option<&str>,
) -> Result<Note, Error> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO notes (id, ticket_id, content, editing_agent) VALUES (?1, ?2, ?3, ?4)",
        params![id, ticket, content, agent],
    )?;
    get(conn, ticket, &id)
}
pub(crate) fn edit(
    conn: &Connection,
    ticket: &str,
    id: &str,
    patch: NotePatch,
) -> Result<Note, Error> {
    let changed = conn.execute("UPDATE notes SET content = COALESCE(?1, content), editing_agent = COALESCE(?2, editing_agent), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE ticket_id = ?3 AND id = ?4", params![patch.content,patch.editing_agent,ticket,id])?;
    if changed == 0 {
        return Err(Error::NoteNotFound(id.to_owned()));
    }
    get(conn, ticket, id)
}
pub(crate) fn delete(conn: &Connection, ticket: &str, id: &str) -> Result<(), Error> {
    if conn.execute(
        "DELETE FROM notes WHERE ticket_id = ?1 AND id = ?2",
        params![ticket, id],
    )? == 0
    {
        return Err(Error::NoteNotFound(id.to_owned()));
    }
    Ok(())
}
pub(crate) fn read(
    conn: &Connection,
    ticket: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Note>, Error> {
    let mut statement = conn.prepare("SELECT id, content, created_at, updated_at, editing_agent FROM notes WHERE ticket_id = ?1 ORDER BY number LIMIT ?2 OFFSET ?3")?;
    Ok(statement
        .query_map(params![ticket, limit.clamp(1, 100), offset], row)?
        .collect::<Result<Vec<_>, _>>()?)
}

/// A note's reporting time and attribution for list and rail summaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportedUpdate {
    pub note_id: String,
    pub reported_at: String,
    pub editing_agent: Option<String>,
}

pub(crate) fn populate_update(conn: &Connection, ticket: &mut crate::Ticket) -> Result<(), Error> {
    ticket.updated_at = conn.query_row(
        "SELECT updated_at FROM tickets WHERE id = ?1",
        [&ticket.id],
        |row| row.get(0),
    )?;
    ticket.latest_update = conn.query_row("SELECT id, created_at, editing_agent FROM notes WHERE ticket_id = ?1 ORDER BY created_at DESC, number DESC LIMIT 1", [&ticket.id], |row| Ok(ReportedUpdate { note_id: row.get(0)?, reported_at: row.get(1)?, editing_agent: row.get(2)? })).optional()?;
    Ok(())
}

pub(crate) fn migrate_updates(tx: &Transaction<'_>) -> Result<(), Error> {
    for (table, column, kind) in [
        ("tickets", "updated_at", "TEXT"),
        ("source_sync", "discovery_matches", "INTEGER"),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !exists {
            tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"))?;
        }
    }
    tx.execute_batch("
        UPDATE tickets SET updated_at = (SELECT MAX(time) FROM (
            SELECT timestamp AS time FROM ticket_history WHERE ticket_id = tickets.id
            UNION ALL SELECT updated_at FROM notes WHERE ticket_id = tickets.id
            UNION ALL SELECT external_updated_at FROM source_sync WHERE ticket_id = tickets.id)) WHERE updated_at IS NULL;
        CREATE TRIGGER IF NOT EXISTS ticket_created_time AFTER INSERT ON tickets BEGIN
            UPDATE tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS ticket_changed_time AFTER UPDATE OF title, body, status, project_id, plan_id, trashed ON tickets
        WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body OR OLD.status IS NOT NEW.status OR OLD.project_id IS NOT NEW.project_id OR OLD.plan_id IS NOT NEW.plan_id OR OLD.trashed IS NOT NEW.trashed BEGIN
            UPDATE tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS ticket_history_time AFTER INSERT ON ticket_history WHEN NEW.kind NOT IN ('source_unavailable', 'publication_unresolved') BEGIN
            UPDATE tickets SET updated_at = CASE WHEN updated_at IS NULL OR updated_at < NEW.timestamp THEN NEW.timestamp ELSE updated_at END WHERE id = NEW.ticket_id;
        END;
        CREATE TRIGGER IF NOT EXISTS note_created_time AFTER INSERT ON notes BEGIN
            UPDATE tickets SET updated_at = NEW.created_at WHERE id = NEW.ticket_id;
        END;
        CREATE TRIGGER IF NOT EXISTS note_changed_time AFTER UPDATE ON notes BEGIN
            UPDATE tickets SET updated_at = NEW.updated_at WHERE id = NEW.ticket_id;
        END;
        CREATE TRIGGER IF NOT EXISTS note_deleted_time AFTER DELETE ON notes BEGIN
            UPDATE tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.ticket_id;
        END;
        INSERT INTO ticket_history (ticket_id, kind, from_value, to_value, timestamp, editing_agent)
        SELECT a.ticket_id, 'publication_unresolved', a.id, a.destination, a.updated_at, NULL FROM publication_attempts a
        WHERE a.status = 'unresolved' AND NOT EXISTS (SELECT 1 FROM ticket_history h WHERE h.ticket_id = a.ticket_id AND h.kind = 'publication_unresolved' AND h.from_value = a.id);
        INSERT INTO ticket_history (ticket_id, kind, from_value, to_value, timestamp, editing_agent)
        SELECT i.ticket_id, 'source_import', '', i.display, i.linked_at, i.provider FROM external_identities i
        WHERE i.origin = 'imported' AND NOT EXISTS (SELECT 1 FROM ticket_history h WHERE h.ticket_id = i.ticket_id AND h.kind = 'source_import');
        INSERT INTO ticket_history (ticket_id, kind, from_value, to_value, timestamp, editing_agent)
        SELECT s.ticket_id, 'source_unavailable', '', s.last_error_code, s.failing_since, i.provider FROM source_sync s JOIN external_identities i ON i.ticket_id = s.ticket_id
        WHERE s.failing_since IS NOT NULL AND s.last_error_code IN ('not_found', 'unauthenticated', 'forbidden', 'unavailable', 'protocol') AND NOT EXISTS (SELECT 1 FROM ticket_history h WHERE h.ticket_id = s.ticket_id AND h.kind = 'source_unavailable' AND h.timestamp = s.failing_since);
        PRAGMA user_version = 28;")?;
    Ok(())
}
