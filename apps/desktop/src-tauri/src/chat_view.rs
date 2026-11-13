//! What the Chat screens read: stored Chat records and the host's live state, worded and
//! shaped for display. Nothing here is a harness wire format, and nothing here decides
//! what runs; it only describes what the core and the host already know.
use std::collections::HashMap;

use serde::Serialize;

use crate::chat_attention::{self, Facts, Status};
use ticketd_chat_host::{
    AGENT_CHANGES_RECORD_NAME, Activity, ApprovalDecision, CONTEXT_RECORD_NAME, ChatLive,
    ChatProblem, InteractionKind, ProblemKind, STOPPED_BY_TICKETD, StopState, problem_kind,
};
use ticketd_core::{
    Chat, ChatAgentChange, ChatDelivery, ChatInputStanding, ChatInteraction, ChatInteractionKind,
    ChatInteractionState, ChatItem, ChatMessage, ChatRole, ChatSessionOrigin, ChatSubmissionIntent,
    ChatTool, ChatToolState, ChatTurn, ChatTurnState,
};

use crate::chat_reports::{self, ContextView, FileView, PlanStepView, Report, SettingsView};
use crate::folder_probe::Branch;
use crate::step_kind::{self, Kind, Variant};

pub const HARNESSES: [(&str, &str); 2] = [("claude-code", "Claude Code"), ("codex", "Codex")];

pub fn harness_name(id: &str) -> &str {
    HARNESSES
        .iter()
        .find(|(key, _)| *key == id)
        .map_or(id, |(_, name)| name)
}

/// The harness's own sign-in, as a command the person runs in a terminal.
pub fn login_command(harness: &str) -> Option<&'static str> {
    match harness {
        // ponytail: `claude /login` starts Claude Code at its sign-in; confirm against
        // a live installation in #264.
        "claude-code" => Some("claude /login"),
        "codex" => Some("codex login"),
        _ => None,
    }
}

/// Where the harness's publisher explains installing and updating it.
pub fn help_url(harness: &str) -> Option<&'static str> {
    match harness {
        "claude-code" => Some("https://code.claude.com/docs/en/setup"),
        "codex" => Some("https://developers.openai.com/codex/cli"),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub kind: &'static str,
    pub message: Option<String>,
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
    },
}

/// What a step acted on: a path relative to the Chat's folder (`~` for the home
/// folder outside it), a pattern, a query or a page.
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
    pub output: Option<String>,
    /// When the host recorded the call, for a running step's clock. Absent from calls
    /// recorded before ticketd kept it.
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RequestOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    User {
        id: String,
        at: String,
        text: String,
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
        /// `active`, `completed`, `stopped` (by the person), `quit` (ticketd quit),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Folder {
    pub path: String,
    pub name: String,
    pub managed: bool,
    pub missing: bool,
    pub shared_with: Vec<String>,
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
    pub effect: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Queued {
    pub id: String,
    pub text: String,
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
    pub problem: Option<&'static str>,
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
    /// Titles of other Chats that use the same folder.
    pub shared_with: Vec<String>,
    pub links: Vec<LinkedRecord>,
    pub queue: Vec<Queued>,
    pub project: Option<ProjectRef>,
    /// Read only for an open Chat; list rows do not show it.
    pub branch: Option<Branch>,
    /// The failed turn after which the person checked the harness again and it was
    /// usable; its failure is no longer told as a problem.
    pub checked_turn: Option<String>,
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
    /// Assistant messages that are not complete; they stop streaming when their turn ends.
    open: HashMap<String, ChatMessage>,
    last_response: Option<String>,
    last_change: Option<ChatAgentChange>,
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
                self.last_response = Some(message.text.clone());
            }
            ChatItem::Interaction(interaction) => {
                if interaction.state == ChatInteractionState::Pending {
                    self.pending
                        .insert(interaction.id.clone(), interaction.clone());
                } else {
                    self.pending.remove(&interaction.id);
                }
            }
            ChatItem::Tool(tool) if chat_reports::is_report(tool) => {
                // Only the latest turn can still be running.
                self.reports.retain(|_, kept| kept.turn_id == tool.turn_id);
                self.reports.insert(tool.id.clone(), tool.clone());
            }
            ChatItem::Tool(tool) => {
                if let Some(changes) = agent_changes(tool) {
                    self.last_change = changes.last().cloned().or(self.last_change.take());
                }
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
            complete: false,
            turn_id: Some(turn_id.to_owned()),
            queued: false,
            attempts: Vec::new(),
            created_at: String::new(),
        };
        self.open.insert(message_id.to_owned(), message);
        true
    }

    /// The last turn, when it failed with a kind of problem the person can act on.
    pub fn failed_turn(&self) -> Option<&ChatTurn> {
        self.last_turn.as_ref().filter(|turn| {
            turn.state == ChatTurnState::Failed
                && turn
                    .problem
                    .as_deref()
                    .is_some_and(|key| problem_kind(key) != ProblemKind::Other)
        })
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

fn request(interaction: &ChatInteraction, live: &ChatLive, harness: &str) -> Item {
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
    let title = match (approval, state == "pending") {
        (true, true) => format!("{harness} is asking for approval"),
        (true, false) => format!("{harness} asked for approval"),
        (false, true) => format!("{harness} is asking you"),
        (false, false) => format!("{harness} asked you"),
    };
    let (options, free_text) = match asked.map(|request| &request.kind) {
        Some(InteractionKind::Approval { decisions, .. }) => (
            decisions.iter().copied().map(approval_option).collect(),
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
    let outcome = response.map(|response| match response {
        "allow" => "You allowed this once".to_owned(),
        "allow for session" => "You allowed this for this session".to_owned(),
        "deny" => "You denied this".to_owned(),
        answer => format!("You answered: {answer}"),
    });
    Item::Request {
        id: interaction.id.clone(),
        at: String::new(),
        turn_id: Some(interaction.turn_id.clone()),
        request: if approval { "approval" } else { "question" },
        title,
        subject: Some(interaction.prompt.clone()).filter(|prompt| !prompt.is_empty()),
        reason: interaction
            .reason
            .clone()
            .filter(|reason| !reason.is_empty()),
        options,
        free_text,
        state,
        outcome,
        answer: response.filter(|_| !approval).map(str::to_owned),
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

/// Claude Code's own wording of a search that found nothing.
const NOTHING_FOUND: [&str; 2] = ["No files found", "No matches found"];
/// Claude Code's Write result when the file did not exist before (SDK 0.3.322).
const WRITE_CREATED: &str = "File created successfully at:";

/// The step rows for one tool call: one, except for a Codex file change, which has
/// one row per kind of change.
fn steps(tool: &ChatTool, harness: &str, chat: &Chat, home: Option<&str>) -> Vec<Step> {
    let cut = tool
        .output_truncated
        .then_some("earlier output cut, ticketd keeps the last 1 MiB".to_owned());
    let base = Step {
        kind: "other",
        variant: None,
        target: tool.name.clone(),
        targets: vec![target(&tool.name)],
        command: None,
        exit_code: None,
        folder: None,
        timed_out: false,
        duration_ms: None,
        no_matches: false,
        state: "done",
        result: cut,
        output: tool.output.clone(),
        started_at: tool.started_at.clone(),
    };
    if tool.name == CONTEXT_RECORD_NAME {
        return vec![Step {
            target: format!("ticketd gave {harness} this Chat's context"),
            targets: Vec::new(),
            result: None,
            output: Some(tool.input.clone()),
            ..base
        }];
    }
    let input = serde_json::from_str::<serde_json::Value>(&tool.input).ok();
    let value = |name: &str| input.as_ref().and_then(|input| input.get(name));
    let field = |name: &str| value(name).and_then(serde_json::Value::as_str);
    let number = |name: &str| value(name).and_then(serde_json::Value::as_i64);
    let active = chat.active_turn.as_ref().map(|turn| &turn.id) == Some(&tool.turn_id);
    let state = match tool.state {
        ChatToolState::Running if active => "running",
        ChatToolState::Running => "not_finished",
        ChatToolState::Completed => "done",
        // Codex declines were stored as failures before they were kept apart.
        ChatToolState::Failed if field("status") == Some("declined") => "declined",
        ChatToolState::Failed => "failed",
        ChatToolState::Declined => "declined",
        ChatToolState::Unknown => "unknown",
    };
    let base = Step { state, ..base };
    let folder = chat.execution_folder.as_str();
    let path = |text: &str| target(&shown_path(text, folder, home));
    let kind = |kind: &'static str, targets: Vec<StepTarget>| Step {
        kind,
        targets,
        ..base.clone()
    };
    let command = |command: &str, cwd: Option<&str>| {
        let shell = step_kind::shell(command);
        let paths = !matches!(shell.kind, Kind::Run | Kind::Search);
        let targets = shell
            .targets
            .into_iter()
            .map(|found| StepTarget {
                text: if paths {
                    shown_path(&found.text, folder, home)
                } else {
                    found.text
                },
                lines: found.lines.map(|(from, to)| [from, to]),
                scope: found.scope.map(|scope| shown_path(&scope, folder, home)),
            })
            .collect();
        // Where the command ran: Codex's working folder, then a leading `cd`.
        let ran_in = match (cwd, shell.folder) {
            (_, Some(cd)) if cd.starts_with(['/', '~']) => Some(cd),
            (Some(cwd), Some(cd)) => Some(format!("{}/{cd}", cwd.trim_end_matches('/'))),
            (cwd, cd) => cd.or(cwd.map(str::to_owned)),
        }
        .map(|ran_in| shown_path(&ran_in, folder, home))
        .filter(|ran_in| ran_in != ".");
        let exit_code = number("exitCode");
        let search = shell.kind == Kind::Search;
        // grep and rg exit 1 when they find nothing: the search worked.
        let state = if search && state == "failed" && exit_code == Some(1) {
            "done"
        } else {
            state
        };
        let empty = tool
            .output
            .as_deref()
            .is_none_or(|output| output.trim().is_empty());
        Step {
            kind: shell.kind.name(),
            variant: shell.variant.map(Variant::name),
            target: shell.command.clone(),
            targets,
            command: Some(shell.command),
            exit_code,
            folder: ran_in,
            // ponytail: Codex ends a command that ran out of time with exit code
            // 124; confirm against a live timeout in #264.
            timed_out: state == "failed" && exit_code == Some(124),
            duration_ms: number("durationMs"),
            no_matches: search && state == "done" && (empty || exit_code == Some(1)),
            state,
            ..base.clone()
        }
    };
    let found_nothing = |step: Step| Step {
        no_matches: step.state == "done"
            && tool.output.as_deref().is_none_or(|output| {
                let output = output.trim();
                output.is_empty() || NOTHING_FOUND.iter().any(|said| output.starts_with(said))
            }),
        ..step
    };
    // Codex names a command step by its command and keeps its item as the input;
    // Claude Code names its tool and passes the command or file in the input.
    let step = match (field("type"), tool.name.as_str()) {
        (Some("commandExecution"), _) => {
            command(field("command").unwrap_or(&tool.name), field("cwd"))
        }
        (Some("fileChange"), _) => return file_changes(value("changes"), &base, &path),
        (Some("webSearch"), _) => {
            let url = value("action")
                .filter(|action| action["type"] == "openPage")
                .and_then(|action| action["url"].as_str());
            match url {
                Some(url) => Step {
                    variant: Some(Variant::Fetch.name()),
                    ..kind("web", vec![target(&page(url))])
                },
                None => kind("web", vec![target(field("query").unwrap_or_default())]),
            }
        }
        (Some("imageView"), _) => kind("read", field("path").map(path).into_iter().collect()),
        (Some(_), _) => base.clone(),
        (None, name) if let Some(paths) = name.strip_prefix("Edit ") => {
            kind("edit", paths.split(", ").map(path).collect())
        }
        (None, "Bash" | "PowerShell") => match field("command") {
            Some(text) => command(text, None),
            None => base.clone(),
        },
        (None, "Read") => {
            let lines = match (number("offset"), number("limit")) {
                (offset, Some(limit)) if limit > 0 => {
                    let from = offset.unwrap_or(1).max(1);
                    u32::try_from(from)
                        .ok()
                        .zip(u32::try_from(from + limit - 1).ok())
                        .map(|(from, to)| [from, to])
                }
                _ => None,
            };
            let file = field("file_path").map(|file| StepTarget {
                lines,
                ..path(file)
            });
            kind("read", file.into_iter().collect())
        }
        (None, "LS") => Step {
            variant: Some(Variant::List.name()),
            ..kind("read", field("path").map(path).into_iter().collect())
        },
        (None, "Grep" | "Glob") => {
            let scope = field("path").map(|scope| shown_path(scope, folder, home));
            let scope = scope.or(field("glob").map(str::to_owned));
            let pattern = field("pattern").map(|pattern| StepTarget {
                scope,
                ..target(pattern)
            });
            found_nothing(kind("search", pattern.into_iter().collect()))
        }
        (None, "Edit" | "MultiEdit" | "NotebookEdit" | "Write") => {
            let file = field("file_path").or(field("notebook_path"));
            // Created only when Claude Code's result says so.
            let created = tool.name == "Write"
                && state == "done"
                && tool
                    .output
                    .as_deref()
                    .is_some_and(|output| output.starts_with(WRITE_CREATED));
            kind(
                if created { "create" } else { "edit" },
                file.map(path).into_iter().collect(),
            )
        }
        (None, "WebSearch") => kind("web", vec![target(field("query").unwrap_or_default())]),
        (None, "WebFetch") => Step {
            variant: Some(Variant::Fetch.name()),
            ..kind("web", vec![target(&page(field("url").unwrap_or_default()))])
        },
        (None, _) => base.clone(),
    };
    vec![step]
}

/// A Codex file change: one row per kind of change, in the order each kind first
/// appears.
fn file_changes(
    changes: Option<&serde_json::Value>,
    base: &Step,
    path: &dyn Fn(&str) -> StepTarget,
) -> Vec<Step> {
    let mut rows: Vec<Step> = Vec::new();
    let changes = changes.and_then(serde_json::Value::as_array);
    for change in changes.into_iter().flatten() {
        let Some(file) = change["path"].as_str() else {
            continue;
        };
        let how = change["kind"]["type"].as_str().or(change["kind"].as_str());
        let kind = match how {
            Some("add") => "create",
            Some("delete") => "delete",
            _ => "edit",
        };
        match rows.iter_mut().find(|row| row.kind == kind) {
            Some(row) => row.targets.push(path(file)),
            None => rows.push(Step {
                kind,
                targets: vec![path(file)],
                ..base.clone()
            }),
        }
    }
    if rows.is_empty() {
        rows.push(Step {
            kind: "edit",
            ..base.clone()
        });
    }
    rows
}

/// One history record as a transcript item, or `None` when it has no row of its own.
pub fn item(
    record: &ChatItem,
    chat: &Chat,
    live: &ChatLive,
    fresh: Option<FreshHistory>,
) -> Option<Item> {
    let harness = harness_name(&chat.harness);
    Some(match record {
        ChatItem::Session(session) => {
            if session.origin != ChatSessionOrigin::FreshSession {
                return None;
            }
            match fresh.filter(|fresh| session.position > fresh.after) {
                Some(fresh) => Item::Session {
                    id: session.id.clone(),
                    at: session.started_at.clone(),
                    history: fresh.history,
                    count: fresh.count,
                },
                None => Item::Marker {
                    id: session.id.clone(),
                    at: session.started_at.clone(),
                    reason: "note",
                    message: Some(format!(
                        "Continued in a fresh {harness} session with history you selected."
                    )),
                    turn_id: None,
                },
            }
        }
        ChatItem::Message(message) if message.role == ChatRole::User => Item::User {
            id: message.id.clone(),
            at: message.created_at.clone(),
            text: message.text.clone(),
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
            let (reason, message) = match turn.state {
                ChatTurnState::Active | ChatTurnState::Completed => return None,
                ChatTurnState::Interrupted => ("stopped", turn.detail.clone()),
                ChatTurnState::Failed => (
                    "failed",
                    Some(turn.detail.clone().unwrap_or("The turn failed.".to_owned())),
                ),
                ChatTurnState::Unknown if turn.detail.as_deref() == Some(STOPPED_BY_TICKETD) => {
                    ("quit", None)
                }
                ChatTurnState::Unknown => (
                    "note",
                    Some(format!(
                        "Contact with {harness} was lost ({}). Whether this turn finished is unknown.",
                        turn.detail.as_deref().unwrap_or("no detail")
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
            changes,
            turn_id: Some(tool.turn_id.clone()),
        },
        ChatItem::Tool(tool) => Item::Steps {
            id: tool.id.clone(),
            at: String::new(),
            steps: steps(tool, harness, chat, home_folder().as_deref()),
            turn_id: Some(tool.turn_id.clone()),
        },
        ChatItem::Interaction(interaction) => request(interaction, live, harness),
        ChatItem::Notice(notice) => Item::Marker {
            id: notice.id.clone(),
            at: notice.created_at.clone(),
            reason: "note",
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
        outcome: match turn.state {
            ChatTurnState::Active => "active",
            ChatTurnState::Completed => "completed",
            ChatTurnState::Interrupted => "stopped",
            ChatTurnState::Failed => "failed",
            ChatTurnState::Unknown if turn.detail.as_deref() == Some(STOPPED_BY_TICKETD) => "quit",
            ChatTurnState::Unknown => "lost",
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
) -> Vec<Item> {
    let timing = match record {
        ChatItem::Turn(turn) => Some(turn_item(turn)),
        _ => None,
    };
    timing
        .into_iter()
        .chain(item(record, chat, live, fresh))
        .collect()
}

fn home_folder() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

fn retention(chat: &Chat) -> &'static str {
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
    let command = login_command(harness).filter(|_| kind == ProblemKind::LoginRequired);
    let help = help_url(harness).filter(|_| setup);
    let kind = match kind {
        ProblemKind::NotInstalled => "not_installed",
        ProblemKind::IncompatibleVersion => "incompatible",
        ProblemKind::LoginRequired => "not_signed_in",
        ProblemKind::QuotaExhausted => "usage_limit",
        ProblemKind::NativeHistoryUnavailable => "history_lost",
        ProblemKind::SessionInUse => "session_in_use",
        ProblemKind::PermissionUnavailable => "sandbox_unavailable",
        ProblemKind::Other => "failed",
    };
    Problem {
        kind,
        message,
        command: command.map(str::to_owned),
        help_url: help.map(str::to_owned),
        ..Problem::default()
    }
}

fn problem(
    chat: &Chat,
    live: &ChatLive,
    tracker: &Tracker,
    around: &Surroundings,
) -> Option<Problem> {
    let failed = |message: String| Problem {
        kind: "failed",
        message: Some(message),
        ..Problem::default()
    };
    if around.folder_missing {
        return Some(Problem {
            kind: "folder_missing",
            path: Some(chat.execution_folder.clone()),
            ..Problem::default()
        });
    }
    if let Some((message_id, refused)) = &tracker.uncertain {
        return Some(Problem {
            kind: "uncertain_delivery",
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
        kind: "stop_unconfirmed",
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
                turn.state == ChatTurnState::Unknown && turn.detail.as_ref() == Some(detail)
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
            let kind = problem_kind(turn.problem.as_deref()?);
            Some(Problem {
                resets_at: turn
                    .problem_resets_at
                    .filter(|_| kind == ProblemKind::QuotaExhausted),
                past: true,
                ..harness_problem(&chat.harness, kind, turn.detail.clone())
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
        problem: problem(chat, live, tracker, around),
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
        queue_paused: chat.queue_paused,
        context: chat_reports::context(live),
        settings: chat_reports::settings(live, name),
        unseen: tracker
            .last_turn
            .as_ref()
            .is_some_and(|turn| chat.unseen(turn)),
        muted: chat.muted,
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
    let status = chat_attention::status(&Facts {
        chat,
        harness,
        live,
        last_turn: tracker.last_turn.as_ref(),
        uncertain: tracker.uncertain_text.as_deref(),
        problem: problem.as_ref().map(|problem| (problem.kind, problem.past)),
        failure: problem
            .as_ref()
            .filter(|problem| problem.kind == "failed")
            .and_then(|problem| problem.message.as_deref()),
        activity,
        opening: opening(activity, live.opening).is_some(),
        last_change: tracker.last_change.as_ref(),
        last_response: tracker.last_response.as_deref(),
    });
    let interruption = match &tracker.last_turn {
        _ if activity != "interrupted" => None,
        _ if live.stop == Some(StopState::Unconfirmed) => Some("unconfirmed"),
        Some(turn) if turn.state == ChatTurnState::Interrupted => Some("stopped"),
        Some(turn) if turn.detail.as_deref() == Some(STOPPED_BY_TICKETD) => Some("quit"),
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
        needs_you: status.rank.waits(),
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

/// The state of a Chat no supervisor has reported on: nothing runs.
pub fn idle() -> ChatLive {
    ChatLive {
        activity: Activity::Idle,
        running: false,
        opening: None,
        steering: None,
        delivery_unconfirmed: false,
        sending: Vec::new(),
        interactions: Vec::new(),
        stop: None,
        problem: None,
        context: None,
        settings: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Chat, ChatInteraction, ChatInteractionKind, ChatInteractionState, ChatTool, ChatToolState,
        ChatTurn, ChatTurnState, Item, STOPPED_BY_TICKETD, Step, idle, items, opening, request,
        steps,
    };
    use serde_json::json;
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
                started_at: String::new(),
                ended_at: None,
            }),
            seen_through: 0,
            muted: false,
            created_at: String::new(),
        }
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
    fn claude_code_tools_read_as_their_kind() {
        let done = ChatToolState::Completed;
        let row = |name: &str, input: &str, output: Option<&str>| {
            let step = one(&tool(name, input, done, output));
            (step.kind, step.variant, texts(&step).join(", "))
        };
        let ran = one(&tool(
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
        let read = one(&tool(
            "Read",
            r#"{"file_path":"/work/limiter/src/a.ts","offset":40,"limit":51}"#,
            done,
            None,
        ));
        assert_eq!((read.kind, texts(&read)), ("read", vec!["src/a.ts"]));
        assert_eq!(read.targets[0].lines, Some([40, 90]));
        let grep = one(&tool(
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
        };
        let Item::Request {
            subject, reason, ..
        } = request(&interaction, &idle(), "Codex")
        else {
            panic!("an interaction is a request");
        };
        assert_eq!(subject.as_deref(), Some("touch hello.txt"));
        assert_eq!(reason.as_deref(), Some("Allow creating hello.txt?"));
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
        let mut stopping = idle();
        stopping.stop = Some(StopState::Unconfirmed);
        let state = |chat: &Chat, live: &_| match item(&plan, chat, live, None) {
            Some(Item::Plan { state, .. }) => state,
            other => panic!("a plan, got {other:?}"),
        };
        let running = idle();
        assert_eq!(state(&chat(Some("turn-1")), &running), "running");
        assert_eq!(state(&chat(Some("turn-1")), &stopping), "unconfirmed");
        assert_eq!(state(&chat(None), &running), "ended");

        let thinking = record(
            REASONING_RECORD_NAME,
            r#"{"running":true,"started_at":1,"ended_at":null,"text":null,"heading":null}"#,
            ChatToolState::Running,
        );
        let Some(Item::Reasoning { state, .. }) = item(&thinking, &chat(None), &idle(), None)
        else {
            panic!("reasoning");
        };
        assert_eq!(state, "not_finished");

        let files = record(
            FILES_RECORD_NAME,
            r#"{"files":[{"path":"src/limiter.ts","kind":"added","from":null,"added_lines":48,"removed_lines":0,"confirmed":true}]}"#,
            ChatToolState::Completed,
        );
        let Some(Item::Files { files: shown, .. }) = item(&files, &chat(None), &idle(), None)
        else {
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
        };
        let Item::Request {
            answer, turn_id, ..
        } = request(&interaction, &idle(), "Codex")
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
                started_at: "2026-11-10T10:00:00Z".to_owned(),
                ended_at: Some("2026-11-10T10:00:40Z".to_owned()),
            })
        };
        let outcome = |record: &ChatItem| match items(record, &chat(None), &idle(), None).as_slice()
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
        let step = &steps(&running, "Codex", &chat(Some("turn")), None)[0];
        assert_eq!(
            (step.state, step.started_at.as_deref()),
            ("running", Some("2026-11-10T10:00:05Z"))
        );
    }
}
