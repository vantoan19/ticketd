//! What keeps Automations going in the background: how many runs execute at once,
//! whether any Automation is on, and the two ways to switch one off mid-run.

use ticketd_core::{
    Automation, AutomationAgentSettings, AutomationDefinition, AutomationRunStatus,
    AutomationStepStatus, NotifyTarget, RunAction, RunEnd, Step, StepAction, StepOutcome, Trigger,
    Workspace,
};

const TAG: &str = "ready-for-triage";

/// A folder that exists, as a step's folder must.
fn folder() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

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
                    execution_folder: Some(folder()),
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
    tag(&mut workspace, "Queued");
    let running = &started[0];
    assert_eq!(running.automation_id, automation.id);
    let begun = workspace.advance_automation_run(&running.id, None).unwrap();
    let RunAction::RunAgent(agent) = begun else {
        panic!("the run begins with its agent, got {begun:?}");
    };
    let chat_id = agent.chat_id;

    let chats = workspace
        .stop_and_turn_off_automation(&automation.id)
        .unwrap();

    // The Chat of the agent that was working, for the host to interrupt.
    assert_eq!(chats, [chat_id]);
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
    // The interrupted agent's turn ends as a failure a moment later. The run has
    // ended, so that outcome is not recorded and the step's failure path does not run.
    let interrupted = StepOutcome::Failed {
        reason: "The agent could not finish.".into(),
    };
    assert_eq!(
        workspace
            .advance_automation_run(&running.id, Some(interrupted))
            .unwrap(),
        RunAction::Ended
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

/// An Automation this build cannot read (a newer ticketd wrote it) keeps its cursor
/// until a build that reads it arrives, so its events stay after the cursor. A pass
/// must still see that it can do nothing with them and leave the write lock alone;
/// otherwise every pass would take it again for as long as that Automation exists.
#[test]
#[allow(clippy::unwrap_used)]
fn the_waiting_events_of_an_automation_this_build_cannot_read_take_no_write_lock() {
    let (dir, mut workspace) = workspace();
    let unreadable = triage(&mut workspace);
    let db = rusqlite::Connection::open(dir.path().join("background.sqlite3")).unwrap();
    db.execute(
        "UPDATE automations SET definition = json_set(definition, '$.schema_version', 99) WHERE id = ?1",
        [&unreadable.id],
    )
    .unwrap();
    drop(db);
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace.add_tag(&ticket.reference, TAG).unwrap();
    // The event waits for a build that can read the Automation.
    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);

    let holder = rusqlite::Connection::open(dir.path().join("background.sqlite3")).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
}

/// A pass of the runner that finds nothing to do must not take the write lock, which
/// every other write of the Workspace waits for: passes come every few seconds. Another
/// connection holds the write lock; each step of the pass still answers, having read
/// that there is nothing to write. Were any of them to take the lock, it would wait and
/// then fail as busy.
#[test]
#[allow(clippy::unwrap_used)]
fn a_pass_with_nothing_to_do_takes_no_write_lock() {
    let (dir, mut workspace) = workspace();
    triage(&mut workspace);
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    let every_day = workspace
        .create_automation(AutomationDefinition {
            name: "Daily".into(),
            trigger: Some(Trigger::Schedule {
                schedule: ticketd_core::Schedule::EveryHours { hours: 24 },
            }),
            conditions: Vec::new(),
            steps: vec![Step {
                id: "summarise".into(),
                action: StepAction::RunAgent {
                    agent_id: Some(agent.id),
                    execution_folder: Some(folder()),
                    on_failure: None,
                },
            }],
        })
        .unwrap();
    workspace
        .set_automation_enabled(&every_day.id, true)
        .unwrap();
    // Seen on, so its schedule counts from noon.
    workspace
        .queue_scheduled_automation_runs(Some("2026-11-15T12:00:00"))
        .unwrap();
    let holder = rusqlite::Connection::open(dir.path().join("background.sqlite3")).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();

    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
    assert_eq!(
        workspace
            .queue_scheduled_automation_runs(Some("2026-11-15T13:00:00"))
            .unwrap(),
        0
    );
    assert!(workspace.start_automation_runs(2).unwrap().is_empty());
    assert_eq!(
        workspace.end_running_automation_runs(&[], "gone").unwrap(),
        0
    );
    assert!(
        workspace
            .end_runs_of_deleted_automations()
            .unwrap()
            .is_empty()
    );
}
