//! What the Chat screens read: stored Chat records and the host's live state, worded and
//! shaped for display. Nothing here is a harness wire format, and nothing here decides
//! what runs; it only describes what the core and the host already know.
use std::collections::HashMap;

use serde::Serialize;
use ticketd_chat_host::{
    AGENT_CHANGES_RECORD_NAME, Activity, ApprovalDecision, CONTEXT_RECORD_NAME, ChatLive,
    ChatProblem, InteractionKind, ProblemKind, STOPPED_BY_TICKETD, StopState, problem_kind,
};
use ticketd_core::{
    Chat, ChatAgentChange, ChatDelivery, ChatInputStanding, ChatInteraction, ChatInteractionKind,
    ChatInteractionState, ChatItem, ChatMessage, ChatRole, ChatSessionOrigin, ChatTool,
    ChatToolState, ChatTurn, ChatTurnState,
};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    pub verb: &'static str,
    pub target: String,
    /// `running`, `done`, `failed` or `unknown`: a step not `done` is not told as done.
    pub state: &'static str,
    pub result: Option<String>,
    pub output: Option<String>,
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
    },
    Response {
        id: String,
        at: String,
        text: String,
        state: &'static str,
    },
    Steps {
        id: String,
        at: String,
        steps: Vec<Step>,
    },
    /// What the agent changed in ticketd during a turn.
    Records {
        id: String,
        at: String,
        changes: Vec<ChatAgentChange>,
    },
    Request {
        id: String,
        at: String,
        request: &'static str,
        title: String,
        subject: Option<String>,
        /// Why the harness asks, apart from what would run.
        reason: Option<String>,
        options: Vec<RequestOption>,
        free_text: bool,
        state: &'static str,
        outcome: Option<String>,
    },
    Marker {
        id: String,
        at: String,
        reason: &'static str,
        message: Option<String>,
    },
    Session {
        id: String,
        at: String,
        history: &'static str,
        count: usize,
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
    pub links: Vec<LinkedRecord>,
    pub queue: Vec<Queued>,
    pub queue_paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub harness_name: String,
    pub folder_name: Option<String>,
    pub first_ticket: Option<String>,
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
    /// Requests stored as pending; whether one can be answered is the host's live state.
    pending: HashMap<String, ChatInteraction>,
    /// Assistant messages that are not complete; they stop streaming when their turn ends.
    open: HashMap<String, ChatMessage>,
    last_response: Option<String>,
    last_change: Option<ChatAgentChange>,
    updated_at: Option<String>,
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
                } else if self.uncertain.as_ref().map(|(id, _)| id) == Some(&message.id) {
                    self.uncertain = None;
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
        open.chain(pending).collect()
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
    let outcome = interaction
        .response
        .as_deref()
        .filter(|_| state == "answered")
        .map(|response| match response {
            "allow" => "You allowed this once".to_owned(),
            "allow for session" => "You allowed this for the session".to_owned(),
            "deny" => "You denied this".to_owned(),
            answer => format!("You answered: {answer}"),
        });
    Item::Request {
        id: interaction.id.clone(),
        at: String::new(),
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
    }
}

/// The changes kept by the host's record of what the agent changed, if `tool` is one.
fn agent_changes(tool: &ChatTool) -> Option<Vec<ChatAgentChange>> {
    (tool.name == AGENT_CHANGES_RECORD_NAME)
        .then(|| serde_json::from_str(&tool.input).ok())
        .flatten()
}

fn step(tool: &ChatTool, harness: &str) -> Step {
    if tool.name == CONTEXT_RECORD_NAME {
        return Step {
            verb: "other",
            target: format!("ticketd gave {harness} this Chat's context"),
            state: "done",
            result: None,
            output: Some(tool.input.clone()),
        };
    }
    let input = serde_json::from_str::<serde_json::Value>(&tool.input).ok();
    let field = |name: &str| input.as_ref().and_then(|input| input.get(name)?.as_str());
    // Codex names a command step by its command; Claude Code names its tool and
    // passes the command or file in the input.
    let (verb, target) = match (field("type"), tool.name.strip_prefix("Edit ")) {
        (Some("commandExecution"), _) => ("ran", tool.name.as_str()),
        (_, Some(paths)) => ("edited", paths),
        _ => match (tool.name.as_str(), field("command"), field("file_path")) {
            ("Bash" | "PowerShell", Some(command), _) => ("ran", command),
            ("Read", _, Some(path)) => ("read", path),
            ("Edit" | "MultiEdit" | "Write", _, Some(path)) => ("edited", path),
            _ => ("other", tool.name.as_str()),
        },
    };
    let outcome = match tool.state {
        ChatToolState::Running | ChatToolState::Completed => None,
        ChatToolState::Failed => Some("failed"),
        ChatToolState::Unknown => Some("outcome unknown"),
    };
    let cut = tool
        .output_truncated
        .then_some("earlier output cut, ticketd keeps the last 1 MiB");
    let result: Vec<_> = outcome.into_iter().chain(cut).collect();
    Step {
        verb,
        target: target.to_owned(),
        state: match tool.state {
            ChatToolState::Running => "running",
            ChatToolState::Completed => "done",
            ChatToolState::Failed => "failed",
            ChatToolState::Unknown => "unknown",
        },
        result: Some(result.join(", ")).filter(|result| !result.is_empty()),
        output: tool.output.clone(),
    }
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
                },
            }
        }
        ChatItem::Message(message) if message.role == ChatRole::User => Item::User {
            id: message.id.clone(),
            at: message.created_at.clone(),
            text: message.text.clone(),
            delivery: delivery(message, live)?,
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
            }
        }
        ChatItem::Tool(tool) if let Some(changes) = agent_changes(tool) => Item::Records {
            id: tool.id.clone(),
            at: String::new(),
            changes,
        },
        ChatItem::Tool(tool) => Item::Steps {
            id: tool.id.clone(),
            at: String::new(),
            steps: vec![step(tool, harness)],
        },
        ChatItem::Interaction(interaction) => request(interaction, live, harness),
        ChatItem::Notice(notice) => Item::Marker {
            id: notice.id.clone(),
            at: notice.created_at.clone(),
            reason: "note",
            message: Some(notice.text.clone()),
        },
    })
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
        // Only a run's Chat ends this way, and the run says why; in the Chat itself
        // the message is enough.
        ProblemKind::TurnLimitReached | ProblemKind::ToolDenied | ProblemKind::Other => "failed",
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

fn title(chat: &Chat) -> String {
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
            // "Send adds this to the turn in progress" already says the plain case.
            effect: live
                .steering
                .filter(|steering| steering.interrupts_tools)
                .map(|_| format!("Sending now may interrupt tools {name} is running.")),
        },
        links: around.links.clone(),
        queue: around.queue.clone(),
        queue_paused: chat.queue_paused,
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

/// Whether a Chat counts in the sidebar: it waits for an answer or a delivery decision
/// (`asked`), or it Failed. An install or sign-in step is shown on the row and not
/// counted. The desktop's `needsYou` states the same rule for its fixtures.
fn needs_you(asked: bool, activity: &str, problem: Option<&str>) -> bool {
    let setup = matches!(
        problem,
        Some("not_installed" | "incompatible" | "probe_failed" | "not_signed_in")
    );
    asked || (!setup && (activity == "failed" || problem == Some("failed")))
}

pub fn summary(chat: &Chat, live: &ChatLive, tracker: &Tracker, around: &Surroundings) -> Summary {
    let activity = activity(live, tracker);
    let problem = problem(chat, live, tracker, around);
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
        harness_name: harness_name(&chat.harness).to_owned(),
        // A managed folder is named by an id and never shared: the row leaves it out.
        folder_name: (!around.folder_missing && !chat.folder_managed)
            .then(|| last_component(&chat.execution_folder)),
        first_ticket: around.links.iter().find_map(|link| match link {
            LinkedRecord::Ticket { reference, .. } => Some(reference.clone()),
            LinkedRecord::Document { .. } | LinkedRecord::Project { .. } => None,
        }),
        retention: retention(chat),
        activity,
        needs_you: needs_you(
            !live.interactions.is_empty() || tracker.uncertain.is_some(),
            activity,
            problem.as_ref().map(|problem| problem.kind),
        ),
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
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ChatInteraction, ChatInteractionKind, ChatInteractionState, ChatTool, ChatToolState, Item,
        idle, needs_you, opening, request, step,
    };
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

    #[test]
    fn a_claude_command_step_names_the_command_it_ran() {
        let tool = |name: &str, input: &str| ChatTool {
            id: "t".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            name: name.to_owned(),
            input: input.to_owned(),
            state: ChatToolState::Completed,
            output: None,
            output_truncated: false,
        };
        let ran = step(
            &tool("PowerShell", r#"{"command":"ticketd --version"}"#),
            "Claude Code",
        );
        assert_eq!(
            (ran.verb, ran.target.as_str()),
            ("ran", "ticketd --version")
        );
        let read = step(&tool("Read", r#"{"file_path":"src/a.ts"}"#), "Claude Code");
        assert_eq!((read.verb, read.target.as_str()), ("read", "src/a.ts"));
        let other = step(&tool("WebSearch", r#"{"query":"x"}"#), "Claude Code");
        assert_eq!((other.verb, other.target.as_str()), ("other", "WebSearch"));
    }

    /// U4: a command that is waiting for approval, or was refused, is not told as run.
    #[test]
    fn a_step_says_whether_it_finished() {
        let tool = |state| ChatTool {
            id: "t".to_owned(),
            position: 0,
            turn_id: "turn".to_owned(),
            name: "touch hello.txt".to_owned(),
            input: r#"{"type":"commandExecution"}"#.to_owned(),
            state,
            output: None,
            output_truncated: false,
        };
        let states = [
            ChatToolState::Running,
            ChatToolState::Completed,
            ChatToolState::Failed,
            ChatToolState::Unknown,
        ]
        .map(|state| step(&tool(state), "Codex").state);
        assert_eq!(states, ["running", "done", "failed", "unknown"]);
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

    #[test]
    fn the_count_takes_waiting_uncertain_and_failed_chats_but_not_setup_blocks() {
        assert!(needs_you(true, "waiting", None));
        assert!(needs_you(true, "idle", Some("uncertain_delivery")));
        assert!(needs_you(false, "failed", None));
        assert!(needs_you(false, "idle", Some("failed")));
        assert!(needs_you(false, "failed", Some("usage_limit")));
        assert!(!needs_you(false, "failed", Some("not_installed")));
        assert!(!needs_you(false, "idle", Some("not_signed_in")));
        assert!(!needs_you(false, "interrupted", None));
        assert!(!needs_you(false, "working", None));
    }
}
