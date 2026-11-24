//! ACP v1 session and Prompt lifecycle. A Prompt's reply ends its Turn.
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

use agent_client_protocol_schema::{ProtocolVersion, v1 as acp};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{Value, json};
use ticketd_core::harnesses::ANTIGRAVITY;

use crate::json_rpc::{
    self, CallOutcome, Connection, Incoming, Peer, Reply, Response, WriteFailure,
};
use crate::runtime::RuntimeState;
use crate::stdio::Io;
use crate::{
    ADAPTER_CLOSE_TIMEOUT, ApprovalOption, CHECK_TIMEOUT, CloseOutcome, ContextUsage,
    DeliveryEvidence, DispatchOutcome, EventKind, FileChange, HarnessCommand, HarnessRuntime,
    InteractionAnswer, InteractionKind, InteractionRequest, InteractionResponse, InterruptOutcome,
    InterruptRequest, NativeItemId, NativeRequestId, NativeSessionId, NativeTurnId, OpenRequest,
    OpenedRuntime, Plan, PlanStep, PlanStepStatus, Problem, ProblemKind, Refusal, RespondOutcome,
    SessionStart, SettingChange, SettingKey, SettingOutcome, Submission, SubmissionId, TurnOutcome,
};

use super::{capabilities, problem, settings, steps};

enum Call {
    Initialize,
    Open(SessionStart),
    Configure(SettingKey, String),
    Prompt(NativeTurnId),
}

struct Prompt {
    turn: NativeTurnId,
    submission: SubmissionId,
    message: String,
    message_number: usize,
    thought: String,
    tools: HashMap<acp::ToolCallId, acp::ToolCall>,
    files: BTreeMap<String, FileChange>,
    denied: HashSet<acp::ToolCallId>,
}

impl Prompt {
    fn new(turn: NativeTurnId, submission: SubmissionId) -> Self {
        Self {
            turn,
            submission,
            message: String::new(),
            message_number: 0,
            thought: String::new(),
            tools: HashMap::new(),
            files: BTreeMap::new(),
            denied: HashSet::new(),
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
    fn thinking(&self, running: bool) -> EventKind {
        EventKind::ReasoningUpdated {
            turn: self.turn.clone(),
            item: NativeItemId::new(format!("{}:thought", self.turn.0)),
            running,
            started_at: None,
            ended_at: None,
            text: Some(self.thought.clone()),
            heading: None,
        }
    }
    fn tool_update(&mut self, update: acp::ToolCallUpdate, events: &mut Vec<EventKind>) {
        let id = update.tool_call_id;
        let tool = self
            .tools
            .entry(id.clone())
            .or_insert_with(|| acp::ToolCall::new(id.clone(), "Tool"));
        steps::merge(tool, update.fields);
        self.report_tool(&id, events);
    }
    fn report_tool(&mut self, id: &acp::ToolCallId, events: &mut Vec<EventKind>) {
        let Some(tool) = self.tools.get(id) else {
            return;
        };
        let declined = self.denied.contains(id);
        events.push(steps::observed(tool, self.turn.clone(), declined));
        if !declined && tool.status == acp::ToolCallStatus::Completed {
            for file in steps::changes(tool) {
                self.files.insert(file.path.clone(), file);
            }
        }
        if !self.files.is_empty() {
            events.push(EventKind::FilesChanged {
                turn: self.turn.clone(),
                files: self.files.values().cloned().collect(),
            });
        }
    }
}

struct Permission {
    rpc_id: Value,
    tool: acp::ToolCallId,
    options: Vec<acp::PermissionOption>,
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
    prompt: Option<Prompt>,
    configs: Vec<acp::SessionConfigOption>,
    permission_policy: PermissionPolicy,
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
        vec![
            EventKind::SessionIdentified { native_session },
            self.settings_report(),
        ]
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
        vec![self.settings_report()]
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
                return vec![self.settings_report()];
            }
            acp::SessionUpdate::CurrentModeUpdate(update) => {
                return if settings::update_mode(&mut self.configs, update.current_mode_id) {
                    vec![self.settings_report()]
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
                prompt.thought.push_str(&text.text);
                events.push(prompt.thinking(true));
            }
            acp::SessionUpdate::ToolCall(tool) => {
                prompt.flush_message(&mut events);
                let id = tool.tool_call_id.clone();
                prompt.tools.insert(id.clone(), tool);
                prompt.report_tool(&id, &mut events);
            }
            acp::SessionUpdate::ToolCallUpdate(update) => prompt.tool_update(update, &mut events),
            acp::SessionUpdate::Plan(plan) => {
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
                Some(Response::Immediate(cancelled_permission(id))),
            );
        };
        if self.runtime.interrupted(&prompt.turn) {
            return (
                Vec::new(),
                Some(Response::Immediate(cancelled_permission(id))),
            );
        }
        let native = NativeRequestId::new(id.to_string());
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
            })
            .collect();
        let reason = [
            raw["reason"].as_str(),
            raw["warning"].as_str(),
            raw["toolCall"]["rawInput"]["toolSummary"].as_str(),
        ]
        .into_iter()
        .flatten()
        .chain(
            options
                .iter()
                .filter_map(|option| option.meta.as_ref()?.get("agy.security.warning")?.as_str()),
        )
        .collect::<Vec<_>>()
        .join("\n");
        if !self.runtime.register_request(
            native.clone(),
            Some(&prompt.turn),
            Permission {
                rpc_id: id,
                options,
                tool: tool.clone(),
            },
        ) {
            return (Vec::new(), None);
        }
        let mut events: Vec<_> = self
            .runtime
            .processing(prompt.submission.clone(), prompt.turn.clone())
            .into_iter()
            .collect();
        prompt.flush_message(&mut events);
        prompt.tool_update(request.tool_call, &mut events);
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request: native,
            turn: Some(prompt.turn.clone()),
            item: Some(NativeItemId::new(tool.0.as_ref())),
            kind: InteractionKind::NativeApproval {
                description: prompt
                    .tools
                    .get(&tool)
                    .map_or_else(|| "Tool permission".to_owned(), |tool| tool.title.clone()),
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
            events.push(prompt.thinking(false));
        }
        events.extend(
            self.runtime
                .end_turn(turn, prompt_outcome(reply), |_| Default::default()),
        );
        events
    }
}

fn cancelled_permission(id: Value) -> Value {
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
    if error.code == -32000 && lower.contains("authentication required") {
        return problem(ProblemKind::LoginRequired, ANTIGRAVITY.sign_in_guidance);
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

    fn disconnected(&mut self) {
        self.runtime.disconnected();
        self.prompt = None;
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

impl AcpRuntime {
    async fn request(&self, method: &str, value: Value, call: Call) -> Result<Value, Problem> {
        match self.connection.call(method, |_| Ok((value, call))).await {
            CallOutcome::Reply(value) => Ok(value),
            CallOutcome::Error(error) => {
                let lower = error.message.to_ascii_lowercase();
                let kind = if method == "session/resume"
                    && (error.code == -32601
                        || ["not found", "does not exist", "no conversation"]
                            .iter()
                            .any(|phrase| lower.contains(phrase)))
                {
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

    async fn configure(&self, setting: SettingKey, wanted: String) -> SettingOutcome {
        let result = self
            .connection
            .call("session/set_config_option", |session| {
                let id = session.id.clone().ok_or(Refusal::RuntimeClosed)?;
                let (config, select) =
                    settings::select(&session.configs, setting).ok_or(Refusal::Unsupported)?;
                if !settings::options(select)
                    .iter()
                    .any(|option| option.value.0.as_ref() == wanted)
                {
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

pub(super) async fn open(
    io: Io,
    request: OpenRequest,
    permission: String,
) -> Result<OpenedRuntime, Problem> {
    let (connection, events) = Connection::start(
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
    let initial = request.settings.clone();
    if let Err(problem) = runtime.open_session(request).await {
        runtime.close().await;
        return Err(problem);
    }
    let native_permission =
        (permission != settings::OWN && permission != settings::FULL).then_some(permission);
    for (setting, value) in [
        (SettingKey::Permission, native_permission),
        (SettingKey::Model, initial.model),
        (SettingKey::Effort, initial.effort),
    ] {
        if let Some(value) = value {
            let outcome = runtime.configure(setting, value).await;
            if outcome != SettingOutcome::Applied {
                runtime.close().await;
                let (kind, fallback) = match setting {
                    SettingKey::Permission => (
                        ProblemKind::PermissionUnavailable,
                        "Antigravity did not confirm the requested approval mode",
                    ),
                    _ => (
                        ProblemKind::Other,
                        "Antigravity did not confirm the requested setting",
                    ),
                };
                let reason = match outcome {
                    SettingOutcome::Refused { reason } => reason,
                    _ => fallback.to_owned(),
                };
                return Err(problem(kind, reason));
            }
        }
    }
    Ok(OpenedRuntime {
        runtime: Arc::new(runtime),
        events,
        capabilities: capabilities(),
    })
}

#[async_trait]
impl HarnessRuntime for AcpRuntime {
    async fn submit(&self, submission: Submission) -> DispatchOutcome {
        let rpc = &self.connection;
        if let Err(refusal) = rpc.check_generation(submission.generation) {
            return DispatchOutcome::NotSent(refusal);
        }
        let result = rpc
            .send_request("session/prompt", |session| {
                session.runtime.check_submission(&submission.kind, false)?;
                let id = session.id.clone().ok_or(Refusal::RuntimeClosed)?;
                let request =
                    acp::PromptRequest::new(id, vec![acp::ContentBlock::from(submission.text)]);
                let params = params(request).map_err(|_| Refusal::Unsupported)?;
                let turn = NativeTurnId::new(uuid::Uuid::new_v4().to_string());
                session.runtime.turn_started(Some(&turn));
                session.runtime.submission_written(&submission.submission);
                session.prompt = Some(Prompt::new(turn.clone(), submission.submission));
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
                let option = request.options.iter().find(|option| option.option_id.0.as_ref() == selected)
                    .ok_or(Refusal::Unsupported)?;
                let deny = matches!(option.kind, acp::PermissionOptionKind::RejectOnce | acp::PermissionOptionKind::RejectAlways)
                    .then(|| request.tool.clone());
                let result = acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Selected(
                    acp::SelectedPermissionOutcome::new(option.option_id.clone()),
                ));
                Ok((json!({"id": request.rpc_id, "result": params(result).map_err(|_| Refusal::Unsupported)?}), deny))
            })?;
            if let Some(tool) = deny && let Some(prompt) = &mut session.prompt { prompt.denied.insert(tool); }
            Ok(frame)
        }).await
    }

    async fn interrupt(&self, request: InterruptRequest) -> InterruptOutcome {
        let outcome = self
            .connection
            .respond(request.generation, |session| {
                session.runtime.mark_interrupt(&request.expected_turn)?;
                let id = session.id.clone().ok_or(Refusal::RuntimeClosed)?;
                let payload =
                    params(acp::CancelNotification::new(id)).map_err(|_| Refusal::Unsupported)?;
                Ok(json!({"method": "session/cancel", "params": payload}))
            })
            .await;
        match outcome {
            RespondOutcome::Sent => {
                let pending = self
                    .connection
                    .state()
                    .peer
                    .runtime
                    .unanswered()
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in pending {
                    let result = self
                        .connection
                        .write(|session| {
                            let request = session
                                .runtime
                                .unanswered()
                                .find(|(key, _)| **key == id)
                                .map(|(_, request)| request)
                                .ok_or(Refusal::UnknownRequest)?;
                            Ok(cancelled_permission(request.rpc_id.clone()))
                        })
                        .await;
                    if matches!(result, Err(WriteFailure::Lost)) {
                        return InterruptOutcome::Unconfirmed;
                    }
                }
                InterruptOutcome::Acknowledged
            }
            RespondOutcome::NotSent(refusal) => InterruptOutcome::NotSent(refusal),
            RespondOutcome::UnknownAfterLoss => InterruptOutcome::Unconfirmed,
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
