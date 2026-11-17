//! Automations that start without a ticket: on a schedule, or when the person
//! presses Run now. Times are the computer's local time, handed in.

use ticketd_core::{
    Automation, AutomationAgentSettings, AutomationDefinition, AutomationRun, AutomationRunStatus,
    Error, RunAction, RunEnd, Schedule, Step, StepAction, StepChange, StepOutcome, Trigger,
    Weekday, Workspace,
};

// 2026-11-16 is a Monday.
const SUNDAY_NOON: &str = "2026-11-15T12:00:00";

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("schedule.sqlite3")).unwrap();
    (dir, workspace)
}

fn every(hours: u32) -> Trigger {
    Trigger::Schedule {
        schedule: Schedule::EveryHours { hours },
    }
}

fn weekly(time: &str, weekdays: &[Weekday]) -> Trigger {
    Trigger::Schedule {
        schedule: Schedule::Weekly {
            time: time.into(),
            weekdays: weekdays.to_vec(),
        },
    }
}

/// An Automation with one finished Run agent step, started by `trigger`. It is off.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn automation(workspace: &mut Workspace, trigger: Trigger) -> Automation {
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    workspace
        .create_automation(AutomationDefinition {
            name: "Weekly summary".into(),
            trigger: Some(trigger),
            conditions: Vec::new(),
            steps: vec![Step {
                id: "summarise".into(),
                action: StepAction::RunAgent {
                    agent_id: Some(agent.id),
                    execution_folder: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                    on_failure: None,
                },
            }],
        })
        .unwrap()
}

/// The same, switched on, with its schedule counting from Sunday noon.
#[allow(clippy::unwrap_used)]
fn scheduled(workspace: &mut Workspace, trigger: Trigger) -> Automation {
    let automation = automation(workspace, trigger);
    let on = workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();
    assert_eq!(fired(workspace, SUNDAY_NOON), 0);
    on
}

/// How many runs the schedules start when the local time is `now`.
#[allow(clippy::unwrap_used)]
fn fired(workspace: &mut Workspace, now: &str) -> usize {
    workspace
        .queue_scheduled_automation_runs(Some(now))
        .unwrap()
}

#[allow(clippy::unwrap_used)]
fn runs(workspace: &Workspace, automation: &Automation) -> Vec<AutomationRun> {
    workspace.automation_runs(&automation.id).unwrap()
}

/// Starts every queued run and ends its only step with `outcome`. Returns how the
/// last one ended.
#[allow(clippy::unwrap_used)]
fn finish(workspace: &mut Workspace, outcome: StepOutcome) -> RunAction {
    let started = workspace.start_automation_runs(10).unwrap();
    let ended = started.iter().map(|run| {
        workspace.advance_automation_run(&run.id, None).unwrap();
        workspace
            .advance_automation_run(&run.id, Some(outcome.clone()))
            .unwrap()
    });
    ended.last().unwrap()
}

#[test]
fn a_schedule_of_every_n_hours_fires_n_hours_after_it_last_did() {
    let (_dir, mut workspace) = workspace();
    let automation = scheduled(&mut workspace, every(6));

    assert_eq!(fired(&mut workspace, "2026-11-15T17:59:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-15T18:00:00"), 1);

    let run = runs(&workspace, &automation).remove(0);
    assert_eq!(run.status, AutomationRunStatus::Queued);
    // Nothing happened to a ticket: the run has no ticket and no event.
    assert_eq!(run.ticket, None);
    assert_eq!(run.event, None);
    assert_eq!(run.definition, automation.definition);
    assert_eq!(
        finish(&mut workspace, StepOutcome::Completed),
        RunAction::End(RunEnd::Completed)
    );

    assert_eq!(fired(&mut workspace, "2026-11-15T23:59:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-16T00:00:00"), 1);
}

#[test]
fn a_weekly_schedule_fires_at_its_time_on_the_chosen_weekdays() {
    let (_dir, mut workspace) = workspace();
    scheduled(
        &mut workspace,
        weekly("09:00", &[Weekday::Mon, Weekday::Fri]),
    );

    assert_eq!(fired(&mut workspace, "2026-11-16T08:59:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-16T09:00:03"), 1);
    finish(&mut workspace, StepOutcome::Completed);
    // Once for Monday, and not on a day that was not chosen.
    assert_eq!(fired(&mut workspace, "2026-11-16T09:05:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-17T09:00:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-20T08:00:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-20T09:00:00"), 1);
}

#[test]
fn a_schedule_missed_while_ticketd_was_not_running_fires_once_at_the_next_start() {
    let (_dir, mut workspace) = workspace();
    let hourly = scheduled(&mut workspace, every(1));
    let daily = scheduled(
        &mut workspace,
        weekly("09:00", &[Weekday::Mon, Weekday::Tue, Weekday::Wed]),
    );

    // Closed from Sunday to Thursday: dozens of hours and three mornings went by.
    assert_eq!(fired(&mut workspace, "2026-11-19T10:30:00"), 2);
    assert_eq!(runs(&workspace, &hourly).len(), 1);
    assert_eq!(runs(&workspace, &daily).len(), 1);
    finish(&mut workspace, StepOutcome::Completed);

    // What was missed is spent. The hours count again from when it fired.
    assert_eq!(fired(&mut workspace, "2026-11-19T10:31:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-19T11:30:00"), 1);
    assert_eq!(runs(&workspace, &hourly).len(), 2);
}

#[test]
fn a_schedule_that_comes_due_while_its_last_run_is_still_going_starts_no_second_run() {
    let (_dir, mut workspace) = workspace();
    let automation = scheduled(&mut workspace, every(1));
    assert_eq!(fired(&mut workspace, "2026-11-15T13:00:00"), 1);

    assert_eq!(fired(&mut workspace, "2026-11-15T14:00:00"), 0);
    finish(&mut workspace, StepOutcome::Completed);

    // That hour was skipped, not kept for later.
    assert_eq!(fired(&mut workspace, "2026-11-15T14:01:00"), 0);
    assert_eq!(runs(&workspace, &automation).len(), 1);
}

#[test]
fn only_a_schedule_that_is_on_fires_and_changing_it_starts_counting_again() {
    let (_dir, mut workspace) = workspace();
    let off = automation(&mut workspace, every(1));
    let on = scheduled(&mut workspace, every(4));

    assert_eq!(fired(&mut workspace, "2026-11-15T15:00:00"), 0);
    assert!(runs(&workspace, &off).is_empty());

    // Three hours in, it becomes every two hours: two hours from now, not at once.
    workspace
        .update_automation(
            &on.id,
            AutomationDefinition {
                trigger: Some(every(2)),
                ..on.definition.clone()
            },
        )
        .unwrap();
    assert_eq!(fired(&mut workspace, "2026-11-15T15:01:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-15T17:00:00"), 0);
    assert_eq!(fired(&mut workspace, "2026-11-15T17:01:00"), 1);
}

#[test]
fn a_weekly_schedule_needs_a_real_time() {
    let (_dir, mut workspace) = workspace();
    for time in ["", "9 o'clock", "25:00"] {
        let unfinished = automation(&mut workspace, weekly(time, &[Weekday::Mon]));
        assert_eq!(
            unfinished.problems[0].message, "Needs a time and a weekday",
            "{time}"
        );
    }
}

#[test]
fn run_now_queues_a_run_without_a_ticket_one_at_a_time() {
    let (_dir, mut workspace) = workspace();
    let automation = automation(&mut workspace, Trigger::ByHand);

    let run = workspace.run_automation_now(&automation.id).unwrap();

    assert_eq!(run.status, AutomationRunStatus::Queued);
    assert_eq!(run.ticket, None);
    assert_eq!(run.event, None);
    assert_eq!(runs(&workspace, &automation), vec![run.clone()]);
    assert!(matches!(
        workspace.run_automation_now(&automation.id),
        Err(Error::AutomationRun(_))
    ));

    finish(&mut workspace, StepOutcome::Completed);
    workspace.run_automation_now(&automation.id).unwrap();
    // Run again on the finished run is refused the same way while one is going.
    assert!(matches!(
        workspace.run_automation_again(&run.id),
        Err(Error::AutomationRun(_))
    ));
    finish(&mut workspace, StepOutcome::Completed);
    let again = workspace.run_automation_again(&run.id).unwrap();
    assert_eq!((again.ticket, again.event), (None, None));
}

#[test]
fn a_by_hand_automation_is_never_on() {
    let (_dir, mut workspace) = workspace();
    let by_hand = automation(&mut workspace, Trigger::ByHand);

    assert!(workspace.set_automation_enabled(&by_hand.id, true).is_err());
    assert!(!workspace.any_automation_on().unwrap());

    // One that is on and becomes by-hand goes off, so nothing keeps ticketd in the tray.
    let on = scheduled(&mut workspace, every(1));
    let changed = workspace
        .update_automation(
            &on.id,
            AutomationDefinition {
                trigger: Some(Trigger::ByHand),
                ..on.definition
            },
        )
        .unwrap();
    assert!(!changed.enabled);
    assert!(!workspace.any_automation_on().unwrap());
    // Nothing fires on a timer either.
    assert_eq!(fired(&mut workspace, "2026-11-20T09:00:00"), 0);
}

#[test]
fn run_now_is_refused_unless_the_automation_is_by_hand_and_finished() {
    let (_dir, mut workspace) = workspace();
    let from_a_tag = automation(
        &mut workspace,
        Trigger::TagAdded {
            tag: "ready".into(),
        },
    );
    assert!(matches!(
        workspace.run_automation_now(&from_a_tag.id),
        Err(Error::AutomationRun(_))
    ));

    // A step that needs a ticket makes a by-hand Automation unfinished.
    let by_hand = automation(&mut workspace, Trigger::ByHand);
    let mut definition = by_hand.definition.clone();
    definition.steps.push(Step {
        id: "tag".into(),
        action: StepAction::ChangeTicket {
            change: Some(StepChange::AddTag { tag: "done".into() }),
            on_failure: None,
        },
    });
    workspace
        .update_automation(&by_hand.id, definition)
        .unwrap();
    let Err(Error::AutomationUnfinished(reason)) = workspace.run_automation_now(&by_hand.id) else {
        panic!("a by-hand Automation with a Change ticket step ran");
    };
    assert_eq!(
        reason,
        "Change ticket: needs a ticket, and this Automation does not start from one"
    );
    assert!(runs(&workspace, &by_hand).is_empty());
}

#[test]
fn a_failed_run_without_a_ticket_needs_you_but_has_no_ticket_to_put_it_in_the_inbox() {
    let (_dir, mut workspace) = workspace();
    let automation = automation(&mut workspace, Trigger::ByHand);
    workspace.run_automation_now(&automation.id).unwrap();

    finish(
        &mut workspace,
        StepOutcome::Failed {
            reason: "The agent could not finish.".into(),
        },
    );

    let run = runs(&workspace, &automation).remove(0);
    assert_eq!(run.status, AutomationRunStatus::NeedsAttention);
    assert!(run.needs_you);
    assert_eq!(workspace.sidebar_counts().unwrap().runs_needing_you, 1);
    assert!(workspace.inbox_page(10, 0, false).unwrap().is_empty());
    // Dismissing it works as for any run.
    assert!(!workspace.dismiss_automation_run(&run.id).unwrap().needs_you);
}

#[test]
fn the_previous_format_gains_schedule_state_and_keeps_what_is_on() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let automation = automation(&mut workspace, every(1));
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "ALTER TABLE automation_device_state DROP COLUMN schedule_from; PRAGMA user_version = 79;",
    )
    .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();

    assert!(workspace.automation(&automation.id).unwrap().enabled);
    assert_eq!(fired(&mut workspace, SUNDAY_NOON), 0);
    assert_eq!(fired(&mut workspace, "2026-11-15T13:00:00"), 1);
}
