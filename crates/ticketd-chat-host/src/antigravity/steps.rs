//! Tool observations retain ACP's shape after extracting any bulky output.
use agent_client_protocol_schema::v1 as acp;
use serde_json::{Value, json};
use ticketd_core::ChatToolState;

use crate::tool_steps::{CommandFacts, shell_step};
use crate::{
    EventKind, FileChange, FileChangeKind, FileTargets, LineCounts, MAX_PROVIDER_DETAIL_BYTES,
    NativeItemId, NativeTurnId, ProviderDetail, ReadAction, ReadTarget, RunAction, SearchScope,
    SearchTarget, StepAction, ToolEvidence, ToolStatus, ToolStep, WebAction,
};

pub(crate) fn read_steps(evidence: ToolEvidence<'_>) -> Vec<ToolStep> {
    let Ok(tool) = serde_json::from_str::<acp::ToolCall>(evidence.input) else {
        return vec![
            StepAction::Other {
                name: evidence.name.to_owned(),
            }
            .into(),
        ];
    };
    let input = tool.raw_input.as_ref().unwrap_or(&Value::Null);
    let text = |keys: &[&str]| keys.iter().find_map(|key| input[*key].as_str());
    let locations = || {
        if tool.locations.is_empty() {
            [
                "AbsolutePath",
                "TargetFile",
                "SourcePath",
                "DestinationPath",
                "path",
            ]
            .iter()
            .filter_map(|key| input[*key].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
        } else {
            tool.locations
                .iter()
                .map(|item| item.path.to_string_lossy().into_owned())
                .collect()
        }
    };
    let action = match tool.kind {
        acp::ToolKind::Execute => {
            if let Some(command) = text(&["CommandLine", "command"]) {
                return vec![shell_step(
                    evidence,
                    command,
                    CommandFacts {
                        working_directory: text(&["Cwd", "cwd", "WorkingDirectory"]),
                        exit_code: tool
                            .raw_output
                            .as_ref()
                            .and_then(|output| output["exit_code"].as_i64()),
                        ..CommandFacts::default()
                    },
                )];
            }
            StepAction::Run(RunAction::Command)
        }
        acp::ToolKind::Read => {
            let program = tool.name.as_deref().unwrap_or("");
            if program == "list_dir" || program == "list_directory" {
                StepAction::Read(ReadAction::List(locations()))
            } else {
                StepAction::Read(ReadAction::Files(
                    locations()
                        .into_iter()
                        .map(|path| {
                            let lines = tool
                                .locations
                                .iter()
                                .find(|location| location.path == std::path::Path::new(&path))
                                .and_then(|location| location.line.map(|line| (line, line)));
                            ReadTarget { path, lines }
                        })
                        .collect(),
                ))
            }
        }
        acp::ToolKind::Search => StepAction::Search {
            targets: text(&["Query", "Pattern", "query"])
                .map(|query| SearchTarget {
                    query: query.to_owned(),
                    scope: text(&["SearchPath", "path"])
                        .map(|path| SearchScope::Path(path.to_owned())),
                })
                .into_iter()
                .collect(),
            no_matches: evidence.state == ChatToolState::Completed
                && evidence
                    .output
                    .is_none_or(|output| output.trim().is_empty()),
        },
        acp::ToolKind::Edit | acp::ToolKind::Move => {
            let created: Vec<_> = diffs(&tool)
                .filter(|diff| diff.old_text.is_none())
                .collect();
            if tool.kind == acp::ToolKind::Edit
                && !created.is_empty()
                && created.len() == diffs(&tool).count()
            {
                StepAction::Create {
                    targets: FileTargets::Paths(
                        created
                            .iter()
                            .map(|diff| diff.path.to_string_lossy().into_owned())
                            .collect(),
                    ),
                    counts: LineCounts {
                        added: tool
                            .raw_input
                            .as_ref()
                            .and_then(|value| value["_ticketdAddedLines"].as_u64())
                            .and_then(|lines| u32::try_from(lines).ok()),
                        removed: None,
                    },
                }
            } else {
                StepAction::Edit {
                    targets: FileTargets::Paths(locations()),
                    counts: LineCounts::default(),
                }
            }
        }
        acp::ToolKind::Delete => StepAction::Delete {
            paths: locations(),
            counts: LineCounts::default(),
        },
        acp::ToolKind::Fetch => match text(&["Url", "URL", "url"]) {
            Some(url) => StepAction::Web(WebAction::Fetch {
                url: url.to_owned(),
            }),
            None => StepAction::Other {
                name: evidence.name.to_owned(),
            },
        },
        acp::ToolKind::Think => return Vec::new(),
        _ => StepAction::Other {
            name: evidence.name.to_owned(),
        },
    };
    vec![action.into()]
}

pub(super) fn merge(tool: &mut acp::ToolCall, update: acp::ToolCallUpdateFields) {
    if let Some(title) = update.title {
        tool.title = title;
    }
    if let Some(name) = update.name {
        tool.name = Some(name);
    }
    if let Some(kind) = update.kind {
        tool.kind = kind;
    }
    if let Some(status) = update.status {
        tool.status = status;
    }
    if let Some(locations) = update.locations {
        tool.locations = locations;
    }
    if let Some(content) = update.content {
        tool.content = content;
    }
    if let Some(input) = update.raw_input {
        match (tool.raw_input.as_mut(), input) {
            (Some(Value::Object(known)), Value::Object(update)) => known.extend(update),
            (_, input) => tool.raw_input = Some(input),
        }
    }
    if update.raw_output.is_some() {
        tool.raw_output = update.raw_output;
    }
}

fn diffs(tool: &acp::ToolCall) -> impl Iterator<Item = &acp::Diff> {
    tool.content.iter().filter_map(|item| match item {
        acp::ToolCallContent::Diff(diff) => Some(diff),
        _ => None,
    })
}

pub(super) fn changes(tool: &acp::ToolCall) -> Vec<FileChange> {
    if tool.status == acp::ToolCallStatus::Failed {
        return Vec::new();
    }
    diffs(tool)
        .map(|diff| FileChange {
            path: diff.path.to_string_lossy().into_owned(),
            kind: if diff.old_text.is_none() {
                FileChangeKind::Added
            } else {
                FileChangeKind::Modified
            },
            added_lines: diff
                .old_text
                .is_none()
                .then(|| u32::try_from(diff.new_text.lines().count()).unwrap_or(u32::MAX)),
            removed_lines: diff.old_text.is_none().then_some(0),
            confirmed: tool.status == acp::ToolCallStatus::Completed,
        })
        .collect()
}

pub(super) fn observed(tool: &acp::ToolCall, turn: NativeTurnId, declined: bool) -> EventKind {
    let output = tool
        .raw_output
        .as_ref()
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value["output"].as_str())
                .map(str::to_owned)
        })
        .or_else(|| {
            let texts: Vec<_> = tool
                .content
                .iter()
                .filter_map(|part| match part {
                    acp::ToolCallContent::Content(content)
                        if let acp::ContentBlock::Text(text) = &content.content =>
                    {
                        Some(text.text.as_str())
                    }
                    _ => None,
                })
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        });
    let status = match tool.status {
        _ if declined => ToolStatus::Declined,
        acp::ToolCallStatus::Completed => ToolStatus::Succeeded,
        acp::ToolCallStatus::Failed => ToolStatus::Failed,
        _ => ToolStatus::Running,
    };
    let mut native = tool.clone();
    native.raw_output = tool.raw_output.as_ref().and_then(|output| {
        output["exit_code"]
            .as_i64()
            .map(|code| json!({"exit_code": code}))
    });
    native.content = diffs(tool)
        .take(32)
        .map(|diff| {
            // File content is output. Only its path and creation semantics belong here.
            let mut copy = acp::Diff::new(diff.path.clone(), "");
            copy.old_text = diff.old_text.as_ref().map(|_| String::new());
            acp::ToolCallContent::Diff(copy)
        })
        .collect();
    if tool.raw_input.as_ref().is_none_or(Value::is_object)
        && diffs(tool).next().is_some()
        && diffs(tool).all(|diff| diff.old_text.is_none())
    {
        let added: usize = diffs(tool).map(|diff| diff.new_text.lines().count()).sum();
        native.raw_input.get_or_insert_with(|| json!({}))["_ticketdAddedLines"] = json!(added);
    }

    let original = serde_json::to_string(&native).unwrap_or_default();
    let size = original.len();
    let bounded = if size <= MAX_PROVIDER_DETAIL_BYTES {
        original
    } else {
        if let Some(Value::Object(fields)) = &mut native.raw_input {
            fields.retain(|key, value| {
                key == "_ticketdAddedLines"
                    || (key != "Content"
                        && key != "ReplacementContent"
                        && value.as_str().is_some_and(|text| text.len() <= 4096))
            });
        } else {
            native.raw_input = None;
        }
        native.locations.truncate(32);
        native.meta = None;
        let compact = serde_json::to_string(&native).unwrap_or_default();
        if compact.len() <= MAX_PROVIDER_DETAIL_BYTES {
            compact
        } else {
            if native.kind == acp::ToolKind::Execute {
                let input = tool.raw_input.as_ref().unwrap_or(&Value::Null);
                let command = input["CommandLine"]
                    .as_str()
                    .or_else(|| input["command"].as_str())
                    .unwrap_or(&tool.title);
                native.raw_input = Some(json!({"CommandLine": command}));
            }
            native.title.clear();
            native.locations.clear();
            native.content.clear();
            serde_json::to_string(&native)
                .ok()
                .filter(|text| text.len() <= MAX_PROVIDER_DETAIL_BYTES)
                .unwrap_or_default()
        }
    };
    EventKind::ToolUpdated {
        turn,
        item: NativeItemId::new(tool.tool_call_id.0.as_ref()),
        title: tool.title.clone(),
        status,
        output,
        detail: Some(ProviderDetail::from_compacted_tool_input(
            "tool_call",
            bounded,
            size,
        )),
    }
}
