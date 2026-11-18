use crate::{Error, Workspace};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

// A stable scope for the one local person, independent of editing attribution.
pub(crate) const LOCAL_PERSON: &str = "local-person";

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
    /// True when the update this entry announces has since been deleted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

/// The Inbox as its list and the sidebar count show it, read at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InboxAttention {
    /// Every entry, newest first.
    pub entries: Vec<AttentionEntry>,
    /// Each ticket that an agent moved to In review in an entry: where it stands now, so
    /// an Undo of the review can be checked and restored.
    pub reviews: Vec<ReviewState>,
    /// The reminder each ticket with a reminder entry has now.
    pub reminders: Vec<ReminderState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttentionEntry {
    #[serde(flatten)]
    pub entry: InboxEntry,
    /// The entry still asks the person to act: an agent's move to In review that is
    /// still the ticket's latest status change, or a reminder that is due and not
    /// rescheduled. A review the person restored with Undo needs them again too; the
    /// desktop keeps those restorations and adds them.
    pub needs_you: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewState {
    pub reference: String,
    pub status: crate::Status,
    pub latest_status_change: Option<crate::HistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReminderState {
    pub reference: String,
    pub due_at: String,
}

/// The columns of an `InboxEntry`, for `inbox_entries i JOIN tickets t`.
const ENTRY_COLUMNS: &str = "i.id, t.reference, t.title, i.kind, i.from_value, i.to_value, i.timestamp, i.read, i.editing_agent, (i.kind = 'activity' AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.id = i.from_value))";

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboxEntry> {
    Ok(InboxEntry {
        id: row.get(0)?,
        reference: row.get::<_, String>(1)?,
        title: row.get(2)?,
        kind: row.get(3)?,
        from_value: row.get(4)?,
        to_value: row.get(5)?,
        timestamp: row.get(6)?,
        read: row.get(7)?,
        editing_agent: row.get(8)?,
        deleted: row.get(9)?,
    })
}

/// An entry where an agent, not the person, moved the ticket to In review.
const AGENT_REVIEW: &str = "i.kind = 'status' AND i.to_value = 'In review' AND i.editing_agent IS NOT NULL AND i.editing_agent <> 'local-person'";

/// The `ticket_history` row of the latest status change of the ticket `id`.
fn latest_status_change(id: &str) -> String {
    format!("(SELECT MAX(number) FROM ticket_history WHERE ticket_id = {id} AND kind = 'status')")
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE ticket_follows (person TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), PRIMARY KEY(person, ticket_id)); CREATE TABLE inbox_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, from_value TEXT NOT NULL, to_value TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), read INTEGER NOT NULL DEFAULT 0); CREATE INDEX inbox_person_id ON inbox_entries(person, id DESC);")?;
    Ok(())
}

pub(crate) fn migrate_reminders(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE ticket_reminders (person TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), due_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(person, ticket_id));")?;
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
    // A connection acting as the local person never notifies them of their own
    // unattributed changes; changes attributed to an agent or a source still do.
    connection.execute("INSERT INTO inbox_entries (person, ticket_id, kind, from_value, to_value, editing_agent) SELECT person, ticket_id, ?2, ?3, ?4, ?5 FROM ticket_follows WHERE ticket_id = ?1 AND (?5 IS NOT NULL OR NOT EXISTS (SELECT 1 FROM sqlite_temp_master WHERE name = 'acting_person'))", params![ticket_id, kind, from, to, agent])?;
    Ok(())
}

/// Makes the local person follow a ticket; following twice changes nothing.
pub(crate) fn follow(connection: &rusqlite::Connection, ticket_id: &str) -> Result<(), Error> {
    connection.execute(
        "INSERT OR IGNORE INTO ticket_follows (person, ticket_id) VALUES (?1, ?2)",
        params![LOCAL_PERSON, ticket_id],
    )?;
    Ok(())
}

/// A reminder time as stored: a whole-second UTC instant, so stored times compare
/// correctly as text. Sub-second parts are dropped, and a leap second (`23:59:60`) reads
/// as the second before it.
fn parse_reminder_time(value: &str) -> Result<String, Error> {
    use chrono::{Datelike, Timelike, format::ParseErrorKind};
    let invalid = |reason: String| Error::InvalidReminderTime(reason);
    let instant = chrono::DateTime::parse_from_rfc3339(value).map_err(|error| {
        invalid(match error.kind() {
            ParseErrorKind::OutOfRange | ParseErrorKind::Impossible => {
                format!("'{value}' is not a valid date and time")
            }
            _ if chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").is_ok() => {
                format!(
                    "'{value}' has no UTC offset; add one, for example {value}Z or {value}+07:00"
                )
            }
            _ => format!(
                "'{value}' is not an RFC 3339 time with an offset, for example 2030-01-01T09:00:00Z or 2030-01-01T09:00:00+07:00"
            ),
        })
    })?;
    let utc = instant.with_timezone(&chrono::Utc);
    if !(0..=9999).contains(&utc.year()) {
        return Err(invalid(format!(
            "'{value}' is outside the years 0000 to 9999"
        )));
    }
    let whole = utc.with_nanosecond(0).unwrap_or(utc);
    Ok(whole.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Schedule (`Some`) or remove (`None`) the local person's reminder, and answer the one
/// already delivered. Returns whether the ticket had a reminder before.
fn store_reminder(
    scope: &Connection,
    ticket_id: &str,
    due_at: Option<&str>,
) -> Result<bool, Error> {
    let existed: bool = scope.query_row(
        "SELECT EXISTS(SELECT 1 FROM ticket_reminders WHERE person = ?1 AND ticket_id = ?2)",
        params![LOCAL_PERSON, ticket_id],
        |row| row.get(0),
    )?;
    // Snoozing or dismissing answers the reminder already delivered, so it
    // must not keep claiming to be due in the inbox.
    scope.execute(
        "UPDATE inbox_entries SET read = 1 WHERE person = ?1 AND ticket_id = ?2 AND kind = 'reminder' AND read = 0",
        params![LOCAL_PERSON, ticket_id],
    )?;
    if let Some(due_at) = due_at {
        scope.execute("INSERT INTO ticket_reminders (person, ticket_id, due_at, delivered) VALUES (?1, ?2, ?3, 0) ON CONFLICT(person, ticket_id) DO UPDATE SET due_at = excluded.due_at, delivered = 0", params![LOCAL_PERSON, ticket_id, due_at])?;
    } else {
        scope.execute(
            "DELETE FROM ticket_reminders WHERE person = ?1 AND ticket_id = ?2",
            params![LOCAL_PERSON, ticket_id],
        )?;
    }
    Ok(existed)
}

impl Workspace {
    /// Marks this connection as the local person's own hands (the desktop):
    /// their unattributed changes create no inbox entries for themselves.
    pub fn act_as_local_person(&mut self) -> Result<(), Error> {
        self.connection
            .execute_batch("CREATE TEMP TABLE IF NOT EXISTS acting_person (x INTEGER)")?;
        Ok(())
    }
    /// Return the scheduled instant in UTC, independent of following.
    pub fn reminder(&self, reference: &str) -> Result<Option<String>, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            Ok(self
                .connection
                .query_row(
                    "SELECT due_at FROM ticket_reminders WHERE person = ?1 AND ticket_id = ?2",
                    params![LOCAL_PERSON, ticket.id],
                    |row| row.get(0),
                )
                .optional()?)
        })
    }

    /// Set, reschedule or dismiss a reminder. Every set schedules a new occurrence.
    /// Dismissing a ticket that has no reminder changes nothing; use
    /// [`Workspace::dismiss_reminder`] to learn whether there was one.
    pub fn set_reminder(&mut self, reference: &str, due_at: Option<&str>) -> Result<(), Error> {
        let due_at = due_at.map(parse_reminder_time).transpose()?;
        // A reminder is the person's own, so a ticket in Trash may have one.
        crate::write_scope::run(&self.connection, |scope| {
            let ticket_id = scope.even_if_trashed(reference)?;
            store_reminder(scope, &ticket_id, due_at.as_deref())?;
            Ok(())
        })
    }

    /// Move the ticket's existing reminder to a later time. A ticket without a reminder,
    /// or a time that is not after the current one, is refused: snoozing postpones, it
    /// neither creates a reminder nor brings one forward.
    pub fn snooze_reminder(&mut self, reference: &str, due_at: &str) -> Result<(), Error> {
        let due_at = parse_reminder_time(due_at)?;
        crate::write_scope::run(&self.connection, |scope| {
            let ticket_id = scope.even_if_trashed(reference)?;
            let current: Option<String> = scope
                .query_row(
                    "SELECT due_at FROM ticket_reminders WHERE person = ?1 AND ticket_id = ?2",
                    params![LOCAL_PERSON, ticket_id],
                    |row| row.get(0),
                )
                .optional()?;
            let current = current.ok_or_else(|| Error::NoReminder(reference.to_owned()))?;
            // Stored times are whole-second UTC, but a reminder from an older version may
            // not be, so compare instants rather than strings.
            let is_later = chrono::DateTime::parse_from_rfc3339(&current)
                .map(|current| chrono::DateTime::parse_from_rfc3339(&due_at).ok() > Some(current))
                .unwrap_or(true);
            if !is_later {
                return Err(Error::SnoozeNotLater {
                    reference: reference.to_owned(),
                    current,
                });
            }
            store_reminder(scope, &ticket_id, Some(&due_at))?;
            Ok(())
        })
    }

    /// Remove the ticket's reminder. Returns whether there was one to remove.
    pub fn dismiss_reminder(&mut self, reference: &str) -> Result<bool, Error> {
        crate::write_scope::run(&self.connection, |scope| {
            let ticket_id = scope.even_if_trashed(reference)?;
            store_reminder(scope, &ticket_id, None)
        })
    }

    pub fn is_following(&self, reference: &str) -> Result<bool, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            Ok(self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM ticket_follows WHERE person = ?1 AND ticket_id = ?2)",
                params![LOCAL_PERSON, ticket.id],
                |row| row.get(0),
            )?)
        })
    }
    pub fn set_following(&mut self, reference: &str, following: bool) -> Result<(), Error> {
        // Following is the person's own, so a ticket in Trash may be followed.
        crate::write_scope::run(&self.connection, |scope| {
            let id = scope.even_if_trashed(reference)?;
            if following {
                follow(scope, &id)?;
            } else {
                scope.execute(
                    "DELETE FROM ticket_follows WHERE person = ?1 AND ticket_id = ?2",
                    params![LOCAL_PERSON, id],
                )?;
            }
            Ok(())
        })
    }
    /// Turn reminders that have come due into inbox entries. Reads never do this: the
    /// reminder poll (the desktop) and the inbox command (the CLI) call it. Insertion and
    /// marking delivered commit together, so each reminder is delivered once, including
    /// across processes. It takes the write lock only when a reminder is due.
    pub fn deliver_due_reminders(&mut self) -> Result<(), Error> {
        // Checked with the same comparison the delivery makes, so the two cannot disagree.
        let due: bool = self.connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM ticket_reminders WHERE person = ?1 AND delivered = 0 AND julianday(due_at) <= julianday('now'))")?.query_row([LOCAL_PERSON], |row| row.get(0))?;
        if !due {
            return Ok(());
        }
        crate::write_scope::run(&self.connection, |scope| {
            let now: String =
                scope.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                    row.get(0)
                })?;
            scope.execute("INSERT INTO inbox_entries (person, ticket_id, kind, from_value, to_value) SELECT person, ticket_id, 'reminder', '', due_at FROM ticket_reminders WHERE person = ?1 AND delivered = 0 AND julianday(due_at) <= julianday(?2)", params![LOCAL_PERSON, now])?;
            scope.execute("UPDATE ticket_reminders SET delivered = 1 WHERE person = ?1 AND delivered = 0 AND julianday(due_at) <= julianday(?2)", params![LOCAL_PERSON, now])?;
            Ok(())
        })
    }
    /// How long until the next undelivered reminder comes due: zero when one already
    /// has, `None` when none is set. The desktop sleeps this long before delivering.
    pub fn next_reminder_due_in(&self) -> Result<Option<std::time::Duration>, Error> {
        let seconds: Option<f64> = self.connection.prepare_cached("SELECT MIN((julianday(due_at) - julianday('now')) * 86400.0) FROM ticket_reminders WHERE person = ?1 AND delivered = 0")?.query_row([LOCAL_PERSON], |row| row.get(0))?;
        Ok(seconds.map(|seconds| std::time::Duration::from_secs_f64(seconds.max(0.0))))
    }
    pub fn inbox(&self, limit: u32, offset: u32) -> Result<Vec<InboxEntry>, Error> {
        self.inbox_page(limit, offset, false)
    }
    /// Read newest-first inbox entries. With `unread_only`, the filter applies before
    /// paging so every page holds only unread entries.
    pub fn inbox_page(
        &self,
        limit: u32,
        offset: u32,
        unread_only: bool,
    ) -> Result<Vec<InboxEntry>, Error> {
        let mut stmt = self.connection.prepare_cached(&format!("SELECT {ENTRY_COLUMNS} FROM inbox_entries i JOIN tickets t ON t.id = i.ticket_id WHERE i.person = ?1 AND (?4 = 0 OR i.read = 0) ORDER BY i.id DESC LIMIT ?2 OFFSET ?3"))?;
        let entries = stmt
            .query_map(
                params![LOCAL_PERSON, limit.min(100), offset, unread_only],
                entry_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    /// Every Inbox entry, newest first, with whether it still needs the person, and what
    /// an Undo of a review checks. Three queries, however long the Inbox is.
    pub fn inbox_attention(&self) -> Result<InboxAttention, Error> {
        crate::read_scope::run(&self.connection, |connection| {
            let latest = latest_status_change("t.id");
            let mut statement = connection.prepare_cached(&format!(
                "SELECT {ENTRY_COLUMNS}, CASE
                   WHEN {AGENT_REVIEW} THEN t.status = 'In review' AND EXISTS (
                     SELECT 1 FROM ticket_history h WHERE h.number = {latest} AND h.to_value = 'In review'
                       AND h.editing_agent = i.editing_agent AND julianday(i.timestamp) >= julianday(h.timestamp))
                   WHEN i.kind = 'reminder' THEN EXISTS (
                     SELECT 1 FROM ticket_reminders r WHERE r.person = i.person AND r.ticket_id = i.ticket_id
                       AND r.due_at = i.to_value AND julianday(r.due_at) <= julianday('now'))
                   ELSE 0 END
                 FROM inbox_entries i JOIN tickets t ON t.id = i.ticket_id WHERE i.person = ?1 ORDER BY i.id DESC"
            ))?;
            let entries = statement
                .query_map([LOCAL_PERSON], |row| {
                    Ok(AttentionEntry {
                        entry: entry_from_row(row)?,
                        needs_you: row.get(10)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = connection.prepare_cached(&format!(
                "SELECT t.reference, t.status, h.kind, h.from_value, h.to_value, h.timestamp, h.editing_agent
                   FROM tickets t LEFT JOIN ticket_history h ON h.number = {latest}
                  WHERE t.id IN (SELECT i.ticket_id FROM inbox_entries i WHERE i.person = ?1 AND {AGENT_REVIEW})
                  ORDER BY t.number DESC"
            ))?;
            let reviews = statement
                .query_map([LOCAL_PERSON], |row| {
                    let latest_status_change = match row.get::<_, Option<String>>(2)? {
                        Some(kind) => Some(crate::HistoryEntry {
                            kind,
                            from_value: row.get(3)?,
                            to_value: row.get(4)?,
                            timestamp: row.get(5)?,
                            editing_agent: row.get(6)?,
                        }),
                        None => None,
                    };
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        latest_status_change,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|(reference, status, latest_status_change)| {
                    Ok(ReviewState {
                        reference,
                        status: status.parse()?,
                        latest_status_change,
                    })
                })
                .collect::<Result<Vec<_>, Error>>()?;
            let mut statement = connection.prepare_cached(
                "SELECT t.reference, r.due_at FROM ticket_reminders r JOIN tickets t ON t.id = r.ticket_id
                  WHERE r.person = ?1 AND r.ticket_id IN (SELECT ticket_id FROM inbox_entries WHERE person = ?1 AND kind = 'reminder')
                  ORDER BY t.number DESC",
            )?;
            let reminders = statement
                .query_map([LOCAL_PERSON], |row| {
                    Ok(ReminderState {
                        reference: row.get(0)?,
                        due_at: row.get(1)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(InboxAttention {
                entries,
                reviews,
                reminders,
            })
        })
    }
    /// The person who wrote an update is not told about it: drop the inbox
    /// entries that update produced for them.
    pub fn discard_inbox_for_own_update(&mut self, activity_id: &str) -> Result<(), Error> {
        self.connection.execute(
            "DELETE FROM inbox_entries WHERE person = ?1 AND kind = 'activity' AND from_value = ?2",
            params![LOCAL_PERSON, activity_id],
        )?;
        Ok(())
    }
    pub fn set_inbox_read(&mut self, ids: &[i64], read: bool) -> Result<(), Error> {
        if ids.len() > 100 {
            return Err(Error::InvalidBatch(
                "at most 100 inbox entries may be changed at once".into(),
            ));
        }
        crate::write_scope::run(&self.connection, |scope| {
            // An entry can disappear after it was listed (its Activity or Automation run
            // is deleted), and marking it is then a no-op. An ID that was never issued
            // is a mistake, and nothing changes when any ID is one.
            for id in ids {
                let issued: bool = scope.query_row(
                    "SELECT EXISTS(SELECT 1 FROM inbox_entries WHERE person = ?1 AND id = ?2)
                         OR ?2 BETWEEN 1 AND COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'inbox_entries'), 0)",
                    params![LOCAL_PERSON, id],
                    |row| row.get(0),
                )?;
                if !issued {
                    return Err(Error::InboxEntryNotFound(*id));
                }
            }
            for id in ids {
                scope.execute(
                    "UPDATE inbox_entries SET read = ?1 WHERE person = ?2 AND id = ?3",
                    params![read, LOCAL_PERSON, id],
                )?;
            }
            Ok(())
        })
    }
}
