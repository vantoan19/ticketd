//! Keep the ACP facts needed to report a Step across partial tool updates.
use agent_client_protocol_schema::v1 as acp;
use serde_json::{Value, json};
use ticketd_core::{CHAT_TOOL_OUTPUT_LIMIT, ChatToolState};

use crate::tool_steps::{CommandFacts, shell_step};
use crate::{
    EventKind, FileChange, FileChangeKind, FileTargets, LineCounts, MAX_PROVIDER_DETAIL_BYTES,
    NativeItemId, NativeTurnId, ProviderDetail, ReadAction, ReadTarget, RunAction, SearchScope,
    SearchTarget, StepAction, ToolEvidence, ToolStatus, ToolStep, WebAction,
};

const COMMAND: &[&str] = &["CommandLine", "command"];
const WORKING_DIRECTORY: &[&str] = &["Cwd", "cwd", "WorkingDirectory"];
const FILE_PATH: &[&str] = &[
    "AbsolutePath",
    "TargetFile",
    "SourcePath",
    "DestinationPath",
    "path",
];
const QUERY: &[&str] = &["Query", "Pattern", "query"];
const SEARCH_PATH: &[&str] = &["SearchPath", "path"];
const URL: &[&str] = &["Url", "URL", "url"];
const INPUT_FIELDS: &[&[&str]] = &[
    COMMAND,
    WORKING_DIRECTORY,
    FILE_PATH,
    QUERY,
    SEARCH_PATH,
    URL,
];

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
            FILE_PATH
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
            if let Some(command) = text(COMMAND) {
                return vec![shell_step(
                    evidence,
                    command,
                    CommandFacts {
                        working_directory: text(WORKING_DIRECTORY),
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
            targets: text(QUERY)
                .map(|query| SearchTarget {
                    query: query.to_owned(),
                    scope: text(SEARCH_PATH).map(|path| SearchScope::Path(path.to_owned())),
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
        acp::ToolKind::Fetch => match text(URL) {
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

pub(super) struct Tool {
    native: acp::ToolCall,
    raw_output: Option<String>,
    content_output: Option<String>,
    files: Vec<FileChange>,
}

impl Tool {
    pub(super) fn new(id: acp::ToolCallId) -> Self {
        Self {
            native: acp::ToolCall::new(id, "Tool"),
            raw_output: None,
            content_output: None,
            files: Vec::new(),
        }
    }

    pub(super) fn from_call(call: acp::ToolCall) -> Self {
        let update = acp::ToolCallUpdate::from(call);
        let mut tool = Self::new(update.tool_call_id);
        tool.merge(update.fields);
        tool
    }

    pub(super) fn title(&self) -> &str {
        &self.native.title
    }

    pub(super) fn status(&self) -> acp::ToolCallStatus {
        self.native.status
    }

    pub(super) fn merge(&mut self, mut update: acp::ToolCallUpdateFields) {
        if let Some(locations) = &mut update.locations {
            // Location metadata is opaque. The reader only uses the path and line.
            for location in locations {
                location.meta = None;
            }
        }
        if let Some(input) = update.raw_input.take() {
            self.merge_input(input);
        }
        if let Some(output) = update.raw_output.take() {
            self.raw_output = output
                .as_str()
                .or_else(|| output["output"].as_str())
                .map(output_tail);
            self.native.raw_output = output["exit_code"]
                .as_i64()
                .map(|code| json!({"exit_code": code}));
        }
        if let Some(content) = update.content.take() {
            self.files = content
                .iter()
                .filter_map(|part| match part {
                    acp::ToolCallContent::Diff(diff) => Some(file_change(diff)),
                    _ => None,
                })
                .collect();
            let texts: Vec<_> = content
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
            self.content_output = (!texts.is_empty()).then(|| output_tail(&texts.join("\n")));
        }
        self.native.update(update);
    }

    fn merge_input(&mut self, input: Value) {
        let Value::Object(mut fields) = input else {
            self.native.raw_input = None;
            return;
        };
        fields.retain(|key, _| INPUT_FIELDS.iter().any(|keys| keys.contains(&key.as_str())));
        let known = self.native.raw_input.get_or_insert_with(|| json!({}));
        if let Value::Object(known) = known {
            known.extend(fields);
            known.retain(|_, value| {
                value
                    .as_str()
                    .is_some_and(|text| text.len() <= MAX_PROVIDER_DETAIL_BYTES)
            });
        }
    }

    pub(super) fn changes(&self) -> impl Iterator<Item = FileChange> + '_ {
        self.files.iter().cloned().map(|mut file| {
            file.confirmed = self.status() == acp::ToolCallStatus::Completed;
            file
        })
    }

    pub(super) fn observed(&self, turn: NativeTurnId, declined: bool) -> EventKind {
        let status = match self.status() {
            _ if declined => ToolStatus::Declined,
            acp::ToolCallStatus::Completed => ToolStatus::Succeeded,
            acp::ToolCallStatus::Failed => ToolStatus::Failed,
            _ => ToolStatus::Running,
        };
        EventKind::ToolUpdated {
            turn,
            item: NativeItemId::new(self.native.tool_call_id.0.as_ref()),
            title: self.title().to_owned(),
            status,
            output: self
                .raw_output
                .as_ref()
                .or(self.content_output.as_ref())
                .cloned(),
            detail: Some(self.detail()),
        }
    }

    fn detail(&self) -> ProviderDetail {
        let mut native = self.native.clone();
        native.content = self
            .files
            .iter()
            .take(32)
            .map(|file| {
                let mut diff = acp::Diff::new(&file.path, "");
                diff.old_text = (file.kind != FileChangeKind::Added).then(String::new);
                acp::ToolCallContent::Diff(diff)
            })
            .collect();

        if !self.files.is_empty()
            && self
                .files
                .iter()
                .all(|file| file.kind == FileChangeKind::Added)
        {
            let added = self
                .files
                .iter()
                .filter_map(|file| file.added_lines)
                .fold(0, u32::saturating_add);
            native.raw_input.get_or_insert_with(|| json!({}))["_ticketdAddedLines"] = json!(added);
        }

        let mut detail = serde_json::to_string(&native).unwrap_or_default();
        let size = detail.len();
        if detail.len() > MAX_PROVIDER_DETAIL_BYTES {
            // The event has the title already. Give the reader's evidence this space.
            native.title.clear();
            native.name = native
                .name
                .filter(|name| name.len() <= MAX_PROVIDER_DETAIL_BYTES);
            native.locations.truncate(32);
            detail = serde_json::to_string(&native).unwrap_or_default();
        }
        if detail.len() > MAX_PROVIDER_DETAIL_BYTES {
            native.locations.clear();
            native.content.clear();
            detail = serde_json::to_string(&native).unwrap_or_default();
        }
        if detail.len() > MAX_PROVIDER_DETAIL_BYTES && native.kind == acp::ToolKind::Execute {
            // An approval needs the exact command even when ancillary fields won't fit.
            let input = native.raw_input.as_ref().unwrap_or(&Value::Null);
            let command = COMMAND
                .iter()
                .find_map(|key| input[*key].as_str())
                .unwrap_or(self.title());
            native.raw_input = Some(json!({"CommandLine": command}));
            native.name = None;
            detail = serde_json::to_string(&native).unwrap_or_default();
        }
        if detail.len() > MAX_PROVIDER_DETAIL_BYTES {
            detail.clear();
        }
        ProviderDetail::from_compacted_tool_input("tool_call", detail, size)
    }
}

fn diffs(tool: &acp::ToolCall) -> impl Iterator<Item = &acp::Diff> {
    tool.content.iter().filter_map(|item| match item {
        acp::ToolCallContent::Diff(diff) => Some(diff),
        _ => None,
    })
}

fn file_change(diff: &acp::Diff) -> FileChange {
    let created = diff.old_text.is_none();
    FileChange {
        path: diff.path.to_string_lossy().into_owned(),
        kind: if created {
            FileChangeKind::Added
        } else {
            FileChangeKind::Modified
        },
        added_lines: created
            .then(|| u32::try_from(diff.new_text.lines().count()).unwrap_or(u32::MAX)),
        removed_lines: created.then_some(0),
        confirmed: false,
    }
}

fn output_tail(output: &str) -> String {
    // Keep the preceding character so the workspace still records a truncated
    // output and cuts it at the same UTF-8 boundary as the unabridged output.
    let mut start = output.len().saturating_sub(CHAT_TOOL_OUTPUT_LIMIT + 1);
    while !output.is_char_boundary(start) {
        start -= 1;
    }
    output[start..].to_owned()
}
