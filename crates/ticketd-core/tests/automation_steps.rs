//! What the Change ticket, Notify me and If steps of a run do. The core runs them
//! itself as a run reaches them, so each test advances a run and looks at the ticket
//! and at what comes back.

use ticketd_core::{
    Automation, AutomationDefinition, AutomationRun, AutomationRunStatus, AutomationStepStatus,
    Check, NotifyTarget, RunAction, RunEnd, Status, Step, StepAction, StepChange, StepOutcome,
    Ticket, TicketPatch, Trigger, Workspace, WorkspaceActor,
};

const TAG: &str = "ready-for-testing";
const NAME: &str = "Verify on staging";

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("steps.sqlite3")).unwrap();
    (dir, workspace)
}

fn change(id: &str, change: StepChange) -> Step {
    Step {
        id: id.into(),
        action: StepAction::ChangeTicket {
            change: Some(change),
            on_failure: None,
        },
    }
}

fn notify(id: &str, text: &str, opens: NotifyTarget) -> Step {
    Step {
        id: id.into(),
        action: StepAction::Notify {
            text: text.into(),
            opens,
            on_failure: None,
        },
    }
}

/// An Automation named `NAME` that is on and starts when `TAG` is added.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn automation_on(workspace: &mut Workspace, steps: Vec<Step>) -> Automation {
    let automation = workspace
        .create_automation(AutomationDefinition {
            name: NAME.into(),
            trigger: Some(Trigger::TagAdded { tag: TAG.into() }),
            conditions: Vec::new(),
            steps,
        })
        .unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap()
}

/// Tags a new ticket and starts the run that follows.
#[allow(clippy::unwrap_used)]
fn started(workspace: &mut Workspace, title: &str) -> (Ticket, AutomationRun) {
    let ticket = workspace.create_ticket(title).unwrap();
    let ticket = workspace.add_tag(&ticket.reference, TAG).unwrap();
    workspace.queue_automation_runs().unwrap();
    let run = workspace.start_automation_runs(2).unwrap().remove(0);
    (ticket, run)
}

/// The actor of the newest Workspace event.
#[allow(clippy::unwrap_used)]
fn last_actor(workspace: &Workspace) -> WorkspaceActor {
    let head = workspace.workspace_event_head().unwrap();
    workspace
        .workspace_events_after(head - 1, 1)
        .unwrap()
        .remove(0)
        .actor
}

#[test]
fn adding_a_tag_is_logged_as_the_automations_and_starts_no_automation() {
    let (_dir, mut workspace) = workspace();
    // The step adds the very tag that starts the Automation: a loop, were its
    // writes a person's.
    let automation = automation_on(
        &mut workspace,
        vec![change("tag", StepChange::AddTag { tag: TAG.into() })],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    workspace.remove_tag(&ticket.reference, TAG).unwrap();
    workspace.queue_automation_runs().unwrap();

    assert_eq!(
        workspace.advance_automation_run(&run.id, None).unwrap(),
        RunAction::End(RunEnd::Completed)
    );

    let ticket = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(ticket.tags, [TAG]);
    assert_eq!(last_actor(&workspace), WorkspaceActor::Automation);
    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
    assert_eq!(workspace.automation_runs(&automation.id).unwrap().len(), 1);

    // The connection goes back to writing as the person.
    workspace.add_tag(&ticket.reference, "by-hand").unwrap();
    assert_eq!(last_actor(&workspace), WorkspaceActor::Person);
}

#[test]
fn removing_a_tag_takes_only_that_tag_off_the_ticket() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![change("untag", StepChange::RemoveTag { tag: TAG.into() })],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    workspace.add_tag(&ticket.reference, "backend").unwrap();

    workspace.advance_automation_run(&run.id, None).unwrap();

    let ticket = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(ticket.tags, ["backend"]);
    assert_eq!(last_actor(&workspace), WorkspaceActor::Automation);
}

#[test]
fn setting_the_status_is_attributed_to_the_automation_by_name() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![change(
            "done",
            StepChange::SetStatus {
                status: Status::Done,
            },
        )],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");

    workspace.advance_automation_run(&run.id, None).unwrap();

    let ticket = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(ticket.status, Status::Done);
    assert_eq!(last_actor(&workspace), WorkspaceActor::Automation);
    let history = workspace.ticket_history(&ticket.reference).unwrap();
    let change = history.iter().find(|entry| entry.kind == "status").unwrap();
    assert_eq!(change.editing_agent.as_deref(), Some(NAME));
}

#[test]
fn a_posted_update_is_signed_with_the_automations_name_and_fills_in_its_fields() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![change(
            "update",
            StepChange::PostUpdate {
                text: "{{ticket.reference}} {{ticket.title}} is {{ticket.status}} after \
                       {{event.tag}}. {{ticket.body}} {{ ticket.title }}"
                    .into(),
            },
        )],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    // The fields are read when the step runs, not when the run was created. A title
    // that spells a reference is text, not a reference.
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Fix {{ticket.status}} login".into()),
                status: Some(Status::InReview),
                ..Default::default()
            },
        )
        .unwrap();

    workspace.advance_automation_run(&run.id, None).unwrap();

    let updates = workspace.activities(&ticket.reference, 10, 0).unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(
        updates[0].brief,
        format!(
            "{} Fix {{{{ticket.status}}}} login is In review after {TAG}. \
             {{{{ticket.body}}}} {{{{ ticket.title }}}}",
            ticket.reference
        )
    );
    assert_eq!(updates[0].editing_agent.as_deref(), Some(NAME));
    assert_eq!(last_actor(&workspace), WorkspaceActor::Automation);
}

#[test]
fn a_change_the_workspace_refuses_fails_the_step_and_leaves_the_connection_a_persons() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![change("tag", StepChange::AddTag { tag: "seen".into() })],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();

    let action = workspace.advance_automation_run(&run.id, None).unwrap();

    // The Workspace's words are the step's reason, and with no failure path the run
    // needs attention.
    let RunAction::End(RunEnd::NeedsAttention { reason }) = action else {
        panic!("the run needs attention, got {action:?}");
    };
    assert!(reason.contains("trash"), "{reason}");
    let ended = workspace.automation_run(&run.id).unwrap();
    assert_eq!(ended.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(ended.steps[0].status, AutomationStepStatus::Failed);
    assert_eq!(ended.steps[0].reason.as_deref(), Some(reason.as_str()));
    workspace
        .set_trashed(&ticket.reference, false, None)
        .unwrap();
    workspace.add_tag(&ticket.reference, "by-hand").unwrap();
    assert_eq!(last_actor(&workspace), WorkspaceActor::Person);
    let ticket = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(ticket.tags, ["by-hand", TAG]);
}

#[test]
fn a_change_is_not_made_once_the_run_has_ended_elsewhere() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![
            notify("wait", "Hello", NotifyTarget::Ticket),
            change("tag", StepChange::AddTag { tag: "seen".into() }),
        ],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    workspace.advance_automation_run(&run.id, None).unwrap();
    workspace.stop_automation_run(&run.id).unwrap();

    // The executor reports the step it was on, after the person stopped the run.
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::Ended
    );

    let ticket = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(ticket.tags, [TAG]);
}

#[test]
fn a_notification_carries_the_automations_name_the_filled_in_text_and_what_it_opens() {
    let (_dir, mut workspace) = workspace();
    let automation = automation_on(
        &mut workspace,
        vec![
            notify(
                "tell",
                "Verified {{ticket.reference}} {{ticket.title}}",
                NotifyTarget::Ticket,
            ),
            notify("tell-run", "See the run", NotifyTarget::Run),
        ],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");

    let RunAction::Notify {
        step_id,
        notification,
    } = workspace.advance_automation_run(&run.id, None).unwrap()
    else {
        panic!("the run asks for a notification");
    };

    assert_eq!(step_id, "tell");
    assert_eq!(notification.title, NAME);
    assert_eq!(
        notification.body,
        format!("Verified {} Fix login", ticket.reference)
    );
    assert_eq!(notification.opens, NotifyTarget::Ticket);
    assert_eq!(
        notification.ticket_reference.as_deref(),
        Some(ticket.reference.as_str())
    );
    assert_eq!(notification.automation_id, automation.id);
    assert_eq!(notification.run_id, run.id);
    let RunAction::Notify {
        notification: to_run,
        ..
    } = workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap()
    else {
        panic!("the run asks for a second notification");
    };
    assert_eq!(to_run.opens, NotifyTarget::Run);
}

#[test]
fn a_preview_fills_in_the_text_with_the_ticket_changed_most_recently() {
    let (dir, mut workspace) = workspace();
    let text = "{{ticket.reference}} {{ticket.title}} ({{ticket.status}}) got {{event.tag}}";
    assert_eq!(
        workspace.preview_automation_text(text, None, true).unwrap(),
        None
    );
    let first = workspace.create_ticket("Fix login").unwrap();
    workspace.create_ticket("Untouched").unwrap();
    let trashed = workspace.create_ticket("Trashed").unwrap();
    // The three were made long ago, so the changes below are the most recent
    // whatever the clock does between two writes.
    rusqlite::Connection::open(dir.path().join("steps.sqlite3"))
        .unwrap()
        .execute(
            "UPDATE tickets SET updated_at = '2020-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
    workspace
        .change_ticket(
            &first.reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();

    let preview = workspace
        .preview_automation_text(text, Some("needs-fix"), true)
        .unwrap();

    assert_eq!(
        preview,
        Some(format!(
            "{} Fix login (In progress) got needs-fix",
            first.reference
        ))
    );
}

#[test]
fn a_preview_for_an_automation_without_a_ticket_leaves_every_field_empty() {
    let (_dir, mut workspace) = workspace();
    workspace.create_ticket("Fix login").unwrap();

    let preview = workspace
        .preview_automation_text("Week of {{ticket.title}}{{event.tag}} is up", None, false)
        .unwrap();

    // What a run started by a schedule or by hand will send: no ticket stands in.
    assert_eq!(preview.as_deref(), Some("Week of  is up"));
}

/// An If with a notification on each path, so the path taken is the one handed back.
fn branch(id: &str, checks: Vec<Check>) -> Step {
    Step {
        id: id.into(),
        action: StepAction::If {
            checks,
            yes: vec![notify("yes", "Yes", NotifyTarget::Ticket)],
            no: vec![notify("no", "No", NotifyTarget::Ticket)],
        },
    }
}

/// Runs an Automation's newest run (a fresh one when it has ended) to the path its If
/// chose, on the ticket as it is now: whether that was Yes.
#[allow(clippy::unwrap_used, clippy::panic)] // Setup that fails fails the test.
fn chose_yes(workspace: &mut Workspace, automation: &Automation) -> bool {
    let mut run = workspace.automation_runs(&automation.id).unwrap().remove(0);
    if run.status == AutomationRunStatus::Completed {
        run = workspace.run_automation_again(&run.id).unwrap();
    }
    workspace.start_automation_runs(10).unwrap();
    let mut outcome = None;
    let chosen = loop {
        let action = workspace.advance_automation_run(&run.id, outcome).unwrap();
        let RunAction::Notify { step_id, .. } = action else {
            panic!("the If hands over the notification on its path, got {action:?}");
        };
        // A step before the If is only waited for.
        if step_id == "wait" {
            outcome = Some(StepOutcome::Completed);
        } else {
            break step_id;
        }
    };
    workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();
    chosen == "yes"
}

#[test]
fn an_if_tests_the_ticket_as_it_is_when_reached_and_passes_when_every_check_does() {
    let (_dir, mut workspace) = workspace();
    let automation = automation_on(
        &mut workspace,
        vec![
            notify("wait", "Waiting", NotifyTarget::Ticket),
            branch(
                "passed",
                vec![
                    Check::Tag {
                        tag: "verified".into(),
                        has: true,
                    },
                    Check::Status {
                        status: Some(Status::Done),
                        is: true,
                    },
                ],
            ),
        ],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    workspace.advance_automation_run(&run.id, None).unwrap();

    // What an agent records after the run started is what the If reads.
    workspace.add_tag(&ticket.reference, "verified").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    let action = workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();
    assert!(matches!(&action, RunAction::Notify { step_id, .. } if step_id == "yes"));
    workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();

    // Another run reads the ticket as it is then: one check no longer holds.
    workspace.remove_tag(&ticket.reference, "verified").unwrap();
    assert!(!chose_yes(&mut workspace, &automation));
}

#[test]
fn an_if_checks_for_a_project_no_project_and_what_the_ticket_is_not() {
    let (dir, mut workspace) = workspace();
    let project = workspace
        .create_project("Web", &dir.path().to_string_lossy())
        .unwrap();
    let in_project = |is| Check::Project {
        project_id: Some(Some(project.id.clone())),
        is,
    };
    let checks = [
        vec![in_project(true)],
        vec![in_project(false)],
        vec![Check::Project {
            project_id: Some(None),
            is: true,
        }],
        vec![
            Check::Status {
                status: Some(Status::Done),
                is: false,
            },
            Check::Tag {
                tag: "blocked".into(),
                has: false,
            },
        ],
    ];
    // One Automation for each question, all started by the same tag.
    let automations =
        checks.map(|checks| automation_on(&mut workspace, vec![branch("if", checks)]));
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace.add_tag(&ticket.reference, TAG).unwrap();
    workspace.queue_automation_runs().unwrap();
    let passes = |workspace: &mut Workspace| {
        automations
            .iter()
            .map(|automation| chose_yes(workspace, automation))
            .collect::<Vec<_>>()
    };
    assert_eq!(passes(&mut workspace), [false, true, true, true]);

    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                project_id: Some(Some(project.id.clone())),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    workspace.add_tag(&ticket.reference, "blocked").unwrap();
    assert_eq!(passes(&mut workspace), [true, false, false, false]);
}
