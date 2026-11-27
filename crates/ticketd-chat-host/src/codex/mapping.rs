//! Translates app-server traffic into contract events and keeps the protocol data
//! needed to interpret the thread, tools, errors and settings.
//!
//! Everything here is synchronous and runs on the protocol reader in arrival order.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::json_rpc::{Reply, RpcError};
use crate::runtime::RuntimeState;
use crate::{
    ApprovalDecision, DeliveryEvidence, EventKind, InteractionAnswer, InteractionKind,
    InteractionRequest, NativeItemId, NativeRequestId, NativeSessionId, NativeSubAgentId,
    NativeTurnId, NoticeKind, Problem, ProblemKind, ProviderDetail, Question, Refusal,
    SubmissionId, ToolStatus, TurnEvidence, TurnOutcome, reset_time,
};

mod children;

use super::report::{REOPEN_WITH, Reports};
use super::steps::tool_detail;

/// Live tool output kept between a command's start and its authoritative completion.
const MAX_LIVE_TOOL_OUTPUT_BYTES: usize = 64 * 1024;

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

pub(super) fn acknowledged_turn(result: &Value) -> Option<NativeTurnId> {
    result
        .pointer("/turn/id")
        .or_else(|| result.get("turnId"))
        .and_then(Value::as_str)
        .map(NativeTurnId::new)
}

#[derive(Debug)]
pub(super) struct Request {
    id: Value,
    kind: RequestKind,
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
    input: Option<ProviderDetail>,
}

#[derive(Debug, Default)]
pub(super) struct Session {
    thread: Option<String>,
    pub(super) runtime: RuntimeState<Request>,
    tools: HashMap<String, ToolProgress>,
    /// The last non-retried error per turn, for a failed turn that carries none.
    turn_errors: HashMap<String, Value>,
    /// Set for an unattended session: what every `turn/start` adds, which keeps
    /// approvals off and the sandbox as the agent's allowed tools set it.
    pub(super) turn_overrides: Option<Value>,
    rate_limits: Option<Value>,
    /// MCP servers whose failed start was already reported in this session.
    failed_servers: HashSet<String>,
    /// The settings last recorded with the Chat (`NoticeKind::EffectiveSettings`).
    recorded: Option<Value>,
    pub(super) reports: Reports,
    /// The child threads the Chat's thread started: its sub-agents.
    children: Vec<children::Child>,
}

impl Session {
    pub fn thread(&self) -> Option<&str> {
        self.thread.as_deref()
    }

    #[cfg(test)]
    pub fn interrupt_asked(&mut self, turn: &NativeTurnId) {
        self.runtime
            .mark_interrupt(turn)
            .expect("the turn is active");
    }

    pub fn disconnected(&mut self) {
        self.runtime.disconnected();
        self.tools.clear();
        self.children.clear();
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
                let Some(turn) = acknowledged_turn(result) else {
                    return vec![unknown("turn/start reply without a turn", result)];
                };
                if self.runtime.resolve_start(submission)
                    && !matches!(
                        text(result, &["turn", "status"]),
                        Some("completed" | "interrupted" | "failed")
                    )
                {
                    self.runtime.turn_started(&turn);
                }
                let mut events: Vec<_> = self
                    .runtime
                    .acknowledged(submission, &turn, late)
                    .into_iter()
                    .collect();
                // The turn carried the person's choice: the Chat now runs with it.
                events.extend(self.record_choice());
                events
            }
            (Call::Steer(submission), Ok(result)) => match acknowledged_turn(result) {
                Some(turn) => self
                    .runtime
                    .acknowledged(submission, &turn, late)
                    .into_iter()
                    .collect(),
                None => vec![unknown("turn/steer reply without a turn", result)],
            },
            (Call::StartTurn(submission) | Call::Steer(submission), Err(error)) => {
                if matches!(call, Call::StartTurn(_)) && self.runtime.resolve_start(submission) {
                    self.reports.turn_start_rejected();
                }
                late.then(|| EventKind::SubmissionEvidence {
                    submission: submission.clone(),
                    evidence: DeliveryEvidence::Rejected {
                        reason: rejection_reason(error),
                    },
                })
                .into_iter()
                .collect()
            }
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
        let reported = self.reports.thread_opened(result);
        let mut settings = json!({
            "cliVersion": result.pointer("/thread/cliVersion"),
            "model": result.get("model"),
            "modelProvider": result.get("modelProvider"),
            "reasoningEffort": result.get("reasoningEffort"),
            "approvalPolicy": result.get("approvalPolicy"),
            "approvalsReviewer": result.get("approvalsReviewer"),
            "sandbox": result.get("sandbox"),
            "cwd": result.get("cwd"),
            "instructionSources": result.get("instructionSources"),
            // Kept with the Chat, so a later session can leave Full access for them.
            "own": self.reports.own,
        });
        if let Some(choice) = self.reports.permission_choice() {
            settings[REOPEN_WITH] = json!({"permission": choice});
        }
        self.recorded = Some(settings.clone());
        vec![
            EventKind::SessionIdentified {
                native_session: NativeSessionId::new(thread),
            },
            reported,
            EventKind::Notice {
                turn: None,
                kind: NoticeKind::EffectiveSettings,
                message: format!("Model {model}, approval policy {approval}, sandbox {sandbox}"),
                detail: Some(detail("thread/settings", &settings)),
            },
        ]
    }

    /// Records the person's permission choice with the Chat when it differs from the
    /// recorded one, so the Chat shows it, and a session opened for it again applies
    /// it, after a restart too.
    fn record_choice(&mut self) -> Option<EventKind> {
        let choice = self.reports.permission_choice()?;
        let recorded = self.recorded.as_mut()?;
        if recorded[REOPEN_WITH]["permission"].as_str() == Some(choice.as_str()) {
            return None;
        }
        recorded[REOPEN_WITH] = json!({"permission": choice});
        Some(EventKind::Notice {
            turn: None,
            kind: NoticeKind::EffectiveSettings,
            message: format!("Permissions: {choice}"),
            detail: Some(detail("thread/settings", recorded)),
        })
    }

    // -- notifications ------------------------------------------------------------

    pub fn notification(&mut self, method: &str, params: &Value) -> Vec<EventKind> {
        // Another thread of this process is a sub-agent's: what it does is its own, never
        // the Chat's turn.
        if self.is_other_thread(params) {
            return self.child_notification(method, params);
        }
        let events = match method {
            "turn/started" => text(params, &["turn", "id"]).map(|turn| {
                let turn = NativeTurnId::new(turn);
                self.runtime.turn_started(&turn);
                self.reports.turn_started();
                vec![EventKind::TurnStarted { turn, origin: None }]
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
            "serverRequest/resolved" => params.get("requestId").map(|id| {
                self.runtime
                    .resolve_request(&request_key(id))
                    .into_iter()
                    .collect()
            }),
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
        let outcome = match text(turn, &["status"])? {
            "completed" => TurnOutcome::Completed,
            "interrupted" => TurnOutcome::Interrupted,
            "failed" => {
                let stored = self.turn_errors.get(id);
                let error = turn.get("error").filter(|error| !error.is_null());
                TurnOutcome::Failed(self.problem(error.or(stored).unwrap_or(&Value::Null)))
            }
            _ => return None,
        };
        self.turn_errors.remove(id);
        self.tools.clear();
        self.reports.turn_ended(id);
        // Codex reports interruption as an outcome. Unattended denials and
        // commands it could not start are additional observations.
        Some(
            self.runtime
                .end_turn(NativeTurnId::new(id), outcome, |marks| TurnEvidence {
                    interrupt_written: false,
                    denied: Self::denied_reason(marks.denied),
                    not_started: marks.not_started,
                }),
        )
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
        let thread = self.thread().unwrap_or_default().to_owned();
        let mut announced = Vec::new();
        if kind == "collabAgentToolCall" {
            // multi-agent v1: the call that starts a sub-agent is still a Step; its row
            // replaces it once the sub-agent is known.
            announced = self.spawned(&thread, item);
        }
        let events = match kind {
            "subAgentActivity" => self.sub_agent_activity(&thread, item),
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
        announced.extend(events);
        Some(announced)
    }

    /// A user message echoing a submission this runtime wrote is evidence that the
    /// harness is processing it, even when the RPC reply is still outstanding.
    fn user_message(&mut self, turn: &str, item: &Value) -> Vec<EventKind> {
        let Some(submission) = text(item, &["clientId"]).map(SubmissionId::new) else {
            return Vec::new();
        };
        self.runtime
            .processing(submission, NativeTurnId::new(turn))
            .into_iter()
            .collect()
    }

    /// Codex could not start the command, so it never ran: it failed with no process,
    /// the exit code Codex gives a command it could not run (-1), and no time taken.
    /// A command that ran and failed has a process, its own exit code or a duration.
    // ponytail: recognized by shape from items seen live (codex-cli 0.162.1, a Windows
    // sandbox that would not set up: "Failed to create unified exec process: ...");
    // the protocol documents no field for it.
    fn never_started(item: &Value) -> bool {
        let none_or = |field: &str, value: i64| {
            item.get(field)
                .is_none_or(|found| found.is_null() || found.as_i64() == Some(value))
        };
        text(item, &["status"]) == Some("failed")
            && item.get("processId").is_none_or(Value::is_null)
            && none_or("exitCode", -1)
            && none_or("durationMs", 0)
    }

    /// The turn's denials as separate sentences, a file Codex could not change before a
    /// command it could not run. An empty entry stands for a denial not worth naming.
    fn denied_reason(mut denials: Vec<String>) -> Option<String> {
        if denials.is_empty() {
            return None;
        }
        denials.sort_by_key(|denial| !denial.starts_with("Codex could not change"));
        denials.retain(|denial| !denial.is_empty());
        Some(if denials.is_empty() {
            "Codex could not run commands in this step.".to_owned()
        } else {
            denials.join(" ")
        })
    }

    /// What an unattended turn fails on in this item, if anything: a tool Codex
    /// declined, or a file it declined or could not change. Nobody approves for an
    /// unattended session (see `server_request`), so a declined file change is one
    /// outside the folders Codex may write to.
    fn denial(kind: &str, title: &str, item: &Value) -> Option<String> {
        let status = text(item, &["status"])?;
        if kind != "fileChange" {
            // Codex shell-quotes the command, doubling each backslash.
            return (status == "declined")
                .then(|| format!("Codex could not run {}.", title.replace("\\\\", "\\")));
        }
        let paths: Vec<&str> = item
            .get("changes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|change| text(change, &["path"]))
            .collect();
        let why = match status {
            "declined" => "it is outside the step's folder",
            "failed" => "the file could not be written",
            _ => return None,
        };
        Some(format!(
            "Codex could not change {}: {why}.",
            paths.join(", ")
        ))
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
        let turn = NativeTurnId::new(turn);
        if self.turn_overrides.is_some()
            && let Some(denial) = Self::denial(kind, &title, item)
        {
            // ticketd's own guide command is not what the person needs to hear about
            // (#387 5A3): it still ends the turn as failed, with the generic reason.
            let reason = if title.contains("ticketd skills get") {
                String::new()
            } else {
                denial
            };
            self.runtime.mark_denial(&turn, reason);
        }
        if kind == "commandExecution" && self.turn_overrides.is_some() && Self::never_started(item)
        {
            self.runtime.mark_not_started(&turn, || {
                let output = text(item, &["aggregatedOutput"]).unwrap_or_default();
                output
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .unwrap_or("Codex could not start a command and gave no reason.")
                    .to_owned()
            });
        }
        let cut_off = self.runtime.interrupted(&turn);
        let status = item_status(item, completed, cut_off);
        let output = item_output(item);
        let detail = item_detail(kind, item);
        if completed {
            self.tools.remove(id);
        } else {
            let progress = ToolProgress {
                title: title.clone(),
                output: String::new(),
                input: (kind == "commandExecution").then(|| detail.clone()),
            };
            self.tools.insert(id.to_owned(), progress);
        }
        EventKind::ToolUpdated {
            turn,
            item: NativeItemId::new(id),
            title,
            status,
            output,
            detail: Some(detail),
        }
    }

    fn tool_output(&mut self, turn: NativeTurnId, item: NativeItemId, delta: &str) -> EventKind {
        let (title, output, input) = progress_output(&mut self.tools, &item.0, delta);
        EventKind::ToolUpdated {
            turn,
            item,
            title,
            status: ToolStatus::Running,
            output: Some(output),
            detail: input,
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
        if self.runtime.has_request(&request) {
            // Redelivery of a request that is already on screen.
            return (Vec::new(), None);
        }
        if self.turn_overrides.is_some() {
            // Nobody is there to approve: decline, and Codex reports the item declined.
            let result = match method {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    Some(json!({"decision": "decline"}))
                }
                "item/permissions/requestApproval" => Some(json!({"permissions": {}})),
                _ => None,
            };
            if let Some(result) = result {
                return (Vec::new(), Some(json!({"id": id, "result": result})));
            }
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
        let payload = Request {
            id: id.clone(),
            kind,
        };
        // A sub-agent asks on its own turn, which is not the Chat's: the request is the
        // child's, lives as long as the child's turn, and opens no turn of the Chat.
        let (turn, owner, mut events) =
            match text(params, &["threadId"]).filter(|_| self.is_other_thread(params)) {
                Some(thread) => {
                    let child_turn = text(params, &["turnId"]);
                    let events = self.known(thread, child_turn, json!({}));
                    let owner = NativeSubAgentId::new(thread);
                    self.runtime
                        .register_owned_request(request.clone(), owner.clone(), payload);
                    (None, Some(owner), events)
                }
                None => {
                    let turn = text(params, &["turnId"]).map(NativeTurnId::new);
                    self.runtime
                        .register_request(request.clone(), turn.as_ref(), payload);
                    (turn, None, Vec::new())
                }
            };
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request,
            turn,
            owner,
            item,
            kind: shown,
            detail: Some(detail(method, params)),
        }));
        (events, None)
    }

    /// Builds the reply frame for a live request and marks it answered. Nothing is
    /// consumed when the answer does not fit the request.
    pub fn answer(
        &mut self,
        request: &NativeRequestId,
        answer: &InteractionAnswer,
    ) -> Result<Value, Refusal> {
        self.runtime
            .answer(request, |request| request.encode_answer(answer))
    }
}

impl Request {
    fn encode_answer(&self, answer: &InteractionAnswer) -> Result<Value, Refusal> {
        let result = match (&self.kind, answer) {
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
        Ok(json!({"id": self.id, "result": result}))
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

/// How far an item has got, from its own status. `cut_off` is a Stop that ticketd asked
/// for: what then fails is not told as a failure here (#387 3B3).
fn item_status(item: &Value, completed: bool, cut_off: bool) -> ToolStatus {
    match text(item, &["status"]) {
        Some("failed") if cut_off => ToolStatus::FailedAfterInterrupt,
        Some("failed") => ToolStatus::Failed,
        Some("declined") => ToolStatus::Declined,
        Some("inProgress") => ToolStatus::Running,
        Some("completed") => ToolStatus::Succeeded,
        _ if completed => ToolStatus::Succeeded,
        _ => ToolStatus::Running,
    }
}

/// What an item printed or returned.
fn item_output(item: &Value) -> Option<String> {
    text(item, &["aggregatedOutput"])
        .or_else(|| text(item, &["error", "message"]))
        // What a dynamic tool (ticketd's own) returned.
        .or_else(|| item["contentItems"][0]["text"].as_str())
        .map(str::to_owned)
}

/// What an item did, as stored for its Step. The output travels apart from it.
fn item_detail(kind: &str, item: &Value) -> ProviderDetail {
    let mut rest = item.clone();
    if let Some(fields) = rest.as_object_mut() {
        fields.remove("aggregatedOutput");
    }
    tool_detail(kind, &rest)
}

/// Adds the live output of a command to what is kept of it, bounded, and says what the
/// Step shows now: its title, its output so far and what it ran.
fn progress_output(
    tools: &mut HashMap<String, ToolProgress>,
    item: &str,
    delta: &str,
) -> (String, String, Option<ProviderDetail>) {
    let progress = tools.entry(item.to_owned()).or_insert(ToolProgress {
        title: "Command".to_owned(),
        output: String::new(),
        input: None,
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
    (
        progress.title.clone(),
        progress.output.clone(),
        progress.input.clone(),
    )
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
        // ticketd's own tool is shown as the command the agent asked for.
        "dynamicToolCall" if field("tool") == super::ticket_tool::NAME => {
            let arguments = item["arguments"]["arguments"]
                .as_array()
                .into_iter()
                .flatten();
            let words: Vec<&str> = arguments.filter_map(Value::as_str).collect();
            format!("{} {}", super::ticket_tool::NAME, words.join(" "))
                .trim_end()
                .to_owned()
        }
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
