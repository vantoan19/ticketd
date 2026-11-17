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
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Next {
    Step(String),
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
pub(crate) fn next_action(steps: &[Step], finished: Option<(&str, &StepOutcome)>) -> Next {
    let Some((step_id, outcome)) = finished else {
        return first(steps);
    };
    let Some((siblings, index)) = locate(steps, step_id) else {
        return Next::End(RunEnd::NeedsAttention {
            reason: "The run's step is no longer part of its Automation.".to_owned(),
        });
    };
    match (outcome, &siblings[index].action) {
        (StepOutcome::Branched { yes }, StepAction::If { yes: then, no, .. }) => {
            first(if *yes { then } else { no })
        }
        (StepOutcome::Failed { reason }, action) => match failure_path(action) {
            Some(path) => first(path),
            None => Next::End(RunEnd::NeedsAttention {
                reason: reason.clone(),
            }),
        },
        (StepOutcome::Completed | StepOutcome::Branched { .. }, _) => first(&siblings[index + 1..]),
    }
}

fn first(steps: &[Step]) -> Next {
    match steps.first() {
        Some(step) => Next::Step(step.id.clone()),
        None => Next::End(RunEnd::Completed),
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

/// Which step a run goes to after an If and after a step that failed.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::automations::NotifyTarget;

    fn notify(id: &str) -> Step {
        Step {
            id: id.into(),
            action: StepAction::Notify {
                text: "Done".into(),
                opens: NotifyTarget::Ticket,
                on_failure: None,
            },
        }
    }

    fn branch(id: &str, yes: Vec<Step>, no: Vec<Step>) -> Step {
        Step {
            id: id.into(),
            action: StepAction::If {
                checks: Vec::new(),
                yes,
                no,
            },
        }
    }

    fn run_step(id: &str) -> Next {
        Next::Step(id.into())
    }

    /// The ids of the steps a run goes through when each If answers as `answers` says.
    fn walk(steps: &[Step], answers: &[(&str, bool)]) -> Vec<String> {
        let mut visited = Vec::new();
        let mut action = next_action(steps, None);
        while let Next::Step(step_id) = action {
            let outcome = match answers.iter().find(|(id, _)| *id == step_id) {
                Some((_, yes)) => StepOutcome::Branched { yes: *yes },
                None => StepOutcome::Completed,
            };
            action = next_action(steps, Some((&step_id, &outcome)));
            visited.push(step_id);
        }
        assert_eq!(action, Next::End(RunEnd::Completed));
        visited
    }

    /// before → If(passed?) → Yes: [close, tell] / No: [If(flaky?) → Yes: [retry] / No: [fix]]
    fn flow() -> Vec<Step> {
        vec![
            notify("before"),
            branch(
                "passed",
                vec![notify("close"), notify("tell")],
                vec![branch("flaky", vec![notify("retry")], vec![notify("fix")])],
            ),
        ]
    }

    #[test]
    fn an_if_that_answers_yes_runs_its_yes_path_to_the_end_and_nothing_else() {
        assert_eq!(
            walk(&flow(), &[("passed", true)]),
            ["before", "passed", "close", "tell"]
        );
    }

    #[test]
    fn an_if_that_answers_no_runs_its_no_path() {
        assert_eq!(
            walk(&flow(), &[("passed", false), ("flaky", false)]),
            ["before", "passed", "flaky", "fix"]
        );
    }

    #[test]
    fn a_nested_if_chooses_again_inside_the_path_taken() {
        assert_eq!(
            walk(&flow(), &[("passed", false), ("flaky", true)]),
            ["before", "passed", "flaky", "retry"]
        );
    }

    #[test]
    fn a_path_with_no_steps_ends_the_run() {
        let steps = vec![branch("passed", vec![notify("close")], Vec::new())];
        assert_eq!(
            next_action(
                &steps,
                Some(("passed", &StepOutcome::Branched { yes: false }))
            ),
            Next::End(RunEnd::Completed)
        );
        assert_eq!(
            next_action(
                &steps,
                Some(("passed", &StepOutcome::Branched { yes: true }))
            ),
            run_step("close")
        );
    }

    fn notify_or(id: &str, on_failure: Vec<Step>) -> Step {
        Step {
            id: id.into(),
            action: StepAction::Notify {
                text: "Done".into(),
                opens: NotifyTarget::Ticket,
                on_failure: Some(on_failure),
            },
        }
    }

    fn failed(reason: &str) -> StepOutcome {
        StepOutcome::Failed {
            reason: reason.into(),
        }
    }

    #[test]
    fn a_failed_step_without_a_failure_path_ends_the_run_needing_attention_with_its_reason() {
        let steps = vec![notify("verify"), notify("never-reached")];
        assert_eq!(
            next_action(&steps, Some(("verify", &failed("Notifications are off.")))),
            Next::End(RunEnd::NeedsAttention {
                reason: "Notifications are off.".into()
            })
        );
    }

    #[test]
    fn a_failed_step_with_a_failure_path_runs_the_path_to_its_end_and_the_run_completes() {
        let steps = vec![
            notify_or("verify", vec![notify("tell"), notify("tag")]),
            notify("never-reached"),
        ];
        let why = failed("The agent reached its limit of 1 turns before finishing.");

        assert_eq!(
            next_action(&steps, Some(("verify", &why))),
            run_step("tell")
        );
        assert_eq!(
            next_action(&steps, Some(("tell", &StepOutcome::Completed))),
            run_step("tag")
        );
        // The end of the failure path is the end of the run: the step after the one
        // that failed does not run.
        assert_eq!(
            next_action(&steps, Some(("tag", &StepOutcome::Completed))),
            Next::End(RunEnd::Completed)
        );
        // The same step, when it does not fail, goes on to the next one.
        assert_eq!(
            next_action(&steps, Some(("verify", &StepOutcome::Completed))),
            run_step("never-reached")
        );
    }

    #[test]
    fn a_failure_path_with_no_steps_ends_the_run_completed() {
        let steps = vec![notify_or("verify", Vec::new()), notify("never-reached")];
        assert_eq!(
            next_action(&steps, Some(("verify", &failed("Notifications are off.")))),
            Next::End(RunEnd::Completed)
        );
    }

    #[test]
    fn a_failure_path_is_an_ordinary_path_with_ifs_and_failure_paths_of_its_own() {
        // verify ⇢ fails: [retry ⇢ fails: [If(flaky?) → Yes: [tell] / No: [give-up]], retried]
        let steps = vec![notify_or(
            "verify",
            vec![
                notify_or(
                    "retry",
                    vec![branch(
                        "flaky",
                        vec![notify("tell")],
                        vec![notify("give-up")],
                    )],
                ),
                notify("retried"),
            ],
        )];
        let why = failed("Notifications are off.");

        assert_eq!(
            next_action(&steps, Some(("verify", &why))),
            run_step("retry")
        );
        assert_eq!(
            next_action(&steps, Some(("retry", &why))),
            run_step("flaky")
        );
        assert_eq!(
            next_action(
                &steps,
                Some(("flaky", &StepOutcome::Branched { yes: false }))
            ),
            run_step("give-up")
        );
        // A step on a failure path that fails with no path of its own needs attention.
        assert_eq!(
            next_action(&steps, Some(("give-up", &why))),
            Next::End(RunEnd::NeedsAttention {
                reason: "Notifications are off.".into()
            })
        );
        assert_eq!(
            next_action(&steps, Some(("retry", &StepOutcome::Completed))),
            run_step("retried")
        );
    }
}
