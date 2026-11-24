//! What the Chat screens read about a turn's reasoning, plan and changed files, and
//! about the live session's context window and settings. Each comes from what the
//! harness reported, as the host keeps it; nothing is estimated here.

use serde::Serialize;
use ticketd_chat_host::records::{
    self, FILES_RECORD_NAME, FilesRecord, PLAN_RECORD_NAME, PlanRecord, REASONING_RECORD_NAME,
    ReasoningRecord,
};
use ticketd_chat_host::{
    AppliesFrom, ChatLive, HarnessOptions, LiveSettings, PermissionKind, PlanStepStatus, Setting,
    SettingChangeState, SettingKey, SettingOutcome, StopState,
};
use ticketd_core::{Chat, ChatTool, ChatToolState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanStepView {
    pub text: String,
    pub status: PlanStepStatus,
    pub active_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileView {
    /// Relative to the Chat's folder, or with `~` for the home folder.
    pub path: String,
    /// The absolute path the file opens from.
    pub open_path: String,
    /// `added`, `modified`, `deleted` or `renamed`.
    pub kind: String,
    /// A renamed file's earlier path, shown like `path`.
    pub from: Option<String>,
    pub added_lines: Option<u32>,
    pub removed_lines: Option<u32>,
    pub confirmed: bool,
}

/// A transcript item made from one of the host's turn records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Report {
    Reasoning {
        turn_id: String,
        /// `running`, `done`, `not_finished` (the turn ended first) or `unknown`.
        state: &'static str,
        record: ReasoningRecord,
    },
    Plan {
        turn_id: String,
        /// `running`, `ended`, or `unconfirmed` after a stop that did not confirm.
        state: &'static str,
        steps: Vec<PlanStepView>,
        explanation: Option<String>,
    },
    Files {
        turn_id: String,
        /// `running` or `ended`.
        state: &'static str,
        files: Vec<FileView>,
    },
}

fn absolute(path: &str, folder: &str) -> String {
    if path.starts_with(['/', '\\']) || path.get(1..2) == Some(":") || folder.is_empty() {
        path.to_owned()
    } else {
        format!("{}/{path}", folder.trim_end_matches(['/', '\\']))
    }
}

/// The report `tool` keeps, when it is one of the host's turn records.
pub fn report(
    tool: &ChatTool,
    chat: &Chat,
    live: &ChatLive,
    shown: &dyn Fn(&str) -> String,
) -> Option<Report> {
    let active = chat.active_turn.as_ref().map(|turn| &turn.id) == Some(&tool.turn_id);
    let turn_id = tool.turn_id.clone();
    if let Some(record) =
        records::read::<ReasoningRecord>(&tool.name, REASONING_RECORD_NAME, &tool.input)
    {
        let state = match tool.state {
            ChatToolState::Running if active => "running",
            ChatToolState::Running => "not_finished",
            ChatToolState::Unknown => "unknown",
            _ => "done",
        };
        return Some(Report::Reasoning {
            turn_id,
            state,
            record,
        });
    }
    if let Some(plan) = records::read::<PlanRecord>(&tool.name, PLAN_RECORD_NAME, &tool.input) {
        let state = match (active, live.stop) {
            (true, Some(StopState::Unconfirmed)) => "unconfirmed",
            (true, _) => "running",
            (false, _) => "ended",
        };
        return Some(Report::Plan {
            turn_id,
            state,
            steps: plan
                .steps
                .into_iter()
                .map(|step| PlanStepView {
                    text: step.text,
                    status: step.status,
                    active_label: step.active_label,
                })
                .collect(),
            explanation: plan.explanation,
        });
    }
    let files = records::read::<FilesRecord>(&tool.name, FILES_RECORD_NAME, &tool.input)?;
    let folder = chat.execution_folder.as_str();
    Some(Report::Files {
        turn_id,
        state: if active { "running" } else { "ended" },
        files: files
            .files
            .into_iter()
            .map(|file| FileView {
                path: shown(&file.path),
                open_path: absolute(&file.path, folder),
                kind: file.kind,
                from: file.from.as_deref().map(shown),
                added_lines: file.added_lines,
                removed_lines: file.removed_lines,
                confirmed: file.confirmed,
            })
            .collect(),
    })
}

/// Whether a stored tool is one of the host's turn records, whose display depends on
/// whether its turn is still running.
pub fn is_report(tool: &ChatTool) -> bool {
    [REASONING_RECORD_NAME, PLAN_RECORD_NAME, FILES_RECORD_NAME].contains(&tool.name.as_str())
}

/// A plan as a Document: a checklist where only completed steps are checked.
pub fn plan_document(tool: &ChatTool, chat_title: &str, date: &str) -> Option<String> {
    let plan = records::read::<PlanRecord>(&tool.name, PLAN_RECORD_NAME, &tool.input)?;
    let mut text = format!("From Chat “{chat_title}”, {date}.\n\n");
    if let Some(explanation) = &plan.explanation {
        text.push_str(explanation);
        text.push_str("\n\n");
    }
    for step in &plan.steps {
        let mark = match step.status {
            PlanStepStatus::Completed => "x",
            PlanStepStatus::Pending | PlanStepStatus::InProgress => " ",
        };
        text.push_str(&format!("- [{mark}] {}\n", step.text));
    }
    Some(text)
}

// ---------------------------------------------------------------------------
// Live session: context window and settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContextCategoryView {
    pub name: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContextView {
    pub used: u64,
    pub window: u64,
    pub categories: Vec<ContextCategoryView>,
    pub compacts_at: Option<u64>,
    /// When the harness reported it, in milliseconds since the Unix epoch.
    pub at: i64,
    pub compacted_at: Option<i64>,
}

pub fn context(live: &ChatLive) -> Option<ContextView> {
    let report = live.context.as_ref()?;
    Some(ContextView {
        used: report.usage.used,
        window: report.usage.window,
        categories: report
            .usage
            .categories
            .iter()
            .map(|category| ContextCategoryView {
                name: category.name.clone(),
                tokens: category.tokens,
            })
            .collect(),
        compacts_at: report.usage.compacts_at,
        at: report.at,
        compacted_at: report.compacted_at,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingOptionView {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub is_default: bool,
    /// For a permission option: `read_only`, `ask`, `accept_edits` or `full_access`.
    pub permission: Option<&'static str>,
    /// It can be chosen: the harness's own policy allows it.
    pub allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingChangeView {
    pub value: String,
    /// `held` (until the turn ends), `sent`, `applied`, `refused`, `unconfirmed` or
    /// `unsupported`.
    pub state: &'static str,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingView {
    pub current: Option<String>,
    pub options: Vec<SettingOptionView>,
    pub changeable: bool,
    /// Why it cannot be changed, when it cannot.
    pub reason: Option<String>,
    /// `next_turn` or `next_request`.
    pub applies_from: &'static str,
    pub answered_by: Option<String>,
    /// The latest change the person asked for.
    pub change: Option<SettingChangeView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsView {
    pub model: Option<SettingView>,
    pub effort: Option<SettingView>,
    pub permission: Option<SettingView>,
}

fn permission_name(kind: PermissionKind) -> &'static str {
    match kind {
        PermissionKind::ReadOnly => "read_only",
        PermissionKind::Ask => "ask",
        PermissionKind::AcceptEdits => "accept_edits",
        PermissionKind::FullAccess => "full_access",
    }
}

fn setting(key: SettingKey, setting: Option<&Setting>, live: &LiveSettings) -> Option<SettingView> {
    let setting = setting?;
    let reason = setting.unchangeable.clone();
    let change = live
        .changes
        .iter()
        .find(|change| change.setting == key)
        .map(|change| change_view(&change.value, &change.state));
    Some(SettingView {
        current: setting.current.clone(),
        options: setting.options.iter().map(option_view).collect(),
        changeable: reason.is_none(),
        reason,
        applies_from: match setting.applies_from {
            AppliesFrom::NextTurn => "next_turn",
            AppliesFrom::NextRequest => "next_request",
        },
        answered_by: setting.answered_by.clone(),
        change,
    })
}

fn option_view(option: &ticketd_chat_host::SettingOption) -> SettingOptionView {
    SettingOptionView {
        id: option.id.clone(),
        label: option.label.clone(),
        description: option.description.clone(),
        is_default: option.is_default,
        permission: option.permission.map(permission_name),
        allowed: option.allowed,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelChoiceView {
    #[serde(flatten)]
    pub model: SettingOptionView,
    /// Lowest first; `is_default` marks the model's own default, when said.
    pub efforts: Vec<SettingOptionView>,
    /// The model an alias row runs, by name ("Default" runs "Opus 5.5").
    pub runs_as: Option<String>,
}

/// What New Chat's picker offers for one harness before any session: what the
/// installed harness itself reported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessOptionsView {
    pub harness_id: String,
    pub models: Vec<ModelChoiceView>,
    /// `current` is unset: before a session only the harness's own setting applies.
    pub permission: Option<SettingView>,
    /// Why the picker offers only the harness's default model.
    pub unavailable: Option<String>,
}

pub fn options_view(
    harness_id: &str,
    harness: &str,
    options: Result<HarnessOptions, String>,
) -> HarnessOptionsView {
    let none = LiveSettings {
        reported: ticketd_chat_host::HarnessSettings::default(),
        changes: Vec::new(),
    };
    match options {
        Ok(options) => HarnessOptionsView {
            harness_id: harness_id.to_owned(),
            models: options
                .models
                .iter()
                .map(|choice| ModelChoiceView {
                    model: option_view(&choice.model),
                    efforts: choice.efforts.iter().map(option_view).collect(),
                    runs_as: choice.runs_as.clone(),
                })
                .collect(),
            permission: setting(SettingKey::Permission, options.permission.as_ref(), &none),
            unavailable: options.model_list_error.or_else(|| {
                options
                    .models
                    .is_empty()
                    .then(|| format!("{harness} listed no models"))
            }),
        },
        Err(reason) => HarnessOptionsView {
            harness_id: harness_id.to_owned(),
            models: Vec::new(),
            permission: None,
            unavailable: Some(reason),
        },
    }
}

impl HarnessOptionsView {
    /// Why New Chat's `pick` is not one this harness offered, or `None` when it is.
    pub fn refusal(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        permission: Option<&str>,
    ) -> Option<String> {
        let chosen = match model {
            Some(model) => match self.models.iter().find(|choice| choice.model.id == model) {
                Some(choice) => Some(choice),
                None => return Some(format!("{model} is not a model it offers")),
            },
            None => self.models.iter().find(|choice| choice.model.is_default),
        };
        if let Some(effort) = effort {
            let offered = chosen.is_some_and(|choice| {
                choice
                    .efforts
                    .iter()
                    .any(|option| option.id == effort && option.allowed)
            });
            if !offered {
                return Some(format!("{effort} is not an effort the model offers"));
            }
        }
        if let Some(permission) = permission {
            let offered = self.permission.as_ref().is_some_and(|setting| {
                setting.changeable
                    && setting
                        .options
                        .iter()
                        .any(|option| option.id == permission && option.allowed)
            });
            if !offered {
                return Some(format!(
                    "{permission} is not a permission mode it lets ticketd choose"
                ));
            }
        }
        None
    }
}

pub fn settings(live: &ChatLive) -> Option<SettingsView> {
    let live = live.settings.as_deref()?;
    let reported = &live.reported;
    Some(SettingsView {
        model: setting(SettingKey::Model, reported.model.as_ref(), live),
        effort: setting(SettingKey::Effort, reported.effort.as_ref(), live),
        permission: setting(SettingKey::Permission, reported.permission.as_ref(), live),
    })
}

/// Where a change of a setting to `value` stands, as the screens read it.
pub fn change_view(value: &str, state: &SettingChangeState) -> SettingChangeView {
    let (state, reason) = match state {
        SettingChangeState::Held => ("held", None),
        SettingChangeState::Sent => ("sent", None),
        SettingChangeState::Done(SettingOutcome::Applied) => ("applied", None),
        SettingChangeState::Done(SettingOutcome::Refused { reason }) => {
            ("refused", Some(reason.clone()))
        }
        SettingChangeState::Done(SettingOutcome::Unconfirmed) => ("unconfirmed", None),
        SettingChangeState::Done(SettingOutcome::ReopenSession) => ("held", None),
        SettingChangeState::Done(SettingOutcome::Unsupported) => ("unsupported", None),
    };
    SettingChangeView {
        value: value.to_owned(),
        state,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ticketd_chat_host::{HarnessSettings, LiveSettingChange, SettingOption};

    fn option(id: &str, permission: Option<PermissionKind>) -> SettingOption {
        SettingOption {
            id: id.to_owned(),
            label: id.to_owned(),
            description: None,
            is_default: false,
            permission,
            allowed: true,
        }
    }

    fn permission(current: &str) -> LiveSettings {
        LiveSettings {
            reported: HarnessSettings {
                model: None,
                effort: None,
                permission: Some(Setting {
                    current: Some(current.to_owned()),
                    options: vec![
                        option("ask", Some(PermissionKind::Ask)),
                        option("full", Some(PermissionKind::FullAccess)),
                    ],
                    unchangeable: None,
                    applies_from: AppliesFrom::NextRequest,
                    answered_by: None,
                }),
            },
            changes: vec![LiveSettingChange {
                setting: SettingKey::Permission,
                value: "ask".to_owned(),
                state: SettingChangeState::Held,
            }],
        }
    }

    #[test]
    fn full_access_is_a_choice_in_and_out_of() {
        let view = |current: &str| {
            let live = permission(current);
            setting(
                SettingKey::Permission,
                live.reported.permission.as_ref(),
                &live,
            )
            .unwrap()
        };

        let asking = view("ask");
        let full = asking.options.iter().find(|option| option.id == "full");
        assert_eq!(
            full.map(|option| (option.permission, option.allowed)),
            Some((Some("full_access"), true))
        );
        assert!(asking.changeable);
        assert_eq!(asking.change.unwrap().state, "held");

        let in_full = view("full");
        assert!(in_full.changeable, "a Chat in Full access can leave it");
        assert_eq!(in_full.reason, None);
    }

    #[test]
    fn a_saved_plan_checks_only_completed_steps() {
        let tool = ChatTool {
            id: "plan".to_owned(),
            position: 1,
            turn_id: "turn".to_owned(),
            name: PLAN_RECORD_NAME.to_owned(),
            input: r#"{"steps":[{"text":"Read","status":"completed","active_label":null},{"text":"Write","status":"in_progress","active_label":"Writing"}],"explanation":null}"#.to_owned(),
            state: ChatToolState::Completed,
            output: None,
            output_truncated: false,
            started_at: None,
        };
        assert_eq!(
            plan_document(&tool, "Rate limits", "Nov 13, 2026").as_deref(),
            Some("From Chat “Rate limits”, Nov 13, 2026.\n\n- [x] Read\n- [ ] Write\n")
        );
    }
}
