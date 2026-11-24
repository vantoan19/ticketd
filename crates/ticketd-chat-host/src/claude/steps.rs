//! Reads the Claude Code evidence kept in a Chat, independently of its adapter.

use serde_json::Value;
use ticketd_core::ChatToolState;

use crate::tool_steps::{
    CommandFacts, FileTargets, LineCounts, ReadAction, ReadTarget, SearchScope, SearchTarget,
    StepAction, StepOutcomeOverride, ToolEvidence, ToolStep, WebAction, shell_step,
};

const NOTHING_FOUND: [&str; 2] = ["No files found", "No matches found"];
const WRITE_CREATED: &str = "File created successfully at:";

/// Reads one Claude Code tool call from current or saved history.
pub fn read_claude_steps(mut evidence: ToolEvidence<'_>) -> Vec<ToolStep> {
    let input = serde_json::from_str::<Value>(evidence.input).ok();
    let value = |name: &str| input.as_ref().and_then(|input| input.get(name));
    let field = |name: &str| value(name).and_then(Value::as_str);
    let number = |name: &str| value(name).and_then(Value::as_i64);
    let declined = evidence.state == ChatToolState::Failed && field("status") == Some("declined");
    if declined {
        evidence.state = ChatToolState::Declined;
    }

    let step = match evidence.name {
        "Bash" | "PowerShell" if let Some(command) = field("command") => {
            let exit_code = number("exitCode");
            shell_step(
                evidence,
                command,
                CommandFacts {
                    exit_code,
                    duration_ms: number("durationMs"),
                    timed_out: evidence.state == ChatToolState::Failed && exit_code == Some(124),
                    ..CommandFacts::default()
                },
            )
        }
        "Read" => {
            let lines = number("limit")
                .filter(|limit| *limit > 0)
                .and_then(|limit| {
                    let first = number("offset").unwrap_or(1).max(1);
                    let last = first.checked_add(limit - 1)?;
                    Some((u32::try_from(first).ok()?, u32::try_from(last).ok()?))
                });
            StepAction::Read(ReadAction::Files(
                field("file_path")
                    .map(|path| ReadTarget {
                        path: path.to_owned(),
                        lines,
                    })
                    .into_iter()
                    .collect(),
            ))
            .into()
        }
        "LS" => StepAction::Read(ReadAction::List(
            field("path").into_iter().map(str::to_owned).collect(),
        ))
        .into(),
        "Grep" | "Glob" => {
            let scope = field("path")
                .map(|path| SearchScope::Path(path.to_owned()))
                .or_else(|| field("glob").map(|glob| SearchScope::Pattern(glob.to_owned())));
            let no_matches = evidence.state == ChatToolState::Completed
                && evidence.output.is_none_or(|output| {
                    let output = output.trim();
                    output.is_empty() || NOTHING_FOUND.iter().any(|said| output.starts_with(said))
                });
            StepAction::Search {
                targets: field("pattern")
                    .map(|query| SearchTarget {
                        query: query.to_owned(),
                        scope,
                    })
                    .into_iter()
                    .collect(),
                no_matches,
            }
            .into()
        }
        "Edit" | "MultiEdit" | "NotebookEdit" | "Write" => {
            let file = field("file_path").or(field("notebook_path"));
            let targets = match file {
                Some(path) if plan_file(path, evidence.working_directory) => FileTargets::Plan {
                    path: path.to_owned(),
                },
                file => FileTargets::Paths(file.into_iter().map(str::to_owned).collect()),
            };
            let count = |name: &str| {
                let count = value("ticketd_lines")?.get(name)?.as_u64()?;
                u32::try_from(count).ok()
            };
            let counts = LineCounts {
                added: count("added"),
                removed: count("removed"),
            };
            // Claude Code's Write result says when the file did not exist before.
            let created = evidence.name == "Write"
                && evidence.state == ChatToolState::Completed
                && evidence
                    .output
                    .is_some_and(|output| output.starts_with(WRITE_CREATED));
            if created {
                StepAction::Create { targets, counts }.into()
            } else {
                StepAction::Edit { targets, counts }.into()
            }
        }
        "WebSearch" => StepAction::Web(WebAction::Search {
            query: field("query").unwrap_or_default().to_owned(),
        })
        .into(),
        "WebFetch" => StepAction::Web(WebAction::Fetch {
            url: field("url").unwrap_or_default().to_owned(),
        })
        .into(),
        name if let Some(paths) = name.strip_prefix("Edit ") => StepAction::Edit {
            targets: FileTargets::Paths(paths.split(", ").map(str::to_owned).collect()),
            counts: LineCounts::default(),
        }
        .into(),
        name => StepAction::Other {
            name: name.to_owned(),
        }
        .into(),
    };
    vec![ToolStep {
        outcome: if declined {
            Some(StepOutcomeOverride::Declined)
        } else {
            step.outcome
        },
        ..step
    }]
}

/// Claude Code keeps plans in its own profile, outside the Chat's folder.
fn plan_file(path: &str, folder: &str) -> bool {
    let path = std::path::Path::new(path);
    let outside = folder.is_empty() || !path.starts_with(folder);
    let in_plans = path
        .parent()
        .and_then(|parent| parent.file_name())
        .is_some_and(|name| name == "plans");
    let claude = path.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("claude")
    });
    outside && in_plans && claude && path.extension().is_some_and(|ext| ext == "md")
}
