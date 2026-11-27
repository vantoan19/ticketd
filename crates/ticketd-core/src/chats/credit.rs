//! Which agent of a Chat made a status change or an Activity through the `ticketd` CLI
//! (format 105).
//!
//! The CLI already tags what a Chat's harness writes with the Chat. This adds the agent.
//!
//! * **Exact.** A harness that names each call (Codex's `CODEX_TOOL_CALL_ID`, the item ID of
//!   the command Step) has the CLI record that key with the write. The Step with that native
//!   ID says who ran it.
//! * **Commit order.** Otherwise the host tells the core which shell Steps ran and what
//!   plain `ticketd` calls each names. A **window** is the stretch of the two record feeds
//!   (status history and Activities, both only ever growing) between a shell Step starting
//!   and ending. A write is placed by the windows it falls in: one window, its owner;
//!   several, the one whose named call could be this write, if only one could; otherwise the
//!   Chat, with the sub-agent unknown. A write outside every window stays with the Chat.
//!
//! Nothing is guessed and no command is changed. Evidence and Documents are not credited.
//! Credit is read when asked for, from what is stored, so it needs no turn and does not
//! depend on when the host noticed anything.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::receipt::FEED_HEADS;
use super::{CHAT_AGENT_CHANGES_LIMIT, CHAT_AGENT_EXCERPT_LIMIT, ChatAgentChange, Error, invalid};

/// What a `ticketd` call a shell Step names would write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatPlannedWriteKind {
    /// A status move.
    Status,
    /// An Activity.
    Activity,
    /// A call that may write either (a batch, a script of changes).
    Other,
}

/// One write a shell Step's plain `ticketd` call would make.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatPlannedWrite {
    pub kind: ChatPlannedWriteKind,
    /// The words of the call that could name its ticket. Empty: unknown, so any ticket.
    #[serde(default)]
    pub references: Vec<String>,
}

/// The agent a write is credited to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatWriteCredit {
    pub chat_id: String,
    /// The sub-agent's native ID. `None`: the Chat's main agent, or a write that cannot be
    /// placed more exactly than the Chat.
    pub sub_agent: Option<String>,
}

/// The credited writes on one ticket.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TicketWriteCredits {
    /// Status moves, by their number in the ticket history feed.
    pub statuses: HashMap<i64, ChatWriteCredit>,
    /// Activities, by ID.
    pub activities: HashMap<String, ChatWriteCredit>,
}

/// An agent with a credited write on a ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketWritingAgent {
    pub chat_id: String,
    /// The sub-agent's native ID; `None` is the Chat's main agent.
    pub sub_agent: Option<String>,
    /// The sub-agent's latest run is running; for the main agent, the Chat has an active turn.
    pub running: bool,
}

/// Format 105: the CLI's per-call key beside each write, and the shell Step windows.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    crate::format::add_column_if_missing(connection, "chat_record_writes", "call_id", "TEXT")?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_step_windows (tool_id TEXT PRIMARY KEY REFERENCES chat_tools(id), chat_id TEXT NOT NULL REFERENCES chats(id), history_start INTEGER NOT NULL, activities_start INTEGER NOT NULL, history_end INTEGER, activities_end INTEGER, writes TEXT NOT NULL DEFAULT '[]');
         CREATE INDEX IF NOT EXISTS chat_step_windows_chat ON chat_step_windows(chat_id);",
    )?;
    Ok(())
}

/// A shell Step was seen: its window opens at the feeds' present heads, or is empty when
/// the Step is already over. Seen again, it keeps the window it has.
pub(super) fn open_window(
    connection: &Connection,
    chat_id: &str,
    tool_id: &str,
    writes: &[ChatPlannedWrite],
) -> Result<(), Error> {
    let running: Option<bool> = connection
        .query_row(
            "SELECT state = 'running' FROM chat_tools WHERE id = ?1 AND chat_id = ?2",
            params![tool_id, chat_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(running) = running else {
        return Err(invalid(format!(
            "'{tool_id}' is not a Step of this Chat to open a window for"
        )));
    };
    connection.execute(
        &format!(
            "INSERT OR IGNORE INTO chat_step_windows (tool_id, chat_id, history_start, activities_start, history_end, activities_end, writes)
             SELECT ?1, ?2, h, a, CASE WHEN ?3 THEN NULL ELSE h END, CASE WHEN ?3 THEN NULL ELSE a END, ?4
             FROM (SELECT json_extract({FEED_HEADS}, '$.history') AS h, json_extract({FEED_HEADS}, '$.activities') AS a)"
        ),
        params![tool_id, chat_id, running, serde_json::to_string(writes)?],
    )?;
    Ok(())
}

/// The Step is over: its window closes at the feeds' present heads.
pub(super) fn close_window(connection: &Connection, tool_id: &str) -> Result<(), Error> {
    connection.execute(
        &format!(
            "UPDATE chat_step_windows SET
                 history_end = json_extract({FEED_HEADS}, '$.history'),
                 activities_end = json_extract({FEED_HEADS}, '$.activities')
             WHERE tool_id = ?1 AND history_end IS NULL"
        ),
        [tool_id],
    )?;
    Ok(())
}

/// The harness is gone: no Step of the Chat is running any more.
pub(super) fn close_windows(connection: &Connection, chat_id: &str) -> Result<(), Error> {
    connection.execute(
        &format!(
            "UPDATE chat_step_windows SET
                 history_end = json_extract({FEED_HEADS}, '$.history'),
                 activities_end = json_extract({FEED_HEADS}, '$.activities')
             WHERE chat_id = ?1 AND history_end IS NULL"
        ),
        [chat_id],
    )?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Feed {
    Status,
    Activity,
}

struct Write {
    feed: Feed,
    number: i64,
    activity_id: Option<String>,
    chat_id: String,
    call_id: Option<String>,
}

struct Window {
    owner: Option<String>,
    /// The position of the Step in the Chat's history.
    position: i64,
    history: (i64, Option<i64>),
    activities: (i64, Option<i64>),
    open: bool,
    writes: Vec<ChatPlannedWrite>,
}

impl Window {
    fn holds(&self, feed: Feed, number: i64) -> bool {
        let (start, end) = match feed {
            Feed::Status => self.history,
            Feed::Activity => self.activities,
        };
        number > start && end.map_or(self.open, |end| number <= end)
    }

    /// A plain `ticketd` call this Step names could have made the write.
    fn could_write(&self, feed: Feed, reference: &str) -> bool {
        self.writes.iter().any(|plan| {
            let kind = match plan.kind {
                ChatPlannedWriteKind::Other => true,
                ChatPlannedWriteKind::Status => feed == Feed::Status,
                ChatPlannedWriteKind::Activity => feed == Feed::Activity,
            };
            kind && (plan.references.is_empty()
                || plan
                    .references
                    .iter()
                    .any(|word| word.eq_ignore_ascii_case(reference)))
        })
    }
}

/// What is known about one Chat, loaded once for all of its writes.
struct Placing {
    windows: Vec<Window>,
    /// Native IDs of the Chat's Steps with their owner and position, to find the Step a
    /// call key names.
    steps: Vec<(String, Option<String>, i64)>,
}

impl Placing {
    fn load(connection: &Connection, chat_id: &str) -> Result<Self, Error> {
        let mut statement = connection.prepare(
            "SELECT t.sub_agent_id, w.history_start, w.history_end, w.activities_start, w.activities_end, t.state = 'running', w.writes, t.position
             FROM chat_step_windows w JOIN chat_tools t ON t.id = w.tool_id WHERE w.chat_id = ?1",
        )?;
        let windows = statement
            .query_map([chat_id], |row| {
                let writes: String = row.get(6)?;
                Ok(Window {
                    owner: row.get(0)?,
                    position: row.get(7)?,
                    history: (row.get(1)?, row.get(2)?),
                    activities: (row.get(3)?, row.get(4)?),
                    open: row.get(5)?,
                    // A window the reader cannot read names nothing.
                    writes: serde_json::from_str(&writes).unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut statement = connection
            .prepare("SELECT id, sub_agent_id, position FROM chat_tools WHERE chat_id = ?1")?;
        let steps = statement
            .query_map([chat_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { windows, steps })
    }

    /// The owner of the Step the harness's own key names, with its position:
    /// `Some((None, _))` is the main agent.
    fn by_key(&self, key: &str) -> Option<(Option<String>, i64)> {
        self.steps
            .iter()
            .find(|(id, _, _)| {
                id == key
                    || id
                        .strip_suffix(key)
                        .is_some_and(|before| before.ends_with(':'))
            })
            .map(|(_, owner, position)| (owner.clone(), *position))
    }

    fn by_window(&self, write: &Write, reference: &str) -> Option<(String, i64)> {
        let inside: Vec<&Window> = self
            .windows
            .iter()
            .filter(|window| window.holds(write.feed, write.number))
            .collect();
        let only = match inside.as_slice() {
            [] => None,
            [only] => Some(*only),
            several => {
                let mut named = several
                    .iter()
                    .filter(|window| window.could_write(write.feed, reference));
                match (named.next(), named.next()) {
                    (Some(only), None) => Some(*only),
                    _ => None,
                }
            }
        }?;
        only.owner.clone().map(|owner| (owner, only.position))
    }

    /// The sub-agent a write is credited to and the position of the Step that made it.
    fn place(&self, write: &Write, reference: &str) -> Option<(String, i64)> {
        match &write.call_id {
            // The harness named the call: its Step, or nobody. A window never stands in.
            Some(key) => {
                let (owner, position) = self.by_key(key)?;
                Some((owner?, position))
            }
            None => self.by_window(write, reference),
        }
    }

    fn credit(&self, write: &Write, reference: &str) -> Option<String> {
        self.place(write, reference).map(|(owner, _)| owner)
    }
}

/// The credit of every tagged status move and Activity on a ticket.
pub(super) fn ticket_credits(
    connection: &Connection,
    ticket_id: &str,
    reference: &str,
) -> Result<TicketWriteCredits, Error> {
    ticket_credits_scoped(connection, ticket_id, reference, None)
}

/// The credit of the tagged writes on a ticket, only those of the Activities and status
/// moves in `scope` (Activity IDs, history numbers) when given. A write is placed by its
/// Chat's windows alone, so the others change nothing about the ones kept.
pub(super) fn ticket_credits_scoped(
    connection: &Connection,
    ticket_id: &str,
    reference: &str,
    scope: Option<(&[String], &[i64])>,
) -> Result<TicketWriteCredits, Error> {
    let (activities, statuses) = match scope {
        Some((activities, statuses)) => (
            Some(serde_json::to_string(activities)?),
            Some(serde_json::to_string(statuses)?),
        ),
        None => (None, None),
    };
    let mut statement = connection.prepare(
        "SELECT 0, h.number, NULL, w.chat_id, w.call_id
         FROM ticket_history h JOIN chat_record_writes w ON w.history_number = h.number
         WHERE h.ticket_id = ?1 AND h.kind = 'status'
           AND (?3 IS NULL OR h.number IN (SELECT value FROM json_each(?3)))
         UNION ALL
         SELECT 1, a.number, a.id, w.chat_id, w.call_id
         FROM activities a JOIN chat_record_writes w ON w.activity_id = a.id
         WHERE a.ticket_id = ?1
           AND (?2 IS NULL OR a.id IN (SELECT value FROM json_each(?2)))
         ORDER BY 1, 2",
    )?;
    let writes = statement
        .query_map(params![ticket_id, activities, statuses], |row| {
            Ok(Write {
                feed: if row.get::<_, i64>(0)? == 0 {
                    Feed::Status
                } else {
                    Feed::Activity
                },
                number: row.get(1)?,
                activity_id: row.get(2)?,
                chat_id: row.get(3)?,
                call_id: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut placings: HashMap<String, Placing> = HashMap::new();
    let mut credits = TicketWriteCredits::default();
    for write in writes {
        if !placings.contains_key(&write.chat_id) {
            placings.insert(
                write.chat_id.clone(),
                Placing::load(connection, &write.chat_id)?,
            );
        }
        let sub_agent = placings[&write.chat_id].credit(&write, reference);
        let credit = ChatWriteCredit {
            chat_id: write.chat_id.clone(),
            sub_agent,
        };
        match (write.feed, write.activity_id) {
            (Feed::Status, _) => {
                credits.statuses.insert(write.number, credit);
            }
            (Feed::Activity, Some(id)) => {
                credits.activities.insert(id, credit);
            }
            (Feed::Activity, None) => {}
        }
    }
    Ok(credits)
}

/// The agents with a credited write on a ticket, and whether each is running now.
pub(super) fn writing_agents(
    connection: &Connection,
    ticket_id: &str,
    reference: &str,
) -> Result<Vec<TicketWritingAgent>, Error> {
    let credits = ticket_credits(connection, ticket_id, reference)?;
    let mut every: Vec<&ChatWriteCredit> = credits
        .statuses
        .values()
        .chain(credits.activities.values())
        .collect();
    every.sort_by(|a, b| (&a.chat_id, &a.sub_agent).cmp(&(&b.chat_id, &b.sub_agent)));
    every.dedup();
    let agents = every;
    agents
        .into_iter()
        .map(|credit| {
            let running = match &credit.sub_agent {
                Some(native_id) => connection
                    .query_row(
                        "SELECT r.state = 'running' FROM chat_sub_agent_runs r
                         JOIN chat_sub_agents s ON s.id = r.sub_agent_id
                         WHERE s.chat_id = ?1 AND s.native_id = ?2 ORDER BY r.run DESC LIMIT 1",
                        params![credit.chat_id, native_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(false),
                None => connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_turns WHERE chat_id = ?1 AND state = 'active')",
                    [&credit.chat_id],
                    |row| row.get(0),
                )?,
            };
            Ok(TicketWritingAgent {
                chat_id: credit.chat_id.clone(),
                sub_agent: credit.sub_agent.clone(),
                running,
            })
        })
        .collect()
}

/// What a sub-agent's run changed in tickets: the writes credited to it whose Step lies in
/// the run (from `from` to before `until`, positions in the Chat's history), as the Chat's
/// own turn lists its changes. Oldest first.
pub(super) fn sub_agent_changes(
    connection: &Connection,
    chat_id: &str,
    native_id: &str,
    from: i64,
    until: Option<i64>,
) -> Result<Vec<ChatAgentChange>, Error> {
    let mut statement = connection.prepare(
        "SELECT 0, h.number, NULL, w.call_id, t.reference, t.title, h.from_value, h.to_value, h.timestamp
         FROM ticket_history h JOIN tickets t ON t.id = h.ticket_id
         JOIN chat_record_writes w ON w.history_number = h.number
         WHERE w.chat_id = ?1 AND h.kind = 'status'
         UNION ALL
         SELECT 1, a.number, a.id, w.call_id, t.reference, t.title, '', a.brief, a.reported_at
         FROM activities a JOIN tickets t ON t.id = a.ticket_id
         JOIN chat_record_writes w ON w.activity_id = a.id
         WHERE w.chat_id = ?1
         ORDER BY 9, 1, 2",
    )?;
    let rows = statement
        .query_map([chat_id], |row| {
            let status = row.get::<_, i64>(0)? == 0;
            Ok((
                Write {
                    feed: if status { Feed::Status } else { Feed::Activity },
                    number: row.get(1)?,
                    activity_id: row.get(2)?,
                    chat_id: chat_id.to_owned(),
                    call_id: row.get(3)?,
                },
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let placing = Placing::load(connection, chat_id)?;
    let mut changes = Vec::new();
    for (write, reference, title, from_value, to_value) in rows {
        let Some((owner, position)) = placing.place(&write, &reference) else {
            continue;
        };
        if owner != native_id || position < from || until.is_some_and(|until| position >= until) {
            continue;
        }
        changes.push(match write.feed {
            Feed::Status => ChatAgentChange::Status {
                reference,
                title,
                from: from_value,
                to: to_value,
            },
            Feed::Activity => ChatAgentChange::Update {
                reference,
                excerpt: to_value.chars().take(CHAT_AGENT_EXCERPT_LIMIT).collect(),
            },
        });
        if changes.len() >= CHAT_AGENT_CHANGES_LIMIT {
            break;
        }
    }
    Ok(changes)
}
