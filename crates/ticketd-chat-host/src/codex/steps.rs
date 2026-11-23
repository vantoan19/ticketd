//! Reads the native item recorded by the Codex adapter.
use serde_json::{Value, json};
use ticketd_core::ChatToolState;

use crate::tool_steps::{
    CommandFacts, FileTargets, LineCounts, ReadAction, ReadTarget, StepAction, StepOutcomeOverride,
    ToolEvidence, ToolStep, shell_step,
};
use crate::{FileChangeKind, MAX_PROVIDER_DETAIL_BYTES, ProviderDetail, WebAction, diffstat};

pub(crate) fn read_codex_steps(mut evidence: ToolEvidence<'_>) -> Vec<ToolStep> {
    let input = serde_json::from_str::<Value>(evidence.input).ok();
    let value = |name: &str| input.as_ref().and_then(|input| input.get(name));
    let field = |name: &str| value(name).and_then(Value::as_str);
    let number = |name: &str| value(name).and_then(Value::as_i64);
    // Declines were stored as failures before they had their own state.
    let declined = evidence.state == ChatToolState::Failed && field("status") == Some("declined");
    if declined {
        evidence.state = ChatToolState::Declined;
    }
    let mut steps = match field("type") {
        Some("commandExecution") => {
            let exit_code = number("exitCode");
            vec![shell_step(
                evidence,
                field("command").unwrap_or(evidence.name),
                CommandFacts {
                    working_directory: field("cwd"),
                    exit_code,
                    duration_ms: number("durationMs"),
                    timed_out: evidence.state == ChatToolState::Failed && exit_code == Some(124),
                },
            )]
        }
        Some("fileChange") => file_changes(evidence.name, value("changes")),
        Some("webSearch") => {
            let url = value("action")
                .filter(|action| action["type"] == "openPage")
                .and_then(|action| action["url"].as_str());
            let web = match url {
                Some(url) => WebAction::Fetch {
                    url: url.to_owned(),
                },
                None => WebAction::Search {
                    query: field("query").unwrap_or_default().to_owned(),
                },
            };
            vec![StepAction::Web(web).into()]
        }
        Some("imageView") => vec![
            StepAction::Read(ReadAction::Files(
                field("path")
                    .map(|path| ReadTarget {
                        path: path.to_owned(),
                        lines: None,
                    })
                    .into_iter()
                    .collect(),
            ))
            .into(),
        ],
        None if let Some(paths) = evidence.name.strip_prefix("Edit ") => {
            vec![
                StepAction::Edit {
                    targets: FileTargets::Paths(paths.split(", ").map(str::to_owned).collect()),
                    counts: LineCounts::default(),
                }
                .into(),
            ]
        }
        _ => vec![
            StepAction::Other {
                name: evidence.name.to_owned(),
            }
            .into(),
        ],
    };
    if declined {
        for step in &mut steps {
            step.outcome = Some(StepOutcomeOverride::Declined);
        }
    }
    steps
}

struct FileSteps {
    kind: FileChangeKind,
    paths: Vec<String>,
    counts: LineCounts,
}

fn file_changes(title: &str, changes: Option<&Value>) -> Vec<ToolStep> {
    let mut groups: Vec<FileSteps> = Vec::new();
    for change in changes.and_then(Value::as_array).into_iter().flatten() {
        let Some(path) = change["path"].as_str() else {
            continue;
        };
        let kind = file_kind(change);
        let counts = file_counts(change, &kind);
        // Preserve the order in which each kind first appeared.
        if let Some(group) = groups.iter_mut().find(|group| group.kind == kind) {
            let sum = |a: Option<u32>, b: Option<u32>| a.zip(b).map(|(a, b)| a.saturating_add(b));
            group.counts.added = sum(group.counts.added, counts.added);
            group.counts.removed = sum(group.counts.removed, counts.removed);
            group.paths.push(path.to_owned());
        } else {
            groups.push(FileSteps {
                kind,
                paths: vec![path.to_owned()],
                counts,
            });
        }
    }
    if groups.is_empty() {
        return vec![
            StepAction::Edit {
                targets: FileTargets::Paths(vec![title.to_owned()]),
                counts: LineCounts::default(),
            }
            .into(),
        ];
    }
    groups
        .into_iter()
        .map(
            |FileSteps {
                 kind,
                 paths,
                 counts,
             }| {
                match kind {
                    FileChangeKind::Added => StepAction::Create {
                        targets: FileTargets::Paths(paths),
                        counts,
                    },
                    FileChangeKind::Deleted => StepAction::Delete { paths, counts },
                    FileChangeKind::Modified | FileChangeKind::Renamed { .. } => StepAction::Edit {
                        targets: FileTargets::Paths(paths),
                        counts,
                    },
                }
                .into()
            },
        )
        .collect()
}

fn file_kind(change: &Value) -> FileChangeKind {
    match change["kind"]["type"].as_str().or(change["kind"].as_str()) {
        Some("add") => FileChangeKind::Added,
        Some("delete") => FileChangeKind::Deleted,
        _ => FileChangeKind::Modified,
    }
}

fn file_counts(change: &Value, kind: &FileChangeKind) -> LineCounts {
    if let Some(diff) = change["diff"].as_str() {
        let (added, removed) = diffstat::counts(kind, diff);
        return LineCounts {
            added: Some(added),
            removed: Some(removed),
        };
    }
    let count = |field: &str| {
        change["ticketd_lines"][field]
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
    };
    LineCounts {
        added: count("added"),
        removed: count("removed"),
    }
}

pub(super) fn tool_detail(kind: &str, item: &Value) -> ProviderDetail {
    let raw = item.to_string();
    let original_bytes = raw.len();
    if original_bytes <= MAX_PROVIDER_DETAIL_BYTES {
        return ProviderDetail::from_compacted_tool_input(kind, raw, original_bytes);
    }
    let mut compact = serde_json::Map::new();
    compact.insert("type".to_owned(), Value::String(kind.to_owned()));
    let fields: &[&str] = match kind {
        "commandExecution" => &["cwd", "status", "exitCode", "durationMs"],
        "fileChange" => &["status"],
        "webSearch" => &["query", "action"],
        "imageView" => &["path"],
        _ => &["status"],
    };
    let mut bytes = Value::Object(compact.clone()).to_string().len();
    for field in fields {
        if let Some(value) = item.get(field) {
            let field_bytes = field.len() + value.to_string().len() + 4;
            if bytes + field_bytes <= MAX_PROVIDER_DETAIL_BYTES {
                compact.insert((*field).to_owned(), value.clone());
                bytes += field_bytes;
            }
        }
    }
    if let Some(changes) = item["changes"].as_array().filter(|_| kind == "fileChange") {
        let mut files = Vec::new();
        bytes += r#","changes":[]"#.len();
        for change in changes {
            let Some(path) = change["path"].as_str() else {
                continue;
            };
            let counts = file_counts(change, &file_kind(change));
            let file = json!({
                "path": path,
                "kind": change["kind"],
                "ticketd_lines": {"added": counts.added, "removed": counts.removed}
            });
            bytes += file.to_string().len() + 1;
            if bytes > MAX_PROVIDER_DETAIL_BYTES {
                break;
            }
            files.push(file);
        }
        compact.insert("changes".to_owned(), Value::Array(files));
    }
    // Oversized commands still have their exact spelling in the tool title.
    ProviderDetail::from_compacted_tool_input(
        kind,
        Value::Object(compact).to_string(),
        original_bytes,
    )
}
