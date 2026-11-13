//! What the Change ticket and Notify me steps of a run do, through the Workspace.

use ticketd_core::{
    Automation, AutomationDefinition, AutomationRun, Check, NotifyTarget, Status, Step, StepAction,
    StepChange, StepOutcome, Ticket, TicketPatch, Trigger, Workspace, WorkspaceActor,
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

    workspace.apply_automation_change(&run.id, "tag").unwrap();

    let ticket = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(ticket.tags, [TAG]);
    assert_eq!(last_actor(&workspace), WorkspaceActor::Automation);
    workspace
        .advance_automation_run(&run.id, None)
        .and_then(|_| workspace.advance_automation_run(&run.id, Some(StepOutcome::Completed)))
        .unwrap();
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

    workspace.apply_automation_change(&run.id, "untag").unwrap();

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

    workspace.apply_automation_change(&run.id, "done").unwrap();

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

    workspace
        .apply_automation_change(&run.id, "update")
        .unwrap();

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
fn a_change_the_workspace_refuses_is_an_error_and_leaves_the_connection_a_persons() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![change("tag", StepChange::AddTag { tag: "seen".into() })],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();

    let refused = workspace.apply_automation_change(&run.id, "tag");

    assert!(refused.is_err(), "a trashed ticket takes no tag");
    workspace
        .set_trashed(&ticket.reference, false, None)
        .unwrap();
    workspace.add_tag(&ticket.reference, "by-hand").unwrap();
    assert_eq!(last_actor(&workspace), WorkspaceActor::Person);
    let ticket = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(ticket.tags, ["by-hand", TAG]);
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

    let notification = workspace.automation_notification(&run.id, "tell").unwrap();

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
    let to_run = workspace
        .automation_notification(&run.id, "tell-run")
        .unwrap();
    assert_eq!(to_run.opens, NotifyTarget::Run);
}

#[test]
fn a_preview_fills_in_the_text_with_the_ticket_changed_most_recently() {
    let (_dir, mut workspace) = workspace();
    let text = "{{ticket.reference}} {{ticket.title}} ({{ticket.status}}) got {{event.tag}}";
    assert_eq!(workspace.preview_automation_text(text, None).unwrap(), None);
    let first = workspace.create_ticket("Fix login").unwrap();
    workspace.create_ticket("Untouched").unwrap();
    let trashed = workspace.create_ticket("Trashed").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    workspace
        .change_ticket(
            &first.reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();

    let preview = workspace
        .preview_automation_text(text, Some("needs-fix"))
        .unwrap();

    assert_eq!(
        preview,
        Some(format!(
            "{} Fix login (In progress) got needs-fix",
            first.reference
        ))
    );
}

fn branch(id: &str, checks: Vec<Check>) -> Step {
    Step {
        id: id.into(),
        action: StepAction::If {
            checks,
            yes: Vec::new(),
            no: Vec::new(),
        },
    }
}

#[test]
fn an_if_tests_the_ticket_as_it_is_when_asked_and_passes_when_every_check_does() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![branch(
            "passed",
            vec![
                Check::Tag {
                    tag: "verified".into(),
                    has: true,
                },
                Check::Status {
                    status: Status::Done,
                    is: true,
                },
            ],
        )],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    assert!(!workspace.automation_if_passes(&run.id, "passed").unwrap());

    // What an agent records after the run started is what the If reads.
    workspace.add_tag(&ticket.reference, "verified").unwrap();
    assert!(!workspace.automation_if_passes(&run.id, "passed").unwrap());
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    assert!(workspace.automation_if_passes(&run.id, "passed").unwrap());

    workspace
        .remove_tag(&ticket.reference, "verified")
        .unwrap();
    assert!(!workspace.automation_if_passes(&run.id, "passed").unwrap());
}

#[test]
fn an_if_checks_for_a_project_no_project_and_what_the_ticket_is_not() {
    let (dir, mut workspace) = workspace();
    let project = workspace
        .create_project("Web", &dir.path().to_string_lossy())
        .unwrap();
    let in_project = |is| Check::Project {
        project_id: Some(project.id.clone()),
        is,
    };
    automation_on(
        &mut workspace,
        vec![
            branch("in", vec![in_project(true)]),
            branch("out", vec![in_project(false)]),
            branch(
                "none",
                vec![Check::Project {
                    project_id: None,
                    is: true,
                }],
            ),
            branch(
                "open",
                vec![
                    Check::Status {
                        status: Status::Done,
                        is: false,
                    },
                    Check::Tag {
                        tag: "blocked".into(),
                        has: false,
                    },
                ],
            ),
        ],
    );
    let (ticket, run) = started(&mut workspace, "Fix login");
    let passes = |workspace: &Workspace| {
        ["in", "out", "none", "open"].map(|id| workspace.automation_if_passes(&run.id, id).unwrap())
    };
    assert_eq!(passes(&workspace), [false, true, true, true]);

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
    assert_eq!(passes(&workspace), [true, false, false, false]);
}

#[test]
fn only_an_if_step_of_a_run_can_be_asked() {
    let (_dir, mut workspace) = workspace();
    automation_on(
        &mut workspace,
        vec![notify("tell", "Hello", NotifyTarget::Ticket)],
    );
    let (_, run) = started(&mut workspace, "Fix login");
    assert!(workspace.automation_if_passes(&run.id, "tell").is_err());
    assert!(workspace.automation_if_passes(&run.id, "gone").is_err());
}
