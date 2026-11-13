//! What Claude Code reports beyond messages and tools, through the bridge: thinking,
//! its to-do list and tasks, the files its edit tools changed, the context window
//! and the session's settings. Only values Claude Code or the SDK reported are used.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::wire::{capitalized, text};

use crate::{
    AppliesFrom, ContextCategory, ContextUsage, EventKind, FileChange, FileChangeKind,
    HarnessSettings, NativeItemId, NativeTurnId, PermissionKind, Plan, PlanStep, PlanStepStatus,
    Setting, SettingOption,
};

/// Tools whose calls are the plan, shown as the plan and never as steps.
pub(super) const PLAN_TOOLS: &[&str] = &[
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
];
/// Tools that change one file, named by `file_path` (`notebook_path` for notebooks).
const FILE_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Permission modes ticketd can offer: never `bypassPermissions`.
const PERMISSION_MODES: &[(&str, &str, PermissionKind)] = &[
    ("default", "Ask before edits", PermissionKind::Ask),
    ("acceptEdits", "Accept edits", PermissionKind::AcceptEdits),
    ("plan", "Plan only", PermissionKind::ReadOnly),
];

#[derive(Debug)]
struct Thinking {
    index: Option<i64>,
    item: NativeItemId,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    stopped: bool,
    text: Option<String>,
}

#[derive(Debug, Clone)]
struct Task {
    id: String,
    subject: String,
    status: PlanStepStatus,
    active_form: Option<String>,
}

/// A plan tool call waiting for its result.
#[derive(Debug)]
enum PlanCall {
    Todo,
    Create { active_form: Option<String> },
    Update(Value),
    Read,
}

#[derive(Debug, Default)]
pub(super) struct Reports {
    thinking_started: u64,
    thinking: VecDeque<Thinking>,
    plan_calls: HashMap<String, PlanCall>,
    /// Claude Code's task list, which lasts for the session.
    tasks: Vec<Task>,
    /// The files of the open turn, by the tool use that changed them.
    files: Vec<(String, FileChange)>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    models: Option<Vec<Value>>,
}

fn status(name: &str) -> Option<PlanStepStatus> {
    Some(match name {
        "pending" => PlanStepStatus::Pending,
        "in_progress" => PlanStepStatus::InProgress,
        "completed" => PlanStepStatus::Completed,
        _ => return None,
    })
}

impl Reports {
    // -- thinking -----------------------------------------------------------------

    pub fn thinking(&mut self, turn: &NativeTurnId, event: &Value) -> Vec<EventKind> {
        if !event["parent_tool_use_id"].is_null() {
            return Vec::new();
        }
        let index = event["index"].as_i64();
        let at = event["at"].as_i64();
        match text(event, "phase") {
            Some("started") => {
                self.thinking_started += 1;
                let item = NativeItemId(format!("thinking-{}", self.thinking_started));
                self.thinking.push_back(Thinking {
                    index,
                    item,
                    started_at: at,
                    ended_at: None,
                    stopped: false,
                    // Redacted thinking has no text to wait for.
                    text: (event["redacted"] == true).then(String::new),
                });
                let started = self
                    .thinking
                    .back()
                    .map(|thinking| self.update(turn, thinking));
                started.into_iter().collect()
            }
            Some("stopped") => {
                let Some(position) = self
                    .thinking
                    .iter()
                    .position(|thinking| thinking.index == index && !thinking.stopped)
                else {
                    return Vec::new();
                };
                let thinking = &mut self.thinking[position];
                thinking.stopped = true;
                thinking.ended_at = at;
                let update = self.update(turn, &self.thinking[position]);
                if self.thinking[position].text.is_some() {
                    self.thinking.remove(position);
                }
                vec![update]
            }
            _ => Vec::new(),
        }
    }

    /// The final text of a thinking block, in the order the blocks began. A block whose
    /// start was not seen is reported without times.
    pub fn thinking_text(&mut self, turn: &NativeTurnId, said: &str) -> EventKind {
        let said = Some(said.to_owned()).filter(|said| !said.trim().is_empty());
        let position = match self.thinking.iter().position(|t| t.text.is_none()) {
            Some(position) => position,
            None => {
                self.thinking_started += 1;
                self.thinking.push_back(Thinking {
                    index: None,
                    item: NativeItemId(format!("thinking-{}", self.thinking_started)),
                    started_at: None,
                    ended_at: None,
                    stopped: true,
                    text: None,
                });
                self.thinking.len() - 1
            }
        };
        // An empty text still settles the block, so the next text goes to the next one.
        self.thinking[position].text = Some(said.unwrap_or_default());
        let update = self.update(turn, &self.thinking[position]);
        if self.thinking[position].stopped {
            self.thinking.remove(position);
        }
        update
    }

    fn update(&self, turn: &NativeTurnId, thinking: &Thinking) -> EventKind {
        EventKind::ReasoningUpdated {
            turn: turn.clone(),
            item: thinking.item.clone(),
            running: !thinking.stopped,
            started_at: thinking.started_at,
            ended_at: thinking.ended_at,
            text: thinking.text.clone().filter(|text| !text.is_empty()),
            heading: None,
        }
    }

    // -- plan ---------------------------------------------------------------------

    /// A plan tool was called. `TodoWrite` carries the whole list; the task tools say
    /// what changed only in their results.
    pub fn plan_tool(
        &mut self,
        turn: &NativeTurnId,
        id: &str,
        name: &str,
        input: &Value,
    ) -> Vec<EventKind> {
        let call = match name {
            "TodoWrite" => {
                let steps = input["todos"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|todo| {
                        Some(PlanStep {
                            text: text(todo, "content")?.to_owned(),
                            status: status(text(todo, "status")?)?,
                            active_label: text(todo, "activeForm").map(str::to_owned),
                        })
                    })
                    .collect();
                self.plan_calls.insert(id.to_owned(), PlanCall::Todo);
                return vec![EventKind::PlanUpdated {
                    turn: turn.clone(),
                    plan: Plan {
                        steps,
                        explanation: None,
                    },
                }];
            }
            "TaskCreate" => PlanCall::Create {
                active_form: text(input, "activeForm").map(str::to_owned),
            },
            "TaskUpdate" => PlanCall::Update(input.clone()),
            _ => PlanCall::Read,
        };
        self.plan_calls.insert(id.to_owned(), call);
        Vec::new()
    }

    pub fn is_plan_tool(&self, id: &str) -> bool {
        self.plan_calls.contains_key(id)
    }

    /// A plan tool's result. Only a result Claude Code reported changes the list.
    pub fn plan_result(
        &mut self,
        turn: &NativeTurnId,
        id: &str,
        failed: bool,
        outcome: &Value,
    ) -> Vec<EventKind> {
        let Some(call) = self.plan_calls.remove(id) else {
            return Vec::new();
        };
        if failed {
            return Vec::new();
        }
        let changed = match (call, text(outcome, "kind")) {
            (PlanCall::Create { active_form }, Some("task_created")) => {
                let (Some(task), Some(subject)) =
                    (text(outcome, "task_id"), text(outcome, "subject"))
                else {
                    return Vec::new();
                };
                self.tasks.push(Task {
                    id: task.to_owned(),
                    subject: subject.to_owned(),
                    status: PlanStepStatus::Pending,
                    active_form,
                });
                true
            }
            (PlanCall::Update(input), Some("task_updated")) if outcome["success"] == true => {
                let task_id = text(outcome, "task_id").unwrap_or_default();
                if text(&input, "status") == Some("deleted") {
                    self.tasks.retain(|task| task.id != task_id);
                } else if let Some(task) = self.tasks.iter_mut().find(|task| task.id == task_id) {
                    if let Some(next) = text(&input, "status").and_then(status) {
                        task.status = next;
                    }
                    if let Some(subject) = text(&input, "subject") {
                        task.subject = subject.to_owned();
                    }
                    if let Some(active) = text(&input, "activeForm") {
                        task.active_form = Some(active.to_owned());
                    }
                }
                true
            }
            (_, Some("task_list")) => {
                let listed = outcome["tasks"].as_array().cloned().unwrap_or_default();
                self.tasks = listed
                    .iter()
                    .filter_map(|entry| {
                        let id = text(entry, "id")?;
                        let known = self.tasks.iter().find(|task| task.id == id);
                        Some(Task {
                            id: id.to_owned(),
                            subject: text(entry, "subject")?.to_owned(),
                            status: status(text(entry, "status")?)?,
                            active_form: known.and_then(|task| task.active_form.clone()),
                        })
                    })
                    .collect();
                true
            }
            _ => false,
        };
        if !changed {
            return Vec::new();
        }
        vec![EventKind::PlanUpdated {
            turn: turn.clone(),
            plan: Plan {
                steps: self
                    .tasks
                    .iter()
                    .map(|task| PlanStep {
                        text: task.subject.clone(),
                        status: task.status,
                        active_label: task.active_form.clone(),
                    })
                    .collect(),
                explanation: None,
            },
        }]
    }

    // -- files --------------------------------------------------------------------

    /// An edit tool started: its file is listed, not confirmed until its result.
    pub fn file_tool(
        &mut self,
        turn: &NativeTurnId,
        id: &str,
        name: &str,
        input: &Value,
    ) -> Option<EventKind> {
        if !FILE_TOOLS.contains(&name) {
            return None;
        }
        let path = text(input, "file_path").or_else(|| text(input, "notebook_path"))?;
        self.files.push((
            id.to_owned(),
            FileChange {
                path: path.to_owned(),
                kind: FileChangeKind::Modified,
                added_lines: None,
                removed_lines: None,
                confirmed: false,
            },
        ));
        Some(self.files_changed(turn))
    }

    /// An edit tool's result. A failed or declined edit changed nothing.
    pub fn file_result(
        &mut self,
        turn: &NativeTurnId,
        id: &str,
        failed: bool,
        outcome: &Value,
    ) -> Option<EventKind> {
        let position = self.files.iter().position(|(tool, _)| tool == id)?;
        if failed {
            self.files.remove(position);
            return Some(self.files_changed(turn));
        }
        let file = &mut self.files[position].1;
        file.confirmed = true;
        if text(outcome, "kind") == Some("file") {
            if text(outcome, "change") == Some("create") {
                file.kind = FileChangeKind::Added;
            }
            let count = |key: &str| outcome[key].as_u64().and_then(|n| u32::try_from(n).ok());
            file.added_lines = count("added_lines");
            file.removed_lines = count("removed_lines");
        }
        Some(self.files_changed(turn))
    }

    /// Each file once; several edits of one file add up, and stay unconfirmed while
    /// any of them is.
    fn files_changed(&self, turn: &NativeTurnId) -> EventKind {
        let mut files: Vec<FileChange> = Vec::new();
        for (_, file) in &self.files {
            match files.iter_mut().find(|seen| seen.path == file.path) {
                Some(seen) => {
                    seen.added_lines = seen.added_lines.zip(file.added_lines).map(|(a, b)| a + b);
                    seen.removed_lines = seen
                        .removed_lines
                        .zip(file.removed_lines)
                        .map(|(a, b)| a + b);
                    seen.confirmed &= file.confirmed;
                }
                None => files.push(file.clone()),
            }
        }
        EventKind::FilesChanged {
            turn: turn.clone(),
            files,
        }
    }

    pub fn turn_ended(&mut self) {
        self.thinking.clear();
        self.files.clear();
        self.plan_calls.clear();
    }

    // -- context ------------------------------------------------------------------

    pub fn context(event: &Value) -> Option<EventKind> {
        let used = event["total_tokens"].as_u64()?;
        let window = event["max_tokens"].as_u64().filter(|window| *window > 0)?;
        Some(EventKind::ContextUsage(ContextUsage {
            used,
            window,
            categories: event["categories"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|category| {
                    Some(ContextCategory {
                        name: text(category, "name")?.to_owned(),
                        tokens: category["tokens"].as_u64()?,
                    })
                })
                .collect(),
            compacts_at: event["compacts_at"].as_u64(),
        }))
    }

    // -- settings -----------------------------------------------------------------

    /// `session_info`: what Claude Code says is in effect.
    pub fn session_info(&mut self, event: &Value) -> Option<EventKind> {
        let before = (
            self.model.clone(),
            self.permission_mode.clone(),
            self.effort.clone(),
        );
        self.model = text(event, "model")
            .map(str::to_owned)
            .or(self.model.take());
        self.permission_mode = text(event, "permission_mode")
            .map(str::to_owned)
            .or(self.permission_mode.take());
        self.effort = text(event, "effort")
            .map(str::to_owned)
            .or(self.effort.take());
        let after = (
            self.model.clone(),
            self.permission_mode.clone(),
            self.effort.clone(),
        );
        (before != after).then(|| self.settings())
    }

    /// `session_initialized`: the models the SDK offers. Said once Claude Code has
    /// said what is in effect.
    pub fn initialized(&mut self, event: &Value) -> Option<EventKind> {
        self.models = event["models"].as_array().cloned();
        self.model.is_some().then(|| self.settings())
    }

    fn current_model(&self) -> Option<&Value> {
        let model = self.model.as_deref()?;
        self.models.iter().flatten().find(|entry| {
            text(entry, "value") == Some(model) || text(entry, "resolved_model") == Some(model)
        })
    }

    pub fn settings(&self) -> EventKind {
        let entry = self.current_model();
        let model = self.model.as_ref().map(|model| Setting {
            current: entry
                .and_then(|entry| text(entry, "value"))
                .map_or_else(|| model.clone(), str::to_owned)
                .into(),
            options: self
                .models
                .iter()
                .flatten()
                .filter_map(|entry| {
                    let id = text(entry, "value")?.to_owned();
                    Some(SettingOption {
                        label: text(entry, "display_name").unwrap_or(&id).to_owned(),
                        description: text(entry, "description")
                            .filter(|text| !text.is_empty())
                            .map(str::to_owned),
                        // The SDK lists Claude Code's default as the `default` row.
                        is_default: id == "default",
                        permission: None,
                        allowed: true,
                        id,
                    })
                })
                .collect(),
            unchangeable: None,
            applies_from: AppliesFrom::NextRequest,
            answered_by: None,
        });
        let effort = entry.and_then(|entry| {
            let levels = entry["effort_levels"].as_array()?;
            let options: Vec<SettingOption> = levels
                .iter()
                .filter_map(Value::as_str)
                .map(|level| SettingOption {
                    id: level.to_owned(),
                    label: capitalized(level),
                    description: None,
                    is_default: false,
                    permission: None,
                    allowed: true,
                })
                .collect();
            (!options.is_empty()).then(|| Setting {
                current: self.effort.clone(),
                options,
                unchangeable: None,
                applies_from: AppliesFrom::NextRequest,
                answered_by: None,
            })
        });
        let permission = self.permission_mode.as_ref().map(|mode| {
            let mut options: Vec<SettingOption> = PERMISSION_MODES
                .iter()
                .map(|(id, label, kind)| SettingOption {
                    id: (*id).to_owned(),
                    label: (*label).to_owned(),
                    description: None,
                    is_default: *id == "default",
                    permission: Some(*kind),
                    allowed: true,
                })
                .collect();
            let bypass = mode == "bypassPermissions";
            if !options.iter().any(|option| &option.id == mode) {
                // A mode ticketd does not offer is shown as what is in effect.
                options.push(SettingOption {
                    id: mode.clone(),
                    label: if bypass {
                        "Full access".to_owned()
                    } else {
                        mode.clone()
                    },
                    description: None,
                    is_default: false,
                    permission: bypass.then_some(PermissionKind::FullAccess),
                    allowed: false,
                });
            }
            Setting {
                current: Some(mode.clone()),
                options,
                // ticketd never moves a session out of, or into, skipped permissions.
                unchangeable: bypass.then(|| "Set in Claude Code's settings".to_owned()),
                applies_from: AppliesFrom::NextRequest,
                answered_by: None,
            }
        });
        EventKind::SettingsState(HarnessSettings {
            model,
            effort,
            permission,
        })
    }
}
