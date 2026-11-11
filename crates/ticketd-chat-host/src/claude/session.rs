//! Translates bridge session events into contract events and tracks what they have
//! told us: the open turn, live requests, tools and streamed text.
//!
//! Everything here is synchronous and runs on the protocol reader in arrival order.

use std::collections::{HashMap, VecDeque};

use serde_json::{Map, Value, json};

use crate::{
    ApprovalDecision, DeliveryEvidence, EventKind, InteractionAnswer, InteractionKind,
    InteractionRequest, InteractionResolution, NativeItemId, NativeRequestId, NativeSessionId,
    NativeTurnId, NoticeKind, Problem, ProblemKind, ProviderDetail, Question, Refusal,
    SubmissionId, ToolStatus, TurnOutcome,
};

#[derive(Debug)]
struct Turn {
    id: NativeTurnId,
    /// An interrupt was written for this turn.
    interrupt_written: bool,
    /// The last error Claude Code attached to assistant content in this turn.
    error: Option<String>,
}

#[derive(Debug)]
struct LiveRequest {
    /// For a question: whether each question takes several answers, by question id.
    /// `None` for a permission request.
    questions: Option<HashMap<String, bool>>,
    answered: bool,
}

#[derive(Debug, Default)]
pub(super) struct Session {
    turns_started: u64,
    items_started: u64,
    turn: Option<Turn>,
    native_session: Option<String>,
    settings_reported: bool,
    requests: HashMap<NativeRequestId, LiveRequest>,
    /// Name and input of each tool the open turn started, by tool-use id.
    tools: HashMap<String, (String, ProviderDetail)>,
    /// Text blocks being streamed, oldest first, by content block index.
    streams: VecDeque<(i64, NativeItemId)>,
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

impl Session {
    pub fn active_turn(&self) -> Option<&NativeTurnId> {
        self.turn.as_ref().map(|turn| &turn.id)
    }

    pub fn interrupt_written(&mut self) {
        if let Some(turn) = &mut self.turn {
            turn.interrupt_written = true;
        }
    }

    /// The runtime is gone: nothing is live any more.
    pub fn clear_live(&mut self) {
        self.turn = None;
        self.requests.clear();
        self.tools.clear();
        self.streams.clear();
    }

    /// The open turn, opening one when Claude Code shows activity outside a turn.
    /// Claude Code has no turn identity, so the id is local to this runtime.
    fn turn(&mut self, events: &mut Vec<EventKind>) -> NativeTurnId {
        if let Some(turn) = &self.turn {
            return turn.id.clone();
        }
        self.turns_started += 1;
        let id = NativeTurnId(format!("local-turn-{}", self.turns_started));
        self.turn = Some(Turn {
            id: id.clone(),
            interrupt_written: false,
            error: None,
        });
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
            "sdk_message_unmapped" => {
                let kind = match (text(event, "sdk_type"), text(event, "sdk_subtype")) {
                    (Some(kind), Some(subtype)) => format!("{kind}/{subtype}"),
                    (kind, _) => kind.unwrap_or("unknown").to_owned(),
                };
                events.push(EventKind::Unknown {
                    summary: format!("Claude Code sent a message ticketd does not show: {kind}"),
                    detail: ProviderDetail::new(kind, text(event, "json").unwrap_or_default()),
                });
            }
            _ => return None,
        }
        Some((events, decline))
    }

    fn session_info(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        self.identify(text(event, "session_id"), events);
        if !self.settings_reported {
            self.settings_reported = true;
            let settings = json!({
                "claude_code_version": event.get("claude_code_version"),
                "cwd": event.get("cwd"),
                "model": event.get("model"),
                "permission_mode": event.get("permission_mode"),
            });
            events.push(EventKind::Notice {
                turn: None,
                kind: NoticeKind::EffectiveSettings,
                message: "Claude Code reported the settings in effect".to_owned(),
                detail: Some(ProviderDetail::new("session_info", &settings.to_string())),
            });
        }
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
            if let Some(open) = &mut self.turn {
                open.error = Some(error.to_owned());
            }
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
                Some("text" | "thinking") => {}
                Some("tool_use") => {
                    let Some(id) = text(block, "id") else {
                        events.push(unknown("a tool use without an id", "tool_use", block));
                        continue;
                    };
                    let title = text(block, "name").unwrap_or("tool").to_owned();
                    let detail = ProviderDetail::new("tool_use", &block["input"].to_string());
                    self.tools
                        .insert(id.to_owned(), (title.clone(), detail.clone()));
                    events.push(EventKind::ToolUpdated {
                        turn: turn.clone(),
                        item: NativeItemId::new(id),
                        title,
                        status: ToolStatus::Running,
                        output: None,
                        detail: Some(detail),
                    });
                }
                _ => events.push(unknown(
                    "Claude Code sent content ticketd does not show",
                    text(block, "block_type").unwrap_or("content"),
                    block,
                )),
            }
        }
    }

    fn tool_result(&mut self, event: &Value, events: &mut Vec<EventKind>) {
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
        let mut output = text(event, "text").unwrap_or_default().to_owned();
        if event["truncated"] == true {
            output.push_str("\n[output truncated]");
        }
        events.push(EventKind::ToolUpdated {
            turn: turn.clone(),
            item: NativeItemId::new(id),
            title: title.clone(),
            status: if event["is_error"] == true {
                ToolStatus::Failed
            } else {
                ToolStatus::Succeeded
            },
            output: Some(output),
            detail: Some(detail.clone()),
        });
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
        let description = text(event, "title")
            .or_else(|| text(event, "description"))
            .map_or_else(|| format!("Claude wants to use {tool}"), str::to_owned);
        let detail = json!({
            "tool_name": event.get("tool_name"),
            "input": event.get("input"),
            "decision_reason": event.get("decision_reason"),
            "blocked_path": event.get("blocked_path"),
            "agent_id": event.get("agent_id"),
        });
        let turn = self.turn(events);
        self.requests.insert(
            request.clone(),
            LiveRequest {
                questions: None,
                answered: false,
            },
        );
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request,
            turn: Some(turn),
            kind: InteractionKind::Approval {
                description,
                // ponytail: no AllowForSession. The bridge's `remember` applies
                // whatever rule Claude Code suggested, which may be saved to the
                // user's settings; offer it once the bridge reports the rule's scope.
                decisions: vec![ApprovalDecision::Allow, ApprovalDecision::Deny],
            },
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
        self.requests.insert(
            request.clone(),
            LiveRequest {
                questions: Some(
                    questions
                        .iter()
                        .map(|question| (question.id.clone(), question.multi_select))
                        .collect(),
                ),
                answered: false,
            },
        );
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request,
            turn: Some(turn),
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
        if self.requests.remove(&request).is_some() {
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
            if let Some(live) = self.requests.get_mut(request) {
                live.answered = false;
            }
            return None;
        }
        self.requests.remove(request)?;
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
        let live = self
            .requests
            .get_mut(request)
            .filter(|live| !live.answered)
            .ok_or(Refusal::UnknownRequest)?;
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
        live.answered = true;
        Ok(decision)
    }

    fn turn_result(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        self.identify(text(event, "session_id"), events);
        let id = self.turn(events);
        let turn = self.turn.take();
        self.tools.clear();
        self.streams.clear();
        let subtype = text(event, "subtype").unwrap_or("unknown");
        let failed = event["is_error"] == true || subtype.starts_with("error");
        // ponytail: how Claude Code reports an interrupted turn is unverified; any
        // unsuccessful result after an interrupt was written counts as interrupted.
        let outcome = if !failed {
            TurnOutcome::Completed
        } else if turn.as_ref().is_some_and(|turn| turn.interrupt_written) {
            TurnOutcome::Interrupted
        } else {
            let errors = strings(event, "errors");
            let detail = json!({
                "subtype": subtype,
                "errors": errors,
                "stop_reason": event.get("stop_reason"),
                "terminal_reason": event.get("terminal_reason"),
                "denied_tool_names": event.get("denied_tool_names"),
            });
            TurnOutcome::Failed(Problem {
                kind: match turn.and_then(|turn| turn.error).as_deref() {
                    Some("authentication_failed") => ProblemKind::LoginRequired,
                    Some("rate_limit" | "billing_error") => ProblemKind::QuotaExhausted,
                    _ => ProblemKind::Other,
                },
                message: if errors.is_empty() {
                    text(event, "result_text").unwrap_or(subtype).to_owned()
                } else {
                    errors.join("; ")
                },
                detail: Some(ProviderDetail::new("turn_result", &detail.to_string())),
            })
        };
        events.push(EventKind::TurnEnded {
            turn: id,
            outcome,
            submissions: strings(event, "submission_ids")
                .into_iter()
                .map(SubmissionId)
                .collect(),
        });
    }
}
