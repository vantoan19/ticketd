//! What Codex reports about a turn and the session beyond messages and tools: its
//! reasoning, plan, changed files, context window and settings. Only values Codex
//! sent are reported; nothing is estimated from commands, model names or tokens.

use std::collections::HashMap;

use serde_json::Value;

use crate::diffstat::counts;
use crate::wire::{capitalized, text};

use crate::{
    AppliesFrom, ContextUsage, EventKind, FileChange, FileChangeKind, HarnessOptions,
    HarnessSettings, ModelChoice, NativeItemId, NativeTurnId, Plan, PlanStep, PlanStepStatus,
    Setting, SettingKey, SettingOption,
};

/// What a `*/list` request has returned so far.
#[derive(Debug, Default)]
enum Listing {
    #[default]
    NotListed,
    Listed(Vec<Value>),
    Failed(String),
}

#[derive(Debug, Default)]
struct Reasoning {
    started_at: Option<i64>,
    /// Summary parts as streamed, by summary index.
    parts: Vec<String>,
    heading: Option<String>,
}

/// One file change item and the files it named, in item order.
#[derive(Debug)]
struct FileItem {
    turn: String,
    item: String,
    files: Vec<FileChange>,
}

/// The permission choice that leaves approvals and the sandbox to the person's own
/// Codex configuration, as Codex applied it to the thread.
pub(super) const OWN_SETTINGS: &str = "own";
/// The permission choice that never asks and runs outside the sandbox.
pub(super) const FULL_ACCESS: &str = "full-access";
/// Where a person's Chat records the choice a session opened for it again applies.
pub(super) const REOPEN_WITH: &str = "reopen_with";
/// Built-in profiles that mean no sandbox, by Codex version: whether the person's
/// requirements allow one is whether Full access is offered.
const FULL_ACCESS_PROFILES: &[&str] = &[":danger-full-access", ":danger-no-sandbox"];

/// Overrides the person chose, sent with the next `turn/start`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct Overrides {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `OWN_SETTINGS` or `FULL_ACCESS`; `None` until the person picks.
    pub permission: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct Reports {
    reasoning: HashMap<String, Reasoning>,
    file_items: Vec<FileItem>,
    /// Net line counts per path from the turn's aggregated diff.
    turn_diffs: HashMap<String, HashMap<String, (u32, u32)>>,
    model: Option<String>,
    effort: Option<String>,
    /// The approval policy the thread last reported, by name.
    approval: Option<String>,
    sandbox: Option<String>,
    /// The person's own approval policy and sandbox for this thread, as Codex
    /// reported them before ticketd changed anything (`approvalPolicy` and
    /// `sandboxPolicy`, ready for `turn/start`). Leaving Full access restores them:
    /// a thread keeps the last policy it was given, across a resume too. Never set
    /// for an Automation's agent, whose sandbox is the agent's.
    pub own: Option<Value>,
    /// The session is a person's Chat, so its own settings are learned when it opens.
    pub persons: bool,
    /// ticketd sent Full access in this session: from then on every turn says which
    /// choice it runs on.
    full_access_sent: bool,
    models: Listing,
    profiles: Listing,
    rerouted_to: Option<String>,
    pub overrides: Overrides,
}

fn owned(value: &Value, key: &str) -> Option<String> {
    text(value, key).map(str::to_owned)
}

/// A heading Codex marked by opening a summary part with bold text.
fn marked_heading(part: &str) -> Option<String> {
    let rest = part.trim_start().strip_prefix("**")?;
    let end = rest.find("**")?;
    let heading = rest[..end].trim();
    (!heading.is_empty()).then(|| heading.to_owned())
}

/// Per-file counts from a multi-file unified diff, keyed by the path after `b/`.
fn per_file_counts(diff: &str) -> HashMap<String, (u32, u32)> {
    let mut files: HashMap<String, (u32, u32)> = HashMap::new();
    let mut current: Option<String> = None;
    let mut old: Option<String> = None;
    let strip = |path: &str| {
        let path = path.split('\t').next().unwrap_or(path);
        path.strip_prefix("a/")
            .or_else(|| path.strip_prefix("b/"))
            .unwrap_or(path)
            .to_owned()
    };
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("--- ") {
            old = (path != "/dev/null").then(|| strip(path));
            current = None;
        } else if let Some(path) = line.strip_prefix("+++ ") {
            current = if path == "/dev/null" {
                old.take()
            } else {
                Some(strip(path))
            };
            if let Some(path) = &current {
                files.entry(path.clone()).or_default();
            }
        } else if let Some(path) = &current {
            let entry = files.entry(path.clone()).or_default();
            if line.starts_with('+') {
                entry.0 = entry.0.saturating_add(1);
            } else if line.starts_with('-') {
                entry.1 = entry.1.saturating_add(1);
            }
        }
    }
    files
}

fn same_file(named: &str, diffed: &str) -> bool {
    named == diffed || named.ends_with(&format!("/{diffed}"))
}

/// A short rendering of a sandbox policy: its `type`.
fn sandbox_type(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| owned(value, "type"))
}

impl Reports {
    // -- reasoning ----------------------------------------------------------------

    pub fn reasoning_started(&mut self, turn: &str, item: &Value, params: &Value) -> EventKind {
        let id = text(item, "id").unwrap_or_default().to_owned();
        let started_at = params
            .get("startedAtMs")
            .or_else(|| item.get("startedAtMs"))
            .and_then(Value::as_i64);
        let state = self.reasoning.entry(id.clone()).or_default();
        state.started_at = started_at;
        EventKind::ReasoningUpdated {
            turn: NativeTurnId::new(turn),
            item: NativeItemId::new(id),
            running: true,
            started_at,
            ended_at: None,
            text: None,
            heading: None,
        }
    }

    /// A summary delta. Reported only when it completes a heading Codex marked, so
    /// streamed text does not become a stream of records.
    pub fn reasoning_delta(&mut self, params: &Value) -> Vec<EventKind> {
        let (Some(turn), Some(item), Some(delta)) = (
            text(params, "turnId"),
            text(params, "itemId"),
            text(params, "delta"),
        ) else {
            return Vec::new();
        };
        let index = params
            .get("summaryIndex")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .unwrap_or(0);
        let state = self.reasoning.entry(item.to_owned()).or_default();
        if state.parts.len() <= index {
            state.parts.resize(index + 1, String::new());
        }
        state.parts[index].push_str(delta);
        let heading = marked_heading(&state.parts[index]);
        if heading.is_none() || heading == state.heading {
            return Vec::new();
        }
        state.heading = heading.clone();
        vec![EventKind::ReasoningUpdated {
            turn: NativeTurnId::new(turn),
            item: NativeItemId::new(item),
            running: true,
            started_at: state.started_at,
            ended_at: None,
            text: None,
            heading,
        }]
    }

    pub fn reasoning_completed(&mut self, turn: &str, item: &Value, params: &Value) -> EventKind {
        let id = text(item, "id").unwrap_or_default().to_owned();
        let state = self.reasoning.remove(&id).unwrap_or_default();
        let summary: Vec<&str> = item
            .get("summary")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|part| !part.trim().is_empty())
            .collect();
        let started_at = item
            .get("startedAtMs")
            .and_then(Value::as_i64)
            .or(state.started_at);
        let ended_at = params
            .get("completedAtMs")
            .or_else(|| item.get("completedAtMs"))
            .and_then(Value::as_i64);
        EventKind::ReasoningUpdated {
            turn: NativeTurnId::new(turn),
            item: NativeItemId::new(id),
            running: false,
            started_at,
            ended_at,
            text: (!summary.is_empty()).then(|| summary.join("\n\n")),
            heading: summary.last().and_then(|part| marked_heading(part)),
        }
    }

    // -- plan ---------------------------------------------------------------------

    pub fn plan(params: &Value) -> Option<EventKind> {
        let turn = text(params, "turnId")?;
        let steps = params
            .get("plan")?
            .as_array()?
            .iter()
            .filter_map(|step| {
                Some(PlanStep {
                    text: owned(step, "step")?,
                    status: match text(step, "status")? {
                        "pending" => PlanStepStatus::Pending,
                        "inProgress" => PlanStepStatus::InProgress,
                        "completed" => PlanStepStatus::Completed,
                        _ => return None,
                    },
                    active_label: None,
                })
            })
            .collect();
        Some(EventKind::PlanUpdated {
            turn: NativeTurnId::new(turn),
            plan: Plan {
                steps,
                explanation: owned(params, "explanation").filter(|note| !note.is_empty()),
            },
        })
    }

    // -- files --------------------------------------------------------------------

    /// A file change item started or ended. One that failed or was declined changed
    /// nothing, so its files leave the list.
    pub fn file_change(&mut self, turn: &str, item: &Value) -> EventKind {
        let id = text(item, "id").unwrap_or_default();
        let status = text(item, "status");
        let confirmed = status == Some("completed");
        self.file_items
            .retain(|known| !(known.turn == turn && known.item == id));
        if !matches!(status, Some("failed" | "declined")) {
            let files = item
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|change| {
                    let path = owned(change, "path")?;
                    let how = change.get("kind");
                    let kind = match how.and_then(|kind| text(kind, "type")) {
                        Some("add") => FileChangeKind::Added,
                        Some("delete") => FileChangeKind::Deleted,
                        _ => match how.and_then(|kind| text(kind, "move_path")) {
                            Some(_) => FileChangeKind::Renamed { from: path.clone() },
                            None => FileChangeKind::Modified,
                        },
                    };
                    let path = how
                        .and_then(|kind| owned(kind, "move_path"))
                        .unwrap_or(path);
                    let (added, removed) = match text(change, "diff") {
                        Some(diff) => {
                            let (added, removed) = counts(&kind, diff);
                            (Some(added), Some(removed))
                        }
                        None => (None, None),
                    };
                    Some(FileChange {
                        path,
                        kind,
                        added_lines: added,
                        removed_lines: removed,
                        confirmed,
                    })
                })
                .collect();
            self.file_items.push(FileItem {
                turn: turn.to_owned(),
                item: id.to_owned(),
                files,
            });
        }
        self.files(turn)
    }

    /// The turn's aggregated diff gives each file's net counts.
    pub fn turn_diff(&mut self, params: &Value) -> Option<EventKind> {
        let turn = text(params, "turnId")?;
        let diff = text(params, "diff")?;
        self.turn_diffs
            .insert(turn.to_owned(), per_file_counts(diff));
        // Nothing to say until a file change item named the files.
        self.file_items
            .iter()
            .any(|known| known.turn == turn)
            .then(|| self.files(turn))
    }

    /// Every file the turn changed, once each, with the net counts when Codex gave them.
    fn files(&self, turn: &str) -> EventKind {
        let mut files: Vec<FileChange> = Vec::new();
        for file in self
            .file_items
            .iter()
            .filter(|known| known.turn == turn)
            .flat_map(|known| &known.files)
        {
            match files.iter_mut().find(|seen| seen.path == file.path) {
                Some(seen) => {
                    seen.added_lines = seen.added_lines.zip(file.added_lines).map(|(a, b)| a + b);
                    seen.removed_lines = seen
                        .removed_lines
                        .zip(file.removed_lines)
                        .map(|(a, b)| a + b);
                    seen.confirmed &= file.confirmed;
                    if file.kind == FileChangeKind::Deleted {
                        seen.kind = FileChangeKind::Deleted;
                    }
                }
                None => files.push(file.clone()),
            }
        }
        if let Some(net) = self.turn_diffs.get(turn) {
            for file in &mut files {
                if let Some((_, &(added, removed))) =
                    net.iter().find(|(path, _)| same_file(&file.path, path))
                {
                    file.added_lines = Some(added);
                    file.removed_lines = Some(removed);
                }
            }
        }
        EventKind::FilesChanged {
            turn: NativeTurnId::new(turn),
            files,
        }
    }

    pub fn turn_started(&mut self) {
        self.rerouted_to = None;
    }

    pub fn turn_ended(&mut self, turn: &str) {
        self.file_items.retain(|known| known.turn != turn);
        self.turn_diffs.remove(turn);
        self.reasoning.clear();
    }

    // -- context ------------------------------------------------------------------

    /// The last request's tokens are what the window holds. Without the window's size
    /// there is nothing to report.
    pub fn token_usage(params: &Value) -> Option<EventKind> {
        let usage = params.get("tokenUsage")?;
        let window = usage.get("modelContextWindow")?.as_u64()?;
        let used = usage.pointer("/last/totalTokens")?.as_u64()?;
        Some(EventKind::ContextUsage(ContextUsage {
            used,
            window,
            categories: Vec::new(),
            compacts_at: None,
        }))
    }

    // -- settings -----------------------------------------------------------------

    /// The settings `thread/start` or `thread/resume` answered with. For a person's
    /// Chat whose own settings are not known from its record, they are these: ticketd
    /// sends no permissions when it opens a thread, so the reply is their Codex
    /// configuration, or what an earlier session of the Chat last gave the thread.
    pub fn thread_opened(&mut self, result: &Value) -> EventKind {
        self.model = owned(result, "model");
        self.effort = owned(result, "reasoningEffort");
        self.approval = approval_name(result.get("approvalPolicy"));
        self.sandbox = sandbox_type(result.get("sandbox"));
        if self.persons && self.own.is_none() {
            self.own = Some(serde_json::json!({
                "approvalPolicy": result.get("approvalPolicy"),
                "sandboxPolicy": result.get("sandbox"),
            }));
        }
        self.settings()
    }

    pub fn settings_updated(&mut self, params: &Value) -> Option<EventKind> {
        let settings = params.get("threadSettings")?;
        self.model = owned(settings, "model").or(self.model.take());
        self.effort = owned(settings, "effort");
        self.approval = approval_name(settings.get("approvalPolicy")).or(self.approval.take());
        self.sandbox = sandbox_type(settings.get("sandboxPolicy")).or(self.sandbox.take());
        Some(self.settings())
    }

    /// The person's choice for this Chat, which a session opened for it again applies:
    /// the pick, else how the thread reports it runs. `None` for an Automation's agent.
    pub fn permission_choice(&self) -> Option<String> {
        let in_effect = if self.full_access_in_effect() {
            FULL_ACCESS
        } else {
            OWN_SETTINGS
        };
        self.persons.then(|| {
            self.overrides
                .permission
                .clone()
                .unwrap_or_else(|| in_effect.to_owned())
        })
    }

    /// The thread reports that it never asks and has no sandbox.
    fn full_access_in_effect(&self) -> bool {
        self.approval.as_deref() == Some("never")
            && self.sandbox.as_deref() == Some("dangerFullAccess")
    }

    /// What the next `turn/start` adds for the person's permission choice: Full
    /// access, or their own settings again once the thread has had Full access.
    pub fn permission_params(&mut self) -> Option<Value> {
        match self.overrides.permission.as_deref() {
            Some(FULL_ACCESS) => {
                self.full_access_sent = true;
                Some(serde_json::json!({
                    "approvalPolicy": "never",
                    "sandboxPolicy": {"type": "dangerFullAccess"},
                }))
            }
            Some(OWN_SETTINGS) if self.full_access_sent || self.full_access_in_effect() => {
                self.own.clone()
            }
            _ => None,
        }
    }

    pub fn rerouted(&mut self, params: &Value) -> EventKind {
        self.rerouted_to = owned(params, "toModel");
        self.settings()
    }

    pub fn models_listed(&mut self, reply: Result<&Value, String>) -> EventKind {
        self.models = listing(reply);
        self.settings()
    }

    pub fn profiles_listed(&mut self, reply: Result<&Value, String>) -> EventKind {
        self.profiles = listing(reply);
        self.settings()
    }

    /// Records a change for the next turn.
    pub fn override_setting(&mut self, setting: SettingKey, value: &str) -> bool {
        match setting {
            SettingKey::Model => self.overrides.model = Some(value.to_owned()),
            SettingKey::Effort => self.overrides.effort = Some(value.to_owned()),
            SettingKey::Permission if [OWN_SETTINGS, FULL_ACCESS].contains(&value) => {
                self.overrides.permission = Some(value.to_owned());
            }
            SettingKey::Permission => return false,
        }
        true
    }

    fn model_entry(&self, model: &str) -> Option<&Value> {
        match &self.models {
            Listing::Listed(models) => models.iter().find(|entry| {
                text(entry, "model") == Some(model) || text(entry, "id") == Some(model)
            }),
            _ => None,
        }
    }

    pub fn settings(&self) -> EventKind {
        let model = self.overrides.model.clone().or(self.model.clone());
        let model_setting = Setting {
            current: model.clone(),
            options: match &self.models {
                Listing::Listed(models) => models.iter().filter_map(model_option).collect(),
                _ => Vec::new(),
            },
            unchangeable: match &self.models {
                Listing::Failed(reason) => Some(format!("Codex did not list its models: {reason}")),
                _ => None,
            },
            applies_from: AppliesFrom::NextTurn,
            answered_by: self.rerouted_to.clone(),
        };
        let entry = model.as_deref().and_then(|model| self.model_entry(model));
        let effort = entry.and_then(|entry| {
            let options = effort_options(entry);
            (!options.is_empty()).then(|| Setting {
                current: self.overrides.effort.clone().or(self.effort.clone()),
                options,
                unchangeable: None,
                applies_from: AppliesFrom::NextTurn,
                answered_by: None,
            })
        });
        // Known once the thread has said how it runs. A pick shows from when it is
        // made, as a model pick does, though it goes out with the next turn; before
        // any pick, what the thread reports is shown.
        let in_effect = if self.full_access_in_effect() {
            FULL_ACCESS
        } else {
            OWN_SETTINGS
        };
        let permission = (self.approval.is_some() || self.sandbox.is_some()).then(|| Setting {
            current: Some(
                self.overrides
                    .permission
                    .clone()
                    .unwrap_or_else(|| in_effect.to_owned()),
            ),
            options: permission_options(&self.profiles),
            // A run's agent keeps the agent's sandbox until the person takes it over.
            unchangeable: (!self.persons).then(|| AUTOMATION_RUNNING.to_owned()),
            applies_from: AppliesFrom::NextTurn,
            answered_by: None,
        });
        EventKind::SettingsState(HarnessSettings {
            model: model.is_some().then_some(model_setting),
            effort,
            permission,
        })
    }
}

const AUTOMATION_RUNNING: &str =
    "An Automation is running this Chat. Reply or stop it to take it over first.";

/// The approval policy a reply names: its value, or `granular` for a granular one.
fn approval_name(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(name) => Some(name.clone()),
        Value::Object(fields) => fields.keys().next().cloned(),
        _ => None,
    }
}

/// The permission setting before a session: the two choices, `choice` current.
pub(super) fn permission_setting(choice: String) -> Setting {
    Setting {
        current: Some(choice),
        options: permission_options(&Listing::NotListed),
        unchangeable: None,
        applies_from: AppliesFrom::NextTurn,
        answered_by: None,
    }
}

/// The person's two choices. Full access is offered unless the person's Codex
/// requirements refuse the no-sandbox profile; a Codex that lists no profiles
/// refuses it, if at all, when the turn asks for it.
fn permission_options(profiles: &Listing) -> Vec<SettingOption> {
    let full_access_allowed = match profiles {
        Listing::Listed(profiles) => profiles
            .iter()
            .find(|profile| FULL_ACCESS_PROFILES.contains(&text(profile, "id").unwrap_or("")))
            .is_none_or(|profile| profile["allowed"] == true),
        _ => true,
    };
    ticketd_core::harnesses::CODEX
        .permissions
        .iter()
        .map(|choice| {
            SettingOption::from_permission(choice, choice.id != FULL_ACCESS || full_access_allowed)
        })
        .collect()
}

/// A model Codex lists and does not hide.
fn model_option(entry: &Value) -> Option<SettingOption> {
    if entry["hidden"] == true {
        return None;
    }
    let id = owned(entry, "model").or_else(|| owned(entry, "id"))?;
    Some(SettingOption {
        label: owned(entry, "displayName").unwrap_or(id.clone()),
        description: owned(entry, "description").filter(|text| !text.is_empty()),
        is_default: entry["isDefault"] == true,
        permission: None,
        allowed: true,
        id,
    })
}

/// A listed model's reasoning efforts in Codex's order, its default marked.
fn effort_options(entry: &Value) -> Vec<SettingOption> {
    let default = text(entry, "defaultReasoningEffort");
    entry
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| {
            let id = owned(option, "reasoningEffort")?;
            Some(SettingOption {
                label: capitalized(&id),
                description: owned(option, "description").filter(|text| !text.is_empty()),
                is_default: Some(id.as_str()) == default,
                permission: None,
                allowed: true,
                id,
            })
        })
        .collect()
}

/// What Codex offers before a thread, from its `model/list` and
/// `permissionProfile/list` replies, and the two permission choices.
pub(super) fn listed_options(models: &[Value], profiles: Option<&[Value]>) -> HarnessOptions {
    let profiles = profiles.map_or(Listing::NotListed, |profiles| {
        Listing::Listed(profiles.to_vec())
    });
    HarnessOptions {
        models: models
            .iter()
            .filter_map(|entry| {
                Some(ModelChoice {
                    model: model_option(entry)?,
                    efforts: effort_options(entry),
                    // Codex lists models by their own names.
                    runs_as: None,
                })
            })
            .collect(),
        permission: Some(Setting {
            current: None,
            options: permission_options(&profiles),
            unchangeable: None,
            applies_from: AppliesFrom::NextTurn,
            answered_by: None,
        }),
    }
}

fn listing(reply: Result<&Value, String>) -> Listing {
    match reply {
        Ok(result) => match result.get("data").and_then(Value::as_array) {
            Some(data) => Listing::Listed(data.clone()),
            None => Listing::Failed("the reply had no list".to_owned()),
        },
        Err(reason) => Listing::Failed(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_heading_is_only_what_codex_marked_in_bold() {
        assert_eq!(
            marked_heading("**Checking the limiter**\n\nI read"),
            Some("Checking the limiter".to_owned())
        );
        assert_eq!(marked_heading("Checking the limiter"), None);
        assert_eq!(marked_heading("**unfinished"), None);
    }

    #[test]
    fn an_aggregated_diff_counts_each_file_and_a_deleted_one_by_its_old_path() {
        let diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same\ndiff --git a/gone.md b/gone.md\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
        let counts = per_file_counts(diff);
        assert_eq!(counts.get("src/a.ts"), Some(&(2, 1)));
        assert_eq!(counts.get("gone.md"), Some(&(0, 1)));
    }
}
