use rusqlite::{Connection, OptionalExtension, named_params, params};
use serde::Deserialize;

use super::{CHAT_AGENT_CHANGES_LIMIT, CHAT_AGENT_EXCERPT_LIMIT, ChatAgentChange, NOW, invalid};
use crate::Error;

const SUBMISSION_KEY: &str = "submission:";
pub(super) const FEED_HEADS: &str = "json_object(
    'history', COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'ticket_history'), 0),
    'activities', COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'activities'), 0))";

/// The observed Turn whose receipt is due. Keep this value across storage failures
/// so a retry uses the first end boundary it could read.
pub struct ChatTurnReceipt {
    turn_id: String,
    end: Option<EndBoundary>,
}

struct EndBoundary {
    at: String,
    feed_heads: String,
}

impl ChatTurnReceipt {
    pub fn new(turn_id: String) -> Self {
        Self { turn_id, end: None }
    }

    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }

    pub(super) fn capture_end(&mut self, connection: &Connection) -> Result<(), Error> {
        Self::end_boundary(&mut self.end, connection)?;
        Ok(())
    }

    fn end_boundary<'a>(
        end: &'a mut Option<EndBoundary>,
        connection: &Connection,
    ) -> Result<&'a EndBoundary, Error> {
        // Read under the settlement's write lock so the time and both feed heads
        // describe the same boundary. Keep them even if the transaction rolls back.
        Ok(match end {
            Some(end) => end,
            absent => absent.insert(connection.query_row(
                &format!("SELECT {NOW}, {FEED_HEADS}"),
                [],
                |row| {
                    Ok(EndBoundary {
                        at: row.get(0)?,
                        feed_heads: row.get(1)?,
                    })
                },
            )?),
        })
    }
}

pub(super) enum Boundary<'a> {
    Submission(&'a str),
    Start(&'a str),
    End(&'a str),
}

impl Boundary<'_> {
    fn key(self) -> Vec<u8> {
        let (prefix, id) = match self {
            Self::Submission(id) => (SUBMISSION_KEY, id),
            Self::Start(id) => ("turn-start:", id),
            Self::End(id) => ("turn-end:", id),
        };
        format!("{prefix}{id}").into_bytes()
    }
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
struct FeedHeads {
    history: i64,
    activities: i64,
}

/// Record the last allocated number in each feed in the boundary's
/// write transaction. AUTOINCREMENT keeps these numbers valid after deletions.
/// Format 85's attribution table also holds the boundary rows. A BLOB key and
/// JSON payload match neither a TEXT Activity ID nor an INTEGER history number
/// in an older reader. Chat retention already removes every row for the Chat.
pub(super) fn record_boundary(
    connection: &Connection,
    chat_id: &str,
    boundary: Boundary<'_>,
) -> Result<(), Error> {
    save_boundary(connection, chat_id, boundary, None)
}

/// Use the retained boundary when ending the Turn or first observing it at its end.
pub(super) fn record_turn_boundary<'a>(
    connection: &Connection,
    chat_id: &str,
    boundary: Boundary<'_>,
    pending: Option<&'a mut ChatTurnReceipt>,
) -> Result<Option<&'a str>, Error> {
    let matching = |receipt: &&mut ChatTurnReceipt| matches!(boundary, Boundary::Start(id) | Boundary::End(id) if id == receipt.turn_id);
    if let Some(receipt) = pending.filter(matching) {
        let end = ChatTurnReceipt::end_boundary(&mut receipt.end, connection)?;
        save_boundary(connection, chat_id, boundary, Some(&end.feed_heads))?;
        return Ok(Some(&end.at));
    }
    record_boundary(connection, chat_id, boundary)?;
    Ok(None)
}

fn save_boundary(
    connection: &Connection,
    chat_id: &str,
    boundary: Boundary<'_>,
    feed_heads: Option<&str>,
) -> Result<(), Error> {
    connection.execute(
        &format!(
            "INSERT INTO chat_record_writes (chat_id, activity_id, history_number)
                  VALUES (?1, ?2, COALESCE(?3, {FEED_HEADS}))"
        ),
        params![chat_id, boundary.key(), feed_heads],
    )?;
    Ok(())
}

fn read_boundary(
    connection: &Connection,
    chat_id: &str,
    boundary: Boundary<'_>,
) -> Result<Option<FeedHeads>, Error> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT history_number FROM chat_record_writes WHERE activity_id = ?1 AND chat_id = ?2",
            params![boundary.key(), chat_id],
            |row| row.get(0),
        )
        .optional()?;
    decode_boundary(payload.as_deref())
}

fn decode_boundary(payload: Option<&str>) -> Result<Option<FeedHeads>, Error> {
    payload
        .map(serde_json::from_str)
        .transpose()
        .map_err(Into::into)
}

/// Tag writes in the CLI's own transaction. A BLOB in the unused slot identifies
/// writes from current CLIs. When a legacy Turn lacks a recorded end boundary,
/// its receipt keeps old tags at an exact time tie and skips these newer tags.
/// An older reader still joins each write by its usual ID or number.
///
/// `call_id` is the key the harness gave this one command (`CODEX_TOOL_CALL_ID`), kept
/// with the write so the agent that ran the command can be told exactly.
pub(super) fn prepare_writer(
    connection: &Connection,
    chat_id: &str,
    call_id: Option<&str>,
) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS acting_chat (id TEXT NOT NULL, call_id TEXT);
         DELETE FROM acting_chat;
         CREATE TEMP TRIGGER IF NOT EXISTS acting_chat_status AFTER INSERT ON main.ticket_history WHEN NEW.kind = 'status' BEGIN
             INSERT INTO chat_record_writes (chat_id, history_number, activity_id, call_id)
             SELECT id, NEW.number, X'', call_id FROM acting_chat;
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS acting_chat_update AFTER INSERT ON main.activities BEGIN
             INSERT INTO chat_record_writes (chat_id, activity_id, history_number, call_id)
             SELECT id, NEW.id, X'', call_id FROM acting_chat;
         END;",
    )?;
    connection.execute(
        "INSERT INTO acting_chat (id, call_id) VALUES (?1, ?2)",
        params![chat_id, call_id],
    )?;
    Ok(())
}

pub(super) fn read_changes(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    require_ended: bool,
) -> Result<Vec<ChatAgentChange>, Error> {
    let (harness, observed_start, ended_at): (String, String, Option<String>) = connection
        .query_row(
            "SELECT c.harness, t.started_at, t.ended_at FROM chat_turns t
             JOIN chats c ON c.id = t.chat_id WHERE t.id = ?1 AND t.chat_id = ?2",
            params![turn_id, chat_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| invalid(format!("turn '{turn_id}' was not recorded for this Chat")))?;
    if require_ended && ended_at.is_none() {
        return Ok(Vec::new());
    }

    let mut attributed_start = observed_start.clone();
    let mut start = read_boundary(connection, chat_id, Boundary::Start(turn_id))?;
    let end = read_boundary(connection, chat_id, Boundary::End(turn_id))?;
    let mut submissions = connection.prepare(
        "SELECT a.recorded_at, w.history_number
         FROM chat_messages m JOIN chat_submission_attempts a ON a.message_id = m.id
         LEFT JOIN chat_record_writes w ON w.activity_id = CAST(?3 || a.id AS BLOB) AND w.chat_id = a.chat_id
         WHERE m.chat_id = ?1 AND a.chat_id = ?1 AND a.turn_id = ?2
           AND a.delivery NOT IN ('not_delivered', 'rejected')",
    )?;
    let mut rows = submissions.query(params![chat_id, turn_id, SUBMISSION_KEY])?;
    while let Some(row) = rows.next()? {
        let at: String = row.get(0)?;
        let payload: Option<String> = row.get(1)?;
        match decode_boundary(payload.as_deref())? {
            // Both feeds only advance, so the smaller pair precedes the other.
            Some(heads) => start = start.map(|other| other.min(heads)),
            None if at <= observed_start => start = None,
            None => {}
        }
        attributed_start = attributed_start.min(at);
    }

    let ordered_start = start.is_some();
    let ordered_end = end.is_some();
    let start = start.unwrap_or_default();
    let end = end.unwrap_or(FeedHeads {
        history: i64::MAX,
        activities: i64::MAX,
    });
    // Seek into the two feeds by primary key before looking up the tickets. A
    // boundary belongs to what preceded it, so only the upper bound is inclusive.
    // Legacy windows fall back to timestamps where a boundary was not recorded.
    // Untagged writes still need a matching agent and an unambiguous observed Turn.
    let mut statement = connection.prepare(
        "WITH changes AS (
             SELECT 'status' AS kind, t.reference, t.title, h.from_value, h.to_value,
                    h.timestamp AS at, 0 AS source, h.number AS seq, h.editing_agent AS agent, w.chat_id AS writer,
                    w.activity_id IS X'' AS ordered_writer
             FROM ticket_history h CROSS JOIN tickets t ON t.id = h.ticket_id
             LEFT JOIN chat_record_writes w ON w.history_number = h.number
             WHERE h.kind = 'status' AND h.number > :history_start AND h.number <= :history_end
             UNION ALL
             SELECT 'update', t.reference, t.title, '', a.brief, a.reported_at, 1, a.number, a.editing_agent, w.chat_id,
                    w.history_number IS X''
             FROM activities a CROSS JOIN tickets t ON t.id = a.ticket_id
             LEFT JOIN chat_record_writes w ON w.activity_id = a.id
             WHERE a.number > :activities_start AND a.number <= :activities_end
         )
         SELECT kind, reference, title, from_value, to_value FROM changes
         WHERE (writer = :chat_id AND (:ordered_start OR at >= :attributed_start)
             AND (:ordered_end OR :ended_at IS NULL OR at < :ended_at OR (at = :ended_at AND NOT ordered_writer)))
            OR (writer IS NULL AND agent = :harness AND at >= :observed_start
             AND (:ended_at IS NULL OR at <= :ended_at) AND NOT EXISTS (
                 SELECT 1 FROM chat_turns o JOIN chats oc ON oc.id = o.chat_id
                 WHERE oc.harness = :harness AND o.chat_id <> :chat_id AND o.started_at <= at
                   AND (o.ended_at IS NULL OR o.ended_at >= at)))
         ORDER BY at, source, seq LIMIT :limit",
    )?;
    let changes = statement
        .query_map(
            named_params! {
                ":chat_id": chat_id,
                ":harness": harness,
                ":attributed_start": attributed_start,
                ":observed_start": observed_start,
                ":ended_at": ended_at,
                ":ordered_start": ordered_start,
                ":ordered_end": ordered_end,
                ":history_start": start.history,
                ":history_end": end.history,
                ":activities_start": start.activities,
                ":activities_end": end.activities,
                ":limit": CHAT_AGENT_CHANGES_LIMIT as i64,
            },
            |row| {
                let (kind, reference): (String, String) = (row.get(0)?, row.get(1)?);
                Ok(if kind == "status" {
                    ChatAgentChange::Status {
                        reference,
                        title: row.get(2)?,
                        from: row.get(3)?,
                        to: row.get(4)?,
                    }
                } else {
                    let brief: String = row.get(4)?;
                    ChatAgentChange::Update {
                        reference,
                        excerpt: brief.chars().take(CHAT_AGENT_EXCERPT_LIMIT).collect(),
                    }
                })
            },
        )?
        .collect::<Result<_, _>>()?;
    Ok(changes)
}
