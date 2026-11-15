//! The Automation run state machine: from the steps a run was created with and how
//! the step it was on ended, to what the run does next. No SQL and no clock; the
//! records in `automation_runs` apply what it decides.
//!
//! Paths never rejoin, so the end of any list of steps (the flow itself, a Yes or No
//! path, a failure path) is the end of the run.

use serde::{Deserialize, Serialize};

use crate::automations::{Step, StepAction};

/// How a step ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StepOutcome {
    Completed,
    /// `reason` says in plain words why, for the person.
    Failed {
        reason: String,
    },
    /// An If chose its Yes or its No path.
    Branched {
        yes: bool,
    },
}

/// What a run does next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum RunAction {
    RunStep { step_id: String },
    End(RunEnd),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "end", rename_all = "snake_case")]
pub enum RunEnd {
    /// Every step on the path taken ran, or a failed step's failure path did.
    Completed,
    /// A step failed and had no failure path.
    NeedsAttention { reason: String },
}

/// The next action of a run over `steps`. `finished` is the step that just ended and
/// how; `None` starts the run.
pub fn next_action(steps: &[Step], finished: Option<(&str, &StepOutcome)>) -> RunAction {
    let Some((step_id, outcome)) = finished else {
        return first(steps);
    };
    let Some((siblings, index)) = locate(steps, step_id) else {
        return RunAction::End(RunEnd::NeedsAttention {
            reason: "The run's step is no longer part of its Automation.".to_owned(),
        });
    };
    match (outcome, &siblings[index].action) {
        (StepOutcome::Branched { yes }, StepAction::If { yes: then, no, .. }) => {
            first(if *yes { then } else { no })
        }
        (StepOutcome::Failed { reason }, action) => match failure_path(action) {
            Some(path) => first(path),
            None => RunAction::End(RunEnd::NeedsAttention {
                reason: reason.clone(),
            }),
        },
        (StepOutcome::Completed | StepOutcome::Branched { .. }, _) => first(&siblings[index + 1..]),
    }
}

fn first(steps: &[Step]) -> RunAction {
    match steps.first() {
        Some(step) => RunAction::RunStep {
            step_id: step.id.clone(),
        },
        None => RunAction::End(RunEnd::Completed),
    }
}

fn failure_path(action: &StepAction) -> Option<&Vec<Step>> {
    match action {
        StepAction::RunAgent { on_failure, .. }
        | StepAction::ChangeTicket { on_failure, .. }
        | StepAction::Notify { on_failure, .. } => on_failure.as_ref(),
        StepAction::If { .. } => None,
    }
}

/// The list holding the step with `id`, at any depth, and its place in that list.
fn locate<'a>(steps: &'a [Step], id: &str) -> Option<(&'a [Step], usize)> {
    if let Some(index) = steps.iter().position(|step| step.id == id) {
        return Some((steps, index));
    }
    steps.iter().find_map(|step| {
        step.action
            .paths()
            .into_iter()
            .find_map(|path| locate(path, id))
    })
}
