//! The Workspace event log: one row per committed ticket change, which Automations
//! are triggered from (ADR 0012). The log is device-local and kept 90 days.
//!
//! Rows are written by triggers on `tickets`, `ticket_tags` and `activities`, so every
//! write path (commands, batches, source refresh, Workspace sync) logs in the
//! transaction that makes the change without knowing about the log. Who made the
//! change is the one thing a trigger cannot see; see [`set_actor`].

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Error, Workspace};

/// Set by the host on every harness process it starts for an Automation run (to the
/// run's ID). The ticketd CLI started with it logs its writes with actor `automation`,
/// which is what keeps an Automation from triggering Automations.
pub const AUTOMATION_RUN_ID_VARIABLE: &str = "TICKETD_AUTOMATION_RUN_ID";

const RETENTION_DAYS: i64 = 90;

/// The ticket fields whose change is a `ticket.updated` event.
const TICKET_FIELDS: [&str; 4] = ["title", "body", "project_id", "plan_id"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkspaceEventType {
    #[serde(rename = "ticket.created")]
    TicketCreated,
    /// The title, description, project or plan changed.
    #[serde(rename = "ticket.updated")]
    TicketUpdated,
    #[serde(rename = "ticket.status_changed")]
    TicketStatusChanged,
    #[serde(rename = "ticket.tag_added")]
    TicketTagAdded,
    #[serde(rename = "ticket.tag_removed")]
    TicketTagRemoved,
    /// An authored update was posted on the ticket.
    #[serde(rename = "activity.created")]
    ActivityCreated,
}

/// Who made a logged change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceActor {
    Person,
    /// An Automation's own step, or the CLI run by an Automation run's agent.
    Automation,
    /// A refresh of an external ticket source (such as GitHub) brought the change
    /// in. It starts Automations like a change made here.
    Sync,
    /// Workspace sync applied a change made on another desktop, whoever made it
    /// there. It starts no Automation here: each desktop reacts only to changes
    /// made on it and to its ticket sources (ADR 0012; provisional).
    WorkspaceSync,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceEvent {
    /// Grows with every event and is never reused: the cursor a reader keeps.
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: WorkspaceEventType,
    pub at: String,
    pub ticket_id: String,
    /// What changed, before and after, as an object of the changed fields. A created
    /// ticket, an added tag and a posted update have no previous value; a removed tag
    /// has no current one.
    pub previous: Option<serde_json::Value>,
    pub current: Option<serde_json::Value>,
    pub actor: WorkspaceActor,
}

/// Step 67. `ticket.updated` lists only the fields that differ, and `IS NOT` keeps a
/// write that changes nothing out of the log.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    create(connection)?;
    connection.execute_batch("PRAGMA user_version = 73;")?;
    Ok(())
}

/// Format version 81: what Workspace sync applies is logged with an actor of its
/// own, `workspace_sync`, apart from a ticket source's `sync`. Events already
/// logged keep the actor they have.
pub(crate) fn migrate_workspace_sync_actor(connection: &Connection) -> Result<(), Error> {
    create(connection)
}

/// The log and its triggers, as they are now. Safe to run again.
fn create(connection: &Connection) -> Result<(), Error> {
    let pairs = TICKET_FIELDS
        .map(|field| format!("SELECT '{field}' AS field, OLD.{field} AS old, NEW.{field} AS new"))
        .join(" UNION ALL ");
    let differs = TICKET_FIELDS
        .map(|field| format!("OLD.{field} IS NOT NEW.{field}"))
        .join(" OR ");
    let created = created_values("NEW");
    // Workspace sync applies incoming files with capture switched off; that flag also
    // names the actor. Other actors are set per connection (`set_actor`).
    let log = "INSERT INTO workspace_events (type, ticket_id, previous, current, actor) SELECT";
    let actor =
        "CASE (SELECT applying FROM sync_capture) WHEN 1 THEN 'workspace_sync' ELSE 'person' END";
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS workspace_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            ticket_id TEXT NOT NULL REFERENCES tickets(id),
            previous TEXT,
            current TEXT,
            actor TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS workspace_events_at ON workspace_events(at);
         DROP TRIGGER IF EXISTS workspace_event_ticket_created;
         DROP TRIGGER IF EXISTS workspace_event_ticket_updated;
         DROP TRIGGER IF EXISTS workspace_event_ticket_status_changed;
         DROP TRIGGER IF EXISTS workspace_event_ticket_tag_added;
         DROP TRIGGER IF EXISTS workspace_event_ticket_tag_removed;
         DROP TRIGGER IF EXISTS workspace_event_activity_created;
         CREATE TRIGGER workspace_event_ticket_created AFTER INSERT ON tickets BEGIN
             {log} 'ticket.created', NEW.id, NULL, {created}, {actor};
         END;
         CREATE TRIGGER workspace_event_ticket_updated AFTER UPDATE OF title, body, project_id, plan_id ON tickets
         WHEN {differs} BEGIN
             {log} 'ticket.updated', NEW.id,
                 (SELECT json_group_object(field, old) FROM ({pairs}) WHERE old IS NOT new),
                 (SELECT json_group_object(field, new) FROM ({pairs}) WHERE old IS NOT new),
                 {actor};
         END;
         CREATE TRIGGER workspace_event_ticket_status_changed AFTER UPDATE OF status ON tickets
         WHEN OLD.status IS NOT NEW.status BEGIN
             {log} 'ticket.status_changed', NEW.id, json_object('status', OLD.status),
                 json_object('status', NEW.status), {actor};
         END;
         CREATE TRIGGER workspace_event_ticket_tag_added AFTER INSERT ON ticket_tags BEGIN
             {log} 'ticket.tag_added', NEW.ticket_id, NULL, json_object('tag', NEW.tag_name), {actor};
         END;
         CREATE TRIGGER workspace_event_ticket_tag_removed AFTER DELETE ON ticket_tags BEGIN
             {log} 'ticket.tag_removed', OLD.ticket_id, json_object('tag', OLD.tag_name), NULL, {actor};
         END;
         CREATE TRIGGER workspace_event_activity_created AFTER INSERT ON activities BEGIN
             {log} 'activity.created', NEW.ticket_id, NULL,
                 json_object('id', NEW.id, 'brief', NEW.brief, 'editing_agent', NEW.editing_agent),
                 {actor};
         END;"
    ))?;
    Ok(())
}

/// What a `ticket.created` event carries, read from the ticket row named `row`.
fn created_values(row: &str) -> String {
    format!(
        "json_object('title', {row}.title, 'body', {row}.body, 'status', {row}.status, \
         'project_id', {row}.project_id, 'plan_id', {row}.plan_id)"
    )
}

/// The actor this connection's writes are logged with, in place of the default
/// (`person`, or `workspace_sync` while Workspace sync applies incoming files).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Acting {
    Automation,
    Sync,
    /// Log nothing: the first import of a ticket source.
    Silent,
}

impl Acting {
    fn as_str(self) -> &'static str {
        match self {
            Self::Automation => "automation",
            Self::Sync => "sync",
            Self::Silent => "silent",
        }
    }
}

/// The actor set on this connection, if any.
pub(crate) fn actor(connection: &Connection) -> Result<Option<Acting>, Error> {
    let marked: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_temp_master WHERE name = 'workspace_event_actor')",
        [],
        |row| row.get(0),
    )?;
    if !marked {
        return Ok(None);
    }
    let kind: Option<String> = connection
        .query_row("SELECT kind FROM workspace_event_actor", [], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(kind.map(|kind| match kind.as_str() {
        "automation" => Acting::Automation,
        "sync" => Acting::Sync,
        _ => Acting::Silent,
    }))
}

/// Set or clear the actor of this connection's later writes. Connection-scoped like
/// `act_for_chat`: a TEMP trigger restamps each row the permanent triggers log, which
/// keeps every write path unchanged. Set inside a savepoint, it is undone with it.
pub(crate) fn set_actor(connection: &Connection, acting: Option<Acting>) -> Result<(), Error> {
    // Inside a trigger body SQLite rejects a schema-qualified table, hence the
    // unqualified `workspace_events`.
    connection.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS workspace_event_actor (kind TEXT NOT NULL);
         DELETE FROM workspace_event_actor;
         CREATE TEMP TRIGGER IF NOT EXISTS workspace_event_actor_applied AFTER INSERT ON main.workspace_events BEGIN
             UPDATE workspace_events SET actor = (SELECT kind FROM workspace_event_actor)
             WHERE id = NEW.id AND EXISTS (SELECT 1 FROM workspace_event_actor WHERE kind <> 'silent');
             DELETE FROM workspace_events
             WHERE id = NEW.id AND EXISTS (SELECT 1 FROM workspace_event_actor WHERE kind = 'silent');
         END;",
    )?;
    if let Some(acting) = acting {
        connection.execute(
            "INSERT INTO workspace_event_actor (kind) VALUES (?1)",
            [acting.as_str()],
        )?;
    }
    Ok(())
}

/// The id of the newest event ever logged, 0 before the first. Expiry does not lower it.
pub(crate) fn head(connection: &Connection) -> Result<i64, Error> {
    Ok(connection
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

/// Make one event of each ticket created after `since`. Several write paths create a
/// ticket and then fill it in (create with content, a source import, an incoming sync
/// file); without this a new ticket would also read as updated and as changing status.
/// The created event takes the values the ticket ended up with. Call it at the end of
/// such a write, inside its transaction, with the head read at its start.
pub(crate) fn fold_into_creation(connection: &Connection, since: i64) -> Result<(), Error> {
    let created = created_values("tickets");
    connection.execute(
        "DELETE FROM workspace_events WHERE id > ?1 AND type IN ('ticket.updated', 'ticket.status_changed')
         AND ticket_id IN (SELECT ticket_id FROM workspace_events WHERE id > ?1 AND type = 'ticket.created')",
        [since],
    )?;
    connection.execute(
        &format!(
            "UPDATE workspace_events SET current = (SELECT {created} FROM tickets WHERE tickets.id = ticket_id)
             WHERE id > ?1 AND type = 'ticket.created'"
        ),
        [since],
    )?;
    Ok(())
}

fn parse<T: serde::de::DeserializeOwned>(text: String) -> Result<T, Error> {
    Ok(serde_json::from_value(serde_json::Value::String(text))?)
}

/// `Workspace::workspace_events_after`, for a caller inside a transaction.
pub(crate) fn after(
    connection: &Connection,
    cursor: i64,
    limit: u32,
) -> Result<Vec<WorkspaceEvent>, Error> {
    let mut statement = connection.prepare(
        "SELECT id, type, at, ticket_id, previous, current, actor FROM workspace_events
             WHERE id > ?1 ORDER BY id LIMIT ?2",
    )?;
    let rows = statement
        .query_map(params![cursor, limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, kind, at, ticket_id, previous, current, actor)| {
            let values =
                |text: Option<String>| text.map(|text| serde_json::from_str(&text)).transpose();
            Ok(WorkspaceEvent {
                id,
                kind: parse(kind)?,
                at,
                ticket_id,
                previous: values(previous)?,
                current: values(current)?,
                actor: parse(actor)?,
            })
        })
        .collect()
}

impl Workspace {
    /// Events logged after `cursor` (an event id, 0 for the start), oldest first, at
    /// most `limit`. A reader keeps the id of the last event it handled as its cursor.
    pub fn workspace_events_after(
        &self,
        cursor: i64,
        limit: u32,
    ) -> Result<Vec<WorkspaceEvent>, Error> {
        after(&self.connection, cursor, limit)
    }

    /// The id of the newest event ever logged: where a reader that wants only what
    /// happens from now on starts its cursor.
    pub fn workspace_event_head(&self) -> Result<i64, Error> {
        head(&self.connection)
    }

    /// Marks this connection as writing inside an Automation run (the CLI run by the
    /// run's agent, see `AUTOMATION_RUN_ID_VARIABLE`, or an Automation's own step):
    /// what it changes is logged with actor `automation`.
    pub fn act_for_automation(&mut self) -> Result<(), Error> {
        set_actor(&self.connection, Some(Acting::Automation))
    }

    /// The housekeeping a host runs at launch and once a day: removes replaced versions
    /// older than 30 days, and Workspace events and finished Automation runs more than
    /// 90 days before `now` (the database clock when omitted).
    pub fn upkeep(&mut self, now: Option<&str>) -> Result<(), Error> {
        self.expire_versions(now)?;
        let now = crate::source::clock(&self.connection, now)?;
        self.connection.execute(
            "DELETE FROM workspace_events WHERE julianday(at) < julianday(?1) - ?2",
            params![now, RETENTION_DAYS],
        )?;
        crate::automation_runs::expire(&self.connection, &now)?;
        Ok(())
    }
}
