//! Translates app-server traffic into contract events and tracks what the protocol
//! has told us about the thread: its active turn, live requests and correlations.
//!
//! Everything here is synchronous and runs on the protocol reader in arrival order.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Value, json};

use crate::{
    ApprovalDecision, DeliveryEvidence, EventKind, InteractionAnswer, InteractionKind,
    InteractionRequest, InteractionResolution, NativeItemId, NativeRequestId, NativeSessionId,
    NativeTurnId, NoticeKind, Problem, ProblemKind, ProviderDetail, Question, Refusal,
    SubmissionId, ToolStatus, TurnOutcome, reset_time,
};

use super::report::Reports;
use super::rpc::{Reply, RpcError};

/// Live tool output kept between a command's start and its authoritative completion.
const MAX_LIVE_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
/// Recently ended turns and written submissions remembered for late correlation.
const MAX_REMEMBERED: usize = 64;

/// Notifications that carry nothing a Chat shows. Listed so they are not reported as
/// unknown traffic; anything absent from this list and unmodeled becomes `Unknown`.
const IGNORED_NOTIFICATIONS: &[&str] = &[
    "account/login/completed",
    "account/updated",
    "app/list/updated",
    "hook/completed",
    "hook/started",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress",
    // A new summary part is seen by its first delta; raw reasoning text is not shown.
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
    "mcpServer/startupStatus/updated",
    "modelProvider/authRecoveryCompleted",
    "remoteControl/status/changed",
    "skills/changed",
    "thread/goal/cleared",
    "thread/goal/updated",
    "thread/name/updated",
    "thread/started",
    "thread/status/changed",
];

/// Item types that are neither assistant text nor tool activity.
const IGNORED_ITEMS: &[&str] = &[
    "enteredReviewMode",
    "exitedReviewMode",
    "functionCallOutput",
    "hookPrompt",
    "sleep",
    "subAgentActivity",
];

/// What an outgoing request was for, kept until its reply or its late reply.
#[derive(Debug)]
pub(super) enum Call {
    /// `initialize`, `account/read`, `turn/interrupt`: the caller reads the reply.
    Plain,
    OpenThread,
    StartTurn(SubmissionId),
    Steer(SubmissionId),
    ListModels,
    ListPermissionProfiles,
}

#[derive(Debug)]
struct LiveRequest {
    id: Value,
    turn: Option<String>,
    kind: RequestKind,
    answered: bool,
}

#[derive(Debug)]
enum RequestKind {
    Approval { decisions: Vec<ApprovalDecision> },
    Permissions { requested: Value },
    UserInput,
}

#[derive(Debug)]
struct ToolProgress {
    title: String,
    output: String,
}

#[derive(Debug, Default)]
pub(super) struct Session {
    thread: Option<String>,
    active_turn: Option<NativeTurnId>,
    ended_turns: VecDeque<String>,
    written_submissions: VecDeque<SubmissionId>,
    turn_submissions: HashMap<String, Vec<SubmissionId>>,
    requests: HashMap<NativeRequestId, LiveRequest>,
    tools: HashMap<String, ToolProgress>,
    /// The last non-retried error per turn, for a failed turn that carries none.
    turn_errors: HashMap<String, Value>,
    /// Set for an unattended session: what every `turn/start` adds, which keeps
    /// approvals off and the sandbox as the agent's allowed tools set it.
    pub(super) turn_overrides: Option<Value>,
    /// The tool Codex declined in the open turn of an unattended session.
    declined: Option<String>,
    rate_limits: Option<Value>,
    /// MCP servers whose failed start was already reported in this session.
    failed_servers: HashSet<String>,
    pub(super) reports: Reports,
}

impl Session {
    pub fn thread(&self) -> Option<&str> {
        self.thread.as_deref()
    }

    pub fn active_turn(&self) -> Option<&NativeTurnId> {
        self.active_turn.as_ref()
    }

    /// Remembers a submission about to be written so provider output naming it can be
    /// recognized as evidence.
    pub fn submission_written(&mut self, submission: &SubmissionId) {
        if self.written_submissions.len() == MAX_REMEMBERED {
            self.written_submissions.pop_front();
        }
        self.written_submissions.push_back(submission.clone());
    }

    /// The runtime is gone: nothing is active and no request can be answered.
    pub fn clear_live(&mut self) {
        self.active_turn = None;
        self.requests.clear();
        self.tools.clear();
    }

    // -- replies ------------------------------------------------------------------

    /// Applies a reply in arrival order. `late` means the caller stopped waiting, so
    /// the reply is reported as an event instead of a command outcome.
    pub fn reply(&mut self, call: &Call, reply: &Reply, late: bool) -> Vec<EventKind> {
        match (call, reply) {
            (Call::Plain, _) | (Call::OpenThread, Err(_)) => Vec::new(),
            (Call::ListModels, reply) => {
                let reply = reply.as_ref().map_err(rejection_reason);
                vec![self.reports.models_listed(reply)]
            }
            (Call::ListPermissionProfiles, reply) => {
                let reply = reply.as_ref().map_err(rejection_reason);
                vec![self.reports.profiles_listed(reply)]
            }
            (Call::OpenThread, Ok(result)) => self.thread_opened(result),
            (Call::StartTurn(submission), Ok(result)) => {
                let Some(turn) = text(result, &["turn", "id"]) else {
                    return vec![unknown("turn/start reply without a turn", result)];
                };
                if text(result, &["turn", "status"]) == Some("inProgress") {
                    self.turn_is_active(turn);
                }
                self.acknowledged(submission, turn, late)
            }
            (Call::Steer(submission), Ok(result)) => match text(result, &["turnId"]) {
                Some(turn) => self.acknowledged(submission, turn, late),
                None => vec![unknown("turn/steer reply without a turn", result)],
            },
            (Call::StartTurn(submission) | Call::Steer(submission), Err(error)) if late => {
                vec![EventKind::SubmissionEvidence {
                    submission: submission.clone(),
                    evidence: DeliveryEvidence::Rejected {
                        reason: rejection_reason(error),
                    },
                }]
            }
            (Call::StartTurn(_) | Call::Steer(_), Err(_)) => Vec::new(),
        }
    }

    fn thread_opened(&mut self, result: &Value) -> Vec<EventKind> {
        let Some(thread) = text(result, &["thread", "id"]) else {
            return Vec::new();
        };
        self.thread = Some(thread.to_owned());
        let model = text(result, &["model"]).unwrap_or("unknown");
        let approval = brief(result.get("approvalPolicy"));
        let sandbox = brief(result.get("sandbox"));
        let settings = json!({
            "cliVersion": result.pointer("/thread/cliVersion"),
            "model": result.get("model"),
            "modelProvider": result.get("modelProvider"),
            "reasoningEffort": result.get("reasoningEffort"),
            "approvalPolicy": result.get("approvalPolicy"),
            "approvalsReviewer": result.get("approvalsReviewer"),
            "sandbox": result.get("sandbox"),
            "cwd": result.get("cwd"),
            "instructionSources": result.get("instructionSources"),
        });
        vec![
            EventKind::SessionIdentified {
                native_session: NativeSessionId::new(thread),
            },
            self.reports.thread_opened(result),
            EventKind::Notice {
                turn: None,
                kind: NoticeKind::EffectiveSettings,
                message: format!("Model {model}, approval policy {approval}, sandbox {sandbox}"),
                detail: Some(detail("thread/settings", &settings)),
            },
        ]
    }

    fn acknowledged(
        &mut self,
        submission: &SubmissionId,
        turn: &str,
        late: bool,
    ) -> Vec<EventKind> {
        self.correlate(turn, submission);
        if !late {
            return Vec::new();
        }
        vec![EventKind::SubmissionEvidence {
            submission: submission.clone(),
            evidence: DeliveryEvidence::Acknowledged {
                turn: NativeTurnId::new(turn),
            },
        }]
    }

    /// Returns whether the correlation is new.
    fn correlate(&mut self, turn: &str, submission: &SubmissionId) -> bool {
        if self.ended_turns.iter().any(|ended| ended == turn) {
            return false;
        }
        let submissions = self.turn_submissions.entry(turn.to_owned()).or_default();
        if submissions.contains(submission) {
            return false;
        }
        submissions.push(submission.clone());
        true
    }

    /// A turn that already ended stays ended: its completion may precede the reply
    /// that names it.
    fn turn_is_active(&mut self, turn: &str) {
        if !self.ended_turns.iter().any(|ended| ended == turn) {
            self.active_turn = Some(NativeTurnId::new(turn));
        }
    }

    // -- notifications ------------------------------------------------------------

    pub fn notification(&mut self, method: &str, params: &Value) -> Vec<EventKind> {
        // ponytail: activity on other threads of this process (sub-agents) is not
        // shown; their approvals still arrive as requests. Model them when Chats
        // display sub-agent work.
        if self.is_other_thread(params) {
            return Vec::new();
        }
        let events = match method {
            "turn/started" => text(params, &["turn", "id"]).map(|turn| {
                self.turn_is_active(turn);
                self.reports.turn_started();
                vec![EventKind::TurnStarted {
                    turn: NativeTurnId::new(turn),
                }]
            }),
            "turn/completed" => params
                .get("turn")
                .and_then(|turn| self.turn_completed(turn)),
            "item/started" => self.item(params, false),
            "item/completed" => self.item(params, true),
            "item/agentMessage/delta" => delta(params).map(|(turn, item, text)| {
                vec![EventKind::TextDelta {
                    turn,
                    item,
                    text: text.to_owned(),
                }]
            }),
            // A proposed plan is Markdown, shown like a response.
            "item/plan/delta" => delta(params).map(|(turn, item, text)| {
                vec![EventKind::TextDelta {
                    turn,
                    item,
                    text: text.to_owned(),
                }]
            }),
            "item/commandExecution/outputDelta" => {
                delta(params).map(|(turn, item, text)| vec![self.tool_output(turn, item, text)])
            }
            "item/reasoning/summaryTextDelta" => Some(self.reports.reasoning_delta(params)),
            "turn/plan/updated" => Reports::plan(params).map(|plan| vec![plan]),
            "turn/diff/updated" => Some(self.reports.turn_diff(params).into_iter().collect()),
            "thread/tokenUsage/updated" => Some(Reports::token_usage(params).into_iter().collect()),
            "thread/compacted" => Some(vec![EventKind::Compacted]),
            "thread/settings/updated" => {
                Some(self.reports.settings_updated(params).into_iter().collect())
            }
            "error" => self.error(params),
            "serverRequest/resolved" => params
                .get("requestId")
                .map(|id| self.request_resolved(&request_key(id))),
            "account/rateLimits/updated" => params.get("rateLimits").map(|limits| {
                self.rate_limits = Some(limits.clone());
                Vec::new()
            }),
            "modelProvider/authRecoveryStarted" => Some(vec![notice(
                NoticeKind::Retrying,
                method,
                params,
                "Codex is refreshing its sign-in",
            )]),
            "warning" | "configWarning" | "deprecationNotice" | "guardianWarning" => {
                Some(vec![notice(
                    NoticeKind::Warning,
                    method,
                    params,
                    "Codex reported a warning",
                )])
            }
            // The model that was asked for is not the one answering.
            "model/rerouted" => Some(vec![
                self.reports.rerouted(params),
                EventKind::Notice {
                    turn: text(params, &["turnId"]).map(NativeTurnId::new),
                    kind: NoticeKind::CapabilityUnavailable,
                    message: match (text(params, &["fromModel"]), text(params, &["toModel"])) {
                        (Some(from), Some(to)) => {
                            format!("Codex rerouted this turn from {from} to {to}.")
                        }
                        (_, Some(to)) => format!("Codex rerouted this turn to {to}."),
                        _ => "Codex rerouted this turn to a different model".to_owned(),
                    },
                    detail: Some(detail(method, params)),
                },
            ]),
            // ponytail: the field names come from the app-server schema and were not
            // seen in a live session; any other shape stays ignored, as before.
            "mcpServer/startupStatus/updated" if text(params, &["status"]) == Some("failed") => {
                let server = text(params, &["name"]).unwrap_or("an MCP server");
                let first = self.failed_servers.is_empty();
                // Codex reports a server for the session and again for a thread: one line.
                if !self.failed_servers.insert(server.to_owned()) {
                    return Vec::new();
                }
                let reason = text(params, &["error"]).unwrap_or("no reason given");
                let reason = reason.trim_end().trim_end_matches('.');
                // The recovery applies to every server: said with the first one only.
                let recovery = if first {
                    " Work that does not need it continues; MCP servers are set up in Codex's own MCP settings."
                } else {
                    ""
                };
                Some(vec![EventKind::Notice {
                    turn: None,
                    kind: NoticeKind::CapabilityUnavailable,
                    message: format!(
                        "Codex could not start the MCP server {server}: {reason}.{recovery}"
                    ),
                    detail: Some(detail(method, params)),
                }])
            }
            "windows/worldWritableWarning" => Some(vec![notice(
                NoticeKind::Warning,
                method,
                params,
                "Codex found world-writable folders that weaken its Windows sandbox",
            )]),
            ignored if IGNORED_NOTIFICATIONS.contains(&ignored) => Some(Vec::new()),
            _ => None,
        };
        events.unwrap_or_else(|| vec![unknown(method, params)])
    }

    fn is_other_thread(&self, params: &Value) -> bool {
        match (text(params, &["threadId"]), self.thread()) {
            (Some(named), Some(own)) => named != own,
            _ => false,
        }
    }

    fn turn_completed(&mut self, turn: &Value) -> Option<Vec<EventKind>> {
        let id = text(turn, &["id"])?;
        let declined = self.declined.take();
        let outcome = match text(turn, &["status"])? {
            // Nobody approves for an unattended session, so a declined tool is one
            // the agent needed and was denied, even if it then ended its turn.
            "completed" if declined.is_some() => TurnOutcome::Failed(Problem {
                kind: ProblemKind::ToolDenied,
                message: format!("Codex was denied: {}", declined.unwrap_or_default()),
                detail: None,
                resets_at: None,
            }),
            "completed" => TurnOutcome::Completed,
            "interrupted" => TurnOutcome::Interrupted,
            "failed" => {
                let stored = self.turn_errors.get(id);
                let error = turn.get("error").filter(|error| !error.is_null());
                TurnOutcome::Failed(self.problem(error.or(stored).unwrap_or(&Value::Null)))
            }
            _ => return None,
        };
        if self
            .active_turn
            .as_ref()
            .is_some_and(|active| active.0 == id)
        {
            self.active_turn = None;
        }
        if self.ended_turns.len() == MAX_REMEMBERED {
            self.ended_turns.pop_front();
        }
        self.ended_turns.push_back(id.to_owned());
        self.turn_errors.remove(id);
        self.tools.clear();
        self.reports.turn_ended(id);

        // The turn's unanswered requests can no longer be answered.
        let mut events = Vec::new();
        self.requests.retain(|request, live| {
            if live.turn.as_deref() != Some(id) {
                return true;
            }
            if !live.answered {
                events.push(EventKind::InteractionResolved {
                    request: request.clone(),
                    resolution: InteractionResolution::Withdrawn,
                });
            }
            false
        });
        events.push(EventKind::TurnEnded {
            turn: NativeTurnId::new(id),
            outcome,
            submissions: self.turn_submissions.remove(id).unwrap_or_default(),
        });
        Some(events)
    }

    fn problem(&self, error: &Value) -> Problem {
        let kind = match text(error, &["codexErrorInfo"]) {
            Some("usageLimitExceeded" | "sessionBudgetExceeded") => ProblemKind::QuotaExhausted,
            Some("unauthorized") => ProblemKind::LoginRequired,
            Some("sandboxError" | "tooManyDenials") if self.turn_overrides.is_some() => {
                ProblemKind::ToolDenied
            }
            Some("sandboxError") => ProblemKind::PermissionUnavailable,
            _ => ProblemKind::Other,
        };
        // Reset times come from the rate-limit snapshot, not from the error.
        let payload = match (&self.rate_limits, kind) {
            (Some(limits), ProblemKind::QuotaExhausted) => {
                json!({"error": error, "rateLimits": limits})
            }
            _ => json!({"error": error}),
        };
        Problem {
            kind,
            message: text(error, &["message"])
                .unwrap_or("Codex reported that the turn failed")
                .to_owned(),
            detail: Some(detail("turn/error", &payload)),
            resets_at: (kind == ProblemKind::QuotaExhausted)
                .then(|| self.rate_limits.as_ref().and_then(limit_reset))
                .flatten(),
        }
    }

    fn error(&mut self, params: &Value) -> Option<Vec<EventKind>> {
        let error = params.get("error")?;
        let turn = text(params, &["turnId"]);
        if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
            return Some(vec![EventKind::Notice {
                turn: turn.map(NativeTurnId::new),
                kind: NoticeKind::Retrying,
                message: text(error, &["message"])
                    .unwrap_or("Codex is retrying")
                    .to_owned(),
                detail: Some(detail("error", params)),
            }]);
        }
        // Terminal for the turn; `turn/completed` reports it.
        self.turn_errors.insert(turn?.to_owned(), error.clone());
        Some(Vec::new())
    }

    fn item(&mut self, params: &Value, completed: bool) -> Option<Vec<EventKind>> {
        let item = params.get("item")?;
        let kind = text(item, &["type"])?;
        let id = text(item, &["id"])?;
        let turn = text(params, &["turnId"])?;
        let events = match kind {
            "agentMessage" if completed => vec![EventKind::MessageCompleted {
                turn: NativeTurnId::new(turn),
                item: NativeItemId::new(id),
                text: text(item, &["text"])?.to_owned(),
            }],
            "agentMessage" => Vec::new(),
            "plan" if completed => vec![EventKind::MessageCompleted {
                turn: NativeTurnId::new(turn),
                item: NativeItemId::new(id),
                text: text(item, &["text"])?.to_owned(),
            }],
            "plan" => Vec::new(),
            "reasoning" if completed => vec![self.reports.reasoning_completed(turn, item, params)],
            "reasoning" => vec![self.reports.reasoning_started(turn, item, params)],
            "contextCompaction" if completed => vec![EventKind::Compacted],
            "contextCompaction" => Vec::new(),
            "userMessage" => self.user_message(turn, item),
            ignored if IGNORED_ITEMS.contains(&ignored) => Vec::new(),
            "fileChange" => {
                let title = tool_title(kind, item).unwrap_or_default();
                vec![
                    self.tool(turn, id, kind, title, item, completed),
                    self.reports.file_change(turn, item),
                ]
            }
            _ => match tool_title(kind, item) {
                Some(title) => vec![self.tool(turn, id, kind, title, item, completed)],
                None if completed => vec![unknown(&format!("item/{kind}"), item)],
                None => Vec::new(),
            },
        };
        Some(events)
    }

    /// A user message echoing a submission this runtime wrote is evidence that the
    /// harness is processing it, even when the RPC reply is still outstanding.
    fn user_message(&mut self, turn: &str, item: &Value) -> Vec<EventKind> {
        let Some(submission) = text(item, &["clientId"]).map(SubmissionId::new) else {
            return Vec::new();
        };
        if !self.written_submissions.contains(&submission) || !self.correlate(turn, &submission) {
            return Vec::new();
        }
        vec![EventKind::SubmissionEvidence {
            submission,
            evidence: DeliveryEvidence::Processing {
                turn: NativeTurnId::new(turn),
            },
        }]
    }

    fn tool(
        &mut self,
        turn: &str,
        id: &str,
        kind: &str,
        title: String,
        item: &Value,
        completed: bool,
    ) -> EventKind {
        if text(item, &["status"]) == Some("declined") && self.turn_overrides.is_some() {
            self.declined = Some(title.clone());
        }
        let status = match text(item, &["status"]) {
            Some("failed") => ToolStatus::Failed,
            Some("declined") => ToolStatus::Declined,
            Some("inProgress") => ToolStatus::Running,
            Some("completed") => ToolStatus::Succeeded,
            _ if completed => ToolStatus::Succeeded,
            _ => ToolStatus::Running,
        };
        let output = text(item, &["aggregatedOutput"])
            .or_else(|| text(item, &["error", "message"]))
            .map(str::to_owned);
        // The output travels in `output`; keep it out of the bounded detail.
        let mut rest = item.clone();
        if let Some(fields) = rest.as_object_mut() {
            fields.remove("aggregatedOutput");
        }
        if completed {
            self.tools.remove(id);
        } else {
            let progress = ToolProgress {
                title: title.clone(),
                output: String::new(),
            };
            self.tools.insert(id.to_owned(), progress);
        }
        EventKind::ToolUpdated {
            turn: NativeTurnId::new(turn),
            item: NativeItemId::new(id),
            title,
            status,
            output,
            detail: Some(detail(kind, &rest)),
        }
    }

    fn tool_output(&mut self, turn: NativeTurnId, item: NativeItemId, delta: &str) -> EventKind {
        let progress = self.tools.entry(item.0.clone()).or_insert(ToolProgress {
            title: "Command".to_owned(),
            output: String::new(),
        });
        progress.output.push_str(delta);
        let mut excess = progress
            .output
            .len()
            .saturating_sub(MAX_LIVE_TOOL_OUTPUT_BYTES);
        while !progress.output.is_char_boundary(excess) {
            excess += 1;
        }
        progress.output.drain(..excess);
        // ponytail: each delta re-sends the bounded live tail (64 KiB at most); send
        // increments if profiling in #267 shows this matters.
        EventKind::ToolUpdated {
            turn,
            item,
            title: progress.title.clone(),
            status: ToolStatus::Running,
            output: Some(progress.output.clone()),
            detail: None,
        }
    }

    // -- requests from the harness ------------------------------------------------

    /// Registers a request from the harness. The second value is a frame to write
    /// back at once, used to refuse requests no person can answer through ticketd.
    pub fn server_request(
        &mut self,
        id: &Value,
        method: &str,
        params: &Value,
    ) -> (Vec<EventKind>, Option<Value>) {
        let request = request_key(id);
        if self.requests.contains_key(&request) {
            // Redelivery of a request that is already on screen.
            return (Vec::new(), None);
        }
        let reason = text(params, &["reason"]);
        let (kind, shown) = match method {
            "item/commandExecution/requestApproval" => {
                let decisions = offered_decisions(params);
                (
                    RequestKind::Approval {
                        decisions: decisions.clone(),
                    },
                    InteractionKind::approval(
                        text(params, &["command"]),
                        reason,
                        "Run a command",
                        decisions,
                    ),
                )
            }
            "item/fileChange/requestApproval" => {
                let decisions = offered_decisions(params);
                (
                    RequestKind::Approval {
                        decisions: decisions.clone(),
                    },
                    InteractionKind::approval(None, reason, "Apply file changes", decisions),
                )
            }
            "item/permissions/requestApproval" => (
                RequestKind::Permissions {
                    requested: params.get("permissions").cloned().unwrap_or(json!({})),
                },
                InteractionKind::approval(
                    None,
                    reason,
                    "Grant additional permissions",
                    ALL_DECISIONS.to_vec(),
                ),
            ),
            "item/tool/requestUserInput" => match questions(params) {
                Some(questions) => (
                    RequestKind::UserInput,
                    InteractionKind::Question { questions },
                ),
                None => return refuse(id, method, params),
            },
            _ => return refuse(id, method, params),
        };
        // A command or file change approval names the item it would run or apply.
        let item = matches!(kind, RequestKind::Approval { .. })
            .then(|| text(params, &["itemId"]).map(NativeItemId::new))
            .flatten();
        let turn = text(params, &["turnId"]);
        self.requests.insert(
            request.clone(),
            LiveRequest {
                id: id.clone(),
                turn: turn.map(str::to_owned),
                kind,
                answered: false,
            },
        );
        let requested = EventKind::InteractionRequested(InteractionRequest {
            request,
            turn: turn.map(NativeTurnId::new),
            item,
            kind: shown,
            detail: Some(detail(method, params)),
        });
        (vec![requested], None)
    }

    /// Builds the reply frame for a live request and marks it answered. Nothing is
    /// consumed when the answer does not fit the request.
    pub fn answer(
        &mut self,
        request: &NativeRequestId,
        answer: &InteractionAnswer,
    ) -> Result<Value, Refusal> {
        let live = self
            .requests
            .get_mut(request)
            .filter(|live| !live.answered)
            .ok_or(Refusal::UnknownRequest)?;
        let result = match (&live.kind, answer) {
            (RequestKind::Approval { decisions }, InteractionAnswer::Approval(decision))
                if decisions.contains(decision) =>
            {
                json!({"decision": match decision {
                    ApprovalDecision::Allow => "accept",
                    ApprovalDecision::AllowForSession => "acceptForSession",
                    ApprovalDecision::Deny => "decline",
                }})
            }
            (RequestKind::Permissions { requested }, InteractionAnswer::Approval(decision)) => {
                match decision {
                    ApprovalDecision::Allow => json!({"permissions": requested, "scope": "turn"}),
                    ApprovalDecision::AllowForSession => {
                        json!({"permissions": requested, "scope": "session"})
                    }
                    // Granting nothing is how this request is declined.
                    ApprovalDecision::Deny => json!({"permissions": {}}),
                }
            }
            (RequestKind::UserInput, InteractionAnswer::Answers(answers)) => {
                let answers: serde_json::Map<String, Value> = answers
                    .iter()
                    .map(|answer| {
                        let values = json!({"answers": answer.values});
                        (answer.question_id.clone(), values)
                    })
                    .collect();
                json!({"answers": answers})
            }
            _ => return Err(Refusal::Unsupported),
        };
        live.answered = true;
        Ok(json!({"id": live.id, "result": result}))
    }

    fn request_resolved(&mut self, request: &NativeRequestId) -> Vec<EventKind> {
        let Some(live) = self.requests.remove(request) else {
            return Vec::new();
        };
        let resolution = if live.answered {
            InteractionResolution::Answered
        } else {
            InteractionResolution::Withdrawn
        };
        vec![EventKind::InteractionResolved {
            request: request.clone(),
            resolution,
        }]
    }
}

const ALL_DECISIONS: [ApprovalDecision; 3] = [
    ApprovalDecision::Allow,
    ApprovalDecision::AllowForSession,
    ApprovalDecision::Deny,
];

/// The decisions the harness offers. `availableDecisions` is documented but absent
/// from the 0.162.1 schema, so it narrows the default only when present. Decisions
/// that amend policy are not offered through ticketd.
fn offered_decisions(params: &Value) -> Vec<ApprovalDecision> {
    let Some(available) = params.get("availableDecisions").and_then(Value::as_array) else {
        return ALL_DECISIONS.to_vec();
    };
    let mut decisions: Vec<ApprovalDecision> = available
        .iter()
        .filter_map(|decision| match decision.as_str() {
            Some("accept") => Some(ApprovalDecision::Allow),
            Some("acceptForSession") => Some(ApprovalDecision::AllowForSession),
            Some("decline") => Some(ApprovalDecision::Deny),
            _ => None,
        })
        .collect();
    // Declining is part of every approval response in the protocol.
    if !decisions.contains(&ApprovalDecision::Deny) {
        decisions.push(ApprovalDecision::Deny);
    }
    decisions
}

fn questions(params: &Value) -> Option<Vec<Question>> {
    let questions = params.get("questions")?.as_array()?;
    questions
        .iter()
        .map(|question| {
            let options = question.get("options").and_then(Value::as_array);
            Some(Question {
                id: text(question, &["id"])?.to_owned(),
                prompt: text(question, &["question"])?.to_owned(),
                options: options
                    .into_iter()
                    .flatten()
                    .filter_map(|option| text(option, &["label"]))
                    .map(str::to_owned)
                    .collect(),
                multi_select: false,
            })
        })
        .collect()
}

/// Refuses a request ticketd cannot put in front of a person. It is never approved.
fn refuse(id: &Value, method: &str, params: &Value) -> (Vec<EventKind>, Option<Value>) {
    let reply = if method == "mcpServer/elicitation/request" {
        // ponytail: MCP elicitation forms are declined; render them as questions when
        // a Chat needs MCP servers that ask for input.
        json!({"id": id, "result": {"action": "decline"}})
    } else {
        let message = format!("ticketd does not handle {method}");
        json!({"id": id, "error": {"code": -32601, "message": message}})
    };
    (vec![unknown(method, params)], Some(reply))
}

fn tool_title(kind: &str, item: &Value) -> Option<String> {
    let field = |name: &str| text(item, &[name]).unwrap_or("");
    Some(match kind {
        "commandExecution" => field("command").to_owned(),
        "fileChange" => {
            let paths: Vec<&str> = item
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|change| text(change, &["path"]))
                .collect();
            format!("Edit {}", paths.join(", "))
        }
        "mcpToolCall" => format!("{}.{}", field("server"), field("tool")),
        "dynamicToolCall" | "collabAgentToolCall" => field("tool").to_owned(),
        "webSearch" => format!("Web search: {}", field("query")),
        "imageView" => format!("View image {}", field("path")),
        "imageGeneration" => "Generate image".to_owned(),
        _ => return None,
    })
}

fn delta(params: &Value) -> Option<(NativeTurnId, NativeItemId, &str)> {
    Some((
        NativeTurnId::new(text(params, &["turnId"])?),
        NativeItemId::new(text(params, &["itemId"])?),
        text(params, &["delta"])?,
    ))
}

/// When an exhausted limit resets: the latest reset among the windows the snapshot
/// shows as used up. `None` when no window is, or none says when.
fn limit_reset(limits: &Value) -> Option<i64> {
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|window| limits.get(window))
        .filter(|window| window.get("usedPercent").and_then(Value::as_f64) >= Some(100.0))
        .filter_map(|window| reset_time(window.get("resetsAt")?))
        .max()
}

fn notice(kind: NoticeKind, method: &str, params: &Value, fallback: &str) -> EventKind {
    EventKind::Notice {
        turn: text(params, &["turnId"]).map(NativeTurnId::new),
        kind,
        message: text(params, &["message"])
            .or_else(|| text(params, &["summary"]))
            .unwrap_or(fallback)
            .to_owned(),
        detail: Some(detail(method, params)),
    }
}

pub(super) fn unknown(what: &str, payload: &Value) -> EventKind {
    EventKind::Unknown {
        summary: format!("Unrecognized Codex message: {what}"),
        detail: detail(what, payload),
    }
}

pub(super) fn rejection_reason(error: &RpcError) -> String {
    format!("{} (code {})", error.message, error.code)
}

fn detail(kind: &str, payload: &Value) -> ProviderDetail {
    ProviderDetail::new(kind, &payload.to_string())
}

fn request_key(id: &Value) -> NativeRequestId {
    match id {
        Value::String(id) => NativeRequestId::new(id.as_str()),
        other => NativeRequestId::new(other.to_string()),
    }
}

/// A short rendering of a setting that is either a name or a tagged object.
fn brief(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(name)) => name.clone(),
        Some(Value::Object(fields)) => match fields.get("type").and_then(Value::as_str) {
            Some(kind) => kind.to_owned(),
            None => fields.keys().next().cloned().unwrap_or_default(),
        },
        _ => "unknown".to_owned(),
    }
}

fn text<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |value, key| value.get(key))?
        .as_str()
}
