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
    NativeSessionId, NativeSubAgentId, NativeTurnId, NoticeKind, Problem, ProblemKind,
    ProviderDetail, Question, Refusal, SettingKey, SubAgentOutcome, SubAgentStart, SubAgentStopper,
    SubmissionId, ToolStatus, TurnEvidence, TurnOrigin, TurnOutcome, TurnStarter, reset_time,
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
    /// The sub-agents of this session, by task ID, and the tool uses frames name them by.
    sub_agents: SubAgents,
    /// Inputs of the person's written to the harness whose processing was not shown yet.
    /// Output can come before the harness says it is processing them, and a turn they
    /// start is not one the harness started by itself.
    pending_inputs: HashSet<String>,
}

/// How many frames of a sub-agent that has not been announced yet are held for it, and
/// how many sub-agents are waited for.
const HELD_FRAMES: usize = 256;
const HELD_AGENTS: usize = 32;
/// The most the frames waiting for an announcement keep in all, as the bytes they were
/// sent in: the counts alone would let a session hold a gigabyte.
pub(super) const HELD_BYTES: usize = 4 * 1024 * 1024;

/// What the session knows of its sub-agents. Claude Code tags each frame of a sub-agent
/// with the tool use that started it (`parent_tool_use_id`); `task_started` says which
/// task that is, and can arrive after the first of its frames.
#[derive(Debug, Default)]
struct SubAgents {
    /// By task ID.
    known: HashMap<String, Agent>,
    /// The launch a tool use started or resumed, by tool-use ID.
    by_tool_use: HashMap<String, Launch>,
    /// The sub-agent that ran each of its tool calls, by tool-use ID.
    owner: HashMap<String, String>,
    /// Frames of a tool use not announced as a sub-agent yet: (event name, event, bytes).
    held: HashMap<String, Vec<(String, Value, usize)>>,
    /// What the held frames keep, in bytes: charged on hold, given back on replay or drop.
    held_bytes: usize,
    /// The sub-agent that finished last while no turn ran, until a turn opens: the one
    /// the turn Claude Code starts by itself follows.
    finished_at_rest: Option<String>,
}

/// What a tool use started: the task, and the run it opened. A task resumed through
/// another tool use has a newer run; frames of the earlier launch are late.
#[derive(Debug, Clone)]
struct Launch {
    task: String,
    run: Option<String>,
}

impl SubAgents {
    /// A turn ended. Frames still waiting for an announcement never get one, and what
    /// a foreground sub-agent ran in the turn is over with it.
    ///
    /// Returns the foreground sub-agents that were over with it.
    fn turn_ended(&mut self) -> Vec<String> {
        self.held.clear();
        self.held_bytes = 0;
        self.finished_at_rest = None;
        let mut over = Vec::new();
        for (task, agent) in self.known.iter_mut().filter(|(_, agent)| !agent.background) {
            if agent.running {
                over.push(task.clone());
            }
            agent.running = false;
        }
        // A sub-agent in the background goes on past the turn, and so do its tool calls.
        let running: HashSet<&str> = self
            .known
            .iter()
            .filter(|(_, agent)| agent.running)
            .map(|(task, _)| task.as_str())
            .collect();
        self.owner.retain(|_, task| running.contains(task.as_str()));
        over
    }
}

#[derive(Debug, Default)]
struct Agent {
    /// The tool use that started it; its result, for a sub-agent in the foreground, says
    /// it ended.
    tool_use: Option<String>,
    /// The harness's ID for the run in progress.
    run: Option<String>,
    running: bool,
    background: bool,
    /// ticketd asked Claude Code to stop it: how it ended is then the person's doing.
    stop_asked: bool,
    /// The model its own messages reported last.
    model: Option<String>,
    /// What its latest message said: its final report repeats it.
    last_text: Option<String>,
}

fn text<'a>(event: &'a Value, field: &str) -> Option<&'a str> {
    event.get(field).and_then(Value::as_str)
}

fn strings(event: &Value, field: &str) -> Vec<String> {
    let items = event.get(field).and_then(Value::as_array);
    let items = items.into_iter().flatten().filter_map(Value::as_str);
    items.map(str::to_owned).collect()
}

/// Whose tool call it is: the main agent's, in its turn, or a sub-agent's, which belongs to
/// no turn of its own.
#[derive(Clone, Copy)]
enum Who<'a> {
    Main(&'a NativeTurnId),
    SubAgent(&'a str),
}

/// The latest state of one tool item.
fn tool_event(
    who: Who<'_>,
    id: &str,
    title: &str,
    status: ToolStatus,
    output: Option<String>,
    detail: Option<ProviderDetail>,
) -> EventKind {
    let (item, title) = (NativeItemId::new(id), title.to_owned());
    match who {
        Who::SubAgent(owner) => EventKind::SubAgentToolUpdated {
            sub_agent: NativeSubAgentId::new(owner),
            item,
            title,
            status,
            output,
            detail,
        },
        Who::Main(turn) => EventKind::ToolUpdated {
            turn: turn.clone(),
            item,
            title,
            status,
            output,
            detail,
        },
    }
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

    /// An input of the person's is being written to the harness.
    pub fn input_written(&mut self, submission: &str) {
        self.pending_inputs.insert(submission.to_owned());
    }

    /// The bridge refused an input and no longer holds it: output with no input behind it
    /// is the harness's again.
    pub fn input_refused(&mut self, submission: &str) {
        self.pending_inputs.remove(submission);
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
        self.pending_inputs.clear();
        self.turn_error = None;
        self.tools.clear();
        self.declined.clear();
        self.streams.clear();
        self.sub_agents = SubAgents::default();
    }

    /// The open turn, opening one when Claude Code shows activity outside a turn.
    /// Claude Code has no turn identity, so the id is local to this runtime.
    fn turn(&mut self, events: &mut Vec<EventKind>) -> NativeTurnId {
        self.open_turn(events, true)
    }

    /// The turn the person's input started, opened as soon as the harness says it took the
    /// input. Not labelled: the person started it.
    fn turn_for_input(&mut self, events: &mut Vec<EventKind>) -> NativeTurnId {
        self.open_turn(events, false)
    }

    fn open_turn(&mut self, events: &mut Vec<EventKind>, by_itself: bool) -> NativeTurnId {
        if let Some(turn) = self.active_turn() {
            return turn.clone();
        }
        self.turns_started += 1;
        let id = NativeTurnId(format!("local-turn-{}", self.turns_started));
        self.runtime.turn_started(&id);
        // Output of the main agent with no input of the person's behind it: Claude Code
        // resumed by itself, which it does when a sub-agent in the background finishes.
        // What that sub-agent was is the last one that finished since the last turn.
        let finished = self.sub_agents.finished_at_rest.take();
        let origin = (by_itself && self.pending_inputs.is_empty()).then(|| TurnOrigin {
            by: TurnStarter::Harness,
            sub_agent: finished.map(NativeSubAgentId),
        });
        events.push(EventKind::TurnStarted {
            turn: id.clone(),
            origin,
        });
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
                for submission in strings(event, "submission_ids") {
                    self.pending_inputs.remove(&submission);
                }
                let turn = self.turn_for_input(&mut events);
                for submission in strings(event, "submission_ids") {
                    events.push(EventKind::SubmissionEvidence {
                        submission: SubmissionId(submission),
                        evidence: DeliveryEvidence::Processing { turn: turn.clone() },
                    });
                }
            }
            "delta" => self.delta(event, &mut events),
            // A sub-agent's thinking is its own, and opens no turn.
            "thinking" if !event["parent_tool_use_id"].is_null() => {
                self.sub_agent_thinking(event, &mut events);
            }
            "thinking" => {
                let turn = self.turn(&mut events);
                events.extend(self.reports.thinking(&turn, event));
            }
            "sub_agent_started" => self.sub_agent_started(event, &mut events),
            "sub_agent_updated" => self.sub_agent_updated(event, &mut events),
            "sub_agent_ended" => self.sub_agent_ended(event, &mut events),
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
        // A sub-agent's frames are its own: they open no turn and are not the main
        // agent's reply, reasoning, plan or Steps.
        if let Some(parent) = text(event, "parent_tool_use_id") {
            return self.sub_agent_content(parent, event, events);
        }
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
        let blocks = event.get("blocks").and_then(Value::as_array);
        for block in blocks.into_iter().flatten() {
            match text(block, "type") {
                // Blocks complete in the order their streams began.
                Some("text") => {
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
                Some("thinking") => {
                    let said = text(block, "text").unwrap_or_default();
                    events.push(self.reports.thinking_text(&turn, said));
                }
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
                    self.observe_tool_input(Who::Main(&turn), id, &title, &block["input"], events);
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

    /// A `thinking` frame of a sub-agent: its reasoning item.
    fn sub_agent_thinking(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let Some(parent) = text(event, "parent_tool_use_id") else {
            return;
        };
        let Some(launch) = self.sub_agents.by_tool_use.get(parent).cloned() else {
            return self.hold(parent, "thinking", event);
        };
        // A frame of a launch a resume superseded changes nothing about the run now.
        if self.late_run(&launch.task, launch.run.as_deref()) {
            return;
        }
        let task = launch.task;
        let run = self.sub_agents.known.get(&task).and_then(|a| a.run.clone());
        events.extend(
            self.reports
                .sub_agent_thinking(&task, run.as_deref(), event),
        );
    }

    /// A frame of the sub-agent the tool use `parent` started: its messages, reasoning
    /// and tool calls are its own, and open no turn.
    fn sub_agent_content(&mut self, parent: &str, event: &Value, events: &mut Vec<EventKind>) {
        let Some(launch) = self.sub_agents.by_tool_use.get(parent).cloned() else {
            return self.hold(parent, "assistant_content", event);
        };
        if self.late_run(&launch.task, launch.run.as_deref()) {
            return;
        }
        let task = launch.task;
        let turn = self.active_turn().cloned();
        let run = self
            .sub_agents
            .known
            .get(&task)
            .and_then(|agent| agent.run.clone());
        if let Some(model) = text(event, "model")
            && let Some(agent) = self.sub_agents.known.get_mut(&task)
            && agent.model.as_deref() != Some(model)
        {
            agent.model = Some(model.to_owned());
            events.push(EventKind::SubAgentUpdated {
                sub_agent: NativeSubAgentId::new(&task),
                run: None,
                background: None,
                native: Some(json!({"model": model})),
            });
        }
        if let Some(error) = text(event, "error") {
            events.push(EventKind::Notice {
                turn: turn.clone(),
                kind: NoticeKind::Warning,
                message: format!("Claude Code reported an error in a sub-agent: {error}"),
                detail: None,
            });
        }
        let blocks = event.get("blocks").and_then(Value::as_array);
        for block in blocks.into_iter().flatten() {
            match text(block, "type") {
                Some("tool_use") => {
                    let Some(id) = text(block, "id") else {
                        events.push(unknown("a tool use without an id", "tool_use", block));
                        continue;
                    };
                    let title = text(block, "name").unwrap_or("tool").to_owned();
                    // Only the main agent's plan is the turn's plan: a sub-agent's list
                    // stays a Step of its own. Its edits are its run's files, not the turn's.
                    self.sub_agents.owner.insert(id.to_owned(), task.clone());
                    let changed = self.reports.sub_agent_file_tool(
                        &task,
                        run.as_deref(),
                        id,
                        &title,
                        &block["input"],
                    );
                    self.observe_tool_input(
                        Who::SubAgent(&task),
                        id,
                        &title,
                        &block["input"],
                        events,
                    );
                    events.extend(changed);
                }
                Some("text") => {
                    let said = text(block, "text").unwrap_or_default();
                    if said.trim().is_empty() {
                        continue;
                    }
                    if let Some(agent) = self.sub_agents.known.get_mut(&task) {
                        agent.last_text = Some(said.to_owned());
                    }
                    events.push(EventKind::SubAgentMessage {
                        sub_agent: NativeSubAgentId::new(&task),
                        item: self.new_item(),
                        text: said.to_owned(),
                    });
                }
                Some("thinking") => {
                    let said = text(block, "text").unwrap_or_default();
                    events.push(
                        self.reports
                            .sub_agent_thinking_text(&task, run.as_deref(), said),
                    );
                }
                Some("other") if text(block, "block_type") == Some("redacted_thinking") => {}
                _ => events.push(unknown(
                    "Claude Code sent content ticketd does not show",
                    text(block, "block_type").unwrap_or("content"),
                    block,
                )),
            }
        }
    }

    /// Keeps a frame of a tool use that no `task_started` has named yet, until one does.
    /// A tool use that never becomes a sub-agent is dropped with its turn.
    fn hold(&mut self, parent: &str, name: &str, event: &Value) {
        let sub_agents = &mut self.sub_agents;
        if !sub_agents.held.contains_key(parent) && sub_agents.held.len() >= HELD_AGENTS {
            return;
        }
        if sub_agents
            .held
            .get(parent)
            .is_some_and(|frames| frames.len() >= HELD_FRAMES)
        {
            return;
        }
        let bytes = event.to_string().len();
        if sub_agents.held_bytes + bytes > HELD_BYTES {
            return;
        }
        sub_agents.held_bytes += bytes;
        sub_agents.held.entry(parent.to_owned()).or_default().push((
            name.to_owned(),
            event.clone(),
            bytes,
        ));
    }

    /// The person stops one background sub-agent: remembered, so that its end is theirs.
    /// Refused when it does not run now, or runs in the foreground, where Claude Code ends
    /// it with its turn.
    pub fn stop_asked(&mut self, task: &str) -> Result<(), Refusal> {
        match self.sub_agents.known.get_mut(task) {
            Some(agent) if agent.running && agent.background => {
                agent.stop_asked = true;
                Ok(())
            }
            _ => Err(Refusal::UnknownSubAgent),
        }
    }

    /// Claude Code did not take the request: nobody asked it to stop.
    pub fn stop_not_asked(&mut self, task: &str) {
        if let Some(agent) = self.sub_agents.known.get_mut(task) {
            agent.stop_asked = false;
        }
    }

    fn stopper(&self, task: &str) -> SubAgentStopper {
        if self
            .sub_agents
            .known
            .get(task)
            .is_some_and(|agent| agent.stop_asked)
            || self
                .active_turn()
                .is_some_and(|turn| self.runtime.interrupted(turn))
        {
            SubAgentStopper::Person
        } else {
            SubAgentStopper::MainAgent
        }
    }

    fn sub_agent_started(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let Some(task) = text(event, "task_id") else {
            events.push(unknown(
                "a sub-agent without a task id",
                "sub_agent_started",
                event,
            ));
            return;
        };
        let tool_use = text(event, "tool_use_id");
        let background = event["background"] == true;
        let run = text(event, "run_id").map(str::to_owned);
        let agent = self.sub_agents.known.entry(task.to_owned()).or_default();
        agent.running = true;
        agent.stop_asked = false;
        agent.background = background;
        // A new run has its own report: the last run's last message says nothing of it.
        if agent.run != run {
            agent.last_text = None;
        }
        agent.run.clone_from(&run);
        agent.tool_use = tool_use.map(str::to_owned);
        if let Some(tool_use) = tool_use {
            self.sub_agents.by_tool_use.insert(
                tool_use.to_owned(),
                Launch {
                    task: task.to_owned(),
                    run: run.clone(),
                },
            );
        }
        events.push(EventKind::SubAgentStarted(SubAgentStart {
            sub_agent: NativeSubAgentId::new(task),
            run,
            parent: text(event, "parent_task_id").map(NativeSubAgentId::new),
            tool: tool_use.map(NativeItemId::new),
            background,
            native: json!({
                "description": event.get("description"),
                "subagent_type": event.get("subagent_type"),
                "prompt": event.get("prompt"),
            }),
        }));
        // What it did before it was announced.
        if let Some(tool_use) = tool_use
            && let Some(frames) = self.sub_agents.held.remove(tool_use)
        {
            for (name, frame, bytes) in frames {
                self.sub_agents.held_bytes = self.sub_agents.held_bytes.saturating_sub(bytes);
                if let Some((more, _)) = self.event(&name, &frame) {
                    events.extend(more);
                }
            }
        }
    }

    /// Whether a frame naming run `incoming` of `task` is late: the run it names sorts
    /// before the one that runs now (the SDK orders a task's run IDs by when they opened).
    fn late_run(&self, task: &str, incoming: Option<&str>) -> bool {
        matches!(
            (self.sub_agents.known.get(task).and_then(|agent| agent.run.as_deref()), incoming),
            (Some(current), Some(incoming)) if incoming < current
        )
    }

    fn sub_agent_updated(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let Some(task) = text(event, "task_id") else {
            return;
        };
        // A resumed task is the same task with a new run: what an earlier run says now
        // changes nothing about the one that runs.
        if self.late_run(task, text(event, "run_id")) {
            return;
        }
        let background = event["background"].as_bool();
        let described = text(event, "description");
        let outcome = match text(event, "status") {
            Some("completed") => Some(SubAgentOutcome::Completed),
            Some("failed") => Some(SubAgentOutcome::Failed),
            Some("killed") => Some(SubAgentOutcome::Stopped(self.stopper(task))),
            _ => None,
        };
        let error = text(event, "error").map(str::to_owned);
        let Some(agent) = self.sub_agents.known.get_mut(task) else {
            return;
        };
        if let Some(background) = background {
            agent.background = background;
        }
        if background.is_some() || described.is_some() {
            events.push(EventKind::SubAgentUpdated {
                sub_agent: NativeSubAgentId::new(task),
                run: text(event, "run_id").map(str::to_owned),
                background,
                native: described.map(|description| json!({ "description": description })),
            });
        }
        if let Some(outcome) = outcome
            && agent.running
        {
            agent.running = false;
            if !matches!(outcome, SubAgentOutcome::Stopped(_))
                && self.runtime.active_turn_id().is_none()
            {
                self.sub_agents.finished_at_rest = Some(task.to_owned());
            }
            // What it asked and nobody answered goes with it.
            events.extend(self.runtime.withdraw_owned(&NativeSubAgentId::new(task)));
            events.push(EventKind::SubAgentEnded {
                sub_agent: NativeSubAgentId::new(task),
                run: text(event, "run_id").map(str::to_owned),
                outcome,
                detail: error,
            });
        }
    }

    fn sub_agent_ended(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let Some(task) = text(event, "task_id") else {
            return;
        };
        if self.late_run(task, text(event, "run_id")) {
            return;
        }
        let outcome = match text(event, "status") {
            Some("completed") => SubAgentOutcome::Completed,
            Some("failed") => SubAgentOutcome::Failed,
            _ => SubAgentOutcome::Stopped(self.stopper(task)),
        };
        let run = text(event, "run_id").map(str::to_owned);
        let Some(agent) = self.sub_agents.known.get_mut(task) else {
            return;
        };
        let current = run.is_none() || agent.run.is_none() || agent.run == run;
        if current {
            // The last to finish while no turn runs is the one the turn Claude Code starts
            // by itself follows.
            let finished_at_rest = agent.running
                && !matches!(outcome, SubAgentOutcome::Stopped(_))
                && self.runtime.active_turn_id().is_none();
            agent.running = false;
            if finished_at_rest {
                self.sub_agents.finished_at_rest = Some(task.to_owned());
            }
        }
        // Its final report is its last message; the notification repeats it, and says it
        // alone when the sub-agent's messages did not arrive.
        let report = text(event, "summary")
            .map(str::trim)
            .filter(|report| !report.is_empty())
            .filter(|_| current && outcome == SubAgentOutcome::Completed)
            .filter(|report| agent.last_text.as_deref().map(str::trim) != Some(*report))
            .map(str::to_owned);
        if let Some(report) = report {
            agent.last_text = Some(report.clone());
            events.push(EventKind::SubAgentMessage {
                sub_agent: NativeSubAgentId::new(task),
                item: self.new_item(),
                text: report,
            });
        }
        self.reports.sub_agent_ended(task);
        // What it asked and nobody answered goes with it.
        events.extend(self.runtime.withdraw_owned(&NativeSubAgentId::new(task)));
        events.push(EventKind::SubAgentEnded {
            sub_agent: NativeSubAgentId::new(task),
            run,
            outcome,
            detail: None,
        });
    }

    /// The result of the tool use that started a sub-agent in the foreground says the
    /// sub-agent is done, whether or not a task notification said it. A sub-agent in the
    /// background goes on past it.
    fn foreground_agent_returned(
        &mut self,
        tool_use: &str,
        failed: bool,
        after_interrupt: bool,
        events: &mut Vec<EventKind>,
    ) {
        let Some(launch) = self.sub_agents.by_tool_use.get(tool_use) else {
            return;
        };
        let Some(agent) = self.sub_agents.known.get_mut(&launch.task) else {
            return;
        };
        if !agent.running || agent.background || agent.tool_use.as_deref() != Some(tool_use) {
            return;
        }
        agent.running = false;
        let (task, run) = (launch.task.clone(), agent.run.clone());
        self.reports.sub_agent_ended(&task);
        events.extend(self.runtime.withdraw_owned(&NativeSubAgentId::new(&task)));
        events.push(EventKind::SubAgentEnded {
            sub_agent: NativeSubAgentId::new(task),
            run,
            // The error a Stop gives the tool is the person's Stop, not a failure.
            outcome: if failed && after_interrupt {
                SubAgentOutcome::Stopped(SubAgentStopper::Person)
            } else if failed {
                SubAgentOutcome::Failed
            } else {
                SubAgentOutcome::Completed
            },
            detail: None,
        });
    }

    /// A permission callback and assistant content can both carry this tool's input.
    fn observe_tool_input(
        &mut self,
        who: Who<'_>,
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
        events.push(tool_event(
            who,
            id,
            title,
            ToolStatus::Running,
            None,
            Some(detail),
        ));
    }

    fn tool_result(&mut self, event: &Value, events: &mut Vec<EventKind>) {
        let failed = event["is_error"] == true;
        let tool_use = text(event, "tool_use_id").unwrap_or_default();
        // A result of a sub-agent not announced yet waits for it.
        if let Some(parent) = text(event, "parent_tool_use_id")
            && !self.sub_agents.by_tool_use.contains_key(parent)
        {
            return self.hold(parent, "tool_result", event);
        }
        if self.reports.is_plan_tool(tool_use) {
            let turn = self.turn(events);
            events.extend(
                self.reports
                    .plan_result(&turn, tool_use, failed, &event["outcome"]),
            );
            return;
        }
        let owner = self.sub_agents.owner.get(tool_use).cloned();
        let declined = text(event, "tool_use_id").is_some_and(|id| self.declined.remove(id));
        let known = text(event, "tool_use_id").and_then(|id| Some((id, self.tools.get(id)?)));
        // A sub-agent's Step needs no turn; the main agent's needs the one it ran in.
        let who = match (&owner, self.active_turn()) {
            (Some(owner), _) => Some(Who::SubAgent(owner)),
            (None, Some(turn)) => Some(Who::Main(turn)),
            (None, None) => None,
        };
        let (Some((id, (title, detail))), Some(who)) = (known, who) else {
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
        let after_interrupt = self
            .active_turn()
            .is_some_and(|turn| self.runtime.interrupted(turn));
        let status = match (failed, declined) {
            (true, true) => ToolStatus::Declined,
            (true, false) if after_interrupt => ToolStatus::FailedAfterInterrupt,
            (true, false) => ToolStatus::Failed,
            (false, _) => ToolStatus::Succeeded,
        };
        events.push(tool_event(
            who,
            id,
            title,
            status,
            Some(output),
            Some(detail),
        ));
        match (&owner, self.active_turn().cloned()) {
            (Some(task), _) => events.extend(self.reports.sub_agent_file_result(
                task,
                id,
                failed,
                &event["outcome"],
            )),
            (None, Some(turn)) => {
                events.extend(
                    self.reports
                        .file_result(&turn, id, failed, &event["outcome"]),
                )
            }
            (None, None) => {}
        }
        self.foreground_agent_returned(tool_use, failed, after_interrupt, events);
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
        // A sub-agent's request is its own (`agent_id` is its task ID): no turn is opened
        // for it, none owns it, and none's end withdraws it.
        let owner = text(event, "agent_id").map(NativeSubAgentId::new);
        let turn = owner.is_none().then(|| self.turn(events));
        // Claude Code can ask before emitting assistant content for the tool.
        if let (Some(id), Some(name), Some(input)) = (
            text(event, "tool_use_id"),
            text(event, "tool_name"),
            event.get("input").filter(|input| input.is_object()),
        ) && !PLAN_TOOLS.contains(&name)
        {
            match (&turn, &owner) {
                (Some(turn), _) => {
                    self.observe_tool_input(Who::Main(turn), id, name, input, events)
                }
                // A sub-agent's tool is its own Step, once the sub-agent is known.
                (None, Some(agent)) if self.sub_agents.known.contains_key(&agent.0) => {
                    self.sub_agents.owner.insert(id.to_owned(), agent.0.clone());
                    self.observe_tool_input(Who::SubAgent(&agent.0), id, name, input, events);
                }
                (None, _) => {}
            }
        }
        let payload = Request {
            questions: None,
            tool_use: text(event, "tool_use_id").map(str::to_owned),
        };
        let registered = match &owner {
            Some(owner) => {
                self.runtime
                    .register_owned_request(request.clone(), owner.clone(), payload)
            }
            None => self
                .runtime
                .register_request(request.clone(), turn.as_ref(), payload),
        };
        if !registered {
            return;
        }
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request,
            turn,
            owner,
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
        // A sub-agent's question is its own, like its permission requests (`agent_id` is
        // its task ID): no turn is opened for it, and only its end withdraws it.
        let owner = text(event, "agent_id").map(NativeSubAgentId::new);
        let turn = owner.is_none().then(|| self.turn(events));
        let payload = Request {
            questions: Some(
                questions
                    .iter()
                    .map(|question| (question.id.clone(), question.multi_select))
                    .collect(),
            ),
            tool_use: None,
        };
        let registered = match &owner {
            Some(owner) => {
                self.runtime
                    .register_owned_request(request.clone(), owner.clone(), payload)
            }
            None => self
                .runtime
                .register_request(request.clone(), turn.as_ref(), payload),
        };
        if !registered {
            return None;
        }
        events.push(EventKind::InteractionRequested(InteractionRequest {
            request,
            turn,
            owner,
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
        let (decision, declined) = self.runtime.answer_and_retain(request, |live| {
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
        self.streams.clear();
        for task in self.sub_agents.turn_ended() {
            // A sub-agent in the foreground was over with the turn, and so was what it asked.
            events.extend(self.runtime.withdraw_owned(&NativeSubAgentId::new(&task)));
        }
        self.pending_inputs = strings(event, "pending_submission_ids")
            .into_iter()
            .collect();
        // The tool calls of a sub-agent still running in the background go on.
        let sub_agents = &self.sub_agents;
        self.tools
            .retain(|tool, _| sub_agents.owner.contains_key(tool));
        // The same goes for what the person declined: a main-agent tool's denial ends with
        // the turn, a background sub-agent's tool may still answer later.
        self.declined
            .retain(|tool| sub_agents.owner.contains_key(tool));
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
