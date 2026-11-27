//! Durable Chat records: identity, links, input, submission attempts, observed turns,
//! tools and interactions, plus the ordered change log that Chat views follow.
//!
//! The core only records what the desktop host tells it was observed. Saving input,
//! recording a possible submission, and recording acknowledgment, processing and a
//! terminal outcome are separate writes, so a saved message is never mistaken for a
//! delivered or completed one. Nothing here dispatches work.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Error, Workspace};

pub(crate) mod attachments;
pub use attachments::{ChatAttachment, ChatAttachmentContent};
pub(crate) use credit::migrate as migrate_credit;
mod credit;
pub use credit::{
    ChatPlannedWrite, ChatPlannedWriteKind, ChatWriteCredit, TicketWriteCredits, TicketWritingAgent,
};
mod receipt;
pub(crate) mod sub_agents;
pub use receipt::ChatTurnReceipt;
pub use sub_agents::{
    ChatSubAgent, ChatSubAgentRun, ChatSubAgentState, ChatSubAgentStopper, sub_agent_title,
};
#[cfg(test)]
mod tests;

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
const CHANGE_HEAD: &str =
    "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'chat_changes'), 0)";

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
         CREATE INDEX IF NOT EXISTS chat_record_writes_history ON chat_record_writes(history_number);"
    ))?;
    Ok(())
}

/// Format 67: what the person has seen of each Chat, and whether it is muted. Chats
/// that already exist count as seen through their last turn, so upgrading marks
/// nothing unread and announces nothing.
/// Like every migration step it may run again over a schema that already has it.
pub(crate) fn migrate_attention(connection: &Connection) -> Result<(), Error> {
    let has: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chats') WHERE name = 'seen_through')",
        [],
        |row| row.get(0),
    )?;
    if !has {
        connection.execute_batch(
            "ALTER TABLE chats ADD COLUMN seen_through INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE chats ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
             UPDATE chats SET seen_through = COALESCE((SELECT MAX(position) FROM chat_turns WHERE chat_id = chats.id), 0);",
        )?;
    }
    Ok(())
}

/// Format 68: when each tool call started, so a running step can say how long it has
/// run. Calls recorded before this have no start time and show no clock.
/// Like every migration step it may run again over a schema that already has it.
pub(crate) fn migrate_tool_start(connection: &Connection) -> Result<(), Error> {
    let has: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chat_tools') WHERE name = 'started_at')",
        [],
        |row| row.get(0),
    )?;
    if !has {
        connection.execute_batch("ALTER TABLE chat_tools ADD COLUMN started_at TEXT;")?;
    }
    Ok(())
}

/// Schema 72: a request keeps when it was asked and resolved, so a turn's time can
/// leave out the time it waited on the person; a notice keeps whether the harness
/// said it, so harness warnings fold with their turn while ticketd's own stay.
pub(crate) fn migrate_request_times(connection: &Connection) -> Result<(), Error> {
    let has = |table: &str, column: &str| -> Result<bool, Error> {
        Ok(connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            params![table, column],
            |row| row.get(0),
        )?)
    };
    if !has("chat_interactions", "asked_at")? {
        connection.execute_batch(
            "ALTER TABLE chat_interactions ADD COLUMN asked_at TEXT;
             ALTER TABLE chat_interactions ADD COLUMN resolved_at TEXT;",
        )?;
    }
    if !has("chat_notices", "from_harness")? {
        connection.execute_batch(
            "ALTER TABLE chat_notices ADD COLUMN from_harness INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

/// Schema 71: Mark as unread is kept apart from an outcome the person has not seen,
/// so a Chat they marked shows the blue dot on the words it had and never reads as
/// a new Failed or Done that would notify.
pub(crate) fn migrate_marked_unread(connection: &Connection) -> Result<(), Error> {
    let has: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chats') WHERE name = 'marked_unread')",
        [],
        |row| row.get(0),
    )?;
    if !has {
        connection.execute_batch(
            "ALTER TABLE chats ADD COLUMN marked_unread INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

/// Schema 70: how far the person has read each Chat's transcript, so its New marker
/// is placed the same way after ticketd restarts. Existing Chats start with nothing
/// read through and place it from their unseen turn, as before.
pub(crate) fn migrate_read_through(connection: &Connection) -> Result<(), Error> {
    let has: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chats') WHERE name = 'read_through')",
        [],
        |row| row.get(0),
    )?;
    if !has {
        connection.execute_batch(
            "ALTER TABLE chats ADD COLUMN read_through TEXT;
             ALTER TABLE chats ADD COLUMN read_through_position INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

/// Schema 69: an approval remembers the tool call it was asked for, so its decision
/// is told on that step and not on whichever step came next.
pub(crate) fn migrate_interaction_tool(connection: &Connection) -> Result<(), Error> {
    let has: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chat_interactions') WHERE name = 'tool_id')",
        [],
        |row| row.get(0),
    )?;
    if !has {
        connection.execute_batch("ALTER TABLE chat_interactions ADD COLUMN tool_id TEXT;")?;
    }
    Ok(())
}

/// Schema 83: how each turn ended, as the host names it, so nothing has to read it back
/// out of the wording kept in `detail`. Turns recorded before this have none and the
/// host reads their state, detail and problem as it always did.
/// Like every migration step it may run again over a schema that already has it.
pub(crate) fn migrate_turn_ending(connection: &Connection) -> Result<(), Error> {
    let has: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chat_turns') WHERE name = 'ending')",
        [],
        |row| row.get(0),
    )?;
    if !has {
        connection.execute_batch("ALTER TABLE chat_turns ADD COLUMN ending TEXT;")?;
    }
    Ok(())
}

/// Format 105: every Step and approval records its owner (`sub_agent_id`, see
/// [`ChatOwner`]; `NULL`, the main agent, for everything recorded before) and may have no
/// turn. SQLite cannot drop `NOT NULL` from a column, so both tables are rebuilt with
/// `turn_id` nullable, keeping every row, position and column.
/// Like every migration step it may run again over a schema that already has it.
pub(crate) fn migrate_owner_and_optional_turn(connection: &Connection) -> Result<(), Error> {
    let done: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chat_tools') WHERE name = 'sub_agent_id')",
        [],
        |row| row.get(0),
    )?;
    if done {
        return Ok(());
    }
    connection.execute_batch(
        "CREATE TABLE chat_tools_new (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, turn_id TEXT REFERENCES chat_turns(id), name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, output TEXT, output_truncated INTEGER NOT NULL DEFAULT 0, started_at TEXT, sub_agent_id TEXT);
         INSERT INTO chat_tools_new (id, chat_id, position, turn_id, name, input, state, output, output_truncated, started_at)
             SELECT id, chat_id, position, turn_id, name, input, state, output, output_truncated, started_at FROM chat_tools;
         DROP TABLE chat_tools;
         ALTER TABLE chat_tools_new RENAME TO chat_tools;
         CREATE INDEX chat_tools_chat ON chat_tools(chat_id, position);
         CREATE TABLE chat_interactions_new (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL UNIQUE, turn_id TEXT REFERENCES chat_turns(id), kind TEXT NOT NULL, native_request_id TEXT, prompt TEXT NOT NULL, reason TEXT, state TEXT NOT NULL, response TEXT, tool_id TEXT, asked_at TEXT, resolved_at TEXT, sub_agent_id TEXT);
         INSERT INTO chat_interactions_new (id, chat_id, position, turn_id, kind, native_request_id, prompt, reason, state, response, tool_id, asked_at, resolved_at)
             SELECT id, chat_id, position, turn_id, kind, native_request_id, prompt, reason, state, response, tool_id, asked_at, resolved_at FROM chat_interactions;
         DROP TABLE chat_interactions;
         ALTER TABLE chat_interactions_new RENAME TO chat_interactions;
         CREATE INDEX chat_interactions_chat ON chat_interactions(chat_id, position);",
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

/// Option IDs the person requested for the first session, including explicit defaults.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct ChatStartPicks<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub permission: Option<&'a str>,
}

pub enum ChatCreationReplay {
    Exact(Chat),
    /// A saved request from before the requested settings were recorded.
    Legacy(Chat),
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
    /// The position of the last ended turn the person has seen: a turn that ended at a
    /// later position is unseen.
    pub seen_through: i64,
    /// The last record of the transcript that was in view in a focused window: the
    /// New marker goes after it. `None` until the person has read any.
    pub read_through: Option<String>,
    /// The person marked the Chat unread. It reads as unread until it is next seen,
    /// without making its last outcome unseen.
    pub marked_unread: bool,
    /// The person turned this Chat's notifications off.
    pub muted: bool,
    /// The native IDs of the sub-agents that lost contact and that the next message has not
    /// told the harness about yet: ticketd holds a note for it. Empty when there is none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub restart_notice: Vec<String>,
    pub created_at: String,
}

impl Chat {
    /// Whether `turn` ended and the person has not seen it since.
    pub fn unseen(&self, turn: &ChatTurn) -> bool {
        turn.state != ChatTurnState::Active && turn.position > self.seen_through
    }
}

/// A Chat as the Chat list and overview read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatSummary {
    pub chat: Chat,
    /// The other Chats outside the trash that work in the same folder ("Chats in this
    /// folder"), Active ones first, each most recently changed first.
    pub folder_chats: Vec<FolderChat>,
}

/// Another Chat working in a Chat's folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderChat {
    pub id: String,
    pub title: Option<String>,
    pub archived: bool,
    pub trashed: bool,
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
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
    /// False for assistant text still streaming or cut short by a crash.
    pub complete: bool,
    pub turn_id: Option<String>,
    /// The agent that wrote it, for assistant text: a sub-agent's words are not the main
    /// agent's reply (format 105). User input is always the main agent's.
    #[serde(default)]
    pub owner: ChatOwner,
    /// User input with no submission that may have reached the harness.
    pub queued: bool,
    /// Kept for draft recovery and excluded from dispatch while the edit is held.
    #[serde(default)]
    pub editing: bool,
    /// User input needs linked-record context before dispatch.
    #[serde(default)]
    pub requires_link_context: bool,
    /// What ticketd added to this message for the harness, besides the person's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<ChatMessageNote>,
    pub attempts: Vec<ChatSubmissionAttempt>,
    pub created_at: String,
}

/// What ticketd told the harness along with a message, kept as it was said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessageNote {
    pub kind: ChatMessageNoteKind,
    /// The native IDs of the sub-agents it is about.
    pub sub_agents: Vec<String>,
    /// Exactly the text that was added.
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageNoteKind {
    /// Sub-agents lost contact when ticketd quit.
    LostSubAgents,
}

/// A saved request can outlive its queued message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatInputReceipt {
    pub id: String,
    pub message: Option<ChatMessage>,
}

/// The held messages a queued edit replaces and its complete set of links.
#[derive(Debug, Clone)]
pub struct ChatQueueEdit {
    pub replaces: Vec<String>,
    pub links: Vec<ChatLink>,
}

/// Links to add when saving input, or a queued edit that also consumes held messages.
#[derive(Debug)]
pub enum ChatInputChange {
    Link(Vec<ChatLink>),
    Edit(ChatQueueEdit),
}

impl ChatInputReceipt {
    pub fn into_message(self) -> Result<ChatMessage, Error> {
        self.message
            .ok_or_else(|| invalid("saved input is missing"))
    }
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
    /// How the turn ended, as the host names it (format 83). The core keeps the key
    /// and decides nothing from it; `None` on a turn recorded before it existed or
    /// still active.
    #[serde(default)]
    pub ending: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// Who started the turn when the person did not (format 105): the harness resuming
    /// the main agent by itself, or ticketd waking it. `None`: the person's message did.
    #[serde(default)]
    pub origin: Option<ChatTurnOrigin>,
}

/// Who started a turn the person did not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatTurnOrigin {
    pub by: ChatTurnStarter,
    /// The native ID of the sub-agent whose finish it follows, when that is known.
    pub sub_agent: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatTurnStarter {
    /// The harness resumed the main agent by itself.
    Harness,
    /// ticketd sent the message that woke it.
    Ticketd,
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

/// Which agent a Step or an approval belongs to (format 105).
///
/// Every Step and approval has exactly one owner: the Chat's main agent, or one
/// sub-agent the Chat's harness started. A sub-agent is identified inside its Chat by the
/// harness's native ID (Claude's task ID, Codex's child thread ID, Antigravity's child
/// conversation ID). The core keeps that ID as given and decides nothing from it; the
/// sub-agent record keyed by (Chat, native ID) is a later addition.
///
/// Stored as one nullable column, `sub_agent_id`, on `chat_tools` and `chat_interactions`:
/// `NULL` is the main agent, so all data from before format 105 is the main agent's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatOwner {
    #[default]
    Main,
    SubAgent {
        /// The harness's native ID of the sub-agent, unique within the Chat.
        native_id: String,
    },
}

impl ChatOwner {
    /// The value of the `sub_agent_id` column: `None` for the main agent.
    fn column(&self) -> Option<&str> {
        match self {
            ChatOwner::Main => None,
            ChatOwner::SubAgent { native_id } => Some(native_id),
        }
    }

    fn from_column(native_id: Option<String>) -> Self {
        native_id.map_or(ChatOwner::Main, |native_id| ChatOwner::SubAgent {
            native_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatTool {
    pub id: String,
    pub position: i64,
    /// The turn the Step ran in. `None` when no turn owns it: a sub-agent's Step outside
    /// the main agent's turns (format 105).
    #[serde(default)]
    pub turn_id: Option<String>,
    /// The agent that ran the Step.
    #[serde(default)]
    pub owner: ChatOwner,
    pub name: String,
    pub input: String,
    pub state: ChatToolState,
    pub output: Option<String>,
    pub output_truncated: bool,
    /// When the host first recorded the call. `None` for calls recorded before
    /// ticketd kept it.
    pub started_at: Option<String>,
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
    /// The turn the request arrived in; `None` when no turn owns it (format 105).
    #[serde(default)]
    pub turn_id: Option<String>,
    /// The agent that asked.
    #[serde(default)]
    pub owner: ChatOwner,
    pub kind: ChatInteractionKind,
    pub native_request_id: Option<String>,
    /// For an approval, what would run or change; for a question, its text.
    pub prompt: String,
    /// Why the harness asks for an approval, apart from `prompt`. Cut to
    /// `CHAT_NOTICE_LIMIT` characters.
    pub reason: Option<String>,
    pub state: ChatInteractionState,
    pub response: Option<String>,
    /// For an approval, the tool call it was asked for, when the harness said.
    pub tool_id: Option<String>,
    /// When it was asked and when it was answered or expired. `None` for requests
    /// recorded before ticketd kept them.
    #[serde(default)]
    pub asked_at: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<String>,
}

/// Changes listed for one turn at most; a turn that made more shows the first ones.
pub const CHAT_AGENT_CHANGES_LIMIT: usize = 50;

/// The name of the tool record that keeps a Turn's `ChatAgentChange` values as JSON.
pub const AGENT_CHANGES_RECORD_NAME: &str = "ticketd changes";

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
    /// Said by the harness (a warning, a retry), not by ticketd.
    #[serde(default)]
    pub from_harness: bool,
    /// For the note that the person stopped sub-agents while no turn ran: how many.
    #[serde(default)]
    pub sub_agents_stopped: Option<i64>,
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
    /// One run of a sub-agent, where it began in the Chat's history.
    SubAgentRun(ChatSubAgentRun),
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
        /// Who started it when the person did not.
        #[serde(default)]
        origin: Option<ChatTurnOrigin>,
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
        /// How the turn ended, as the host names it; kept as given.
        #[serde(default)]
        ending: Option<String>,
    },
    /// Keep the record changes credited to an ended Turn with its transcript.
    CaptureAgentChanges {
        turn_id: String,
    },
    /// A checkpoint of an assistant message: `text` replaces what was stored.
    AssistantText {
        message_id: String,
        /// The turn it was said in, when one was active. Must be this Chat's.
        #[serde(default)]
        turn_id: Option<String>,
        /// The agent that said it. An existing message keeps the owner it was recorded with.
        #[serde(default)]
        owner: ChatOwner,
        text: String,
        complete: bool,
    },
    Tool {
        tool_id: String,
        /// The turn the Step belongs to, when one does. Must be this Chat's.
        #[serde(default)]
        turn_id: Option<String>,
        /// The agent that ran it. An existing record keeps the owner it was recorded with.
        #[serde(default)]
        owner: ChatOwner,
        name: String,
        input: String,
        state: ChatToolState,
        output: Option<String>,
    },
    /// The Step `tool_id` (recorded before this, or in the same batch) runs a shell command.
    /// Writes the Chat's agents commit while it runs may be its owner's (see
    /// `ChatWriteCredit`); `writes` is what the plain `ticketd` calls it names would write.
    ShellStep {
        tool_id: String,
        #[serde(default)]
        writes: Vec<ChatPlannedWrite>,
    },
    InteractionRequested {
        interaction_id: String,
        /// The turn it arrived in, when one does. Must be this Chat's.
        #[serde(default)]
        turn_id: Option<String>,
        /// The agent that asked.
        #[serde(default)]
        owner: ChatOwner,
        kind: ChatInteractionKind,
        native_request_id: Option<String>,
        prompt: String,
        /// Cut to `CHAT_NOTICE_LIMIT` characters when stored.
        reason: Option<String>,
        /// For an approval, the tool call it is about, when the harness said.
        tool_id: Option<String>,
    },
    /// A sub-agent started or was resumed: a run begins. The first sighting makes its
    /// record; a resume (a new `native_run_id`) adds a run to it.
    SubAgentStarted {
        /// The harness's ID for the sub-agent, unique within the Chat.
        native_id: String,
        /// The native ID of the sub-agent that started it; `None` for the main agent.
        #[serde(default)]
        parent: Option<String>,
        /// The Step (a tool record of this Chat) that started it.
        #[serde(default)]
        tool_id: Option<String>,
        /// The turn the run began in, when one was active. Must be this Chat's.
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        native_run_id: Option<String>,
        #[serde(default)]
        background: bool,
        /// A JSON object of what the harness said (`description`, `subagent_type`,
        /// `prompt`, `model`), merged over what is kept.
        payload: String,
    },
    /// More is known of a sub-agent: its words, or that it runs in the background.
    /// Ignored for a sub-agent never seen, and for a run an earlier one than the latest.
    SubAgentUpdated {
        native_id: String,
        #[serde(default)]
        native_run_id: Option<String>,
        #[serde(default)]
        background: Option<bool>,
        #[serde(default)]
        payload: Option<String>,
    },
    /// A run ended. `state` is anything but `Running`. Ignored when the run already ended
    /// or an earlier run than the latest is meant.
    SubAgentEnded {
        native_id: String,
        #[serde(default)]
        native_run_id: Option<String>,
        state: ChatSubAgentState,
        #[serde(default)]
        stopped_by: Option<ChatSubAgentStopper>,
        #[serde(default)]
        stop_reason: Option<String>,
        /// What the harness said went wrong, for a run that failed.
        #[serde(default)]
        detail: Option<String>,
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
        /// Said by the harness rather than by ticketd.
        #[serde(default)]
        from_harness: bool,
    },
    /// The person stopped `count` sub-agents while no turn ran. A note of its own so the
    /// Chat says so where the turn's stop would have been.
    SubAgentsStopped {
        notice_id: String,
        count: i64,
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
    /// Every sub-agent of the Chat, oldest first, whatever part of the history `items`
    /// holds: a row in the history names one whose record is older than the page.
    #[serde(default)]
    pub sub_agents: Vec<ChatSubAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
// A change carries one record and lives only while a view applies it; boxing the Chat
// would cost every reader a deref for no measurable saving.
#[allow(clippy::large_enum_variant)]
pub enum ChatRecord {
    Chat(Chat),
    Item(ChatItem),
    /// A sub-agent and its runs. It is not an entry of the Chat's history (each run is);
    /// a follower is told when the record changed.
    SubAgent(ChatSubAgent),
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
pub(crate) fn log(
    connection: &Connection,
    chat_id: &str,
    kind: &str,
    subject: &str,
) -> Result<i64, Error> {
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
        advance_change_floor(connection, chat_id, cut)?;
    }
    Ok(())
}

fn advance_change_floor(connection: &Connection, chat_id: &str, cut: i64) -> Result<(), Error> {
    connection.execute(
        "UPDATE chats SET changes_trimmed_through = MAX(changes_trimmed_through, ?2) WHERE id = ?1",
        params![chat_id, cut],
    )?;
    Ok(())
}

fn head(connection: &Connection) -> Result<i64, Error> {
    Ok(connection.query_row(CHANGE_HEAD, [], |row| row.get(0))?)
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
        ending: row.get(9)?,
        origin: row
            .get::<_, Option<String>>(10)?
            .map(|by| {
                Ok::<_, rusqlite::Error>(ChatTurnOrigin {
                    by: serde_json::from_value(serde_json::Value::String(by)).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            10,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    sub_agent: row.get(11)?,
                })
            })
            .transpose()?,
    })
}

const TURN: &str = "SELECT id, position, native_turn_id, state, detail, started_at, ended_at, problem, problem_resets_at, ending, origin_by, origin_sub_agent FROM chat_turns";

/// A Chat's own columns, for `FROM chats`, in the order [`chat_from_row`] reads them.
const CHAT_COLUMNS: &str = "id, title, harness, execution_folder, folder_managed, archived, trashed, queue_paused, created_at, effective_settings,
    (SELECT native_session_id FROM chat_sessions WHERE chat_id = chats.id ORDER BY position DESC LIMIT 1),
    seen_through, muted, read_through, marked_unread, restart_notice";

/// A Chat from [`CHAT_COLUMNS`], without its links and active turn.
fn chat_from_row(row: &Row<'_>) -> rusqlite::Result<Chat> {
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
        seen_through: row.get(11)?,
        muted: row.get(12)?,
        read_through: row.get(13)?,
        marked_unread: row.get(14)?,
        restart_notice: row
            .get::<_, Option<String>>(15)?
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default(),
        links: Vec::new(),
        active_turn: None,
    })
}

/// Which Chats a list shows, as SQL over `chats`. A Chat owned by an Automation run is
/// reached from its run, not from a list.
fn list_scope(filter: ChatListFilter) -> &'static str {
    match filter {
        ChatListFilter::Active => "trashed = 0 AND archived = 0 AND automation_run_id IS NULL",
        ChatListFilter::Archived => "trashed = 0 AND archived = 1 AND automation_run_id IS NULL",
        ChatListFilter::Trashed => "trashed = 1 AND automation_run_id IS NULL",
    }
}

/// Most recently changed first.
const LIST_ORDER: &str =
    "(SELECT MAX(sequence) FROM chat_changes WHERE chat_id = chats.id) DESC, id";

/// Saved input that can be queued, including an original held for editing.
pub(crate) const QUEUED_CHAT_INPUT: &str = "m.role = 'user'
    AND NOT EXISTS (
        SELECT 1 FROM chat_submission_attempts a WHERE a.message_id = m.id
        AND (a.delivery IN ('possible', 'acknowledged', 'uncertain')
             OR a.turn_id IS NOT NULL OR a.decision = 'discarded')
    )";

fn read_chat(connection: &Connection, id: &str) -> Result<Chat, Error> {
    let mut chat = connection
        .prepare_cached(&format!("SELECT {CHAT_COLUMNS} FROM chats WHERE id = ?1"))?
        .query_row([id], chat_from_row)
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
            "SELECT id, position, role, text, complete, turn_id, created_at, editing, requires_link_context, sub_agent_id, note FROM chat_messages WHERE id = ?1",
            [id],
            |row| {
                Ok(ChatMessage {
                    id: row.get(0)?,
                    position: row.get(1)?,
                    role: named(row, 2)?,
                    text: row.get(3)?,
                    attachments: Vec::new(),
                    complete: row.get(4)?,
                    turn_id: row.get(5)?,
                    created_at: row.get(6)?,
                    queued: false,
                    editing: row.get(7)?,
                    requires_link_context: row.get(8)?,
                    owner: ChatOwner::from_column(row.get(9)?),
                    note: row
                        .get::<_, Option<String>>(10)?
                        .and_then(|text| serde_json::from_str(&text).ok()),
                    attempts: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut message) = message else {
        return Ok(None);
    };
    if message.role == ChatRole::User {
        message.attachments = attachments::list(connection, id)?;
    }
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
                "SELECT id, position, turn_id, name, input, state, output, output_truncated, started_at, sub_agent_id FROM chat_tools WHERE id = ?1",
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
                        started_at: row.get(8)?,
                        owner: ChatOwner::from_column(row.get(9)?),
                    })
                },
            )
            .optional()?
            .map(ChatItem::Tool),
        "interaction" => connection
            .query_row(
                "SELECT id, position, turn_id, kind, native_request_id, prompt, state, response, reason, tool_id, asked_at, resolved_at, sub_agent_id FROM chat_interactions WHERE id = ?1",
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
                        tool_id: row.get(9)?,
                        asked_at: row.get(10)?,
                        resolved_at: row.get(11)?,
                        owner: ChatOwner::from_column(row.get(12)?),
                    })
                },
            )
            .optional()?
            .map(ChatItem::Interaction),
        "notice" => connection
            .query_row(
                "SELECT id, position, text, created_at, from_harness, sub_agents_stopped FROM chat_notices WHERE id = ?1",
                [id],
                |row| {
                    Ok(ChatNotice {
                        id: row.get(0)?,
                        position: row.get(1)?,
                        text: row.get(2)?,
                        created_at: row.get(3)?,
                        from_harness: row.get(4)?,
                        sub_agents_stopped: row.get(5)?,
                    })
                },
            )
            .optional()?
            .map(ChatItem::Notice),
        "sub_agent_run" => sub_agents::read_run(connection, id)?.map(ChatItem::SubAgentRun),
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
             UNION ALL SELECT position, 'notice', id, chat_id FROM chat_notices
             UNION ALL SELECT position, 'sub_agent_run', id, chat_id FROM chat_sub_agent_runs)
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
        ChatLinkKind::Project => {
            return crate::projects::ensure_active(connection, &link.id).map(|_| ());
        }
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

fn add_link(connection: &Connection, chat_id: &str, link: &ChatLink) -> Result<bool, Error> {
    let kind = name(link.kind)?;
    let linked: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_links WHERE chat_id = ?1 AND kind = ?2 AND target_id = ?3)",
        params![chat_id, kind, link.id],
        |row| row.get(0),
    )?;
    if linked {
        return Ok(false);
    }
    ensure_link_target(connection, link)?;
    connection.execute(
        "INSERT INTO chat_links (chat_id, kind, target_id) VALUES (?1, ?2, ?3)",
        params![chat_id, kind, link.id],
    )?;
    Ok(true)
}

fn add_links(connection: &Connection, id: &str, links: &[ChatLink]) -> Result<bool, Error> {
    read_chat(connection, id)?;
    let mut added = false;
    for link in links {
        added |= add_link(connection, id, link)?;
    }
    if added {
        log(connection, id, "chat", id)?;
        trim(connection, id)?;
    }
    Ok(added)
}

/// Runs `create` once per command ID and returns the ID of the record it created.
/// A command ID deduplicates this ticketd write only; it promises nothing about the harness.
/// Creates a Chat in the caller's transaction. Repeating `command_id` with the same
/// content returns the first Chat.
pub(crate) fn create_chat_in(
    connection: &Connection,
    command_id: Option<&str>,
    chat: NewChat,
) -> Result<Chat, Error> {
    let request = create_chat_request(&chat);
    create_chat_with_request(connection, command_id, chat, request)
}

fn create_chat_with_request(
    connection: &Connection,
    command_id: Option<&str>,
    chat: NewChat,
    request: Value,
) -> Result<Chat, Error> {
    if chat.harness.trim().is_empty() || chat.execution_folder.trim().is_empty() {
        return Err(invalid("a Chat needs a harness and an execution folder"));
    }
    let id = once(connection, command_id, request, || {
        let id = Uuid::new_v4().to_string();
        let title = chat
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty());
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
}

fn create_chat_request(chat: &NewChat) -> Value {
    json!({"operation": "create_chat", "chat": chat})
}

fn creation_requests(
    chat: &NewChat,
    picks: ChatStartPicks<'_>,
    text: &str,
    files: &[ChatAttachmentContent],
) -> (Value, Value, Value) {
    let legacy = create_chat_request(chat);
    let mut settings_only = legacy.clone();
    settings_only["start_picks"] = json!(picks);
    let mut request = settings_only.clone();
    request["first_message"] = json!({
        "text_sha256": format!("{:x}", Sha256::digest(text.as_bytes())),
        "attachments": files.iter().map(ChatAttachmentContent::identity).collect::<Vec<_>>(),
    });
    (request, settings_only, legacy)
}

fn replay_chat_creation(
    connection: &Connection,
    command_id: &str,
    request: &Value,
    settings_only: &Value,
    legacy: &Value,
) -> Result<Option<ChatCreationReplay>, Error> {
    let Some((stored, outcome)) = request_outcome(connection, command_id)? else {
        return Ok(None);
    };
    let request = request.to_string();
    let settings_only = settings_only.to_string();
    let legacy = legacy.to_string();
    let replay = if stored == request || stored == settings_only {
        ChatCreationReplay::Exact
    } else if stored == legacy {
        ChatCreationReplay::Legacy
    } else {
        return Err(Error::RequestConflict(command_id.to_owned()));
    };
    let id: String = serde_json::from_str(&outcome)?;
    Ok(Some(replay(read_chat(connection, &id)?)))
}

fn request_outcome(
    connection: &Connection,
    command_id: &str,
) -> Result<Option<(String, String)>, Error> {
    Ok(connection
        .query_row(
            "SELECT request, outcome FROM request_outcomes WHERE id = ?1",
            [command_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

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
    if let Some(id) = previous_outcome(connection, command_id, &request)? {
        return Ok(id);
    }
    let id = create()?;
    save_outcome(connection, command_id, &request, &id)?;
    Ok(id)
}

fn save_outcome(
    connection: &Connection,
    command_id: &str,
    request: &str,
    outcome: &str,
) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO request_outcomes (id, request, outcome) VALUES (?1, ?2, ?3)",
        params![command_id, request, serde_json::to_string(outcome)?],
    )?;
    Ok(())
}

fn previous_outcome(
    connection: &Connection,
    command_id: &str,
    request: &str,
) -> Result<Option<String>, Error> {
    if let Some((previous, outcome)) = request_outcome(connection, command_id)? {
        if previous != request {
            return Err(Error::RequestConflict(command_id.to_owned()));
        }
        return Ok(Some(serde_json::from_str(&outcome)?));
    }
    Ok(None)
}

const AUTOMATION_PROMPT_REQUEST_SUFFIX: &str = ":first";

fn automation_prompt_command_id(chat_id: &str) -> String {
    format!("{chat_id}{AUTOMATION_PROMPT_REQUEST_SUFFIX}")
}

enum AutomationPromptReceipt {
    Marked(String),
    Unmarked(String),
}

fn automation_prompt_receipt(
    connection: &Connection,
    chat_id: &str,
) -> Result<Option<AutomationPromptReceipt>, Error> {
    Ok(connection
        .query_row(
            "SELECT json_extract(outcome, '$'), json_type(request, '$.input_source') IS NOT NULL
             FROM request_outcomes
             WHERE id = ?1 AND json_extract(request, '$.operation') = 'save_chat_input'
                 AND json_extract(request, '$.chat_id') = ?2
                 AND (json_type(request, '$.input_source') IS NULL
                      OR json_extract(request, '$.input_source') = 'automation_prompt')",
            params![automation_prompt_command_id(chat_id), chat_id],
            |row| {
                let id = row.get(0)?;
                Ok(if row.get(1)? {
                    AutomationPromptReceipt::Marked(id)
                } else {
                    AutomationPromptReceipt::Unmarked(id)
                })
            },
        )
        .optional()?)
}

#[derive(Clone, Copy, Default)]
struct InputReplacement<'a> {
    replaces: &'a [String],
    links: &'a [ChatLink],
}

impl<'a> InputReplacement<'a> {
    fn for_edit(edit: Option<&'a ChatQueueEdit>) -> Result<Self, Error> {
        match edit {
            Some(edit) if edit.replaces.is_empty() => {
                Err(invalid("choose a queued message to edit"))
            }
            Some(edit) => Ok(Self {
                replaces: &edit.replaces,
                links: &edit.links,
            }),
            None => Ok(Self::default()),
        }
    }

    fn for_change(change: Option<&'a ChatInputChange>) -> Result<Self, Error> {
        match change {
            Some(ChatInputChange::Link(links)) => Ok(Self {
                links,
                ..Self::default()
            }),
            Some(ChatInputChange::Edit(edit)) => Self::for_edit(Some(edit)),
            None => Ok(Self::default()),
        }
    }
}

/// Input and its receipt identity, prepared together before the durable write.
/// The borrowed input cannot change between preparation and save.
pub struct PreparedChatInput<'a> {
    chat_id: &'a str,
    text: &'a str,
    files: &'a [ChatAttachmentContent],
    replacement: InputReplacement<'a>,
    request: Option<(&'a str, Value)>,
}

impl<'a> PreparedChatInput<'a> {
    pub fn new(
        command_id: Option<&'a str>,
        chat_id: &'a str,
        text: &'a str,
        files: &'a [ChatAttachmentContent],
        change: Option<&'a ChatInputChange>,
    ) -> Result<Self, Error> {
        Self::for_replacement(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement::for_change(change)?,
        )
    }

    fn for_replacement(
        command_id: Option<&'a str>,
        chat_id: &'a str,
        text: &'a str,
        files: &'a [ChatAttachmentContent],
        replacement: InputReplacement<'a>,
    ) -> Result<Self, Error> {
        if !replacement.replaces.is_empty() && command_id.is_none() {
            return Err(invalid("Editing queued input requires a command ID"));
        }
        let request = command_id
            .map(|id| {
                save_input_request(chat_id, text, files, replacement).map(|request| (id, request))
            })
            .transpose()?;
        Ok(Self {
            chat_id,
            text,
            files,
            replacement,
            request,
        })
    }
}

fn validate_legacy_input_links(
    connection: &Connection,
    command_id: &str,
    request: &Value,
) -> Result<bool, Error> {
    let key = format!("chat_queue_edit_links:{command_id}");
    if let Some((previous, _)) = request_outcome(connection, &key)? {
        let previous: Value = serde_json::from_str(&previous)?;
        // A public request could use this ID even before the prefix was used for links.
        if previous["operation"] == "chat_queue_edit_links" {
            if previous["chat_id"] != request["chat_id"]
                || previous["links"] != sorted_input_links(request)
            {
                return Err(Error::RequestConflict(command_id.to_owned()));
            }
            return Ok(true);
        }
    }
    Ok(false)
}

fn read_input_receipt(
    connection: &Connection,
    command_id: &str,
    request: &Value,
    chat_id: &str,
    source: InputSource<'_>,
) -> Result<Option<ChatInputReceipt>, Error> {
    let Some((previous, outcome)) = request_outcome(connection, command_id)? else {
        // Some older versions could save links before saving the input.
        validate_legacy_input_links(connection, command_id, request)?;
        return Ok(None);
    };
    let mut previous: Value = serde_json::from_str(&previous)?;
    let Some(fields) = previous.as_object_mut() else {
        return Err(Error::RequestConflict(command_id.to_owned()));
    };
    let saved_source = fields.remove("input_source");
    let links_ordered = fields.remove("links_ordered") == Some(Value::Bool(true));
    let split_links_receipt = !fields.contains_key("links");
    if !links_ordered {
        // Older receipts remembered the set of links, discarding their insertion order.
        if !split_links_receipt && fields.get("links") != Some(&sorted_input_links(request)) {
            return Err(Error::RequestConflict(command_id.to_owned()));
        }
        fields.insert("links".to_owned(), request["links"].clone());
    }
    if previous != *request {
        return Err(Error::RequestConflict(command_id.to_owned()));
    }
    if split_links_receipt
        && !validate_legacy_input_links(connection, command_id, request)?
        && request["links"] != json!([])
    {
        return Err(Error::RequestConflict(command_id.to_owned()));
    }
    let same_source = match (saved_source.as_ref(), source) {
        // Old receipts cannot prove a takeover. While the Chat still has an owner,
        // let only a new command ID initiate one.
        (None, InputSource::AutomationReply) => {
            crate::automation_runs::chat_owner(connection, chat_id)?.is_none()
        }
        // A historical receipt can recover ordinary input but cannot authorize a Prompt.
        (None, InputSource::AutomationPrompt(_)) => false,
        (None, InputSource::Person) => true,
        // A lost takeover reply can be retried through the now ordinary Chat.
        (Some(saved), InputSource::Person) if saved == "automation_reply" => {
            crate::automation_runs::chat_owner(connection, chat_id)?.is_none()
        }
        (Some(saved), _) => saved == source.receipt_name(),
    };
    if !same_source {
        return Err(Error::RequestConflict(command_id.to_owned()));
    }
    let id: String = serde_json::from_str(&outcome)?;
    let message = read_message(connection, &id)?;
    Ok(Some(ChatInputReceipt { id, message }))
}

fn sorted_input_links(request: &Value) -> Value {
    let mut links = request["links"].as_array().cloned().unwrap_or_default();
    links.sort_unstable_by(|left, right| {
        [left[0].as_str(), left[1].as_str()].cmp(&[right[0].as_str(), right[1].as_str()])
    });
    Value::Array(links)
}

#[derive(Clone, Copy)]
enum InputSource<'a> {
    Person,
    AutomationReply,
    AutomationPrompt(&'a str),
}

impl InputSource<'_> {
    fn receipt_name(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::AutomationReply => "automation_reply",
            Self::AutomationPrompt(_) => "automation_prompt",
        }
    }
}

fn save_input_request(
    chat_id: &str,
    text: &str,
    files: &[ChatAttachmentContent],
    replacement: InputReplacement<'_>,
) -> Result<Value, Error> {
    let InputReplacement { links, replaces } = replacement;
    let mut seen = HashSet::new();
    let links = links
        .iter()
        .filter(|link| seen.insert((link.kind, link.id.as_str())))
        .map(|link| Ok((name(link.kind)?, link.id.as_str())))
        .collect::<Result<Vec<_>, Error>>()?;
    let mut request = json!({
        "operation": "save_chat_input",
        "chat_id": chat_id,
        "text": text,
        "links": links,
    });
    if !files.is_empty() {
        request["attachments"] =
            Value::Array(files.iter().map(ChatAttachmentContent::identity).collect());
    }
    if !replaces.is_empty() {
        request["replaces"] = json!(replaces);
    }
    Ok(request)
}

fn delete_queued_input(connection: &Connection, message_id: &str) -> Result<(), Error> {
    connection.execute(
        "DELETE FROM chat_submission_attempts WHERE message_id = ?1",
        [message_id],
    )?;
    connection.execute("DELETE FROM chat_messages WHERE id = ?1", [message_id])?;
    Ok(())
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
            &format!(
                "UPDATE chat_interactions SET state = 'expired', resolved_at = {NOW} WHERE id = ?1"
            ),
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
    receipt: Option<&mut ChatTurnReceipt>,
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
            origin,
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
            let started_at = receipt::record_turn_boundary(
                connection,
                chat_id,
                receipt::Boundary::Start(&turn_id),
                receipt,
            )?;
            connection.execute(
                &format!(
                    "INSERT INTO chat_turns (id, chat_id, position, native_turn_id, state, started_at, origin_by, origin_sub_agent)
                     VALUES (?1, ?2, ?3, ?4, 'active', COALESCE(?5, {NOW}), ?6, ?7)"
                ),
                params![
                    turn_id,
                    chat_id,
                    position,
                    native_turn_id,
                    started_at,
                    origin.as_ref().map(|origin| name(origin.by)).transpose()?,
                    origin.and_then(|origin| origin.sub_agent),
                ],
            )?;
            Ok(())
        }
        ChatObservation::TurnEnded {
            turn_id,
            state,
            detail,
            problem,
            problem_resets_at,
            ending,
        } => {
            require_turn(connection, chat_id, &turn_id)?;
            let resets_at = problem_resets_at.filter(|at| (0..=CHAT_RESET_TIME_MAX).contains(at));
            if state == ChatTurnState::Active {
                return Err(invalid("a turn cannot end as active"));
            }
            let (current, has_ended): (ChatTurnState, bool) = connection.query_row(
                "SELECT state, ended_at IS NOT NULL FROM chat_turns WHERE id = ?1",
                [&turn_id],
                |row| Ok((named(row, 0)?, row.get(1)?)),
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
            log(connection, chat_id, "turn", &turn_id)?;
            let ended_at = if has_ended {
                None
            } else {
                receipt::record_turn_boundary(
                    connection,
                    chat_id,
                    receipt::Boundary::End(&turn_id),
                    receipt,
                )?
            };
            connection.execute(
                &format!(
                    "UPDATE chat_turns SET state = ?2, detail = ?3, problem = ?4,
                     problem_resets_at = ?5, ending = ?6,
                     ended_at = COALESCE(ended_at, ?7, {NOW}) WHERE id = ?1"
                ),
                params![
                    turn_id,
                    name(state)?,
                    detail,
                    problem,
                    resets_at,
                    ending,
                    ended_at
                ],
            )?;
            sub_agents::end_turn(connection, chat_id, &turn_id, state, ending.as_deref())?;
            expire_interactions(connection, chat_id, Some(&turn_id))
        }
        ChatObservation::CaptureAgentChanges { turn_id } => {
            let changes = receipt::read_changes(connection, chat_id, &turn_id, true)?;
            if changes.is_empty() {
                return Ok(());
            }
            observe(
                connection,
                chat_id,
                ChatObservation::Tool {
                    tool_id: format!("{turn_id}:ticketd-changes"),
                    turn_id: Some(turn_id),
                    owner: ChatOwner::Main,
                    name: AGENT_CHANGES_RECORD_NAME.to_owned(),
                    input: serde_json::to_string(&changes)?,
                    state: ChatToolState::Completed,
                    output: None,
                },
                None,
            )
        }
        ChatObservation::AssistantText {
            message_id,
            turn_id,
            owner,
            text,
            complete,
        } => {
            if let Some(turn_id) = &turn_id {
                require_turn(connection, chat_id, turn_id)?;
            }
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
                    "INSERT INTO chat_messages (id, chat_id, position, role, text, complete, turn_id, sub_agent_id) VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6, ?7)",
                    params![message_id, chat_id, position, text, complete, turn_id, owner.column()],
                )?;
            }
            Ok(())
        }
        ChatObservation::Tool {
            tool_id,
            turn_id,
            owner,
            name: tool_name,
            input,
            state,
            output,
        } => {
            if let Some(turn_id) = &turn_id {
                require_turn(connection, chat_id, turn_id)?;
            }
            let (output, truncated) = match output.map(bounded) {
                Some((output, truncated)) => (Some(output), truncated),
                None => (None, false),
            };
            if owned(connection, "chat_tools", chat_id, &tool_id)? {
                connection.execute(
                    "UPDATE chat_tools SET name = ?2, input = ?3, state = ?4, output = ?5, output_truncated = ?6 WHERE id = ?1",
                    params![tool_id, tool_name, input, name(state)?, output, truncated],
                )?;
                if state != ChatToolState::Running {
                    credit::close_window(connection, &tool_id)?;
                }
                log(connection, chat_id, "tool", &tool_id)?;
            } else {
                let position = log(connection, chat_id, "tool", &tool_id)?;
                connection.execute(
                    &format!("INSERT INTO chat_tools (id, chat_id, position, turn_id, sub_agent_id, name, input, state, output, output_truncated, started_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, {NOW})"),
                    params![tool_id, chat_id, position, turn_id, owner.column(), tool_name, input, name(state)?, output, truncated],
                )?;
            }
            Ok(())
        }
        ChatObservation::ShellStep { tool_id, writes } => {
            credit::open_window(connection, chat_id, &tool_id, &writes)
        }
        ChatObservation::InteractionRequested {
            interaction_id,
            turn_id,
            owner,
            kind,
            native_request_id,
            prompt,
            reason,
            tool_id,
        } => {
            if let Some(turn_id) = &turn_id {
                require_turn(connection, chat_id, turn_id)?;
            }
            if owned(connection, "chat_interactions", chat_id, &interaction_id)? {
                return Ok(());
            }
            let position = log(connection, chat_id, "interaction", &interaction_id)?;
            let reason: Option<String> =
                reason.map(|reason| reason.chars().take(CHAT_NOTICE_LIMIT).collect());
            connection.execute(
                &format!("INSERT INTO chat_interactions (id, chat_id, position, turn_id, sub_agent_id, kind, native_request_id, prompt, reason, state, tool_id, asked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, {NOW})"),
                params![interaction_id, chat_id, position, turn_id, owner.column(), name(kind)?, native_request_id, prompt, reason, tool_id],
            )?;
            Ok(())
        }
        ChatObservation::SubAgentStarted {
            native_id,
            parent,
            tool_id,
            turn_id,
            native_run_id,
            background,
            payload,
        } => sub_agents::observe(
            connection,
            chat_id,
            sub_agents::Change::Started {
                native_id,
                parent,
                tool_id,
                turn_id,
                native_run_id,
                background,
                payload,
            },
        ),
        ChatObservation::SubAgentUpdated {
            native_id,
            native_run_id,
            background,
            payload,
        } => sub_agents::observe(
            connection,
            chat_id,
            sub_agents::Change::Updated {
                native_id,
                native_run_id,
                background,
                payload,
            },
        ),
        ChatObservation::SubAgentEnded {
            native_id,
            native_run_id,
            state,
            stopped_by,
            stop_reason,
            detail,
        } => sub_agents::observe(
            connection,
            chat_id,
            sub_agents::Change::Ended {
                native_id,
                native_run_id,
                state,
                stopped_by,
                stop_reason,
                detail,
            },
        ),
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
                &format!("UPDATE chat_interactions SET state = ?2, response = ?3, resolved_at = {NOW} WHERE id = ?1"),
                params![interaction_id, name(state)?, response],
            )?;
            log(connection, chat_id, "interaction", &interaction_id)?;
            Ok(())
        }
        ChatObservation::Notice {
            notice_id,
            text,
            from_harness,
        } => {
            if owned(connection, "chat_notices", chat_id, &notice_id)? {
                return Ok(());
            }
            let text: String = text.chars().take(CHAT_NOTICE_LIMIT).collect();
            let position = log(connection, chat_id, "notice", &notice_id)?;
            connection.execute(
                "INSERT INTO chat_notices (id, chat_id, position, text, from_harness) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![notice_id, chat_id, position, text, from_harness],
            )?;
            Ok(())
        }
        ChatObservation::SubAgentsStopped { notice_id, count } => {
            if owned(connection, "chat_notices", chat_id, &notice_id)? {
                return Ok(());
            }
            let noun = if count == 1 {
                "sub-agent"
            } else {
                "sub-agents"
            };
            let position = log(connection, chat_id, "notice", &notice_id)?;
            connection.execute(
                "INSERT INTO chat_notices (id, chat_id, position, text, from_harness, sub_agents_stopped) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![notice_id, chat_id, position, format!("You stopped {count} {noun}."), count],
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

fn owns_running_chat(connection: &Connection, chat_id: &str, run_id: &str) -> Result<bool, Error> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM chats JOIN automation_runs
              ON automation_runs.id = chats.automation_run_id
              WHERE chats.id = ?1 AND automation_runs.id = ?2
              AND automation_runs.status = 'running')",
        params![chat_id, run_id],
        |row| row.get(0),
    )?)
}

fn set_aside_input(
    connection: &Connection,
    chat_id: &str,
    message_id: &str,
    move_from_queue: bool,
) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO chat_submission_attempts (id, chat_id, message_id, intent, delivery, decision) VALUES (?1, ?2, ?3, ?4, 'not_delivered', 'discarded')",
        params![
            uuid::Uuid::new_v4().to_string(),
            chat_id,
            message_id,
            name(ChatSubmissionIntent::NewTurn)?
        ],
    )?;
    let sequence = log(connection, chat_id, "message", message_id)?;
    if move_from_queue {
        connection.execute(
            "UPDATE chat_messages SET position = ?1 WHERE id = ?2",
            params![sequence, message_id],
        )?;
    }
    Ok(())
}

/// The marked receipt identifies the Prompt before its supervisor returns the save
/// outcome. Late delivery evidence still takes precedence.
pub(crate) fn set_aside_taken_over_prompt(
    connection: &Connection,
    chat_id: &str,
) -> Result<(), Error> {
    let id = match automation_prompt_receipt(connection, chat_id)? {
        Some(AutomationPromptReceipt::Marked(id)) => id,
        Some(AutomationPromptReceipt::Unmarked(id)) => {
            // The ID alone cannot distinguish the person's input from an old Prompt.
            // Keep the row for review without automatically dispatching it on takeover.
            if read_message(connection, &id)?.is_some_and(|message| message.queued) {
                connection.execute("UPDATE chats SET queue_paused = 1 WHERE id = ?1", [chat_id])?;
            }
            return Ok(());
        }
        None => return Ok(()),
    };
    let Some(message) = read_message(connection, &id)? else {
        return Ok(());
    };
    match message.standing() {
        ChatInputStanding::Delivered | ChatInputStanding::SetAside => return Ok(()),
        ChatInputStanding::AwaitsDecision => {
            decide(
                connection,
                chat_id,
                &message,
                ChatDeliveryDecision::Discarded,
            )?;
        }
        ChatInputStanding::Queued => set_aside_input(connection, chat_id, &id, true)?,
        ChatInputStanding::Sending => set_aside_input(connection, chat_id, &id, false)?,
    }
    observe(
        connection,
        chat_id,
        ChatObservation::Notice {
            notice_id: Uuid::new_v4().to_string(),
            text: "You took this run over.".to_owned(),
            from_harness: false,
        },
        None,
    )?;
    trim(connection, chat_id)
}

/// Records the person's decision on the submission of `message` whose delivery is
/// still unknown. A later decision replaces an earlier one that was not carried out.
fn decide(
    connection: &Connection,
    chat_id: &str,
    message: &ChatMessage,
    decision: ChatDeliveryDecision,
) -> Result<i64, Error> {
    let attempt = message
        .open_question()
        .filter(|_| message.awaits_decision())
        .ok_or_else(|| Error::ChatSubmissionUnresolved(message.id.clone()))?;
    connection.execute(
        "UPDATE chat_submission_attempts SET decision = ?2 WHERE id = ?1",
        params![attempt.id, name(decision)?],
    )?;
    log(connection, chat_id, "message", &message.id)
}

/// Records that nothing more will be observed from this Chat's runtime: the active turn's
/// outcome is unknown, possible submissions are uncertain, and open requests expire.
fn lose_contact(
    connection: &Connection,
    chat_id: &str,
    detail: &str,
    ending: &str,
    receipt: Option<&mut ChatTurnReceipt>,
) -> Result<(), Error> {
    let ids = |sql: &str| -> Result<Vec<String>, Error> {
        let mut statement = connection.prepare(sql)?;
        let ids = statement
            .query_map([chat_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    };
    let mut receipt = receipt;
    for id in ids("SELECT id FROM chat_turns WHERE chat_id = ?1 AND state = 'active'")? {
        let ended_at = receipt::record_turn_boundary(
            connection,
            chat_id,
            receipt::Boundary::End(&id),
            receipt.as_deref_mut(),
        )?;
        log(connection, chat_id, "turn", &id)?;
        connection.execute(
            &format!("UPDATE chat_turns SET state = 'unknown', detail = ?2, ending = ?3, ended_at = COALESCE(?4, {NOW}) WHERE id = ?1"),
            params![id, detail, ending, ended_at],
        )?;
        if ended_at.is_some() {
            // Legacy writes can share the end's millisecond. Capture before another
            // connection can commit a write with that timestamp.
            observe(
                connection,
                chat_id,
                ChatObservation::CaptureAgentChanges { turn_id: id },
                None,
            )?;
        }
    }
    for id in ids("SELECT id FROM chat_tools WHERE chat_id = ?1 AND state = 'running'")? {
        connection.execute(
            "UPDATE chat_tools SET state = 'unknown' WHERE id = ?1",
            [&id],
        )?;
        log(connection, chat_id, "tool", &id)?;
    }
    credit::close_windows(connection, chat_id)?;
    expire_interactions(connection, chat_id, None)?;
    sub_agents::lose_contact(connection, chat_id)?;
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

/// Removes the Chats matching `filter` (a condition on `chats`) with every record
/// they hold. Only run retention deletes a Chat; a person's Chats are trashed.
pub(crate) fn delete_where(connection: &Connection, filter: &str) -> Result<(), Error> {
    // Children before the rows they reference.
    for table in [
        "chat_record_writes",
        "chat_changes",
        "chat_sub_agent_runs",
        "chat_sub_agents",
        "chat_step_windows",
        "chat_notices",
        "chat_interactions",
        "chat_tools",
        "chat_submission_attempts",
        "chat_messages",
        "chat_turns",
        "chat_sessions",
        "chat_links",
    ] {
        connection.execute(
            &format!("DELETE FROM {table} WHERE chat_id IN (SELECT id FROM chats WHERE {filter})"),
            [],
        )?;
    }
    connection.execute(&format!("DELETE FROM chats WHERE {filter}"), [])?;
    Ok(())
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
        self.chat_write(|connection| create_chat_in(connection, command_id, chat))
    }

    /// Whether the command already has a receipt, so a replay can decode attachments
    /// against the backup limit even if the Workspace upload limit has since fallen.
    pub fn has_chat_creation_receipt(&self, command_id: &str) -> Result<bool, Error> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM request_outcomes WHERE id = ?1)",
            [command_id],
            |row| row.get(0),
        )?)
    }

    /// Finds the Chat created by this request without starting a new write.
    pub fn replay_chat_creation(
        &self,
        command_id: &str,
        chat: &NewChat,
        picks: ChatStartPicks<'_>,
        text: &str,
        files: &[ChatAttachmentContent],
    ) -> Result<Option<ChatCreationReplay>, Error> {
        let (request, settings_only, legacy) = creation_requests(chat, picks, text, files);
        crate::read_scope::run(&self.connection, |connection| {
            replay_chat_creation(connection, command_id, &request, &settings_only, &legacy)
        })
    }

    /// Binds the selected settings and first input before the host prepares the
    /// execution folder and saves the input itself.
    pub fn create_chat_for_first_message(
        &mut self,
        command_id: &str,
        chat: NewChat,
        picks: ChatStartPicks<'_>,
        text: &str,
        files: &[ChatAttachmentContent],
    ) -> Result<Chat, Error> {
        let (request, settings_only, legacy) = creation_requests(&chat, picks, text, files);
        self.chat_write(|connection| {
            if let Some(ChatCreationReplay::Exact(chat) | ChatCreationReplay::Legacy(chat)) =
                replay_chat_creation(connection, command_id, &request, &settings_only, &legacy)?
            {
                return Ok(chat);
            }
            if text.trim().is_empty() && files.is_empty() {
                return Err(invalid("Chat input must not be empty"));
            }
            if !files.is_empty() {
                let limit = crate::attachments::upload_limit(connection)?;
                for file in files {
                    file.ensure_fits(limit)?;
                }
            }
            create_chat_with_request(connection, Some(command_id), chat, request)
        })
    }

    pub fn chat(&self, id: &str) -> Result<Chat, Error> {
        read_chat(&self.connection, id)
    }

    /// The Chat's most recent turn, whatever its state.
    pub fn chat_latest_turn(&self, chat_id: &str) -> Result<Option<ChatTurn>, Error> {
        Ok(self
            .connection
            .query_row(
                &format!("{TURN} WHERE chat_id = ?1 ORDER BY position DESC LIMIT 1"),
                [chat_id],
                turn_from_row,
            )
            .optional()?)
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
        let mut statement = self.connection.prepare(&format!(
            "SELECT id FROM chats WHERE {} ORDER BY {LIST_ORDER}",
            list_scope(filter)
        ))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| read_chat(&self.connection, id))
            .collect()
    }

    /// The Chats a list shows, as [`Workspace::list_chats`] reads them, each with the
    /// other Chats outside the trash that work in its folder. A fixed number of queries
    /// however many Chats there are.
    pub fn chat_summaries(&self, filter: ChatListFilter) -> Result<Vec<ChatSummary>, Error> {
        crate::read_scope::run(&self.connection, |connection| {
            let mut statement = connection.prepare_cached(&format!(
                "SELECT {CHAT_COLUMNS} FROM chats WHERE {} ORDER BY {LIST_ORDER}",
                list_scope(filter)
            ))?;
            let mut chats = statement
                .query_map([], chat_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let ids =
                serde_json::to_string(&chats.iter().map(|chat| &chat.id).collect::<Vec<_>>())?;
            let mut links: HashMap<String, Vec<ChatLink>> = HashMap::new();
            let mut statement = connection.prepare_cached(
                "SELECT chat_id, kind, target_id FROM chat_links WHERE chat_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid",
            )?;
            for link in statement.query_map([&ids], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ChatLink {
                        kind: named(row, 1)?,
                        id: row.get(2)?,
                    },
                ))
            })? {
                let (chat_id, link) = link?;
                links.entry(chat_id).or_default().push(link);
            }
            // The columns of `TURN`, then the Chat.
            let mut statement = connection.prepare_cached(
                "SELECT id, position, native_turn_id, state, detail, started_at, ended_at, problem, problem_resets_at, ending, origin_by, origin_sub_agent, chat_id
                   FROM chat_turns WHERE chat_id IN (SELECT value FROM json_each(?1)) AND state = 'active'",
            )?;
            let mut turns: HashMap<String, ChatTurn> = statement
                .query_map([&ids], |row| {
                    Ok((row.get::<_, String>(12)?, turn_from_row(row)?))
                })?
                .collect::<Result<_, _>>()?;
            // The Chats outside the trash, in the order the Active and then the Archived
            // list show them, that share a folder with a Chat of this list.
            let mut statement = connection.prepare_cached(&format!(
                "SELECT id, title, archived, trashed, execution_folder FROM chats
                  WHERE trashed = 0 AND automation_run_id IS NULL
                    AND execution_folder IN (SELECT execution_folder FROM chats WHERE id IN (SELECT value FROM json_each(?1)))
                  ORDER BY archived, {LIST_ORDER}"
            ))?;
            let mut by_folder: HashMap<String, Vec<FolderChat>> = HashMap::new();
            for found in statement.query_map([&ids], |row| {
                Ok((
                    row.get::<_, String>(4)?,
                    FolderChat {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        archived: row.get(2)?,
                        trashed: row.get(3)?,
                    },
                ))
            })? {
                let (folder, chat) = found?;
                by_folder.entry(folder).or_default().push(chat);
            }
            Ok(chats
                .drain(..)
                .map(|mut chat| {
                    chat.links = links.remove(&chat.id).unwrap_or_default();
                    chat.active_turn = turns.remove(&chat.id);
                    let folder_chats = by_folder
                        .get(&chat.execution_folder)
                        .map(|chats| {
                            chats
                                .iter()
                                .filter(|other| other.id != chat.id)
                                .cloned()
                                .collect()
                        })
                        .unwrap_or_default();
                    ChatSummary { chat, folder_chats }
                })
                .collect())
        })
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
                add_link(connection, id, &link).map(|_| ())
            } else {
                connection.execute(
                    "DELETE FROM chat_links WHERE chat_id = ?1 AND kind = ?2 AND target_id = ?3",
                    params![id, name(link.kind)?, link.id],
                )?;
                Ok(())
            }
        })
    }

    /// Adds a message's new links together. Existing links are allowed, including
    /// those to Projects archived since they were linked.
    pub fn add_chat_links(&mut self, id: &str, links: &[ChatLink]) -> Result<bool, Error> {
        self.chat_write(|connection| add_links(connection, id, links))
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

    /// The person saw the Chat's outcome: every turn that has ended is seen. Changes
    /// nothing, and logs nothing, when nothing ended unseen.
    pub fn mark_chat_seen(&mut self, id: &str) -> Result<Chat, Error> {
        let chat = self.chat(id)?;
        let through = self
            .last_ended_turn(id)?
            .filter(|through| *through > chat.seen_through);
        if through.is_none() && !chat.marked_unread {
            return Ok(chat);
        }
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET seen_through = MAX(seen_through, ?2), marked_unread = 0 WHERE id = ?1",
                params![id, through.unwrap_or(0)],
            )?;
            Ok(())
        })
    }

    /// Mark as unread: the Chat reads as unread until it is next seen. Its last outcome
    /// is not made unseen, so nothing is announced again. A Chat with no ended turn
    /// has nothing to mark.
    pub fn mark_chat_unread(&mut self, id: &str) -> Result<Chat, Error> {
        let chat = self.chat(id)?;
        if chat.marked_unread || self.last_ended_turn(id)?.is_none() {
            return Ok(chat);
        }
        self.update_chat(id, |connection| {
            connection.execute("UPDATE chats SET marked_unread = 1 WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /// The person had the transcript in view through `record` (a message, turn, tool,
    /// request, notice or session of this Chat). It only moves forward; a record that
    /// is not this Chat's, or is earlier than what was read, changes nothing. No Chat
    /// change is logged: reading is not a change the views have to follow.
    pub fn mark_chat_read_through(&mut self, id: &str, record: &str) -> Result<Chat, Error> {
        let chat = self.chat(id)?;
        let position: Option<i64> = self
            .connection
            .query_row(
                "SELECT position FROM (
                     SELECT position, id, chat_id FROM chat_sessions
                     UNION ALL SELECT position, id, chat_id FROM chat_messages
                     UNION ALL SELECT position, id, chat_id FROM chat_turns
                     UNION ALL SELECT position, id, chat_id FROM chat_tools
                     UNION ALL SELECT position, id, chat_id FROM chat_interactions
                     UNION ALL SELECT position, id, chat_id FROM chat_notices)
                 WHERE chat_id = ?1 AND id = ?2",
                params![id, record],
                |row| row.get(0),
            )
            .optional()?;
        let Some(position) = position else {
            return Ok(chat);
        };
        let moved = self.connection.execute(
            "UPDATE chats SET read_through = ?2, read_through_position = ?3
             WHERE id = ?1 AND read_through_position < ?3",
            params![id, record, position],
        )?;
        if moved == 0 {
            return Ok(chat);
        }
        self.chat(id)
    }

    /// Mute stops the Chat's notifications and its share of the app-icon count.
    pub fn set_chat_muted(&mut self, id: &str, muted: bool) -> Result<Chat, Error> {
        self.update_chat(id, |connection| {
            connection.execute(
                "UPDATE chats SET muted = ?2 WHERE id = ?1",
                params![id, muted],
            )?;
            Ok(())
        })
    }

    fn last_ended_turn(&self, id: &str) -> Result<Option<i64>, Error> {
        Ok(self.connection.query_row(
            "SELECT MAX(position) FROM chat_turns WHERE chat_id = ?1 AND state <> 'active'",
            [id],
            |row| row.get(0),
        )?)
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
        self.save_chat_input_with_attachments(command_id, chat_id, text, &[])
    }

    pub fn save_chat_input_with_attachments(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
    ) -> Result<ChatMessage, Error> {
        self.save_chat_input_replacing(command_id, chat_id, text, files, &[])?
            .into_message()
    }

    /// Save edited input and consume its held originals in the same transaction.
    pub fn save_chat_input_replacing(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        replaces: &[String],
    ) -> Result<ChatInputReceipt, Error> {
        let (receipt, _, _) = self.save_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement {
                replaces,
                ..InputReplacement::default()
            },
            InputSource::Person,
        )?;
        Ok(receipt)
    }

    /// Applies the edited links and saves the input in the same write. Returns
    /// whether new links were added so the host can refresh a running session.
    pub fn save_chat_input_with_edit(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        edit: Option<&ChatQueueEdit>,
    ) -> Result<(ChatInputReceipt, bool), Error> {
        let (receipt, _, links_changed) = self.save_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement::for_edit(edit)?,
            InputSource::Person,
        )?;
        Ok((receipt, links_changed))
    }

    /// Saves a message and its links together, including queued edits.
    pub fn save_chat_input_with_change(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        change: Option<&ChatInputChange>,
    ) -> Result<(ChatInputReceipt, bool), Error> {
        let (receipt, _, links_changed) = self.save_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement::for_change(change)?,
            InputSource::Person,
        )?;
        Ok((receipt, links_changed))
    }

    /// Saves a person's reply with the takeover of the run that owns the Chat.
    /// Both writes succeed together. Replaying an existing save leaves ownership alone.
    pub fn save_automation_chat_reply(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        edit: Option<&ChatQueueEdit>,
    ) -> Result<(ChatInputReceipt, Option<crate::AutomationRun>), Error> {
        let (receipt, run, _) = self.save_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement::for_edit(edit)?,
            InputSource::AutomationReply,
        )?;
        Ok((receipt, run))
    }

    pub fn save_automation_chat_reply_with_change(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        change: Option<&ChatInputChange>,
    ) -> Result<(ChatInputReceipt, Option<crate::AutomationRun>), Error> {
        self.save_prepared_automation_chat_reply(PreparedChatInput::new(
            command_id, chat_id, text, files, change,
        )?)
    }

    /// Saves the prepared reply and takes over the run in the same transaction.
    pub fn save_prepared_automation_chat_reply(
        &mut self,
        reply: PreparedChatInput<'_>,
    ) -> Result<(ChatInputReceipt, Option<crate::AutomationRun>), Error> {
        let (receipt, run, _) = self.save_prepared_input(reply, InputSource::AutomationReply)?;
        Ok((receipt, run))
    }

    /// The run's first Prompt may only be created while it still owns this Chat.
    pub fn save_automation_chat_prompt(
        &mut self,
        chat_id: &str,
        run_id: &str,
        text: &str,
    ) -> Result<ChatMessage, Error> {
        let command_id = automation_prompt_command_id(chat_id);
        self.save_input(
            Some(&command_id),
            chat_id,
            text,
            &[],
            InputReplacement::default(),
            InputSource::AutomationPrompt(run_id),
        )?
        .0
        .into_message()
    }

    /// Whether the Prompt can still be dispatched for this running owner.
    pub fn automation_chat_owned_by_run(&self, chat_id: &str, run_id: &str) -> Result<bool, Error> {
        owns_running_chat(&self.connection, chat_id, run_id)
    }

    fn save_input(
        &mut self,
        command_id: Option<&str>,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        replacement: InputReplacement<'_>,
        source: InputSource<'_>,
    ) -> Result<(ChatInputReceipt, Option<crate::AutomationRun>, bool), Error> {
        let input =
            PreparedChatInput::for_replacement(command_id, chat_id, text, files, replacement)?;
        self.save_prepared_input(input, source)
    }

    fn save_prepared_input(
        &mut self,
        input: PreparedChatInput<'_>,
        source: InputSource<'_>,
    ) -> Result<(ChatInputReceipt, Option<crate::AutomationRun>, bool), Error> {
        let PreparedChatInput {
            chat_id,
            text,
            files,
            replacement,
            request,
        } = input;
        let InputReplacement { replaces, links } = replacement;
        let command_id = request.as_ref().map(|(id, _)| *id);
        self.chat_write(|connection| {
            if let InputSource::AutomationPrompt(run_id) = source
                && !owns_running_chat(connection, chat_id, run_id)?
            {
                return Err(invalid("the run no longer owns this Chat"));
            }
            if let Some((command_id, request)) = &request
                && let Some(receipt) = read_input_receipt(connection, command_id, request, chat_id, source)?
            {
                return Ok((receipt, None, false));
            }
            if !matches!(source, InputSource::AutomationPrompt(_))
                && let Some(command_id) = command_id
                && let Some(prompt_chat_id) = command_id.strip_suffix(AUTOMATION_PROMPT_REQUEST_SUFFIX)
                && connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM chats JOIN automation_runs
                      ON automation_runs.id = chats.automation_run_id
                      WHERE chats.id = ?1 AND automation_runs.status = 'running')",
                    [prompt_chat_id],
                    |row| row.get(0),
                )?
            {
                return Err(Error::RequestConflict(command_id.to_owned()));
            }
            if text.trim().is_empty() && files.is_empty() {
                return Err(invalid("Chat input must not be empty"));
            }
            if !files.is_empty() {
                let limit = crate::attachments::upload_limit(connection)?;
                for file in files {
                    file.ensure_fits(limit)?;
                }
            }
            if read_chat(connection, chat_id)?.trashed {
                return Err(Error::ChatTrashed(chat_id.to_owned()));
            }
            let mut requires_link_context = !links.is_empty();
            for original in replaces {
                let message = require_input(connection, chat_id, original)?;
                if !message.queued || !message.editing {
                    return Err(invalid("the original message is no longer held for editing"));
                }
                requires_link_context |= message.requires_link_context;
                delete_queued_input(connection, original)?;
            }
            let links_changed = !links.is_empty() && add_links(connection, chat_id, links)?;
            let run = if matches!(source, InputSource::AutomationReply) {
                crate::automation_runs::take_over_chat(connection, chat_id, true)?
            } else {
                None
            };
            let id = Uuid::new_v4().to_string();
            let position = log(connection, chat_id, "message", &id)?;
            connection.execute(
                "INSERT INTO chat_messages (id, chat_id, position, role, text, complete, requires_link_context) VALUES (?1, ?2, ?3, 'user', ?4, 1, ?5)",
                params![id, chat_id, position, text, requires_link_context],
            )?;
            if !files.is_empty() {
                attachments::save(connection, &id, files)?;
            }
            if !replaces.is_empty() {
                // Older cursors may already contain a row just replaced.
                advance_change_floor(connection, chat_id, position)?;
            }
            trim(connection, chat_id)?;
            if let Some((command_id, mut request)) = request {
                request["input_source"] = json!(source.receipt_name());
                request["links_ordered"] = Value::Bool(true);
                save_outcome(connection, command_id, &request.to_string(), &id)?;
            }
            let message = read_message(connection, &id)?;
            Ok((ChatInputReceipt { id, message }, run, links_changed))
        })
    }

    /// Reads the outcome of a person's previously saved input. A retry can succeed even
    /// when the Chat has since become busy and would refuse new attachments.
    pub fn replay_chat_input(
        &self,
        command_id: &str,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
    ) -> Result<Option<ChatMessage>, Error> {
        self.replay_chat_input_replacing(command_id, chat_id, text, files, &[])?
            .map(ChatInputReceipt::into_message)
            .transpose()
    }

    /// Whether an edited input was durably saved. This reads the receipt only, even
    /// if the replacement message itself was later edited or removed.
    pub fn chat_queue_edit_saved(&self, chat_id: &str, command_id: &str) -> Result<bool, Error> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM request_outcomes WHERE id = ?1
              AND json_extract(request, '$.operation') = 'save_chat_input'
              AND json_extract(request, '$.chat_id') = ?2
              AND json_array_length(request, '$.replaces') > 0)",
            params![command_id, chat_id],
            |row| row.get(0),
        )?)
    }

    /// Confirms an exact edited send even if its saved replacement was later removed.
    pub fn replay_chat_queue_edit(
        &self,
        command_id: &str,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        replaces: &[String],
    ) -> Result<bool, Error> {
        if replaces.is_empty() {
            return Ok(false);
        }
        Ok(self
            .replay_chat_input_replacing(command_id, chat_id, text, files, replaces)?
            .is_some())
    }

    /// Reads the exact saved receipt even after its replacement row was withdrawn.
    pub fn replay_chat_input_replacing(
        &self,
        command_id: &str,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        replaces: &[String],
    ) -> Result<Option<ChatInputReceipt>, Error> {
        self.replay_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement {
                replaces,
                ..InputReplacement::default()
            },
            InputSource::Person,
        )
    }

    /// Validates a saved edit without taking the writer or reapplying links.
    /// A historical save with no link receipt still replays its original outcome.
    pub fn replay_chat_input_with_edit(
        &self,
        command_id: &str,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        edit: Option<&ChatQueueEdit>,
    ) -> Result<Option<ChatInputReceipt>, Error> {
        self.replay_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement::for_edit(edit)?,
            InputSource::Person,
        )
    }

    pub fn replay_chat_input_with_change(
        &self,
        command_id: &str,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        change: Option<&ChatInputChange>,
    ) -> Result<Option<ChatInputReceipt>, Error> {
        self.replay_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement::for_change(change)?,
            InputSource::Person,
        )
    }

    /// Replays an Automation takeover reply without taking over the run.
    pub fn replay_automation_chat_reply_with_change(
        &self,
        command_id: &str,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        change: Option<&ChatInputChange>,
    ) -> Result<Option<ChatInputReceipt>, Error> {
        self.replay_input(
            command_id,
            chat_id,
            text,
            files,
            InputReplacement::for_change(change)?,
            InputSource::AutomationReply,
        )
    }

    fn replay_input(
        &self,
        command_id: &str,
        chat_id: &str,
        text: &str,
        files: &[ChatAttachmentContent],
        replacement: InputReplacement<'_>,
        source: InputSource<'_>,
    ) -> Result<Option<ChatInputReceipt>, Error> {
        let request = save_input_request(chat_id, text, files, replacement)?;
        crate::read_scope::run(&self.connection, |connection| {
            read_input_receipt(connection, command_id, &request, chat_id, source)
        })
    }

    /// Withdraw queued input the person no longer wants sent. Refused once a submission
    /// may have reached the harness: that input is history, not queue.
    pub fn withdraw_chat_input(&mut self, chat_id: &str, message_id: &str) -> Result<Chat, Error> {
        self.chat_write(|connection| {
            read_chat(connection, chat_id)?;
            let message = if owned(connection, "chat_messages", chat_id, message_id)? {
                read_message(connection, message_id)?
            } else {
                None
            };
            let Some(message) = message.filter(|message| message.queued) else {
                return Err(invalid("this input is not in the queue"));
            };
            delete_queued_input(connection, message_id)?;
            let position = log(connection, chat_id, "chat", chat_id)?;
            if message.editing {
                advance_change_floor(connection, chat_id, position)?;
            }
            trim(connection, chat_id)?;
            read_chat(connection, chat_id)
        })
    }

    /// Holds queued input for editing without withdrawing its text and snapshots.
    /// A retry returns the same outcome after a lost acknowledgement.
    pub fn confirm_chat_queue_edit(
        &mut self,
        chat_id: &str,
        message_id: &str,
        transfer_id: &str,
    ) -> Result<bool, Error> {
        self.chat_write(|connection| {
            let request = json!({
                "operation": "confirm_chat_queue_edit",
                "chat_id": chat_id,
                "message_id": message_id,
            });
            let outcome = once(connection, Some(transfer_id), request, || {
                let queued = owned(connection, "chat_messages", chat_id, message_id)?
                    && read_message(connection, message_id)?.is_some_and(|message| message.queued);
                if !queued {
                    return Ok(String::new());
                }
                connection.execute(
                    "UPDATE chat_messages SET editing = 1 WHERE id = ?1",
                    [message_id],
                )?;
                log(connection, chat_id, "message", message_id)?;
                log(connection, chat_id, "chat", chat_id)?;
                trim(connection, chat_id)?;
                Ok(message_id.to_owned())
            })?;
            Ok(!outcome.is_empty())
        })
    }

    /// Set queued input aside without sending it: it moves from the queue to the end of
    /// the history as input that was never delivered and is never sent. For input the
    /// person did not write, which must not wait to go out for them.
    pub fn set_aside_queued_chat_input(
        &mut self,
        chat_id: &str,
        message_id: &str,
    ) -> Result<ChatMessage, Error> {
        self.chat_write(|connection| {
            let message = require_input(connection, chat_id, message_id)?;
            if !message.queued || message.editing {
                return Err(invalid("this input is not in the queue"));
            }
            set_aside_input(connection, chat_id, message_id, true)?;
            trim(connection, chat_id)?;
            read_message(connection, message_id)?.ok_or_else(|| invalid("saved input is missing"))
        })
    }

    /// The text of the Chat's first message from the person, which its title was cut
    /// from; `None` while it has none. Read on its own, because a snapshot holds
    /// only the latest items. First means first saved (insertion order), not first
    /// in the transcript: sending queued input moves its position.
    pub fn chat_first_input_text(&self, chat_id: &str) -> Result<Option<String>, Error> {
        read_chat(&self.connection, chat_id)?;
        Ok(self
            .connection
            .query_row(
                "SELECT text FROM chat_messages WHERE chat_id = ?1 AND role = 'user'
                 ORDER BY rowid LIMIT 1",
                [chat_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Queued input in the order it was saved, including originals held for editing.
    pub fn chat_queue(&self, chat_id: &str) -> Result<Vec<ChatMessage>, Error> {
        crate::read_scope::run(&self.connection, |connection| {
            read_chat(connection, chat_id)?;
            let mut statement = connection.prepare(&format!(
                "SELECT id FROM chat_messages m WHERE chat_id = ?1 AND {QUEUED_CHAT_INPUT}
                 ORDER BY position"
            ))?;
            let ids = statement
                .query_map([chat_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut queue = Vec::with_capacity(ids.len());
            for id in ids {
                queue.extend(read_message(connection, &id)?.filter(|message| message.queued));
            }
            Ok(queue)
        })
    }

    /// Whether saved input needs linked-record context, including input awaiting resend.
    pub fn chat_input_requires_link_context(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> Result<bool, Error> {
        crate::read_scope::run(&self.connection, |connection| {
            Ok(require_input(connection, chat_id, message_id)?.requires_link_context)
        })
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
        self.submit_input(chat_id, message_id, attempt_id, intent, false, None)?
            .ok_or_else(|| invalid("saved input is missing"))
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
        self.submit_input(chat_id, message_id, attempt_id, intent, true, None)?
            .ok_or_else(|| invalid("saved input is missing"))
    }

    /// Records the run's Prompt only while that run still owns the Chat.
    pub fn record_automation_chat_submission(
        &mut self,
        chat_id: &str,
        run_id: &str,
        message_id: &str,
        attempt_id: &str,
    ) -> Result<Option<ChatMessage>, Error> {
        self.submit_input(
            chat_id,
            message_id,
            attempt_id,
            ChatSubmissionIntent::NewTurn,
            false,
            Some(run_id),
        )
    }

    fn submit_input(
        &mut self,
        chat_id: &str,
        message_id: &str,
        attempt_id: &str,
        intent: ChatSubmissionIntent,
        from_queue: bool,
        run_id: Option<&str>,
    ) -> Result<Option<ChatMessage>, Error> {
        self.chat_write(|connection| {
            if let Some(run_id) = run_id {
                if !owns_running_chat(connection, chat_id, run_id)? {
                    return Ok(None);
                }
                if !matches!(
                    automation_prompt_receipt(connection, chat_id)?,
                    Some(AutomationPromptReceipt::Marked(id)) if id == message_id
                ) {
                    return Err(invalid("only the Automation Prompt can be submitted"));
                }
            }
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
                Some(recorded) if recorded == message_id => return Ok(Some(message)),
                Some(_) => return Err(Error::RequestConflict(attempt_id.to_owned())),
                None => {}
            }
            if message.editing {
                return Err(invalid("this input is held for editing"));
            }
            if !message.queued {
                return Err(Error::ChatSubmissionUnresolved(message_id.to_owned()));
            }
            let sequence = log(connection, chat_id, "message", message_id)?;
            connection.execute(
                "INSERT INTO chat_submission_attempts (id, chat_id, message_id, intent, delivery)
                 VALUES (?1, ?2, ?3, ?4, 'possible')",
                params![attempt_id, chat_id, message_id, name(intent)?],
            )?;
            receipt::record_boundary(
                connection,
                chat_id,
                receipt::Boundary::Submission(attempt_id),
            )?;
            // Positions are change sequences, so this one is unused and the latest.
            if from_queue && message.attempts.is_empty() {
                connection.execute(
                    "UPDATE chat_messages SET position = ?1 WHERE id = ?2",
                    params![sequence, message_id],
                )?;
            }
            trim(connection, chat_id)?;
            Ok(Some(
                read_message(connection, message_id)?
                    .ok_or_else(|| invalid("saved input is missing"))?,
            ))
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
                "INSERT INTO chat_submission_attempts (id, chat_id, message_id, intent, delivery)
                 VALUES (?1, ?2, ?3, ?4, 'possible')",
                params![
                    attempt_id,
                    chat_id,
                    message_id,
                    name(ChatSubmissionIntent::NewTurn)?
                ],
            )?;
            receipt::record_boundary(
                connection,
                chat_id,
                receipt::Boundary::Submission(attempt_id),
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
        self.record_chat_observation_batch(chat_id, observations, None)
    }

    /// Record a batch for an observed Turn end, retaining the first readable
    /// boundary even if the transaction fails and the batch needs to be retried.
    pub fn record_chat_turn_observations(
        &mut self,
        chat_id: &str,
        observations: Vec<ChatObservation>,
        receipt: &mut ChatTurnReceipt,
    ) -> Result<i64, Error> {
        self.record_chat_observation_batch(chat_id, observations, Some(receipt))
    }

    fn record_chat_observation_batch(
        &mut self,
        chat_id: &str,
        observations: Vec<ChatObservation>,
        mut receipt: Option<&mut ChatTurnReceipt>,
    ) -> Result<i64, Error> {
        self.chat_write(|connection| {
            read_chat(connection, chat_id)?;
            if let Some(receipt) = receipt.as_deref_mut() {
                receipt.capture_end(connection)?;
            }
            for observation in observations {
                observe(connection, chat_id, observation, receipt.as_deref_mut())?;
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
    /// At startup or after a storage failure, the stored state may outlive the runtime
    /// behind it. The host supplies `ending` for the active turn.
    pub fn mark_chat_contact_lost(
        &mut self,
        chat_id: Option<&str>,
        detail: &str,
        ending: &str,
    ) -> Result<Vec<String>, Error> {
        self.reconcile_chat_contact_loss(chat_id, detail, ending, None)
    }

    /// Settle a live runtime's loss and capture the observed active Turn's agent
    /// changes in the transaction that first ends it.
    pub fn mark_chat_runtime_lost(
        &mut self,
        chat_id: &str,
        receipt: Option<&mut ChatTurnReceipt>,
        detail: &str,
        ending: &str,
    ) -> Result<(), Error> {
        self.reconcile_chat_contact_loss(Some(chat_id), detail, ending, receipt)?;
        Ok(())
    }

    fn reconcile_chat_contact_loss(
        &mut self,
        chat_id: Option<&str>,
        detail: &str,
        ending: &str,
        mut receipt: Option<&mut ChatTurnReceipt>,
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
                  OR EXISTS (SELECT 1 FROM chat_sub_agent_runs WHERE chat_id = chats.id AND state = 'running')
                  OR EXISTS (SELECT 1 FROM chat_submission_attempts WHERE chat_id = chats.id AND delivery = 'possible' AND turn_id IS NULL))
                 ORDER BY rowid",
            )?;
            let affected = statement
                .query_map([chat_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            for id in &affected {
                lose_contact(connection, id, detail, ending, receipt.as_deref_mut())?;
            }
            Ok(affected)
        })
    }

    /// Marks this connection as writing for the Chat `chat_id` (the CLI run by that
    /// Chat's harness, see `CHAT_ID_VARIABLE`): the status moves and Activities it
    /// records are credited to that Chat. Connection-scoped like `act_as_local_person`;
    /// TEMP triggers keep every write path unchanged.
    pub fn act_for_chat(&mut self, chat_id: &str) -> Result<(), Error> {
        self.act_for_chat_call(chat_id, None)
    }

    /// Like [`Self::act_for_chat`], for a harness that names each command it runs:
    /// `call_id` (blank counts as none) is kept with every write, and tells exactly which
    /// Step, so which agent, made it.
    pub fn act_for_chat_call(&mut self, chat_id: &str, call_id: Option<&str>) -> Result<(), Error> {
        let call_id = call_id.map(str::trim).filter(|id| !id.is_empty());
        receipt::prepare_writer(&self.connection, chat_id, call_id)
    }

    /// The agent each tagged status move and Activity on a ticket is credited to, as far as
    /// it can be told exactly: see `ChatWriteCredit`.
    pub fn ticket_write_credits(&self, reference: &str) -> Result<TicketWriteCredits, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            credit::ticket_credits(&self.connection, &ticket.id, &ticket.reference)
        })
    }

    /// A ticket's history with the agent each status move is credited to: see
    /// [`Self::ticket_write_credits`]. Other entries carry none.
    pub fn ticket_history_credits(
        &self,
        reference: &str,
    ) -> Result<Vec<(crate::HistoryEntry, Option<ChatWriteCredit>)>, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            let entries = crate::history::read(&self.connection, &ticket.id)?;
            let numbers = crate::history::numbers(&self.connection, &ticket.id)?;
            let mut credits =
                credit::ticket_credits(&self.connection, &ticket.id, &ticket.reference)?;
            Ok(entries
                .into_iter()
                .zip(numbers)
                .map(|(entry, number)| (entry, credits.statuses.remove(&number)))
                .collect())
        })
    }

    /// One sub-agent of a Chat, by the harness's own ID for it, with its runs.
    pub fn chat_sub_agent(
        &self,
        chat_id: &str,
        native_id: &str,
    ) -> Result<Option<ChatSubAgent>, Error> {
        self.read(|_| {
            sub_agents::read_record(&self.connection, &sub_agents::record_id(chat_id, native_id))
        })
    }

    /// The agents of Chats on this computer with a credited write on the ticket, and
    /// whether each is running now (a sub-agent's latest run is; the main agent has an
    /// active turn): the label "{model} is working on this ticket" reads this.
    pub fn ticket_writing_agents(&self, reference: &str) -> Result<Vec<TicketWritingAgent>, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            credit::writing_agents(&self.connection, &ticket.id, &ticket.reference)
        })
    }

    /// The tickets (ID and reference) that a Chat with something running now has a
    /// credited write on: where a ticket label may be showing or about to. Reading each
    /// ticket's [`Self::ticket_writing_agents`] says exactly who runs.
    pub fn tickets_with_running_writers(&self) -> Result<Vec<(String, String)>, Error> {
        self.read(|_| {
            let mut statement = self.connection.prepare(
                "WITH running AS (
                     SELECT id FROM chats WHERE trashed = 0 AND (
                         EXISTS (SELECT 1 FROM chat_turns WHERE chat_id = chats.id AND state = 'active')
                      OR EXISTS (SELECT 1 FROM chat_sub_agent_runs WHERE chat_id = chats.id AND state = 'running')))
                 SELECT DISTINCT t.id, t.reference FROM tickets t WHERE t.id IN (
                     SELECT a.ticket_id FROM activities a JOIN chat_record_writes w ON w.activity_id = a.id
                     WHERE w.chat_id IN (SELECT id FROM running)
                     UNION
                     SELECT h.ticket_id FROM ticket_history h JOIN chat_record_writes w ON w.history_number = h.number
                     WHERE h.kind = 'status' AND w.chat_id IN (SELECT id FROM running))
                 ORDER BY t.reference",
            )?;
            let tickets = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok(tickets)
        })
    }

    /// The reference of the ticket with this ID, if there is one.
    pub fn ticket_reference_of(&self, id: &str) -> Result<Option<String>, Error> {
        self.read(|_| {
            Ok(self
                .connection
                .query_row("SELECT reference FROM tickets WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?)
        })
    }

    /// What the Chat's agent changed in tickets during the Turn, oldest first.
    /// New writes with this Chat's identity count in durable commit order, from its
    /// first correlated submission or observed Turn start, whichever came first.
    /// A Turn with older boundaries falls back to the available timestamps.
    /// Writes without a Chat identity count from the observed Turn start and only
    /// when the agent name matches the harness and no other Chat of that harness
    /// had a Turn running at the time.
    // Documents carry no agent name yet, so a created Document is not listed.
    pub fn chat_turn_agent_changes(
        &self,
        chat_id: &str,
        turn_id: &str,
    ) -> Result<Vec<ChatAgentChange>, Error> {
        crate::read_scope::run(&self.connection, |connection| {
            receipt::read_changes(connection, chat_id, turn_id, false)
        })
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
        crate::read_scope::run(&self.connection, |transaction| {
            let chat = read_chat(transaction, chat_id)?;
            let page = read_history(transaction, chat_id, i64::MAX, limit)?;
            let sequence = head(transaction)?;
            Ok(ChatSnapshot {
                chat,
                sequence,
                items: page.items,
                earlier: page.earlier,
                sub_agents: sub_agents::read_all(transaction, chat_id)?,
            })
        })
    }

    /// The sub-agents the next message has to tell the harness about: the ones that lost
    /// contact and are still lost, oldest first. Empty when there is nothing to tell.
    pub fn chat_restart_notice(&self, chat_id: &str) -> Result<Vec<ChatSubAgent>, Error> {
        crate::read_scope::run(&self.connection, |connection| {
            read_chat(connection, chat_id)?;
            let kept = sub_agents::notice(connection, chat_id)?;
            let mut lost = Vec::new();
            for native_id in kept {
                let record = sub_agents::read_record(
                    connection,
                    &sub_agents::record_id(chat_id, &native_id),
                )?;
                lost.extend(record.filter(|record| {
                    record.latest().map(|run| run.state) == Some(ChatSubAgentState::Lost)
                }));
            }
            Ok(lost)
        })
    }

    /// Keeps `note` as what ticketd added to the person's message `message_id` for the
    /// harness, and clears the Chat's notice: it has been told.
    pub fn record_chat_message_note(
        &mut self,
        chat_id: &str,
        message_id: &str,
        note: &ChatMessageNote,
    ) -> Result<(), Error> {
        let stored = serde_json::to_string(note)?;
        self.chat_write(|connection| {
            let changed = connection.execute(
                "UPDATE chat_messages SET note = ?3 WHERE id = ?2 AND chat_id = ?1 AND role = 'user'",
                params![chat_id, message_id, stored],
            )?;
            if changed == 0 {
                return Err(invalid("the message the note belongs to is missing"));
            }
            log(connection, chat_id, "message", message_id)?;
            sub_agents::set_notice(connection, chat_id, &[])
        })
    }

    /// Up to `limit` history items before `before`, a position from an item already read.
    pub fn chat_history(
        &self,
        chat_id: &str,
        before: i64,
        limit: usize,
    ) -> Result<ChatHistoryPage, Error> {
        crate::read_scope::run(&self.connection, |connection| {
            read_chat(connection, chat_id)?;
            read_history(connection, chat_id, before, limit)
        })
    }

    /// The Chats written after change `after`, each with its latest change: what an
    /// overview reads again, leaving the other Chats as they were.
    pub fn chats_changed_since(&self, after: i64) -> Result<Vec<(String, i64)>, Error> {
        let mut statement = self.connection.prepare_cached(
            "SELECT chat_id, MAX(sequence) FROM chat_changes WHERE sequence > ?1 GROUP BY chat_id",
        )?;
        let changed = statement
            .query_map([after], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(changed)
    }

    /// The whole stored output of one of the Chat's tool calls; `None` when it has none
    /// or the call is not the Chat's. Views carry only its last lines.
    pub fn chat_tool_output(&self, chat_id: &str, tool_id: &str) -> Result<Option<String>, Error> {
        Ok(self
            .connection
            .query_row(
                "SELECT output FROM chat_tools WHERE chat_id = ?1 AND id = ?2",
                params![chat_id, tool_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
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
        crate::read_scope::run(&self.connection, |transaction| {
            let trimmed_through: i64 = transaction
                .query_row(
                    "SELECT changes_trimmed_through FROM chats WHERE id = ?1",
                    [chat_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| Error::ChatNotFound(chat_id.to_owned()))?;
            if after < trimmed_through || after > head(transaction)? {
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
                    Some(ChatRecord::Chat(read_chat(transaction, &id)?))
                } else if kind == "sub_agent" {
                    sub_agents::read_record(transaction, &id)?.map(ChatRecord::SubAgent)
                } else {
                    read_item(transaction, &kind, &id)?.map(ChatRecord::Item)
                };
                changes.extend(record.map(|record| ChatChange { sequence, record }));
            }
            Ok(ChatCatchUp::Changes {
                changes,
                sequence,
                more,
            })
        })
    }
}
