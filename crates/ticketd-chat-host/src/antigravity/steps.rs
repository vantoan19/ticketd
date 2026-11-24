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
const ALL_FILES_ADDED: &str = "_ticketdAllFilesAdded";
const ADDED_LINES: &str = "_ticketdAddedLines";
const INPUT_FIELDS: &[&[&str]] = &[
    COMMAND,
    WORKING_DIRECTORY,
    FILE_PATH,
    QUERY,
    SEARCH_PATH,
    URL,
];

pub(crate) fn read_steps(evidence: ToolEvidence<'_>) -> Vec<ToolStep> {
    // The ACP schema can also deserialize positional arrays as structs.
    // Recognize our compact sequence before trying the native object reader.
    if evidence.input.trim_start().starts_with(['"', '['])
        && let Some(step) = read_compact_execute(evidence)
    {
        return vec![step];
    }
    let Ok(tool) = serde_json::from_str::<acp::ToolCall>(evidence.input) else {
        return vec![
            StepAction::Other {
                name: evidence.name.to_owned(),
            }
            .into(),
        ];
    };
    let input = tool.raw_input.as_ref().unwrap_or(&Value::Null);
    let text = |keys: &[&str]| input_text(input, keys);
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
                        exit_code: exit_code(&tool),
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
            let diff_paths = || {
                diffs(&tool)
                    .map(|diff| diff.path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            };
            let all_files_added = input[ALL_FILES_ADDED].as_bool().unwrap_or_else(|| {
                let mut diffs = diffs(&tool).peekable();
                diffs.peek().is_some() && diffs.all(|diff| diff.old_text.is_none())
            });
            if tool.kind == acp::ToolKind::Edit && all_files_added {
                let targets = diff_paths();
                StepAction::Create {
                    targets: FileTargets::Paths(if targets.is_empty() {
                        locations()
                    } else {
                        targets
                    }),
                    counts: LineCounts {
                        added: input[ADDED_LINES]
                            .as_u64()
                            .and_then(|lines| u32::try_from(lines).ok()),
                        removed: None,
                    },
                }
            } else {
                let targets = locations();
                StepAction::Edit {
                    targets: FileTargets::Paths(
                        if tool.kind == acp::ToolKind::Edit && targets.is_empty() {
                            diff_paths()
                        } else {
                            targets
                        },
                    ),
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

fn input_text<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| input[*key].as_str())
}

fn exit_code(tool: &acp::ToolCall) -> Option<i64> {
    tool.raw_output.as_ref()?.get("exit_code")?.as_i64()
}

// An oversized native ToolCall can keep execution evidence in either of these
// shapes. A bare string leaves the most space for exact command text.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum CompactExecute {
    Command(String),
    WithFacts(Option<String>, Option<String>, Option<i64>),
}

fn read_compact_execute(evidence: ToolEvidence<'_>) -> Option<ToolStep> {
    let (command, working_directory, exit_code) = match serde_json::from_str(evidence.input).ok()? {
        CompactExecute::Command(command) => (Some(command), None, None),
        CompactExecute::WithFacts(command, working_directory, exit_code) => {
            (command, working_directory, exit_code)
        }
    };
    Some(match command {
        Some(command) => shell_step(
            evidence,
            &command,
            CommandFacts {
                working_directory: working_directory.as_deref(),
                exit_code,
                ..CommandFacts::default()
            },
        ),
        None => StepAction::Run(RunAction::CommandUnavailable {
            working_directory,
            exit_code,
        })
        .into(),
    })
}

fn bounded_json(value: &(impl serde::Serialize + ?Sized)) -> Option<String> {
    serde_json::to_string(value)
        .ok()
        .filter(|json| json.len() <= MAX_PROVIDER_DETAIL_BYTES)
}

fn compact_execute(
    command: Option<&str>,
    working_directory: Option<&str>,
    exit_code: Option<i64>,
) -> (String, bool) {
    let exact = command.and_then(bounded_json);
    let retained_command = exact.as_ref().and(command);
    let detail = [
        (working_directory, exit_code),
        (None, exit_code),
        (working_directory, None),
    ]
    .into_iter()
    .filter(|(directory, code)| directory.is_some() || code.is_some())
    .find_map(|(directory, code)| bounded_json(&(retained_command, directory, code)));
    let command_unavailable = exact.is_none();
    (
        detail
            .or(exact)
            .unwrap_or_else(|| "[null,null,null]".to_owned()),
        command_unavailable,
    )
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
        let Value::Object(fields) = input else {
            self.native.raw_input = None;
            return;
        };
        let known = self.native.raw_input.get_or_insert_with(|| json!({}));
        if let Value::Object(known) = known {
            for (key, value) in fields
                .into_iter()
                .filter(|(key, _)| INPUT_FIELDS.iter().any(|keys| keys.contains(&key.as_str())))
            {
                match value {
                    Value::String(text) if text.len() <= MAX_PROVIDER_DETAIL_BYTES => {
                        known.insert(key, Value::String(text));
                    }
                    Value::String(text) if COMMAND.contains(&key.as_str()) => {
                        // Track that the command was supplied even when the text
                        // is too large to keep between partial tool updates.
                        known.insert(key, json!(text.len()));
                    }
                    _ => {
                        known.remove(&key);
                    }
                }
            }
        }
    }

    pub(super) fn changes(&self) -> impl Iterator<Item = FileChange> + '_ {
        self.files.iter().cloned().map(|mut file| {
            file.confirmed = self.status() == acp::ToolCallStatus::Completed;
            file
        })
    }

    pub(super) fn observed(
        &self,
        turn: NativeTurnId,
        declined: bool,
        approval_cancelled: bool,
    ) -> (EventKind, bool) {
        let status = match self.status() {
            _ if declined => ToolStatus::Declined,
            acp::ToolCallStatus::Completed => ToolStatus::Succeeded,
            acp::ToolCallStatus::Failed if approval_cancelled => ToolStatus::FailedAfterInterrupt,
            acp::ToolCallStatus::Failed => ToolStatus::Failed,
            _ => ToolStatus::Running,
        };
        let (detail, command_unavailable) = self.detail();
        (
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
                detail: Some(detail),
            },
            command_unavailable,
        )
    }

    fn detail(&self) -> (ProviderDetail, bool) {
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

        // The diff preview can omit modifications or be cleared to fit the budget.
        let all_files_added = native.kind == acp::ToolKind::Edit
            && !self.files.is_empty()
            && self
                .files
                .iter()
                .all(|file| file.kind == FileChangeKind::Added);
        if native.kind == acp::ToolKind::Edit {
            let input = native.raw_input.get_or_insert_with(|| json!({}));
            input[ALL_FILES_ADDED] = json!(all_files_added);
            if all_files_added {
                let added = self
                    .files
                    .iter()
                    .filter_map(|file| file.added_lines)
                    .fold(0, u32::saturating_add);
                input[ADDED_LINES] = json!(added);
            }
        }

        let input = native.raw_input.as_ref().unwrap_or(&Value::Null);
        let command = (native.kind == acp::ToolKind::Execute)
            .then(|| COMMAND.iter().find_map(|key| input.get(*key)))
            .flatten();
        let oversized_command_bytes = command
            .and_then(Value::as_u64)
            .and_then(|bytes| usize::try_from(bytes).ok());
        let mut detail = serde_json::to_string(&native).unwrap_or_default();
        let size = detail
            .len()
            .max(oversized_command_bytes.unwrap_or_default());
        if detail.len() > MAX_PROVIDER_DETAIL_BYTES {
            // The event has the title already. Give the reader's evidence this space.
            native.title.clear();
            native.name = native
                .name
                .filter(|name| name.len() <= MAX_PROVIDER_DETAIL_BYTES);
            native.locations.truncate(32);
            detail = serde_json::to_string(&native).unwrap_or_default();
        }
        if all_files_added && detail.len() > MAX_PROVIDER_DETAIL_BYTES {
            // Locations can identify created files without the diff preview.
            native.content.clear();
            detail = serde_json::to_string(&native).unwrap_or_default();
        }
        if detail.len() > MAX_PROVIDER_DETAIL_BYTES {
            native.locations.clear();
            native.content.clear();
            detail = serde_json::to_string(&native).unwrap_or_default();
        }
        let mut command_unavailable = false;
        if native.kind == acp::ToolKind::Execute
            && (detail.len() > MAX_PROVIDER_DETAIL_BYTES || oversized_command_bytes.is_some())
        {
            if let Some(command) = command {
                (detail, command_unavailable) = compact_execute(
                    command.as_str(),
                    input_text(input, WORKING_DIRECTORY),
                    exit_code(&native),
                );
            } else {
                detail =
                    serde_json::to_string(&acp::ToolCall::new("", "").kind(acp::ToolKind::Execute))
                        .unwrap_or_default();
            }
        }
        if detail.len() > MAX_PROVIDER_DETAIL_BYTES {
            detail.clear();
        }
        (
            ProviderDetail::from_compacted_tool_input("tool_call", detail, size),
            command_unavailable,
        )
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
