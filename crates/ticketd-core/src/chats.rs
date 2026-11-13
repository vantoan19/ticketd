//! Durable Chat records: identity, links, input, submission attempts, observed turns,
//! tools and interactions, plus the ordered change log that Chat views follow.
//!
//! The core only records what the desktop host tells it was observed. Saving input,
//! recording a possible submission, and recording acknowledgment, processing and a
//! terminal outcome are separate writes, so a saved message is never mistaken for a
//! delivered or completed one. Nothing here dispatches work.

use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{Error, Workspace};

/// Stored tool output keeps its last this-many bytes; `ChatTool::output_truncated` marks
/// that the start was dropped. The end is kept because it is where a command reports its
/// outcome.
/// Provisional: to be measured against real sessions.
pub const CHAT_TOOL_OUTPUT_LIMIT: usize = 1024 * 1024;

/// Change entries kept per Chat. A follower whose cursor is older must read a new snapshot.
/// Provisional: to be measured against real sessions.
pub const CHAT_CHANGE_TAIL: usize = 2_000;

/// Characters kept of one stored notice.
pub const CHAT_NOTICE_LIMIT: usize = 2_000;

/// Characters kept of the settings a harness reported as in effect.
pub const CHAT_EFFECTIVE_SETTINGS_LIMIT: usize = 16_000;

/// The latest reset time kept with a failed turn, in seconds since the Unix epoch
/// (the end of year 9999). A value outside `0..=` this is not a time and is dropped.
pub const CHAT_RESET_TIME_MAX: i64 = 253_402_300_799;

/// The environment variable the Chat host sets on a harness process to the Chat's ID.
/// Commands the harness runs inherit it, so the `ticketd` CLI can credit its writes to
/// that Chat (`Workspace::act_for_chat`). It carries only the ID, never a credential.
pub const CHAT_ID_VARIABLE: &str = "TICKETD_CHAT_ID";

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// Chat tables are deliberately left without workspace change-token triggers: they
/// change many times a second while a turn streams, and views follow `chat_changes`.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, harness TEXT NOT NULL, execution_folder TEXT NOT NULL, folder_managed INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, trashed INTEGER NOT NULL DEFAULT 0, queue_paused INTEGER NOT NULL DEFAULT 0, effective_settings TEXT, changes_trimmed_through INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ({NOW}));
         CREATE TABLE IF NOT EXISTS chat_links (chat_id TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(chat_id, kind, target_id));
         CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, native_session_id TEXT NOT NULL, origin TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT ({NOW}));
         CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, native_turn_id TEXT, state TEXT NOT NULL, detail TEXT, problem TEXT, problem_resets_at INTEGER, started_at TEXT NOT NULL DEFAULT ({NOW}), ended_at TEXT);
         CREATE UNIQUE INDEX IF NOT EXISTS chat_turns_active ON chat_turns(chat_id) WHERE state = 'active';
         CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, role TEXT NOT NULL, text TEXT NOT NULL, complete INTEGER NOT NULL, turn_id TEXT REFERENCES chat_turns(id), created_at TEXT NOT NULL DEFAULT ({NOW}));
         CREATE TABLE IF NOT EXISTS chat_submission_attempts (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), message_id TEXT NOT NULL REFERENCES chat_messages(id), intent TEXT NOT NULL, delivery TEXT NOT NULL, turn_id TEXT REFERENCES chat_turns(id), detail TEXT, decision TEXT, recorded_at TEXT NOT NULL DEFAULT ({NOW}));
         CREATE INDEX IF NOT EXISTS chat_submission_attempts_message ON chat_submission_attempts(message_id);
         CREATE TABLE IF NOT EXISTS chat_tools (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, turn_id TEXT NOT NULL REFERENCES chat_turns(id), name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, output TEXT, output_truncated INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS chat_interactions (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, turn_id TEXT NOT NULL REFERENCES chat_turns(id), kind TEXT NOT NULL, native_request_id TEXT, prompt TEXT NOT NULL, reason TEXT, state TEXT NOT NULL, response TEXT);
         CREATE TABLE IF NOT EXISTS chat_notices (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ({NOW}));
         CREATE TABLE IF NOT EXISTS chat_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL, subject_id TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS chat_changes_chat ON chat_changes(chat_id, sequence);
         CREATE INDEX IF NOT EXISTS chat_sessions_chat ON chat_sessions(chat_id, position);
         CREATE INDEX IF NOT EXISTS chat_turns_chat ON chat_turns(chat_id, position);
         CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, position);
         CREATE INDEX IF NOT EXISTS chat_tools_chat ON chat_tools(chat_id, position);
         CREATE INDEX IF NOT EXISTS chat_interactions_chat ON chat_interactions(chat_id, position);
         CREATE INDEX IF NOT EXISTS chat_notices_chat ON chat_notices(chat_id, position);
         CREATE TABLE IF NOT EXISTS chat_record_writes (chat_id TEXT NOT NULL, activity_id TEXT, history_number INTEGER);
         CREATE INDEX IF NOT EXISTS chat_record_writes_activity ON chat_record_writes(activity_id);
         CREATE INDEX IF NOT EXISTS chat_record_writes_history ON chat_record_writes(history_number);
         PRAGMA user_version = 66;"
    ))?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatLinkKind {
    Project,
    Ticket,
    Document,
}

/// A reference from a Chat to a record by its stable ID. The record does not own the Chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatLink {
    pub kind: ChatLinkKind,
    pub id: String,
}

/// What a linked record is called now. Read on request and never stored with the Chat,
/// so a reference built from it cannot go stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatLinkedRecord {
    pub kind: ChatLinkKind,
    pub id: String,
    /// The Ticket reference (`T-KQ43`); only tickets have one.
    pub reference: Option<String>,
    /// A ticket title, Document heading or project name, cut to 200 characters.
    pub title: String,
    pub trashed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewChat {
    pub title: Option<String>,
    /// The harness this Chat keeps for its whole life, as the host names it.
    pub harness: String,
    pub execution_folder: String,
    /// Whether ticketd created the execution folder for this Chat.
    pub folder_managed: bool,
    #[serde(default)]
    pub links: Vec<ChatLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub title: Option<String>,
    pub harness: String,
    pub execution_folder: String,
    pub folder_managed: bool,
    pub archived: bool,
    pub trashed: bool,
    /// Set by Stop: the host must not dispatch queued input until it is cleared.
    pub queue_paused: bool,
    /// The settings the harness last reported as in effect, as the host recorded them.
    pub effective_settings: Option<String>,
    /// The latest recorded harness-session identity. Its presence does not mean the
    /// harness can still resume it.
    pub native_session_id: Option<String>,
    pub links: Vec<ChatLink>,
    /// The turn last recorded as active. The host owns whether a process is behind it.
    pub active_turn: Option<ChatTurn>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatListFilter {
    Active,
    Archived,
    Trashed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatSessionOrigin {
    New,
    NativeResume,
    /// An explicit resume of the same Chat in a fresh harness session.
    FreshSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub position: i64,
    pub native_session_id: String,
    pub origin: ChatSessionOrigin,
    pub started_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatSubmissionIntent {
    NewTurn,
    Steer,
}

/// What is known about whether the harness received a submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatDelivery {
    /// Recorded before transport: the harness may or may not have received it.
    Possible,
    /// Known not to have reached the harness; the input is queued again.
    NotDelivered,
    /// The harness refused it; the input is queued again.
    Rejected,
    Acknowledged,
    /// Contact was lost after a possible submission. Never resubmitted automatically.
    Uncertain,
}

/// What the person decided about a submission whose delivery stayed uncertain. The
/// attempt keeps `Uncertain`: a decision is not an observation of what the harness got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatDeliveryDecision {
    /// Sent again as a new submission, recorded as a later attempt.
    Resent,
    /// Set aside; it is never sent again.
    Discarded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSubmissionAttempt {
    pub id: String,
    pub intent: ChatSubmissionIntent,
    pub delivery: ChatDelivery,
    /// The turn observed processing this submission, when the harness correlated one.
    pub turn_id: Option<String>,
    pub detail: Option<String>,
    pub decision: Option<ChatDeliveryDecision>,
    pub recorded_at: String,
}

impl ChatSubmissionAttempt {
    /// The harness acknowledged the submission or correlated a turn with it.
    pub fn received(&self) -> bool {
        self.delivery == ChatDelivery::Acknowledged || self.turn_id.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub position: i64,
    pub role: ChatRole,
    pub text: String,
    /// False for assistant text still streaming or cut short by a crash.
    pub complete: bool,
    pub turn_id: Option<String>,
    /// User input with no submission that may have reached the harness.
    pub queued: bool,
    pub attempts: Vec<ChatSubmissionAttempt>,
    pub created_at: String,
}

/// Where user input stands, read from all of its attempts and the person's decisions
/// together. Everything that asks "is it queued" or "does it await a decision" asks
/// this, so a decision is never lost when a later observation arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatInputStanding {
    /// Nothing may have reached the harness and nothing is undecided: it is in the queue.
    Queued,
    /// A submission was handed over and nothing is known about it yet.
    Sending,
    /// The harness acknowledged a submission or correlated a turn with one.
    Delivered,
    /// A submission may or may not have arrived, and either the person has not decided
    /// or the resend they asked for was not accepted. Never sent without their request.
    AwaitsDecision,
    /// The person set it aside. It is never queued or sent again, whatever is observed
    /// about its attempts afterwards.
    SetAside,
}

impl ChatMessage {
    /// Where this input stands, given whether the host holds it to send as soon as its
    /// session opens (`held`): input the person sent that waits only for that is being
    /// sent, not in their queue. Holding it changes no other standing, so a decision
    /// or a delivery is never hidden, and storage still keeps it queued until a
    /// submission is recorded.
    pub fn standing_while(&self, held: bool) -> ChatInputStanding {
        match self.standing() {
            ChatInputStanding::Queued if held => ChatInputStanding::Sending,
            standing => standing,
        }
    }

    /// Where this input stands in storage. Meaningful for user input only.
    pub fn standing(&self) -> ChatInputStanding {
        let attempts = &self.attempts;
        if attempts.iter().any(ChatSubmissionAttempt::received) {
            return ChatInputStanding::Delivered;
        }
        let discarded = Some(ChatDeliveryDecision::Discarded);
        if attempts.iter().any(|attempt| attempt.decision == discarded) {
            return ChatInputStanding::SetAside;
        }
        // Nothing is queued while any submission is still in flight.
        if attempts
            .iter()
            .any(|attempt| attempt.delivery == ChatDelivery::Possible)
        {
            return ChatInputStanding::Sending;
        }
        match attempts.last().map(|attempt| attempt.delivery) {
            None => ChatInputStanding::Queued,
            Some(ChatDelivery::Possible) => ChatInputStanding::Sending,
            Some(ChatDelivery::Acknowledged) => ChatInputStanding::Delivered,
            Some(ChatDelivery::Uncertain) => ChatInputStanding::AwaitsDecision,
            // A resend that was not accepted settles nothing about the attempt before it.
            Some(ChatDelivery::NotDelivered | ChatDelivery::Rejected) => {
                if self.open_question().is_some() {
                    ChatInputStanding::AwaitsDecision
                } else {
                    ChatInputStanding::Queued
                }
            }
        }
    }

    /// The latest attempt whose delivery is still unknown.
    pub fn open_question(&self) -> Option<&ChatSubmissionAttempt> {
        self.attempts
            .iter()
            .rev()
            .find(|attempt| attempt.delivery == ChatDelivery::Uncertain && !attempt.received())
    }

    /// A submission may or may not have arrived and what happens next is the person's
    /// decision: they have not made one, or the resend they asked for was not accepted.
    pub fn awaits_decision(&self) -> bool {
        self.role == ChatRole::User && self.standing() == ChatInputStanding::AwaitsDecision
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatTurnState {
    Active,
    Completed,
    Failed,
    Interrupted,
    /// Contact was lost while the turn was active; its outcome was not observed.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatTurn {
    pub id: String,
    pub position: i64,
    pub native_turn_id: Option<String>,
    pub state: ChatTurnState,
    pub detail: Option<String>,
    /// The kind of failure, as the host names it, when the turn ended with one.
    pub problem: Option<String>,
    /// When the provider said the limit behind the failure resets, in seconds since
    /// the Unix epoch. `None` when it did not say.
    pub problem_resets_at: Option<i64>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatToolState {
    Running,
    Completed,
    Failed,
    /// The person declined it when the harness asked, so it never ran.
    Declined,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatTool {
    pub id: String,
    pub position: i64,
    pub turn_id: String,
    pub name: String,
    pub input: String,
    pub state: ChatToolState,
    pub output: Option<String>,
    pub output_truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatInteractionKind {
    Approval,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatInteractionState {
    Pending,
    Answered,
    Expired,
}

/// History of an approval request or question. It is never authority to answer one;
/// only the host's live request registry can do that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatInteraction {
    pub id: String,
    pub position: i64,
    pub turn_id: String,
    pub kind: ChatInteractionKind,
    pub native_request_id: Option<String>,
    /// For an approval, what would run or change; for a question, its text.
    pub prompt: String,
    /// Why the harness asks for an approval, apart from `prompt`. Cut to
    /// `CHAT_NOTICE_LIMIT` characters.
    pub reason: Option<String>,
    pub state: ChatInteractionState,
    pub response: Option<String>,
}

/// Changes listed for one turn at most; a turn that made more shows the first ones.
pub const CHAT_AGENT_CHANGES_LIMIT: usize = 50;
/// Characters of an Activity shown as its excerpt.
const CHAT_AGENT_EXCERPT_LIMIT: usize = 140;

/// A change the Chat's agent made in ticketd, through the CLI under its agent name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatAgentChange {
    /// A ticket moved from one status to another.
    Status {
        reference: String,
        title: String,
        from: String,
        to: String,
    },
    /// An Activity posted on a ticket.
    Update { reference: String, excerpt: String },
}

/// Something the host observed that belongs to no other record: a harness warning, a
/// retry, traffic it could not interpret. Text is cut to `CHAT_NOTICE_LIMIT` characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatNotice {
    pub id: String,
    pub position: i64,
    pub text: String,
    pub created_at: String,
}

/// One entry of a Chat's history, ordered by `position`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ChatItem {
    Session(ChatSession),
    Message(ChatMessage),
    Turn(ChatTurn),
    Tool(ChatTool),
    Interaction(ChatInteraction),
    Notice(ChatNotice),
}

/// Something the host observed from the harness. Record only what was actually seen:
/// acknowledgment, correlated processing and a terminal outcome are separate facts.
/// IDs are chosen by the host; repeating an observation leaves the record as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "observation", rename_all = "snake_case")]
pub enum ChatObservation {
    SubmissionNotDelivered {
        attempt_id: String,
        detail: Option<String>,
    },
    SubmissionRejected {
        attempt_id: String,
        detail: Option<String>,
    },
    SubmissionAcknowledged {
        attempt_id: String,
    },
    /// Delivery cannot be determined. The input is kept and never resubmitted.
    SubmissionUncertain {
        attempt_id: String,
        detail: Option<String>,
    },
    /// The harness correlated a turn with this submission.
    SubmissionProcessing {
        attempt_id: String,
        turn_id: String,
    },
    TurnStarted {
        turn_id: String,
        native_turn_id: Option<String>,
    },
    /// `state` is the terminal outcome; `Active` is refused.
    TurnEnded {
        turn_id: String,
        state: ChatTurnState,
        detail: Option<String>,
        /// The kind of failure, as the host names it.
        problem: Option<String>,
        /// When the provider said the limit behind the failure resets, in seconds
        /// since the Unix epoch. Kept only within `0..=CHAT_RESET_TIME_MAX`.
        #[serde(default)]
        problem_resets_at: Option<i64>,
    },
    /// A checkpoint of an assistant message: `text` replaces what was stored.
    AssistantText {
        message_id: String,
        turn_id: String,
        text: String,
        complete: bool,
    },
    Tool {
        tool_id: String,
        turn_id: String,
        name: String,
        input: String,
        state: ChatToolState,
        output: Option<String>,
    },
    InteractionRequested {
        interaction_id: String,
        turn_id: String,
        kind: ChatInteractionKind,
        native_request_id: Option<String>,
        prompt: String,
        /// Cut to `CHAT_NOTICE_LIMIT` characters when stored.
        reason: Option<String>,
    },
    /// `state` is `Answered` or `Expired`.
    InteractionResolved {
        interaction_id: String,
        state: ChatInteractionState,
        response: Option<String>,
    },
    Notice {
        notice_id: String,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatHistoryPage {
    /// Oldest first.
    pub items: Vec<ChatItem>,
    /// Whether older history exists before the first item.
    pub earlier: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSnapshot {
    pub chat: Chat,
    /// The change sequence this snapshot includes; follow with `chat_changes` after it.
    pub sequence: i64,
    /// The latest history, oldest first.
    pub items: Vec<ChatItem>,
    pub earlier: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ChatRecord {
    Chat(Chat),
    Item(ChatItem),
}

/// The current state of a record that changed, at the sequence of its latest change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatChange {
    pub sequence: i64,
    pub record: ChatRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatCatchUp {
    Changes {
        /// Ordered by sequence; a record that changed several times appears once.
        changes: Vec<ChatChange>,
        /// The cursor for the next read.
        sequence: i64,
        more: bool,
    },
    /// The cursor cannot be served; read a new snapshot.
    Resync,
}

fn name<T: Serialize>(value: T) -> Result<String, Error> {
    Ok(match serde_json::to_value(value)? {
        Value::String(name) => name,
        other => other.to_string(),
    })
}

fn named<T: DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    serde_json::from_value(Value::String(row.get(index)?)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Chat(message.into())
}

/// Appends a change entry and returns its sequence, which also orders new history items.
fn log(connection: &Connection, chat_id: &str, kind: &str, subject: &str) -> Result<i64, Error> {
    connection.execute(
        "INSERT INTO chat_changes (chat_id, kind, subject_id) VALUES (?1, ?2, ?3)",
        params![chat_id, kind, subject],
    )?;
    Ok(connection.last_insert_rowid())
}

fn trim(connection: &Connection, chat_id: &str) -> Result<(), Error> {
    let cut: Option<i64> = connection
        .query_row(
            "SELECT sequence FROM chat_changes WHERE chat_id = ?1 ORDER BY sequence DESC LIMIT 1 OFFSET ?2",
            params![chat_id, CHAT_CHANGE_TAIL as i64],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(cut) = cut {
        connection.execute(
            "DELETE FROM chat_changes WHERE chat_id = ?1 AND sequence <= ?2",
            params![chat_id, cut],
        )?;
        connection.execute(
            "UPDATE chats SET changes_trimmed_through = ?2 WHERE id = ?1",
            params![chat_id, cut],
        )?;
    }
    Ok(())
}

fn head(connection: &Connection) -> Result<i64, Error> {
    Ok(connection.query_row(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'chat_changes'), 0)",
        [],
        |row| row.get(0),
    )?)
}

fn turn_from_row(row: &Row<'_>) -> rusqlite::Result<ChatTurn> {
    Ok(ChatTurn {
        id: row.get(0)?,
        position: row.get(1)?,
        native_turn_id: row.get(2)?,
        state: named(row, 3)?,
        detail: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        problem: row.get(7)?,
        problem_resets_at: row.get(8)?,
    })
}

const TURN: &str = "SELECT id, position, native_turn_id, state, detail, started_at, ended_at, problem, problem_resets_at FROM chat_turns";

fn read_chat(connection: &Connection, id: &str) -> Result<Chat, Error> {
    let mut chat = connection
        .query_row(
            "SELECT id, title, harness, execution_folder, folder_managed, archived, trashed, queue_paused, created_at, effective_settings,
                    (SELECT native_session_id FROM chat_sessions WHERE chat_id = chats.id ORDER BY position DESC LIMIT 1)
             FROM chats WHERE id = ?1",
            [id],
            |row| {
                Ok(Chat {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    harness: row.get(2)?,
                    execution_folder: row.get(3)?,
                    folder_managed: row.get(4)?,
                    archived: row.get(5)?,
                    trashed: row.get(6)?,
                    queue_paused: row.get(7)?,
                    created_at: row.get(8)?,
                    effective_settings: row.get(9)?,
                    native_session_id: row.get(10)?,
                    links: Vec::new(),
                    active_turn: None,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::ChatNotFound(id.to_owned()))?;
    let mut statement = connection
        .prepare("SELECT kind, target_id FROM chat_links WHERE chat_id = ?1 ORDER BY rowid")?;
    chat.links = statement
        .query_map([id], |row| {
            Ok(ChatLink {
                kind: named(row, 0)?,
                id: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    chat.active_turn = connection
        .query_row(
            &format!("{TURN} WHERE chat_id = ?1 AND state = 'active'"),
            [id],
            turn_from_row,
        )
        .optional()?;
    Ok(chat)
}

fn read_message(connection: &Connection, id: &str) -> Result<Option<ChatMessage>, Error> {
    let message = connection
        .query_row(
            "SELECT id, position, role, text, complete, turn_id, created_at FROM chat_messages WHERE id = ?1",
            [id],
            |row| {
                Ok(ChatMessage {
                    id: row.get(0)?,
                    position: row.get(1)?,
                    role: named(row, 2)?,
                    text: row.get(3)?,
                    complete: row.get(4)?,
                    turn_id: row.get(5)?,
                    created_at: row.get(6)?,
                    queued: false,
                    attempts: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut message) = message else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT id, intent, delivery, turn_id, detail, recorded_at, decision FROM chat_submission_attempts WHERE message_id = ?1 ORDER BY rowid",
    )?;
    message.attempts = statement
        .query_map([id], |row| {
            Ok(ChatSubmissionAttempt {
                id: row.get(0)?,
                intent: named(row, 1)?,
                delivery: named(row, 2)?,
                turn_id: row.get(3)?,
                detail: row.get(4)?,
                recorded_at: row.get(5)?,
                decision: row
                    .get::<_, Option<String>>(6)?
                    .map(|_| named(row, 6))
                    .transpose()?,
            })
        })?
        .collect::<Result<_, _>>()?;
    message.queued =
        message.role == ChatRole::User && message.standing() == ChatInputStanding::Queued;
    Ok(Some(message))
}

fn read_item(connection: &Connection, kind: &str, id: &str) -> Result<Option<ChatItem>, Error> {
    Ok(match kind {
        "message" => read_message(connection, id)?.map(ChatItem::Message),
        "turn" => connection
            .query_row(&format!("{TURN} WHERE id = ?1"), [id], turn_from_row)
            .optional()?
            .map(ChatItem::Turn),
        "session" => connection
            .query_row(
                "SELECT id, position, native_session_id, origin, started_at FROM chat_sessions WHERE id = ?1",
                [id],
                |row| {
                    Ok(ChatSession {
                        id: row.get(0)?,
                        position: row.get(1)?,
                        native_session_id: row.get(2)?,
                        origin: named(row, 3)?,
                        started_at: row.get(4)?,
                    })
                },
            )
            .optional()?
            .map(ChatItem::Session),
        "tool" => connection
            .query_row(
                "SELECT id, position, turn_id, name, input, state, output, output_truncated FROM chat_tools WHERE id = ?1",
                [id],
                |row| {
                    Ok(ChatTool {
                        id: row.get(0)?,
                        position: row.get(1)?,
                        turn_id: row.get(2)?,
                        name: row.get(3)?,
                        input: row.get(4)?,
                        state: named(row, 5)?,
                        output: row.get(6)?,
                        output_truncated: row.get(7)?,
                    })
                },
            )
            .optional()?
            .map(ChatItem::Tool),
        "interaction" => connection
            .query_row(
                "SELECT id, position, turn_id, kind, native_request_id, prompt, state, response, reason FROM chat_interactions WHERE id = ?1",
                [id],
                |row| {
                    Ok(ChatInteraction {
                        id: row.get(0)?,
                        position: row.get(1)?,
                        turn_id: row.get(2)?,
                        kind: named(row, 3)?,
                        native_request_id: row.get(4)?,
                        prompt: row.get(5)?,
                        state: named(row, 6)?,
                        response: row.get(7)?,
                        reason: row.get(8)?,
                    })
                },
            )
            .optional()?
            .map(ChatItem::Interaction),
        "notice" => connection
            .query_row(
                "SELECT id, position, text, created_at FROM chat_notices WHERE id = ?1",
                [id],
                |row| {
                    Ok(ChatNotice {
                        id: row.get(0)?,
                        position: row.get(1)?,
                        text: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
            .optional()?
            .map(ChatItem::Notice),
        _ => None,
    })
}

fn read_history(
    connection: &Connection,
    chat_id: &str,
    before: i64,
    limit: usize,
) -> Result<ChatHistoryPage, Error> {
    let mut statement = connection.prepare(
        "SELECT kind, id FROM (
             SELECT position, 'session' AS kind, id, chat_id FROM chat_sessions
             UNION ALL SELECT position, 'message', id, chat_id FROM chat_messages
             UNION ALL SELECT position, 'turn', id, chat_id FROM chat_turns
             UNION ALL SELECT position, 'tool', id, chat_id FROM chat_tools
             UNION ALL SELECT position, 'interaction', id, chat_id FROM chat_interactions
             UNION ALL SELECT position, 'notice', id, chat_id FROM chat_notices)
         WHERE chat_id = ?1 AND position < ?2 ORDER BY position DESC LIMIT ?3",
    )?;
    let mut subjects = statement
        .query_map(params![chat_id, before, limit as i64 + 1], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let earlier = subjects.len() > limit;
    subjects.truncate(limit);
    let mut items = Vec::with_capacity(subjects.len());
    for (kind, id) in subjects.iter().rev() {
        items.extend(read_item(connection, kind, id)?);
    }
    Ok(ChatHistoryPage { items, earlier })
}

fn ensure_link_target(connection: &Connection, link: &ChatLink) -> Result<(), Error> {
    let (table, missing): (&str, fn(String) -> Error) = match link.kind {
        ChatLinkKind::Project => ("projects", Error::ProjectNotFound),
        ChatLinkKind::Ticket => ("tickets", Error::NotFound),
        ChatLinkKind::Document => ("documents", Error::DocumentNotFound),
    };
    let exists: bool = connection.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
        [&link.id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(missing(link.id.clone()))
    }
}

fn add_link(connection: &Connection, chat_id: &str, link: &ChatLink) -> Result<(), Error> {
    ensure_link_target(connection, link)?;
    connection.execute(
        "INSERT OR IGNORE INTO chat_links (chat_id, kind, target_id) VALUES (?1, ?2, ?3)",
        params![chat_id, name(link.kind)?, link.id],
    )?;
    Ok(())
}

/// Runs `create` once per command ID and returns the ID of the record it created.
/// A command ID deduplicates this ticketd write only; it promises nothing about the harness.
fn once(
    connection: &Connection,
    command_id: Option<&str>,
    request: Value,
    create: impl FnOnce() -> Result<String, Error>,
) -> Result<String, Error> {
    let Some(command_id) = command_id else {
        return create();
    };
    let request = request.to_string();
    let stored: Option<(String, String)> = connection
        .query_row(
            "SELECT request, outcome FROM request_outcomes WHERE id = ?1",
            [command_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((previous, outcome)) = stored {
        if previous != request {
            return Err(Error::RequestConflict(command_id.to_owned()));
        }
        return Ok(serde_json::from_str(&outcome)?);
    }
    let id = create()?;
    connection.execute(
        "INSERT INTO request_outcomes (id, request, outcome) VALUES (?1, ?2, ?3)",
        params![command_id, request, serde_json::to_string(&id)?],
    )?;
    Ok(id)
}

/// The last `CHAT_TOOL_OUTPUT_LIMIT` bytes of `output`, and whether its start was dropped.
fn bounded(mut output: String) -> (String, bool) {
    if output.len() <= CHAT_TOOL_OUTPUT_LIMIT {
        return (output, false);
    }
    let mut start = output.len() - CHAT_TOOL_OUTPUT_LIMIT;
    while !output.is_char_boundary(start) {
        start += 1;
    }
    output.drain(..start);
    (output, true)
}

/// Whether a record with this ID exists, refusing one that belongs to another Chat.
fn owned(connection: &Connection, table: &str, chat_id: &str, id: &str) -> Result<bool, Error> {
    let owner: Option<String> = connection
        .query_row(
            &format!("SELECT chat_id FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        None => Ok(false),
        Some(owner) if owner == chat_id => Ok(true),
        Some(_) => Err(invalid(format!("'{id}' belongs to another Chat"))),
    }
}

fn require_turn(connection: &Connection, chat_id: &str, turn_id: &str) -> Result<(), Error> {
    if owned(connection, "chat_turns", chat_id, turn_id)? {
        Ok(())
    } else {
        Err(invalid(format!(
            "turn '{turn_id}' was not recorded for this Chat"
        )))
    }
}

fn observe_delivery(
    connection: &Connection,
    chat_id: &str,
    attempt_id: &str,
    delivery: ChatDelivery,
    detail: Option<&str>,
) -> Result<(), Error> {
    let (message_id, current) = connection
        .query_row(
            "SELECT message_id, delivery FROM chat_submission_attempts WHERE id = ?1 AND chat_id = ?2",
            params![attempt_id, chat_id],
            |row| Ok((row.get::<_, String>(0)?, named::<ChatDelivery>(row, 1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            invalid(format!(
                "submission attempt '{attempt_id}' was not recorded for this Chat"
            ))
        })?;
    if current == delivery {
        return Ok(());
    }
    // Only an open question can be settled; a settled observation is never rewritten.
    if !matches!(current, ChatDelivery::Possible | ChatDelivery::Uncertain) {
        return Err(invalid(format!(
            "submission attempt '{attempt_id}' is already recorded as {}",
            name(current)?
        )));
    }
    connection.execute(
        "UPDATE chat_submission_attempts SET delivery = ?2, detail = COALESCE(?3, detail) WHERE id = ?1",
        params![attempt_id, name(delivery)?, detail],
    )?;
    log(connection, chat_id, "message", &message_id)?;
    Ok(())
}

fn expire_interactions(
    connection: &Connection,
    chat_id: &str,
    turn_id: Option<&str>,
) -> Result<(), Error> {
    let mut statement = connection.prepare(
        "SELECT id FROM chat_interactions WHERE chat_id = ?1 AND state = 'pending' AND (?2 IS NULL OR turn_id = ?2)",
    )?;
    let pending = statement
        .query_map(params![chat_id, turn_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in pending {
        connection.execute(
            "UPDATE chat_interactions SET state = 'expired' WHERE id = ?1",
            [&id],
        )?;
        log(connection, chat_id, "interaction", &id)?;
    }
    Ok(())
}

fn observe(
    connection: &Connection,
    chat_id: &str,
    observation: ChatObservation,
) -> Result<(), Error> {
    match observation {
        ChatObservation::SubmissionNotDelivered { attempt_id, detail } => observe_delivery(
            connection,
            chat_id,
            &attempt_id,
            ChatDelivery::NotDelivered,
            detail.as_deref(),
        ),
        ChatObservation::SubmissionRejected { attempt_id, detail } => observe_delivery(
            connection,
            chat_id,
            &attempt_id,
            ChatDelivery::Rejected,
            detail.as_deref(),
        ),
        ChatObservation::SubmissionAcknowledged { attempt_id } => observe_delivery(
            connection,
            chat_id,
            &attempt_id,
            ChatDelivery::Acknowledged,
            None,
        ),
        ChatObservation::SubmissionUncertain { attempt_id, detail } => observe_delivery(
            connection,
            chat_id,
            &attempt_id,
            ChatDelivery::Uncertain,
            detail.as_deref(),
        ),
        ChatObservation::SubmissionProcessing {
            attempt_id,
            turn_id,
        } => {
            require_turn(connection, chat_id, &turn_id)?;
            let message_id: Option<String> = connection
                .query_row(
                    "UPDATE chat_submission_attempts SET turn_id = ?3 WHERE id = ?1 AND chat_id = ?2 RETURNING message_id",
                    params![attempt_id, chat_id, turn_id],
                    |row| row.get(0),
                )
                .optional()?;
            let message_id = message_id.ok_or_else(|| {
                invalid(format!(
                    "submission attempt '{attempt_id}' was not recorded for this Chat"
                ))
            })?;
            log(connection, chat_id, "message", &message_id)?;
            Ok(())
        }
        ChatObservation::TurnStarted {
            turn_id,
            native_turn_id,
        } => {
            if owned(connection, "chat_turns", chat_id, &turn_id)? {
                return Ok(());
            }
            let active: Option<String> = connection
                .query_row(
                    "SELECT id FROM chat_turns WHERE chat_id = ?1 AND state = 'active'",
                    [chat_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(active) = active {
                return Err(invalid(format!(
                    "turn '{active}' is still active; a Chat has one active turn"
                )));
            }
            let position = log(connection, chat_id, "turn", &turn_id)?;
            connection.execute(
                "INSERT INTO chat_turns (id, chat_id, position, native_turn_id, state) VALUES (?1, ?2, ?3, ?4, 'active')",
                params![turn_id, chat_id, position, native_turn_id],
            )?;
            Ok(())
        }
        ChatObservation::TurnEnded {
            turn_id,
            state,
            detail,
            problem,
            problem_resets_at,
        } => {
            require_turn(connection, chat_id, &turn_id)?;
            let resets_at = problem_resets_at.filter(|at| (0..=CHAT_RESET_TIME_MAX).contains(at));
            if state == ChatTurnState::Active {
                return Err(invalid("a turn cannot end as active"));
            }
            let current: ChatTurnState = connection.query_row(
                "SELECT state FROM chat_turns WHERE id = ?1",
                [&turn_id],
                |row| named(row, 0),
            )?;
            if current == state {
                return Ok(());
            }
            // Later evidence can settle an unknown outcome; an observed outcome stands.
            if !matches!(current, ChatTurnState::Active | ChatTurnState::Unknown) {
                return Err(invalid(format!(
                    "turn '{turn_id}' already ended as {}",
                    name(current)?
                )));
            }
            connection.execute(
                &format!("UPDATE chat_turns SET state = ?2, detail = ?3, problem = ?4, problem_resets_at = ?5, ended_at = COALESCE(ended_at, {NOW}) WHERE id = ?1"),
                params![turn_id, name(state)?, detail, problem, resets_at],
            )?;
            log(connection, chat_id, "turn", &turn_id)?;
            expire_interactions(connection, chat_id, Some(&turn_id))
        }
        ChatObservation::AssistantText {
            message_id,
            turn_id,
            text,
            complete,
        } => {
            require_turn(connection, chat_id, &turn_id)?;
            if owned(connection, "chat_messages", chat_id, &message_id)? {
                let updated = connection.execute(
                    "UPDATE chat_messages SET text = ?2, complete = ?3 WHERE id = ?1 AND role = 'assistant'",
                    params![message_id, text, complete],
                )?;
                if updated == 0 {
                    return Err(invalid(format!(
                        "'{message_id}' is user input, not assistant text"
                    )));
                }
                log(connection, chat_id, "message", &message_id)?;
            } else {
                let position = log(connection, chat_id, "message", &message_id)?;
                connection.execute(
                    "INSERT INTO chat_messages (id, chat_id, position, role, text, complete, turn_id) VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6)",
                    params![message_id, chat_id, position, text, complete, turn_id],
                )?;
            }
            Ok(())
        }
        ChatObservation::Tool {
            tool_id,
            turn_id,
            name: tool_name,
            input,
            state,
            output,
        } => {
            require_turn(connection, chat_id, &turn_id)?;
            let (output, truncated) = match output.map(bounded) {
                Some((output, truncated)) => (Some(output), truncated),
                None => (None, false),
            };
            if owned(connection, "chat_tools", chat_id, &tool_id)? {
                connection.execute(
                    "UPDATE chat_tools SET name = ?2, input = ?3, state = ?4, output = ?5, output_truncated = ?6 WHERE id = ?1",
                    params![tool_id, tool_name, input, name(state)?, output, truncated],
                )?;
                log(connection, chat_id, "tool", &tool_id)?;
            } else {
                let position = log(connection, chat_id, "tool", &tool_id)?;
                connection.execute(
                    "INSERT INTO chat_tools (id, chat_id, position, turn_id, name, input, state, output, output_truncated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![tool_id, chat_id, position, turn_id, tool_name, input, name(state)?, output, truncated],
                )?;
            }
            Ok(())
        }
        ChatObservation::InteractionRequested {
            interaction_id,
            turn_id,
            kind,
            native_request_id,
            prompt,
            reason,
        } => {
            require_turn(connection, chat_id, &turn_id)?;
            if owned(connection, "chat_interactions", chat_id, &interaction_id)? {
                return Ok(());
            }
            let position = log(connection, chat_id, "interaction", &interaction_id)?;
            let reason: Option<String> =
                reason.map(|reason| reason.chars().take(CHAT_NOTICE_LIMIT).collect());
            connection.execute(
                "INSERT INTO chat_interactions (id, chat_id, position, turn_id, kind, native_request_id, prompt, reason, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')",
                params![interaction_id, chat_id, position, turn_id, name(kind)?, native_request_id, prompt, reason],
            )?;
            Ok(())
        }
        ChatObservation::InteractionResolved {
            interaction_id,
            state,
            response,
        } => {
            if state == ChatInteractionState::Pending {
                return Err(invalid("an interaction cannot resolve as pending"));
            }
            let current: Option<ChatInteractionState> = connection
                .query_row(
                    "SELECT state FROM chat_interactions WHERE id = ?1 AND chat_id = ?2",
                    params![interaction_id, chat_id],
                    |row| named(row, 0),
                )
                .optional()?;
            let current = current.ok_or_else(|| {
                invalid(format!(
                    "interaction '{interaction_id}' was not recorded for this Chat"
                ))
            })?;
            if current == state {
                return Ok(());
            }
            if current != ChatInteractionState::Pending {
                return Err(invalid(format!(
                    "interaction '{interaction_id}' is already {}; only a current request can be answered",
                    name(current)?
                )));
            }
            connection.execute(
                "UPDATE chat_interactions SET state = ?2, response = ?3 WHERE id = ?1",
                params![interaction_id, name(state)?, response],
            )?;
            log(connection, chat_id, "interaction", &interaction_id)?;
            Ok(())
        }
        ChatObservation::Notice { notice_id, text } => {
            if owned(connection, "chat_notices", chat_id, &notice_id)? {
                return Ok(());
            }
            let text: String = text.chars().take(CHAT_NOTICE_LIMIT).collect();
            let position = log(connection, chat_id, "notice", &notice_id)?;
            connection.execute(
                "INSERT INTO chat_notices (id, chat_id, position, text) VALUES (?1, ?2, ?3, ?4)",
                params![notice_id, chat_id, position, text],
            )?;
            Ok(())
        }
    }
}

/// The saved input `message_id` of this Chat.
fn require_input(
    connection: &Connection,
    chat_id: &str,
    message_id: &str,
) -> Result<ChatMessage, Error> {
    let not_input = || invalid(format!("'{message_id}' is not saved input of this Chat"));
    if !owned(connection, "chat_messages", chat_id, message_id)? {
        return Err(not_input());
    }
    read_message(connection, message_id)?
        .filter(|message| message.role == ChatRole::User)
        .ok_or_else(not_input)
}

/// Records the person's decision on the submission of `message` whose delivery is
/// still unknown. A later decision replaces an earlier one that was not carried out.
fn decide(
    connection: &Connection,
    chat_id: &str,
    message: &ChatMessage,
    decision: ChatDeliveryDecision,
) -> Result<(), Error> {
    let attempt = message
        .open_question()
        .filter(|_| message.awaits_decision())
        .ok_or_else(|| Error::ChatSubmissionUnresolved(message.id.clone()))?;
    connection.execute(
        "UPDATE chat_submission_attempts SET decision = ?2 WHERE id = ?1",
        params![attempt.id, name(decision)?],
    )?;
    log(connection, chat_id, "message", &message.id)?;
    Ok(())
}

/// Records that nothing more will be observed from this Chat's runtime: the active turn's
/// outcome is unknown, possible submissions are uncertain, and open requests expire.
fn lose_contact(connection: &Connection, chat_id: &str, detail: &str) -> Result<(), Error> {
    let ids = |sql: &str| -> Result<Vec<String>, Error> {
        let mut statement = connection.prepare(sql)?;
        let ids = statement
            .query_map([chat_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    };
    for id in ids("SELECT id FROM chat_turns WHERE chat_id = ?1 AND state = 'active'")? {
        connection.execute(
            &format!("UPDATE chat_turns SET state = 'unknown', detail = ?2, ended_at = {NOW} WHERE id = ?1"),
            params![id, detail],
        )?;
        log(connection, chat_id, "turn", &id)?;
    }
    for id in ids("SELECT id FROM chat_tools WHERE chat_id = ?1 AND state = 'running'")? {
        connection.execute(
            "UPDATE chat_tools SET state = 'unknown' WHERE id = ?1",
            [&id],
        )?;
        log(connection, chat_id, "tool", &id)?;
    }
    expire_interactions(connection, chat_id, None)?;
    for id in ids(
        "SELECT DISTINCT message_id FROM chat_submission_attempts WHERE chat_id = ?1 AND delivery = 'possible' AND turn_id IS NULL",
    )? {
        connection.execute(
            "UPDATE chat_submission_attempts SET delivery = 'uncertain', detail = ?2 WHERE message_id = ?1 AND delivery = 'possible' AND turn_id IS NULL",
            params![id, detail],
        )?;
        log(connection, chat_id, "message", &id)?;
    }
    trim(connection, chat_id)
}

impl Workspace {
    /// One immediate transaction: records and their change entries commit together or not at all.
    fn chat_write<T>(
        &mut self,
        write: impl FnOnce(&Connection) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let result = write(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }

    fn update_chat(
        &mut self,
        id: &str,
        update: impl FnOnce(&Connection) -> Result<(), Error>,
    ) -> Result<Chat, Error> {
        self.chat_write(|connection| {
            read_chat(connection, id)?;
            update(connection)?;
            log(connection, id, "chat", id)?;
            trim(connection, id)?;
            read_chat(connection, id)
        })
    }

    /// Create a Chat. Repeating `command_id` with the same content returns the first Chat.
    pub fn create_chat(&mut self, command_id: Option<&str>, chat: NewChat) -> Result<Chat, Error> {
        if chat.harness.trim().is_empty() || chat.execution_folder.trim().is_empty() {
            return Err(invalid("a Chat needs a harness and an execution folder"));
        }
        self.chat_write(|connection| {
            let request = json!({"operation": "create_chat", "chat": &chat});
            let id = once(connection, command_id, request, || {
                let id = Uuid::new_v4().to_string();
                let title = chat.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
                connection.execute(
                    "INSERT INTO chats (id, title, harness, execution_folder, folder_managed) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, title, chat.harness, chat.execution_folder, chat.folder_managed],
                )?;
                for link in &chat.links {
                    add_link(connection, &id, link)?;
                }
                log(connection, &id, "chat", &id)?;
                Ok(id)
            })?;
            read_chat(connection, &id)
        })
    }

    pub fn chat(&self, id: &str) -> Result<Chat, Error> {
        read_chat(&self.connection, id)
    }

    /// The Chat's linked records as they are now, in link order.
    pub fn chat_linked_records(&self, id: &str) -> Result<Vec<ChatLinkedRecord>, Error> {
        let heading = crate::documents::HEADING;
        let mut records = Vec::new();
        for link in self.chat(id)?.links {
            let query = match link.kind {
                ChatLinkKind::Project => {
                    "SELECT NULL, substr(name, 1, 200), 0 FROM projects WHERE id = ?1".to_owned()
                }
                ChatLinkKind::Ticket => {
                    "SELECT reference, substr(title, 1, 200), trashed FROM tickets WHERE id = ?1"
                        .to_owned()
                }
                ChatLinkKind::Document => {
                    format!("SELECT NULL, {heading}, d.trashed FROM documents d WHERE d.id = ?1")
                }
            };
            let found = self
                .connection
                .query_row(&query, [&link.id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .optional()?;
            // Linked records are trashed, never deleted; a missing one has nothing to show.
            if let Some((reference, title, trashed)) = found {
                records.push(ChatLinkedRecord {
                    kind: link.kind,
                    id: link.id,
                    reference,
                    title,
                    trashed,
                });
            }
        }
        Ok(records)
    }

    /// Chats with the most recently changed first.
    // ponytail: unpaged; add a limit when workspaces hold thousands of Chats.
    pub fn list_chats(&self, filter: ChatListFilter) -> Result<Vec<Chat>, Error> {
        let scope = match filter {
            ChatListFilter::Active => "trashed = 0 AND archived = 0",
            ChatListFilter::Archived => "trashed = 0 AND archived = 1",
            ChatListFilter::Trashed => "trashed = 1",
        };
        let mut statement = self.connection.prepare(&format!(
            "SELECT id FROM chats WHERE {scope} ORDER BY (SELECT MAX(sequence) FROM chat_changes WHERE chat_id = chats.id) DESC, id"
        ))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| read_chat(&self.connection, id))
            .collect()
    }

    pub fn set_chat_title(&mut self, id: &str, title: Option<&str>) -> Result<Chat, Error> {
        let title = title.map(str::trim).filter(|title| !title.is_empty());
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET title = ?2 WHERE id = ?1",
                params![id, title],
            )?;
            Ok(())
        })
    }

    /// Point the Chat at another folder, for example when its folder is missing after a restore.
    pub fn set_chat_execution_folder(
        &mut self,
        id: &str,
        folder: &str,
        managed: bool,
    ) -> Result<Chat, Error> {
        if folder.trim().is_empty() {
            return Err(invalid("a Chat needs an execution folder"));
        }
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET execution_folder = ?2, folder_managed = ?3 WHERE id = ?1",
                params![id, folder, managed],
            )?;
            Ok(())
        })
    }

    /// Logs a change of the Chat record with nothing stored changed, for a change views
    /// must see that lives outside the workspace, such as its folder going missing or
    /// coming back.
    pub fn mark_chat_changed(&mut self, id: &str) -> Result<Chat, Error> {
        self.update_chat(id, |_| Ok(()))
    }

    /// Add or remove a link. The linked record is validated but never changed.
    pub fn set_chat_link(
        &mut self,
        id: &str,
        link: ChatLink,
        present: bool,
    ) -> Result<Chat, Error> {
        self.update_chat(id, |connection| {
            if present {
                add_link(connection, id, &link)
            } else {
                connection.execute(
                    "DELETE FROM chat_links WHERE chat_id = ?1 AND kind = ?2 AND target_id = ?3",
                    params![id, name(link.kind)?, link.id],
                )?;
                Ok(())
            }
        })
    }

    /// Archive hides a Chat; it does not stop its work or change its queue.
    pub fn set_chat_archived(&mut self, id: &str, archived: bool) -> Result<Chat, Error> {
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET archived = ?2 WHERE id = ?1",
                params![id, archived],
            )?;
            Ok(())
        })
    }

    /// Move a Chat to or from the trash, keeping its history, queue, links and files.
    /// A trashed Chat accepts no new input or submission; the returned `active_turn`
    /// tells the host what it still has to stop. Restoring never dispatches anything.
    pub fn set_chat_trashed(&mut self, id: &str, trashed: bool) -> Result<Chat, Error> {
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET trashed = ?2 WHERE id = ?1",
                params![id, trashed],
            )?;
            Ok(())
        })
    }

    pub fn set_chat_queue_paused(&mut self, id: &str, paused: bool) -> Result<Chat, Error> {
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET queue_paused = ?2 WHERE id = ?1",
                params![id, paused],
            )?;
            Ok(())
        })
    }

    /// Record the harness-session identity now in use. A new identity is appended to the
    /// Chat's history; reporting the current one again changes nothing.
    pub fn record_chat_session(
        &mut self,
        id: &str,
        native_session_id: &str,
        origin: ChatSessionOrigin,
    ) -> Result<Chat, Error> {
        self.chat_write(|connection| {
            let chat = read_chat(connection, id)?;
            if chat.native_session_id.as_deref() == Some(native_session_id) {
                return Ok(chat);
            }
            let session = Uuid::new_v4().to_string();
            let position = log(connection, id, "session", &session)?;
            connection.execute(
                "INSERT INTO chat_sessions (id, chat_id, position, native_session_id, origin) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session, id, position, native_session_id, name(origin)?],
            )?;
            log(connection, id, "chat", id)?;
            trim(connection, id)?;
            read_chat(connection, id)
        })
    }

    /// Save user input before any dispatch. It stays queued until a submission is recorded.
    /// Repeating `command_id` with the same content returns the first message.
    pub fn save_chat_input(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
    ) -> Result<ChatMessage, Error> {
        if text.trim().is_empty() {
            return Err(invalid("Chat input must not be empty"));
        }
        self.chat_write(|connection| {
            let request = json!({"operation": "save_chat_input", "chat_id": chat_id, "text": text});
            let id = once(connection, command_id, request, || {
                if read_chat(connection, chat_id)?.trashed {
                    return Err(Error::ChatTrashed(chat_id.to_owned()));
                }
                let id = Uuid::new_v4().to_string();
                let position = log(connection, chat_id, "message", &id)?;
                connection.execute(
                    "INSERT INTO chat_messages (id, chat_id, position, role, text, complete) VALUES (?1, ?2, ?3, 'user', ?4, 1)",
                    params![id, chat_id, position, text],
                )?;
                trim(connection, chat_id)?;
                Ok(id)
            })?;
            read_message(connection, &id)?.ok_or_else(|| invalid("saved input is missing"))
        })
    }

    /// Withdraw queued input the person no longer wants sent. Refused once a submission
    /// may have reached the harness: that input is history, not queue.
    pub fn withdraw_chat_input(&mut self, chat_id: &str, message_id: &str) -> Result<Chat, Error> {
        self.update_chat(chat_id, |connection| {
            let queued = owned(connection, "chat_messages", chat_id, message_id)?
                && read_message(connection, message_id)?.is_some_and(|message| message.queued);
            if !queued {
                return Err(invalid("this input is not in the queue"));
            }
            connection.execute(
                "DELETE FROM chat_submission_attempts WHERE message_id = ?1",
                [message_id],
            )?;
            connection.execute("DELETE FROM chat_messages WHERE id = ?1", [message_id])?;
            Ok(())
        })
    }

    /// Queued input in the order it was saved.
    pub fn chat_queue(&self, chat_id: &str) -> Result<Vec<ChatMessage>, Error> {
        read_chat(&self.connection, chat_id)?;
        let mut statement = self.connection.prepare(
            "SELECT id FROM chat_messages m WHERE chat_id = ?1 AND role = 'user'
               AND NOT EXISTS (SELECT 1 FROM chat_submission_attempts a WHERE a.message_id = m.id AND a.delivery IN ('possible', 'acknowledged', 'uncertain'))
             ORDER BY position",
        )?;
        let ids = statement
            .query_map([chat_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        // The query narrows; `queued` is the rule, with the person's decisions in view.
        let mut queue = Vec::with_capacity(ids.len());
        for id in ids {
            queue.extend(read_message(&self.connection, &id)?.filter(|message| message.queued));
        }
        Ok(queue)
    }

    /// Record, before handing input to the harness, that it may be about to receive it.
    /// `attempt_id` is the host's submission identity; repeating it records nothing new.
    /// Refused while an earlier attempt for the same input may have been delivered, so
    /// unknown delivery can never turn into a second submission.
    pub fn record_chat_submission(
        &mut self,
        chat_id: &str,
        message_id: &str,
        attempt_id: &str,
        intent: ChatSubmissionIntent,
    ) -> Result<ChatMessage, Error> {
        self.submit_input(chat_id, message_id, attempt_id, intent, false)
    }

    /// `record_chat_submission` for input sent from the queue. Queued input has no place
    /// in the transcript until it is sent, so it is moved to the end of the history:
    /// read again later, it stands before its own reply, as a live view showed it.
    pub fn record_chat_queue_submission(
        &mut self,
        chat_id: &str,
        message_id: &str,
        attempt_id: &str,
        intent: ChatSubmissionIntent,
    ) -> Result<ChatMessage, Error> {
        self.submit_input(chat_id, message_id, attempt_id, intent, true)
    }

    fn submit_input(
        &mut self,
        chat_id: &str,
        message_id: &str,
        attempt_id: &str,
        intent: ChatSubmissionIntent,
        from_queue: bool,
    ) -> Result<ChatMessage, Error> {
        self.chat_write(|connection| {
            if read_chat(connection, chat_id)?.trashed {
                return Err(Error::ChatTrashed(chat_id.to_owned()));
            }
            let message = require_input(connection, chat_id, message_id)?;
            let recorded: Option<String> = connection
                .query_row(
                    "SELECT message_id FROM chat_submission_attempts WHERE id = ?1",
                    [attempt_id],
                    |row| row.get(0),
                )
                .optional()?;
            match recorded {
                Some(recorded) if recorded == message_id => return Ok(message),
                Some(_) => return Err(Error::RequestConflict(attempt_id.to_owned())),
                None => {}
            }
            if !message.queued {
                return Err(Error::ChatSubmissionUnresolved(message_id.to_owned()));
            }
            connection.execute(
                "INSERT INTO chat_submission_attempts (id, chat_id, message_id, intent, delivery) VALUES (?1, ?2, ?3, ?4, 'possible')",
                params![attempt_id, chat_id, message_id, name(intent)?],
            )?;
            let sequence = log(connection, chat_id, "message", message_id)?;
            // Positions are change sequences, so this one is unused and the latest.
            if from_queue && message.attempts.is_empty() {
                connection.execute(
                    "UPDATE chat_messages SET position = ?1 WHERE id = ?2",
                    params![sequence, message_id],
                )?;
            }
            trim(connection, chat_id)?;
            read_message(connection, message_id)?.ok_or_else(|| invalid("saved input is missing"))
        })
    }

    /// Record that the person asked for input whose delivery is uncertain to be sent
    /// again. The uncertain attempt keeps what was observed and gains the decision; the
    /// new submission is its own attempt, recorded as possible before the hand-off.
    /// Refused unless the input awaits the person's decision, so this can never follow
    /// from anything but their request. Repeating `attempt_id` records
    /// nothing new.
    pub fn record_chat_resubmission(
        &mut self,
        chat_id: &str,
        message_id: &str,
        attempt_id: &str,
    ) -> Result<ChatMessage, Error> {
        self.chat_write(|connection| {
            if read_chat(connection, chat_id)?.trashed {
                return Err(Error::ChatTrashed(chat_id.to_owned()));
            }
            let message = require_input(connection, chat_id, message_id)?;
            if message.attempts.iter().any(|a| a.id == attempt_id) {
                return Ok(message);
            }
            decide(connection, chat_id, &message, ChatDeliveryDecision::Resent)?;
            connection.execute(
                "INSERT INTO chat_submission_attempts (id, chat_id, message_id, intent, delivery) VALUES (?1, ?2, ?3, ?4, 'possible')",
                params![attempt_id, chat_id, message_id, name(ChatSubmissionIntent::NewTurn)?],
            )?;
            trim(connection, chat_id)?;
            read_message(connection, message_id)?.ok_or_else(|| invalid("saved input is missing"))
        })
    }

    /// Record that the person set aside input whose delivery is uncertain. The message
    /// and its attempt stay in history as uncertain; it is never sent again.
    pub fn discard_uncertain_chat_submission(
        &mut self,
        chat_id: &str,
        message_id: &str,
    ) -> Result<ChatMessage, Error> {
        self.chat_write(|connection| {
            let message = require_input(connection, chat_id, message_id)?;
            decide(
                connection,
                chat_id,
                &message,
                ChatDeliveryDecision::Discarded,
            )?;
            trim(connection, chat_id)?;
            read_message(connection, message_id)?.ok_or_else(|| invalid("saved input is missing"))
        })
    }

    /// Keep the settings the harness reported as in effect, replacing an earlier report.
    /// Cut to `CHAT_EFFECTIVE_SETTINGS_LIMIT` characters.
    pub fn set_chat_effective_settings(&mut self, id: &str, settings: &str) -> Result<Chat, Error> {
        let settings: String = settings
            .chars()
            .take(CHAT_EFFECTIVE_SETTINGS_LIMIT)
            .collect();
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET effective_settings = ?2 WHERE id = ?1",
                params![id, settings],
            )?;
            Ok(())
        })
    }

    /// Record observations in order, atomically with their change entries, and return the
    /// change sequence afterwards. If one is invalid, none is recorded. Observations for a
    /// trashed Chat are accepted so that stopping its work is still recorded.
    pub fn record_chat_observations(
        &mut self,
        chat_id: &str,
        observations: Vec<ChatObservation>,
    ) -> Result<i64, Error> {
        self.chat_write(|connection| {
            read_chat(connection, chat_id)?;
            for observation in observations {
                observe(connection, chat_id, observation)?;
            }
            trim(connection, chat_id)?;
            head(connection)
        })
    }

    /// Record that the runtime behind one Chat, or behind every Chat when `chat_id` is
    /// `None`, is gone: active turns become unknown, possible submissions uncertain,
    /// running tools unknown and open requests expired. Queued input is left queued and
    /// nothing is resubmitted. Returns the Chats that had something to reconcile.
    ///
    /// The host calls this when a harness process is lost and once at startup, before it
    /// runs anything, because stored state from a previous process or a restored backup
    /// has no runtime behind it.
    pub fn mark_chat_contact_lost(
        &mut self,
        chat_id: Option<&str>,
        detail: &str,
    ) -> Result<Vec<String>, Error> {
        self.chat_write(|connection| {
            if let Some(id) = chat_id {
                read_chat(connection, id)?;
            }
            let mut statement = connection.prepare(
                "SELECT id FROM chats WHERE (?1 IS NULL OR id = ?1) AND (
                     EXISTS (SELECT 1 FROM chat_turns WHERE chat_id = chats.id AND state = 'active')
                  OR EXISTS (SELECT 1 FROM chat_tools WHERE chat_id = chats.id AND state = 'running')
                  OR EXISTS (SELECT 1 FROM chat_interactions WHERE chat_id = chats.id AND state = 'pending')
                  OR EXISTS (SELECT 1 FROM chat_submission_attempts WHERE chat_id = chats.id AND delivery = 'possible' AND turn_id IS NULL))
                 ORDER BY rowid",
            )?;
            let affected = statement
                .query_map([chat_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            for id in &affected {
                lose_contact(connection, id, detail)?;
            }
            Ok(affected)
        })
    }

    /// Marks this connection as writing for the Chat `chat_id` (the CLI run by that
    /// Chat's harness, see `CHAT_ID_VARIABLE`): the status moves and Activities it
    /// records are credited to that Chat. Connection-scoped like `act_as_local_person`;
    /// TEMP triggers keep every write path unchanged.
    pub fn act_for_chat(&mut self, chat_id: &str) -> Result<(), Error> {
        self.connection.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS acting_chat (id TEXT NOT NULL);
             DELETE FROM acting_chat;
             CREATE TEMP TRIGGER IF NOT EXISTS acting_chat_status AFTER INSERT ON main.ticket_history WHEN NEW.kind = 'status' BEGIN
                 INSERT INTO chat_record_writes (chat_id, history_number) SELECT id, NEW.number FROM acting_chat;
             END;
             CREATE TEMP TRIGGER IF NOT EXISTS acting_chat_update AFTER INSERT ON main.activities BEGIN
                 INSERT INTO chat_record_writes (chat_id, activity_id) SELECT id, NEW.id FROM acting_chat;
             END;",
        )?;
        self.connection
            .execute("INSERT INTO acting_chat (id) VALUES (?1)", [chat_id])?;
        Ok(())
    }

    /// What the Chat's agent changed in tickets while `turn_id` ran, oldest first: status
    /// moves and Activities. A change written for this Chat (`act_for_chat`) is listed;
    /// one written for another Chat never is. A change with no Chat identity (an older
    /// CLI, or the variable stripped) is listed only when it carries the Chat's harness
    /// as agent name and no other Chat of that harness had a turn running at that
    /// moment: when one did, either could have made it, and showing nothing is better
    /// than crediting the wrong Chat.
    // Documents carry no agent name yet, so a created Document is not listed.
    pub fn chat_turn_agent_changes(
        &self,
        chat_id: &str,
        turn_id: &str,
    ) -> Result<Vec<ChatAgentChange>, Error> {
        let (agent, started, ended): (String, String, Option<String>) = self
            .connection
            .query_row(
                "SELECT c.harness, t.started_at, t.ended_at FROM chat_turns t JOIN chats c ON c.id = t.chat_id WHERE t.id = ?1 AND t.chat_id = ?2",
                params![turn_id, chat_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| invalid(format!("turn '{turn_id}' was not recorded for this Chat")))?;
        let mut statement = self.connection.prepare(
            "SELECT kind, reference, title, from_value, to_value FROM (
                 SELECT 'status' AS kind, t.reference AS reference, t.title, h.from_value, h.to_value, h.timestamp AS at, 0 AS source, h.number AS seq, h.editing_agent AS agent,
                        (SELECT chat_id FROM chat_record_writes WHERE history_number = h.number) AS writer
                 FROM ticket_history h JOIN tickets t ON t.id = h.ticket_id
                 WHERE h.kind = 'status' AND h.timestamp >= ?2 AND (?3 IS NULL OR h.timestamp <= ?3)
                 UNION ALL
                 SELECT 'update', t.reference, t.title, '', a.brief, a.reported_at, 1, a.number, a.editing_agent,
                        (SELECT chat_id FROM chat_record_writes WHERE activity_id = a.id)
                 FROM activities a JOIN tickets t ON t.id = a.ticket_id
                 WHERE a.reported_at >= ?2 AND (?3 IS NULL OR a.reported_at <= ?3))
             WHERE writer = ?5 OR (writer IS NULL AND agent = ?1 AND NOT EXISTS (
                 SELECT 1 FROM chat_turns o JOIN chats oc ON oc.id = o.chat_id
                 WHERE oc.harness = ?1 AND o.chat_id <> ?5 AND o.started_at <= at AND (o.ended_at IS NULL OR o.ended_at >= at)))
             ORDER BY at, source, seq LIMIT ?4",
        )?;
        let changes = statement
            .query_map(
                params![
                    agent,
                    started,
                    ended,
                    CHAT_AGENT_CHANGES_LIMIT as i64,
                    chat_id
                ],
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

    /// The input of the Chat's latest tool record named `name`, such as the context a
    /// session was last given.
    pub fn chat_latest_tool_input(
        &self,
        chat_id: &str,
        name: &str,
    ) -> Result<Option<String>, Error> {
        Ok(self
            .connection
            .query_row(
                "SELECT input FROM chat_tools WHERE chat_id = ?1 AND name = ?2 ORDER BY position DESC LIMIT 1",
                params![chat_id, name],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// The Chat and its latest `limit` history items, with the change sequence to follow from.
    pub fn chat_snapshot(&self, chat_id: &str, limit: usize) -> Result<ChatSnapshot, Error> {
        let transaction = self.connection.unchecked_transaction()?;
        let chat = read_chat(&transaction, chat_id)?;
        let page = read_history(&transaction, chat_id, i64::MAX, limit)?;
        let sequence = head(&transaction)?;
        transaction.commit()?;
        Ok(ChatSnapshot {
            chat,
            sequence,
            items: page.items,
            earlier: page.earlier,
        })
    }

    /// Up to `limit` history items before `before`, a position from an item already read.
    pub fn chat_history(
        &self,
        chat_id: &str,
        before: i64,
        limit: usize,
    ) -> Result<ChatHistoryPage, Error> {
        read_chat(&self.connection, chat_id)?;
        read_history(&self.connection, chat_id, before, limit)
    }

    /// The latest change sequence across all Chats; it moves on every Chat write.
    pub fn chat_change_sequence(&self) -> Result<i64, Error> {
        head(&self.connection)
    }

    /// Records of one Chat that changed after `after`, in order, at most `limit` at a time.
    /// Returns `Resync` when the cursor is older than the retained tail or is not from
    /// this workspace's log (for example after a restore).
    pub fn chat_changes(
        &self,
        chat_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<ChatCatchUp, Error> {
        let transaction = self.connection.unchecked_transaction()?;
        let trimmed_through: i64 = transaction
            .query_row(
                "SELECT changes_trimmed_through FROM chats WHERE id = ?1",
                [chat_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::ChatNotFound(chat_id.to_owned()))?;
        if after < trimmed_through || after > head(&transaction)? {
            return Ok(ChatCatchUp::Resync);
        }
        let mut statement = transaction.prepare(
            "SELECT kind, subject_id, MAX(sequence) AS latest FROM chat_changes
             WHERE chat_id = ?1 AND sequence > ?2 GROUP BY kind, subject_id ORDER BY latest LIMIT ?3",
        )?;
        let mut subjects = statement
            .query_map(params![chat_id, after, limit as i64 + 1], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let more = subjects.len() > limit;
        subjects.truncate(limit);
        let sequence = subjects.last().map_or(after, |subject| subject.2);
        let mut changes = Vec::with_capacity(subjects.len());
        for (kind, id, sequence) in subjects {
            let record = if kind == "chat" {
                Some(ChatRecord::Chat(read_chat(&transaction, &id)?))
            } else {
                read_item(&transaction, &kind, &id)?.map(ChatRecord::Item)
            };
            changes.extend(record.map(|record| ChatChange { sequence, record }));
        }
        transaction.commit()?;
        Ok(ChatCatchUp::Changes {
            changes,
            sequence,
            more,
        })
    }
}
