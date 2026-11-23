//! The retrieved conversation of an external ticket: its source comments and
//! timeline events.
//!
//! These are a mirror of what the source said, kept apart from locally
//! authored notes and from ticketd's own history. They carry the source's
//! authors, never an editing-agent attribution, and nothing here can be written
//! by a client: only refresh replaces them, and a failed refresh keeps what was
//! retrieved earlier.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Conversation, ExternalEventKind, StateCategory};
use crate::{Error, Workspace};

/// One entry of the source conversation, in source chronological order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConversationEntry {
    Comment {
        id: String,
        /// The source's author handle.
        author: String,
        body: String,
        /// Where to view or reply to the comment at the source.
        url: String,
        created_at: String,
        /// Set when the comment was edited after it was written.
        edited_at: Option<String>,
    },
    Event {
        id: String,
        /// `closed`, `reopened`, `assigned` or `unassigned`.
        event: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state_category: Option<StateCategory>,
        actor: Option<String>,
        /// Whom an assignment change concerns.
        subject: Option<String>,
        created_at: String,
    },
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE source_conversation (\
            ticket_id TEXT NOT NULL REFERENCES tickets(id), \
            kind TEXT NOT NULL CHECK (kind IN ('comment', 'event')), \
            entry_id TEXT NOT NULL, \
            position INTEGER NOT NULL, \
            actor TEXT, \
            event TEXT, \
            subject TEXT, \
            body TEXT, \
            url TEXT, \
            created_at TEXT NOT NULL, \
            edited_at TEXT, \
            PRIMARY KEY (ticket_id, kind, entry_id)); \
         ALTER TABLE source_sync ADD COLUMN conversation_updated_at TEXT;",
    )?;
    Ok(())
}

pub(super) fn migrate_state_categories(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "ALTER TABLE source_conversation ADD COLUMN state_category TEXT
             CHECK (state_category IN ('open', 'completed', 'not_planned', 'duplicate', 'unknown'));
         UPDATE source_conversation SET state_category = CASE event
             WHEN 'closed_completed' THEN 'completed'
             WHEN 'closed_not_planned' THEN 'not_planned'
             WHEN 'closed_duplicate' THEN 'duplicate'
             WHEN 'closed' THEN 'unknown'
             WHEN 'reopened' THEN 'open'
         END, event = CASE WHEN event IN ('closed_completed', 'closed_not_planned', 'closed_duplicate')
                          THEN 'closed' ELSE event END
         WHERE kind = 'event' AND event IN (
             'closed_completed', 'closed_not_planned', 'closed_duplicate', 'closed', 'reopened'
         );",
    )?;
    Ok(())
}

fn event_parts(kind: ExternalEventKind) -> (&'static str, Option<StateCategory>) {
    match kind {
        ExternalEventKind::Closed(category) => ("closed", Some(category)),
        ExternalEventKind::Reopened => ("reopened", Some(StateCategory::Open)),
        ExternalEventKind::Assigned => ("assigned", None),
        ExternalEventKind::Unassigned => ("unassigned", None),
    }
}

fn entries_of(conversation: &Conversation) -> Vec<ConversationEntry> {
    let mut entries: Vec<ConversationEntry> = conversation
        .comments
        .iter()
        .map(|comment| ConversationEntry::Comment {
            id: comment.id.clone(),
            author: comment.author.clone(),
            body: comment.body.clone(),
            url: comment.url.clone(),
            created_at: comment.created_at.clone(),
            edited_at: (!comment.updated_at.is_empty() && comment.updated_at != comment.created_at)
                .then(|| comment.updated_at.clone()),
        })
        .chain(conversation.events.iter().map(|event| {
            let (kind, state_category) = event_parts(event.kind);
            ConversationEntry::Event {
                id: event.id.clone(),
                event: kind.to_owned(),
                state_category,
                actor: event.actor.clone(),
                subject: event.subject.clone(),
                created_at: event.created_at.clone(),
            }
        }))
        .collect();
    // Stable: a comment stays ahead of an event written in the same second.
    entries.sort_by(|a, b| created_at(a).cmp(created_at(b)));
    entries
}

fn created_at(entry: &ConversationEntry) -> &str {
    match entry {
        ConversationEntry::Comment { created_at, .. }
        | ConversationEntry::Event { created_at, .. } => created_at,
    }
}

fn key(entry: &ConversationEntry) -> (&'static str, &str) {
    match entry {
        ConversationEntry::Comment { id, .. } => ("comment", id),
        ConversationEntry::Event { id, .. } => ("event", id),
    }
}

pub(crate) fn load(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Vec<ConversationEntry>, Error> {
    let mut statement = connection.prepare(
        "SELECT kind, entry_id, actor, event, subject, body, url, created_at, edited_at, state_category \
         FROM source_conversation WHERE ticket_id = ?1 ORDER BY position, rowid",
    )?;
    let rows = statement
        .query_map([ticket_id], |row| {
            let kind: String = row.get(0)?;
            Ok(if kind == "comment" {
                ConversationEntry::Comment {
                    id: row.get(1)?,
                    author: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    body: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    url: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    created_at: row.get(7)?,
                    edited_at: row.get(8)?,
                }
            } else {
                ConversationEntry::Event {
                    id: row.get(1)?,
                    event: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    state_category: row
                        .get::<_, Option<String>>(9)?
                        .as_deref()
                        .map(StateCategory::parse),
                    actor: row.get(2)?,
                    subject: row.get(4)?,
                    created_at: row.get(7)?,
                }
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A closure time is evidence from the latest lifecycle event, never a sync time.
/// A retained conversation may be stale after an issue changes or a read fails.
fn latest_lifecycle(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Option<(String, String, String)>, Error> {
    let mut statement = connection.prepare(
            "SELECT c.entry_id, c.event, c.created_at FROM source_sync s \
             JOIN source_conversation c ON c.ticket_id = s.ticket_id \
             WHERE s.ticket_id = ?1 AND s.state_category <> 'open' \
               AND s.external_updated_at <> '' AND s.conversation_updated_at = s.external_updated_at \
               AND c.kind = 'event' AND c.event IN ('closed', 'reopened') \
             ORDER BY c.position, c.rowid",
        )?;
    let rows = statement.query_map([ticket_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut latest = None;
    for row in rows {
        let (id, kind, at) = row?;
        // An invalid lifecycle timestamp means we cannot establish which event
        // is latest. Compare instants, since offsets need not sort as strings.
        let Ok(time) = chrono::DateTime::parse_from_rfc3339(&at) else {
            return Ok(None);
        };
        if latest
            .as_ref()
            .is_none_or(|(previous, _, _, _)| time >= *previous)
        {
            latest = Some((time, id, kind, at));
        }
    }
    Ok(latest.map(|(_, id, kind, at)| (id, kind, at)))
}

pub(crate) fn closed_at(connection: &Connection, ticket_id: &str) -> Result<Option<String>, Error> {
    Ok(latest_lifecycle(connection, ticket_id)?
        .and_then(|(_, kind, at)| (kind != "reopened").then_some(at)))
}

/// Present legacy conversations using only current, fresh source evidence. The
/// stored timeline stays untouched, and no earlier closure borrows today's state.
pub(crate) fn present(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Vec<ConversationEntry>, Error> {
    let mut entries = load(connection, ticket_id)?;
    let current: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT s.state_category, CASE WHEN d.last_known = 0 THEN d.locator ELSE NULL END \
             FROM source_sync s LEFT JOIN external_duplicate_targets d ON d.ticket_id = s.ticket_id \
             WHERE s.ticket_id = ?1 AND s.state_category <> 'open' \
               AND s.external_updated_at <> '' AND s.conversation_updated_at = s.external_updated_at",
            [ticket_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let latest = latest_lifecycle(connection, ticket_id)?;
    if let (Some((category, target)), Some((latest_id, kind, _))) = (current, latest)
        && kind == "closed"
        && let Some(ConversationEntry::Event {
            state_category,
            subject,
            ..
        }) = entries
            .iter_mut()
            .find(|entry| matches!(entry, ConversationEntry::Event { id, .. } if id == &latest_id))
    {
        if *state_category == Some(StateCategory::Unknown) {
            *state_category = Some(StateCategory::parse(&category));
        }
        if *state_category == Some(StateCategory::Duplicate) && subject.is_none() {
            *subject = target.filter(|value| !value.is_empty());
        }
    }
    Ok(entries)
}

/// Makes the stored conversation of `ticket_id` equal `conversation`, and notes
/// the issue update time it was read at. Entries the source no longer lists are
/// removed; entries already stored are left as they are. Returns whether
/// anything changed. Runs inside the caller's refresh transaction.
pub(crate) fn store(
    connection: &Connection,
    ticket_id: &str,
    conversation: &Conversation,
    issue_updated_at: &str,
) -> Result<bool, Error> {
    let incoming = entries_of(conversation);
    let existing = load(connection, ticket_id)?;
    let before: HashMap<_, (usize, &ConversationEntry)> = existing
        .iter()
        .enumerate()
        .map(|(position, entry)| (key(entry), (position, entry)))
        .collect();
    let mut changed = existing.len() != incoming.len();
    for (position, entry) in incoming.iter().enumerate() {
        if before.get(&key(entry)) == Some(&(position, entry)) {
            continue;
        }
        changed = true;
        let (kind, id) = key(entry);
        let position = i64::try_from(position).unwrap_or(i64::MAX);
        match entry {
            ConversationEntry::Comment {
                author,
                body,
                url,
                created_at,
                edited_at,
                ..
            } => connection.execute(
                "INSERT INTO source_conversation (ticket_id, kind, entry_id, position, actor, body, url, created_at, edited_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                 ON CONFLICT(ticket_id, kind, entry_id) DO UPDATE SET position = excluded.position, actor = excluded.actor, \
                 body = excluded.body, url = excluded.url, created_at = excluded.created_at, edited_at = excluded.edited_at",
                params![ticket_id, kind, id, position, author, body, url, created_at, edited_at],
            )?,
            ConversationEntry::Event {
                event,
                state_category,
                actor,
                subject,
                created_at,
                ..
            } => connection.execute(
                "INSERT INTO source_conversation (ticket_id, kind, entry_id, position, actor, event, subject, created_at, state_category) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                 ON CONFLICT(ticket_id, kind, entry_id) DO UPDATE SET position = excluded.position, actor = excluded.actor, \
                 event = excluded.event, subject = excluded.subject, created_at = excluded.created_at, state_category = excluded.state_category",
                params![ticket_id, kind, id, position, actor, event, subject, created_at, state_category.map(StateCategory::as_str)],
            )?,
        };
    }
    let kept: std::collections::HashSet<_> = incoming.iter().map(key).collect();
    for entry in &existing {
        if !kept.contains(&key(entry)) {
            let (kind, id) = key(entry);
            connection.execute(
                "DELETE FROM source_conversation WHERE ticket_id = ?1 AND kind = ?2 AND entry_id = ?3",
                params![ticket_id, kind, id],
            )?;
        }
    }
    connection.execute(
        "UPDATE source_sync SET conversation_updated_at = ?2 WHERE ticket_id = ?1",
        params![ticket_id, issue_updated_at],
    )?;
    Ok(changed)
}

/// Whether the conversation of an issue observed at `issue_updated_at` must be
/// read: true for an unknown issue, or an externally owned one whose stored
/// conversation was not read at that update time. Never true for a ticket that
/// is no longer externally owned.
pub(crate) fn needs_reading(
    connection: &Connection,
    provider: &str,
    external_id: &str,
    issue_updated_at: &str,
) -> Result<bool, Error> {
    let row: Option<(Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT o.authority, s.conversation_updated_at FROM external_identities i \
             LEFT JOIN external_ownership o ON o.ticket_id = i.ticket_id \
             LEFT JOIN source_sync s ON s.ticket_id = i.ticket_id \
             WHERE i.provider = ?1 AND i.external_id = ?2",
            params![provider, external_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        None => true,
        Some((authority, marker)) => {
            authority.as_deref() == Some("external")
                && (issue_updated_at.is_empty() || marker.as_deref() != Some(issue_updated_at))
        }
    })
}

impl Workspace {
    /// The source comments and events retrieved for a ticket, oldest first.
    /// Empty for a ticket that never had a source or whose source offers none.
    /// Retained when the source is unavailable or ownership was taken.
    pub fn source_conversation(&self, reference: &str) -> Result<Vec<ConversationEntry>, Error> {
        let id = crate::relationships::id(&self.connection, reference)?;
        present(&self.connection, &id)
    }
}
