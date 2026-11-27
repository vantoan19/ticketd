//! What the Chat screens read: stored Chat records and the host's live state, worded and
//! shaped for display. Nothing here is a harness wire format, and nothing here decides
//! what runs; it only describes what the core and the host already know.
use std::collections::{HashMap, HashSet};

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
    ChatInteractionKind, ChatInteractionState, ChatItem, ChatMessage, ChatOwner, ChatRole,
    ChatSessionOrigin, ChatSubAgent, ChatSubAgentRun, ChatSubAgentState, ChatSubAgentStopper,
    ChatSubmissionIntent, ChatSuggestion, ChatTool, ChatToolState, ChatTurn, ChatTurnStarter,
    ChatTurnState, SuggestedTicket,
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
    /// The harness's own one-line account of a command, when it gave one. Absent from
    /// the record, so a view that predates it reads the same row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
        /// The sub-agent whose words these are; absent for the main agent's.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
    },
    Steps {
        id: String,
        at: String,
        steps: Vec<Step>,
        turn_id: Option<String>,
        /// The sub-agent whose Steps these are; absent for the main agent's.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
    },
    /// What the agent changed in ticketd during a turn.
    Records {
        id: String,
        at: String,
        changes: Vec<ChatAgentChange>,
        /// For each change, whether its record is now `trashed` or `deleted`; such a
        /// record is named, not linked. Filled in where the workspace can be read.
        gone: Vec<Option<&'static str>>,
        /// The turn's changes up to this call, netted by the Chat host's one rule
        /// (`attention::net_changes`): what the records row says. `changes` stay as
        /// they are, for the fold's step rows. The turn's last records item holds the
        /// whole turn's.
        net: Vec<ChatAgentChange>,
        /// For each net change, as `gone` is for `changes`.
        net_gone: Vec<Option<&'static str>>,
        turn_id: Option<String>,
        /// The sub-agent whose run's changes these are; absent for the main agent's.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
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
        /// The sub-agent whose run this is (its `turn_id` is then the run's); absent for
        /// the main agent's turns.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
        /// Who started the turn when the person did not; absent when their message did.
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<TurnOriginView>,
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
        /// The sub-agent it is about; absent for the main agent's.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
        /// For `sub_agents_stopped`: how many.
        #[serde(skip_serializing_if = "Option::is_none")]
        count: Option<i64>,
    },
    Session {
        id: String,
        at: String,
        history: &'static str,
        count: usize,
    },
    /// One run of a sub-agent, as the row in its parent's transcript says it. The row is
    /// the parent sub-agent's (absent for a direct sub-agent of the main agent), and in
    /// the parent's turn or run that it began in.
    SubAgent {
        id: String,
        at: String,
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
        /// The sub-agent this is a run of; its record is in `ChatState.sub_agents`.
        sub_agent: String,
        run: i64,
        status: &'static str,
        stopped_by: Option<&'static str>,
        stop_reason: Option<String>,
        started_at: String,
        ended_at: Option<String>,
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
        /// The sub-agent whose reasoning it is; absent for the main agent's.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
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
        /// The sub-agent whose run's files these are; absent for the main agent's.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
    },
}

/// Who started a turn the person did not: the Chat's harness resuming the main agent by
/// itself (`harness`) or ticketd waking it (`ticketd`), and the sub-agent whose finish it
/// follows when that is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TurnOriginView {
    pub by: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_agent: Option<String>,
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
    /// `false` while only sub-agents run: no turn does. Absent otherwise (a turn runs, or
    /// nothing does).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_running: Option<bool>,
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
    /// Every sub-agent of the Chat, oldest first: the one place a sub-agent's title, type,
    /// model, brief and latest status live. Rows and items name one by its `id`.
    pub sub_agents: Vec<SubAgentView>,
}

/// One sub-agent of a Chat, as the screens read it. Title, type and model are worded from
/// what the harness said, each time the view is built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SubAgentView {
    /// The harness's own ID for it, which is also what `owner` and `parent` name.
    pub id: String,
    pub native_id: String,
    /// The sub-agent that started it; absent when the main agent did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub title: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub model: String,
    /// Where its latest run stands: `running`, `completed`, `failed`, `stopped` or `lost`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_by: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub runs: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<BriefView>,
    pub capabilities: SubAgentCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BriefView {
    /// What it was asked; absent when the harness does not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `main_agent`, or `sub_agent` (the one `parent` names).
    pub source: &'static str,
}

/// What the Chat's harness lets ticketd show of its sub-agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SubAgentCapabilities {
    pub brief: bool,
    pub text: bool,
    pub end: bool,
    pub stop: bool,
    pub resume: bool,
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
    /// The first change the agent made in ticketd in its latest turn.
    pub first_change: Option<ChatAgentChange>,
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
    /// The first line of the Chat's first message, read only when its title could
    /// have been cut from it (`title_may_be_cut`).
    pub first_line: Option<String>,
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
    /// The latest note that the person stopped sub-agents with no turn running: where it
    /// stands in the history and how many.
    sub_agents_stopped: Option<(i64, i64)>,
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
    /// What the agent changed in ticketd in the latest turn that changed anything, by the
    /// record of each call (a call shown again replaces its own).
    changes: Vec<(String, Vec<ChatAgentChange>)>,
    /// The turn `changes` were made in.
    changes_turn: Option<String>,
    /// What the agent changed in each turn, by call and by the segment of the turn the
    /// call ran in, to net each segment's records row.
    turn_changes: HashMap<String, Vec<CallChanges>>,
    /// How many steers each turn has taken: a steer starts the turn's next segment.
    steers: HashMap<String, usize>,
    /// The steering messages already counted; one shown again is not a second steer.
    steer_messages: HashSet<String>,
    updated_at: Option<String>,
    /// Reasoning, plan and files records of the latest turn: how they read depends on
    /// whether it still runs.
    reports: HashMap<String, ChatTool>,
    /// Every sub-agent of the Chat with its runs, oldest first. A run row names its
    /// sub-agent here, and a Step finds the run it ran in by where it was recorded.
    sub_agents: Vec<ChatSubAgent>,
    /// The Steps sub-agents ran, by tool id: they are kept apart from the main agent's
    /// turn, and read again when their run ends.
    sub_agent_tools: HashMap<String, ChatTool>,
}

/// What one ticketd call changed, and the segment of its turn it ran in.
#[derive(Debug, Clone)]
struct CallChanges {
    tool_id: String,
    segment: usize,
    changes: Vec<ChatAgentChange>,
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

    /// A tracker for a snapshot: its items, and every sub-agent of the Chat, which an
    /// item names even when the record is older than the items read.
    pub fn from_snapshot(items: &[ChatItem], sub_agents: &[ChatSubAgent]) -> Self {
        let mut tracker = Self::from_items(items);
        tracker.sub_agents = sub_agents.to_vec();
        tracker
    }

    /// A sub-agent's record changed.
    pub fn note_sub_agent(&mut self, record: &ChatSubAgent) {
        match self
            .sub_agents
            .iter_mut()
            .find(|kept| kept.native_id == record.native_id)
        {
            Some(kept) => *kept = record.clone(),
            None => self.sub_agents.push(record.clone()),
        }
    }

    fn sub_agent(&self, native_id: &str) -> Option<&ChatSubAgent> {
        self.sub_agents
            .iter()
            .find(|record| record.native_id == native_id)
    }

    /// The run of `native_id` that a record at `position` of the Chat's history belongs
    /// to: the latest run that began before it, or the first.
    fn run_at(&self, native_id: &str, position: i64) -> Option<&ChatSubAgentRun> {
        let runs = &self.sub_agent(native_id)?.runs;
        runs.iter()
            .rev()
            .find(|run| run.position <= position)
            .or_else(|| runs.first())
    }

    /// Whether `tool` is the call that started a sub-agent, whose row tells it. A launch
    /// that is still running is taken for one before the harness announces the sub-agent
    /// (so no row for it is shown and then taken away); one that failed without ever
    /// starting one stays a Step, saying what went wrong.
    fn starts_sub_agent(&self, tool: &ChatTool, harness: &str) -> bool {
        self.sub_agents
            .iter()
            .any(|record| record.tool_id.as_deref() == Some(tool.id.as_str()))
            || (harness == "claude-code"
                && matches!(tool.name.as_str(), "Agent" | "Task")
                && tool.state == ChatToolState::Running)
    }

    /// What a sub-agent's run did to ticketd's records, netted by the Chat host's rule:
    /// the changes of every call of that run noted so far, with `changes` for `tool`.
    fn sub_agent_net(
        &self,
        tool: &ChatTool,
        changes: &[ChatAgentChange],
        native_id: &str,
        run: Option<&ChatSubAgentRun>,
    ) -> Vec<ChatAgentChange> {
        let mut calls: Vec<&ChatTool> = self
            .sub_agent_tools
            .values()
            .filter(|kept| {
                kept.id != tool.id
                    && kept.owner == owner_of(native_id)
                    && self
                        .run_at(native_id, kept.position)
                        .map(|run| run.id.as_str())
                        == run.map(|run| run.id.as_str())
            })
            .collect();
        calls.sort_by_key(|call| call.position);
        let mut all: Vec<ChatAgentChange> = calls
            .into_iter()
            .filter_map(agent_changes)
            .flatten()
            .collect();
        all.extend(changes.iter().cloned());
        attention::net_changes(&all)
    }

    /// The Steps a sub-agent ran, to read again when its run changes.
    pub fn sub_agent_steps(&self, native_id: &str) -> Vec<ChatItem> {
        let mut tools: Vec<&ChatTool> = self
            .sub_agent_tools
            .values()
            .filter(|tool| tool.owner == owner_of(native_id))
            .collect();
        tools.sort_by_key(|tool| tool.position);
        tools.into_iter().cloned().map(ChatItem::Tool).collect()
    }

    /// The Chat's sub-agents as the screens read them.
    pub fn sub_agent_views(&self, chat: &Chat, live: &ChatLive) -> Vec<SubAgentView> {
        self.sub_agents
            .iter()
            .filter_map(|record| sub_agent_view(record, chat, live))
            .collect()
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
                self.touch(Some(turn.started_at.as_str()));
                self.touch(turn.ended_at.as_deref());
            }
            ChatItem::Message(message) if message.role == ChatRole::User => {
                if message.awaits_decision() {
                    self.uncertain = Some((message.id.clone(), refused_resend(message)));
                    self.uncertain_text = Some(message.text.clone());
                } else if self.uncertain.as_ref().map(|(id, _)| id) == Some(&message.id) {
                    self.uncertain = None;
                    self.uncertain_text = None;
                }
                self.touch(Some(message.created_at.as_str()));
                // A steer starts the next segment of the turn it joined.
                if message
                    .attempts
                    .last()
                    .is_some_and(|attempt| attempt.intent == ChatSubmissionIntent::Steer)
                    && let Some(turn_id) = message
                        .attempts
                        .iter()
                        .rev()
                        .find_map(|attempt| attempt.turn_id.clone())
                        .or(message.turn_id.clone())
                        .or_else(|| self.last_turn.as_ref().map(|turn| turn.id.clone()))
                    && self.steer_messages.insert(message.id.clone())
                {
                    *self.steers.entry(turn_id).or_default() += 1;
                }
            }
            // A sub-agent's words are its own: they are not the Chat's last response, and
            // change nothing the turn's records say.
            ChatItem::Message(message) if message.owner != ChatOwner::Main => {
                self.touch(Some(message.created_at.as_str()));
            }
            ChatItem::Message(message) => {
                self.touch(Some(message.created_at.as_str()));
                if message.complete {
                    self.open.remove(&message.id);
                } else {
                    self.open.insert(message.id.clone(), message.clone());
                }
                // A change from an earlier turn is not what the Chat last did.
                if message.turn_id != self.changes_turn {
                    self.changes.clear();
                }
                self.last_response = Some(message.text.clone());
            }
            ChatItem::Interaction(interaction) => {
                self.touch(interaction.asked_at.as_deref());
                self.touch(interaction.resolved_at.as_deref());
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
            // A sub-agent's Step is its own: it is not one of the turn's calls, and it
            // changes nothing the turn's records, reports or approvals say.
            ChatItem::Tool(tool) if tool.owner != ChatOwner::Main => {
                self.touch(tool.started_at.as_deref());
                self.sub_agent_tools.insert(tool.id.clone(), tool.clone());
            }
            ChatItem::SubAgentRun(run) => {
                self.touch(Some(run.started_at.as_str()));
                self.touch(run.ended_at.as_deref());
                if let Some(record) = self
                    .sub_agents
                    .iter_mut()
                    .find(|record| record.native_id == run.sub_agent)
                {
                    match record.runs.iter_mut().find(|kept| kept.id == run.id) {
                        Some(kept) => *kept = run.clone(),
                        None => record.runs.push(run.clone()),
                    }
                }
            }
            ChatItem::Tool(tool) if chat_reports::is_report(tool) && tool.turn_id.is_some() => {
                self.touch(tool.started_at.as_deref());
                // Only the latest turn can still be running.
                self.reports.retain(|_, kept| kept.turn_id == tool.turn_id);
                self.reports.insert(tool.id.clone(), tool.clone());
            }
            ChatItem::Tool(tool) => {
                self.touch(tool.started_at.as_deref());
                // The latest turn's calls are tracked by turn; a Step no turn owns (a
                // sub-agent's) is shown as it stands and tracked by nothing.
                let Some(turn_id) = &tool.turn_id else {
                    return;
                };
                if let Some(changes) = agent_changes(tool)
                    && !changes.is_empty()
                {
                    if self.changes_turn.as_ref() != Some(turn_id) {
                        self.changes.clear();
                        self.changes_turn = Some(turn_id.clone());
                    }
                    let segment = self.steers.get(turn_id).copied().unwrap_or(0);
                    let calls = self.turn_changes.entry(turn_id.clone()).or_default();
                    match calls.iter_mut().find(|call| call.tool_id == tool.id) {
                        Some(call) => call.changes.clone_from(&changes),
                        None => calls.push(CallChanges {
                            tool_id: tool.id.clone(),
                            segment,
                            changes: changes.clone(),
                        }),
                    }
                    match self.changes.iter_mut().find(|(id, _)| *id == tool.id) {
                        Some((_, kept)) => *kept = changes,
                        None => self.changes.push((tool.id.clone(), changes)),
                    }
                }
                // Only the latest turn's calls can still be asked about.
                self.turn_tools
                    .retain(|_, kept| kept.turn_id == tool.turn_id);
                self.turn_tools.insert(tool.id.clone(), tool.clone());
            }
            ChatItem::Notice(notice) => {
                if let Some(count) = notice.sub_agents_stopped {
                    self.sub_agents_stopped = Some((notice.position, count));
                }
            }
            ChatItem::Session(_) => {}
        }
    }

    /// How many sub-agents the person stopped, while that is the Chat's last event: no
    /// turn has started since.
    pub fn stopped_sub_agents(&self) -> Option<i64> {
        let (position, count) = self.sub_agents_stopped?;
        self.last_turn
            .as_ref()
            .is_none_or(|turn| turn.position < position)
            .then_some(count)
    }

    /// What the latest turn did to ticketd's records, the first sentence of the records
    /// row the person sees last: the net (`attention::net_changes`) of the latest
    /// segment that changed anything, in order.
    pub fn first_change(&self) -> Option<ChatAgentChange> {
        let calls = self.turn_changes.get(self.changes_turn.as_ref()?)?;
        let segment_of = |tool_id: &str| {
            calls
                .iter()
                .find(|call| call.tool_id == tool_id)
                .map_or(0, |call| call.segment)
        };
        let latest = self.changes.iter().map(|(id, _)| segment_of(id)).max()?;
        let all: Vec<ChatAgentChange> = self
            .changes
            .iter()
            .filter(|(id, _)| segment_of(id) == latest)
            .flat_map(|(_, changes)| changes.iter().cloned())
            .collect();
        attention::net_changes(&all).into_iter().next()
    }

    /// What the segment of a turn `tool` ran in did to ticketd's records, netted by the
    /// Chat host's rule: what that segment's records row says. A steer starts a new
    /// segment, so the changes before it are not netted in again. `tool` counts
    /// whether or not it was noted yet.
    fn turn_net(&self, tool: &ChatTool, changes: &[ChatAgentChange]) -> Vec<ChatAgentChange> {
        let calls = tool
            .turn_id
            .as_ref()
            .and_then(|turn_id| self.turn_changes.get(turn_id));
        let noted = calls.and_then(|calls| calls.iter().find(|call| call.tool_id == tool.id));
        let segment = noted.map_or_else(
            || {
                tool.turn_id
                    .as_ref()
                    .and_then(|turn_id| self.steers.get(turn_id))
                    .copied()
                    .unwrap_or(0)
            },
            |call| call.segment,
        );
        let mut all: Vec<ChatAgentChange> = calls
            .into_iter()
            .flatten()
            .filter(|call| call.segment == segment)
            .flat_map(|call| {
                if call.tool_id == tool.id {
                    changes
                } else {
                    &call.changes
                }
                .iter()
                .cloned()
            })
            .collect();
        if noted.is_none() {
            all.extend(changes.iter().cloned());
        }
        attention::net_changes(&all)
    }

    /// How many files the latest turn changed, from the host's record of them.
    fn files_changed(&self) -> Option<usize> {
        let latest = self.last_turn.as_ref()?;
        self.reports
            .values()
            .filter(|tool| tool.turn_id.as_ref() == Some(&latest.id))
            .find_map(|tool| {
                ticketd_chat_host::records::read::<ticketd_chat_host::records::FilesRecord>(
                    &tool.name,
                    ticketd_chat_host::records::FILES_RECORD_NAME,
                    &tool.input,
                )
            })
            .map(|record| record.files.len())
    }

    /// The newest time any record of the Chat carries: a working row's time counts
    /// from here, so a long turn does not read as the day it started.
    fn touch(&mut self, at: Option<&str>) {
        if let Some(at) = at
            && self.updated_at.as_deref().is_none_or(|newest| at > newest)
        {
            self.updated_at = Some(at.to_owned());
        }
    }

    #[cfg(test)]
    fn updated_at(&self) -> Option<&str> {
        self.updated_at.as_deref()
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
            owner: ChatOwner::Main,
            queued: false,
            editing: false,
            requires_link_context: false,
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
        turn_id: interaction.turn_id.clone(),
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
        step.description = action.description;
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

/// Word each action the harness reader found in the tool evidence. A call still running
/// reads as running while the turn it ran in is the Chat's active turn.
fn steps(tool: &ChatTool, harness: &str, chat: &Chat, home: Option<&str>) -> Vec<Step> {
    let running = tool.turn_id.is_some()
        && chat.active_turn.as_ref().map(|turn| &turn.id) == tool.turn_id.as_ref();
    steps_while(tool, harness, chat, home, running)
}

/// As `steps`, when the caller knows whether the work the call belongs to still goes on:
/// the active turn for the main agent's, the run for a sub-agent's.
fn steps_while(
    tool: &ChatTool,
    harness: &str,
    chat: &Chat,
    home: Option<&str>,
    active: bool,
) -> Vec<Step> {
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
        description: None,
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
                    owner: None,
                    count: None,
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
        // A sub-agent's message is one of its run's, and complete when it was said.
        ChatItem::Message(message) if let ChatOwner::SubAgent { native_id } = &message.owner => {
            Item::Response {
                id: message.id.clone(),
                at: message.created_at.clone(),
                text: message.text.clone(),
                state: if message.complete {
                    "complete"
                } else {
                    "partial"
                },
                turn_id: Some(run_id(
                    native_id,
                    tracker.run_at(native_id, message.position),
                )),
                owner: Some(native_id.clone()),
            }
        }
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
                owner: None,
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
                owner: None,
                count: None,
            }
        }
        // The call that started a sub-agent is told by the sub-agent's own row.
        ChatItem::Tool(tool) if tracker.starts_sub_agent(tool, &chat.harness) => return None,
        // A sub-agent's Step is one of its run's: its row reads as running while the run does.
        ChatItem::Tool(tool) if let ChatOwner::SubAgent { native_id } = &tool.owner => {
            let run = tracker.run_at(native_id, tool.position);
            let running = run.is_some_and(|run| run.state == ChatSubAgentState::Running);
            let this_run = run_id(native_id, run);
            // Its reasoning and files, and the records it changed, are its run's report.
            if let Some(report) =
                chat_reports::sub_agent_report(tool, this_run.clone(), running, chat, &|path| {
                    shown_path(path, &chat.execution_folder, home_folder().as_deref())
                })
            {
                return Some(report_item(tool, report, Some(native_id.clone())));
            }
            if let Some(changes) = agent_changes(tool) {
                let net = tracker.sub_agent_net(tool, &changes, native_id, run);
                return Some(Item::Records {
                    id: tool.id.clone(),
                    at: String::new(),
                    gone: vec![None; changes.len()],
                    net_gone: vec![None; net.len()],
                    net,
                    changes,
                    turn_id: Some(this_run),
                    owner: Some(native_id.clone()),
                });
            }
            Item::Steps {
                id: tool.id.clone(),
                at: String::new(),
                steps: steps_while(tool, harness, chat, home_folder().as_deref(), running)
                    .into_iter()
                    .map(|step| Step {
                        decision: tracker.decided().get(&tool.id).cloned(),
                        awaiting: tracker.awaits(&tool.id),
                        ..step
                    })
                    .collect(),
                turn_id: Some(run_id(native_id, run)),
                owner: Some(native_id.clone()),
            }
        }
        ChatItem::SubAgentRun(_) => return None,
        ChatItem::Tool(tool)
            if let Some(report) = chat_reports::report(tool, chat, live, &|path| {
                shown_path(path, &chat.execution_folder, home_folder().as_deref())
            }) =>
        {
            report_item(tool, report, None)
        }
        ChatItem::Tool(tool) if let Some(changes) = agent_changes(tool) => {
            let net = tracker.turn_net(tool, &changes);
            Item::Records {
                id: tool.id.clone(),
                at: String::new(),
                gone: vec![None; changes.len()],
                net_gone: vec![None; net.len()],
                net,
                changes,
                turn_id: tool.turn_id.clone(),
                owner: None,
            }
        }
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
            turn_id: tool.turn_id.clone(),
            owner: None,
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
        // The person stopped sub-agents while no turn ran: the row counts them.
        ChatItem::Notice(notice) if notice.sub_agents_stopped.is_some() => Item::Marker {
            id: notice.id.clone(),
            at: notice.created_at.clone(),
            reason: "sub_agents_stopped",
            message: None,
            turn_id: None,
            owner: None,
            count: notice.sub_agents_stopped,
        },
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
            owner: None,
            count: None,
        },
    })
}

fn report_item(tool: &ChatTool, report: Report, owner: Option<String>) -> Item {
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
            owner,
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
            owner,
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
        owner: None,
        origin: turn.origin.as_ref().map(|origin| TurnOriginView {
            by: match origin.by {
                ChatTurnStarter::Harness => "harness",
                ChatTurnStarter::Ticketd => "ticketd",
            },
            sub_agent: origin.sub_agent.clone(),
        }),
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
    if let ChatItem::SubAgentRun(run) = record {
        return sub_agent_run_items(run, chat, tracker);
    }
    let timing = match record {
        ChatItem::Turn(turn) => Some(turn_item(turn)),
        _ => None,
    };
    timing
        .into_iter()
        .chain(item(record, chat, live, fresh, tracker))
        .collect()
}

/// A sub-agent's `owner` on a Step: the native ID as given.
fn owner_of(native_id: &str) -> ChatOwner {
    ChatOwner::SubAgent {
        native_id: native_id.to_owned(),
    }
}

/// A run's ID in the view: the "turn" of the sub-agent that its items belong to.
fn run_id(native_id: &str, run: Option<&ChatSubAgentRun>) -> String {
    format!("{native_id}:run-{}", run.map_or(1, |run| run.run))
}

fn status_word(state: ChatSubAgentState) -> &'static str {
    match state {
        ChatSubAgentState::Running => "running",
        ChatSubAgentState::Completed => "completed",
        ChatSubAgentState::Failed => "failed",
        ChatSubAgentState::Stopped => "stopped",
        ChatSubAgentState::Lost => "lost",
    }
}

fn stopper_word(stopper: ChatSubAgentStopper) -> &'static str {
    match stopper {
        ChatSubAgentStopper::Person => "person",
        ChatSubAgentStopper::Ticketd => "ticketd",
        ChatSubAgentStopper::MainAgent => "main_agent",
    }
}

/// What one run of a sub-agent gives the transcript: its row in the transcript of the agent
/// that started it, the run as a turn of the sub-agent's own, and a note when it failed.
fn sub_agent_run_items(run: &ChatSubAgentRun, chat: &Chat, tracker: &Tracker) -> Vec<Item> {
    let native = run.sub_agent.as_str();
    let this_run = run_id(native, Some(run));
    // The row sits where the agent that started it works: a nested sub-agent's in its
    // parent's run, a direct one's in the main agent's turn.
    let parent = tracker
        .sub_agent(native)
        .and_then(|record| record.parent.as_deref());
    let (owner, row_turn) = match parent {
        Some(parent) => (
            Some(parent.to_owned()),
            Some(run_id(parent, tracker.run_at(parent, run.position))),
        ),
        None => (None, run.turn_id.clone()),
    };
    let mut items = vec![
        Item::SubAgent {
            id: format!("{native}:row-{}", run.run),
            at: run.started_at.clone(),
            turn_id: row_turn,
            owner,
            sub_agent: native.to_owned(),
            run: run.run,
            status: status_word(run.state),
            stopped_by: run.stopped_by.map(stopper_word),
            stop_reason: run.stop_reason.clone(),
            started_at: run.started_at.clone(),
            ended_at: run.ended_at.clone(),
        },
        Item::Turn {
            id: format!("turn:{this_run}"),
            at: run.started_at.clone(),
            turn_id: this_run.clone(),
            started_at: run.started_at.clone(),
            ended_at: run.ended_at.clone(),
            outcome: match run.state {
                ChatSubAgentState::Running => "active",
                ChatSubAgentState::Completed => "completed",
                ChatSubAgentState::Failed => "failed",
                ChatSubAgentState::Stopped => "stopped",
                ChatSubAgentState::Lost => "lost",
            },
            owner: Some(native.to_owned()),
            origin: None,
        },
    ];
    if run.state == ChatSubAgentState::Failed {
        let harness = harness_name(&chat.harness);
        items.push(Item::Marker {
            id: format!("{this_run}:end"),
            at: run
                .ended_at
                .clone()
                .unwrap_or_else(|| run.started_at.clone()),
            reason: "failed",
            message: run
                .detail
                .as_deref()
                .map(|detail| format!("{harness} ended it with an error: {detail}")),
            turn_id: Some(this_run),
            owner: Some(native.to_owned()),
            count: None,
        });
    }
    items
}

/// How the model a sub-agent reported reads: the harness's own name for it when the live
/// session lists it, else the id as reported, else the harness.
fn model_name(reported: Option<&str>, live: &ChatLive, harness: &str) -> String {
    model_label(reported, live).unwrap_or_else(|| harness.to_owned())
}

/// The model as the live session names it, else the id as reported; `None` when none
/// was reported.
fn model_label(reported: Option<&str>, live: &ChatLive) -> Option<String> {
    let reported = reported.filter(|model| !model.is_empty())?;
    let options = live
        .settings
        .as_deref()
        .and_then(|settings| settings.reported.model.as_ref())
        .map(|setting| setting.options.as_slice())
        .unwrap_or_default();
    // A reported id can carry a date its listed id leaves off.
    let listed = options
        .iter()
        .find(|option| option.id == reported)
        .or_else(|| {
            options
                .iter()
                .filter(|option| option.id.len() > 3 && reported.starts_with(option.id.as_str()))
                .max_by_key(|option| option.id.len())
        });
    Some(listed.map_or_else(|| reported.to_owned(), |option| option.label.clone()))
}

/// The model a sub-agent's own frames reported, as the ticket's label names it.
pub(crate) fn sub_agent_model(record: &ChatSubAgent, live: &ChatLive) -> Option<String> {
    model_label(record.said("model").as_deref(), live)
}

/// The model the Chat's live session reports for the main agent, as the session names it.
pub(crate) fn main_agent_model(live: &ChatLive) -> Option<String> {
    let model = live.settings.as_deref()?.reported.model.as_ref()?;
    let id = model.answered_by.as_deref().or(model.current.as_deref());
    model_label(id, live)
}

/// What a running Step is doing in a few words ("Running npm test -- rate-limit"), for a
/// line that says what an agent does now.
pub(crate) fn running_words(tool: &ChatTool, chat: &Chat) -> Option<String> {
    const LIMIT: usize = 60;
    let harness = harness_name(&chat.harness);
    let step = steps_while(tool, harness, chat, None, true)
        .into_iter()
        .next()?;
    if step.ticketd.is_some() {
        return Some(cut_at_word(&step.target, LIMIT));
    }
    let what = step
        .command
        .clone()
        .or_else(|| step.targets.first().map(|target| target.text.clone()))
        .filter(|what| !what.is_empty())
        .unwrap_or_else(|| step.target.clone());
    let what = cut_at_word(first_line_of(&what).as_deref().unwrap_or(&what), LIMIT);
    Some(match step.kind {
        "run" => format!("Running {what}"),
        "read" => format!("Reading {what}"),
        "search" => format!("Searching {what}"),
        "edit" => format!("Editing {what}"),
        "create" => format!("Creating {what}"),
        "delete" => format!("Deleting {what}"),
        "web" => format!("Browsing {what}"),
        _ => format!("Using {what}"),
    })
}

/// What the harness called a sub-agent's work; failing that, the kind of sub-agent it is.
pub(crate) fn sub_agent_title(record: &ChatSubAgent) -> String {
    let said = |key: &str| record.said(key).filter(|said| !said.trim().is_empty());
    said("description")
        .map(|description| first_line_of(&description).unwrap_or(description))
        .or_else(|| said("subagent_type"))
        .unwrap_or_else(|| "Sub-agent".to_owned())
}

/// A sub-agent as the screens read it, or `None` when it has no run yet.
fn sub_agent_view(record: &ChatSubAgent, chat: &Chat, live: &ChatLive) -> Option<SubAgentView> {
    let latest = record.latest()?;
    let harness = harness_name(&chat.harness);
    let support = descriptor(&chat.harness).map(|descriptor| descriptor.sub_agents);
    let capabilities = support.map_or(
        SubAgentCapabilities {
            brief: true,
            text: true,
            end: true,
            stop: false,
            resume: false,
        },
        |support| SubAgentCapabilities {
            brief: support.brief,
            text: support.text,
            end: support.end,
            stop: support.stop,
            resume: support.resume,
        },
    );
    let said = |key: &str| record.said(key).filter(|said| !said.trim().is_empty());
    let title = sub_agent_title(record);
    let prompt = said("prompt");
    Some(SubAgentView {
        id: record.native_id.clone(),
        native_id: record.native_id.clone(),
        parent: record.parent.clone(),
        title,
        kind: said("subagent_type"),
        model: model_name(said("model").as_deref(), live, harness),
        status: status_word(latest.state),
        stopped_by: latest.stopped_by.map(stopper_word),
        stop_reason: latest.stop_reason.clone(),
        started_at: latest.started_at.clone(),
        ended_at: latest.ended_at.clone(),
        runs: record.runs.len(),
        brief: Some(BriefView {
            text: prompt.filter(|_| capabilities.brief),
            source: if record.parent.is_some() {
                "sub_agent"
            } else {
                "main_agent"
            },
        }),
        capabilities,
    })
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

/// The longest title a Chat is given from its first line.
pub const TITLE_LIMIT: usize = 80;

/// `text` as it is when it fits `limit` characters, else cut at a word and ended with
/// "…", the whole result within `limit`. One long word is cut where it stands.
pub fn cut_at_word(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_owned();
    }
    let room = limit.saturating_sub(1);
    let head: String = chars[..room].iter().collect();
    // The next character starts a word: the head already ends at one.
    if chars[room].is_whitespace() {
        return ellipsis(&head);
    }
    ellipsis(before_last_word(&head))
}

/// `text` cut short: without the dash, colon, comma or semicolon its last word was
/// followed by, then "…".
fn ellipsis(text: &str) -> String {
    let text = text.trim_end_matches(|c: char| c.is_whitespace() || "-–—:,;".contains(c));
    format!("{text}…")
}

/// `text` without its last, possibly partial, word; all of it when it has only one.
fn before_last_word(text: &str) -> &str {
    match text.trim_end().rfind(char::is_whitespace) {
        Some(at) if at > 0 => text[..at].trim_end(),
        _ => text,
    }
}

/// How a Chat started from a ticket begins, "Work on T-12: <title>". The UI writes
/// that first line (`WORK_ON_LEAD` in `src/features/chats/ticket-chat.ts`) and
/// `display_title` reads it back. Change both together.
const WORK_ON_LEAD: &str = "Work on ";

/// Whether the stored title is long enough to be a cut of the first line (a title a
/// word cut ended says so with "…", and a shorter one was never cut). The first
/// message is read only for these.
pub(crate) fn title_may_be_cut(chat: &Chat) -> bool {
    chat.title
        .as_deref()
        .is_some_and(|title| title.chars().count() >= TITLE_LIMIT - 1 && !title.ends_with('…'))
}

/// The first line of a Chat's first message, which its title is made from.
pub(crate) fn first_line_of(message: &str) -> Option<String> {
    message.trim().lines().next().map(str::to_owned)
}

/// Whether `line` is a ticket's title followed by the prompt: the title, then ": " or
/// " - " (or that cut short), as "Work on <reference>: <title><separator><prompt>".
fn names_title(line: &str, title: &str) -> bool {
    !title.is_empty()
        && line.strip_prefix(title).is_some_and(|after| {
            let after = after.trim_end_matches('…');
            after.starts_with(": ") || after.starts_with(" - ") || matches!(after, ":" | " -" | " ")
        })
}

/// The title the Chat view shows (U-chat titles). A title that starts with
/// "Work on <reference>: " for a ticket linked to the Chat is the rest of the line,
/// and the ticket's own title when the stored line was cut short of it. A title the
/// old 80-character limit cut mid-word, which is a strict prefix of the first line,
/// is cut again at a word. Nothing stored changes.
pub(crate) fn display_title(chat: &Chat, around: &Surroundings) -> String {
    let stored = title(chat);
    let Some(chat_title) = chat.title.as_deref() else {
        return stored;
    };
    // The limit cut it: the first line goes on past it. A title of the limit's length
    // that is the whole line was never cut; one that lost a trimmed space still is.
    let rest_of_line = around
        .first_line
        .as_deref()
        .and_then(|line| line.strip_prefix(chat_title))
        .filter(|rest| !rest.is_empty());
    let cut = rest_of_line.is_some();
    // It ended at a word's end, so that word is whole.
    let at_word_end = rest_of_line.is_some_and(|rest| rest.starts_with(char::is_whitespace))
        || chat_title.ends_with(char::is_whitespace);
    let ticket = around.links.iter().find_map(|link| match link {
        LinkedRecord::Ticket {
            reference, title, ..
        } => chat_title
            .strip_prefix(&format!("{WORK_ON_LEAD}{reference}: "))
            .filter(|rest| !rest.trim().is_empty())
            .map(|rest| (rest, title.as_str())),
        LinkedRecord::Document { .. } | LinkedRecord::Project { .. } => None,
    });
    let (rest, ticket_title) = match ticket {
        Some((rest, ticket_title)) => (rest, Some(ticket_title)),
        None => (chat_title, None),
    };
    // A line a cut ended, and its ticket's title that goes on from it; or a line that
    // starts with the ticket's title and goes on with the prompt ("<title>: <prompt>").
    let ended = rest.trim_end_matches('…');
    if let Some(full) = ticket_title.filter(|full| {
        ((cut || ended.len() < rest.len()) && full.starts_with(ended)) || names_title(rest, full)
    }) {
        return cut_at_word(full, TITLE_LIMIT);
    }
    if cut {
        let whole = rest.trim_end();
        if at_word_end && whole.chars().count() < TITLE_LIMIT {
            return ellipsis(whole);
        }
        return ellipsis(before_last_word(rest));
    }
    rest.to_owned()
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
        title: display_title(chat, around),
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
        // Only sub-agents run (or the main agent is about to resume): no turn does.
        turn_running: (activity == "working"
            && chat.active_turn.is_none()
            && opening.is_none()
            && !live.delivery_unconfirmed
            && live.sending.is_empty()
            && (live.sub_agents > 0 || live.waking))
            .then_some(false),
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
        sub_agents: tracker.sub_agent_views(chat, live),
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
    let first_change = tracker.first_change();
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
        first_change: first_change.as_ref(),
        files_changed: tracker.files_changed(),
        last_response: tracker.last_response.as_deref(),
        stopped_sub_agents: tracker.stopped_sub_agents(),
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
        title: display_title(chat, around),
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
        first_change,
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
    use ticketd_chat_host::Activity;
    use ticketd_chat_host::{STOPPED_BY_TICKETD, StopReason, TurnEnding};
    use ticketd_core::ChatSessionOrigin;
    use ticketd_core::{ChatItem, ChatOwner, ChatTurnStarter};

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
                origin: None,
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
        let paused = |live: &ChatLive| {
            chat_state(&chat(None), live, &Tracker::default(), &around).queue_paused
        };
        assert!(!paused(&live));
        live.prepared_queue_edits.insert("prepared".to_owned());
        assert!(paused(&live));
    }

    fn tool(name: &str, input: &str, state: ChatToolState, output: Option<&str>) -> ChatTool {
        ChatTool {
            id: "t".to_owned(),
            position: 0,
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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

    /// A Claude Code command's own description reaches the view; one without it, and
    /// every other tool, carries none, and serializes without the field.
    #[test]
    fn a_commands_description_reaches_the_step() {
        let done = ChatToolState::Completed;
        let described = claude_step(&tool(
            "Bash",
            r#"{"command":"npm test","description":"Run the unit tests"}"#,
            done,
            None,
        ));
        assert_eq!(described.description.as_deref(), Some("Run the unit tests"));
        assert_eq!(described.command.as_deref(), Some("npm test"));
        assert_eq!(
            serde_json::to_value(&described).expect("a step serializes")["description"],
            "Run the unit tests"
        );
        let plain = claude_step(&tool("Bash", r#"{"command":"npm test"}"#, done, None));
        assert_eq!(plain.description, None);
        assert!(
            serde_json::to_value(&plain)
                .expect("a step serializes")
                .get("description")
                .is_none(),
            "an older record still parses without it"
        );
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
                turn_id: Some("turn-1".to_owned()),
                owner: ChatOwner::Main,
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
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
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
                origin: None,
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
                origin: None,
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
    /// copy (`client.ts` validates them, `model.ts` words each for the transcript). A reason added on
    /// one side only would reach the transcript as an unreadable marker.
    #[test]
    fn the_frontends_markers_are_the_ones_ticketd_stops_a_turn_with() {
        let client = include_str!("../../src/features/chats/client.ts");
        let transcript = include_str!("../../src/features/chats/model.ts");
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
        let others = [
            "stopped",
            "stop_unconfirmed",
            "failed",
            "note",
            "warning",
            "sub_agents_stopped",
        ];
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
                "model.ts has no wording for {marker}"
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

    fn ticket(reference: &str, title: &str) -> super::LinkedRecord {
        super::LinkedRecord::Ticket {
            id: format!("id-{reference}"),
            reference: reference.to_owned(),
            title: title.to_owned(),
            status: "Todo".to_owned(),
        }
    }

    fn titled(title: &str) -> Chat {
        Chat {
            title: Some(title.to_owned()),
            ..chat(None)
        }
    }

    /// What the Chat view makes of a stored title, the Chat's links and its first line.
    fn shown(title: &str, links: &[super::LinkedRecord], first_line: Option<&str>) -> String {
        let around = super::Surroundings {
            links: links.to_vec(),
            first_line: first_line.map(str::to_owned),
            ..Default::default()
        };
        super::display_title(&titled(title), &around)
    }

    #[test]
    fn a_title_starting_with_a_linked_reference_is_the_rest_of_the_line() {
        let linked = [ticket("T-12", "Design the attachment review UI")];
        assert_eq!(
            shown(
                "Work on T-12: Design the attachment review UI",
                &linked,
                None
            ),
            "Design the attachment review UI"
        );
        // The reference is another ticket's, or no ticket is linked: nothing to drop.
        assert_eq!(
            shown("Work on T-99: Design it", &linked, None),
            "Work on T-99: Design it"
        );
        assert_eq!(
            shown("Work on T-12: Design it", &[], None),
            "Work on T-12: Design it"
        );
        assert_eq!(shown("Fix the login", &linked, None), "Fix the login");
        // Only the lead is dropped; a title that is only the lead stays whole.
        assert_eq!(shown("Work on T-12: ", &linked, None), "Work on T-12: ");
    }

    #[test]
    fn a_title_that_starts_with_the_linked_tickets_title_is_that_title() {
        // "Work on <ref>: <ticket title><sep><prompt>", with either separator.
        let linked = [ticket("T-12", "Improve the export dialog")];
        for line in [
            "Work on T-12: Improve the export dialog: also add a progress bar",
            "Work on T-12: Improve the export dialog - also add a progress bar",
        ] {
            assert_eq!(
                shown(line, &linked, Some(line)),
                "Improve the export dialog"
            );
        }
        // The prompt cut it inside the separator.
        assert_eq!(
            shown("Work on T-12: Improve the export dialog:", &linked, None),
            "Improve the export dialog"
        );
        // Not the ticket's title, or no separator after it: the rest of the line.
        assert_eq!(
            shown("Work on T-12: Improve the export dialogs", &linked, None),
            "Improve the export dialogs"
        );
        assert_eq!(
            shown(
                "Work on T-12: Make it faster: also add a progress bar",
                &linked,
                None
            ),
            "Make it faster: also add a progress bar"
        );
        // A ticket title longer than the limit is cut at a word, as for a cut line.
        let long =
            "Design the attachment review experience for every kind of record a Chat can link to";
        let linked = [ticket("T-12", long)];
        let line = format!("Work on T-12: {long}: and then the settings page");
        let title = shown(&line, &linked, Some(&line));
        assert!(
            title.ends_with('…') && title.chars().count() <= 80,
            "{title}"
        );
        assert!(long.starts_with(title.trim_end_matches('…')), "{title}");
    }

    #[test]
    fn a_cut_title_never_ends_in_punctuation_before_the_ellipsis() {
        // Not linked: a legacy title cut mid-word, whose last whole word is a dash.
        let line = format!("{}- andromeda and more", "word ".repeat(15));
        let stored: String = line.chars().take(80).collect();
        let title = shown(&stored, &[], Some(&line));
        assert!(title.ends_with('…'), "{title}");
        assert!(
            !title
                .trim_end_matches('…')
                .ends_with([' ', '-', '–', '—', ':', ',', ';']),
            "{title}"
        );
        // A new title cut at a word keeps no colon or dash either.
        let long = format!(
            "{}: {}",
            "Explain the retry queue and its limits",
            "x".repeat(60)
        );
        assert_eq!(
            super::cut_at_word(&long, 42),
            "Explain the retry queue and its limits…"
        );
        assert_eq!(
            super::cut_at_word("Explain the retry queue and its limits - and more", 41),
            "Explain the retry queue and its limits…"
        );
    }

    #[test]
    fn a_title_cut_mid_word_at_eighty_characters_is_cut_again_at_a_word() {
        let line = "Work on T-12: Design the attachment review UI for this user flow and the settings page";
        let stored: String = line.chars().take(80).collect();
        assert_eq!(stored.chars().count(), 80);
        // The linked ticket's own title starts the same: it is the title.
        let linked = [ticket(
            "T-12",
            "Design the attachment review UI for this user flow and the settings page",
        )];
        assert_eq!(
            shown(&stored, &linked, Some(line)),
            "Design the attachment review UI for this user flow and the settings page"
        );
        // Not linked: the cut falls back to a word.
        let line =
            "Explain how the retry queue decides which Chats to send after a restart, in detail";
        let plain: String = line.chars().take(80).collect();
        let shown_title = shown(&plain, &[], Some(line));
        assert_eq!(
            shown_title,
            "Explain how the retry queue decides which Chats to send after a restart, in…"
        );
        assert!(shown_title.chars().count() <= 80);
        // A short title, or one a word cut already ended, is left alone.
        assert_eq!(shown("Short one", &[], Some("Short one")), "Short one");
        let cut = super::cut_at_word(&"word ".repeat(30), 80);
        assert_eq!(shown(&cut, &[], Some(&"word ".repeat(30))), cut);
    }

    #[test]
    fn a_first_line_of_exactly_eighty_characters_was_never_cut() {
        let whole =
            "Explain how the retry queue decides which Chats to send after a restart, in deta";
        assert_eq!(whole.chars().count(), 80);
        assert_eq!(shown(whole, &[], Some(whole)), whole);
        // With no first message to compare, the title is what is stored.
        assert_eq!(shown(whole, &[], None), whole);
    }

    #[test]
    fn a_legacy_title_that_lost_its_trailing_space_is_still_a_cut() {
        // Cut at 80 characters, then trimmed to 79 by the space that ended it: its
        // last word was whole.
        let stored = format!("{}abcd", "word ".repeat(15));
        assert_eq!(stored.chars().count(), 79);
        let line = format!("{stored} and the rest of the line");
        assert_eq!(shown(&stored, &[], Some(&line)), format!("{stored}…"));
    }

    #[test]
    fn a_turn_is_worded_by_the_first_record_the_agent_changed() {
        let changes = |id: &str, turn: &str, input: &str| {
            ChatItem::Tool(ChatTool {
                id: id.to_owned(),
                turn_id: Some(turn.to_owned()),
                owner: ChatOwner::Main,
                ..tool(
                    ticketd_chat_host::AGENT_CHANGES_RECORD_NAME,
                    input,
                    ChatToolState::Completed,
                    None,
                )
            })
        };
        let moved =
            r#"{"kind":"status","reference":"T-12","title":"Demo","from":"Todo","to":"In review"}"#;
        let posted = r#"{"kind":"update","reference":"T-12","excerpt":"Done"}"#;
        let later = r#"{"kind":"update","reference":"T-13","excerpt":"Next"}"#;
        let wording = |tracker: &Tracker| {
            tracker
                .first_change()
                .as_ref()
                .map(ticketd_chat_host::attention::change_line)
        };
        // Moved, then posted an update: in one call, and across two.
        let one_call = Tracker::from_items(&[changes("a", "t1", &format!("[{moved},{posted}]"))]);
        assert_eq!(
            wording(&one_call).as_deref(),
            Some("Moved T-12 to In review")
        );
        let two_calls = Tracker::from_items(&[
            changes("a", "t1", &format!("[{moved}]")),
            changes("b", "t1", &format!("[{posted}]")),
        ]);
        assert_eq!(
            wording(&two_calls).as_deref(),
            Some("Moved T-12 to In review")
        );
        // Todo -> In progress -> In review, with an update between: the row says the net
        // move, and a call shown again is not counted twice.
        let progress = r#"{"kind":"status","reference":"T-12","title":"Demo","from":"Todo","to":"In progress"}"#;
        let review = r#"{"kind":"status","reference":"T-12","title":"Demo","from":"In progress","to":"In review"}"#;
        let mut netted = Tracker::from_items(&[
            changes("a", "t1", &format!("[{progress}]")),
            changes("b", "t1", &format!("[{posted}]")),
            changes("c", "t1", &format!("[{review}]")),
            changes("c", "t1", &format!("[{review}]")),
        ]);
        assert_eq!(wording(&netted).as_deref(), Some("Moved T-12 to In review"));
        // A move that ends where it began leaves the update to lead.
        netted.note(&changes(
            "d",
            "t1",
            &format!(
                "[{}]",
                review.replace(
                    r#""from":"In progress","to":"In review""#,
                    r#""from":"In review","to":"Todo""#,
                )
            ),
        ));
        assert_eq!(
            wording(&netted).as_deref(),
            Some("Posted an update on T-12")
        );
        // The next turn is worded by its own first change.
        let next = Tracker::from_items(&[
            changes("a", "t1", &format!("[{moved}]")),
            changes("b", "t2", &format!("[{later}]")),
        ]);
        assert_eq!(wording(&next).as_deref(), Some("Posted an update on T-13"));
    }

    /// The records row says the turn's net changes (one rule, in the Chat host), and an
    /// earlier turn's row is netted by its own calls, not the latest turn's.
    #[test]
    fn a_records_item_carries_its_turns_net_changes_and_keeps_the_raw_ones() {
        use super::{ChatAgentChange, item};
        let call = |id: &str, turn: &str, input: &str| {
            ChatItem::Tool(ChatTool {
                id: id.to_owned(),
                turn_id: Some(turn.to_owned()),
                owner: ChatOwner::Main,
                ..tool(
                    ticketd_chat_host::AGENT_CHANGES_RECORD_NAME,
                    input,
                    ChatToolState::Completed,
                    None,
                )
            })
        };
        let status = |reference: &str, from: &str, to: &str| {
            format!(
                r#"{{"kind":"status","reference":"{reference}","title":"Demo","from":"{from}","to":"{to}"}}"#
            )
        };
        let posted = r#"{"kind":"update","reference":"T-12","excerpt":"Done"}"#;
        let first = call(
            "a",
            "t1",
            &format!("[{}]", status("T-12", "Todo", "In progress")),
        );
        let update = call("b", "t1", &format!("[{posted}]"));
        let second = call(
            "c",
            "t1",
            &format!("[{}]", status("T-12", "In progress", "In review")),
        );
        let later = call("d", "t2", &format!("[{}]", status("T-13", "Todo", "Done")));
        let tracker =
            Tracker::from_items(&[first.clone(), update.clone(), second.clone(), later.clone()]);
        let live = ChatLive::idle();
        let read = |record: &ChatItem| {
            let Some(Item::Records { changes, net, .. }) =
                item(record, &chat(None), &live, None, &tracker)
            else {
                panic!("a records item");
            };
            (changes.len(), net)
        };
        let moved = |reference: &str, from: &str, to: &str| ChatAgentChange::Status {
            reference: reference.to_owned(),
            title: "Demo".to_owned(),
            from: from.to_owned(),
            to: to.to_owned(),
        };
        // The turn's last call carries the whole turn, netted; its own change stays raw.
        let (raw, net) = read(&second);
        assert_eq!(raw, 1);
        assert_eq!(
            net,
            [
                moved("T-12", "Todo", "In review"),
                serde_json::from_str::<ChatAgentChange>(posted).unwrap(),
            ]
        );
        // Another turn's row is netted by that turn's calls only.
        assert_eq!(read(&later).1, [moved("T-13", "Todo", "Done")]);
        // A move that ends where it began is no net change.
        let back = Tracker::from_items(&[
            first.clone(),
            call(
                "e",
                "t1",
                &format!("[{}]", status("T-12", "In progress", "Todo")),
            ),
        ]);
        let Some(Item::Records { net, .. }) = item(&first, &chat(None), &live, None, &back) else {
            panic!("a records item");
        };
        assert!(net.is_empty(), "{net:?}");
    }

    /// A steer starts a new segment of its turn, and each segment's records row says
    /// only its own changes; the list row says the first sentence of the last one.
    #[test]
    fn a_steer_splits_a_turns_net_changes_into_segments() {
        use super::{ChatAgentChange, item};
        use ticketd_core::{
            ChatDelivery, ChatMessage, ChatRole, ChatSubmissionAttempt, ChatSubmissionIntent,
        };
        let call = |id: &str, input: &str| {
            ChatItem::Tool(ChatTool {
                id: id.to_owned(),
                turn_id: Some("t1".to_owned()),
                owner: ChatOwner::Main,
                ..tool(
                    ticketd_chat_host::AGENT_CHANGES_RECORD_NAME,
                    input,
                    ChatToolState::Completed,
                    None,
                )
            })
        };
        let status = |from: &str, to: &str| {
            format!(
                r#"{{"kind":"status","reference":"T-12","title":"Demo","from":"{from}","to":"{to}"}}"#
            )
        };
        let posted = r#"{"kind":"update","reference":"T-12","excerpt":"Done"}"#;
        let steer = ChatItem::Message(ChatMessage {
            id: "m".to_owned(),
            position: 3,
            role: ChatRole::User,
            text: "Also post an update".to_owned(),
            attachments: Vec::new(),
            complete: true,
            turn_id: Some("t1".to_owned()),
            owner: ChatOwner::Main,
            queued: false,
            editing: false,
            requires_link_context: false,
            attempts: vec![ChatSubmissionAttempt {
                id: "a".to_owned(),
                intent: ChatSubmissionIntent::Steer,
                delivery: ChatDelivery::Acknowledged,
                turn_id: Some("t1".to_owned()),
                detail: None,
                decision: None,
                recorded_at: String::new(),
            }],
            created_at: String::new(),
        });
        let first = call(
            "a",
            &format!("[{},{posted}]", status("Todo", "In progress")),
        );
        let second = call("b", &format!("[{}]", status("In progress", "In review")));
        let records = [first.clone(), steer.clone(), second.clone()];
        let live = ChatLive::idle();
        // A snapshot reads the whole history, a live view one record at a time: the
        // same segments either way, and a steer shown again is not a second one.
        let mut streamed = Tracker::default();
        for record in &records {
            streamed.note(record);
        }
        streamed.note(&steer);
        for tracker in [Tracker::from_items(&records), streamed] {
            let net = |record: &ChatItem| {
                let Some(Item::Records { net, .. }) =
                    item(record, &chat(None), &live, None, &tracker)
                else {
                    panic!("a records item");
                };
                net
            };
            let moved = |from: &str, to: &str| ChatAgentChange::Status {
                reference: "T-12".to_owned(),
                title: "Demo".to_owned(),
                from: from.to_owned(),
                to: to.to_owned(),
            };
            assert_eq!(
                net(&first),
                [
                    moved("Todo", "In progress"),
                    serde_json::from_str::<ChatAgentChange>(posted).unwrap()
                ]
            );
            // Not netted with the first segment's move or its update.
            assert_eq!(net(&second), [moved("In progress", "In review")]);
            assert_eq!(
                tracker
                    .first_change()
                    .as_ref()
                    .map(ticketd_chat_host::attention::change_line)
                    .as_deref(),
                Some("Moved T-12 to In review")
            );
        }
    }

    #[test]
    fn a_new_chats_title_is_cut_at_a_word_with_an_ellipsis() {
        assert_eq!(super::cut_at_word("Fix the login", 80), "Fix the login");
        let long = "Explain how the retry queue decides which Chats to send after a restart, in detail please";
        let cut = super::cut_at_word(long, 80);
        assert_eq!(
            cut,
            "Explain how the retry queue decides which Chats to send after a restart, in…"
        );
        // A cut right after a word keeps that word.
        let exact = format!("{} tail", "a".repeat(79));
        assert_eq!(
            super::cut_at_word(&exact, 80),
            format!("{}…", "a".repeat(79))
        );
        // One long word has no word to cut at.
        let one = "x".repeat(120);
        assert_eq!(super::cut_at_word(&one, 80), format!("{}…", "x".repeat(79)));
    }

    #[test]
    fn a_working_chats_time_counts_from_its_newest_activity() {
        use ticketd_core::{ChatMessage, ChatRole};
        let turn = ChatTurn {
            id: "turn".to_owned(),
            position: 1,
            native_turn_id: None,
            state: ChatTurnState::Active,
            detail: None,
            problem: None,
            problem_resets_at: None,
            ending: None,
            started_at: "2026-11-24T22:00:00Z".to_owned(),
            ended_at: None,
            origin: None,
        };
        let message = ChatMessage {
            id: "m".to_owned(),
            position: 2,
            role: ChatRole::Assistant,
            text: "Looking".to_owned(),
            attachments: Vec::new(),
            complete: true,
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::Main,
            queued: false,
            editing: false,
            requires_link_context: false,
            attempts: Vec::new(),
            created_at: "2026-11-25T09:30:00Z".to_owned(),
        };
        let mut running = tool("Read", "", ChatToolState::Running, None);
        running.started_at = Some("2026-11-25T09:41:00Z".to_owned());
        let mut tracker = Tracker::default();
        for item in [
            ChatItem::Turn(turn),
            ChatItem::Message(message),
            ChatItem::Tool(running),
        ] {
            tracker.note(&item);
        }
        assert_eq!(tracker.updated_at(), Some("2026-11-25T09:41:00Z"));
        // An older record seen later never moves it back.
        let mut older = tool("Read", "", ChatToolState::Completed, None);
        older.started_at = Some("2026-11-25T09:00:00Z".to_owned());
        tracker.note(&ChatItem::Tool(older));
        assert_eq!(tracker.updated_at(), Some("2026-11-25T09:41:00Z"));
    }

    #[test]
    fn the_files_a_turn_changed_are_counted_for_the_list_row() {
        let files = json!({"files": [
            {"path": "a.ts", "kind": "added", "from": null, "added_lines": 3, "removed_lines": 0, "confirmed": true},
            {"path": "b.ts", "kind": "modified", "from": null, "added_lines": null, "removed_lines": null, "confirmed": false},
        ]});
        let record = tool(
            ticketd_chat_host::records::FILES_RECORD_NAME,
            &files.to_string(),
            ChatToolState::Completed,
            None,
        );
        let ended = ticketd_core::ChatTurn {
            id: "turn".to_owned(),
            position: 1,
            native_turn_id: None,
            state: ChatTurnState::Completed,
            detail: None,
            problem: None,
            problem_resets_at: None,
            ending: None,
            started_at: String::new(),
            ended_at: None,
            origin: None,
        };
        let mut tracker = Tracker::default();
        assert_eq!(tracker.files_changed(), None);
        tracker.note(&ChatItem::Turn(ended));
        tracker.note(&ChatItem::Tool(record));
        assert_eq!(tracker.files_changed(), Some(2));
    }

    // --- Sub-agents -----------------------------------------------------------------

    use ticketd_core::{ChatSubAgent, ChatSubAgentRun, ChatSubAgentState, ChatSubAgentStopper};

    fn sub_agent_run(
        native: &str,
        run: i64,
        position: i64,
        state: ChatSubAgentState,
    ) -> ChatSubAgentRun {
        ChatSubAgentRun {
            id: format!("rec:{native}:run-{run}"),
            position,
            sub_agent: native.to_owned(),
            run,
            native_run_id: Some(format!("r{run}")),
            turn_id: Some("turn".to_owned()),
            state,
            stopped_by: None,
            stop_reason: None,
            detail: None,
            started_at: "2026-11-27T10:00:00.000Z".to_owned(),
            ended_at: (state != ChatSubAgentState::Running)
                .then(|| "2026-11-27T10:02:40.000Z".to_owned()),
        }
    }

    fn sub_agent_record(
        native: &str,
        parent: Option<&str>,
        payload: serde_json::Value,
        runs: Vec<ChatSubAgentRun>,
    ) -> ChatSubAgent {
        ChatSubAgent {
            id: format!("rec:{native}"),
            native_id: native.to_owned(),
            parent: parent.map(str::to_owned),
            tool_id: Some("agent-step".to_owned()),
            background: false,
            payload: payload.to_string(),
            created_at: "2026-11-27T10:00:00.000Z".to_owned(),
            runs,
        }
    }

    fn owned_by(native: &str, id: &str, position: i64, state: ChatToolState) -> ChatTool {
        ChatTool {
            id: id.to_owned(),
            position,
            turn_id: Some("turn".to_owned()),
            owner: ChatOwner::SubAgent {
                native_id: native.to_owned(),
            },
            name: "Read".to_owned(),
            input: json!({"file_path": "/work/limiter/a.ts"}).to_string(),
            state,
            output: None,
            output_truncated: false,
            started_at: None,
        }
    }

    fn view_of(record: &ChatItem, tracker: &Tracker, chat: &Chat) -> Vec<serde_json::Value> {
        items(record, chat, &ChatLive::idle(), None, tracker)
            .iter()
            .map(|item| serde_json::to_value(item).unwrap())
            .collect()
    }

    fn started_by_the_harness(turn_id: &str, sub_agent: Option<&str>) -> ChatItem {
        ChatItem::Turn(ChatTurn {
            id: turn_id.to_owned(),
            position: 30,
            native_turn_id: None,
            state: ChatTurnState::Completed,
            detail: None,
            problem: None,
            problem_resets_at: None,
            ending: Some("completed".to_owned()),
            started_at: "2026-11-27T10:05:00Z".to_owned(),
            ended_at: Some("2026-11-27T10:06:00Z".to_owned()),
            origin: Some(ticketd_core::ChatTurnOrigin {
                by: ChatTurnStarter::Harness,
                sub_agent: sub_agent.map(str::to_owned),
            }),
        })
    }

    #[test]
    fn a_turn_the_harness_started_says_who_and_which_sub_agent_it_follows() {
        let chat = claude_chat(None);
        let tracker = Tracker::default();
        let rows = view_of(&started_by_the_harness("t2", Some("a")), &tracker, &chat);
        assert_eq!(rows[0]["kind"], "turn");
        assert_eq!(
            rows[0]["origin"],
            json!({"by": "harness", "sub_agent": "a"})
        );
        let rows = view_of(&started_by_the_harness("t3", None), &tracker, &chat);
        assert_eq!(rows[0]["origin"], json!({"by": "harness"}));
        // A turn the person started says nothing.
        let mut person = started_by_the_harness("t4", None);
        if let ChatItem::Turn(turn) = &mut person {
            turn.origin = None;
        }
        assert!(view_of(&person, &tracker, &chat)[0].get("origin").is_none());
    }

    #[test]
    fn stopping_sub_agents_with_no_turn_is_a_counted_marker_and_the_rows_second_line() {
        let chat = claude_chat(None);
        let notice = ticketd_core::ChatNotice {
            id: "n1".to_owned(),
            position: 40,
            text: "You stopped 2 sub-agents.".to_owned(),
            created_at: "2026-11-27T10:07:00Z".to_owned(),
            from_harness: false,
            sub_agents_stopped: Some(2),
        };
        let mut tracker = Tracker::default();
        let record = ChatItem::Notice(notice);
        tracker.note(&started_by_the_harness("t2", None));
        tracker.note(&record);
        let rows = view_of(&record, &tracker, &chat);
        assert_eq!(rows[0]["kind"], "marker");
        assert_eq!(rows[0]["reason"], "sub_agents_stopped");
        assert_eq!(rows[0]["count"], 2);
        assert!(
            rows[0]
                .get("turn_id")
                .is_none_or(serde_json::Value::is_null)
        );
        assert_eq!(tracker.stopped_sub_agents(), Some(2));
        // A turn that starts after it takes the words back.
        let mut later = started_by_the_harness("t3", None);
        if let ChatItem::Turn(turn) = &mut later {
            turn.position = 50;
        }
        tracker.note(&later);
        assert_eq!(tracker.stopped_sub_agents(), None);
    }

    #[test]
    fn with_only_sub_agents_running_no_turn_does() {
        let chat = chat(None);
        let tracker = Tracker::default();
        let around = Surroundings::default();
        let working = ChatLive {
            activity: Activity::Working,
            sub_agents: 2,
            ..ChatLive::idle()
        };
        let state = chat_state(&chat, &working, &tracker, &around);
        assert_eq!(
            (state.activity, state.turn_running),
            ("working", Some(false))
        );
        assert!(state.doing.is_none(), "no working line without a turn");
        // The main agent about to resume counts as the same.
        let waking = ChatLive {
            activity: Activity::Working,
            waking: true,
            ..ChatLive::idle()
        };
        assert_eq!(
            chat_state(&chat, &waking, &tracker, &around).turn_running,
            Some(false)
        );
        // Nothing runs, or a turn does: the field is absent.
        let idle = chat_state(&chat, &ChatLive::idle(), &tracker, &around);
        assert_eq!(idle.turn_running, None);
        let with_turn = chat_state(
            &super::tests::chat(Some("turn")),
            &working,
            &tracker,
            &around,
        );
        assert_eq!(with_turn.turn_running, None);
    }

    #[test]
    fn a_run_is_one_row_for_the_agent_that_started_it_and_a_turn_of_its_own() {
        let chat = claude_chat(Some("turn"));
        let outer = sub_agent_record(
            "a",
            None,
            json!({"description": "Review the limiter code"}),
            vec![sub_agent_run("a", 1, 10, ChatSubAgentState::Running)],
        );
        let inner = sub_agent_record(
            "b",
            Some("a"),
            json!({"description": "Check the tests"}),
            vec![sub_agent_run("b", 1, 20, ChatSubAgentState::Completed)],
        );
        let tracker = Tracker::from_snapshot(&[], &[outer.clone(), inner.clone()]);

        let direct = view_of(
            &ChatItem::SubAgentRun(outer.runs[0].clone()),
            &tracker,
            &chat,
        );
        assert_eq!(direct[0]["kind"], "sub_agent");
        assert_eq!(direct[0]["sub_agent"], "a");
        assert_eq!(direct[0]["status"], "running");
        // The main agent's own: no owner, in the turn it began in.
        assert!(direct[0].get("owner").is_none());
        assert_eq!(direct[0]["turn_id"], "turn");
        // The run is a turn of the sub-agent's.
        assert_eq!(direct[1]["kind"], "turn");
        assert_eq!(
            (direct[1]["owner"].as_str(), direct[1]["turn_id"].as_str()),
            (Some("a"), Some("a:run-1"))
        );
        assert_eq!(direct[1]["outcome"], "active");

        // A nested sub-agent's row is its parent's, in the run of the parent it began in.
        let nested = view_of(
            &ChatItem::SubAgentRun(inner.runs[0].clone()),
            &tracker,
            &chat,
        );
        assert_eq!(nested[0]["owner"], "a");
        assert_eq!(nested[0]["turn_id"], "a:run-1");
        assert_eq!(nested[1]["owner"], "b");
        assert_eq!(nested[1]["outcome"], "completed");
        assert_eq!(nested.len(), 2, "a finished run has no failure marker");
    }

    #[test]
    fn a_resumed_sub_agent_has_one_row_for_each_run() {
        let chat = claude_chat(None);
        let record = sub_agent_record(
            "a",
            None,
            json!({"description": "Check coverage"}),
            vec![
                sub_agent_run("a", 1, 10, ChatSubAgentState::Lost),
                sub_agent_run("a", 2, 30, ChatSubAgentState::Running),
            ],
        );
        let tracker = Tracker::from_snapshot(&[], std::slice::from_ref(&record));
        let rows: Vec<_> = record
            .runs
            .iter()
            .map(|run| view_of(&ChatItem::SubAgentRun(run.clone()), &tracker, &chat))
            .collect();
        assert_eq!(rows[0][0]["id"], "a:row-1");
        assert_eq!(
            (rows[0][0]["run"].as_i64(), rows[0][0]["status"].as_str()),
            (Some(1), Some("lost"))
        );
        assert_eq!(rows[1][0]["id"], "a:row-2");
        assert_eq!(rows[1][1]["turn_id"], "a:run-2");
        let views = tracker.sub_agent_views(&chat, &ChatLive::idle());
        assert_eq!((views[0].runs, views[0].status), (2, "running"));
    }

    #[test]
    fn a_failed_run_says_so_and_a_stopped_one_says_who_stopped_it() {
        let chat = claude_chat(None);
        let mut failed = sub_agent_run("a", 1, 10, ChatSubAgentState::Failed);
        failed.detail = Some("the model's response hit its output limit".to_owned());
        let mut stopped = sub_agent_run("b", 1, 20, ChatSubAgentState::Stopped);
        stopped.stopped_by = Some(ChatSubAgentStopper::Ticketd);
        stopped.stop_reason = Some("turned_off".to_owned());
        let records = [
            sub_agent_record("a", None, json!({}), vec![failed.clone()]),
            sub_agent_record("b", None, json!({}), vec![stopped.clone()]),
        ];
        let tracker = Tracker::from_snapshot(&[], &records);
        let failure = view_of(&ChatItem::SubAgentRun(failed), &tracker, &chat);
        assert_eq!(failure[2]["kind"], "marker");
        assert_eq!(failure[2]["reason"], "failed");
        assert_eq!(failure[2]["owner"], "a");
        assert_eq!(
            failure[2]["message"],
            "Claude Code ended it with an error: the model's response hit its output limit"
        );
        let stop = view_of(&ChatItem::SubAgentRun(stopped), &tracker, &chat);
        assert_eq!(stop[0]["stopped_by"], "ticketd");
        assert_eq!(stop[0]["stop_reason"], "turned_off");
        assert_eq!(stop.len(), 2);
    }

    #[test]
    fn a_sub_agents_step_is_its_runs_not_the_turns_and_runs_only_while_its_run_does() {
        let chat = claude_chat(Some("turn"));
        let record = sub_agent_record(
            "a",
            None,
            json!({}),
            vec![sub_agent_run("a", 1, 10, ChatSubAgentState::Running)],
        );
        let step = ChatItem::Tool(owned_by("a", "read-1", 11, ChatToolState::Running));
        let tracker =
            Tracker::from_snapshot(std::slice::from_ref(&step), std::slice::from_ref(&record));
        let shown = view_of(&step, &tracker, &chat);
        assert_eq!(shown[0]["kind"], "steps");
        assert_eq!(shown[0]["owner"], "a");
        assert_eq!(shown[0]["turn_id"], "a:run-1");
        assert_eq!(shown[0]["steps"][0]["state"], "running");

        // The parent's turn is still active, but the run has ended: the step is not running.
        let mut ended = record.clone();
        ended.runs[0] = sub_agent_run("a", 1, 10, ChatSubAgentState::Stopped);
        let tracker = Tracker::from_snapshot(std::slice::from_ref(&step), &[ended]);
        assert_eq!(
            view_of(&step, &tracker, &chat)[0]["steps"][0]["state"],
            "not_finished"
        );

        // The main agent's turn knows nothing of it: no approval, record or report reads it.
        let mut main = Tracker::default();
        main.note(&step);
        assert!(main.refolded().is_empty());
        assert!(main.dependents().is_empty());
        assert_eq!(main.sub_agent_steps("a").len(), 1);
    }

    #[test]
    fn the_call_that_started_a_sub_agent_is_told_by_its_row_and_not_as_a_step() {
        let chat = claude_chat(Some("turn"));
        let launch = |state| ChatTool {
            name: "Agent".to_owned(),
            input: json!({"description": "Check the tests"}).to_string(),
            owner: ChatOwner::Main,
            ..owned_by("", "agent-step", 5, state)
        };
        // Still running, not yet announced: nothing is shown, so nothing has to be taken back.
        let running = ChatItem::Tool(launch(ChatToolState::Running));
        assert!(
            items(
                &running,
                &chat,
                &ChatLive::idle(),
                None,
                &Tracker::default()
            )
            .is_empty()
        );
        // Announced: its row tells it, whatever the call's state.
        let record = sub_agent_record(
            "a",
            None,
            json!({}),
            vec![sub_agent_run("a", 1, 6, ChatSubAgentState::Completed)],
        );
        let done = ChatItem::Tool(launch(ChatToolState::Completed));
        let tracker = Tracker::from_snapshot(&[], &[record]);
        assert!(items(&done, &chat, &ChatLive::idle(), None, &tracker).is_empty());
        // A launch that failed and never started one is a Step: it says what went wrong.
        let failed = ChatItem::Tool(launch(ChatToolState::Failed));
        let shown = items(&failed, &chat, &ChatLive::idle(), None, &Tracker::default());
        assert_eq!(shown.len(), 1);
        // Another harness's tool of that name is its own business.
        let codex = ChatItem::Tool(launch(ChatToolState::Running));
        assert_eq!(
            items(
                &codex,
                &super::Chat {
                    harness: "codex".to_owned(),
                    ..chat
                },
                &ChatLive::idle(),
                None,
                &Tracker::default()
            )
            .len(),
            1
        );
    }

    #[test]
    fn a_sub_agents_title_type_and_model_are_worded_from_what_the_harness_said() {
        let chat = claude_chat(None);
        let said = json!({
            "description": "Find limiter bypasses\nthen report",
            "subagent_type": "Explore",
            "prompt": "Find every way past the limiter.",
            "model": "claude-haiku-5-5-20260301",
        });
        let record = sub_agent_record(
            "a",
            None,
            said,
            vec![sub_agent_run("a", 1, 10, ChatSubAgentState::Running)],
        );
        let tracker = Tracker::from_snapshot(&[], std::slice::from_ref(&record));
        // Without the session's list of models the id reads as reported.
        let view = &tracker.sub_agent_views(&chat, &ChatLive::idle())[0];
        assert_eq!(view.title, "Find limiter bypasses");
        assert_eq!(view.kind.as_deref(), Some("Explore"));
        assert_eq!(view.model, "claude-haiku-5-5-20260301");
        assert_eq!(
            view.brief.as_ref().and_then(|brief| brief.text.as_deref()),
            Some("Find every way past the limiter.")
        );
        assert!(view.capabilities.resume && view.capabilities.brief);

        // The harness's own name for the model, when the session lists it.
        let mut live = ChatLive::idle();
        live.settings = Some(Box::new(ticketd_chat_host::LiveSettings {
            reported: ticketd_chat_host::HarnessSettings {
                model: Some(ticketd_chat_host::Setting {
                    current: None,
                    options: vec![ticketd_chat_host::SettingOption {
                        id: "claude-haiku-5-5".to_owned(),
                        label: "Claude Haiku 5.5".to_owned(),
                        description: None,
                        is_default: false,
                        permission: None,
                        allowed: true,
                    }],
                    unchangeable: None,
                    applies_from: ticketd_chat_host::AppliesFrom::NextTurn,
                    answered_by: None,
                }),
                effort: None,
                permission: None,
            },
            changes: Vec::new(),
        }));
        assert_eq!(
            tracker.sub_agent_views(&chat, &live)[0].model,
            "Claude Haiku 5.5"
        );

        // Nothing reported: the harness.
        let bare = sub_agent_record(
            "b",
            None,
            json!({}),
            vec![sub_agent_run("b", 1, 12, ChatSubAgentState::Running)],
        );
        let tracker = Tracker::from_snapshot(&[], &[bare]);
        let view = &tracker.sub_agent_views(&chat, &ChatLive::idle())[0];
        assert_eq!(
            (view.title.as_str(), view.model.as_str()),
            ("Sub-agent", "Claude Code")
        );
        assert_eq!(view.kind, None);
    }

    fn said_by(native: &str, id: &str, position: i64, text: &str) -> ticketd_core::ChatMessage {
        ticketd_core::ChatMessage {
            id: id.to_owned(),
            position,
            role: ticketd_core::ChatRole::Assistant,
            text: text.to_owned(),
            attachments: Vec::new(),
            complete: true,
            turn_id: Some("turn".to_owned()),
            owner: super::owner_of(native),
            queued: false,
            editing: false,
            requires_link_context: false,
            attempts: Vec::new(),
            created_at: "2026-11-27T10:00:30.000Z".to_owned(),
        }
    }

    fn report_by(native: &str, id: &str, position: i64, name: &str, input: &str) -> ChatTool {
        ChatTool {
            name: name.to_owned(),
            input: input.to_owned(),
            ..owned_by(native, id, position, ChatToolState::Completed)
        }
    }

    #[test]
    fn a_sub_agents_words_reasoning_and_files_are_its_runs_and_not_the_main_agents() {
        let chat = claude_chat(Some("turn"));
        let record = sub_agent_record(
            "a",
            None,
            json!({"description": "Check the limit"}),
            vec![
                sub_agent_run("a", 1, 10, ChatSubAgentState::Completed),
                sub_agent_run("a", 2, 30, ChatSubAgentState::Running),
            ],
        );
        let mut tracker = Tracker::from_snapshot(&[], &[record]);
        let words = ChatItem::Message(said_by("a", "m1", 12, "Looking at the limiter."));
        tracker.note(&words);
        let later = ChatItem::Message(said_by("a", "m2", 32, "Resumed."));
        tracker.note(&later);
        // Each belongs to the run it was said in, as the sub-agent's own, complete.
        let first = view_of(&words, &tracker, &chat);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["kind"], "response");
        assert_eq!(first[0]["owner"], "a");
        assert_eq!(first[0]["turn_id"], "a:run-1");
        assert_eq!(first[0]["state"], "complete");
        assert_eq!(view_of(&later, &tracker, &chat)[0]["turn_id"], "a:run-2");
        // The main agent's last response is its own.
        assert_eq!(tracker.last_response, None);

        // Reasoning runs while its run does; the files of a run that ended have ended.
        let thinking = ChatItem::Tool(ChatTool {
            state: ChatToolState::Running,
            ..report_by(
                "a",
                "r1",
                32,
                "ticketd reasoning",
                r#"{"running":true,"started_at":1,"ended_at":null,"text":"Check the tests.","heading":null}"#,
            )
        });
        tracker.note(&thinking);
        let shown = view_of(&thinking, &tracker, &chat);
        assert_eq!(
            (
                shown[0]["kind"].as_str(),
                shown[0]["state"].as_str(),
                shown[0]["owner"].as_str(),
                shown[0]["turn_id"].as_str()
            ),
            (
                Some("reasoning"),
                Some("running"),
                Some("a"),
                Some("a:run-2")
            )
        );
        let files = ChatItem::Tool(report_by(
            "a",
            "f1",
            14,
            "ticketd files",
            r#"{"files":[{"path":"/work/limiter/note.txt","kind":"added","from":null,"added_lines":1,"removed_lines":0,"confirmed":true}]}"#,
        ));
        tracker.note(&files);
        let shown = view_of(&files, &tracker, &chat);
        assert_eq!(
            (
                shown[0]["kind"].as_str(),
                shown[0]["state"].as_str(),
                shown[0]["turn_id"].as_str()
            ),
            (Some("files"), Some("ended"), Some("a:run-1"))
        );
        assert_eq!(shown[0]["files"][0]["path"], "note.txt");
        assert_eq!(shown[0]["files"][0]["open_path"], "/work/limiter/note.txt");
        assert_eq!(tracker.files_changed(), None, "not the turn's files");
    }

    #[test]
    fn the_records_a_sub_agent_changed_are_its_runs_and_not_the_turns() {
        let chat = claude_chat(None);
        let record = sub_agent_record(
            "a",
            None,
            json!({}),
            vec![sub_agent_run("a", 1, 10, ChatSubAgentState::Completed)],
        );
        let mut tracker = Tracker::from_snapshot(&[], &[record]);
        let status =
            r#"[{"kind":"status","reference":"T-12","title":"Demo","from":"Todo","to":"Done"}]"#;
        let changed = ChatItem::Tool(report_by(
            "a",
            "c1",
            12,
            ticketd_chat_host::AGENT_CHANGES_RECORD_NAME,
            status,
        ));
        tracker.note(&changed);
        let shown = view_of(&changed, &tracker, &chat);
        assert_eq!(
            (
                shown[0]["kind"].as_str(),
                shown[0]["owner"].as_str(),
                shown[0]["turn_id"].as_str()
            ),
            (Some("records"), Some("a"), Some("a:run-1"))
        );
        assert_eq!(shown[0]["net"].as_array().map(Vec::len), Some(1));
        assert!(tracker.first_change().is_none(), "not the turn's records");
    }

    #[test]
    fn a_codex_sub_agent_has_its_name_and_model_and_no_brief() {
        let chat = chat(None);
        let said = json!({
            "description": "Refund calls",
            "agentPath": "/root/refund_calls",
            "model": "gpt-test",
            "reasoningEffort": "low",
            // A v1 spawn call names its prompt; the descriptor says Codex reports no brief.
            "prompt": "Update the refund calls.",
        });
        let record = sub_agent_record(
            "thr-a",
            None,
            said,
            vec![sub_agent_run("thr-a", 1, 10, ChatSubAgentState::Running)],
        );
        let tracker = Tracker::from_snapshot(&[], std::slice::from_ref(&record));
        let view = &tracker.sub_agent_views(&chat, &ChatLive::idle())[0];
        assert_eq!(view.title, "Refund calls");
        assert_eq!(view.kind, None);
        assert_eq!(view.model, "gpt-test");
        assert!(!view.capabilities.brief && view.capabilities.text && view.capabilities.end);
        assert!(!view.capabilities.resume);
        let brief = view.brief.as_ref().expect("a brief entry for its source");
        assert_eq!((brief.text.as_deref(), brief.source), (None, "main_agent"));
    }

    #[test]
    fn what_a_sub_agent_said_is_a_response_of_its_own_run() {
        let chat = chat(None);
        let record = sub_agent_record(
            "a",
            None,
            json!({}),
            vec![
                sub_agent_run("a", 1, 10, ChatSubAgentState::Completed),
                sub_agent_run("a", 2, 20, ChatSubAgentState::Running),
            ],
        );
        let said =
            |id: &str, position, text: &str| ChatItem::Message(said_by("a", id, position, text));
        let first = said("m1", 11, "The first findings.");
        let second = said("m2", 21, "More findings.");
        let tracker = Tracker::from_snapshot(
            &[first.clone(), second.clone()],
            std::slice::from_ref(&record),
        );
        let shown = |item: &ChatItem| view_of(item, &tracker, &chat);
        let (one, two) = (shown(&first), shown(&second));
        assert_eq!(one.len(), 1);
        assert_eq!(one[0]["kind"], "response");
        assert_eq!(one[0]["text"], "The first findings.");
        assert_eq!(one[0]["state"], "complete");
        assert_eq!(
            (one[0]["owner"].as_str(), one[0]["turn_id"].as_str()),
            (Some("a"), Some("a:run-1"))
        );
        // A resumed sub-agent's words belong to the run they were written in.
        assert_eq!(two[0]["turn_id"], "a:run-2");
        // The main agent's last response and everything it keeps stay its own.
        let mut main = Tracker::default();
        main.note(&first);
        assert_eq!(main.last_response, None);
        assert!(main.dependents().is_empty());
    }

    /// The stored history of the nested fixture (the chat host's test writes it) and the view
    /// built from it, which the interface's tests parse with its own schemas
    /// (`sub-agent-host-view.test.ts`). Regenerated only with
    /// `TICKETD_UPDATE_VIEW_FIXTURES=1`.
    const STORED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/ticketd-chat-host/tests/fixtures/claude/sub_agent_nested.stored.json"
    );
    const STORED_MESSAGES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/ticketd-chat-host/tests/fixtures/claude/sub_agent_messages.stored.json"
    );
    const VIEW_MESSAGES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/features/chats/claude-sub-agent-messages-view.json"
    );
    const CODEX_STORED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/ticketd-chat-host/tests/fixtures/codex/sub_agent_nested.stored.json"
    );
    const CODEX_VIEW: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/features/chats/codex-sub-agent-view.json"
    );
    const AGY_STORED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/ticketd-chat-host/tests/fixtures/antigravity/sub_agent.stored.json"
    );
    const AGY_VIEW: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/features/chats/antigravity-sub-agent-view.json"
    );
    const VIEW: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/features/chats/claude-sub-agent-view.json"
    );

    /// The view of the stored history at `stored`, compared with the file at `view` (or
    /// written to it when asked). Returns what was built, to say what it holds.
    fn pinned_view(
        stored: &str,
        view: &str,
    ) -> (ticketd_core::ChatSnapshot, super::ChatState, Vec<Item>) {
        let stored: ticketd_core::ChatSnapshot =
            serde_json::from_str(&std::fs::read_to_string(stored).expect("the stored history"))
                .expect("the stored history reads");
        let tracker = Tracker::from_snapshot(&stored.items, &stored.sub_agents);
        let live = ChatLive::idle();
        let state = super::chat_state(&stored.chat, &live, &tracker, &Surroundings::default());
        let rows: Vec<Item> = stored
            .items
            .iter()
            .flat_map(|record| items(record, &stored.chat, &live, None, &tracker))
            .collect();
        let built = serde_json::to_string_pretty(&json!({
            "chat": state,
            "items": rows,
            "cursor": 0,
        }))
        .unwrap();
        if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
            std::fs::write(view, format!("{built}\n")).expect("the view is written");
        }
        let kept = std::fs::read_to_string(view).expect(
            "the view; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-desktop --lib chat_view",
        );
        assert!(
            kept.trim_end() == built,
            "the view changed; if that is intended, regenerate {view} with TICKETD_UPDATE_VIEW_FIXTURES=1"
        );
        (stored, state, rows)
    }

    #[test]
    fn the_view_of_a_nested_sub_agent_is_the_contract_the_interface_parses() {
        let (_, state, rows) = pinned_view(STORED, VIEW);

        // What the contract says of it, in words: the parent's turn holds one row and none of
        // the sub-agents' own Steps; each sub-agent owns its run's items.
        let kind_of =
            |value: &serde_json::Value| value["kind"].as_str().unwrap_or_default().to_owned();
        let all: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| serde_json::to_value(row).unwrap())
            .collect();
        let main: Vec<&serde_json::Value> = all
            .iter()
            .filter(|row| row.get("owner").is_none())
            .collect();
        assert_eq!(
            main.iter()
                .filter(|row| kind_of(row) == "sub_agent")
                .count(),
            1
        );
        assert!(
            main.iter()
                .filter(|row| kind_of(row) == "steps")
                .all(|row| row["steps"][0]["kind"] != "read"),
            "a sub-agent's Read is in the main transcript"
        );
        assert_eq!(state.sub_agents.len(), 2);
    }

    /// What the host sends of a Claude Chat whose background sub-agents work after the main
    /// agent's turn ended, in four moments: the host's stored history of each
    /// (`sub_agent_background_*.stored.json`, written by the host's tests) and the live state
    /// it has then. The files are what `sub-agent-background-view.test.ts` parses, and what
    /// the screens are compared with the design's boards from. Regenerated only with
    /// `TICKETD_UPDATE_VIEW_FIXTURES=1`.
    #[test]
    fn the_views_of_background_sub_agents_are_the_contract_the_interface_parses() {
        let moments: [(&str, usize); 5] = [
            ("working", 2),
            ("one", 1),
            ("done", 0),
            ("stopped", 0),
            ("in_turn", 2),
        ];
        for (name, running) in moments {
            let stored_file = format!(
                "{}/../../../crates/ticketd-chat-host/tests/fixtures/claude/sub_agent_background_{name}.stored.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let view_file = format!(
                "{}/../src/features/chats/claude-background-{name}-view.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let stored: ticketd_core::ChatSnapshot =
                serde_json::from_str(&std::fs::read_to_string(&stored_file).expect("stored"))
                    .expect("the stored history reads");
            let tracker = Tracker::from_snapshot(&stored.items, &stored.sub_agents);
            let live = ChatLive {
                activity: if running > 0 {
                    Activity::Working
                } else {
                    Activity::Idle
                },
                running: running > 0,
                sub_agents: running,
                ..ChatLive::idle()
            };
            let state = super::chat_state(&stored.chat, &live, &tracker, &Surroundings::default());
            let rows: Vec<Item> = stored
                .items
                .iter()
                .flat_map(|record| items(record, &stored.chat, &live, None, &tracker))
                .collect();
            let view = serde_json::to_string_pretty(&json!({
                "chat": state,
                "items": rows,
                "cursor": 0,
            }))
            .unwrap();
            if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
                std::fs::write(&view_file, format!("{view}\n")).expect("the view is written");
            }
            let kept = std::fs::read_to_string(&view_file).expect(
                "the view; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-desktop --lib chat_view",
            );
            assert!(
                kept.trim_end() == view,
                "the view changed; if that is intended, regenerate {view_file} with TICKETD_UPDATE_VIEW_FIXTURES=1"
            );
            // The words around the view, from the host's own status.
            let summary = super::summary(&stored.chat, &live, &tracker, &Surroundings::default());
            let line = summary.status.line();
            match name {
                "working" | "in_turn" => assert_eq!(line, "Working · 2 sub-agents"),
                "one" => assert_eq!(line, "Working · 1 sub-agent"),
                "stopped" => assert_eq!(line, "You stopped 2 sub-agents"),
                _ => assert!(line.starts_with("Done"), "{line}"),
            }
            // While the turn that started them still runs, it is the turn that works.
            let no_turn = (running > 0 && name != "in_turn").then_some(false);
            assert_eq!(state.turn_running, no_turn, "{name}");
        }
    }

    /// What the host sends of a Codex Chat right after ticketd woke the main agent for the
    /// sub-agent that finished first, while the other still runs: the host's stored history
    /// (`sub_agent_wake.stored.json`, written by its test) and the live state it has then.
    /// The file is what `codex-wake-view.test.ts` parses and the board is compared with.
    /// Regenerated only with `TICKETD_UPDATE_VIEW_FIXTURES=1`.
    #[test]
    fn the_view_of_a_wake_ticketd_sent_is_the_contract_the_interface_parses() {
        let stored_file = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../crates/ticketd-chat-host/tests/fixtures/codex/sub_agent_wake.stored.json"
        );
        let view_file = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/features/chats/codex-wake-view.json"
        );
        let stored: ticketd_core::ChatSnapshot =
            serde_json::from_str(&std::fs::read_to_string(stored_file).expect("stored"))
                .expect("the stored history reads");
        let tracker = Tracker::from_snapshot(&stored.items, &stored.sub_agents);
        let live = ChatLive {
            activity: Activity::Working,
            running: true,
            sub_agents: 1,
            ..ChatLive::idle()
        };
        let state = super::chat_state(&stored.chat, &live, &tracker, &Surroundings::default());
        let rows: Vec<Item> = stored
            .items
            .iter()
            .flat_map(|record| items(record, &stored.chat, &live, None, &tracker))
            .collect();
        let view = serde_json::to_string_pretty(&json!({
            "chat": state,
            "items": rows,
            "cursor": 0,
        }))
        .unwrap();
        if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
            std::fs::write(view_file, format!("{view}\n")).expect("the view is written");
        }
        let kept = std::fs::read_to_string(view_file).expect(
            "the view; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-desktop --lib chat_view",
        );
        assert!(
            kept.trim_end() == view,
            "the view changed; if that is intended, regenerate {view_file} with TICKETD_UPDATE_VIEW_FIXTURES=1"
        );
        // The second turn says ticketd started it, after which sub-agent, and no message of
        // the person's stands in its place.
        let all: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| serde_json::to_value(row).unwrap())
            .collect();
        let turns: Vec<&serde_json::Value> = all
            .iter()
            .filter(|row| row["kind"] == "turn" && row.get("owner").is_none())
            .collect();
        assert_eq!(turns.len(), 2);
        assert!(turns[0].get("origin").is_none());
        assert_eq!(turns[1]["origin"]["by"], "ticketd");
        assert!(turns[1]["origin"]["sub_agent"].is_string());
        assert_eq!(
            all.iter().filter(|row| row["kind"] == "user").count(),
            1,
            "the woken turn has no message of the person's"
        );
        // The Chats list keeps saying what runs.
        let summary = super::summary(&stored.chat, &live, &tracker, &Surroundings::default());
        assert_eq!(summary.status.line(), "Working · 1 sub-agent");
        assert_eq!(state.turn_running, Some(false));
    }

    #[test]
    fn the_view_of_a_sub_agent_that_speaks_is_the_contract_the_interface_parses() {
        let (_, state, rows) = pinned_view(STORED_MESSAGES, VIEW_MESSAGES);
        let all: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| serde_json::to_value(row).unwrap())
            .collect();
        let of = |kind: &str, owner: Option<&str>| -> Vec<&serde_json::Value> {
            all.iter()
                .filter(|row| row["kind"] == kind && row["owner"].as_str() == owner)
                .collect()
        };
        // The sub-agent's run holds its reasoning, message, files and report, in order.
        let own: Vec<&str> = all
            .iter()
            .filter(|row| row["owner"] == "task_a1")
            .map(|row| row["kind"].as_str().unwrap())
            .collect();
        assert_eq!(
            own,
            [
                "turn",
                "reasoning",
                "response",
                "steps",
                "steps",
                "files",
                "response"
            ]
        );
        assert!(
            all.iter()
                .filter(|row| row["owner"] == "task_a1")
                .all(|row| row["turn_id"] == "task_a1:run-1")
        );
        // The main agent's own: one reply and one files report, none of the sub-agent's.
        assert_eq!(of("response", None).len(), 1);
        assert_eq!(of("files", None).len(), 1);
        assert_eq!(of("reasoning", None).len(), 0);
        assert_eq!(state.sub_agents.len(), 1);
    }

    #[test]
    fn the_view_of_nested_codex_sub_agents_is_the_contract_the_interface_parses() {
        let stored: ticketd_core::ChatSnapshot = serde_json::from_str(
            &std::fs::read_to_string(CODEX_STORED).expect("the stored history"),
        )
        .expect("the stored history reads");
        let tracker = Tracker::from_snapshot(&stored.items, &stored.sub_agents);
        let live = ChatLive::idle();
        let state = super::chat_state(&stored.chat, &live, &tracker, &Surroundings::default());
        let rows: Vec<Item> = stored
            .items
            .iter()
            .flat_map(|record| items(record, &stored.chat, &live, None, &tracker))
            .collect();
        let view = serde_json::to_string_pretty(&json!({
            "chat": state,
            "items": rows,
            "cursor": 0,
        }))
        .unwrap();
        if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
            std::fs::write(CODEX_VIEW, format!("{view}\n")).expect("the view is written");
        }
        let kept = std::fs::read_to_string(CODEX_VIEW).expect(
            "the view; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-desktop --lib chat_view",
        );
        assert!(
            kept.trim_end() == view,
            "the view changed; if that is intended, regenerate {CODEX_VIEW} with TICKETD_UPDATE_VIEW_FIXTURES=1"
        );

        // The main transcript holds one row, for the direct sub-agent, and none of the
        // sub-agents' own Steps or words; the nested one is in its parent's view.
        let all: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| serde_json::to_value(row).unwrap())
            .collect();
        let main: Vec<&serde_json::Value> = all
            .iter()
            .filter(|row| row.get("owner").is_none())
            .collect();
        let kind_of =
            |value: &serde_json::Value| value["kind"].as_str().unwrap_or_default().to_owned();
        assert_eq!(
            main.iter()
                .filter(|row| kind_of(row) == "sub_agent")
                .count(),
            1
        );
        assert!(main.iter().all(|row| {
            kind_of(row) != "response"
                || row["turn_id"].is_null()
                || !row["turn_id"]
                    .as_str()
                    .unwrap_or_default()
                    .contains(":run-")
        }));
        assert_eq!(state.sub_agents.len(), 2);
        assert!(
            state
                .sub_agents
                .iter()
                .all(|agent| !agent.capabilities.brief)
        );
    }

    #[test]
    fn the_view_of_an_ended_antigravity_sub_agent_is_the_contract_the_interface_parses() {
        let stored: ticketd_core::ChatSnapshot =
            serde_json::from_str(&std::fs::read_to_string(AGY_STORED).expect("the stored history"))
                .expect("the stored history reads");
        let tracker = Tracker::from_snapshot(&stored.items, &stored.sub_agents);
        let live = ChatLive::idle();
        let state = super::chat_state(&stored.chat, &live, &tracker, &Surroundings::default());
        let rows: Vec<Item> = stored
            .items
            .iter()
            .flat_map(|record| items(record, &stored.chat, &live, None, &tracker))
            .collect();
        let view = serde_json::to_string_pretty(&json!({
            "chat": state,
            "items": rows,
            "cursor": 0,
        }))
        .unwrap();
        if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
            std::fs::write(AGY_VIEW, format!("{view}\n")).expect("the view is written");
        }
        let kept = std::fs::read_to_string(AGY_VIEW).expect(
            "the view; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-desktop --lib chat_view",
        );
        assert!(
            kept.trim_end() == view,
            "the view changed; if that is intended, regenerate {AGY_VIEW} with TICKETD_UPDATE_VIEW_FIXTURES=1"
        );

        // Antigravity reports a sub-agent's brief but neither its words nor its end, and
        // cannot stop it alone: the record says so, and a finished run is "completed".
        let [agent] = state.sub_agents.as_slice() else {
            panic!("one sub-agent: {:?}", state.sub_agents);
        };
        assert_eq!(agent.title, "Session Auditor");
        assert_eq!(agent.status, "completed");
        assert_eq!(agent.model, "gemini-3.1-pro");
        let capabilities = &agent.capabilities;
        assert_eq!(
            (
                capabilities.brief,
                capabilities.text,
                capabilities.end,
                capabilities.stop,
                capabilities.resume
            ),
            (true, false, false, false, false)
        );
        assert!(
            agent
                .brief
                .as_ref()
                .and_then(|brief| brief.text.as_deref())
                .is_some_and(|text| text.starts_with("Scan the session routes"))
        );
    }
}
