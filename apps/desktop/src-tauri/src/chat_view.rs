//! What the Chat screens read: stored Chat records and the host's live state, worded and
//! shaped for display. Nothing here is a harness wire format, and nothing here decides
//! what runs; it only describes what the core and the host already know.
use std::collections::HashMap;

use serde::Serialize;
use ticketd_chat_host::{
    Activity, ApprovalDecision, CONTEXT_RECORD_NAME, ChatLive, ChatProblem, InteractionKind,
    ProblemKind, STOPPED_BY_TICKETD, StopState,
};
use ticketd_core::{
    Chat, ChatDelivery, ChatInteraction, ChatInteractionKind, ChatInteractionState, ChatItem,
    ChatMessage, ChatRole, ChatSessionOrigin, ChatTool, ChatToolState, ChatTurn, ChatTurnState,
};

pub const HARNESSES: [(&str, &str); 2] = [("claude-code", "Claude Code"), ("codex", "Codex")];

pub fn harness_name(id: &str) -> &str {
    HARNESSES
        .iter()
        .find(|(key, _)| *key == id)
        .map_or(id, |(_, name)| name)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub kind: &'static str,
    pub message: Option<String>,
    pub command: Option<String>,
    pub help_url: Option<String>,
    pub path: Option<String>,
    pub message_id: Option<String>,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    pub verb: &'static str,
    pub target: String,
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
    Request {
        id: String,
        at: String,
        request: &'static str,
        title: String,
        subject: Option<String>,
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
    pub interruption: Option<&'static str>,
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
}

/// What a view has to remember from the history it has seen, because a change names
/// one record and says nothing about the others it affects.
#[derive(Debug, Clone, Default)]
pub struct Tracker {
    last_turn: Option<ChatTurn>,
    /// A submission whose delivery the person has to decide about.
    uncertain: Option<String>,
    /// Requests stored as pending; whether one can be answered is the host's live state.
    pending: HashMap<String, ChatInteraction>,
    /// Assistant messages that are not complete; they stop streaming when their turn ends.
    open: HashMap<String, ChatMessage>,
    last_response: Option<String>,
    updated_at: Option<String>,
}

fn delivery(message: &ChatMessage) -> Option<ChatDelivery> {
    message.attempts.last().map(|attempt| attempt.delivery)
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
                if delivery(message) == Some(ChatDelivery::Uncertain) {
                    self.uncertain = Some(message.id.clone());
                } else if self.uncertain.as_ref() == Some(&message.id) {
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
            ChatItem::Session(_) | ChatItem::Tool(_) => {}
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
        options,
        free_text,
        state,
        outcome,
    }
}

fn step(tool: &ChatTool, harness: &str) -> Step {
    if tool.name == CONTEXT_RECORD_NAME {
        return Step {
            verb: "other",
            target: format!("ticketd gave {harness} this Chat's context"),
            result: None,
            output: Some(tool.input.clone()),
        };
    }
    let kind = serde_json::from_str::<serde_json::Value>(&tool.input)
        .ok()
        .and_then(|input| Some(input.get("type")?.as_str()?.to_owned()));
    let (verb, target) = match (kind.as_deref(), tool.name.strip_prefix("Edit ")) {
        (Some("commandExecution"), _) => ("ran", tool.name.as_str()),
        (_, Some(paths)) => ("edited", paths),
        _ => ("other", tool.name.as_str()),
    };
    let outcome = match tool.state {
        ChatToolState::Running | ChatToolState::Completed => None,
        ChatToolState::Failed => Some("failed"),
        ChatToolState::Unknown => Some("outcome unknown"),
    };
    let cut = tool.output_truncated.then_some("output cut short");
    let result: Vec<_> = outcome.into_iter().chain(cut).collect();
    Step {
        verb,
        target: target.to_owned(),
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
            delivery: match delivery(message)? {
                ChatDelivery::Possible => "sending",
                ChatDelivery::Acknowledged => "delivered",
                ChatDelivery::Uncertain => "uncertain",
                // Back in the queue; the row stays so the attempt is not hidden.
                ChatDelivery::NotDelivered | ChatDelivery::Rejected => "not_sent",
            },
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
        ChatItem::Tool(tool) => Item::Steps {
            id: tool.id.clone(),
            at: String::new(),
            steps: vec![step(tool, harness)],
        },
        ChatItem::Interaction(interaction) => request(interaction, live, harness),
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

fn harness_problem(problem: &ticketd_chat_host::Problem) -> Problem {
    let kind = match problem.kind {
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
        message: Some(problem.message.clone()),
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
    if let Some(message_id) = &tracker.uncertain {
        return Some(Problem {
            kind: "uncertain_delivery",
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
        Some(ChatProblem::OpenFailed { problem, .. }) => Some(harness_problem(problem)),
        Some(ChatProblem::RuntimeLost { detail }) => Some(failed(format!(
            "Contact with the harness was lost: {detail}"
        ))),
        Some(ChatProblem::DispatchRefused { detail }) => Some(failed(format!(
            "The harness did not accept the message, so it is back in the queue: {detail}"
        ))),
        Some(ChatProblem::StorageFailed { detail }) => Some(failed(format!(
            "Chat storage failed, so no new work is accepted: {detail}"
        ))),
        Some(ChatProblem::CleanupUnconfirmed { reason }) => Some(unconfirmed(Some(reason.clone()))),
        None if live.stop == Some(StopState::Unconfirmed) => Some(unconfirmed(None)),
        None => None,
    }
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
    ChatState {
        id: chat.id.clone(),
        title: title(chat),
        harness: HarnessRef {
            id: chat.harness.clone(),
            name: name.to_owned(),
            permissions: Some(format!(
                "Uses your own {name} settings and permissions. ticketd changes none of them."
            )),
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
            .filter(|_| activity == "working")
            .map(|turn| Doing {
                label: "Working".to_owned(),
                since: turn.started_at.clone(),
            }),
        catching_up: false,
        steering: Steering {
            available: live.steering.is_some(),
            effect: live.steering.map(|steering| {
                if steering.interrupts_tools {
                    format!("Sending now may interrupt tools {name} is running.")
                } else {
                    format!("{name} takes your message into the turn in progress.")
                }
            }),
        },
        links: around.links.clone(),
        queue: around.queue.clone(),
        queue_paused: chat.queue_paused,
    }
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
        folder_name: (!around.folder_missing).then(|| last_component(&chat.execution_folder)),
        first_ticket: around.links.iter().find_map(|link| match link {
            LinkedRecord::Ticket { reference, .. } => Some(reference.clone()),
            LinkedRecord::Document { .. } => None,
        }),
        retention: retention(chat),
        activity,
        needs_you: !live.interactions.is_empty() || tracker.uncertain.is_some(),
        problem: problem.map(|problem| problem.kind),
        interruption,
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
        steering: None,
        delivery_unconfirmed: false,
        interactions: Vec::new(),
        stop: None,
        problem: None,
    }
}
