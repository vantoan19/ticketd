//! The tool records that keep a turn's reasoning, plan and changed files in Chat
//! history. Each is stored as JSON in a tool record's input, replaced as the harness
//! reports more, so history keeps what the harness last said and nothing it did not.

use serde::{Deserialize, Serialize};

use crate::{FileChange, FileChangeKind, Plan, PlanStepStatus};

/// The name of the tool record that keeps one reasoning item (`ReasoningRecord`).
pub const REASONING_RECORD_NAME: &str = "ticketd reasoning";
/// The name of the tool record that keeps a turn's plan (`PlanRecord`).
pub const PLAN_RECORD_NAME: &str = "ticketd plan";
/// The name of the tool record that keeps the files a turn changed (`FilesRecord`).
pub const FILES_RECORD_NAME: &str = "ticketd files";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningRecord {
    pub running: bool,
    /// Milliseconds since the Unix epoch.
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub text: Option<String>,
    pub heading: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanRecord {
    pub steps: Vec<PlanStepRecord>,
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanStepRecord {
    pub text: String,
    pub status: PlanStepStatus,
    pub active_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesRecord {
    pub files: Vec<FileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    pub path: String,
    /// `added`, `modified`, `deleted` or `renamed`.
    pub kind: String,
    /// The earlier path of a renamed file.
    pub from: Option<String>,
    pub added_lines: Option<u32>,
    pub removed_lines: Option<u32>,
    pub confirmed: bool,
}

impl From<&Plan> for PlanRecord {
    fn from(plan: &Plan) -> Self {
        Self {
            steps: plan
                .steps
                .iter()
                .map(|step| PlanStepRecord {
                    text: step.text.clone(),
                    status: step.status,
                    active_label: step.active_label.clone(),
                })
                .collect(),
            explanation: plan.explanation.clone(),
        }
    }
}

impl From<&[FileChange]> for FilesRecord {
    fn from(files: &[FileChange]) -> Self {
        Self {
            files: files
                .iter()
                .map(|file| {
                    let (kind, from) = match &file.kind {
                        FileChangeKind::Added => ("added", None),
                        FileChangeKind::Modified => ("modified", None),
                        FileChangeKind::Deleted => ("deleted", None),
                        FileChangeKind::Renamed { from } => ("renamed", Some(from.clone())),
                    };
                    FileRecord {
                        path: file.path.clone(),
                        kind: kind.to_owned(),
                        from,
                        added_lines: file.added_lines,
                        removed_lines: file.removed_lines,
                        confirmed: file.confirmed,
                    }
                })
                .collect(),
        }
    }
}

/// The record a stored tool keeps, when it is one of these.
pub fn read<T: for<'de> Deserialize<'de>>(name: &str, wanted: &str, input: &str) -> Option<T> {
    (name == wanted)
        .then(|| serde_json::from_str(input).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_plan_reads_its_step_statuses_and_an_unknown_one_is_not_read() {
        let stored = r#"{"steps":[{"text":"a","status":"in_progress","active_label":null}],"explanation":null}"#;
        let plan = read::<PlanRecord>(PLAN_RECORD_NAME, PLAN_RECORD_NAME, stored);
        assert_eq!(
            plan.map(|plan| plan.steps[0].status),
            Some(PlanStepStatus::InProgress)
        );
        let odd = stored.replace("in_progress", "skipped");
        assert_eq!(
            read::<PlanRecord>(PLAN_RECORD_NAME, PLAN_RECORD_NAME, &odd),
            None
        );
    }
}
