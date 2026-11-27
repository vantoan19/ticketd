//! What Claude Code reports beyond messages and tools, through the bridge: thinking,
//! its to-do list and tasks, the files its edit tools changed, the context window
//! and the session's settings. Only values Claude Code or the SDK reported are used.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::wire::{capitalized, text};

use crate::{
    AppliesFrom, ContextCategory, ContextUsage, EventKind, FileChange, FileChangeKind,
    HarnessOptions, HarnessSettings, ModelChoice, NativeItemId, NativeSubAgentId, NativeTurnId,
    Plan, PlanStep,
    PlanStepStatus, Setting, SettingOption,
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

/// The model row the SDK lists for Claude Code's own default, which New Chat marks
/// as its default.
pub(super) const DEFAULT_MODEL: &str = "default";
/// The permission mode New Chat marks as its default: "Ask before edits".
pub(super) const DEFAULT_PERMISSION_MODE: &str = "default";

/// Why a run's agent's settings cannot be changed in its Chat.
const AUTOMATION_RUNNING: &str =
    "An Automation is running this Chat. Reply or stop it to take it over first.";

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

/// The files one run of a sub-agent changed, by the tool use that changed them.
#[derive(Debug, Default)]
struct SubFiles {
    run: Option<String>,
    files: Vec<(String, FileChange)>,
}

#[derive(Debug, Default)]
pub(super) struct Reports {
    thinking_started: u64,
    thinking: VecDeque<Thinking>,
    /// A sub-agent's thinking blocks, by task ID.
    sub_thinking: HashMap<String, VecDeque<Thinking>>,
    plan_calls: HashMap<String, PlanCall>,
    /// Claude Code's task list, which lasts for the session.
    tasks: Vec<Task>,
    /// The files of the open turn, by the tool use that changed them.
    files: Vec<(String, FileChange)>,
    /// What each sub-agent's run in progress changed, by task ID.
    sub_files: HashMap<String, SubFiles>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    models: Option<Vec<Value>>,
    /// An Automation run's agent: its settings are the agent's and are not changed.
    unattended: bool,
}

/// One reasoning item as last known, before it is said for the main agent or a sub-agent.
struct Reasoning {
    item: NativeItemId,
    running: bool,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    text: Option<String>,
}

impl Reasoning {
    fn of(thinking: &Thinking) -> Self {
        Self {
            item: thinking.item.clone(),
            running: !thinking.stopped,
            started_at: thinking.started_at,
            ended_at: thinking.ended_at,
            text: thinking.text.clone().filter(|text| !text.is_empty()),
        }
    }

    fn main(self, turn: &NativeTurnId) -> EventKind {
        EventKind::ReasoningUpdated {
            turn: turn.clone(),
            item: self.item,
            running: self.running,
            started_at: self.started_at,
            ended_at: self.ended_at,
            text: self.text,
            heading: None,
        }
    }

    fn sub(self, task: &str, run: Option<&str>) -> EventKind {
        EventKind::SubAgentReasoningUpdated {
            sub_agent: NativeSubAgentId::new(task),
            run: run.map(str::to_owned),
            item: self.item,
            running: self.running,
            started_at: self.started_at,
            ended_at: self.ended_at,
            text: self.text,
        }
    }
}

/// A `thinking` frame: a block began or ended.
fn thinking_frame(
    queue: &mut VecDeque<Thinking>,
    started: &mut u64,
    event: &Value,
) -> Option<Reasoning> {
    let index = event["index"].as_i64();
    let at = event["at"].as_i64();
    match text(event, "phase") {
        Some("started") => {
            *started += 1;
            queue.push_back(Thinking {
                index,
                item: NativeItemId(format!("thinking-{started}")),
                started_at: at,
                ended_at: None,
                stopped: false,
                // Redacted thinking has no text to wait for.
                text: (event["redacted"] == true).then(String::new),
            });
            queue.back().map(Reasoning::of)
        }
        Some("stopped") => {
            let position = queue
                .iter()
                .position(|thinking| thinking.index == index && !thinking.stopped)?;
            let thinking = &mut queue[position];
            thinking.stopped = true;
            thinking.ended_at = at;
            let update = Reasoning::of(thinking);
            if thinking.text.is_some() {
                queue.remove(position);
            }
            Some(update)
        }
        _ => None,
    }
}

/// The final text of the next thinking block that has none.
fn thinking_block(queue: &mut VecDeque<Thinking>, started: &mut u64, said: &str) -> Reasoning {
    let said = Some(said.to_owned()).filter(|said| !said.trim().is_empty());
    let position = match queue.iter().position(|t| t.text.is_none()) {
        Some(position) => position,
        None => {
            *started += 1;
            queue.push_back(Thinking {
                index: None,
                item: NativeItemId(format!("thinking-{started}")),
                started_at: None,
                ended_at: None,
                stopped: true,
                text: None,
            });
            queue.len() - 1
        }
    };
    // An empty text still settles the block, so the next text goes to the next one.
    queue[position].text = Some(said.unwrap_or_default());
    let update = Reasoning::of(&queue[position]);
    if queue[position].stopped {
        queue.remove(position);
    }
    update
}

/// The file an edit tool call changes, before its result confirms it.
fn started_file(name: &str, input: &Value) -> Option<FileChange> {
    if !FILE_TOOLS.contains(&name) {
        return None;
    }
    let path = text(input, "file_path").or_else(|| text(input, "notebook_path"))?;
    Some(FileChange {
        path: path.to_owned(),
        kind: FileChangeKind::Modified,
        added_lines: None,
        removed_lines: None,
        confirmed: false,
    })
}

/// An edit tool's result: the file changed, and by how much when it said.
fn confirm(file: &mut FileChange, outcome: &Value) {
    file.confirmed = true;
    if text(outcome, "kind") == Some("file") {
        if text(outcome, "change") == Some("create") {
            file.kind = FileChangeKind::Added;
        }
        let count = |key: &str| outcome[key].as_u64().and_then(|n| u32::try_from(n).ok());
        file.added_lines = count("added_lines");
        file.removed_lines = count("removed_lines");
    }
}

/// Each file once; several edits of one file add up, and stay unconfirmed while any of
/// them is.
fn listed(edits: &[(String, FileChange)]) -> Vec<FileChange> {
    let mut files: Vec<FileChange> = Vec::new();
    for (_, file) in edits {
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
    files
}

fn sub_files_changed(task: &str, kept: &SubFiles) -> EventKind {
    EventKind::SubAgentFilesChanged {
        sub_agent: NativeSubAgentId::new(task),
        run: kept.run.clone(),
        files: listed(&kept.files),
    }
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
        thinking_frame(&mut self.thinking, &mut self.thinking_started, event)
            .map(|state| state.main(turn))
            .into_iter()
            .collect()
    }

    /// The final text of a thinking block, in the order the blocks began. A block whose
    /// start was not seen is reported without times.
    pub fn thinking_text(&mut self, turn: &NativeTurnId, said: &str) -> EventKind {
        thinking_block(&mut self.thinking, &mut self.thinking_started, said).main(turn)
    }

    /// A thinking frame of a sub-agent: its reasoning is its own, a lane apart from the
    /// main agent's.
    pub fn sub_agent_thinking(
        &mut self,
        task: &str,
        run: Option<&str>,
        event: &Value,
    ) -> Option<EventKind> {
        let queue = self.sub_thinking.entry(task.to_owned()).or_default();
        thinking_frame(queue, &mut self.thinking_started, event).map(|state| state.sub(task, run))
    }

    /// The final text of a thinking block of a sub-agent.
    pub fn sub_agent_thinking_text(
        &mut self,
        task: &str,
        run: Option<&str>,
        said: &str,
    ) -> EventKind {
        let queue = self.sub_thinking.entry(task.to_owned()).or_default();
        thinking_block(queue, &mut self.thinking_started, said).sub(task, run)
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
        let file = started_file(name, input)?;
        self.files.push((id.to_owned(), file));
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
        } else {
            confirm(&mut self.files[position].1, outcome);
        }
        Some(self.files_changed(turn))
    }

    /// Each file once; several edits of one file add up, and stay unconfirmed while
    /// any of them is.
    fn files_changed(&self, turn: &NativeTurnId) -> EventKind {
        EventKind::FilesChanged {
            turn: turn.clone(),
            files: listed(&self.files),
        }
    }

    /// An edit tool of a sub-agent started: its file is listed in that run's own files.
    pub fn sub_agent_file_tool(
        &mut self,
        task: &str,
        run: Option<&str>,
        id: &str,
        name: &str,
        input: &Value,
    ) -> Option<EventKind> {
        let file = started_file(name, input)?;
        let kept = self.sub_files.entry(task.to_owned()).or_default();
        // Another run starts its own list.
        if kept.run.as_deref() != run {
            kept.files.clear();
            kept.run = run.map(str::to_owned);
        }
        kept.files.push((id.to_owned(), file));
        Some(sub_files_changed(task, kept))
    }

    /// The result of an edit tool, when a sub-agent ran it.
    pub fn sub_agent_file_result(
        &mut self,
        task: &str,
        id: &str,
        failed: bool,
        outcome: &Value,
    ) -> Option<EventKind> {
        let kept = self.sub_files.get_mut(task)?;
        let position = kept.files.iter().position(|(tool, _)| tool == id)?;
        if failed {
            kept.files.remove(position);
        } else {
            confirm(&mut kept.files[position].1, outcome);
        }
        Some(sub_files_changed(task, kept))
    }

    /// A sub-agent's run ended: what it kept of its reasoning and files is settled.
    pub fn sub_agent_ended(&mut self, task: &str) {
        self.sub_thinking.remove(task);
        self.sub_files.remove(task);
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

    /// The effort the session was opened with or last switched to. Claude Code's
    /// `session_info` does not always say its effort; until it says another, this
    /// is the one in effect (LIVE2-2).
    pub fn effort_in_effect(&mut self, effort: Option<String>) {
        if effort.is_some() {
            self.effort = effort;
        }
    }

    /// The effort in effect, when known.
    pub fn effort(&self) -> Option<&str> {
        self.effort.as_deref()
    }

    /// The session runs an Automation's agent: its settings are reported unchangeable.
    pub fn unattended(&mut self) {
        self.unattended = true;
    }

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
        // A run's agent keeps the agent's settings until the person takes it over
        // (#387 M15): the controls show them read-only instead of choices refused.
        let locked = self.unattended.then(|| AUTOMATION_RUNNING.to_owned());
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
                .filter_map(model_option)
                .collect(),
            unchangeable: locked.clone(),
            applies_from: AppliesFrom::NextRequest,
            answered_by: None,
        });
        let effort = entry.and_then(|entry| {
            let options = effort_options(entry);
            (!options.is_empty()).then(|| Setting {
                current: self.effort.clone(),
                options,
                unchangeable: locked.clone(),
                applies_from: AppliesFrom::NextRequest,
                answered_by: None,
            })
        });
        let permission = self.permission_mode.as_ref().map(|mode| {
            let mut options = permission_options();
            if !options.iter().any(|option| &option.id == mode) {
                // A mode ticketd does not offer is shown as what is in effect.
                options.push(SettingOption {
                    id: mode.clone(),
                    // Named as the SDK's `PermissionMode` describes each (#387 M15).
                    label: match mode.as_str() {
                        "dontAsk" => "Never asks",
                        "auto" => "Auto",
                        other => other,
                    }
                    .to_owned(),
                    description: None,
                    is_default: false,
                    permission: None,
                    allowed: false,
                });
            }
            Setting {
                current: Some(mode.clone()),
                options,
                unchangeable: locked,
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

/// A model the bridge listed, as `supportedModels()` describes it.
fn model_option(entry: &Value) -> Option<SettingOption> {
    let id = text(entry, "value")?.to_owned();
    Some(SettingOption {
        label: text(entry, "display_name").unwrap_or(&id).to_owned(),
        description: text(entry, "description")
            .filter(|text| !text.is_empty())
            .map(str::to_owned),
        // The SDK lists Claude Code's default as the `default` row.
        is_default: id == DEFAULT_MODEL,
        permission: None,
        allowed: true,
        id,
    })
}

/// The effort levels a listed model supports, lowest first. The SDK names no default.
fn effort_options(entry: &Value) -> Vec<SettingOption> {
    entry["effort_levels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|level| SettingOption {
            id: level.to_owned(),
            label: capitalized(level),
            description: None,
            is_default: false,
            permission: None,
            allowed: true,
        })
        .collect()
}

/// The permission setting before a session: the modes ticketd offers, `mode` current.
pub(super) fn permission_setting(mode: String) -> Setting {
    Setting {
        current: Some(mode),
        options: permission_options(),
        unchangeable: None,
        applies_from: AppliesFrom::NextRequest,
        answered_by: None,
    }
}

/// Whether ticketd offers `mode`, and so may open a session in it.
pub(super) fn offered_permission(mode: &str) -> bool {
    ticketd_core::harnesses::CLAUDE_CODE
        .permissions
        .iter()
        .any(|choice| choice.id == mode)
}

fn permission_options() -> Vec<SettingOption> {
    ticketd_core::harnesses::CLAUDE_CODE
        .permissions
        .iter()
        .map(|choice| SettingOption::from_permission(choice, true))
        .collect()
}

/// The name of the model an alias row runs: the listed row whose own id is the
/// model the alias resolves to, else that model id read as its name
/// ("claude-opus-5-5" is "Opus 5.5"). `None` for a row that is not an alias.
fn runs_as(models: &[Value], entry: &Value) -> Option<String> {
    let value = text(entry, "value")?;
    let resolved = text(entry, "resolved_model").filter(|resolved| *resolved != value)?;
    let listed = models.iter().find(|other| {
        text(other, "value") != Some(value)
            && (text(other, "value") == Some(resolved)
                || text(other, "resolved_model") == Some(resolved))
    });
    let name = match listed.and_then(|other| text(other, "display_name")) {
        Some(name) => Some(name.to_owned()),
        None => model_name(resolved),
    };
    // A row already named after what it runs ("Sonnet 5") says nothing more.
    name.filter(|name| Some(name.as_str()) != text(entry, "display_name"))
}

/// "claude-opus-5-5" as "Opus 5.5"; `None` for an id of another shape.
fn model_name(id: &str) -> Option<String> {
    let mut parts = id.strip_prefix("claude-")?.split('-');
    let family = parts
        .next()
        .filter(|family| family.chars().all(char::is_alphabetic))?;
    let version: Vec<&str> = parts
        .take_while(|part| part.len() <= 2 && part.chars().all(|c| c.is_ascii_digit()))
        .collect();
    if version.is_empty() {
        return None;
    }
    Some(format!("{} {}", capitalized(family), version.join(".")))
}

/// What Claude Code offers before a session, from the models the bridge listed. Its
/// permission mode is not known until a session starts (`current` is `None`): with no
/// pick, the session keeps whatever Claude Code's own settings choose.
pub(super) fn listed_options(models: &[Value]) -> HarnessOptions {
    HarnessOptions {
        model_list_error: None,
        models: models
            .iter()
            .filter_map(|entry| {
                Some(ModelChoice {
                    model: model_option(entry)?,
                    efforts: effort_options(entry),
                    runs_as: runs_as(models, entry),
                })
            })
            .collect(),
        permission: Some(Setting {
            current: None,
            options: permission_options(),
            unchangeable: None,
            applies_from: AppliesFrom::NextRequest,
            answered_by: None,
        }),
    }
}
