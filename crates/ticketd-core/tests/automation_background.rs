//! What keeps Automations going in the background: how many runs execute at once,
//! whether any Automation is on, and the two ways to switch one off mid-run.

use ticketd_core::{
    Automation, AutomationAgentSettings, AutomationDefinition, AutomationRunStatus,
    AutomationStepStatus, NewChat, NotifyTarget, RunAction, RunEnd, Step, StepAction, StepOutcome,
    Trigger, Workspace,
};

const TAG: &str = "ready-for-triage";

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("background.sqlite3")).unwrap();
    (dir, workspace)
}

/// An Automation that is on and runs one agent when `TAG` is added, with a step to
/// run if the agent fails.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn triage(workspace: &mut Workspace) -> Automation {
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
                    execution_folder: Some("/work/app".into()),
                    on_failure: Some(vec![Step {
                        id: "tell-me-it-failed".into(),
                        action: StepAction::Notify {
                            text: "Triage failed".into(),
                            opens: NotifyTarget::Ticket,
                            on_failure: None,
                        },
                    }]),
                },
            }],
        })
        .unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap()
}

#[allow(clippy::unwrap_used)]
fn tag(workspace: &mut Workspace, title: &str) {
    let ticket = workspace.create_ticket(title).unwrap();
    workspace.add_tag(&ticket.reference, TAG).unwrap();
    workspace.queue_automation_runs().unwrap();
}

/// The Automation's run statuses, oldest first.
#[allow(clippy::unwrap_used)]
fn statuses(workspace: &Workspace, automation: &Automation) -> Vec<AutomationRunStatus> {
    let runs = workspace.automation_runs(&automation.id).unwrap();
    runs.iter().rev().map(|run| run.status).collect()
}

#[test]
fn two_runs_execute_at_once_until_the_setting_is_changed() {
    let (_dir, workspace) = workspace();
    assert_eq!(workspace.automation_runs_at_once().unwrap(), 2);

    workspace.set_automation_runs_at_once(5).unwrap();

    assert_eq!(workspace.automation_runs_at_once().unwrap(), 5);
}

#[test]
fn runs_at_once_is_refused_outside_one_to_ten() {
    let (_dir, workspace) = workspace();

    assert!(workspace.set_automation_runs_at_once(0).is_err());
    assert!(workspace.set_automation_runs_at_once(11).is_err());

    assert_eq!(workspace.automation_runs_at_once().unwrap(), 2);
}

#[test]
fn an_automation_is_on_until_the_last_one_is_switched_off_or_deleted() {
    let (_dir, mut workspace) = workspace();
    assert!(!workspace.any_automation_on().unwrap());
    let first = triage(&mut workspace);
    let second = triage(&mut workspace);
    assert!(workspace.any_automation_on().unwrap());

    workspace.set_automation_enabled(&first.id, false).unwrap();
    assert!(workspace.any_automation_on().unwrap());
    workspace.delete_automation(&second.id).unwrap();

    assert!(!workspace.any_automation_on().unwrap());
}

#[test]
fn switching_off_lets_the_active_run_finish_and_starts_no_new_ones() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    tag(&mut workspace, "Fix login");
    let run = workspace.start_automation_runs(2).unwrap().remove(0);
    workspace.advance_automation_run(&run.id, None).unwrap();

    workspace
        .set_automation_enabled(&automation.id, false)
        .unwrap();
    tag(&mut workspace, "Tagged while off");

    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::End(RunEnd::Completed)
    );
    assert_eq!(
        statuses(&workspace, &automation),
        [AutomationRunStatus::Completed]
    );
}

#[test]
fn stopping_and_switching_off_ends_every_active_run_as_needs_attention() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let other = triage(&mut workspace);
    // Both Automations queue a run for each ticket; one run of each starts.
    tag(&mut workspace, "Running");
    let started = workspace.start_automation_runs(2).unwrap();
    for run in &started {
        workspace.advance_automation_run(&run.id, None).unwrap();
    }
    tag(&mut workspace, "Queued");
    let running = &started[0];
    assert_eq!(running.automation_id, automation.id);
    let chat = workspace
        .create_automation_run_chat(
            &running.id,
            "triage",
            NewChat {
                title: None,
                harness: "codex".into(),
                execution_folder: "/work/app".into(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();

    let chats = workspace
        .stop_and_turn_off_automation(&automation.id)
        .unwrap();

    // The Chat of the agent that was working, for the host to interrupt.
    assert_eq!(chats, [chat.id]);
    assert!(!workspace.automation(&automation.id).unwrap().enabled);
    let runs = workspace.automation_runs(&automation.id).unwrap();
    assert_eq!(runs.len(), 2);
    for run in &runs {
        assert_eq!(run.status, AutomationRunStatus::NeedsAttention);
        assert_eq!(
            run.reason.as_deref(),
            Some("You stopped this run when you turned the Automation off.")
        );
        assert!(run.ended_at.is_some());
    }
    let stopped = workspace.automation_run(&running.id).unwrap();
    assert_eq!(stopped.steps[0].status, AutomationStepStatus::Failed);
    assert_eq!(stopped.steps[0].reason, stopped.reason);
    // The interrupted agent's turn ends as a failure a moment later. That outcome is
    // refused, so the step's failure path does not run.
    let interrupted = StepOutcome::Failed {
        reason: "The agent could not finish.".into(),
    };
    assert!(
        workspace
            .advance_automation_run(&running.id, Some(interrupted))
            .is_err()
    );
    assert_eq!(
        workspace.automation_run(&running.id).unwrap().steps,
        stopped.steps
    );
    // The other Automation is untouched.
    assert!(workspace.automation(&other.id).unwrap().enabled);
    assert_eq!(
        statuses(&workspace, &other),
        [AutomationRunStatus::Running, AutomationRunStatus::Queued]
    );
}
