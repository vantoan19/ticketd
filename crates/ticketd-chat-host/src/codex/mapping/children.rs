//! Codex's sub-agents: the child threads of the Chat's thread.
//!
//! Codex runs a sub-agent as a thread of its own on the same app-server process, in
//! either of its multi-agent versions. v2 announces one with a `subAgentActivity` item
//! (`agentThreadId`, `agentPath`, `model`) in the thread that started it; v1 with a
//! `collabAgentToolCall` of the tool `spawnAgent` (`receiverThreadIds`). Either way the
//! child's own frames name the child's `threadId` and carry the child's own turn IDs, and
//! its `turn/started` says the turn it belongs to (`rootTurnId`). They are routed by
//! thread here; none of them is a turn of the Chat, and none changes the Chat's thread's
//! active turn.
//!
//! One record per child thread. Each turn the child runs is a run of it: a new
//! `turn/started` of a child that ended its last turn is the same sub-agent run again.
//! A child's status is its own turns', never its parent's: it goes on when the parent's
//! turn ends or is interrupted (captures `codex-probe2`, `codex-probe3`).

use serde_json::{Value, json};

use super::{
    EventKind, HashMap, NativeItemId, NativeSubAgentId, Refusal, Session, ToolProgress, ToolStatus,
    delta, item_detail, item_output, item_status, progress_output, text, tool_title,
};
use crate::contract::{SubAgentOutcome, SubAgentStart, SubAgentStopper};

/// The multi-agent v1 tool that starts a child.
const SPAWN: &str = "spawnAgent";

/// A child thread of the Chat's thread.
#[derive(Debug)]
pub(super) struct Child {
    thread: String,
    /// The child thread that started it; `None` when the Chat's own thread did.
    parent: Option<String>,
    /// The turn it runs now.
    turn: Option<String>,
    /// The turn ticketd asked Codex to interrupt: how that turn ended is then the
    /// person's doing.
    stopping: Option<String>,
    /// Its tool calls that have not finished, for their live output.
    tools: HashMap<String, ToolProgress>,
}

/// What a person reads as a sub-agent's name: the last part of its path, in words.
fn agent_name(path: &str) -> Option<String> {
    let name = path.rsplit('/').find(|part| !part.is_empty())?;
    let words = name.replace(['_', '-'], " ");
    let mut letters = words.chars();
    let first = letters.next()?;
    Some(first.to_uppercase().chain(letters).collect())
}

/// A child's run began, as the Chat's host is told.
fn started(child: &Child, run: Option<String>, tool: Option<&str>, native: Value) -> EventKind {
    EventKind::SubAgentStarted(SubAgentStart {
        sub_agent: NativeSubAgentId::new(&child.thread),
        run,
        parent: child.parent.as_deref().map(NativeSubAgentId::new),
        tool: tool.map(NativeItemId::new),
        // Codex's children run on when their parent's turn ends.
        background: true,
        native,
    })
}

impl Session {
    fn child(&self, thread: &str) -> Option<&Child> {
        self.children.iter().find(|child| child.thread == thread)
    }

    fn child_mut(&mut self, thread: &str) -> Option<&mut Child> {
        self.children
            .iter_mut()
            .find(|child| child.thread == thread)
    }

    /// The child that started a thread's work: `None` when it is the Chat's own thread.
    fn spawner(&self, thread: &str) -> Option<String> {
        (self.thread() != Some(thread)).then(|| thread.to_owned())
    }

    /// A child was announced: registers it, or says more of one already seen.
    fn announce(
        &mut self,
        thread: &str,
        parent: Option<String>,
        tool: Option<&str>,
        native: Value,
    ) -> Vec<EventKind> {
        if self.child(thread).is_some() {
            return vec![EventKind::SubAgentUpdated {
                sub_agent: NativeSubAgentId::new(thread),
                run: None,
                background: None,
                native: Some(native),
            }];
        }
        let child = Child {
            thread: thread.to_owned(),
            parent,
            turn: None,
            stopping: None,
            tools: HashMap::new(),
        };
        let event = started(&child, None, tool, native);
        self.children.push(child);
        vec![event]
    }

    /// A child thread's frame arrived before the child was announced: it is a child all
    /// the same, started by the Chat's own thread as far as anyone can tell.
    fn known(&mut self, thread: &str, turn: Option<&str>, native: Value) -> Vec<EventKind> {
        if self.child(thread).is_some() {
            return Vec::new();
        }
        let child = Child {
            thread: thread.to_owned(),
            parent: None,
            turn: turn.map(str::to_owned),
            stopping: None,
            tools: HashMap::new(),
        };
        let event = started(&child, turn.map(str::to_owned), None, native);
        self.children.push(child);
        vec![event]
    }

    /// A notification about a thread that is not the Chat's own: a sub-agent's.
    pub(super) fn child_notification(&mut self, method: &str, params: &Value) -> Vec<EventKind> {
        let Some(thread) = text(params, &["threadId"]) else {
            return Vec::new();
        };
        match method {
            "turn/started" => text(params, &["turn", "id"])
                .map(|turn| {
                    let root = text(params, &["turn", "rootTurnId"]);
                    self.child_turn_started(thread, turn, root)
                })
                .unwrap_or_default(),
            "turn/completed" => params
                .get("turn")
                .map(|turn| self.child_turn_completed(thread, turn))
                .unwrap_or_default(),
            "item/started" => self.child_item(thread, params, false),
            "item/completed" => self.child_item(thread, params, true),
            "item/commandExecution/outputDelta" => self.child_tool_output(thread, params),
            // Everything else a child says (its plan, diff, tokens, errors, requests'
            // resolutions, status) is not shown, and is never the Chat's.
            _ => Vec::new(),
        }
    }

    fn child_turn_started(
        &mut self,
        thread: &str,
        turn: &str,
        root: Option<&str>,
    ) -> Vec<EventKind> {
        let native = json!({"root_turn": root});
        if self.child(thread).is_none() {
            // Not announced: this frame registers it, with this turn as its first run.
            return self.known(thread, Some(turn), native);
        }
        let Some(child) = self.child_mut(thread) else {
            return Vec::new();
        };
        if child.turn.as_deref() == Some(turn) {
            return Vec::new();
        }
        child.turn = Some(turn.to_owned());
        child.stopping = None;
        let child = &*child;
        vec![started(child, Some(turn.to_owned()), None, native)]
    }

    fn child_turn_completed(&mut self, thread: &str, turn: &Value) -> Vec<EventKind> {
        let Some(id) = text(turn, &["id"]) else {
            return Vec::new();
        };
        let Some(child) = self.child_mut(thread) else {
            return Vec::new();
        };
        let (outcome, detail) = match text(turn, &["status"]) {
            Some("completed") => (SubAgentOutcome::Completed, None),
            Some("failed") => (
                SubAgentOutcome::Failed,
                text(turn, &["error", "message"]).map(str::to_owned),
            ),
            // Interrupted: by ticketd when it asked, else by the main agent, the only
            // other thing that ends a child's turn.
            Some("interrupted") => (
                SubAgentOutcome::Stopped(if child.stopping.as_deref() == Some(id) {
                    SubAgentStopper::Person
                } else {
                    SubAgentStopper::MainAgent
                }),
                None,
            ),
            _ => return Vec::new(),
        };
        if child.turn.as_deref() == Some(id) {
            child.turn = None;
            child.stopping = None;
        }
        child.tools.clear();
        vec![EventKind::SubAgentEnded {
            sub_agent: NativeSubAgentId::new(thread),
            run: Some(id.to_owned()),
            outcome,
            detail,
        }]
    }

    fn child_item(&mut self, thread: &str, params: &Value, completed: bool) -> Vec<EventKind> {
        let Some(item) = params.get("item") else {
            return Vec::new();
        };
        let (Some(kind), Some(id)) = (text(item, &["type"]), text(item, &["id"])) else {
            return Vec::new();
        };
        let turn = text(params, &["turnId"]);
        let mut events = self.known(thread, turn, json!({}));
        match kind {
            "agentMessage" if completed => {
                if let Some(words) = text(item, &["text"]).filter(|words| !words.is_empty()) {
                    events.push(EventKind::SubAgentMessage {
                        sub_agent: NativeSubAgentId::new(thread),
                        item: NativeItemId::new(id),
                        text: words.to_owned(),
                    });
                }
            }
            "subAgentActivity" => events.extend(self.sub_agent_activity(thread, item)),
            "collabAgentToolCall" if text(item, &["tool"]) == Some(SPAWN) => {
                events.extend(self.spawned(thread, item));
            }
            _ => {
                let Some(title) = tool_title(kind, item) else {
                    return events;
                };
                events.extend(self.child_tool(thread, turn, id, kind, title, item, completed));
            }
        }
        events
    }

    #[allow(clippy::too_many_arguments)]
    fn child_tool(
        &mut self,
        thread: &str,
        turn: Option<&str>,
        id: &str,
        kind: &str,
        title: String,
        item: &Value,
        completed: bool,
    ) -> Option<EventKind> {
        let child = self.child_mut(thread)?;
        let cut_off = turn.is_some() && child.stopping.as_deref() == turn;
        let status = item_status(item, completed, cut_off);
        let output = item_output(item);
        let detail = item_detail(kind, item);
        if completed {
            child.tools.remove(id);
        } else {
            let progress = ToolProgress {
                title: title.clone(),
                output: String::new(),
                input: (kind == "commandExecution").then(|| detail.clone()),
            };
            child.tools.insert(id.to_owned(), progress);
        }
        Some(EventKind::SubAgentToolUpdated {
            sub_agent: NativeSubAgentId::new(thread),
            item: NativeItemId::new(id),
            title,
            status,
            output,
            detail: Some(detail),
        })
    }

    fn child_tool_output(&mut self, thread: &str, params: &Value) -> Vec<EventKind> {
        let Some((_, item, words)) = delta(params) else {
            return Vec::new();
        };
        let mut events = self.known(thread, text(params, &["turnId"]), json!({}));
        let Some(child) = self.child_mut(thread) else {
            return events;
        };
        let (title, output, input) = progress_output(&mut child.tools, &item.0, words);
        events.push(EventKind::SubAgentToolUpdated {
            sub_agent: NativeSubAgentId::new(thread),
            item,
            title,
            status: ToolStatus::Running,
            output: Some(output),
            detail: input,
        });
        events
    }

    /// multi-agent v2: an item of the thread that started a sub-agent says it began (or,
    /// later, that it finished or was spoken to, which its own turns already said).
    pub(super) fn sub_agent_activity(&mut self, thread: &str, item: &Value) -> Vec<EventKind> {
        if text(item, &["kind"]) != Some("started") {
            return Vec::new();
        }
        let Some(child) = text(item, &["agentThreadId"]) else {
            return Vec::new();
        };
        let path = text(item, &["agentPath"]);
        let native = json!({
            "description": path.and_then(agent_name),
            "agentPath": path,
            "model": item.get("model").filter(|model| model.is_string()),
            "reasoningEffort": item.get("reasoningEffort").filter(|effort| effort.is_string()),
        });
        let parent = self.spawner(thread);
        self.announce(child, parent, None, native)
    }

    /// multi-agent v1: the `spawnAgent` tool call names the threads it started.
    pub(super) fn spawned(&mut self, thread: &str, item: &Value) -> Vec<EventKind> {
        if text(item, &["tool"]) != Some(SPAWN) {
            return Vec::new();
        }
        let tool = text(item, &["id"]);
        let prompt = text(item, &["prompt"]).and_then(|prompt| prompt.lines().next());
        let native = json!({
            "description": prompt.filter(|line| !line.trim().is_empty()),
            "model": item.get("model").filter(|model| model.is_string()),
            "reasoningEffort": item.get("reasoningEffort").filter(|effort| effort.is_string()),
        });
        let parent = self.spawner(thread);
        let receivers: Vec<String> = item
            .get("receiverThreadIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect();
        receivers
            .iter()
            .flat_map(|receiver| self.announce(receiver, parent.clone(), tool, native.clone()))
            .collect()
    }

    /// The turns of the child threads that run now, oldest child first, for Stop.
    pub(crate) fn live_child_turns(&self) -> Vec<(String, String)> {
        self.children
            .iter()
            .filter_map(|child| Some((child.thread.clone(), child.turn.clone()?)))
            .collect()
    }

    /// ticketd is about to ask Codex to interrupt a child's turn. Refused when that turn
    /// is over.
    pub(crate) fn child_interrupt_asked(
        &mut self,
        thread: &str,
        turn: &str,
    ) -> Result<(), Refusal> {
        match self.child_mut(thread) {
            Some(child) if child.turn.as_deref() == Some(turn) => {
                child.stopping = Some(turn.to_owned());
                Ok(())
            }
            _ => Err(Refusal::TurnMismatch { active: None }),
        }
    }
}
