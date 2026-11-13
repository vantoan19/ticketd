//! The run state machine on flows that branch: which step a run goes to after an If.

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
