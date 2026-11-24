//! Translates bridge session events into contract events and tracks what they have
//! told us: the open turn, live requests, tools and streamed text.
//!
//! Everything here is synchronous and runs on the protocol reader in arrival order.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Map, Value, json};

use crate::runtime::RuntimeState;
use crate::{
    ApprovalDecision, DeliveryEvidence, EventKind, HarnessCommand, InteractionAnswer,
    InteractionKind, InteractionRequest, InteractionResolution, NativeItemId, NativeRequestId,
    NativeSessionId, NativeTurnId, NoticeKind, Problem, ProblemKind, ProviderDetail, Question,
    Refusal, SettingKey, SubmissionId, ToolStatus, TurnEvidence, TurnOutcome, reset_time,
};

use super::report::{PLAN_TOOLS, Reports};

/// Where the Chat's record keeps the permission mode a reopened session asks with
/// (#408). Only a record written each time the mode changes has it: one an earlier
/// ticketd wrote kept a session's first report, maybe a mode the person has left since.
pub(super) const REOPEN_WITH: &str = "reopen_with";

#[derive(Debug)]
struct Request {
    /// For a question: whether each question takes several answers, by question id.
    /// `None` for a permission request.
    questions: Option<HashMap<String, bool>>,
    /// For a permission request: the tool use it asks about.
    tool_use: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct Session {
    turns_started: u64,
    items_started: u64,
    runtime: RuntimeState<Request>,
    turn_error: Option<String>,
    native_session: Option<String>,
    /// The settings last reported in effect. The Chat keeps them: a resumed session
    /// is opened with them, as Claude Code's own resume does not keep them (#408).
    reported_settings: Option<Value>,
    /// Name and input of each tool the open turn started, by tool-use id.
    tools: HashMap<String, (String, ProviderDetail)>,
    /// Tool uses the person declined: their error result is the refusal, not a failure.
    declined: HashSet<String>,
    /// Text blocks being streamed, oldest first, by content block index.
    streams: VecDeque<(i64, NativeItemId)>,
    /// When the limit Claude Code last reported as exhausted resets, if it said.
    limit_resets_at: Option<i64>,
    /// Nobody approves for this session: a tool Claude Code denied fails the turn.
    unattended: bool,
    reports: Reports,
}

fn text<'a>(event: &'a Value, field: &str) -> Option<&'a str> {
    event.get(field).and_then(Value::as_str)
}

fn strings(event: &Value, field: &str) -> Vec<String> {
    let items = event.get(field).and_then(Value::as_array);
    let items = items.into_iter().flatten().filter_map(Value::as_str);
    items.map(str::to_owned).collect()
}

pub(super) fn unknown(summary: &str, kind: &str, payload: &Value) -> EventKind {
    EventKind::Unknown {
        summary: summary.to_owned(),
        detail: ProviderDetail::new(kind, &payload.to_string()),
    }
}

/// A tool result as shown: the bridge keeps the end of a long one, so the note that
/// something is missing goes where it is missing.
pub(super) fn tool_output(text: &str, truncated: bool) -> String {
    if truncated {
        format!("[earlier output truncated]\n{text}")
    } else {
        text.to_owned()
    }
}

impl Session {
    pub fn active_turn(&self) -> Option<&NativeTurnId> {
        self.runtime.active_turn_id()
    }

    pub fn interrupt_written(&mut self) {
        if let Some(turn) = self.active_turn().cloned() {
            let _ = self.runtime.mark_interrupt(&turn);
        }
    }

    /// The session runs an Automation's agent, with nobody there to approve.
    pub fn mark_unattended(&mut self) {
        self.unattended = true;
        self.reports.unattended();
    }

    /// The runtime is gone: nothing is live any more.
    pub fn clear_live(&mut self) {
        self.runtime.disconnected();
        self.turn_error = None;
        self.tools.clear();
        self.declined.clear();
        self.streams.clear();
    }

    /// The open turn, opening one when Claude Code shows activity outside a turn.
    /// Claude Code has no turn identity, so the id is local to this runtime.
    fn turn(&mut self, events: &mut Vec<EventKind>) -> NativeTurnId {
        if let Some(turn) = self.active_turn() {
            return turn.clone();
        }
        self.turns_started += 1;
        let id = NativeTurnId(format!("local-turn-{}", self.turns_started));
        self.runtime.turn_started(Some(&id));
        events.push(EventKind::TurnStarted { turn: id.clone() });
        id
    }

    fn identify(&mut self, native_session: Option<&str>, events: &mut Vec<EventKind>) {
        let Some(native_session) = native_session else {
            return;
        };
        if self.native_session.as_deref() != Some(native_session) {
            self.native_session = Some(native_session.to_owned());
            events.push(EventKind::SessionIdentified {
                native_session: NativeSessionId::new(native_session),
            });
        }
    }

    /// Applies one session event. `None` when the event is not one this module
    /// models; the caller reports it as unknown traffic.
    pub fn event(&mut self, name: &str, event: &Value) -> Option<(Vec<EventKind>, Option<Value>)> {
        let mut events = Vec::new();
        let mut decline = None;
        match name {
            "session_info" => self.session_info(event, &mut events),
            "input_processing" => {
                let turn = self.turn(&mut events);
                for submission in strings(event, "submission_ids") {
                    events.push(EventKind::SubmissionEvidence {
                        submission: SubmissionId(submission),
                        evidence: DeliveryEvidence::Processing { turn: turn.clone() },
                    });
                }
            }
            "delta" => self.delta(event, &mut events),
            "thinking" => {
                let turn = self.turn(&mut events);
                events.extend(self.reports.thinking(&turn, event));
            }
            "context_usage" => events.extend(Reports::context(event)),
            "compacted" => events.push(EventKind::Compacted),
            "assistant_content" => self.assistant_content(event, &mut events),
            "tool_result" => self.tool_result(event, &mut events),
            "permission_request" => self.permission_request(event, &mut events),
            "question_request" => decline = self.question_request(event, &mut events),
            "request_resolved" => {
                self.request_gone(event, InteractionResolution::Answered, &mut events)
            }
            "request_cancelled" => {
                self.request_gone(event, InteractionResolution::Withdrawn, &mut events);
            }
            "turn_result" => self.turn_result(event, &mut events),
            // The bridge passes rate-limit changes through as they are. They are kept
            // for the failure they explain and are not shown as unknown traffic.
            "sdk_message_unmapped" if text(event, "sdk_type") == Some("rate_limit_event") => {
                let info = text(event, "json")
                    .and_then(|json| serde_json::from_str::<Value>(json).ok())
                    .map(|message| message["rate_limit_info"].clone())
                    .unwrap_or_default();
                // ponytail: `resetsAt` is taken as seconds (milliseconds if too large
                // for that), from the Agent SDK types; confirm with a live session (#264).
                self.limit_resets_at = (info["status"] == "rejected")
                    .then(|| reset_time(&info["resetsAt"]))
                    .flatten();
            }
            // Frames with no event of their own are session housekeeping (status, hook
            // and command lifecycle), "safe to ignore" by the bridge protocol. Requests
            // that need an answer always arrive as events of their own, so nothing
            // the person must act on is dropped here.
            "sdk_message_unmapped" => {}
            _ => return None,
        }
        Some((events, decline))
    }

    fn session_info(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        self.identify(text(event, "session_id"), events);
        let mut reopen_with = json!({"permission_mode": event.get("permission_mode")});
        // Claude Code resumes no effort either: the one in effect is kept to reopen with.
        if let Some(effort) = text(event, "effort").or_else(|| self.reports.effort()) {
            reopen_with["effort"] = json!(effort);
        }
        let settings = json!({
            "claude_code_version": event.get("claude_code_version"),
            "cwd": event.get("cwd"),
            "model": event.get("model"),
            "permission_mode": event.get("permission_mode"),
            REOPEN_WITH: reopen_with,
        });
        events.extend(self.report_settings(settings));
        events.extend(self.reports.session_info(event));
    }

    /// A model, effort or permission mode Claude Code applied mid-session, kept with
    /// the settings in effect so a resumed session opens with it.
    pub fn setting_applied(&mut self, setting: SettingKey, value: &str) -> Option<EventKind> {
        let mut settings = self.reported_settings.clone()?;
        match setting {
            SettingKey::Model => settings["model"] = json!(value),
            SettingKey::Permission => {
                settings["permission_mode"] = json!(value);
                settings[REOPEN_WITH]["permission_mode"] = json!(value);
            }
            SettingKey::Effort => settings[REOPEN_WITH]["effort"] = json!(value),
        }
        self.report_settings(settings)
    }

    /// The settings in effect, said each time they change.
    fn report_settings(&mut self, settings: Value) -> Option<EventKind> {
        if self.reported_settings.as_ref() == Some(&settings) {
            return None;
        }
        let detail = ProviderDetail::new("session_info", &settings.to_string());
        self.reported_settings = Some(settings);
        Some(EventKind::Notice {
            turn: None,
            kind: NoticeKind::EffectiveSettings,
            message: "Claude Code reported the settings in effect".to_owned(),
            detail: Some(detail),
        })
    }

    /// The effort the person picked, or a change Claude Code applied: in effect
    /// until Claude Code reports another.
    pub fn effort_in_effect(&mut self, effort: Option<String>) {
        self.reports.effort_in_effect(effort);
    }

    /// `session_initialized`: the session's choosable settings and slash commands.
    pub fn initialized(&mut self, event: &Value) -> Vec<EventKind> {
        let mut events: Vec<EventKind> = self.reports.initialized(event).into_iter().collect();
        // A bridge that does not list commands says nothing about them.
        let Some(listed) = event["commands"].as_array() else {
            return events;
        };
        let commands = listed
            .iter()
            .filter_map(|command| {
                Some(HarnessCommand {
                    name: text(command, "name")
                        .filter(|name| !name.is_empty())?
                        .to_owned(),
                    description: text(command, "description")
                        .filter(|text| !text.is_empty())
                        .map(str::to_owned),
                })
            })
            .collect();
        events.insert(0, EventKind::CommandsListed(commands));
        events
    }

    fn delta(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        // Thinking is not shown, and a sub-agent's text is not the assistant's reply.
        if text(event, "kind") != Some("text") || !event["parent_tool_use_id"].is_null() {
            return;
        }
        let turn = self.turn(events);
        let index = event.get("index").and_then(Value::as_i64).unwrap_or(-1);
        let item = match self.streams.iter().find(|(open, _)| *open == index) {
            Some((_, item)) => item.clone(),
            None => {
                let item = self.new_item();
                self.streams.push_back((index, item.clone()));
                item
            }
        };
        events.push(EventKind::TextDelta {
            turn,
            item,
            text: text(event, "text").unwrap_or_default().to_owned(),
        });
    }

    fn new_item(&mut self) -> NativeItemId {
        self.items_started += 1;
        NativeItemId(format!("text-{}", self.items_started))
    }

    fn assistant_content(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let turn = self.turn(events);
        if let Some(error) = text(event, "error") {
            self.turn_error = Some(error.to_owned());
            events.push(EventKind::Notice {
                turn: Some(turn.clone()),
                kind: NoticeKind::Warning,
                message: format!("Claude Code reported an error: {error}"),
                detail: None,
            });
        }
        let from_sub_agent = !event["parent_tool_use_id"].is_null();
        let blocks = event.get("blocks").and_then(Value::as_array);
        for block in blocks.into_iter().flatten() {
            match text(block, "type") {
                // Blocks complete in the order their streams began.
                Some("text") if !from_sub_agent => {
                    let item = match self.streams.pop_front() {
                        Some((_, item)) => item,
                        None => self.new_item(),
                    };
                    events.push(EventKind::MessageCompleted {
                        turn: turn.clone(),
                        item,
                        text: text(block, "text").unwrap_or_default().to_owned(),
                    });
                }
                Some("thinking") if !from_sub_agent => {
                    let said = text(block, "text").unwrap_or_default();
                    events.push(self.reports.thinking_text(&turn, said));
                }
                Some("text" | "thinking") => {}
                // Redacted thinking has no text to show; its block start was reported.
                Some("other") if text(block, "block_type") == Some("redacted_thinking") => {}
                Some("tool_use") => {
                    let Some(id) = text(block, "id") else {
                        events.push(unknown("a tool use without an id", "tool_use", block));
                        continue;
                    };
                    let title = text(block, "name").unwrap_or("tool").to_owned();
                    // The plan has no step rows: its tools update the plan instead.
                    if PLAN_TOOLS.contains(&title.as_str()) {
                        events.extend(self.reports.plan_tool(&turn, id, &title, &block["input"]));
                        continue;
                    }
                    let changed = self.reports.file_tool(&turn, id, &title, &block["input"]);
                    self.observe_tool_input(&turn, id, &title, &block["input"], events);
                    events.extend(changed);
                }
                _ => events.push(unknown(
                    "Claude Code sent content ticketd does not show",
                    text(block, "block_type").unwrap_or("content"),
                    block,
                )),
            }
        }
    }

    /// A permission callback and assistant content can both carry this tool's input.
    fn observe_tool_input(
        &mut self,
        turn: &NativeTurnId,
        id: &str,
        title: &str,
        input: &Value,
        events: &mut Vec<EventKind>,
    ) {
        let previous = self.tools.get(id);
        let merged = previous
            .and_then(|(_, detail)| {
                serde_json::from_str::<Map<String, Value>>(detail.payload()).ok()
            })
            .map(|mut kept| {
                if let Some(incoming) = input.as_object() {
                    kept.extend(
                        incoming
                            .iter()
                            .filter(|(_, value)| !value.is_null())
                            .map(|(key, value)| (key.clone(), value.clone())),
                    );
                }
                Value::Object(kept)
            });
        let detail = tool_detail(title, "tool_use", merged.as_ref().unwrap_or(input));
        if previous.is_some_and(|(name, kept)| name == title && kept.payload() == detail.payload())
        {
            return;
        }
        self.tools
            .insert(id.to_owned(), (title.to_owned(), detail.clone()));
        events.push(EventKind::ToolUpdated {
            turn: turn.clone(),
            item: NativeItemId::new(id),
            title: title.to_owned(),
            status: ToolStatus::Running,
            output: None,
            detail: Some(detail),
        });
    }

    fn tool_result(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let failed = event["is_error"] == true;
        let tool_use = text(event, "tool_use_id").unwrap_or_default();
        if self.reports.is_plan_tool(tool_use) {
            let turn = self.turn(events);
            events.extend(
                self.reports
                    .plan_result(&turn, tool_use, failed, &event["outcome"]),
            );
            return;
        }
        let declined = text(event, "tool_use_id").is_some_and(|id| self.declined.remove(id));
        let known = text(event, "tool_use_id").and_then(|id| Some((id, self.tools.get(id)?)));
        let (Some((id, (title, detail))), Some(turn)) = (known, self.active_turn()) else {
            let payload = json!({"tool_use_id": event.get("tool_use_id")});
            events.push(unknown(
                "a tool result for a tool this turn did not start",
                "tool_result",
                &payload,
            ));
            return;
        };
        let output = tool_output(
            text(event, "text").unwrap_or_default(),
            event["truncated"] == true,
        );
        let detail = with_line_counts(title, detail, &event["outcome"]);
        // Claude Code answers the tool a Stop cuts off with an error result. That the
        // interrupt was written is reported; what it means for the tool is not decided
        // here (#387 3B3).
        let after_interrupt = self.runtime.interrupted(turn);
        events.push(EventKind::ToolUpdated {
            turn: turn.clone(),
            item: NativeItemId::new(id),
            title: title.clone(),
            status: match (failed, declined) {
                (true, true) => ToolStatus::Declined,
                (true, false) if after_interrupt => ToolStatus::FailedAfterInterrupt,
                (true, false) => ToolStatus::Failed,
                (false, _) => ToolStatus::Succeeded,
            },
            output: Some(output),
            detail: Some(detail),
        });
        let turn = turn.clone();
        events.extend(
            self.reports
                .file_result(&turn, id, failed, &event["outcome"]),
        );
    }

    fn permission_request(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let Some(request) = text(event, "request_id").map(NativeRequestId::new) else {
            events.push(unknown(
                "a permission request without an id",
                "permission_request",
                event,
            ));
            return;
        };
        let tool = text(event, "display_name")
            .or_else(|| text(event, "tool_name"))
            .unwrap_or("a tool");
        // What would run: a shell tool's command, else Claude Code's own summary.
        let subject = event
            .get("input")
            .and_then(|input| text(input, "command"))
            .or_else(|| text(event, "title"));
        let reason = text(event, "description").or_else(|| text(event, "decision_reason"));
        let detail = json!({
            "tool_name": event.get("tool_name"),
            "input": event.get("input"),
            "decision_reason": event.get("decision_reason"),
            "blocked_path": event.get("blocked_path"),
            "agent_id": event.get("agent_id"),
        });
        let turn = self.turn(events);
        // Claude Code can ask before emitting assistant content for the tool.
        if let (Some(id), Some(name), Some(input)) = (
            text(event, "tool_use_id"),
            text(event, "tool_name"),
            event.get("input").filter(|input| input.is_object()),
        ) && !PLAN_TOOLS.contains(&name)
        {
            self.observe_tool_input(&turn, id, name, input, events);
        }
        if !self.runtime.register_request(
            request.clone(),
            Some(&turn),
            Request {
                questions: None,
                tool_use: text(event, "tool_use_id").map(str::to_owned),
            },
        ) {
            return;
        }
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request,
            turn: Some(turn),
            // The bridge names the tool use a permission is asked for.
            item: text(event, "tool_use_id").map(NativeItemId::new),
            kind: InteractionKind::approval(
                subject,
                reason,
                &format!("Claude wants to use {tool}"),
                // ponytail: no AllowForSession. The bridge's `remember` applies
                // whatever rule Claude Code suggested, which may be saved to the
                // user's settings; offer it once the bridge reports the rule's scope.
                vec![ApprovalDecision::Allow, ApprovalDecision::Deny],
            ),
            detail: Some(ProviderDetail::new(
                "permission_request",
                &detail.to_string(),
            )),
        }));
    }

    /// Returns the decision to send when the question cannot be shown: it is
    /// declined, never answered on the user's behalf.
    fn question_request(&mut self, event: &Value, events: &mut Vec<EventKind>) -> Option<Value> {
        let request = text(event, "request_id").map(NativeRequestId::new)?;
        let questions: Vec<Question> = event
            .get("questions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|question| {
                let prompt = text(question, "question")?;
                let options = question.get("options").and_then(Value::as_array);
                Some(Question {
                    // The bridge keys answers by the question's text.
                    id: prompt.to_owned(),
                    prompt: prompt.to_owned(),
                    options: options
                        .into_iter()
                        .flatten()
                        .filter_map(|option| text(option, "label"))
                        .map(str::to_owned)
                        .collect(),
                    multi_select: question["multiSelect"] == true,
                })
            })
            .collect();
        let asked = event.get("questions").and_then(Value::as_array);
        if questions.is_empty() || asked.map(Vec::len) != Some(questions.len()) {
            events.push(unknown(
                "a question ticketd cannot show; it was declined",
                "question_request",
                event,
            ));
            return Some(json!({
                "request_id": request.0,
                "decision": {"kind": "deny", "message": "ticketd could not show this question"},
            }));
        }
        let turn = self.turn(events);
        if !self.runtime.register_request(
            request.clone(),
            Some(&turn),
            Request {
                questions: Some(
                    questions
                        .iter()
                        .map(|question| (question.id.clone(), question.multi_select))
                        .collect(),
                ),
                tool_use: None,
            },
        ) {
            return None;
        }
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request,
            turn: Some(turn),
            // The AskUserQuestion tool use it was asked from: its row waits with it.
            item: text(event, "tool_use_id").map(NativeItemId::new),
            kind: InteractionKind::Question { questions },
            detail: None,
        }));
        None
    }

    fn request_gone(
        &mut self,
        event: &Value,
        resolution: InteractionResolution,
        events: &mut Vec<EventKind>,
    ) {
        let request = NativeRequestId::new(text(event, "request_id").unwrap_or_default());
        if self.runtime.remove_request(&request).is_some() {
            events.push(EventKind::InteractionResolved {
                request,
                resolution,
            });
        }
    }

    /// The bridge refused an answer that was written. A request it no longer holds
    /// is withdrawn; any other refusal leaves the request live and answerable.
    pub fn answer_refused(&mut self, request: &NativeRequestId, gone: bool) -> Option<EventKind> {
        if !gone {
            if let Some(live) = self.runtime.reopen_request(request)
                && let Some(tool_use) = &live.tool_use
            {
                self.declined.remove(tool_use);
            }
            return None;
        }
        let live = self.runtime.remove_request(request)?;
        if let Some(tool_use) = &live.tool_use {
            self.declined.remove(tool_use);
        }
        Some(EventKind::InteractionResolved {
            request: request.clone(),
            resolution: InteractionResolution::Withdrawn,
        })
    }

    /// Checks an answer against the live request and returns the bridge decision.
    /// Each request accepts one answer.
    pub fn answer(
        &mut self,
        request: &NativeRequestId,
        answer: &InteractionAnswer,
    ) -> Result<Value, Refusal> {
        let (decision, declined) = self.runtime.answer(request, |live| {
            let decision = match (answer, &live.questions) {
                (InteractionAnswer::Approval(ApprovalDecision::Deny), _) => json!({"kind": "deny"}),
                (InteractionAnswer::Approval(ApprovalDecision::Allow), None) => {
                    json!({"kind": "allow"})
                }
                (InteractionAnswer::Answers(answers), Some(questions)) => {
                    let mut by_question = Map::new();
                    for answer in answers {
                        let multi_select = questions
                            .get(&answer.question_id)
                            .ok_or(Refusal::Unsupported)?;
                        let value = match (multi_select, answer.values.as_slice()) {
                            (false, [value]) => json!(value),
                            (true, values) => json!(values),
                            (false, _) => return Err(Refusal::Unsupported),
                        };
                        by_question.insert(answer.question_id.clone(), value);
                    }
                    json!({"kind": "answer", "answers": by_question})
                }
                _ => return Err(Refusal::Unsupported),
            };
            let declined = (answer == &InteractionAnswer::Approval(ApprovalDecision::Deny))
                .then(|| live.tool_use.clone())
                .flatten();
            Ok((decision, declined))
        })?;
        if let Some(tool_use) = declined {
            self.declined.insert(tool_use);
        }
        Ok(decision)
    }

    fn turn_result(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        self.identify(text(event, "session_id"), events);
        let id = self.turn(events);
        let last_error = self.turn_error.take();
        self.tools.clear();
        self.declined.clear();
        self.streams.clear();
        self.reports.turn_ended();
        let subtype = text(event, "subtype").unwrap_or("unknown");
        let failed = event["is_error"] == true || subtype.starts_with("error");
        let denied = denials(event);
        let ended_by = |kind, message: String| {
            TurnOutcome::Failed(Problem {
                kind,
                message,
                detail: None,
                resets_at: None,
            })
        };
        // What the harness said happened. Whether an interrupt or a denial changes how
        // the turn reads is the supervisor's to decide; the evidence is reported below.
        // The bridge reports the complete list for the turn, even if some of
        // its processing messages were delayed or absent.
        for submission in strings(event, "submission_ids") {
            self.runtime
                .acknowledged(&SubmissionId(submission), &id, false);
        }
        let outcome = if subtype == "error_max_turns" {
            ended_by(
                ProblemKind::TurnLimitReached,
                "Claude Code reached the turn limit before finishing.".to_owned(),
            )
        } else if !failed {
            TurnOutcome::Completed
        } else {
            let errors = strings(event, "errors");
            let detail = json!({
                "subtype": subtype,
                "errors": errors,
                "stop_reason": event.get("stop_reason"),
                "terminal_reason": event.get("terminal_reason"),
                "denials": event.get("denials"),
            });
            let kind = match last_error.as_deref() {
                Some("authentication_failed") => ProblemKind::LoginRequired,
                Some("rate_limit" | "billing_error") => ProblemKind::QuotaExhausted,
                _ => ProblemKind::Other,
            };
            TurnOutcome::Failed(Problem {
                kind,
                message: if errors.is_empty() {
                    text(event, "result_text").unwrap_or(subtype).to_owned()
                } else {
                    errors.join("; ")
                },
                detail: Some(ProviderDetail::new("turn_result", &detail.to_string())),
                resets_at: self
                    .limit_resets_at
                    .filter(|_| kind == ProblemKind::QuotaExhausted),
            })
        };
        events.extend(self.runtime.end_turn(id, outcome, |marks| {
            TurnEvidence {
                interrupt_written: marks.interrupted,
                denied: (self.unattended && !denied.is_empty())
                    .then(|| format!("Claude Code was denied: {}.", denied.join("; "))),
                not_started: None,
            }
        }));
    }
}

/// Each distinct thing Claude Code denied in a turn, once: the tool, and for a shell
/// its command on one line ("PowerShell `node test.js`").
pub(super) fn denials(event: &Value) -> Vec<String> {
    const MAX_COMMAND_CHARS: usize = 120;
    let mut said: Vec<String> = Vec::new();
    for denial in event["denials"].as_array().into_iter().flatten() {
        let Some(tool) = denial["tool_name"].as_str() else {
            continue;
        };
        // A shell's command, or the path a file tool was refused (#387 3B1).
        let line = match denial["command"].as_str().or(denial["path"].as_str()) {
            Some(command) => {
                // Control characters (a backspace from a `\b` in a JSON-written
                // path) print as nothing useful: each becomes a space (#387 M19).
                let command: String = command
                    .chars()
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .collect();
                let command = command.split_whitespace().collect::<Vec<_>>().join(" ");
                let short: String = command.chars().take(MAX_COMMAND_CHARS).collect();
                let more = if short.len() < command.len() {
                    "…"
                } else {
                    ""
                };
                format!("{tool} `{short}{more}`")
            }
            None => tool.to_owned(),
        };
        if !said.contains(&line) {
            said.push(line);
        }
    }
    said
}

/// The tool's input with the lines its result said it added and removed, kept as
/// `ticketd_lines` so the step row can show them; unchanged when it said none.
fn with_line_counts(title: &str, detail: &ProviderDetail, outcome: &Value) -> ProviderDetail {
    let count = |key: &str| outcome[key].as_u64();
    let (Some("file"), Some(added), Some(removed)) = (
        text(outcome, "kind"),
        count("added_lines"),
        count("removed_lines"),
    ) else {
        return detail.clone();
    };
    let Ok(Value::Object(mut input)) = serde_json::from_str::<Value>(detail.payload()) else {
        return detail.clone();
    };
    input.insert(
        "ticketd_lines".to_owned(),
        json!({ "added": added, "removed": removed }),
    );
    tool_detail(title, detail.kind(), &Value::Object(input))
}

/// Keep the fields a reader needs when an input includes a large body or diff.
const TOOL_INPUT_BYTES: usize = 16 * 1024;
// Commands stay whole within a separate budget. The encoded input can expand
// again when sent in the subscriber's change feed.
const COMMAND_INPUT_BYTES: usize = crate::SUBSCRIBER_BACKLOG_BYTES / 8;

fn tool_detail(title: &str, kind: &str, input: &Value) -> ProviderDetail {
    let raw = input.to_string();
    if raw.len() <= TOOL_INPUT_BYTES {
        let bytes = raw.len();
        return ProviderDetail::from_compacted_tool_input(kind, raw, bytes);
    }
    let fields: &[&str] = match title {
        "Bash" | "PowerShell" => &["command", "status", "exitCode", "durationMs"],
        "Read" => &["file_path", "offset", "limit"],
        "LS" => &["path"],
        "Grep" | "Glob" => &["pattern", "path", "glob"],
        "Edit" | "MultiEdit" | "NotebookEdit" | "Write" => {
            &["ticketd_lines", "file_path", "notebook_path"]
        }
        "WebSearch" => &["query"],
        "WebFetch" => &["url"],
        _ => &[],
    };
    let mut compact = Map::new();
    let mut bytes = 2;
    for &field in fields {
        let Some(value) = input.get(field) else {
            continue;
        };
        // Field names are fixed ASCII. Count quotes, colon and separator as well.
        let field_bytes = field.len() + 4 + value.to_string().len();
        let budget = if field == "command" {
            COMMAND_INPUT_BYTES
        } else {
            TOOL_INPUT_BYTES
        };
        if bytes + field_bytes <= budget {
            compact.insert(field.to_owned(), value.clone());
            bytes += field_bytes;
        }
    }
    ProviderDetail::from_compacted_tool_input(kind, Value::Object(compact).to_string(), raw.len())
}
