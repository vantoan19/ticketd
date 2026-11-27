//! Sub-agents of a Chat (format 105): helper agents the Chat's harness starts by itself.
//!
//! A **sub-agent** is one record keyed by (Chat, native ID): Claude's task ID, Codex's
//! child thread ID, Antigravity's child conversation ID. It keeps the sub-agent that
//! started it (`parent`, for nesting), the Step that started it (`tool_id`), whether it
//! runs in the background, and the harness's own words about it as a JSON payload (the
//! description, type, prompt and model as the harness said them). Title, type and model
//! are read from the payload when a view is built, as Step kinds are, so nothing stored
//! here has to change when the wording does.
//!
//! Each time the harness starts or resumes it there is a **run**, a row of its own in the
//! Chat's history (it has a `position`, so it shows where it began). The record's status
//! is its latest run's. A resume adds a run; output of an earlier run that arrives late is
//! dropped.
//!
//! The Steps and approvals a sub-agent owns are in `chat_tools` and `chat_interactions`
//! (`sub_agent_id` is the native ID); which run one belongs to is told by its position
//! between the runs' positions.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Error, NOW, invalid, log, name, named};

/// How one run of a sub-agent stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatSubAgentState {
    Running,
    Completed,
    Failed,
    /// Stopped: `ChatSubAgentRun::stopped_by` says by whom.
    Stopped,
    /// ticketd quit while it ran: nothing says whether it still does.
    Lost,
}

/// Who stopped a stopped run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatSubAgentStopper {
    Person,
    Ticketd,
    MainAgent,
}

/// One run of a sub-agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSubAgentRun {
    pub id: String,
    /// Orders the run among the Chat's history.
    pub position: i64,
    /// The native ID of its sub-agent.
    pub sub_agent: String,
    /// 1 for the first run; a resume adds one.
    pub run: i64,
    /// The harness's own ID for the run, when it names runs.
    pub native_run_id: Option<String>,
    /// The turn that was active when the run began, if any.
    pub turn_id: Option<String>,
    /// For a run after the first, the Step that resumed it (the main agent's `SendMessage`);
    /// the first run's is the sub-agent's own `tool_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    pub state: ChatSubAgentState,
    pub stopped_by: Option<ChatSubAgentStopper>,
    /// For `Ticketd`: the host's stop reason key (`turned_off`, `time_limit`, ...).
    pub stop_reason: Option<String>,
    /// What the harness said went wrong, for a run that failed.
    pub detail: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

/// A sub-agent of a Chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSubAgent {
    pub id: String,
    /// The harness's ID for it, unique within the Chat.
    pub native_id: String,
    /// The native ID of the sub-agent that started it; `None` when the main agent did.
    pub parent: Option<String>,
    /// The Step (a `chat_tools` ID) that started it, when the harness said.
    pub tool_id: Option<String>,
    /// It runs in the background: its work can outlast the turn it started in.
    pub background: bool,
    /// What the harness said about it, as one JSON object: `description`,
    /// `subagent_type`, `prompt`, `model`. Merged over as more is reported.
    pub payload: String,
    pub created_at: String,
    /// Every run, oldest first.
    pub runs: Vec<ChatSubAgentRun>,
}

impl ChatSubAgent {
    /// The latest run: where the sub-agent stands.
    pub fn latest(&self) -> Option<&ChatSubAgentRun> {
        self.runs.last()
    }

    /// A string the harness reported about it, from the payload.
    pub fn said(&self, key: &str) -> Option<String> {
        let payload: Value = serde_json::from_str(&self.payload).ok()?;
        payload.get(key)?.as_str().map(str::to_owned)
    }
}

/// What a harness observation does to a sub-agent record. See [`super::ChatObservation`].
pub(super) enum Change {
    Started {
        native_id: String,
        parent: Option<String>,
        tool_id: Option<String>,
        turn_id: Option<String>,
        native_run_id: Option<String>,
        background: bool,
        payload: String,
    },
    Updated {
        native_id: String,
        native_run_id: Option<String>,
        background: Option<bool>,
        payload: Option<String>,
    },
    Ended {
        native_id: String,
        native_run_id: Option<String>,
        state: ChatSubAgentState,
        stopped_by: Option<ChatSubAgentStopper>,
        stop_reason: Option<String>,
        detail: Option<String>,
    },
}

/// Format 105, with the sub-agent tables: they are part of the same step because format 105
/// has not been released. Like every migration step it may run again.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS chat_sub_agents (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), native_id TEXT NOT NULL, parent_native_id TEXT, tool_id TEXT, background INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ({NOW}), UNIQUE(chat_id, native_id));
         CREATE TABLE IF NOT EXISTS chat_sub_agent_runs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), sub_agent_id TEXT NOT NULL REFERENCES chat_sub_agents(id), position INTEGER NOT NULL UNIQUE, run INTEGER NOT NULL, native_run_id TEXT, turn_id TEXT REFERENCES chat_turns(id), state TEXT NOT NULL, stopped_by TEXT, stop_reason TEXT, detail TEXT, started_at TEXT NOT NULL DEFAULT ({NOW}), ended_at TEXT, UNIQUE(sub_agent_id, run));
         CREATE INDEX IF NOT EXISTS chat_sub_agents_chat ON chat_sub_agents(chat_id);
         CREATE INDEX IF NOT EXISTS chat_sub_agent_runs_chat ON chat_sub_agent_runs(chat_id, position);"
    ))?;
    // A turn the person did not start says who did, and a Stop of sub-agents with no turn
    // says how many it stopped (it is a notice with a count).
    for (table, column, definition) in [
        ("chat_turns", "origin_by", "TEXT"),
        ("chat_turns", "origin_sub_agent", "TEXT"),
        ("chat_notices", "sub_agents_stopped", "INTEGER"),
        // The sub-agents that lost contact and the next message has not told the harness
        // about (a JSON array of native IDs), and what a message told it.
        ("chats", "restart_notice", "TEXT"),
        ("chat_messages", "note", "TEXT"),
        // The Step that resumed a run after the first.
        ("chat_sub_agent_runs", "tool_id", "TEXT"),
    ] {
        let has: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !has {
            connection.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition};"
            ))?;
        }
    }
    Ok(())
}

pub(super) fn record_id(chat_id: &str, native_id: &str) -> String {
    format!("{chat_id}:sub-agent:{native_id}")
}

const RUN_COLUMNS: &str = "id, position, sub_agent_id, run, native_run_id, turn_id, state, stopped_by, stop_reason, detail, started_at, ended_at, tool_id";

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<ChatSubAgentRun> {
    Ok(ChatSubAgentRun {
        id: row.get(0)?,
        position: row.get(1)?,
        // The record's ID is replaced by its native ID by the reader.
        sub_agent: row.get(2)?,
        run: row.get(3)?,
        native_run_id: row.get(4)?,
        turn_id: row.get(5)?,
        state: named(row, 6)?,
        stopped_by: row
            .get::<_, Option<String>>(7)?
            .map(|value| {
                serde_json::from_value(Value::String(value)).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        7,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?,
        stop_reason: row.get(8)?,
        detail: row.get(9)?,
        started_at: row.get(10)?,
        ended_at: row.get(11)?,
        tool_id: row.get(12)?,
    })
}

/// One run, by its ID.
pub(super) fn read_run(
    connection: &Connection,
    id: &str,
) -> Result<Option<ChatSubAgentRun>, Error> {
    let run = connection
        .query_row(
            &format!(
                "SELECT {RUN_COLUMNS}, (SELECT native_id FROM chat_sub_agents WHERE id = sub_agent_id) FROM chat_sub_agent_runs WHERE id = ?1"
            ),
            [id],
            |row| Ok((run_from_row(row)?, row.get::<_, String>(13)?)),
        )
        .optional()?;
    Ok(run.map(|(mut run, native)| {
        run.sub_agent = native;
        run
    }))
}

fn read_runs(connection: &Connection, record: &str) -> Result<Vec<ChatSubAgentRun>, Error> {
    let mut statement = connection.prepare(&format!(
        "SELECT {RUN_COLUMNS}, (SELECT native_id FROM chat_sub_agents WHERE id = sub_agent_id) FROM chat_sub_agent_runs WHERE sub_agent_id = ?1 ORDER BY run"
    ))?;
    let runs = statement
        .query_map([record], |row| {
            Ok((run_from_row(row)?, row.get::<_, String>(13)?))
        })?
        .map(|row| {
            row.map(|(mut run, native)| {
                run.sub_agent = native;
                run
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(runs)
}

fn record_from_row(row: &Row<'_>) -> rusqlite::Result<ChatSubAgent> {
    Ok(ChatSubAgent {
        id: row.get(0)?,
        native_id: row.get(1)?,
        parent: row.get(2)?,
        tool_id: row.get(3)?,
        background: row.get(4)?,
        payload: row.get(5)?,
        created_at: row.get(6)?,
        runs: Vec::new(),
    })
}

const RECORD_COLUMNS: &str =
    "id, native_id, parent_native_id, tool_id, background, payload, created_at";

/// One sub-agent with its runs, by its record ID.
pub(super) fn read_record(
    connection: &Connection,
    id: &str,
) -> Result<Option<ChatSubAgent>, Error> {
    let record = connection
        .query_row(
            &format!("SELECT {RECORD_COLUMNS} FROM chat_sub_agents WHERE id = ?1"),
            [id],
            record_from_row,
        )
        .optional()?;
    record
        .map(|mut record| {
            record.runs = read_runs(connection, &record.id)?;
            Ok(record)
        })
        .transpose()
}

/// Every sub-agent of the Chat, oldest first, each with its runs.
pub(super) fn read_all(connection: &Connection, chat_id: &str) -> Result<Vec<ChatSubAgent>, Error> {
    let mut statement = connection.prepare(&format!(
        "SELECT {RECORD_COLUMNS} FROM chat_sub_agents WHERE chat_id = ?1 ORDER BY rowid"
    ))?;
    let records = statement
        .query_map([chat_id], record_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    records
        .into_iter()
        .map(|mut record| {
            record.runs = read_runs(connection, &record.id)?;
            Ok(record)
        })
        .collect()
}

fn merged(kept: &str, incoming: &str) -> Result<String, Error> {
    let mut payload: Map<String, Value> = serde_json::from_str(kept).unwrap_or_default();
    let Value::Object(incoming) = serde_json::from_str(incoming)? else {
        return Err(invalid("a sub-agent's payload must be a JSON object"));
    };
    for (key, value) in incoming {
        if !value.is_null() {
            payload.insert(key, value);
        }
    }
    Ok(Value::Object(payload).to_string())
}

/// The newest run of a record, with its record ID.
fn latest_run(connection: &Connection, record: &str) -> Result<Option<ChatSubAgentRun>, Error> {
    Ok(read_runs(connection, record)?.pop())
}

/// Whether `incoming` is the run `latest` already is: the harness names runs and the names
/// match, or it names none and the run has not ended.
fn same_run(latest: &ChatSubAgentRun, incoming: &Option<String>) -> bool {
    match (&latest.native_run_id, incoming) {
        (Some(kept), Some(incoming)) => kept == incoming,
        (None, None) => latest.state == ChatSubAgentState::Running,
        (None, Some(_)) => latest.state == ChatSubAgentState::Running,
        (Some(_), None) => latest.state == ChatSubAgentState::Running,
    }
}

/// Whether a frame naming run `incoming` is late: the run it names sorts before the
/// latest one (the harness orders its run IDs by when they opened).
fn late(latest: &ChatSubAgentRun, incoming: &Option<String>) -> bool {
    matches!((&latest.native_run_id, incoming), (Some(kept), Some(incoming)) if incoming < kept)
}

fn touch_record(connection: &Connection, chat_id: &str, record: &str) -> Result<(), Error> {
    log(connection, chat_id, "sub_agent", record)?;
    Ok(())
}

/// Applies one observation to the Chat's sub-agents.
pub(super) fn observe(connection: &Connection, chat_id: &str, change: Change) -> Result<(), Error> {
    match change {
        Change::Started {
            native_id,
            parent,
            tool_id,
            turn_id,
            native_run_id,
            background,
            payload,
        } => {
            if let Some(turn_id) = &turn_id {
                super::require_turn(connection, chat_id, turn_id)?;
            }
            let record = record_id(chat_id, &native_id);
            let stored: Option<String> = connection
                .query_row(
                    "SELECT payload FROM chat_sub_agents WHERE id = ?1",
                    [&record],
                    |row| row.get(0),
                )
                .optional()?;
            let payload = merged(stored.as_deref().unwrap_or("{}"), &payload)?;
            if stored.is_none() {
                connection.execute(
                    "INSERT INTO chat_sub_agents (id, chat_id, native_id, parent_native_id, tool_id, background, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![record, chat_id, native_id, parent, tool_id, background, payload],
                )?;
            } else {
                connection.execute(
                    "UPDATE chat_sub_agents SET background = ?2, payload = ?3 WHERE id = ?1",
                    params![record, background, payload],
                )?;
            }
            // The record first: a follower that reads a run knows whose it is.
            touch_record(connection, chat_id, &record)?;
            let latest = latest_run(connection, &record)?;
            match latest {
                Some(latest)
                    if same_run(&latest, &native_run_id) || late(&latest, &native_run_id) => {}
                latest => {
                    let run = latest.map_or(1, |latest| latest.run + 1);
                    let id = format!("{record}:run-{run}");
                    let position = log(connection, chat_id, "sub_agent_run", &id)?;
                    connection.execute(
                        "INSERT INTO chat_sub_agent_runs (id, chat_id, sub_agent_id, position, run, native_run_id, turn_id, tool_id, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running')",
                        params![
                            id,
                            chat_id,
                            record,
                            position,
                            run,
                            native_run_id,
                            turn_id,
                            tool_id.filter(|_| run > 1)
                        ],
                    )?;
                    // Resumed before the person wrote: there is nothing to tell about it.
                    forget(connection, chat_id, &native_id)?;
                }
            }
            Ok(())
        }
        Change::Updated {
            native_id,
            native_run_id,
            background,
            payload,
        } => {
            let record = record_id(chat_id, &native_id);
            let Some(stored) = connection
                .query_row(
                    "SELECT payload FROM chat_sub_agents WHERE id = ?1",
                    [&record],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                return Ok(());
            };
            if let Some(latest) = latest_run(connection, &record)?
                && late(&latest, &native_run_id)
            {
                return Ok(());
            }
            let payload = match payload {
                Some(payload) => merged(&stored, &payload)?,
                None => stored.clone(),
            };
            if payload == stored && background.is_none() {
                return Ok(());
            }
            connection.execute(
                "UPDATE chat_sub_agents SET payload = ?2, background = COALESCE(?3, background) WHERE id = ?1",
                params![record, payload, background],
            )?;
            touch_record(connection, chat_id, &record)
        }
        Change::Ended {
            native_id,
            native_run_id,
            state,
            stopped_by,
            stop_reason,
            detail,
        } => {
            if state == ChatSubAgentState::Running {
                return Err(invalid("a sub-agent run cannot end as running"));
            }
            let record = record_id(chat_id, &native_id);
            let Some(latest) = latest_run(connection, &record)? else {
                return Ok(());
            };
            if latest.state != ChatSubAgentState::Running || late(&latest, &native_run_id) {
                return Ok(());
            }
            end_run(
                connection,
                chat_id,
                &record,
                &latest.id,
                (state, stopped_by, stop_reason, detail),
            )
        }
    }
}

/// How a run ended: its state, who stopped it, why ticketd stopped it, and what went wrong.
type Ending = (
    ChatSubAgentState,
    Option<ChatSubAgentStopper>,
    Option<String>,
    Option<String>,
);

fn end_run(
    connection: &Connection,
    chat_id: &str,
    record: &str,
    run: &str,
    (state, stopped_by, stop_reason, detail): Ending,
) -> Result<(), Error> {
    let stopped_by = match state {
        ChatSubAgentState::Stopped => stopped_by.map(name).transpose()?,
        _ => None,
    };
    let stop_reason = stopped_by.as_ref().and(stop_reason);
    let detail = detail
        .filter(|_| state == ChatSubAgentState::Failed)
        .map(|detail| {
            detail
                .chars()
                .take(super::CHAT_NOTICE_LIMIT)
                .collect::<String>()
        });
    connection.execute(
        &format!(
            "UPDATE chat_sub_agent_runs SET state = ?2, stopped_by = ?3, stop_reason = ?4, detail = ?5, ended_at = {NOW} WHERE id = ?1"
        ),
        params![run, name(state)?, stopped_by, stop_reason, detail],
    )?;
    // The record first: a follower that reads the run knows whose it is.
    touch_record(connection, chat_id, record)?;
    log(connection, chat_id, "sub_agent_run", run)?;
    Ok(())
}

/// A turn ended: the foreground sub-agent runs it started that still run end with it,
/// the way the turn ended. A run in the background outlasts the turn.
pub(super) fn end_turn(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    state: super::ChatTurnState,
    ending: Option<&str>,
) -> Result<(), Error> {
    use super::ChatTurnState as Turn;
    let (end, by, reason) = match (ending, state) {
        (Some("stopped_by_person"), _) => (
            ChatSubAgentState::Stopped,
            Some(ChatSubAgentStopper::Person),
            None,
        ),
        (Some(ending), _) if ending.starts_with("stopped_by_ticketd:") => (
            ChatSubAgentState::Stopped,
            Some(ChatSubAgentStopper::Ticketd),
            ending
                .strip_prefix("stopped_by_ticketd:")
                .map(str::to_owned),
        ),
        (Some("contact_lost"), _) | (_, Turn::Unknown) => (ChatSubAgentState::Lost, None, None),
        (_, Turn::Failed) => (ChatSubAgentState::Failed, None, None),
        (_, Turn::Interrupted) => (
            ChatSubAgentState::Stopped,
            Some(ChatSubAgentStopper::Person),
            None,
        ),
        (_, Turn::Completed | Turn::Active) => (ChatSubAgentState::Completed, None, None),
    };
    let mut statement = connection.prepare(
        "SELECT r.id, r.sub_agent_id FROM chat_sub_agent_runs r JOIN chat_sub_agents a ON a.id = r.sub_agent_id
         WHERE r.chat_id = ?1 AND r.turn_id = ?2 AND r.state = 'running' AND a.background = 0",
    )?;
    let running = statement
        .query_map(params![chat_id, turn_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (run, record) in running {
        end_run(
            connection,
            chat_id,
            &record,
            &run,
            (end, by, reason.clone(), None),
        )?;
    }
    Ok(())
}

/// Contact with the harness was lost: nothing says whether a sub-agent still runs. The Chat
/// then holds a notice for the next message to tell the harness which ones.
pub(super) fn lose_contact(connection: &Connection, chat_id: &str) -> Result<(), Error> {
    let mut statement = connection.prepare(
        "SELECT r.id, r.sub_agent_id, a.native_id FROM chat_sub_agent_runs r JOIN chat_sub_agents a ON a.id = r.sub_agent_id
         WHERE r.chat_id = ?1 AND r.state = 'running' ORDER BY r.position",
    )?;
    let running = statement
        .query_map([chat_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let mut lost = Vec::new();
    for (run, record, native_id) in running {
        end_run(
            connection,
            chat_id,
            &record,
            &run,
            (ChatSubAgentState::Lost, None, None, None),
        )?;
        if !lost.contains(&native_id) {
            lost.push(native_id);
        }
    }
    if lost.is_empty() {
        return Ok(());
    }
    let mut notice = notice(connection, chat_id)?;
    notice.retain(|kept| !lost.contains(kept));
    // What was lost earlier and not told yet stays first.
    notice.extend(lost);
    set_notice(connection, chat_id, &notice)
}

/// The native IDs of the sub-agents the Chat holds a notice for, oldest first.
pub(super) fn notice(connection: &Connection, chat_id: &str) -> Result<Vec<String>, Error> {
    let kept: Option<String> = connection
        .query_row(
            "SELECT restart_notice FROM chats WHERE id = ?1",
            [chat_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(kept
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

pub(super) fn set_notice(
    connection: &Connection,
    chat_id: &str,
    native_ids: &[String],
) -> Result<(), Error> {
    let text = (!native_ids.is_empty()).then(|| Value::from(native_ids).to_string());
    connection.execute(
        "UPDATE chats SET restart_notice = ?2 WHERE id = ?1",
        params![chat_id, text],
    )?;
    log(connection, chat_id, "chat", chat_id)?;
    Ok(())
}

/// The sub-agent is not lost any more: the notice stops naming it.
fn forget(connection: &Connection, chat_id: &str, native_id: &str) -> Result<(), Error> {
    let kept = notice(connection, chat_id)?;
    if kept.iter().any(|id| id == native_id) {
        let kept: Vec<String> = kept.into_iter().filter(|id| id != native_id).collect();
        set_notice(connection, chat_id, &kept)?;
    }
    Ok(())
}

impl ChatSubAgent {
    /// What the harness called the work (the first line of its description); failing that
    /// the kind of sub-agent it is.
    pub fn title(&self) -> String {
        let said = |key: &str| self.said(key).filter(|said| !said.trim().is_empty());
        said("description")
            .map(|description| {
                description
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            })
            .or_else(|| said("subagent_type"))
            .unwrap_or_else(|| "Sub-agent".to_owned())
    }
}
