//! How an Automation run ends: every cause against every status a run can be in,
//! through the Workspace. A cause that cannot end a run in its status changes
//! nothing.

use ticketd_core::{
    AutomationAgentSettings, AutomationDefinition, AutomationRun, AutomationRunStatus,
    AutomationStepStatus, RunAction, Step, StepAction, StepOutcome, Trigger, Workspace,
};

const TAG: &str = "ready-for-triage";
const LIMIT: &str = "The agent reached its limit of 40 turns before finishing.";
const LOST: &str = "The executor lost the run.";
const STOPPED: &str = "You stopped this run.";
const TURNED_OFF: &str = "You stopped this run when you turned the Automation off.";
const DELETED: &str = "You deleted this Automation.";
const TOOK_OVER: &str = "You took this run over.";

#[derive(Debug, Clone, Copy)]
enum Cause {
    /// The person pressed Stop on the run.
    Stop,
    /// "Stop it and turn off".
    TurnOff,
    Delete,
    /// The executor cannot go on with it.
    Abandon,
    /// The person replied in its agent's Chat.
    TakeOver,
    /// The executor reports that its step failed.
    StepFails,
}

const CAUSES: [Cause; 6] = [
    Cause::Stop,
    Cause::TurnOff,
    Cause::Delete,
    Cause::Abandon,
    Cause::TakeOver,
    Cause::StepFails,
];

const STATES: [AutomationRunStatus; 5] = [
    AutomationRunStatus::Queued,
    AutomationRunStatus::Running,
    AutomationRunStatus::Completed,
    AutomationRunStatus::NeedsAttention,
    AutomationRunStatus::TakenOver,
];

/// What a run shows of how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    status: AutomationRunStatus,
    reason: Option<String>,
    needs_you: bool,
    ended: bool,
    /// The status and reason of the step it reached, if it reached one.
    step: Option<(AutomationStepStatus, Option<String>)>,
}

fn seen(run: &AutomationRun) -> Seen {
    Seen {
        status: run.status,
        reason: run.reason.clone(),
        needs_you: run.needs_you,
        ended: run.ended_at.is_some(),
        step: run
            .steps
            .first()
            .map(|step| (step.status, step.reason.clone())),
    }
}

/// What a cause does to a run in `state`, or `None` when it changes nothing.
fn ends_as(state: AutomationRunStatus, cause: Cause) -> Option<Seen> {
    use AutomationRunStatus::{NeedsAttention, Queued, Running, TakenOver};
    let needs_attention = |reason: &str, needs_you: bool, step: bool| {
        Some(Seen {
            status: NeedsAttention,
            reason: Some(reason.into()),
            needs_you,
            ended: true,
            step: step.then(|| (AutomationStepStatus::Failed, Some(reason.into()))),
        })
    };
    match (cause, state) {
        (Cause::Stop, Queued) => needs_attention(STOPPED, true, false),
        (Cause::Stop, Running) => needs_attention(STOPPED, true, true),
        (Cause::TurnOff, Queued) => needs_attention(TURNED_OFF, true, false),
        (Cause::TurnOff, Running) => needs_attention(TURNED_OFF, true, true),
        // They asked for it: nothing is left for them to do.
        (Cause::Delete, Queued) => needs_attention(DELETED, false, false),
        (Cause::Delete, Running) => needs_attention(DELETED, false, true),
        (Cause::Abandon, Running) => needs_attention(LOST, true, true),
        (Cause::StepFails, Running) => needs_attention(LIMIT, true, true),
        (Cause::TakeOver, Running) => Some(Seen {
            status: TakenOver,
            reason: None,
            needs_you: false,
            ended: true,
            step: Some((AutomationStepStatus::Failed, Some(TOOK_OVER.into()))),
        }),
        // The step had already failed for its own reason, which stays.
        (Cause::TakeOver, NeedsAttention) => Some(Seen {
            status: TakenOver,
            reason: None,
            needs_you: false,
            ended: true,
            step: Some((AutomationStepStatus::Failed, Some(LIMIT.into()))),
        }),
        _ => None,
    }
}

/// A Workspace whose one run is in `state`.
struct Setup {
    _dir: tempfile::TempDir,
    workspace: Workspace,
    automation: String,
    run: String,
    /// The Chat of the run's agent step, once it has one.
    chat: Option<String>,
}

#[allow(clippy::unwrap_used, clippy::panic)] // Setup that fails fails the test.
fn run_in(state: AutomationRunStatus) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("endings.sqlite3")).unwrap();
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    let automation = workspace
        .create_automation(AutomationDefinition {
            name: "Triage".into(),
            trigger: Some(Trigger::TagAdded { tag: TAG.into() }),
            conditions: Vec::new(),
            steps: vec![Step {
                id: "triage".into(),
                action: StepAction::RunAgent {
                    agent_id: Some(agent.id),
                    execution_folder: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                    on_failure: None,
                },
            }],
        })
        .unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace.add_tag(&ticket.reference, TAG).unwrap();
    workspace.queue_automation_runs().unwrap();
    let run = workspace.all_automation_runs().unwrap().remove(0).id;
    let mut setup = Setup {
        automation: automation.id,
        run,
        workspace,
        chat: None,
        _dir: dir,
    };
    if state == AutomationRunStatus::Queued {
        return setup;
    }
    setup.workspace.start_automation_runs(2).unwrap();
    let begun = setup
        .workspace
        .advance_automation_run(&setup.run, None)
        .unwrap();
    let RunAction::RunAgent(start) = begun else {
        panic!("the run begins with its agent, got {begun:?}");
    };
    setup.chat = Some(start.chat_id);
    let outcome = match state {
        AutomationRunStatus::Running => return setup,
        AutomationRunStatus::Completed => StepOutcome::Completed,
        _ => StepOutcome::Failed {
            reason: LIMIT.into(),
        },
    };
    setup
        .workspace
        .advance_automation_run(&setup.run, Some(outcome))
        .unwrap();
    if state == AutomationRunStatus::TakenOver {
        let chat = setup.chat.as_deref().unwrap();
        setup
            .workspace
            .take_over_automation_run(chat, true)
            .unwrap();
    }
    setup
}

/// Applies `cause` to the run. What a refusal says is not under test here.
fn apply(setup: &mut Setup, cause: Cause) {
    let Setup {
        workspace,
        automation,
        run,
        chat,
        ..
    } = setup;
    match cause {
        Cause::Stop => drop(workspace.stop_automation_run(run)),
        Cause::TurnOff => drop(workspace.stop_and_turn_off_automation(automation)),
        Cause::Delete => drop(workspace.delete_automation(automation)),
        Cause::Abandon => drop(workspace.fail_automation_run(run, LOST)),
        Cause::TakeOver => {
            if let Some(chat) = chat {
                drop(workspace.take_over_automation_run(chat, true));
            }
        }
        Cause::StepFails => drop(workspace.advance_automation_run(
            run,
            Some(StepOutcome::Failed {
                reason: LIMIT.into(),
            }),
        )),
    }
}

#[test]
fn each_cause_ends_a_run_only_from_the_statuses_it_may() {
    for state in STATES {
        for cause in CAUSES {
            let mut setup = run_in(state);
            let before = seen(&setup.workspace.automation_run(&setup.run).unwrap());
            assert_eq!(before.status, state, "the setup reaches {state:?}");

            apply(&mut setup, cause);

            let after = seen(&setup.workspace.automation_run(&setup.run).unwrap());
            assert_eq!(
                after,
                ends_as(state, cause).unwrap_or(before),
                "{cause:?} on a run that is {state:?}"
            );
        }
    }
}

#[test]
fn a_run_that_needs_the_person_is_counted_and_one_that_was_answered_is_not() {
    for (cause, counted) in [
        (Cause::Stop, 1),
        (Cause::TurnOff, 1),
        (Cause::Abandon, 1),
        (Cause::StepFails, 1),
        (Cause::Delete, 0),
        (Cause::TakeOver, 0),
    ] {
        let mut setup = run_in(AutomationRunStatus::Running);

        apply(&mut setup, cause);

        let counts = setup.workspace.sidebar_counts().unwrap();
        assert_eq!(counts.runs_needing_you, counted, "{cause:?}");
        // The inbox says so for exactly the runs that need the person.
        let unread = setup.workspace.inbox(10, 0).unwrap().len();
        assert_eq!(unread, counted as usize, "{cause:?}");
    }
}
