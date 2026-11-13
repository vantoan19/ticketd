//! The run state machine on flows that branch: which step a run goes to after an If
//! and after a step that failed.

use ticketd_core::{NotifyTarget, RunAction, RunEnd, Step, StepAction, StepOutcome, next_action};

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

fn run_step(id: &str) -> RunAction {
    RunAction::RunStep { step_id: id.into() }
}

/// The ids of the steps a run goes through when each If answers as `answers` says.
fn walk(steps: &[Step], answers: &[(&str, bool)]) -> Vec<String> {
    let mut visited = Vec::new();
    let mut action = next_action(steps, None);
    while let RunAction::RunStep { step_id } = action {
        let outcome = match answers.iter().find(|(id, _)| *id == step_id) {
            Some((_, yes)) => StepOutcome::Branched { yes: *yes },
            None => StepOutcome::Completed,
        };
        action = next_action(steps, Some((&step_id, &outcome)));
        visited.push(step_id);
    }
    assert_eq!(action, RunAction::End(RunEnd::Completed));
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
        RunAction::End(RunEnd::Completed)
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
        RunAction::End(RunEnd::NeedsAttention {
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
        RunAction::End(RunEnd::Completed)
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
        RunAction::End(RunEnd::Completed)
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
        RunAction::End(RunEnd::NeedsAttention {
            reason: "Notifications are off.".into()
        })
    );
    assert_eq!(
        next_action(&steps, Some(("retry", &StepOutcome::Completed))),
        run_step("retried")
    );
}
