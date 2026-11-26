//! What the Chat screens read: stored Chat records and the host's live state, worded and
//! shaped for display. Nothing here is a harness wire format, and nothing here decides
//! what runs; it only describes what the core and the host already know.
use std::collections::HashMap;

use serde::Serialize;

use ticketd_chat_host::attention::{self, Facts, Status};
use ticketd_chat_host::conditions::ChatProblemKind;
use ticketd_chat_host::{
    AGENT_CHANGES_RECORD_NAME, Activity, ApprovalDecision, CONTEXT_RECORD_NAME, ChatLive,
    ChatProblem, FileTargets, InteractionKind, OmittedFiles, ProblemKind, ReadAction, RunAction,
    SearchScope, StepAction, StepOutcomeOverride, StopState, ToolEvidence, ToolStep, TurnEnding,
    WebAction, read_tool_steps,
};
use ticketd_core::harnesses::{ResumePolicy, descriptor};
use ticketd_core::{
    Chat, ChatAgentChange, ChatAttachment, ChatDelivery, ChatInputStanding, ChatInteraction,
    ChatInteractionKind, ChatInteractionState, ChatItem, ChatMessage, ChatRole, ChatSessionOrigin,
    ChatSubmissionIntent, ChatSuggestion, ChatTool, ChatToolState, ChatTurn, ChatTurnState,
    SuggestedTicket,
};

use crate::chat_reports::{self, ContextView, FileView, PlanStepView, Report, SettingsView};
use crate::chat_ticketd::{self, Call};
use crate::folder_probe::Branch;
use ticketd_chat_host::step_kind;

pub fn harness_name(id: &str) -> &str {
    ticketd_core::harnesses::descriptor(id).map_or(id, |descriptor| descriptor.name)
}

/// Where the harness's publisher explains installing and updating it.
pub fn help_url(harness: &str) -> Option<&'static str> {
    ticketd_core::harnesses::descriptor(harness).map(|descriptor| descriptor.help_url)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub kind: ChatProblemKind,
    /// What the notice is titled; the list row says the same of a failed turn.
    pub title: String,
    /// Observed now, it keeps the Chat from taking a new message.
    pub blocks_send: bool,
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_recovery: Option<HistoryRecovery>,
    pub command: Option<String>,
    pub help_url: Option<String>,
    pub path: Option<String>,
    pub message_id: Option<String>,
    /// When the provider said a usage limit resets, in seconds since the Unix epoch.
    /// `None` when it did not say.
    pub resets_at: Option<i64>,
    /// The problem is why the last turn stopped, not a condition observed now: it is
    /// told, and it does not stop the next message.
    pub past: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRecovery {
    StartFresh,
    SelectHistory,
}

fn history_recovery(harness: &str) -> Option<HistoryRecovery> {
    let policy = descriptor(harness)?.resume;
    Some(match policy {
        ResumePolicy::NativeOnly => HistoryRecovery::StartFresh,
        ResumePolicy::NativeOrReplay => HistoryRecovery::SelectHistory,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinkedRecord {
    Ticket {
        id: String,
        reference: String,
        title: String,
        status: String,
    },
    Document {
        id: String,
        title: String,
    },
    Project {
        id: String,
        title: String,
        archived: bool,
    },
}

/// What a step acted on: a path relative to the Chat's folder (`~` for the home
/// folder outside it), a pattern, a query or a page.
/// One of New Chat's suggestions, with the tickets it links as the composer shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Suggestion {
    Continue {
        ticket: LinkedRecord,
        at: Option<String>,
    },
    Review {
        ticket: LinkedRecord,
        at: Option<String>,
    },
    /// `count` unread entries about the linked tickets; `at` is the newest.
    Triage {
        count: usize,
        links: Vec<LinkedRecord>,
        at: String,
    },
}

impl From<ChatSuggestion> for Suggestion {
    fn from(suggestion: ChatSuggestion) -> Self {
        let record = |ticket: SuggestedTicket| LinkedRecord::Ticket {
            id: ticket.id,
            reference: ticket.reference,
            title: ticket.title,
            status: ticket.status.to_string(),
        };
        match suggestion {
            ChatSuggestion::Continue { ticket, at } => Self::Continue {
                ticket: record(ticket),
                at,
            },
            ChatSuggestion::Review { ticket, at } => Self::Review {
                ticket: record(ticket),
                at,
            },
            ChatSuggestion::Triage { count, links, at } => Self::Triage {
                count,
                links: links.into_iter().map(record).collect(),
                at,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepTarget {
    pub text: String,
    /// The lines read, first and last.
    pub lines: Option<[u32; 2]>,
    /// Where a search looked.
    pub scope: Option<String>,
}

/// One tool call as a step row. Classified from the stored tool each time the view is
/// built, so older records read the same way and nothing new is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    /// `read`, `search`, `edit`, `create`, `delete`, `run`, `web` or `other`.
    pub kind: &'static str,
    /// `list` (a read that lists folders), `fetch` (a web page) or `script` (a
    /// command that runs a script given on its input).
    pub variant: Option<&'static str>,
    /// Readable text for a step without targets: the command, the tool, or what
    /// ticketd did.
    pub target: String,
    pub targets: Vec<StepTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted_files: Option<OmittedFilesView>,
    /// The command without its shell wrappers, for a command step.
    pub command: Option<String>,
    pub exit_code: Option<i64>,
    /// Where the command ran, when that is not the Chat's folder.
    pub folder: Option<String>,
    pub timed_out: bool,
    pub duration_ms: Option<i64>,
    /// A search that finished and found nothing.
    pub no_matches: bool,
    /// `running`, `done`, `failed`, `declined`, `not_finished` (the turn ended first)
    /// or `unknown` (contact was lost): a step not `done` is not told as done.
    pub state: &'static str,
    pub result: Option<String>,
    /// The output's last lines: what a view shows until the row opens.
    pub output: Option<String>,
    /// Set when `output` holds only the last lines: where to read all of it.
    pub full_output: Option<FullOutput>,
    /// When the host recorded the call, for a running step's clock. Absent from calls
    /// recorded before ticketd kept it.
    pub started_at: Option<String>,
    /// Lines the step added and removed, when the harness said: the diffstat.
    pub added_lines: Option<u32>,
    pub removed_lines: Option<u32>,
    /// What the person decided when the harness asked to take this step ("You declined
    /// this"): the approval folds into the step it was asked for.
    pub decision: Option<String>,
    /// A command that only calls ticketd, as sentences ("Set T-MP4 to In progress").
    /// `command` keeps exactly what runs.
    pub ticketd: Option<Vec<Call>>,
    /// The harness waits for the person to approve this step: the request card says it,
    /// so the step has no row of its own until it is decided.
    pub awaiting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OmittedFilesView {
    /// Older compact patches can reveal missing paths without their count.
    pub count: Option<u32>,
}

/// Where a step's whole output is read when its row opens (`chat_step_output`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FullOutput {
    pub tool_id: String,
    pub bytes: usize,
}

/// The lines of output a step carries until its row opens; tool output is kept up to
/// 1 MiB, and every snapshot and update would carry it.
const OUTPUT_TAIL_LINES: usize = 20;
/// The most a step carries even when its last lines are long.
const OUTPUT_TAIL_BYTES: usize = 4096;

/// The last `OUTPUT_TAIL_LINES` lines of `output`, at most `OUTPUT_TAIL_BYTES` long.
fn output_tail(output: &str) -> &str {
    let body = output.strip_suffix('\n').unwrap_or(output);
    let lines = body
        .rmatch_indices('\n')
        .nth(OUTPUT_TAIL_LINES - 1)
        .map_or(0, |(at, _)| at + 1);
    let mut start = lines.max(output.len().saturating_sub(OUTPUT_TAIL_BYTES));
    while !output.is_char_boundary(start) {
        start += 1;
    }
    &output[start..]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RequestOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    User {
        id: String,
        at: String,
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<ChatAttachment>,
        delivery: &'static str,
        /// The turn that took this message, once one did.
        turn_id: Option<String>,
        /// Sent to steer a turn in progress: what follows is a new segment of it.
        steer: bool,
    },
    Response {
        id: String,
        at: String,
        text: String,
        state: &'static str,
        turn_id: Option<String>,
    },
    Steps {
        id: String,
        at: String,
        steps: Vec<Step>,
        turn_id: Option<String>,
    },
    /// What the agent changed in ticketd during a turn.
    Records {
        id: String,
        at: String,
        changes: Vec<ChatAgentChange>,
        /// For each change, whether its record is now `trashed` or `deleted`; such a
        /// record is named, not linked. Filled in where the workspace can be read.
        gone: Vec<Option<&'static str>>,
        turn_id: Option<String>,
    },
    /// When a turn started and ended, and how. It has no row of its own: the view folds
    /// the turn's items under one line that says this.
    Turn {
        /// `turn:` and the turn's id, apart from the id of its end marker.
        id: String,
        at: String,
        turn_id: String,
        started_at: String,
        ended_at: Option<String>,
        /// `active`, `completed`, `stopped` (by the person), `quit` (ticketd stopped it),
        /// `failed` or `lost` (contact was lost, so how it ended is unknown).
        outcome: &'static str,
    },
    Request {
        id: String,
        at: String,
        turn_id: Option<String>,
        request: &'static str,
        title: String,
        subject: Option<String>,
        /// Why the harness asks, apart from what would run.
        reason: Option<String>,
        options: Vec<RequestOption>,
        free_text: bool,
        state: &'static str,
        outcome: Option<String>,
        /// For an answered question, the answer as given.
        answer: Option<String>,
        /// An answered approval: its decision is told on the step it was asked for, so
        /// it has no row of its own. Receipts are kept for questions and expiries.
        folded: bool,
        /// When it was answered or expired; `at` is when it was asked. Absent from
        /// requests recorded before ticketd kept them.
        resolved_at: Option<String>,
        /// Exactly what would run, when `subject` shows it shortened or as sentences.
        command: Option<String>,
        /// A command that only calls ticketd, as sentences after the title.
        ticketd: Option<Vec<Call>>,
    },
    Marker {
        id: String,
        at: String,
        reason: &'static str,
        message: Option<String>,
        /// Set for the marker that ends a turn.
        turn_id: Option<String>,
    },
    Session {
        id: String,
        at: String,
        history: &'static str,
        count: usize,
    },
    /// One reasoning item of a turn. Times are milliseconds since the Unix epoch.
    Reasoning {
        id: String,
        at: String,
        turn_id: String,
        state: &'static str,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        text: Option<String>,
        heading: Option<String>,
    },
    /// A turn's plan, as the harness last reported it.
    Plan {
        id: String,
        at: String,
        turn_id: String,
        state: &'static str,
        steps: Vec<PlanStepView>,
        explanation: Option<String>,
    },
    /// The files a turn changed.
    Files {
        id: String,
        at: String,
        turn_id: String,
        state: &'static str,
        files: Vec<FileView>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessRef {
    pub id: String,
    pub name: String,
    pub permissions: Option<String>,
}

/// Another Chat that uses the same folder, as the context popover lists it to open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SharedChat {
    pub id: String,
    pub title: String,
    /// "active" or "archived": the list it opens under.
    pub retention: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Folder {
    pub path: String,
    pub name: String,
    pub managed: bool,
    pub missing: bool,
    pub shared_with: Vec<SharedChat>,
    /// The git branch checked out in the folder, read now; `None` outside a repository.
    pub branch: Option<BranchView>,
    /// The Project whose folder holds the Chat's, else the first linked Project.
    pub project: Option<ProjectRef>,
}

/// `branch` (with its name), `detached` (with the short commit) or `unreadable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BranchView {
    pub kind: &'static str,
    pub name: Option<String>,
}

impl From<&Branch> for BranchView {
    fn from(branch: &Branch) -> Self {
        match branch {
            Branch::Named(name) => Self {
                kind: "branch",
                name: Some(name.clone()),
            },
            Branch::Detached(commit) => Self {
                kind: "detached",
                name: Some(commit.clone()),
            },
            Branch::Unreadable => Self {
                kind: "unreadable",
                name: None,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectRef {
    pub id: String,
    pub title: String,
}

/// A linked ticket as a list row's context item names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TicketRef {
    pub reference: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Doing {
    pub label: String,
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Steering {
    pub available: bool,
    pub images_refused: bool,
    pub effect: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Queued {
    pub id: String,
    pub text: String,
    pub editing: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ChatAttachment>,
    /// It was sent to steer the running turn and the harness did not take it: why, as
    /// the host recorded it. The card says "Couldn't steer; queued".
    pub refused_steer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatState {
    pub id: String,
    pub title: String,
    pub harness: HarnessRef,
    pub folder: Folder,
    pub retention: &'static str,
    pub activity: &'static str,
    pub problem: Option<Problem>,
    pub doing: Option<Doing>,
    /// Working while the harness session opens: "resume" or "start".
    pub opening: Option<&'static str>,
    pub catching_up: bool,
    pub steering: Steering,
    /// Stop was asked for and the harness has not ended the turn; Stop waits. Not set
    /// once the wait ran out unconfirmed, so Stop can be asked for again.
    pub stopping: bool,
    pub links: Vec<LinkedRecord>,
    pub queue: Vec<Queued>,
    pub queue_paused: bool,
    /// How full the live session's context window is, when the harness reported it.
    pub context: Option<ContextView>,
    /// The live session's settings, when the harness reported them.
    pub settings: Option<SettingsView>,
    /// The last turn ended after the person last saw the Chat, or they marked it unread.
    pub unseen: bool,
    pub muted: bool,
    /// There is something to type into: the Chat is not in trash, and neither its
    /// folder nor its session is gone.
    pub has_composer: bool,
    /// The last transcript item the person had in view: the New marker goes after it.
    pub read_through: Option<String>,
    /// Linked records now in the trash: a mention of one reads "(in Trash)".
    pub trashed_links: Vec<String>,
    /// The slash commands the live session's harness lists, for the `/` menu.
    pub commands: Vec<CommandView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandView {
    /// Without its slash: "review".
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub harness_id: String,
    pub harness_name: String,
    pub folder_name: Option<String>,
    pub first_ticket: Option<String>,
    /// The Chat's Project, as the header names its folder's Project.
    pub project: Option<ProjectRef>,
    /// The linked tickets, in link order.
    pub tickets: Vec<TicketRef>,
    pub retention: &'static str,
    pub activity: &'static str,
    pub needs_you: bool,
    pub problem: Option<ChatProblemKind>,
    /// `problem` is why the last turn stopped, not a condition observed now.
    pub problem_past: bool,
    pub interruption: Option<&'static str>,
    /// The latest change the agent made in ticketd.
    pub last_change: Option<ChatAgentChange>,
    pub preview: Option<String>,
    pub updated_at: String,
    /// The ranked status every Chat surface shows (spec 21.3).
    pub status: Status,
    pub muted: bool,
}

/// The history a fresh session was started with. It is known only for the run of
/// ticketd that started the session; the core does not store it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FreshHistory {
    /// The session item this describes is the first one recorded after this position.
    pub after: i64,
    pub history: &'static str,
    pub count: usize,
}

/// What the Chat's own record does not say and the workspace has to be asked for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Surroundings {
    pub folder_missing: bool,
    /// The other Chats that use the same folder.
    pub shared_with: Vec<SharedChat>,
    pub links: Vec<LinkedRecord>,
    pub queue: Vec<Queued>,
    pub project: Option<ProjectRef>,
    /// Read only for an open Chat; list rows do not show it.
    pub branch: Option<Branch>,
    /// The failed turn after which the person checked the harness again and it was
    /// usable; its failure is no longer told as a problem.
    pub checked_turn: Option<String>,
    /// Ids of linked records now in the trash.
    pub trashed_links: Vec<String>,
}

/// What a view has to remember from the history it has seen, because a change names
/// one record and says nothing about the others it affects.
#[derive(Debug, Clone, Default)]
pub struct Tracker {
    last_turn: Option<ChatTurn>,
    /// A submission whose delivery the person has to decide about, and why the resend
    /// they asked for was not accepted, when that is how it came back to them.
    uncertain: Option<(String, Option<String>)>,
    /// The text of that submission.
    uncertain_text: Option<String>,
    /// Requests stored as pending; whether one can be answered is the host's live state.
    pending: HashMap<String, ChatInteraction>,
    /// What the person decided about the approval asked for each tool call, by tool id.
    decided: Decided,
    /// The latest turn's tool calls, to show again when an approval for one is decided.
    turn_tools: HashMap<String, ChatTool>,
    /// Tool calls whose approval was just decided, to show again with the decision.
    refold: Vec<String>,
    /// Assistant messages that are not complete; they stop streaming when their turn ends.
    open: HashMap<String, ChatMessage>,
    last_response: Option<String>,
    last_change: Option<ChatAgentChange>,
    /// The turn `last_change` was made in.
    last_change_turn: Option<String>,
    updated_at: Option<String>,
    /// Reasoning, plan and files records of the latest turn: how they read depends on
    /// whether it still runs.
    reports: HashMap<String, ChatTool>,
}

/// How user input that was submitted at least once, or that the host holds to send,
/// reads. The core decides where it stands, from every attempt, the person's decisions
/// and the host's hold together. Input only in the queue has no row.
fn delivery(message: &ChatMessage, live: &ChatLive) -> Option<&'static str> {
    let held = live.sending.contains(&message.id);
    if message.attempts.is_empty() && !held {
        return None;
    }
    Some(match message.standing_while(held) {
        ChatInputStanding::Sending => "sending",
        ChatInputStanding::Delivered => "delivered",
        // The person set it aside; whether it arrived is still unknown.
        ChatInputStanding::SetAside => "set_aside",
        // Also after a refused resend: the earlier attempt may still have arrived.
        ChatInputStanding::AwaitsDecision => "uncertain",
        // Back in the queue; the row stays so the attempt is not hidden.
        ChatInputStanding::Queued => "not_sent",
    })
}

/// Why the resend the person asked for did not happen, when the message awaits their
/// decision because of that.
fn refused_resend(message: &ChatMessage) -> Option<String> {
    let last = message.attempts.last()?;
    matches!(
        last.delivery,
        ChatDelivery::NotDelivered | ChatDelivery::Rejected
    )
    .then(|| last.detail.clone().unwrap_or("no reason given".to_owned()))
}

impl Tracker {
    pub fn from_items(items: &[ChatItem]) -> Self {
        let mut tracker = Self::default();
        for item in items {
            tracker.note(item);
        }
        tracker
    }

    pub fn note(&mut self, item: &ChatItem) {
        match item {
            ChatItem::Turn(turn) => {
                if self
                    .last_turn
                    .as_ref()
                    .is_none_or(|last| last.position <= turn.position)
                {
                    self.last_turn = Some(turn.clone());
                }
                self.updated_at = Some(turn.ended_at.clone().unwrap_or(turn.started_at.clone()));
            }
            ChatItem::Message(message) if message.role == ChatRole::User => {
                if message.awaits_decision() {
                    self.uncertain = Some((message.id.clone(), refused_resend(message)));
                    self.uncertain_text = Some(message.text.clone());
                } else if self.uncertain.as_ref().map(|(id, _)| id) == Some(&message.id) {
                    self.uncertain = None;
                    self.uncertain_text = None;
                }
                self.updated_at = Some(message.created_at.clone());
            }
            ChatItem::Message(message) => {
                if message.complete {
                    self.open.remove(&message.id);
                } else {
                    self.open.insert(message.id.clone(), message.clone());
                }
                // A change from an earlier turn is not what the Chat last did.
                if message.turn_id != self.last_change_turn {
                    self.last_change = None;
                }
                self.last_response = Some(message.text.clone());
            }
            ChatItem::Interaction(interaction) => {
                let was = self.pending.contains_key(&interaction.id);
                if interaction.state == ChatInteractionState::Pending {
                    self.pending
                        .insert(interaction.id.clone(), interaction.clone());
                } else {
                    self.pending.remove(&interaction.id);
                }
                // The step it asks about reads differently while it waits.
                let waits = interaction.state == ChatInteractionState::Pending;
                if let Some(tool_id) = &interaction.tool_id
                    && was != waits
                {
                    self.refold.push(tool_id.clone());
                }
                if let (Some(tool_id), Some(decision)) =
                    (&interaction.tool_id, approval_outcome(interaction))
                    && self.decided.get(tool_id) != Some(&decision)
                {
                    self.decided.insert(tool_id.clone(), decision);
                    self.refold.push(tool_id.clone());
                }
            }
            ChatItem::Tool(tool) if chat_reports::is_report(tool) => {
                // Only the latest turn can still be running.
                self.reports.retain(|_, kept| kept.turn_id == tool.turn_id);
                self.reports.insert(tool.id.clone(), tool.clone());
            }
            ChatItem::Tool(tool) => {
                if let Some(changes) = agent_changes(tool)
                    && let Some(change) = changes.last()
                {
                    self.last_change = Some(change.clone());
                    self.last_change_turn = Some(tool.turn_id.clone());
                }
                // Only the latest turn's calls can still be asked about.
                self.turn_tools
                    .retain(|_, kept| kept.turn_id == tool.turn_id);
                self.turn_tools.insert(tool.id.clone(), tool.clone());
            }
            ChatItem::Session(_) | ChatItem::Notice(_) => {}
        }
    }

    /// Streamed text arrived for a message that has no record yet. Returns whether the
    /// view has not been shown this message before.
    pub fn streaming(&mut self, message_id: &str, turn_id: &str) -> bool {
        if self.open.contains_key(message_id) {
            return false;
        }
        let message = ChatMessage {
            id: message_id.to_owned(),
            position: 0,
            role: ChatRole::Assistant,
            text: String::new(),
            attachments: Vec::new(),
            complete: false,
            turn_id: Some(turn_id.to_owned()),
            queued: false,
            editing: false,
            attempts: Vec::new(),
            created_at: String::new(),
        };
        self.open.insert(message_id.to_owned(), message);
        true
    }

    /// The last turn, when it failed with a kind of problem the person can act on.
    pub fn failed_turn(&self) -> Option<&ChatTurn> {
        self.last_turn.as_ref().filter(|turn| {
            matches!(
                TurnEnding::of(turn),
                Some(TurnEnding::Failed { kind, .. }) if kind != ProblemKind::Other
            )
        })
    }

    /// What the person decided about the approval asked for each tool call.
    pub fn decided(&self) -> &Decided {
        &self.decided
    }

    /// Whether an approval or a question asked from this tool call still waits for
    /// the person: the dock's card says it, so the call has no running row.
    pub fn awaits(&self, tool_id: &str) -> bool {
        self.pending
            .values()
            .any(|request| request.tool_id.as_deref() == Some(tool_id))
    }

    /// A tool call of the latest turn, by its id.
    fn tool(&self, id: &str) -> Option<&ChatTool> {
        self.turn_tools.get(id)
    }

    /// Tool calls to show again because an approval asked for them was decided since
    /// the last call. Calls of an earlier turn are not kept and read right on a resync.
    pub fn refolded(&mut self) -> Vec<ChatItem> {
        std::mem::take(&mut self.refold)
            .iter()
            .filter_map(|id| self.turn_tools.get(id).cloned().map(ChatItem::Tool))
            .collect()
    }

    /// Records whose display depends on the turn or on live state, to show again after
    /// either changed.
    pub fn dependents(&self) -> Vec<ChatItem> {
        let open = self.open.values().cloned().map(ChatItem::Message);
        let pending = self.pending.values().cloned().map(ChatItem::Interaction);
        let reports = self.reports.values().cloned().map(ChatItem::Tool);
        open.chain(pending).chain(reports).collect()
    }
}

fn approval_option(decision: ApprovalDecision) -> RequestOption {
    let (id, label) = match decision {
        ApprovalDecision::Allow => ("allow", "Allow once"),
        ApprovalDecision::AllowForSession => ("allow_for_session", "Allow for this session"),
        ApprovalDecision::Deny => ("deny", "Deny"),
    };
    RequestOption {
        id: id.to_owned(),
        label: label.to_owned(),
        warning: None,
    }
}

/// The decision an approval option id stands for.
pub fn approval_decision(option_id: &str) -> Option<ApprovalDecision> {
    [
        ApprovalDecision::Allow,
        ApprovalDecision::AllowForSession,
        ApprovalDecision::Deny,
    ]
    .into_iter()
    .find(|decision| approval_option(*decision).id == option_id)
}

/// What the person decided about the tool calls approvals were asked for, by tool id.
pub type Decided = HashMap<String, String>;

/// An answered approval's decision as its step's tooltip says it.
fn approval_outcome(interaction: &ChatInteraction) -> Option<String> {
    if interaction.kind != ChatInteractionKind::Approval
        || interaction.state != ChatInteractionState::Answered
    {
        return None;
    }
    Some(
        match interaction.response.as_deref()? {
            "allow" => "You allowed this once",
            "allow for session" => "You allowed this for this session",
            "deny" => "You declined this",
            choice if let Some(label) = choice.strip_prefix("choice:") => {
                return Some(format!("You chose {label}"));
            }
            _ => "You answered this",
        }
        .to_owned(),
    )
}

/// What an approval asks to do, from the step it was asked for: the title's verb, and
/// what follows it inline (the command, or the files).
fn asked_to(steps: &[Step]) -> Option<(&'static str, &'static str, String)> {
    if let [step] = steps {
        return asked_to_step(step);
    }
    let subjects = steps
        .iter()
        .filter_map(asked_to_step)
        .map(|(_, asked, subject)| {
            let action = asked.strip_prefix("asked to ").unwrap_or("");
            [action, subject.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>();
    (!subjects.is_empty()).then(|| ("wants to", "asked to", subjects.join(", ")))
}

fn asked_to_step(step: &Step) -> Option<(&'static str, &'static str, String)> {
    if step.ticketd.is_some() {
        // The view says the sentences after "wants to"; the subject keeps the command.
        return Some(("wants to", "asked to", step.target.clone()));
    }
    if step.variant == Some("plan") {
        return Some((
            "wants to write its plan",
            "asked to write its plan",
            String::new(),
        ));
    }
    let targets = || {
        let included = step
            .targets
            .iter()
            .map(|target| target.text.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        match &step.omitted_files {
            Some(omitted) => {
                let summary = match omitted.count {
                    Some(count) => {
                        let files = step.targets.len() as u64 + u64::from(count);
                        let file_word = if files == 1 { "file" } else { "files" };
                        let paths = if count == 1 { "path" } else { "paths" };
                        format!("{files} {file_word} ({count} {paths} omitted)")
                    }
                    None => "files (partial list)".to_owned(),
                };
                if included.is_empty() {
                    summary
                } else {
                    format!("{summary} including {included}")
                }
            }
            None => included,
        }
    };
    match step.kind {
        "read" if step.variant == Some("list") => {
            Some(("wants to list", "asked to list", targets()))
        }
        "read" => Some(("wants to read", "asked to read", targets())),
        "search" => Some(("wants to search for", "asked to search for", targets())),
        "run" => Some(("wants to run", "asked to run", step.target.clone())),
        "create" if step.omitted_files.is_some() => {
            Some(("wants to create", "asked to create", targets()))
        }
        "edit" | "create" => Some(("wants to edit", "asked to edit", targets())),
        "delete" => Some(("wants to delete", "asked to delete", targets())),
        "web" if step.variant == Some("fetch") => {
            Some(("wants to open", "asked to open", targets()))
        }
        "web" => Some((
            "wants to search the web for",
            "asked to search the web for",
            targets(),
        )),
        _ => None,
    }
}

/// A stored request as the dock or a receipt shows it. `step` is the step an approval
/// was asked for, when the harness named it: its title then says what it would do,
/// worded so the subject follows inline ("Claude Code wants to run `npm install`").
fn request(interaction: &ChatInteraction, live: &ChatLive, harness: &str, steps: &[Step]) -> Item {
    let asked = live
        .interactions
        .iter()
        .find(|request| request.interaction_id == interaction.id)
        .filter(|_| interaction.state == ChatInteractionState::Pending);
    let approval = interaction.kind == ChatInteractionKind::Approval;
    let state = match (interaction.state, asked) {
        (ChatInteractionState::Answered, _) => "answered",
        (ChatInteractionState::Pending, Some(_)) => "pending",
        // A stored request with no live one behind it can no longer be answered.
        (ChatInteractionState::Pending | ChatInteractionState::Expired, _) => "expired",
    };
    let pending = state == "pending";
    let prompt = Some(interaction.prompt.clone()).filter(|prompt| !prompt.is_empty());
    let step = steps.first();
    let plan = steps.len() == 1 && step.is_some_and(|step| step.variant == Some("plan"));
    let (title, subject) = match (approval, asked_to(steps)) {
        // Its plan's path is the harness's own; the title says what it is.
        (true, Some((wants, asked, _))) if plan => (
            format!("{harness} {}", if pending { wants } else { asked }),
            None,
        ),
        (true, Some((wants, asked, what))) => (
            format!("{harness} {}", if pending { wants } else { asked }),
            Some(what).filter(|what| !what.is_empty()).or(prompt),
        ),
        (true, None) if prompt.is_some() => (
            format!(
                "{harness} {}",
                if pending {
                    "wants approval for"
                } else {
                    "asked for approval for"
                }
            ),
            prompt,
        ),
        (true, None) if pending => (format!("{harness} is asking for approval"), None),
        (true, None) => (format!("{harness} asked for approval"), None),
        (false, _) if pending => (format!("{harness} is asking you"), prompt),
        (false, _) => (format!("{harness} asked you"), prompt),
    };
    let (options, free_text) = match asked.map(|request| &request.kind) {
        Some(InteractionKind::Approval { decisions, .. }) => (
            decisions.iter().copied().map(approval_option).collect(),
            false,
        ),
        Some(InteractionKind::NativeApproval { options, .. }) => (
            options
                .iter()
                .map(|option| RequestOption {
                    id: option.id.clone(),
                    label: option.label.clone(),
                    warning: option.warning.clone(),
                })
                .collect(),
            false,
        ),
        Some(InteractionKind::Question { questions }) => match questions.as_slice() {
            [question] if !question.options.is_empty() => (
                question
                    .options
                    .iter()
                    .map(|option| RequestOption {
                        id: option.clone(),
                        label: option.clone(),
                        warning: None,
                    })
                    .collect(),
                false,
            ),
            // ponytail: several questions in one request are answered with one text,
            // given as the answer to each. Give each question its own answer when the
            // Chat screens can show more than one.
            _ => (Vec::new(), true),
        },
        None => (Vec::new(), false),
    };
    let response = interaction
        .response
        .as_deref()
        .filter(|_| state == "answered");
    let outcome = approval_outcome(interaction).or_else(|| {
        response
            .filter(|_| !approval)
            .map(|answer| format!("You answered: {answer}"))
    });
    Item::Request {
        id: interaction.id.clone(),
        turn_id: Some(interaction.turn_id.clone()),
        request: if approval { "approval" } else { "question" },
        title,
        reason: interaction
            .reason
            .clone()
            .filter(|reason| !reason.is_empty()),
        options,
        free_text,
        state,
        outcome,
        answer: response.filter(|_| !approval).map(str::to_owned),
        folded: approval && state == "answered",
        at: interaction.asked_at.clone().unwrap_or_default(),
        resolved_at: interaction.resolved_at.clone(),
        command: step
            .filter(|_| approval)
            .and_then(|step| step.command.clone())
            .filter(|command| Some(command) != subject.as_ref()),
        ticketd: step
            .filter(|_| approval)
            .and_then(|step| step.ticketd.clone()),
        subject,
    }
}

/// The changes kept by the host's record of what the agent changed, if `tool` is one.
fn agent_changes(tool: &ChatTool) -> Option<Vec<ChatAgentChange>> {
    (tool.name == AGENT_CHANGES_RECORD_NAME)
        .then(|| serde_json::from_str(&tool.input).ok())
        .flatten()
}

/// A path as a step row shows it: relative to the Chat's folder, and with `~` for the
/// home folder outside it.
fn shown_path(path: &str, folder: &str, home: Option<&str>) -> String {
    let within = |base: &str| {
        let base = base.trim_end_matches(['/', '\\']);
        let rest = path.strip_prefix(base)?;
        if rest.is_empty() {
            return Some("");
        }
        rest.strip_prefix(['/', '\\'])
    };
    if !folder.is_empty()
        && let Some(rest) = within(folder)
    {
        return if rest.is_empty() {
            ".".to_owned()
        } else {
            rest.to_owned()
        };
    }
    match home.filter(|home| !home.is_empty()).and_then(within) {
        Some("") => "~".to_owned(),
        Some(rest) => format!("~/{rest}"),
        None => path.to_owned(),
    }
}

fn target(text: &str) -> StepTarget {
    StepTarget {
        text: text.to_owned(),
        lines: None,
        scope: None,
    }
}

/// A web page as `host/path`.
fn page(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    rest.trim_end_matches('/').to_owned()
}

fn word_tool_step(action: ToolStep, base: &Step, folder: &str, home: Option<&str>) -> Step {
    let mut step = base.clone();
    step.omitted_files = action.omitted_files.map(|omitted| OmittedFilesView {
        count: match omitted {
            OmittedFiles::Count(count) => Some(count.get()),
            OmittedFiles::Unknown => None,
        },
    });
    let path = |text: &str| shown_path(text, folder, home);
    let paths = |paths: Vec<String>| paths.into_iter().map(|file| target(&path(&file))).collect();
    let create = matches!(action.action, StepAction::Create { .. });
    step.targets = match action.action {
        StepAction::Read(ReadAction::Files(files)) => {
            step.kind = "read";
            files
                .into_iter()
                .map(|file| StepTarget {
                    text: path(&file.path),
                    lines: file.lines.map(|(first, last)| [first, last]),
                    scope: None,
                })
                .collect()
        }
        StepAction::Read(ReadAction::List(files)) => {
            step.kind = "read";
            step.variant = Some("list");
            paths(files)
        }
        StepAction::Search {
            targets,
            no_matches,
        } => {
            step.kind = "search";
            step.no_matches = no_matches;
            targets
                .into_iter()
                .map(|search| StepTarget {
                    text: search.query,
                    lines: None,
                    scope: search.scope.map(|scope| match scope {
                        SearchScope::Path(scope) => path(&scope),
                        SearchScope::Pattern(scope) => scope,
                    }),
                })
                .collect()
        }
        StepAction::Edit { targets, counts } | StepAction::Create { targets, counts } => {
            step.kind = if create { "create" } else { "edit" };
            step.added_lines = counts.added;
            step.removed_lines = counts.removed;
            match targets {
                FileTargets::Paths(files) => paths(files),
                FileTargets::Plan { .. } => {
                    step.variant = Some("plan");
                    Vec::new()
                }
            }
        }
        StepAction::Delete {
            paths: files,
            counts,
        } => {
            step.kind = "delete";
            step.added_lines = counts.added;
            step.removed_lines = counts.removed;
            paths(files)
        }
        StepAction::Run(run) => {
            step.kind = "run";
            match run {
                RunAction::Command => Vec::new(),
                RunAction::CommandUnavailable {
                    working_directory,
                    exit_code,
                } => {
                    step.folder = working_directory
                        .map(|folder| path(&folder))
                        .filter(|folder| folder != ".");
                    step.exit_code = exit_code;
                    Vec::new()
                }
                RunAction::Script { interpreters } => {
                    step.variant = Some("script");
                    interpreters.iter().map(|program| target(program)).collect()
                }
            }
        }
        StepAction::Web(web) => {
            step.kind = "web";
            match web {
                WebAction::Search { query } => vec![target(&query)],
                WebAction::Fetch { url } => {
                    step.variant = Some("fetch");
                    vec![target(&page(&url))]
                }
            }
        }
        StepAction::Other { name } => {
            let targets = vec![target(&name)];
            step.target = name;
            targets
        }
    };
    if let Some(command) = action.command {
        step.target = match &command.ticketd_calls {
            Some(calls) => calls
                .iter()
                .map(|args| step_kind::ticketd_command(args))
                .collect::<Vec<_>>()
                .join("; "),
            None => step_kind::shown_command(&command.display),
        };
        step.ticketd = command
            .ticketd_calls
            .as_deref()
            .and_then(chat_ticketd::sentences);
        step.command = Some(command.display);
        step.folder = command
            .working_directory
            .map(|folder| path(&folder))
            .filter(|folder| folder != ".");
        step.exit_code = command.exit_code;
        step.duration_ms = command.duration_ms;
        step.timed_out = command.timed_out;
    }
    if let Some(outcome) = action.outcome {
        step.state = match outcome {
            StepOutcomeOverride::Completed => "done",
            StepOutcomeOverride::Declined => "declined",
        };
    }
    step
}

/// Word each action the harness reader found in the tool evidence.
fn steps(tool: &ChatTool, harness: &str, chat: &Chat, home: Option<&str>) -> Vec<Step> {
    let cut = tool
        .output_truncated
        .then_some("earlier output cut, ticketd keeps the last 1 MiB".to_owned());
    let base = Step {
        kind: "other",
        variant: None,
        target: tool.name.clone(),
        targets: vec![target(&tool.name)],
        omitted_files: None,
        command: None,
        exit_code: None,
        folder: None,
        timed_out: false,
        duration_ms: None,
        no_matches: false,
        state: "done",
        result: cut,
        output: tool.output.as_deref().map(output_tail).map(str::to_owned),
        full_output: tool
            .output
            .as_ref()
            .filter(|output| output_tail(output).len() < output.len())
            .map(|output| FullOutput {
                tool_id: tool.id.clone(),
                bytes: output.len(),
            }),
        started_at: tool.started_at.clone(),
        added_lines: None,
        removed_lines: None,
        decision: None,
        ticketd: None,
        awaiting: false,
    };
    if tool.name == CONTEXT_RECORD_NAME {
        return vec![Step {
            target: format!("ticketd gave {harness} this Chat's context"),
            targets: Vec::new(),
            result: None,
            output: Some(tool.input.clone()),
            full_output: None,
            ..base
        }];
    }
    let active = chat.active_turn.as_ref().map(|turn| &turn.id) == Some(&tool.turn_id);
    let state = match tool.state {
        ChatToolState::Running if active => "running",
        ChatToolState::Running => "not_finished",
        ChatToolState::Completed => "done",
        ChatToolState::Failed => "failed",
        ChatToolState::Declined => "declined",
        ChatToolState::Unknown => "unknown",
    };
    let base = Step { state, ..base };
    let folder = chat.execution_folder.as_str();
    read_tool_steps(
        &chat.harness,
        ToolEvidence {
            name: &tool.name,
            input: &tool.input,
            output: tool.output.as_deref(),
            state: tool.state,
            working_directory: folder,
        },
    )
    .into_iter()
    .map(|action| word_tool_step(action, &base, folder, home))
    .collect()
}

/// One history record as a transcript item, or `None` when it has no row of its own.
pub fn item(
    record: &ChatItem,
    chat: &Chat,
    live: &ChatLive,
    fresh: Option<FreshHistory>,
    tracker: &Tracker,
) -> Option<Item> {
    let harness = harness_name(&chat.harness);
    Some(match record {
        ChatItem::Session(session) => {
            if session.origin != ChatSessionOrigin::FreshSession {
                return None;
            }
            let history = fresh
                .filter(|fresh| session.position > fresh.after)
                .map(|fresh| (fresh.history, fresh.count))
                .or_else(|| {
                    (history_recovery(&chat.harness) == Some(HistoryRecovery::StartFresh))
                        .then_some(("none", 0))
                });
            match history {
                Some((history, count)) => Item::Session {
                    id: session.id.clone(),
                    at: session.started_at.clone(),
                    history,
                    count,
                },
                None => Item::Marker {
                    id: session.id.clone(),
                    at: session.started_at.clone(),
                    reason: "note",
                    message: Some(format!("Continued in a fresh {harness} session.")),
                    turn_id: None,
                },
            }
        }
        ChatItem::Message(message) if message.editing && message.queued => return None,
        ChatItem::Message(message) if message.role == ChatRole::User => Item::User {
            id: message.id.clone(),
            at: message.created_at.clone(),
            text: message.text.clone(),
            attachments: message.attachments.clone(),
            delivery: delivery(message, live)?,
            turn_id: message
                .attempts
                .iter()
                .rev()
                .find_map(|attempt| attempt.turn_id.clone())
                .or(message.turn_id.clone()),
            steer: message
                .attempts
                .last()
                .is_some_and(|attempt| attempt.intent == ChatSubmissionIntent::Steer),
        },
        ChatItem::Message(message) => {
            let active = chat.active_turn.as_ref().map(|turn| &turn.id);
            Item::Response {
                id: message.id.clone(),
                at: message.created_at.clone(),
                text: message.text.clone(),
                state: if message.complete {
                    "complete"
                } else if active.is_some() && active == message.turn_id.as_ref() {
                    "streaming"
                } else {
                    "partial"
                },
                turn_id: message.turn_id.clone(),
            }
        }
        ChatItem::Turn(turn) => {
            let (reason, message) = match TurnEnding::of(turn)? {
                TurnEnding::Completed => return None,
                // ticketd stopped it, whether or not the harness reported the turn.
                TurnEnding::StoppedByTicketd(stop) => (stop.marker(), None),
                TurnEnding::StoppedByPerson => ("stopped", turn.detail.clone()),
                TurnEnding::Failed { message, .. } => (
                    "failed",
                    Some(message.unwrap_or("The turn failed.".to_owned())),
                ),
                TurnEnding::ContactLost(reason) => (
                    "note",
                    Some(format!(
                        "Contact with {harness} was lost ({}). Whether this turn finished is unknown.",
                        reason.as_deref().unwrap_or("no detail")
                    )),
                ),
            };
            Item::Marker {
                id: turn.id.clone(),
                at: turn.ended_at.clone().unwrap_or(turn.started_at.clone()),
                reason,
                message,
                turn_id: Some(turn.id.clone()),
            }
        }
        ChatItem::Tool(tool)
            if let Some(report) = chat_reports::report(tool, chat, live, &|path| {
                shown_path(path, &chat.execution_folder, home_folder().as_deref())
            }) =>
        {
            report_item(tool, report)
        }
        ChatItem::Tool(tool) if let Some(changes) = agent_changes(tool) => Item::Records {
            id: tool.id.clone(),
            at: String::new(),
            gone: vec![None; changes.len()],
            changes,
            turn_id: Some(tool.turn_id.clone()),
        },
        ChatItem::Tool(tool) => Item::Steps {
            id: tool.id.clone(),
            at: String::new(),
            steps: steps(tool, harness, chat, home_folder().as_deref())
                .into_iter()
                .map(|step| Step {
                    decision: tracker.decided().get(&tool.id).cloned(),
                    awaiting: tracker.awaits(&tool.id),
                    ..step
                })
                .collect(),
            turn_id: Some(tool.turn_id.clone()),
        },
        ChatItem::Interaction(interaction) => {
            let rows = interaction
                .tool_id
                .as_deref()
                .and_then(|id| tracker.tool(id))
                .map(|tool| steps(tool, harness, chat, home_folder().as_deref()))
                .unwrap_or_default();
            request(interaction, live, harness, &rows)
        }
        ChatItem::Notice(notice) => Item::Marker {
            id: notice.id.clone(),
            at: notice.created_at.clone(),
            // What the harness said folds with its turn; ticketd's own notes stay.
            reason: if notice.from_harness {
                "warning"
            } else {
                "note"
            },
            message: Some(notice.text.clone()),
            turn_id: None,
        },
    })
}

fn report_item(tool: &ChatTool, report: Report) -> Item {
    let (id, at) = (tool.id.clone(), String::new());
    match report {
        Report::Reasoning {
            turn_id,
            state,
            record,
        } => Item::Reasoning {
            id,
            at,
            turn_id,
            state,
            started_at: record.started_at,
            ended_at: record.ended_at,
            text: record.text,
            heading: record.heading,
        },
        Report::Plan {
            turn_id,
            state,
            steps,
            explanation,
        } => Item::Plan {
            id,
            at,
            turn_id,
            state,
            steps,
            explanation,
        },
        Report::Files {
            turn_id,
            state,
            files,
        } => Item::Files {
            id,
            at,
            turn_id,
            state,
            files,
        },
    }
}

/// When a turn started and ended, and how; the view folds the turn under one row
/// that says this.
fn turn_item(turn: &ChatTurn) -> Item {
    Item::Turn {
        id: format!("turn:{}", turn.id),
        at: turn.started_at.clone(),
        turn_id: turn.id.clone(),
        started_at: turn.started_at.clone(),
        ended_at: turn.ended_at.clone(),
        outcome: match TurnEnding::of(turn) {
            None => "active",
            Some(TurnEnding::Completed) => "completed",
            Some(TurnEnding::StoppedByPerson) => "stopped",
            Some(TurnEnding::Failed { .. }) => "failed",
            Some(TurnEnding::StoppedByTicketd(_)) => "quit",
            Some(TurnEnding::ContactLost(_)) => "lost",
        },
    }
}

/// Every transcript item one history record gives: a turn gives its timing and, when
/// it ended other than by completing, its end marker.
pub fn items(
    record: &ChatItem,
    chat: &Chat,
    live: &ChatLive,
    fresh: Option<FreshHistory>,
    tracker: &Tracker,
) -> Vec<Item> {
    let timing = match record {
        ChatItem::Turn(turn) => Some(turn_item(turn)),
        _ => None,
    };
    timing
        .into_iter()
        .chain(item(record, chat, live, fresh, tracker))
        .collect()
}

fn home_folder() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

pub fn retention(chat: &Chat) -> &'static str {
    if chat.trashed {
        "trashed"
    } else if chat.archived {
        "archived"
    } else {
        "active"
    }
}

fn activity(live: &ChatLive, tracker: &Tracker) -> &'static str {
    match live.activity {
        Activity::Working => "working",
        Activity::WaitingForYou => "waiting",
        // Saved history is not evidence of running work: with no live state the last
        // turn's recorded outcome is all there is to show.
        Activity::Idle => match tracker.last_turn.as_ref().map(|turn| turn.state) {
            Some(ChatTurnState::Failed) => "failed",
            Some(ChatTurnState::Interrupted | ChatTurnState::Unknown) => "interrupted",
            Some(ChatTurnState::Active | ChatTurnState::Completed) | None => "idle",
        },
    }
}

/// A harness failure in the Chat screens' terms, with what the person needs to recover.
fn harness_problem(harness: &str, kind: ProblemKind, message: Option<String>) -> Problem {
    let setup = matches!(
        kind,
        ProblemKind::NotInstalled
            | ProblemKind::IncompatibleVersion
            | ProblemKind::PermissionUnavailable
    );
    let sign_in = if kind == ProblemKind::LoginRequired {
        descriptor(harness)
    } else {
        None
    };
    // The notice already gives the sign-in instructions from the problem kind
    // and command. Keep any message that adds something to those instructions.
    let message =
        message.filter(|text| sign_in.is_none_or(|descriptor| text != descriptor.sign_in_guidance));
    let help = help_url(harness).filter(|_| setup);
    Problem {
        kind: kind.into(),
        message,
        history_recovery: if kind == ProblemKind::NativeHistoryUnavailable {
            history_recovery(harness)
        } else {
            None
        },
        command: sign_in.map(|descriptor| descriptor.sign_in_command.to_owned()),
        help_url: help.map(str::to_owned),
        ..Problem::default()
    }
}

impl Problem {
    /// What New Chat tells about a harness that is not ready, from what its probe found.
    pub fn for_harness(name: &str, kind: ChatProblemKind, found: &HarnessFound) -> Self {
        Self {
            kind,
            message: found.message.clone(),
            command: found.command.clone(),
            help_url: found.help_url.clone(),
            path: found.path.clone(),
            ..Self::default()
        }
        .worded(name)
    }

    /// Fills in what follows from the kind: the title in the harness's name, and
    /// whether it stops the next message.
    fn worded(self, harness: &str) -> Self {
        Self {
            title: self.kind.title(harness, self.past),
            blocks_send: !self.past && self.kind.blocks_send(),
            ..self
        }
    }
}

/// What a harness probe found, as its notice needs it.
pub struct HarnessFound {
    pub message: Option<String>,
    pub command: Option<String>,
    pub help_url: Option<String>,
    pub path: Option<String>,
}

/// The Chat's problem, worded for its harness.
fn problem(
    chat: &Chat,
    live: &ChatLive,
    tracker: &Tracker,
    around: &Surroundings,
) -> Option<Problem> {
    found_problem(chat, live, tracker, around)
        .map(|problem| problem.worded(harness_name(&chat.harness)))
}

fn found_problem(
    chat: &Chat,
    live: &ChatLive,
    tracker: &Tracker,
    around: &Surroundings,
) -> Option<Problem> {
    let failed = |message: String| Problem {
        kind: ChatProblemKind::Failed,
        message: Some(message),
        ..Problem::default()
    };
    if around.folder_missing {
        return Some(Problem {
            kind: ChatProblemKind::FolderMissing,
            path: Some(chat.execution_folder.clone()),
            ..Problem::default()
        });
    }
    if let Some((message_id, refused)) = &tracker.uncertain {
        return Some(Problem {
            kind: ChatProblemKind::UncertainDelivery,
            message: refused.as_ref().map(|reason| {
                format!(
                    "You asked to send it again and {} did not accept that: {reason}.",
                    harness_name(&chat.harness)
                )
            }),
            message_id: Some(message_id.clone()),
            ..Problem::default()
        });
    }
    let unconfirmed = |message: Option<String>| Problem {
        kind: ChatProblemKind::StopUnconfirmed,
        message,
        ..Problem::default()
    };
    match &live.problem {
        Some(ChatProblem::OpenFailed { problem, .. }) => Some(harness_problem(
            &chat.harness,
            problem.kind,
            Some(problem.message.clone()),
        )),
        // The turn it cut short already carries the loss as its marker; say it once.
        Some(ChatProblem::RuntimeLost { detail })
            if tracker.last_turn.as_ref().is_some_and(|turn| {
                matches!(
                    TurnEnding::of(turn),
                    Some(TurnEnding::ContactLost(Some(lost))) if lost == *detail
                )
            }) =>
        {
            None
        }
        Some(ChatProblem::RuntimeLost { detail }) => Some(failed(format!(
            "Contact with the harness was lost: {detail}"
        ))),
        // Whether the message is in the queue depends on what the person decided
        // about it, so it is said only when the queue holds something.
        Some(ChatProblem::DispatchRefused { detail }) if around.queue.is_empty() => Some(failed(
            format!("The harness did not accept the message: {detail}"),
        )),
        Some(ChatProblem::DispatchRefused { detail }) => Some(failed(format!(
            "The harness did not accept the message, so it is back in the queue: {detail}"
        ))),
        Some(ChatProblem::StorageFailed { detail }) => Some(failed(format!(
            "Chat storage failed, so no new work is accepted: {detail}"
        ))),
        Some(ChatProblem::CleanupUnconfirmed { reason }) => Some(unconfirmed(Some(reason.clone()))),
        None if live.stop == Some(StopState::Unconfirmed) => Some(unconfirmed(None)),
        // Nothing is live: why the last turn stopped is what there is to say. It is
        // told as past, because nothing shows the condition still holds.
        None => {
            let turn = tracker.failed_turn().filter(|turn| {
                live.activity == Activity::Idle && around.checked_turn.as_ref() != Some(&turn.id)
            })?;
            let TurnEnding::Failed {
                kind,
                message,
                resets_at,
            } = TurnEnding::of(turn)?
            else {
                return None;
            };
            Some(Problem {
                resets_at: resets_at.filter(|_| kind == ProblemKind::QuotaExhausted),
                past: true,
                ..harness_problem(&chat.harness, kind, message)
            })
        }
    }
}

/// What is known about the settings in effect: ticketd sets none, and shows what the
/// harness itself reported for this Chat's latest session.
fn permissions(name: &str, reported: Option<&str>) -> String {
    let own =
        format!("Uses your own {name} settings and permissions. ticketd changes none of them.");
    let Some(reported) = reported else {
        return format!("{own} {name} has not reported the settings in effect.");
    };
    let fields: Vec<String> = match serde_json::from_str(reported) {
        Ok(serde_json::Value::Object(fields)) => fields
            .iter()
            .filter_map(|(key, value)| {
                let value = match value {
                    serde_json::Value::String(text) => text.clone(),
                    serde_json::Value::Number(_) | serde_json::Value::Bool(_) => value.to_string(),
                    _ => return None,
                };
                Some(format!("{} {value}", key.replace('_', " ")))
            })
            .collect(),
        _ => vec![reported.chars().take(300).collect()],
    };
    format!("{own} {name} reported: {}.", fields.join(", "))
}

fn last_component(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_owned()
}

pub(crate) fn title(chat: &Chat) -> String {
    chat.title.clone().unwrap_or("Untitled Chat".to_owned())
}

pub fn chat_state(
    chat: &Chat,
    live: &ChatLive,
    tracker: &Tracker,
    around: &Surroundings,
) -> ChatState {
    let name = harness_name(&chat.harness);
    let activity = activity(live, tracker);
    let opening = opening(activity, live.opening);
    let problem = problem(chat, live, tracker, around);
    let has_composer = !chat.trashed
        && !problem
            .as_ref()
            .is_some_and(|problem| !problem.past && problem.kind.removes_composer());
    ChatState {
        id: chat.id.clone(),
        title: title(chat),
        harness: HarnessRef {
            id: chat.harness.clone(),
            name: name.to_owned(),
            permissions: Some(permissions(name, chat.effective_settings.as_deref())),
        },
        folder: Folder {
            path: chat.execution_folder.clone(),
            name: last_component(&chat.execution_folder),
            managed: chat.folder_managed,
            missing: around.folder_missing,
            shared_with: around.shared_with.clone(),
            branch: around.branch.as_ref().map(BranchView::from),
            project: around.project.clone(),
        },
        retention: retention(chat),
        activity,
        problem,
        doing: chat
            .active_turn
            .as_ref()
            .filter(|_| activity == "working" && opening.is_none())
            .map(|turn| Doing {
                label: "Working".to_owned(),
                since: turn.started_at.clone(),
            }),
        opening,
        catching_up: false,
        steering: Steering {
            available: live.steering.is_some(),
            images_refused: live.steering_images_refused,
            // Said beside Steer, so the person knows what it does before choosing it.
            effect: live.steering.map(|steering| {
                if steering.interrupts_tools {
                    format!("May interrupt tools {name} is running")
                } else {
                    "Joins after the current tool finishes".to_owned()
                }
            }),
        },
        stopping: matches!(
            live.stop,
            Some(StopState::Requested | StopState::Acknowledged)
        ),
        links: around.links.clone(),
        queue: around.queue.clone(),
        queue_paused: chat.queue_paused
            || around
                .queue
                .iter()
                .find(|message| !message.editing)
                .is_some_and(|message| live.prepared_queue_edits.contains(&message.id)),
        context: chat_reports::context(live),
        settings: chat_reports::settings(live),
        unseen: chat.marked_unread
            || tracker
                .last_turn
                .as_ref()
                .is_some_and(|turn| chat.unseen(turn)),
        muted: chat.muted,
        has_composer,
        read_through: chat.read_through.clone(),
        trashed_links: around.trashed_links.clone(),
        commands: live
            .commands
            .iter()
            .map(|command| CommandView {
                name: command.name.clone(),
                description: command.description.clone(),
            })
            .collect(),
    }
}

/// Work the host reports as waiting on a session that has not started a turn yet is
/// that session opening, until the turn runs. A fresh session for an existing Chat
/// starts one, like a new Chat.
fn opening(activity: &str, origin: Option<ChatSessionOrigin>) -> Option<&'static str> {
    match origin.filter(|_| activity == "working")? {
        ChatSessionOrigin::NativeResume => Some("resume"),
        ChatSessionOrigin::New | ChatSessionOrigin::FreshSession => Some("start"),
    }
}

pub fn summary(chat: &Chat, live: &ChatLive, tracker: &Tracker, around: &Surroundings) -> Summary {
    let activity = activity(live, tracker);
    let problem = problem(chat, live, tracker, around);
    let harness = harness_name(&chat.harness);
    let status = attention::status(&Facts {
        chat,
        harness,
        live,
        last_turn: tracker.last_turn.as_ref(),
        uncertain: tracker.uncertain_text.as_deref(),
        problem: problem.as_ref().map(|problem| (problem.kind, problem.past)),
        failure: problem
            .as_ref()
            .filter(|problem| problem.kind == ChatProblemKind::Failed)
            .and_then(|problem| problem.message.as_deref()),
        activity,
        opening: opening(activity, live.opening).is_some(),
        last_change: tracker.last_change.as_ref(),
        last_response: tracker.last_response.as_deref(),
    });
    let interruption = match tracker.last_turn.as_ref().and_then(TurnEnding::of) {
        _ if activity != "interrupted" => None,
        _ if live.stop == Some(StopState::Unconfirmed) => Some("unconfirmed"),
        Some(TurnEnding::StoppedByPerson) => Some("stopped"),
        Some(TurnEnding::StoppedByTicketd(_)) => Some("quit"),
        _ => None,
    };
    Summary {
        id: chat.id.clone(),
        title: title(chat),
        harness_id: chat.harness.clone(),
        harness_name: harness.to_owned(),
        // A managed folder is named by an id and never shared: the row leaves it out.
        folder_name: (!around.folder_missing && !chat.folder_managed)
            .then(|| last_component(&chat.execution_folder)),
        first_ticket: around.links.iter().find_map(|link| match link {
            LinkedRecord::Ticket { reference, .. } => Some(reference.clone()),
            LinkedRecord::Document { .. } | LinkedRecord::Project { .. } => None,
        }),
        project: around.project.clone(),
        tickets: around
            .links
            .iter()
            .filter_map(|link| match link {
                LinkedRecord::Ticket {
                    reference, status, ..
                } => Some(TicketRef {
                    reference: reference.clone(),
                    status: status.clone(),
                }),
                LinkedRecord::Document { .. } | LinkedRecord::Project { .. } => None,
            })
            .collect(),
        retention: retention(chat),
        activity,
        needs_you: status.rank.needs_you(),
        problem_past: problem.as_ref().is_some_and(|problem| problem.past),
        problem: problem.map(|problem| problem.kind),
        interruption,
        last_change: tracker.last_change.clone(),
        preview: tracker
            .last_response
            .as_ref()
            .map(|text| text.chars().take(140).collect()),
        updated_at: tracker
            .updated_at
            .clone()
            .unwrap_or(chat.created_at.clone()),
        status,
        muted: chat.muted,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Chat, ChatInteraction, ChatInteractionKind, ChatInteractionState, ChatLive, ChatTool,
        ChatToolState, ChatTurn, ChatTurnState, Item, Queued, Step, Surroundings, Tracker,
        chat_state, items, opening, request, steps,
    };
    use serde_json::json;
    use ticketd_chat_host::{STOPPED_BY_TICKETD, StopReason, TurnEnding};
    use ticketd_core::ChatItem;
    use ticketd_core::ChatSessionOrigin;

    /// U16, U21: work before the session's first turn runs is the session opening.
    #[test]
    fn work_before_the_sessions_first_turn_is_the_session_opening() {
        let resume = Some(ChatSessionOrigin::NativeResume);
        assert_eq!(opening("working", resume), Some("resume"));
        assert_eq!(
            opening("working", Some(ChatSessionOrigin::New)),
            Some("start")
        );
        assert_eq!(
            opening("working", Some(ChatSessionOrigin::FreshSession)),
            Some("start")
        );
        assert_eq!(opening("working", None), None);
        assert_eq!(opening("waiting", resume), None);
    }

    fn chat(active_turn: Option<&str>) -> Chat {
        Chat {
            id: "c1".to_owned(),
            title: None,
            harness: "codex".to_owned(),
            execution_folder: "/work/limiter".to_owned(),
            folder_managed: false,
            archived: false,
            trashed: false,
            queue_paused: false,
            effective_settings: None,
            native_session_id: None,
            links: Vec::new(),
            active_turn: active_turn.map(|id| ChatTurn {
                id: id.to_owned(),
                position: 0,
                native_turn_id: None,
                state: ChatTurnState::Active,
                detail: None,
                problem: None,
                problem_resets_at: None,
                ending: None,
                started_at: String::new(),
                ended_at: None,
            }),
            seen_through: 0,
            read_through: None,
            marked_unread: false,
            muted: false,
            created_at: String::new(),
        }
    }

    #[test]
    fn a_prepared_edit_pauses_the_queue_after_held_messages() {
        let queued = |id: &str, editing| Queued {
            id: id.to_owned(),
            text: String::new(),
            editing,
            attachments: Vec::new(),
            refused_steer: None,
        };
        let around = Surroundings {
            queue: vec![queued("held", true), queued("prepared", false)],
            ..Surroundings::default()
        };
        let mut live = ChatLive::idle();
        let paused =
            |live| chat_state(&chat(None), live, &Tracker::default(), &around).queue_paused;
        assert!(!paused(&live));
        live.prepared_queue_edits.insert("prepared".to_owned());
        assert!(paused(&live));
    }

    fn tool(name: &str, input: &str, state: ChatToolState, output: Option<&str>) -> ChatTool {
        ChatTool {
            id: "t".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            name: name.to_owned(),
            input: input.to_owned(),
            state,
            output: output.map(str::to_owned),
            output_truncated: false,
            started_at: None,
        }
    }

    fn one(tool: &ChatTool) -> Step {
        let mut rows = steps(tool, "Codex", &chat(None), Some("/Users/me"));
        assert_eq!(rows.len(), 1, "one row");
        rows.remove(0)
    }

    fn claude_chat(active_turn: Option<&str>) -> Chat {
        Chat {
            harness: "claude-code".to_owned(),
            ..chat(active_turn)
        }
    }

    fn claude_step(tool: &ChatTool) -> Step {
        let mut rows = steps(tool, "Claude Code", &claude_chat(None), Some("/Users/me"));
        assert_eq!(rows.len(), 1, "one row");
        rows.remove(0)
    }

    fn codex_command(command: &str, status: &str, exit_code: i64) -> ChatTool {
        let input = json!({
            "type": "commandExecution",
            "command": format!("/bin/zsh -lc '{command}'"),
            "cwd": "/work/limiter",
            "status": status,
            "exitCode": exit_code,
            "durationMs": 600_000,
        });
        let state = match status {
            "completed" => ChatToolState::Completed,
            "declined" => ChatToolState::Declined,
            _ => ChatToolState::Failed,
        };
        tool(
            &format!("/bin/zsh -lc '{command}'"),
            &input.to_string(),
            state,
            None,
        )
    }

    fn texts(step: &Step) -> Vec<&str> {
        step.targets
            .iter()
            .map(|target| target.text.as_str())
            .collect()
    }

    #[test]
    fn a_codex_command_reads_as_what_it_did() {
        let read = one(&codex_command(
            "sed -n 1,120p /work/limiter/src/auth/limiter.ts",
            "completed",
            0,
        ));
        assert_eq!(
            (read.kind, texts(&read)),
            ("read", vec!["src/auth/limiter.ts"])
        );
        assert_eq!(read.targets[0].lines, Some([1, 120]));

        let ran = one(&codex_command(
            "cd apps/desktop && npm run typecheck",
            "completed",
            0,
        ));
        assert_eq!(
            (ran.kind, ran.command.as_deref(), ran.folder.as_deref()),
            ("run", Some("npm run typecheck"), Some("apps/desktop"))
        );
    }

    /// grep's exit 1 is a search that found nothing, not a failure.
    #[test]
    fn a_search_that_found_nothing_succeeded() {
        let search = one(&codex_command("rg -n legacyLimiter src", "failed", 1));
        assert_eq!(
            (search.kind, search.state, search.no_matches),
            ("search", "done", true)
        );
        let failed = one(&codex_command("npm run test:limiter", "failed", 1));
        assert_eq!(
            (failed.kind, failed.state, failed.exit_code),
            ("run", "failed", Some(1))
        );
        let timed_out = one(&codex_command("npm run test:e2e", "failed", 124));
        assert!(timed_out.timed_out);
    }

    #[test]
    fn a_declined_step_is_declined_also_in_records_stored_as_failed() {
        let declined = one(&codex_command("rm -rf node_modules", "declined", 0));
        assert_eq!((declined.kind, declined.state), ("delete", "declined"));
        let mut older = codex_command("rm -rf node_modules", "declined", 0);
        older.state = ChatToolState::Failed;
        assert_eq!(one(&older).state, "declined");
    }

    /// U4: a command that is waiting for approval, or was refused, is not told as run.
    #[test]
    fn a_step_says_whether_it_finished() {
        let states = [
            ChatToolState::Running,
            ChatToolState::Completed,
            ChatToolState::Failed,
            ChatToolState::Declined,
            ChatToolState::Unknown,
        ]
        .map(|state| {
            let tool = tool(
                "touch hello.txt",
                r#"{"type":"commandExecution"}"#,
                state,
                None,
            );
            steps(&tool, "Codex", &chat(Some("turn")), None)[0].state
        });
        assert_eq!(states, ["running", "done", "failed", "declined", "unknown"]);
        // The turn ended before the step did.
        let left = tool(
            "npm run dev",
            r#"{"type":"commandExecution"}"#,
            ChatToolState::Running,
            None,
        );
        assert_eq!(one(&left).state, "not_finished");
    }

    #[test]
    fn a_codex_file_change_has_one_row_per_kind_of_change() {
        let input = json!({"type": "fileChange", "status": "completed", "changes": [
            {"path": "/work/limiter/src/a.ts", "kind": {"type": "update"}},
            {"path": "/work/limiter/src/b.ts", "kind": {"type": "add"}},
            {"path": "/work/limiter/src/c.ts", "kind": {"type": "update"}},
            {"path": "/work/limiter/old.ts", "kind": {"type": "delete"}},
        ]});
        let change = tool("Edit a", &input.to_string(), ChatToolState::Completed, None);
        let rows = steps(&change, "Codex", &chat(None), None);
        assert_eq!(
            super::asked_to(&rows).map(|(_, _, subject)| subject),
            Some("edit src/a.ts, src/c.ts, edit src/b.ts, delete old.ts".to_owned())
        );
        let rows: Vec<_> = rows.iter().map(|row| (row.kind, texts(row))).collect();
        assert_eq!(
            rows,
            [
                ("edit", vec!["src/a.ts", "src/c.ts"]),
                ("create", vec!["src/b.ts"]),
                ("delete", vec!["old.ts"]),
            ]
        );
    }

    #[test]
    fn a_patch_approval_discloses_omitted_targets_including_unlisted_deletions() {
        use ticketd_chat_host::{ApprovalDecision, InteractionKind, LiveInteraction};

        let input = json!({"type": "fileChange", "changes": [
            {"path": "/work/limiter/src/a.ts", "kind": {"type": "update"},
             "ticketd_lines": {"added": 4, "removed": 1}},
        ], "ticketd_omitted_files": {"update": 2, "delete": 1}});
        let patch = ChatItem::Tool(tool(
            "Edit /work/limiter/src/a.ts, /work/limiter/b.ts, /work/limiter/c.ts, /work/limiter/old.ts",
            &input.to_string(),
            ChatToolState::Running,
            None,
        ));
        let approval = ChatItem::Interaction(ChatInteraction {
            id: "ask".to_owned(),
            position: 1,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Approval,
            native_request_id: None,
            prompt: "Apply file changes".to_owned(),
            reason: None,
            state: ChatInteractionState::Pending,
            response: None,
            tool_id: Some("t".to_owned()),
            asked_at: None,
            resolved_at: None,
        });
        let mut live = ChatLive::idle();
        live.interactions.push(LiveInteraction {
            interaction_id: "ask".to_owned(),
            kind: InteractionKind::approval(
                None,
                None,
                "Apply file changes",
                vec![ApprovalDecision::Deny],
            ),
        });
        let tracker = Tracker::from_items(&[patch, approval.clone()]);
        let Some(Item::Request { title, subject, .. }) =
            super::item(&approval, &chat(Some("turn")), &live, None, &tracker)
        else {
            panic!("expected an approval card");
        };
        assert_eq!(title, "Codex wants to");
        assert_eq!(
            subject.as_deref(),
            Some(
                "edit 3 files (2 paths omitted) including src/a.ts, delete 1 file (1 path omitted)"
            )
        );
    }

    #[test]
    fn a_file_step_carries_the_lines_its_harness_said_it_added_and_removed() {
        let input = json!({"type": "fileChange", "status": "completed", "changes": [
            {"path": "/work/limiter/src/a.ts", "kind": {"type": "update"},
             "diff": "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same"},
            {"path": "/work/limiter/src/c.ts", "kind": {"type": "update"},
             "diff": "@@ -1 +1 @@\n-x\n+y"},
            {"path": "/work/limiter/src/b.ts", "kind": {"type": "add"}, "diff": "one\ntwo"},
            {"path": "/work/limiter/src/d.ts", "kind": {"type": "update"}},
        ]});
        let change = tool("Edit a", &input.to_string(), ChatToolState::Completed, None);
        let counts: Vec<_> = steps(&change, "Codex", &chat(None), None)
            .iter()
            .map(|row| (row.kind, row.added_lines, row.removed_lines))
            .collect();
        // One change without a diff leaves its row's count untold.
        assert_eq!(counts, [("edit", None, None), ("create", Some(2), Some(0))]);

        // Claude Code says it in the tool's result, which the adapter keeps.
        let edit = claude_step(&tool(
            "Edit",
            r#"{"file_path":"/work/limiter/src/a.ts","ticketd_lines":{"added":48,"removed":6}}"#,
            ChatToolState::Completed,
            None,
        ));
        assert_eq!((edit.added_lines, edit.removed_lines), (Some(48), Some(6)));
        let untold = claude_step(&tool(
            "Edit",
            r#"{"file_path":"/work/limiter/src/a.ts"}"#,
            ChatToolState::Completed,
            None,
        ));
        assert_eq!(untold.added_lines, None);
    }

    #[test]
    fn claude_code_tools_read_as_their_kind() {
        let done = ChatToolState::Completed;
        let row = |name: &str, input: &str, output: Option<&str>| {
            let step = claude_step(&tool(name, input, done, output));
            (step.kind, step.variant, texts(&step).join(", "))
        };
        let ran = claude_step(&tool(
            "PowerShell",
            r#"{"command":"ticketd --version"}"#,
            done,
            None,
        ));
        assert_eq!(
            (ran.kind, ran.command.as_deref()),
            ("run", Some("ticketd --version"))
        );
        assert_eq!(
            row("Bash", r#"{"command":"rm -f /Users/me/notes.txt"}"#, None),
            ("delete", None, "~/notes.txt".to_owned())
        );
        let read = claude_step(&tool(
            "Read",
            r#"{"file_path":"/work/limiter/src/a.ts","offset":40,"limit":51}"#,
            done,
            None,
        ));
        assert_eq!((read.kind, texts(&read)), ("read", vec!["src/a.ts"]));
        assert_eq!(read.targets[0].lines, Some([40, 90]));
        let grep = claude_step(&tool(
            "Grep",
            r#"{"pattern":"RateLimiter","path":"/work/limiter/src"}"#,
            done,
            Some("No files found"),
        ));
        assert_eq!(
            (grep.kind, grep.targets[0].scope.as_deref(), grep.no_matches),
            ("search", Some("src"), true)
        );
        let input = r#"{"file_path":"/work/limiter/src/new.ts","content":"x"}"#;
        assert_eq!(
            row(
                "Write",
                input,
                Some("File created successfully at: /work/limiter/src/new.ts")
            ),
            ("create", None, "src/new.ts".to_owned())
        );
        assert_eq!(
            row(
                "Write",
                input,
                Some("The file /work/limiter/src/new.ts has been updated successfully.")
            ),
            ("edit", None, "src/new.ts".to_owned())
        );
        assert_eq!(
            row(
                "WebFetch",
                r#"{"url":"https://docs.rs/serde/latest/?q=1"}"#,
                None
            ),
            ("web", Some("fetch"), "docs.rs/serde/latest".to_owned())
        );
        assert_eq!(
            row("WebSearch", r#"{"query":"tauri updater"}"#, None),
            ("web", None, "tauri updater".to_owned())
        );
        assert_eq!(
            row("mcp__linear__get_issue", "{}", None),
            ("other", None, "mcp__linear__get_issue".to_owned())
        );
    }

    /// LIVE-4: a ticketd call reads as a sentence; the exact command stays behind it,
    /// and so does the approval asked for it. Claude Code's plan file is "its plan".
    #[test]
    fn ticketd_calls_and_plan_files_read_as_what_they_do() {
        let bin = "/Users/me/ticketd/target/debug/ticketd";
        let script = format!("T={bin}\n$T change T-MP4 --status \"In progress\"");
        let input = json!({ "command": script }).to_string();
        let step = claude_step(&tool("Bash", &input, ChatToolState::Completed, None));
        assert_eq!(step.kind, "run");
        assert_eq!(
            step.target,
            r#"ticketd change T-MP4 --status "In progress""#
        );
        assert_eq!(step.command.as_deref(), Some(script.as_str()));
        let calls = step.ticketd.clone().expect("told as a sentence");
        assert_eq!(calls[0].verb, "set");

        // An unknown call says its words, without the path.
        let input = json!({ "command": format!("{bin} skills install --harness codex") });
        let other = claude_step(&tool(
            "Bash",
            &input.to_string(),
            ChatToolState::Completed,
            None,
        ));
        assert_eq!(other.ticketd.expect("said")[0].verb, "run");
        assert_eq!(other.target, "ticketd skills install --harness codex");

        // LIVE2-1: a compound of ticketd calls is one sentence per call.
        let compound = format!(
            "T={bin}; $T skills get chat | head -80; echo ----; $T show T-MP3 2>&1 || $T --help"
        );
        let input = json!({ "command": compound });
        let calls = claude_step(&tool(
            "Bash",
            &input.to_string(),
            ChatToolState::Completed,
            None,
        ))
        .ticketd
        .expect("said");
        assert_eq!(
            calls.iter().map(|call| call.verb).collect::<Vec<_>>(),
            ["read", "read", "read"]
        );

        // Anything else stays the command, with ticketd's path left out of it.
        let input = json!({ "command": format!("{bin} export | sh") });
        let raw = claude_step(&tool(
            "Bash",
            &input.to_string(),
            ChatToolState::Completed,
            None,
        ));
        assert_eq!(raw.ticketd, None);
        assert_eq!(raw.target, "ticketd export | sh");
        assert_eq!(
            raw.command.as_deref(),
            Some(format!("{bin} export | sh").as_str())
        );
        let (_, _, subject) = super::asked_to(&[raw]).expect("asked");
        assert_eq!(subject, "ticketd export | sh");

        let interaction = ChatInteraction {
            id: "ask".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Approval,
            native_request_id: None,
            prompt: script.clone(),
            reason: None,
            state: ChatInteractionState::Answered,
            response: Some("allow".to_owned()),
            tool_id: Some("t".to_owned()),
            asked_at: Some("2026-11-13T10:00:00Z".to_owned()),
            resolved_at: Some("2026-11-13T10:02:00Z".to_owned()),
        };
        let Item::Request {
            title,
            subject,
            command,
            ticketd,
            at,
            resolved_at,
            ..
        } = request(
            &interaction,
            &ChatLive::idle(),
            "Claude Code",
            std::slice::from_ref(&step),
        )
        else {
            panic!("a request");
        };
        assert_eq!(title, "Claude Code asked to");
        assert_eq!(subject.as_deref(), Some(step.target.as_str()));
        assert_eq!(command.as_deref(), Some(script.as_str()));
        assert!(ticketd.is_some());
        assert_eq!(at, "2026-11-13T10:00:00Z");
        assert_eq!(resolved_at.as_deref(), Some("2026-11-13T10:02:00Z"));

        let plan = json!({ "file_path": "/Users/me/.claude/plans/quiet-otter.md" });
        let wrote = claude_step(&tool(
            "Write",
            &plan.to_string(),
            ChatToolState::Completed,
            None,
        ));
        assert_eq!(wrote.variant, Some("plan"));
        assert!(wrote.targets.is_empty());
    }

    /// U4: the card shows what would run apart from why the harness asks.
    #[test]
    fn an_approval_shows_its_command_apart_from_its_reason() {
        let interaction = ChatInteraction {
            id: "ask-1".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Approval,
            native_request_id: Some("0".to_owned()),
            prompt: "touch hello.txt".to_owned(),
            reason: Some("Allow creating hello.txt?".to_owned()),
            state: ChatInteractionState::Answered,
            response: Some("deny".to_owned()),
            tool_id: None,
            asked_at: None,
            resolved_at: None,
        };
        let Item::Request {
            subject, reason, ..
        } = request(&interaction, &ChatLive::idle(), "Codex", &[])
        else {
            panic!("an interaction is a request");
        };
        assert_eq!(subject.as_deref(), Some("touch hello.txt"));
        assert_eq!(reason.as_deref(), Some("Allow creating hello.txt?"));

        // Asked for a step, the title says what the step would do, subject inline.
        let title = |step: &Step| match request(
            &interaction,
            &ChatLive::idle(),
            "Codex",
            std::slice::from_ref(step),
        ) {
            Item::Request { title, subject, .. } => (title, subject),
            other => panic!("a request, got {other:?}"),
        };
        let run = one(&codex_command(
            "npm install @pagerduty/pdjs",
            "inProgress",
            0,
        ));
        assert_eq!(
            title(&run),
            (
                "Codex asked to run".to_owned(),
                Some("npm install @pagerduty/pdjs".to_owned())
            )
        );
        let edit = one(&tool("Edit src/a.ts", "", ChatToolState::Running, None));
        assert_eq!(
            title(&edit),
            (
                "Codex asked to edit".to_owned(),
                Some("src/a.ts".to_owned())
            )
        );
        let read = one(&codex_command("cat src/a.ts", "inProgress", 0));
        assert_eq!(
            title(&read),
            (
                "Codex asked to read".to_owned(),
                Some("src/a.ts".to_owned())
            )
        );
    }

    #[test]
    fn a_saved_claude_edit_uses_the_same_path_in_history_and_approval() {
        use super::{Tracker, item};
        use ticketd_core::ChatItem;

        let chat = claude_chat(None);
        let record = ChatItem::Tool(tool(
            "Edit",
            r#"{"file_path":"/work/limiter/src/auth/config.ts"}"#,
            ChatToolState::Completed,
            Some("The file was updated successfully."),
        ));
        let approval = ChatItem::Interaction(ChatInteraction {
            id: "ask".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Approval,
            native_request_id: None,
            prompt: "Permission to change the configuration".to_owned(),
            reason: None,
            state: ChatInteractionState::Answered,
            response: Some("allow".to_owned()),
            tool_id: Some("t".to_owned()),
            asked_at: None,
            resolved_at: None,
        });
        let tracker = Tracker::from_items(&[record.clone(), approval.clone()]);
        let live = ChatLive::idle();
        let Some(Item::Steps { steps, .. }) = item(&record, &chat, &live, None, &tracker) else {
            panic!("a step");
        };
        assert_eq!(steps[0].kind, "edit");
        assert_eq!(texts(&steps[0]), ["src/auth/config.ts"]);
        assert_eq!(
            steps[0].output.as_deref(),
            Some("The file was updated successfully.")
        );
        let Some(Item::Request { title, subject, .. }) =
            item(&approval, &chat, &live, None, &tracker)
        else {
            panic!("an approval");
        };
        assert_eq!(title, "Claude Code asked to edit");
        assert_eq!(subject.as_deref(), Some("src/auth/config.ts"));
    }

    #[test]
    fn a_saved_antigravity_edit_shows_its_file_in_history_and_approval() {
        use super::{Tracker, item};

        let chat = Chat {
            harness: "antigravity".to_owned(),
            ..chat(None)
        };
        let approval = ChatItem::Interaction(ChatInteraction {
            id: "ask".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Approval,
            native_request_id: None,
            prompt: "Permission to edit the file".to_owned(),
            reason: None,
            state: ChatInteractionState::Answered,
            response: Some("allow".to_owned()),
            tool_id: Some("t".to_owned()),
            asked_at: None,
            resolved_at: None,
        });
        let live = ChatLive::idle();

        for (location, input_path, expected) in [
            (
                Some("/work/limiter/src/location.rs"),
                Some("/work/limiter/src/input.rs"),
                "src/location.rs",
            ),
            (None, Some("/work/limiter/src/input.rs"), "src/input.rs"),
            (None, None, "src/diff.rs"),
        ] {
            let mut evidence = json!({
                "toolCallId": "t",
                "title": "Edit file",
                "kind": "edit",
                "status": "completed",
                "content": [{
                    "type": "diff",
                    "path": "/work/limiter/src/diff.rs",
                    "oldText": "old\n",
                    "newText": "new\n"
                }]
            });
            if let Some(path) = location {
                evidence["locations"] = json!([{ "path": path }]);
            }
            if let Some(path) = input_path {
                evidence["rawInput"] = json!({ "TargetFile": path });
            }
            let record = ChatItem::Tool(tool(
                "Edit file",
                &evidence.to_string(),
                ChatToolState::Completed,
                None,
            ));
            let tracker = Tracker::from_items(&[record.clone(), approval.clone()]);
            let Some(Item::Steps { steps, .. }) = item(&record, &chat, &live, None, &tracker)
            else {
                panic!("a step");
            };
            let Some(Item::Request { title, subject, .. }) =
                item(&approval, &chat, &live, None, &tracker)
            else {
                panic!("an approval");
            };
            assert_eq!(steps[0].kind, "edit");
            assert_eq!(title, "Antigravity asked to edit");
            assert_eq!(
                (texts(&steps[0]), subject.as_deref()),
                (vec![expected], Some(expected))
            );
        }
    }

    #[test]
    fn a_saved_antigravity_move_shows_both_paths_in_history_and_approval() {
        use super::{Tracker, item};

        let chat = Chat {
            harness: "antigravity".to_owned(),
            ..chat(None)
        };
        let approval = ChatItem::Interaction(ChatInteraction {
            id: "ask".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Approval,
            native_request_id: None,
            prompt: "Permission to move files".to_owned(),
            reason: None,
            state: ChatInteractionState::Answered,
            response: Some("allow".to_owned()),
            tool_id: Some("t".to_owned()),
            asked_at: None,
            resolved_at: None,
        });
        let live = ChatLive::idle();
        let source = "/work/limiter/src/old.rs";
        let destination = "/work/limiter/src/new.rs";
        let both = ["src/old.rs", "src/new.rs"];

        for (raw_input, locations, expected) in [
            (
                json!({"SourcePath": source, "DestinationPath": destination}),
                json!([{"path": source}]),
                both.as_slice(),
            ),
            (
                json!({"SourcePath": source}),
                json!([{"path": destination}]),
                both.as_slice(),
            ),
            (
                json!({"DestinationPath": destination}),
                json!([]),
                &["src/new.rs"],
            ),
            (
                serde_json::Value::Null,
                json!([{"path": source}, {"path": destination}, {"path": source}]),
                both.as_slice(),
            ),
            (
                json!({"TargetFile": destination}),
                json!([]),
                &["src/new.rs"],
            ),
        ] {
            let evidence = json!({
                "toolCallId": "t", "title": "Move file", "kind": "move",
                "status": "completed", "rawInput": raw_input, "locations": locations,
            });
            let record = ChatItem::Tool(tool(
                "Move file",
                &evidence.to_string(),
                ChatToolState::Completed,
                None,
            ));
            let tracker = Tracker::from_items(&[record.clone(), approval.clone()]);
            let Some(Item::Steps { steps, .. }) = item(&record, &chat, &live, None, &tracker)
            else {
                panic!("a step");
            };
            let Some(Item::Request { title, subject, .. }) =
                item(&approval, &chat, &live, None, &tracker)
            else {
                panic!("an approval");
            };
            assert_eq!(steps[0].kind, "edit");
            assert_eq!(title, "Antigravity asked to edit");
            assert_eq!(texts(&steps[0]), expected, "{evidence}");
            assert_eq!(subject, Some(expected.join(", ")), "{evidence}");
        }
    }

    #[test]
    fn a_live_native_approval_serializes_each_choices_warning() {
        use super::item;
        use ticketd_chat_host::{ApprovalOption, InteractionKind, LiveInteraction};

        let reason = "Review the command.";
        let approval = ChatItem::Interaction(
            serde_json::from_value(json!({
                "id": "ask",
                "position": 1,
                "turn_id": "turn",
                "kind": "approval",
                "prompt": "Print a fixture",
                "reason": reason,
                "state": "pending"
            }))
            .unwrap(),
        );
        let chat = Chat {
            harness: "antigravity".to_owned(),
            ..chat(Some("turn"))
        };
        let mut live = ChatLive::idle();
        live.interactions.push(LiveInteraction {
            interaction_id: "ask".to_owned(),
            kind: InteractionKind::NativeApproval {
                description: "Print a fixture".to_owned(),
                reason: Some(reason.to_owned()),
                options: vec![
                    ApprovalOption {
                        id: "allow".to_owned(),
                        label: "Allow once".to_owned(),
                        warning: None,
                    },
                    ApprovalOption {
                        id: "provider-option-7".to_owned(),
                        label: "Allow always".to_owned(),
                        warning: Some("Adds a persistent rule.".to_owned()),
                    },
                ],
            },
        });
        let tracker = Tracker::from_items(std::slice::from_ref(&approval));
        let view = item(&approval, &chat, &live, None, &tracker).unwrap();
        let json = serde_json::to_value(view).unwrap();
        assert_eq!(json["reason"], reason);
        assert_eq!(
            json["options"],
            json!([
                {"id": "allow", "label": "Allow once"},
                {"id": "provider-option-7", "label": "Allow always", "warning": "Adds a persistent rule."},
            ])
        );
    }

    #[test]
    fn a_saved_antigravity_create_retains_its_target_after_preview_compaction() {
        use super::{Tracker, item};

        let chat = Chat {
            harness: "antigravity".to_owned(),
            ..chat(None)
        };
        let record = ChatItem::Tool(tool(
            "Write files",
            r#"{"toolCallId":"t","title":"","kind":"edit","status":"completed","rawInput":{"TargetFile":"/work/limiter/src/generated.rs","_ticketdAllFilesAdded":true,"_ticketdAddedLines":64}}"#,
            ChatToolState::Completed,
            None,
        ));
        let approval = ChatItem::Interaction(ChatInteraction {
            id: "ask".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Approval,
            native_request_id: None,
            prompt: "Permission to write files".to_owned(),
            reason: None,
            state: ChatInteractionState::Answered,
            response: Some("allow".to_owned()),
            tool_id: Some("t".to_owned()),
            asked_at: None,
            resolved_at: None,
        });
        let tracker = Tracker::from_items(&[record.clone(), approval.clone()]);
        let live = ChatLive::idle();
        let Some(Item::Steps { steps, .. }) = item(&record, &chat, &live, None, &tracker) else {
            panic!("a step");
        };
        let Some(Item::Request { subject, .. }) = item(&approval, &chat, &live, None, &tracker)
        else {
            panic!("an approval");
        };
        assert_eq!(steps[0].kind, "create");
        assert_eq!(steps[0].added_lines, Some(64));
        assert_eq!(texts(&steps[0]), ["src/generated.rs"]);
        assert_eq!(subject.as_deref(), Some("src/generated.rs"));
    }

    /// #367: a turn's records read by whether it still runs, and a stop that did not
    /// confirm leaves the plan unconfirmed rather than finished.
    #[test]
    fn turn_records_read_by_whether_their_turn_runs() {
        use super::{Tracker, item};
        use ticketd_chat_host::StopState;
        use ticketd_chat_host::records::{
            FILES_RECORD_NAME, PLAN_RECORD_NAME, REASONING_RECORD_NAME,
        };
        use ticketd_core::ChatItem;
        let record = |name: &str, input: &str, state| {
            ChatItem::Tool(ChatTool {
                id: name.to_owned(),
                turn_id: "turn-1".to_owned(),
                ..tool(name, input, state, None)
            })
        };
        let plan = record(
            PLAN_RECORD_NAME,
            r#"{"steps":[{"text":"Add it","status":"in_progress","active_label":null}],"explanation":null}"#,
            ChatToolState::Completed,
        );
        let mut stopping = ChatLive::idle();
        stopping.stop = Some(StopState::Unconfirmed);
        let state = |chat: &Chat, live: &_| match item(&plan, chat, live, None, &Tracker::default())
        {
            Some(Item::Plan { state, .. }) => state,
            other => panic!("a plan, got {other:?}"),
        };
        let running = ChatLive::idle();
        assert_eq!(state(&chat(Some("turn-1")), &running), "running");
        assert_eq!(state(&chat(Some("turn-1")), &stopping), "unconfirmed");
        assert_eq!(state(&chat(None), &running), "ended");

        let thinking = record(
            REASONING_RECORD_NAME,
            r#"{"running":true,"started_at":1,"ended_at":null,"text":null,"heading":null}"#,
            ChatToolState::Running,
        );
        let Some(Item::Reasoning { state, .. }) = item(
            &thinking,
            &chat(None),
            &ChatLive::idle(),
            None,
            &Tracker::default(),
        ) else {
            panic!("reasoning");
        };
        assert_eq!(state, "not_finished");

        let files = record(
            FILES_RECORD_NAME,
            r#"{"files":[{"path":"src/limiter.ts","kind":"added","from":null,"added_lines":48,"removed_lines":0,"confirmed":true}]}"#,
            ChatToolState::Completed,
        );
        let Some(Item::Files { files: shown, .. }) = item(
            &files,
            &chat(None),
            &ChatLive::idle(),
            None,
            &Tracker::default(),
        ) else {
            panic!("files");
        };
        assert_eq!(shown[0].path, "src/limiter.ts");
        assert_eq!(shown[0].open_path, "/work/limiter/src/limiter.ts");

        // When the turn ends, its records are shown again with the turn.
        let tracker = Tracker::from_items(&[plan.clone(), files]);
        assert_eq!(tracker.dependents().len(), 2);
    }

    #[test]
    fn an_answered_question_keeps_its_answer_for_the_receipt() {
        let interaction = ChatInteraction {
            id: "ask-2".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            kind: ChatInteractionKind::Question,
            native_request_id: None,
            prompt: "Fail open or closed?".to_owned(),
            reason: None,
            state: ChatInteractionState::Answered,
            response: Some("Fail open".to_owned()),
            tool_id: None,
            asked_at: None,
            resolved_at: None,
        };
        let Item::Request {
            answer, turn_id, ..
        } = request(&interaction, &ChatLive::idle(), "Codex", &[])
        else {
            panic!("an interaction is a request");
        };
        assert_eq!(answer.as_deref(), Some("Fail open"));
        assert_eq!(turn_id.as_deref(), Some("turn"));
    }

    #[test]
    fn a_turn_gives_its_timing_and_how_it_ended_beside_its_marker() {
        let turn = |state, detail: Option<&str>| {
            ChatItem::Turn(ChatTurn {
                id: "turn".to_owned(),
                position: 0,
                native_turn_id: None,
                state,
                detail: detail.map(str::to_owned),
                problem: None,
                problem_resets_at: None,
                ending: None,
                started_at: "2026-11-10T10:00:00Z".to_owned(),
                ended_at: Some("2026-11-10T10:00:40Z".to_owned()),
            })
        };
        let outcome = |record: &ChatItem| match items(
            record,
            &chat(None),
            &ChatLive::idle(),
            None,
            &Tracker::default(),
        )
        .as_slice()
        {
            [
                Item::Turn {
                    outcome,
                    started_at,
                    ended_at,
                    ..
                },
                rest @ ..,
            ] => {
                assert_eq!(started_at, "2026-11-10T10:00:00Z");
                assert_eq!(ended_at.as_deref(), Some("2026-11-10T10:00:40Z"));
                (*outcome, rest.len())
            }
            other => panic!("expected the turn's timing first: {other:?}"),
        };
        assert_eq!(
            outcome(&turn(ChatTurnState::Completed, None)),
            ("completed", 0)
        );
        assert_eq!(
            outcome(&turn(ChatTurnState::Interrupted, None)),
            ("stopped", 1)
        );
        assert_eq!(outcome(&turn(ChatTurnState::Failed, None)), ("failed", 1));
        assert_eq!(
            outcome(&turn(ChatTurnState::Unknown, Some(STOPPED_BY_TICKETD))),
            ("quit", 1)
        );
        assert_eq!(outcome(&turn(ChatTurnState::Unknown, None)), ("lost", 1));

        // L15: the end marker says why ticketd stopped the turn, whether the harness
        // reported it interrupted (Codex) or never did (Claude Code's closed bridge).
        let marker = |record: &ChatItem| match items(
            record,
            &chat(None),
            &ChatLive::idle(),
            None,
            &Tracker::default(),
        )
        .as_slice()
        {
            [Item::Turn { .. }, Item::Marker { reason, .. }] => *reason,
            other => panic!("expected the turn and its marker: {other:?}"),
        };
        let taken_over = Some(StopReason::TakenOver.detail());
        assert_eq!(
            marker(&turn(ChatTurnState::Unknown, taken_over)),
            "taken_over"
        );
        assert_eq!(
            marker(&turn(ChatTurnState::Interrupted, taken_over)),
            "taken_over"
        );
        assert_eq!(
            marker(&turn(
                ChatTurnState::Unknown,
                Some(StopReason::TurnedOff.detail())
            )),
            "turned_off"
        );
        assert_eq!(
            marker(&turn(ChatTurnState::Unknown, Some(STOPPED_BY_TICKETD))),
            "quit"
        );
        assert_eq!(marker(&turn(ChatTurnState::Interrupted, None)), "stopped");

        // A turn that records its ending is read from it, not from its wording; each
        // reason ticketd stops a Chat for has its own marker.
        let ended = |ending: &TurnEnding| {
            ChatItem::Turn(ChatTurn {
                id: "turn".to_owned(),
                position: 0,
                native_turn_id: None,
                state: ChatTurnState::Unknown,
                detail: ending.detail(),
                problem: None,
                problem_resets_at: None,
                ending: Some(ending.key()),
                started_at: "2026-11-10T10:00:00Z".to_owned(),
                ended_at: Some("2026-11-10T10:00:40Z".to_owned()),
            })
        };
        for (reason, expected) in [
            (StopReason::Restore, "restore"),
            (StopReason::Trashed, "trashed"),
            (StopReason::ExplicitResume, "explicit_resume"),
            (StopReason::StorageFailed, "storage_failed"),
        ] {
            let record = ended(&TurnEnding::StoppedByTicketd(reason));
            assert_eq!(marker(&record), expected);
            assert_eq!(outcome(&record), ("quit", 1));
        }
    }

    /// The marker names are a closed set shared with the frontend, which keeps its own
    /// copy (`client.ts` validates them, `Transcript.tsx` words each). A reason added on
    /// one side only would reach the transcript as an unreadable marker.
    #[test]
    fn the_frontends_markers_are_the_ones_ticketd_stops_a_turn_with() {
        let client = include_str!("../../src/features/chats/client.ts");
        let transcript = include_str!("../../src/features/chats/Transcript.tsx");
        let list = client
            .split("reason: z.enum([")
            .nth(1)
            .and_then(|rest| rest.split("]),").next())
            .expect("the marker reasons in client.ts");
        let frontend: std::collections::BTreeSet<&str> = list
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .flat_map(|line| line.split('"').skip(1).step_by(2))
            .collect();
        // Said by the harness or by the turn's ending, not by a reason ticketd stopped it.
        let others = ["stopped", "stop_unconfirmed", "failed", "note", "warning"];
        let ticketd: std::collections::BTreeSet<&str> = StopReason::ALL
            .iter()
            .map(|reason| reason.marker())
            .collect();
        let named: std::collections::BTreeSet<&str> = frontend
            .iter()
            .copied()
            .filter(|marker| !others.contains(marker))
            .collect();
        assert_eq!(named, ticketd, "client.ts and StopReason disagree");
        for marker in &ticketd {
            assert!(
                transcript.contains(&format!("case \"{marker}\":")),
                "Transcript.tsx has no wording for {marker}"
            );
        }
    }

    #[test]
    fn a_step_carries_its_output_s_last_lines_and_says_how_much_there_is() {
        let lines: Vec<String> = (1..=30).map(|n| format!("line {n}")).collect();
        let output = format!("{}\n", lines.join("\n"));
        let long = claude_step(&tool("Bash", "ls", ChatToolState::Completed, Some(&output)));
        let tail = format!("{}\n", lines[10..].join("\n"));
        assert_eq!(long.output.as_deref(), Some(tail.as_str()));
        assert_eq!(
            long.full_output,
            Some(super::FullOutput {
                tool_id: "t".to_owned(),
                bytes: output.len(),
            })
        );
        // One long line is cut too, on a character boundary.
        let wide = "é".repeat(5000);
        let cut = claude_step(&tool("Bash", "ls", ChatToolState::Completed, Some(&wide)));
        assert!(cut.output.as_deref().is_some_and(|tail| tail.len() <= 4096));
        // Output that fits is all there, with nothing more to read.
        let short = claude_step(&tool("Bash", "ls", ChatToolState::Completed, Some("ok\n")));
        assert_eq!(
            (short.output.as_deref(), short.full_output),
            (Some("ok\n"), None)
        );
    }

    #[test]
    fn a_running_step_keeps_when_the_host_recorded_it() {
        let mut running = tool(
            "Read",
            r#"{"file_path":"a.ts"}"#,
            ChatToolState::Running,
            None,
        );
        running.started_at = Some("2026-11-10T10:00:05Z".to_owned());
        let step = &steps(&running, "Claude Code", &claude_chat(Some("turn")), None)[0];
        assert_eq!(
            (step.state, step.started_at.as_deref()),
            ("running", Some("2026-11-10T10:00:05Z"))
        );
    }
}
