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
