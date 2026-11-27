//! ACP v1 session and Prompt lifecycle. A Prompt's reply ends its Turn.
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io,
    sync::Arc,
};

use agent_client_protocol_schema::{ProtocolVersion, v1 as acp};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{Value, json};
use ticketd_core::ChatAttachmentContent;
use ticketd_core::harnesses::ANTIGRAVITY;
use tokio::sync::mpsc;

use crate::attachment_input::AttachmentFiles;
use crate::json_rpc::{
    self, CallOutcome, Connection, Incoming, Peer, Reply, Response, WriteFailure,
};
use crate::runtime::RuntimeState;
use crate::stdio::Io;
use crate::{
    ADAPTER_CLOSE_TIMEOUT, ApprovalOption, CHECK_TIMEOUT, CloseOutcome, ContextUsage,
    DeliveryEvidence, DispatchOutcome, EventKind, FileChange, HarnessCommand, HarnessRuntime,
    InteractionAnswer, InteractionKind, InteractionRequest, InteractionResponse, InterruptOutcome,
    InterruptRequest, NativeItemId, NativeRequestId, NativeSessionId, NativeSubAgentId,
    NativeTurnId, NoticeKind, OpenRequest, OpenedRuntime, Plan, PlanStep, PlanStepStatus, Problem,
    ProblemKind, ProviderDetail, Refusal, RespondOutcome, RuntimeEvent, SessionStart,
    SettingChange, SettingKey, SettingOutcome, SubAgentOutcome, SubAgentStart, Submission,
    SubmissionId, TurnOutcome,
};

use super::{capabilities, problem, settings, steps};

const MIN_THOUGHT_CHECKPOINT_BYTES: usize = 256;
// Include answered IDs so reusing an ID in the same Prompt can't reopen an approval.
const MAX_PERMISSION_REQUESTS_PER_PROMPT: usize = 32;

enum Call {
    Initialize,
    Open(SessionStart),
    Configure(SettingKey, String),
    Prompt(NativeTurnId),
}

/// The tool the main agent calls to start a sub-agent. It completes at launch and names
/// no child.
const LAUNCH_TOOL: &str = "invoke_subagent";

/// The child conversation a tool call belongs to: its ID is `<childId>:<call id>` when a
/// sub-agent made the call, and a bare call ID when the main agent did.
fn child_of(tool: &acp::ToolCallId) -> Option<&str> {
    tool.0
        .split_once(':')
        .filter(|(child, call)| !child.is_empty() && !call.is_empty())
        .map(|(child, _)| child)
}

/// A launch call that no child has been tied to yet.
struct Launch {
    item: acp::ToolCallId,
    /// The child that made the call; `None` for the main agent.
    owner: Option<String>,
    role: Option<String>,
    brief: Option<String>,
    claimed: bool,
}

/// A sub-agent of this Prompt: a child conversation that made a tool call.
struct Child {
    id: String,
    /// The files its calls changed, apart from the main agent's.
    files: BTreeMap<String, FileChange>,
}

struct Prompt {
    turn: NativeTurnId,
    submission: SubmissionId,
    /// The model the Chat's session ran with when the Prompt was sent. Antigravity names
    /// no model for a sub-agent: it runs with the Chat's.
    model: Option<String>,
    children: Vec<Child>,
    launches: Vec<Launch>,
    message: String,
    message_number: usize,
    quota_diagnostic: Option<String>,
    thought: String,
    checkpointed_thought_bytes: usize,
    tools: HashMap<acp::ToolCallId, steps::Tool>,
    files: BTreeMap<String, FileChange>,
    denied: HashSet<acp::ToolCallId>,
    cancelled_approvals: HashSet<acp::ToolCallId>,
}

impl Prompt {
    fn new(turn: NativeTurnId, submission: SubmissionId, model: Option<String>) -> Self {
        Self {
            turn,
            submission,
            model,
            children: Vec::new(),
            launches: Vec::new(),
            message: String::new(),
            message_number: 0,
            quota_diagnostic: None,
            thought: String::new(),
            checkpointed_thought_bytes: 0,
            tools: HashMap::new(),
            files: BTreeMap::new(),
            denied: HashSet::new(),
            cancelled_approvals: HashSet::new(),
        }
    }
    fn message_item(&self) -> NativeItemId {
        NativeItemId::new(format!("{}:message:{}", self.turn.0, self.message_number))
    }
    fn flush_message(&mut self, events: &mut Vec<EventKind>) {
        if !self.message.is_empty() {
            events.push(EventKind::MessageCompleted {
                item: self.message_item(),
                turn: self.turn.clone(),
                text: std::mem::take(&mut self.message),
            });
            self.message_number += 1;
        }
    }
    fn add_thought(&mut self, text: &str, events: &mut Vec<EventKind>) {
        self.thought.push_str(text);
        // Checkpoints replace the whole report. Doubling their size keeps the
        // bytes copied across an uninterrupted stream proportional to its length.
        let next = self
            .checkpointed_thought_bytes
            .saturating_mul(2)
            .max(MIN_THOUGHT_CHECKPOINT_BYTES);
        if self.checkpointed_thought_bytes == 0 || self.thought.len() >= next {
            self.flush_thought(events);
        }
    }
    fn flush_thought(&mut self, events: &mut Vec<EventKind>) {
        if self.thought.len() > self.checkpointed_thought_bytes {
            self.checkpointed_thought_bytes = self.thought.len();
            events.push(self.thinking(true, self.thought.clone()));
        }
    }
    fn take_thought(&mut self, running: bool) -> EventKind {
        let text = std::mem::take(&mut self.thought);
        self.thinking(running, text)
    }
    fn thinking(&self, running: bool, text: String) -> EventKind {
        EventKind::ReasoningUpdated {
            turn: self.turn.clone(),
            item: NativeItemId::new(format!("{}:thought", self.turn.0)),
            running,
            started_at: None,
            ended_at: None,
            text: Some(text),
            heading: None,
        }
    }
    fn tool_update(&mut self, update: acp::ToolCallUpdate, events: &mut Vec<EventKind>) -> bool {
        let id = update.tool_call_id;
        let tool = self
            .tools
            .entry(id.clone())
            .or_insert_with(|| steps::Tool::new(id.clone()));
        let update_files =
            update.fields.content.is_some() || tool.status() != acp::ToolCallStatus::Completed;
        tool.merge(update.fields);
        self.report_tool(&id, update_files, events)
    }
    fn cancel_approval(&mut self, id: &acp::ToolCallId) {
        // An output-only update can repeat a failure the harness already reported.
        if self.tools.get(id).is_none_or(|tool| {
            matches!(
                tool.status(),
                acp::ToolCallStatus::Pending | acp::ToolCallStatus::InProgress
            )
        }) {
            self.cancelled_approvals.insert(id.clone());
        }
    }
    /// A launch call was seen: the one call that can say what a child was asked, once a
    /// child's own calls show it exists.
    fn note_launch(&mut self, call: &acp::ToolCall) {
        if call.name.as_deref() != Some(LAUNCH_TOOL)
            || self
                .launches
                .iter()
                .any(|launch| launch.item == call.tool_call_id)
        {
            return;
        }
        let said = |key: &str| {
            call.raw_input
                .as_ref()
                .and_then(|input| input[key].as_str())
                .filter(|said| !said.trim().is_empty())
                .map(str::to_owned)
        };
        self.launches.push(Launch {
            item: call.tool_call_id.clone(),
            owner: child_of(&call.tool_call_id).map(str::to_owned),
            role: said("Role"),
            brief: said("Prompt"),
            claimed: false,
        });
    }

    /// A child made its first call in this Prompt: it is a sub-agent from now on. Its launch
    /// call names no child, so it is tied to this one only when it is the single launch no
    /// child has claimed: with several parallel launches the order the children appear in
    /// says nothing of which was which, and a wrong brief is worse than none.
    fn announce(&mut self, child: &str, events: &mut Vec<EventKind>) {
        if self.children.iter().any(|known| known.id == child) {
            return;
        }
        self.children.push(Child {
            id: child.to_owned(),
            files: BTreeMap::new(),
        });
        let mut open = self.launches.iter_mut().filter(|launch| !launch.claimed);
        let launch = match (open.next(), open.next()) {
            (Some(only), None) => Some(only),
            _ => None,
        };
        let mut native = json!({"model": self.model});
        let (mut parent, mut tool) = (None, None);
        if let Some(launch) = launch {
            launch.claimed = true;
            native["description"] = json!(launch.role);
            native["prompt"] = json!(launch.brief);
            parent = launch.owner.as_deref().map(NativeSubAgentId::new);
            tool = Some(NativeItemId::new(launch.item.0.as_ref()));
        }
        events.push(EventKind::SubAgentStarted(SubAgentStart {
            sub_agent: NativeSubAgentId::new(child),
            // Each Prompt is one run: a child seen again in a later one was resumed.
            run: Some(self.turn.0.clone()),
            parent,
            tool,
            // The Prompt is held open until its children finish.
            background: false,
            native,
        }));
    }

    fn report_tool(
        &mut self,
        id: &acp::ToolCallId,
        update_files: bool,
        events: &mut Vec<EventKind>,
    ) -> bool {
        let child = child_of(id).map(str::to_owned);
        if let Some(child) = &child {
            self.announce(child, events);
        }
        let Some(tool) = self.tools.get(id) else {
            return false;
        };
        let declined = self.denied.contains(id);
        let (event, command_unavailable) = tool.observed(
            self.turn.clone(),
            declined,
            self.cancelled_approvals.contains(id),
        );
        events.push(match &child {
            Some(child) => owned_by(event, child),
            None => event,
        });
        let files = match &child {
            Some(child) => self
                .children
                .iter_mut()
                .find(|known| known.id == *child)
                .map(|known| &mut known.files),
            None => Some(&mut self.files),
        };
        let mut files_changed = false;
        if let Some(files) = files
            && update_files
            && !declined
            && tool.status() == acp::ToolCallStatus::Completed
        {
            for file in tool.changes() {
                if files.get(&file.path) != Some(&file) {
                    files.insert(file.path.clone(), file);
                    files_changed = true;
                }
            }
        }
        if files_changed {
            let changed: Vec<_> = match &child {
                Some(child) => self
                    .children
                    .iter()
                    .find(|known| known.id == *child)
                    .map(|known| known.files.values().cloned().collect())
                    .unwrap_or_default(),
                None => self.files.values().cloned().collect(),
            };
            events.push(match child {
                Some(child) => EventKind::SubAgentFilesChanged {
                    sub_agent: NativeSubAgentId::new(child),
                    run: Some(self.turn.0.clone()),
                    files: changed,
                },
                None => EventKind::FilesChanged {
                    turn: self.turn.clone(),
                    files: changed,
                },
            });
        }
        command_unavailable
    }
}

/// A tool event of the main agent, said of a sub-agent's Step instead.
fn owned_by(event: EventKind, child: &str) -> EventKind {
    match event {
        EventKind::ToolUpdated {
            item,
            title,
            status,
            output,
            detail,
            ..
        } => EventKind::SubAgentToolUpdated {
            sub_agent: NativeSubAgentId::new(child),
            item,
            title,
            status,
            output,
            detail,
        },
        other => other,
    }
}

struct Permission {
    rpc_id: Arc<Value>,
    tool: acp::ToolCallId,
    options: Vec<(acp::PermissionOptionId, acp::PermissionOptionKind)>,
}

#[derive(Default, PartialEq, Eq)]
enum PermissionPolicy {
    #[default]
    Own,
    Native,
    Full,
}

#[derive(Default)]
struct Session {
    runtime: RuntimeState<Permission>,
    id: Option<acp::SessionId>,
    image_input: bool,
    prompt: Option<Prompt>,
    attachment_files: Vec<AttachmentFiles>,
    configs: Vec<acp::SessionConfigOption>,
    permission_policy: PermissionPolicy,
    settings_confirmed: bool,
}

impl Session {
    fn opened(&mut self, start: SessionStart, value: &Value) -> Vec<EventKind> {
        let response = match start {
            SessionStart::New => serde_json::from_value::<acp::NewSessionResponse>(value.clone())
                .ok()
                .map(|reply| (reply.session_id, reply.config_options)),
            SessionStart::Resume(session) => {
                serde_json::from_value::<acp::ResumeSessionResponse>(value.clone())
                    .ok()
                    .map(|reply| (acp::SessionId::new(session.0), reply.config_options))
            }
        };
        let Some((session, configs)) = response.filter(|(session, _)| !session.0.is_empty()) else {
            return Vec::new();
        };
        let native_session = NativeSessionId::new(session.0.as_ref());
        self.id = Some(session);
        self.configs = configs.unwrap_or_default();
        vec![EventKind::SessionIdentified { native_session }]
    }

    fn current_permission(&self) -> Option<&str> {
        match self.permission_policy {
            PermissionPolicy::Own => Some(settings::OWN),
            PermissionPolicy::Full => Some(settings::FULL),
            PermissionPolicy::Native => settings::select(&self.configs, SettingKey::Permission)
                .map(|(_, select)| select.current_value.0.as_ref())
                .filter(|value| !matches!(*value, settings::OWN | settings::FULL)),
        }
    }

    fn settings_report(&self) -> EventKind {
        EventKind::SettingsState(settings::reported(&self.configs, self.current_permission()))
    }

    fn settings_update(&self) -> Vec<EventKind> {
        self.settings_confirmed
            .then(|| self.settings_report())
            .into_iter()
            .collect()
    }

    fn configured(&mut self, setting: SettingKey, wanted: String, value: &Value) -> Vec<EventKind> {
        let Ok(reply) =
            serde_json::from_value::<acp::SetSessionConfigOptionResponse>(value.clone())
        else {
            return Vec::new();
        };
        self.configs = reply.config_options;
        if setting == SettingKey::Permission && confirmed(&self.configs, setting, &wanted) {
            self.permission_policy = PermissionPolicy::Native;
        }
        self.settings_update()
    }

    fn updated(&mut self, value: Value) -> Vec<EventKind> {
        let Ok(notice) = serde_json::from_value::<acp::SessionNotification>(value) else {
            return Vec::new();
        };
        if self.id.as_ref() != Some(&notice.session_id) {
            return Vec::new();
        }
        let update = notice.update;
        match update {
            acp::SessionUpdate::AvailableCommandsUpdate(update) => {
                return vec![EventKind::CommandsListed(
                    update
                        .available_commands
                        .into_iter()
                        .map(|command| HarnessCommand {
                            name: command.name,
                            description: Some(command.description),
                        })
                        .collect(),
                )];
            }
            acp::SessionUpdate::ConfigOptionUpdate(update) => {
                self.configs = update.config_options;
                return self.settings_update();
            }
            acp::SessionUpdate::CurrentModeUpdate(update) => {
                return if settings::update_mode(&mut self.configs, update.current_mode_id) {
                    self.settings_update()
                } else {
                    Vec::new()
                };
            }
            acp::SessionUpdate::UsageUpdate(usage) if usage.size > 0 => {
                return vec![EventKind::ContextUsage(ContextUsage {
                    used: usage.used,
                    window: usage.size,
                    categories: Vec::new(),
                    compacts_at: None,
                })];
            }
            _ => {}
        }
        let Some(prompt) = self.prompt.as_mut() else {
            return Vec::new();
        };
        let mut events = Vec::new();
        match update {
            acp::SessionUpdate::AgentMessageChunk(_)
            | acp::SessionUpdate::UserMessageChunk(_)
            | acp::SessionUpdate::AgentThoughtChunk(_)
            | acp::SessionUpdate::ToolCall(_)
            | acp::SessionUpdate::ToolCallUpdate(_)
            | acp::SessionUpdate::Plan(_) => {
                events.extend(
                    self.runtime
                        .processing(prompt.submission.clone(), prompt.turn.clone()),
                );
            }
            _ => return events,
        }
        match update {
            acp::SessionUpdate::AgentMessageChunk(ref chunk)
                if let acp::ContentBlock::Text(text) = &chunk.content =>
            {
                prompt.flush_thought(&mut events);
                prompt.quota_diagnostic =
                    is_quota_diagnostic(&text.text).then(|| text.text.clone());
                prompt.message.push_str(&text.text);
                events.push(EventKind::TextDelta {
                    turn: prompt.turn.clone(),
                    item: prompt.message_item(),
                    text: text.text.clone(),
                });
            }
            acp::SessionUpdate::AgentThoughtChunk(ref chunk)
                if let acp::ContentBlock::Text(text) = &chunk.content =>
            {
                prompt.flush_message(&mut events);
                prompt.add_thought(&text.text, &mut events);
            }
            acp::SessionUpdate::ToolCall(tool) => {
                // A sub-agent's call is not the main agent's: its words go on through it.
                if child_of(&tool.tool_call_id).is_none() {
                    prompt.flush_message(&mut events);
                    prompt.flush_thought(&mut events);
                }
                // The caller is a sub-agent from its first call, so it claims its own launch
                // before the launch it makes is noted.
                if let Some(caller) = child_of(&tool.tool_call_id) {
                    prompt.announce(caller, &mut events);
                }
                prompt.note_launch(&tool);
                let id = tool.tool_call_id.clone();
                prompt
                    .tools
                    .insert(id.clone(), steps::Tool::from_call(tool));
                prompt.report_tool(&id, true, &mut events);
            }
            acp::SessionUpdate::ToolCallUpdate(update) => {
                if child_of(&update.tool_call_id).is_none() {
                    prompt.flush_thought(&mut events);
                }
                prompt.tool_update(update, &mut events);
            }
            acp::SessionUpdate::Plan(plan) => {
                prompt.flush_thought(&mut events);
                events.push(EventKind::PlanUpdated {
                    turn: prompt.turn.clone(),
                    plan: Plan {
                        explanation: None,
                        steps: plan
                            .entries
                            .into_iter()
                            .map(|entry| PlanStep {
                                text: entry.content,
                                active_label: None,
                                status: match entry.status {
                                    acp::PlanEntryStatus::Completed => PlanStepStatus::Completed,
                                    acp::PlanEntryStatus::InProgress => PlanStepStatus::InProgress,
                                    _ => PlanStepStatus::Pending,
                                },
                            })
                            .collect(),
                    },
                });
            }
            _ => {}
        }
        events
    }

    fn permission(&mut self, id: Value, raw: Value) -> (Vec<EventKind>, Option<Response>) {
        let Ok(request) = serde_json::from_value::<acp::RequestPermissionRequest>(raw.clone())
        else {
            return refused(id, -32602, "Invalid Antigravity permission request");
        };
        let Some(prompt) = self
            .prompt
            .as_mut()
            .filter(|_| self.id.as_ref() == Some(&request.session_id))
        else {
            return (
                Vec::new(),
                Some(Response::Immediate(cancelled_permission(&id))),
            );
        };
        // The peer can reuse a wire ID in a later Prompt. Its earlier approval
        // stays stale, including while an approval with the same wire ID is open.
        let native = NativeRequestId::new(format!("{}:{id}", prompt.turn.0));
        if self.runtime.has_request(&native) {
            return (Vec::new(), None);
        }
        if self.runtime.interrupted(&prompt.turn) {
            prompt.cancel_approval(&request.tool_call.tool_call_id);
            return (
                Vec::new(),
                Some(Response::Immediate(cancelled_permission(&id))),
            );
        }
        if self.runtime.request_count() >= MAX_PERMISSION_REQUESTS_PER_PROMPT {
            return refused(
                id,
                -32000,
                "ticketd has reached the Antigravity approval limit for this turn",
            );
        }
        let tool = request.tool_call.tool_call_id.clone();
        let mut seen = HashSet::new();
        let options: Vec<_> = request
            .options
            .into_iter()
            .filter(|option| {
                !option.option_id.0.is_empty() && seen.insert(option.option_id.clone())
            })
            .collect();
        if options.is_empty() {
            return refused(id, -32602, "Antigravity offered no permission choices");
        }
        let shown = options
            .iter()
            .map(|option| ApprovalOption {
                id: option.option_id.0.to_string(),
                label: option.name.clone(),
                warning: option
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.get("agy.security.warning"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
            .collect();
        let mut reason = [
            raw["reason"].as_str(),
            raw["warning"].as_str(),
            raw["toolCall"]["rawInput"]["toolSummary"].as_str(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");
        self.runtime.register_request(
            native.clone(),
            Some(&prompt.turn),
            Permission {
                rpc_id: Arc::new(id),
                options: options
                    .into_iter()
                    .map(|option| (option.option_id, option.kind))
                    .collect(),
                tool: tool.clone(),
            },
        );
        let mut events: Vec<_> = self
            .runtime
            .processing(prompt.submission.clone(), prompt.turn.clone())
            .into_iter()
            .collect();
        if child_of(&tool).is_none() {
            prompt.flush_message(&mut events);
            prompt.flush_thought(&mut events);
        }
        if prompt.tool_update(request.tool_call, &mut events) {
            if !reason.is_empty() {
                reason.insert(0, '\n');
            }
            reason.insert_str(0, "The command is too large for ticketd to show in full.");
        }
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request: native,
            // Registered under the Prompt's turn: Antigravity holds the Prompt open until its
            // children finish, so a child's approval cannot outlive it, and the Prompt's end
            // withdraws it. It is the child's all the same.
            turn: Some(prompt.turn.clone()),
            owner: child_of(&tool).map(NativeSubAgentId::new),
            item: Some(NativeItemId::new(tool.0.as_ref())),
            kind: InteractionKind::NativeApproval {
                description: prompt.tools.get(&tool).map_or_else(
                    || "Tool permission".to_owned(),
                    |tool| tool.title().to_owned(),
                ),
                reason: (!reason.is_empty()).then_some(reason),
                options: shown,
            },
            detail: None,
        }));
        (events, None)
    }

    fn finished(&mut self, turn: NativeTurnId, reply: &Reply) -> Vec<EventKind> {
        let Some(mut prompt) = self.prompt.take_if(|prompt| prompt.turn == turn) else {
            return Vec::new();
        };
        let processing = self
            .runtime
            .processing(prompt.submission.clone(), turn.clone());
        if let Err(error) = reply
            && processing.is_some()
            && matches!(error.code, -32601 | -32602)
        {
            self.runtime
                .end_turn(turn, prompt_outcome(reply), |_| Default::default());
            return vec![EventKind::SubmissionEvidence {
                submission: prompt.submission,
                evidence: DeliveryEvidence::Rejected {
                    reason: error.message.clone(),
                },
            }];
        }
        let mut events: Vec<_> = processing.into_iter().collect();
        prompt.flush_message(&mut events);
        if !prompt.thought.is_empty() {
            events.push(prompt.take_thought(false));
        }
        let outcome = match (prompt_outcome(reply), prompt.quota_diagnostic) {
            (TurnOutcome::Completed, Some(diagnostic)) => {
                TurnOutcome::Failed(problem(ProblemKind::QuotaExhausted, diagnostic))
            }
            (outcome, _) => outcome,
        };
        // Antigravity says nothing of when a sub-agent finishes, and holds the Prompt open
        // until they all have: they end with it. Only a Prompt that succeeded says they
        // did. A Stop cancels them with it, and a failed Prompt says nothing of them: both
        // are left to end with the turn, the way it ended, as in every harness.
        if outcome == TurnOutcome::Completed {
            events.extend(
                prompt
                    .children
                    .iter()
                    .map(|child| EventKind::SubAgentEnded {
                        sub_agent: NativeSubAgentId::new(&child.id),
                        run: Some(turn.0.clone()),
                        outcome: SubAgentOutcome::Completed,
                        detail: None,
                    }),
            );
        }
        events.extend(self.runtime.end_turn(turn, outcome, |_| Default::default()));
        events
    }
}

fn cancelled_permission(id: &Value) -> Value {
    json!({"id": id, "result": {"outcome": {"outcome": "cancelled"}}})
}

fn refused(id: Value, code: i64, message: &str) -> (Vec<EventKind>, Option<Response>) {
    (
        Vec::new(),
        Some(Response::Immediate(
            json!({"id": id, "error": {"code": code, "message": message}}),
        )),
    )
}

fn is_quota_diagnostic(text: &str) -> bool {
    // agy 1.5.15 sends this entire diagnostic as its final text chunk and replies
    // with end_turn. Match its executor framing as well as the HTTP and RPC codes.
    text.strip_prefix("\n⚠ agent executor error: generating and executing: Error 429, Message: ")
        .and_then(|text| text.strip_suffix("]\n"))
        .and_then(|text| text.rsplit_once(", Status: RESOURCE_EXHAUSTED, Details: ["))
        .is_some_and(|(message, _)| !message.is_empty())
}

fn prompt_outcome(reply: &Reply) -> TurnOutcome {
    let response = match reply {
        Ok(value) => serde_json::from_value::<acp::PromptResponse>(value.clone()),
        Err(error) => return TurnOutcome::Failed(rpc_problem(error, ProblemKind::Other)),
    };
    let message = match response.map(|reply| reply.stop_reason) {
        Ok(acp::StopReason::EndTurn) => return TurnOutcome::Completed,
        Ok(acp::StopReason::Cancelled) => return TurnOutcome::Interrupted,
        Ok(acp::StopReason::MaxTokens) => "Antigravity reached its token limit",
        Ok(acp::StopReason::MaxTurnRequests) => {
            "Antigravity reached its request limit for this turn"
        }
        Ok(acp::StopReason::Refusal) => "Antigravity refused to continue this turn",
        Ok(_) | Err(_) => "Antigravity returned an unrecognized turn outcome",
    };
    TurnOutcome::Failed(problem(ProblemKind::Other, message))
}

fn rpc_problem(error: &json_rpc::RpcError, fallback: ProblemKind) -> Problem {
    let lower = error.message.to_ascii_lowercase();
    let authentication_required = "authentication required";
    if error.code == -32000 && lower.contains(authentication_required) {
        let message = if lower.trim().trim_end_matches('.') == authentication_required {
            ANTIGRAVITY.sign_in_guidance
        } else {
            &error.message
        };
        return problem(ProblemKind::LoginRequired, message);
    }
    let kind = if ["quota", "rate limit", "resource_exhausted"]
        .iter()
        .any(|word| lower.contains(word))
    {
        ProblemKind::QuotaExhausted
    } else {
        fallback
    };
    problem(kind, &error.message)
}

impl Peer for Session {
    type Call = Call;

    fn replied(&mut self, call: Call, reply: &Reply, _: bool) -> Vec<EventKind> {
        match (call, reply) {
            (Call::Open(start), Ok(value)) => self.opened(start, value),
            (Call::Prompt(turn), reply) => self.finished(turn, reply),
            (Call::Configure(setting, wanted), Ok(value)) => {
                self.configured(setting, wanted, value)
            }
            _ => Vec::new(),
        }
    }

    fn received(&mut self, incoming: Incoming) -> (Vec<EventKind>, Option<Response>) {
        match incoming {
            Incoming::Notification { method, params } if method == "session/update" => {
                (self.updated(params), None)
            }
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                self.permission(id, params)
            }
            Incoming::Request { id, .. } => {
                refused(id, -32601, "This request is not supported in ticketd")
            }
            _ => (Vec::new(), None),
        }
    }

    fn retain_on_loss(&mut self, events: &mut Vec<EventKind>) {
        if let Some(prompt) = &mut self.prompt
            && prompt.thought.len() > prompt.checkpointed_thought_bytes
        {
            events.push(prompt.take_thought(true));
        }
    }

    fn disconnected(&mut self) {
        self.runtime.disconnected();
        self.prompt = None;
        self.attachment_files.clear();
    }
}

struct AcpRuntime {
    connection: Arc<Connection<Session>>,
}

impl std::fmt::Debug for AcpRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AntigravityRuntime")
            .field("generation", &self.connection.generation())
            .finish_non_exhaustive()
    }
}

impl Drop for AcpRuntime {
    fn drop(&mut self) {
        self.connection.close_on_drop();
    }
}

fn params(request: impl Serialize) -> Result<Value, Problem> {
    serde_json::to_value(request).map_err(|error| {
        problem(
            ProblemKind::Other,
            format!("Could not encode the Antigravity request: {error}"),
        )
    })
}

fn attachment_prompt(
    text: String,
    attachments: Vec<ChatAttachmentContent>,
) -> io::Result<(Vec<acp::ContentBlock>, Option<AttachmentFiles>)> {
    let mut prompt = Vec::new();
    let mut files = None;
    if !text.is_empty() {
        prompt.push(text.into());
    }
    for attachment in attachments {
        if let Some(url) = attachment.image_data_url() {
            let (mime_type, data) = url
                .strip_prefix("data:")
                .and_then(|url| url.split_once(";base64,"))
                .ok_or(io::ErrorKind::InvalidData)?;
            prompt.push(acp::ContentBlock::Image(acp::ImageContent::new(
                data, mime_type,
            )));
        } else {
            let files = match &files {
                Some(files) => files,
                None => files.insert(AttachmentFiles::new()?),
            };
            let path = files.materialize(&attachment)?;
            let path = path.to_str().ok_or(io::ErrorKind::InvalidData)?;
            let reference = json!({"name": attachment.name(), "path": path});
            prompt.push(format!("Read this Chat attachment snapshot: {reference}").into());
        }
    }
    Ok((prompt, files))
}

impl AcpRuntime {
    async fn request(&self, method: &str, value: Value, call: Call) -> Result<Value, Problem> {
        let resumed_session = match &call {
            Call::Open(SessionStart::Resume(session)) => Some(session.clone()),
            _ => None,
        };
        match self.connection.call(method, |_| Ok((value, call))).await {
            CallOutcome::Reply(value) => Ok(value),
            CallOutcome::Error(error) => {
                let kind = if resumed_session.is_some_and(|session| {
                    // agy uses the generic internal error code for this missing-history reply.
                    let missing = error.code == -32603
                        && error.message
                            == format!(
                                "Failed to read session {}; retry, or load it with session/load",
                                session.0
                            );
                    error.code == -32601 || missing
                }) {
                    ProblemKind::NativeHistoryUnavailable
                } else {
                    ProblemKind::Other
                };
                Err(rpc_problem(&error, kind))
            }
            CallOutcome::TimedOut => Err(problem(
                ProblemKind::Other,
                format!("Antigravity did not answer {method}"),
            )),
            CallOutcome::Lost | CallOutcome::Refused(_) => Err(problem(
                ProblemKind::Other,
                format!("Antigravity stopped during {method}"),
            )),
        }
    }

    async fn open_session(&self, request: OpenRequest) -> Result<(), Problem> {
        let hello = acp::InitializeRequest::new(ProtocolVersion::V1).client_info(
            acp::Implementation::new("ticketd", env!("CARGO_PKG_VERSION")),
        );
        let value = self
            .request("initialize", params(hello)?, Call::Initialize)
            .await?;
        let hello: acp::InitializeResponse = serde_json::from_value(value).map_err(|_| {
            problem(
                ProblemKind::IncompatibleVersion,
                "Antigravity did not return an ACP v1 handshake",
            )
        })?;
        if hello.protocol_version != ProtocolVersion::V1 {
            return Err(problem(
                ProblemKind::IncompatibleVersion,
                "Antigravity did not negotiate ACP v1",
            ));
        }
        self.connection.state().peer.image_input =
            hello.agent_capabilities.prompt_capabilities.image;
        let folder = request.working_directory;
        match &request.session {
            SessionStart::New => {
                self.request(
                    "session/new",
                    params(acp::NewSessionRequest::new(folder))?,
                    Call::Open(request.session),
                )
                .await?;
            }
            SessionStart::Resume(session) => {
                if hello
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_none()
                {
                    return Err(problem(
                        ProblemKind::NativeHistoryUnavailable,
                        "Antigravity does not offer native resume",
                    ));
                }
                let resume =
                    acp::ResumeSessionRequest::new(acp::SessionId::new(session.0.clone()), folder);
                self.request(
                    "session/resume",
                    params(resume)?,
                    Call::Open(request.session),
                )
                .await?;
            }
        }
        if self.connection.state().peer.id.is_some() {
            Ok(())
        } else {
            Err(problem(
                ProblemKind::Other,
                "Antigravity did not identify the session",
            ))
        }
    }

    async fn start(
        &self,
        request: OpenRequest,
        permission: String,
        events: mpsc::Sender<RuntimeEvent>,
    ) -> Result<(), Problem> {
        let generation = request.generation;
        let initial = request.settings.clone();
        self.open_session(request).await?;
        let native_permission = (permission != settings::OWN && permission != settings::FULL)
            .then(|| permission.clone());
        let mut requested = [
            (SettingKey::Permission, native_permission),
            (SettingKey::Model, initial.model),
            (SettingKey::Effort, initial.effort),
        ];
        for (setting, value) in &mut requested {
            let Some(wanted) = value else { continue };
            // The model's configuration reply reports the effort choices it supports.
            if *setting == SettingKey::Effort
                && initial.retain_effort_if_supported
                && !settings::select(&self.connection.state().peer.configs, *setting)
                    .is_some_and(|(_, select)| settings::offers(select, wanted))
            {
                *value = None;
                continue;
            }
            let outcome = self.configure(*setting, wanted.clone()).await;
            if outcome != SettingOutcome::Applied {
                return Err(opening_setting_problem(*setting, outcome));
            }
        }
        // A later configuration reply can change an earlier choice. All requested
        // values must be in effect together before the host can send a Prompt.
        let mut state = self.connection.state();
        if state.is_closed() {
            return Err(problem(
                ProblemKind::Other,
                "Antigravity stopped before the session opened",
            ));
        }
        for (setting, value) in requested {
            if let Some(value) = value
                && !confirmed(&state.peer.configs, setting, &value)
            {
                return Err(opening_setting_problem(
                    setting,
                    SettingOutcome::Unconfirmed,
                ));
            }
        }
        let record = params(settings::Record {
            permission: Some(permission),
        })?;
        // Save the startup choice before exposing controls that can replace it.
        let reports = [
            EventKind::Notice {
                turn: None,
                kind: NoticeKind::EffectiveSettings,
                message: "Antigravity confirmed the permission in effect".to_owned(),
                detail: Some(ProviderDetail::new("session/settings", &record.to_string())),
            },
            state.peer.settings_report(),
        ];
        let permits = events.try_reserve_many(reports.len()).map_err(|_| {
            problem(
                ProblemKind::Other,
                "Antigravity sent too many events before the session opened",
            )
        })?;
        for (permit, kind) in permits.zip(reports) {
            permit.send(RuntimeEvent { generation, kind });
        }
        state.peer.settings_confirmed = true;
        Ok(())
    }

    async fn configure(&self, setting: SettingKey, wanted: String) -> SettingOutcome {
        let result = self
            .connection
            .call("session/set_config_option", |session| {
                let id = session.id.clone().ok_or(Refusal::RuntimeClosed)?;
                let (config, select) =
                    settings::select(&session.configs, setting).ok_or(Refusal::Unsupported)?;
                if !settings::offers(select, &wanted) {
                    return Err(Refusal::Unsupported);
                }
                let request = acp::SetSessionConfigOptionRequest::new(
                    id,
                    config.clone(),
                    acp::SessionConfigOptionValue::value_id(wanted.clone()),
                );
                let payload = params(request).map_err(|_| Refusal::Unsupported)?;
                Ok((payload, Call::Configure(setting, wanted.clone())))
            })
            .await;
        match result {
            CallOutcome::Reply(reply)
                if serde_json::from_value::<acp::SetSessionConfigOptionResponse>(reply.clone())
                    .is_ok_and(|reply| confirmed(&reply.config_options, setting, &wanted)) =>
            {
                SettingOutcome::Applied
            }
            CallOutcome::Reply(_) => SettingOutcome::Refused {
                reason: "Antigravity did not confirm the requested setting".to_owned(),
            },
            CallOutcome::Error(error) => SettingOutcome::Refused {
                reason: error.message,
            },
            CallOutcome::Refused(reason) => SettingOutcome::Refused {
                reason: reason.reason().to_owned(),
            },
            CallOutcome::TimedOut | CallOutcome::Lost => SettingOutcome::Unconfirmed,
        }
    }
}

fn confirmed(configs: &[acp::SessionConfigOption], setting: SettingKey, value: &str) -> bool {
    settings::select(configs, setting)
        .is_some_and(|(_, select)| select.current_value.0.as_ref() == value)
}

fn opening_setting_problem(setting: SettingKey, outcome: SettingOutcome) -> Problem {
    let (kind, fallback) = match setting {
        SettingKey::Permission => (
            ProblemKind::PermissionUnavailable,
            "Antigravity did not confirm the requested approval mode",
        ),
        SettingKey::Model | SettingKey::Effort => (
            ProblemKind::Other,
            "Antigravity did not confirm the requested setting",
        ),
    };
    let reason = match outcome {
        SettingOutcome::Refused { reason } => reason,
        _ => fallback.to_owned(),
    };
    problem(kind, reason)
}

pub(super) async fn open(
    io: Io,
    request: OpenRequest,
    permission: String,
) -> Result<OpenedRuntime, Problem> {
    let (connection, events, sender) = Connection::start(
        io,
        Session {
            permission_policy: if permission == settings::FULL {
                PermissionPolicy::Full
            } else {
                PermissionPolicy::Own
            },
            ..Default::default()
        },
        request.generation,
        json_rpc::Options {
            harness: &ANTIGRAVITY,
            include_version: true,
            reply_timeout: CHECK_TIMEOUT,
        },
    );
    let runtime = AcpRuntime { connection };
    if let Err(problem) = runtime.start(request, permission, sender).await {
        runtime.close().await;
        return Err(problem);
    }
    Ok(OpenedRuntime {
        runtime: Arc::new(runtime),
        events,
        capabilities: capabilities(),
    })
}

#[async_trait]
impl HarnessRuntime for AcpRuntime {
    fn supports_image_input(&self) -> Option<bool> {
        Some(self.connection.state().peer.image_input)
    }

    async fn submit(&self, submission: Submission) -> DispatchOutcome {
        let Submission {
            submission,
            generation,
            kind,
            text,
            attachments,
        } = submission;
        let rpc = &self.connection;
        if let Err(refusal) = rpc.check_generation(generation) {
            return DispatchOutcome::NotSent(refusal);
        }
        let (prompt, files) = if attachments.is_empty() {
            (vec![text.into()], None)
        } else {
            if self.supports_image_input() == Some(false)
                && attachments.iter().any(ChatAttachmentContent::is_image)
            {
                return DispatchOutcome::NotSent(Refusal::ImageInputUnsupported);
            }
            let prepared = tokio::task::spawn_blocking(move || {
                attachment_prompt(text, attachments).inspect_err(|error| {
                    tracing::warn!(error_kind = %error.kind(), "chat attachment handoff failed");
                })
            })
            .await;
            let Ok(Ok(prepared)) = prepared else {
                return DispatchOutcome::NotSent(Refusal::AttachmentUnavailable);
            };
            prepared
        };
        let result = rpc
            .send_request("session/prompt", |session| {
                session.runtime.check_submission(&kind, false)?;
                let id = session.id.clone().ok_or(Refusal::RuntimeClosed)?;
                let request = acp::PromptRequest::new(id, prompt);
                let params = params(request).map_err(|_| Refusal::Unsupported)?;
                if let Some(files) = files {
                    session.attachment_files.push(files);
                }
                let turn = NativeTurnId::new(uuid::Uuid::new_v4().to_string());
                session.runtime.turn_started(&turn);
                session.runtime.submission_written(&submission);
                let model = settings::select(&session.configs, SettingKey::Model)
                    .map(|(_, select)| select.current_value.0.to_string());
                session.prompt = Some(Prompt::new(turn.clone(), submission, model));
                Ok((params, Call::Prompt(turn)))
            })
            .await;
        match result {
            Ok(_) => DispatchOutcome::Written,
            Err(WriteFailure::Refused(refusal)) => DispatchOutcome::NotSent(refusal),
            Err(WriteFailure::Lost) => DispatchOutcome::UnknownAfterLoss,
        }
    }

    async fn respond(&self, response: InteractionResponse) -> RespondOutcome {
        self.connection.respond(response.generation, |session| {
            if session.prompt.as_ref().is_some_and(|prompt| session.runtime.interrupted(&prompt.turn)) {
                return Err(Refusal::UnknownRequest);
            }
            let (frame, deny) = session.runtime.answer(&response.request, |request| {
                let InteractionAnswer::NativeApproval(selected) = response.answer else {
                    return Err(Refusal::Unsupported);
                };
                let (option, kind) = request.options.iter().find(|(id, _)| id.0.as_ref() == selected)
                    .ok_or(Refusal::Unsupported)?;
                let deny = matches!(kind, acp::PermissionOptionKind::RejectOnce | acp::PermissionOptionKind::RejectAlways)
                    .then(|| request.tool.clone());
                let result = acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Selected(
                    acp::SelectedPermissionOutcome::new(option.clone()),
                ));
                Ok((json!({"id": request.rpc_id.as_ref(), "result": params(result).map_err(|_| Refusal::Unsupported)?}), deny))
            })?;
            if let Some(tool) = deny && let Some(prompt) = &mut session.prompt { prompt.denied.insert(tool); }
            Ok(frame)
        }).await
    }

    async fn interrupt(&self, request: InterruptRequest) -> InterruptOutcome {
        if let Err(refusal) = self.connection.check_generation(request.generation) {
            return InterruptOutcome::NotSent(refusal);
        }
        let outcome = self
            .connection
            .write_frames(|session| {
                let first_interrupt = !session.runtime.interrupted(&request.expected_turn);
                session.runtime.mark_interrupt(&request.expected_turn)?;
                let id = session.id.clone().ok_or(Refusal::RuntimeClosed)?;
                let payload =
                    params(acp::CancelNotification::new(id)).map_err(|_| Refusal::Unsupported)?;
                let mut pending = Vec::new();
                if first_interrupt && let Some(prompt) = &mut session.prompt {
                    // This is the only active Prompt. Its approvals can leave
                    // the UI before their wire replies finish, and agy can
                    // report their tool failures as soon as it receives cancel.
                    for (_, request) in session.runtime.unanswered() {
                        prompt.cancel_approval(&request.tool);
                        pending.push(Arc::clone(&request.rpc_id));
                    }
                }
                let cancel = json!({"method": "session/cancel", "params": payload});
                Ok(std::iter::once(cancel)
                    .chain(pending.into_iter().map(|id| cancelled_permission(&id))))
            })
            .await;
        match outcome {
            Ok(()) if !self.connection.state().is_closed() => InterruptOutcome::Acknowledged,
            Ok(()) | Err(WriteFailure::Lost) => InterruptOutcome::Unconfirmed,
            Err(WriteFailure::Refused(refusal)) => InterruptOutcome::NotSent(refusal),
        }
    }

    async fn change_setting(&self, change: SettingChange) -> SettingOutcome {
        if let Err(refusal) = self.connection.check_generation(change.generation) {
            return SettingOutcome::Refused {
                reason: refusal.reason().to_owned(),
            };
        }
        if change.setting == SettingKey::Permission {
            let state = self.connection.state();
            if state.is_closed() {
                return SettingOutcome::Refused {
                    reason: Refusal::RuntimeClosed.reason().to_owned(),
                };
            }
            if let Err(refusal) = state
                .peer
                .runtime
                .check_submission(&crate::SubmissionKind::StartTurn, false)
            {
                return SettingOutcome::Refused {
                    reason: refusal.reason().to_owned(),
                };
            }
            let current = state.peer.current_permission();
            if current == Some(change.value.as_str()) {
                return SettingOutcome::Applied;
            }
            if let Some(reason) =
                settings::permission(&state.peer.configs, current).refusal(&change.value)
            {
                return SettingOutcome::Refused { reason };
            }
            if state.peer.permission_policy == PermissionPolicy::Full
                || matches!(change.value.as_str(), settings::OWN | settings::FULL)
            {
                return SettingOutcome::ReopenSession;
            }
        }
        self.configure(change.setting, change.value).await
    }

    async fn close(&self) -> CloseOutcome {
        self.connection
            .close(
                ADAPTER_CLOSE_TIMEOUT,
                "Antigravity ACP",
                "tools it started may still be running",
            )
            .await
    }
}
