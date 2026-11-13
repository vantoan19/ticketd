//! Which ticket changes start an Automation: each trigger and each condition.

use ticketd_core::{
    Automation, AutomationAgentSettings, AutomationDefinition, Condition, Status, Step, StepAction,
    TicketPatch, Trigger, Workspace, WriteRequest, WriteResult,
};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("triggers.sqlite3")).unwrap();
    (dir, workspace)
}

/// An Automation that is on, with one finished step.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn automation_on(
    workspace: &mut Workspace,
    trigger: Trigger,
    conditions: Vec<Condition>,
) -> Automation {
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    let automation = workspace
        .create_automation(AutomationDefinition {
            name: "Triage".into(),
            trigger: Some(trigger),
            conditions,
            steps: vec![Step {
                id: "triage".into(),
                action: StepAction::RunAgent {
                    agent_id: Some(agent.id),
                    execution_folder: Some("/work/app".into()),
                    on_failure: None,
                },
            }],
        })
        .unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap()
}

/// Matches what was logged since the last call, and returns the references of the
/// tickets whose runs `automation` has, oldest first.
#[allow(clippy::unwrap_used)]
fn started(workspace: &mut Workspace, automation: &Automation) -> Vec<String> {
    workspace.queue_automation_runs().unwrap();
    let mut runs = workspace.automation_runs(&automation.id).unwrap();
    runs.sort_by_key(|run| run.event.as_ref().map(|event| event.id));
    runs.into_iter()
        .map(|run| run.ticket.unwrap().reference)
        .collect()
}

fn status(status: Status) -> TicketPatch {
    TicketPatch {
        status: Some(status),
        ..Default::default()
    }
}

#[test]
fn a_created_ticket_starts_the_ticket_created_automation_and_its_later_changes_do_not() {
    let (_dir, mut workspace) = workspace();
    let earlier = workspace.create_ticket("Already here").unwrap();
    let automation = automation_on(&mut workspace, Trigger::TicketCreated, Vec::new());

    workspace
        .change_ticket(&earlier.reference, status(Status::Done))
        .unwrap();
    workspace.add_tag(&earlier.reference, "ui").unwrap();
    let ticket = workspace.create_ticket("Fix login").unwrap();

    assert_eq!(started(&mut workspace, &automation), [ticket.reference]);
}

#[test]
fn a_change_to_title_description_or_project_starts_the_ticket_updated_automation() {
    let (dir, mut workspace) = workspace();
    let project = workspace
        .create_project("Website", dir.path().to_str().unwrap())
        .unwrap();
    let [retitled, described, moved, other] = ["Retitled", "Described", "Moved", "Other"]
        .map(|title| workspace.create_ticket(title).unwrap().reference);
    let automation = automation_on(&mut workspace, Trigger::TicketUpdated, Vec::new());

    // A status, a tag and an update are their own triggers, and a new ticket is not
    // an updated one.
    workspace
        .change_ticket(&other, status(Status::Done))
        .unwrap();
    workspace.add_tag(&other, "ui").unwrap();
    workspace
        .add_activity(&other, "Looked at it", None)
        .unwrap();
    workspace.create_ticket("New").unwrap();
    let patches = [
        (
            &retitled,
            TicketPatch {
                title: Some("Fix sign-in".into()),
                ..Default::default()
            },
        ),
        (
            &described,
            TicketPatch {
                body: Some("Steps".into()),
                ..Default::default()
            },
        ),
        (
            &moved,
            TicketPatch {
                project_id: Some(Some(project.id)),
                ..Default::default()
            },
        ),
    ];
    for (reference, patch) in patches {
        workspace.change_ticket(reference, patch).unwrap();
    }

    assert_eq!(
        started(&mut workspace, &automation),
        [retitled, described, moved]
    );
}

#[test]
fn an_update_posted_on_a_ticket_starts_the_update_added_automation() {
    let (_dir, mut workspace) = workspace();
    let [posted, other] =
        ["Posted", "Other"].map(|title| workspace.create_ticket(title).unwrap().reference);
    let automation = automation_on(&mut workspace, Trigger::ActivityCreated, Vec::new());

    workspace
        .change_ticket(&other, status(Status::Done))
        .unwrap();
    workspace
        .add_activity(&posted, "Reproduced on staging", None)
        .unwrap();

    assert_eq!(started(&mut workspace, &automation), [posted]);
}

#[test]
fn a_status_change_starts_the_automation_for_its_to_status_and_its_from_status_when_set() {
    let (_dir, mut workspace) = workspace();
    let [a, b, c] = ["A", "B", "C"].map(|title| workspace.create_ticket(title).unwrap().reference);
    let to_review = automation_on(
        &mut workspace,
        Trigger::StatusChanged {
            to: Some(Status::InReview),
            from: None,
        },
        Vec::new(),
    );
    let from_progress = automation_on(
        &mut workspace,
        Trigger::StatusChanged {
            to: Some(Status::InReview),
            from: Some(Status::InProgress),
        },
        Vec::new(),
    );

    // A goes Todo → In review, B goes In progress → In review, C goes elsewhere.
    workspace
        .change_ticket(&a, status(Status::InReview))
        .unwrap();
    workspace
        .change_ticket(&b, status(Status::InProgress))
        .unwrap();
    workspace
        .change_ticket(&b, status(Status::InReview))
        .unwrap();
    workspace.change_ticket(&c, status(Status::Done)).unwrap();

    assert_eq!(started(&mut workspace, &to_review), [a.clone(), b.clone()]);
    assert_eq!(started(&mut workspace, &from_progress), [b]);
}

#[test]
fn removing_the_trigger_tag_starts_the_tag_removed_automation() {
    let (_dir, mut workspace) = workspace();
    let [removed, other] =
        ["Removed", "Other"].map(|title| workspace.create_ticket(title).unwrap().reference);
    for reference in [&removed, &other] {
        workspace.add_tag(reference, "blocked").unwrap();
        workspace.add_tag(reference, "ui").unwrap();
    }
    let automation = automation_on(
        &mut workspace,
        Trigger::TagRemoved {
            tag: "blocked".into(),
        },
        Vec::new(),
    );

    workspace.remove_tag(&other, "ui").unwrap();
    workspace.add_tag(&other, "later").unwrap();
    workspace.remove_tag(&removed, "blocked").unwrap();

    assert_eq!(started(&mut workspace, &automation), [removed]);
}

const TAG: &str = "ready-for-triage";

fn tag_added() -> Trigger {
    Trigger::TagAdded { tag: TAG.into() }
}

#[test]
fn a_ticket_created_with_the_trigger_tag_starts_the_tag_added_automation() {
    let (_dir, mut workspace) = workspace();
    let automation = automation_on(&mut workspace, tag_added(), Vec::new());

    let request: WriteRequest = serde_json::from_value(serde_json::json!({
        "operation": "create_ticket_with_content",
        "title": "Complete creation",
        "body": "Details",
        "status": "Todo",
        "project_id": null,
        "plan_id": null,
        "tags": ["qa", TAG],
        "follow": false,
    }))
    .unwrap();
    let WriteResult::Ticket(ticket) = workspace.write(None, request).unwrap() else {
        panic!("expected a created ticket")
    };

    assert_eq!(started(&mut workspace, &automation), [ticket.reference]);
}

#[test]
fn a_project_condition_holds_for_a_ticket_in_one_of_its_projects() {
    let (dir, mut workspace) = workspace();
    let [web, api, docs] = ["web", "api", "docs"].map(|name| {
        let path = dir.path().join(name);
        std::fs::create_dir(&path).unwrap();
        workspace
            .create_project(name, path.to_str().unwrap())
            .unwrap()
            .id
    });
    let [in_web, in_api, in_docs, in_none] =
        [Some(&web), Some(&api), Some(&docs), None].map(|project| {
            let ticket = workspace.create_ticket("Fix login").unwrap();
            let patch = TicketPatch {
                project_id: Some(project.cloned()),
                ..Default::default()
            };
            workspace.change_ticket(&ticket.reference, patch).unwrap();
            ticket.reference
        });
    let automation = automation_on(
        &mut workspace,
        tag_added(),
        vec![Condition::Project {
            any_of: vec![web, api],
        }],
    );

    for reference in [&in_none, &in_docs, &in_web, &in_api] {
        workspace.add_tag(reference, TAG).unwrap();
    }

    assert_eq!(started(&mut workspace, &automation), [in_web, in_api]);
}

#[test]
fn a_tag_condition_holds_for_a_ticket_that_has_or_does_not_have_the_tag() {
    let (_dir, mut workspace) = workspace();
    let [bug, plain] =
        ["Bug", "Plain"].map(|title| workspace.create_ticket(title).unwrap().reference);
    workspace.add_tag(&bug, "bug").unwrap();
    let condition = |has| {
        vec![Condition::Tag {
            tag: "bug".into(),
            has,
        }]
    };
    let with = automation_on(&mut workspace, tag_added(), condition(true));
    let without = automation_on(&mut workspace, tag_added(), condition(false));

    workspace.add_tag(&bug, TAG).unwrap();
    workspace.add_tag(&plain, TAG).unwrap();

    assert_eq!(started(&mut workspace, &with), [bug]);
    assert_eq!(started(&mut workspace, &without), [plain]);
}

#[test]
fn a_source_condition_tells_a_local_ticket_from_one_an_external_tracker_owns() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap().reference;
    let source = |name: &str| {
        vec![Condition::Source {
            any_of: vec![name.into()],
        }]
    };
    let local = automation_on(&mut workspace, tag_added(), source("local"));
    let github = automation_on(&mut workspace, tag_added(), source("github"));

    workspace.add_tag(&ticket, TAG).unwrap();

    assert_eq!(started(&mut workspace, &local), [ticket]);
    assert_eq!(started(&mut workspace, &github), [] as [String; 0]);
}

#[test]
fn every_condition_must_hold_for_the_automation_to_start() {
    let (_dir, mut workspace) = workspace();
    let [both, one] =
        ["Both", "One"].map(|title| workspace.create_ticket(title).unwrap().reference);
    workspace.add_tag(&both, "bug").unwrap();
    workspace.add_tag(&one, "bug").unwrap();
    workspace.add_tag(&one, "wontfix").unwrap();
    let automation = automation_on(
        &mut workspace,
        tag_added(),
        vec![
            Condition::Source {
                any_of: vec!["local".into()],
            },
            Condition::Tag {
                tag: "bug".into(),
                has: true,
            },
            Condition::Tag {
                tag: "wontfix".into(),
                has: false,
            },
        ],
    );

    workspace.add_tag(&one, TAG).unwrap();
    workspace.add_tag(&both, TAG).unwrap();

    assert_eq!(started(&mut workspace, &automation), [both]);
}
