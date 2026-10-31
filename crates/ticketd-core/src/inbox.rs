use crate::{Error, Workspace};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

// A stable scope for the one local person, independent of editing attribution.
const LOCAL_PERSON: &str = "local-person";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxEntry {
    pub id: i64,
    pub reference: String,
    pub title: String,
    pub kind: String,
    pub from_value: String,
    pub to_value: String,
    pub timestamp: String,
    pub read: bool,
    pub editing_agent: Option<String>,
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE ticket_follows (person TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), PRIMARY KEY(person, ticket_id)); CREATE TABLE inbox_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, from_value TEXT NOT NULL, to_value TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), read INTEGER NOT NULL DEFAULT 0); CREATE INDEX inbox_person_id ON inbox_entries(person, id DESC); PRAGMA user_version = 14;")?;
    Ok(())
}

pub(crate) fn migrate_reminders(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE ticket_reminders (person TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), due_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(person, ticket_id)); PRAGMA user_version = 18;")?;
    Ok(())
}

pub(crate) fn record(
    connection: &Connection,
    ticket_id: &str,
    kind: &str,
    from: &str,
    to: &str,
    agent: Option<&str>,
) -> Result<(), Error> {
    connection.execute("INSERT INTO inbox_entries (person, ticket_id, kind, from_value, to_value, editing_agent) SELECT person, ticket_id, ?2, ?3, ?4, ?5 FROM ticket_follows WHERE ticket_id = ?1", params![ticket_id, kind, from, to, agent])?;
    Ok(())
}

impl Workspace {
    /// Return the scheduled instant in UTC, independent of following.
    pub fn reminder(&self, reference: &str) -> Result<Option<String>, Error> {
        let ticket = self.show_ticket(reference)?;
        Ok(self
            .connection
            .query_row(
                "SELECT due_at FROM ticket_reminders WHERE person = ?1 AND ticket_id = ?2",
                params![LOCAL_PERSON, ticket.id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Set or dismiss a reminder. Every set schedules a new occurrence.
    pub fn set_reminder(&mut self, reference: &str, due_at: Option<&str>) -> Result<(), Error> {
        let due_at = due_at
            .map(|value| {
                chrono::DateTime::parse_from_rfc3339(value)
                    .map(|date| {
                        date.with_timezone(&chrono::Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
                    })
                    .map_err(|_| {
                        Error::InvalidBatch(
                            "reminder time must be an RFC 3339 instant with an explicit offset"
                                .into(),
                        )
                    })
            })
            .transpose()?;
        let ticket = self.show_ticket(reference)?;
        if let Some(due_at) = due_at {
            self.connection.execute("INSERT INTO ticket_reminders (person, ticket_id, due_at, delivered) VALUES (?1, ?2, ?3, 0) ON CONFLICT(person, ticket_id) DO UPDATE SET due_at = excluded.due_at, delivered = 0", params![LOCAL_PERSON, ticket.id, due_at])?;
        } else {
            self.connection.execute(
                "DELETE FROM ticket_reminders WHERE person = ?1 AND ticket_id = ?2",
                params![LOCAL_PERSON, ticket.id],
            )?;
        }
        Ok(())
    }

    pub fn is_following(&self, reference: &str) -> Result<bool, Error> {
        let ticket = self.show_ticket(reference)?;
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM ticket_follows WHERE person = ?1 AND ticket_id = ?2)",
            params![LOCAL_PERSON, ticket.id],
            |row| row.get(0),
        )?)
    }
    pub fn set_following(&mut self, reference: &str, following: bool) -> Result<(), Error> {
        let tx = self.connection.savepoint()?;
        super::transaction_write_lock(&tx)?;
        let number = reference
            .strip_prefix("T-")
            .and_then(|s| s.parse::<i64>().ok());
        let id: String = tx
            .query_row(
                "SELECT id FROM tickets WHERE number = ?1",
                [number],
                |row| row.get(0),
            )
            .map_err(|e| {
                if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
                    Error::NotFound(reference.into())
                } else {
                    e.into()
                }
            })?;
        if following {
            tx.execute(
                "INSERT OR IGNORE INTO ticket_follows (person, ticket_id) VALUES (?1, ?2)",
                params![LOCAL_PERSON, id],
            )?;
        } else {
            tx.execute(
                "DELETE FROM ticket_follows WHERE person = ?1 AND ticket_id = ?2",
                params![LOCAL_PERSON, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn inbox(&self, limit: u32, offset: u32) -> Result<Vec<InboxEntry>, Error> {
        // Insertion and marking delivered commit together, including across processes.
        let tx = self.connection.unchecked_transaction()?;
        super::transaction_write_lock(&tx)?;
        let now: String =
            tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                row.get(0)
            })?;
        tx.execute("INSERT INTO inbox_entries (person, ticket_id, kind, from_value, to_value) SELECT person, ticket_id, 'reminder', '', due_at FROM ticket_reminders WHERE person = ?1 AND delivered = 0 AND julianday(due_at) <= julianday(?2)", params![LOCAL_PERSON, now])?;
        tx.execute("UPDATE ticket_reminders SET delivered = 1 WHERE person = ?1 AND delivered = 0 AND julianday(due_at) <= julianday(?2)", params![LOCAL_PERSON, now])?;
        tx.commit()?;
        let mut stmt = self.connection.prepare("SELECT i.id, t.number, t.title, i.kind, i.from_value, i.to_value, i.timestamp, i.read, i.editing_agent FROM inbox_entries i JOIN tickets t ON t.id = i.ticket_id WHERE i.person = ?1 ORDER BY i.id DESC LIMIT ?2 OFFSET ?3")?;
        let entries = stmt
            .query_map(params![LOCAL_PERSON, limit.min(100), offset], |row| {
                Ok(InboxEntry {
                    id: row.get(0)?,
                    reference: format!("T-{}", row.get::<_, i64>(1)?),
                    title: row.get(2)?,
                    kind: row.get(3)?,
                    from_value: row.get(4)?,
                    to_value: row.get(5)?,
                    timestamp: row.get(6)?,
                    read: row.get(7)?,
                    editing_agent: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }
    /// Materialize due reminders and report whether any inbox entry is unread.
    pub fn has_unread_inbox(&self) -> Result<bool, Error> {
        self.inbox(0, 0)?;
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM inbox_entries WHERE person = ?1 AND read = 0)",
            [LOCAL_PERSON],
            |row| row.get(0),
        )?)
    }
    pub fn set_inbox_read(&mut self, ids: &[i64], read: bool) -> Result<(), Error> {
        if ids.len() > 100 {
            return Err(Error::InvalidBatch(
                "at most 100 inbox entries may be changed at once".into(),
            ));
        }
        let tx = self.connection.savepoint()?;
        for id in ids {
            tx.execute(
                "UPDATE inbox_entries SET read = ?1 WHERE person = ?2 AND id = ?3",
                params![read, LOCAL_PERSON, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
