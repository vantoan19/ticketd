//! The ticket change: the same change made through each way in leaves the Workspace in the
//! same state, whichever entry point carried it. The one documented exception is leaving
//! Duplicate, which `change_ticket` answers by clearing the link and a batch (and so the
//! combined single-ticket change) answers by refusing.

use serde_json::{Value, json};
use ticketd_core::{
    BatchOperation, Error, Status, TicketChange, TicketPatch, Workspace, WriteRequest,
};

/// The tickets and Plan a scenario works on. References are issued in creation order, so
/// they match across Workspaces built the same way.
struct World {
    _dir: tempfile::TempDir,
    workspace: Workspace,
    /// The ticket the change is made to.
    subject: String,
    /// A ticket that is not in Trash and has no links.
    other: String,
    plan: String,
    project: String,
    event_cursor: i64,
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn world(prepare: impl FnOnce(&mut Workspace, &str, &str)) -> World {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let project = workspace
        .create_project("Website", dir.path().to_str().unwrap())
        .unwrap()
        .id;
    let plan = workspace.create_plan("Launch").unwrap().id;
    let subject = workspace.create_ticket("Subject").unwrap().reference;
    let other = workspace.create_ticket("Other").unwrap().reference;
    prepare(&mut workspace, &subject, &other);
    let event_cursor = workspace.workspace_event_head().unwrap();
    World {
        _dir: dir,
        workspace,
        subject,
        other,
        plan,
        project,
        event_cursor,
    }
}

/// Everything a change leaves behind, with the values that differ between Workspaces
/// (ids, times) replaced: the tickets, their history, their inbox entries and the
/// Workspace events the change logged.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn outcome(world: &World, tickets: &[&str]) -> Value {
    let workspace = &world.workspace;
    let mut shown = Vec::new();
    for reference in tickets {
        let ticket = serde_json::to_value(workspace.show_ticket(reference).unwrap()).unwrap();
        let history: Vec<Value> = workspace
            .ticket_history(reference)
            .unwrap()
            .into_iter()
            .map(|entry| {
                json!([
                    entry.kind,
                    entry.from_value,
                    entry.to_value,
                    entry.editing_agent
                ])
            })
            .collect();
        shown.push(json!({ "ticket": ticket, "history": history }));
    }
    let inbox: Vec<Value> = workspace
        .inbox(100, 0)
        .unwrap()
        .into_iter()
        .map(|entry| {
            json!([
                entry.reference,
                entry.kind,
                entry.from_value,
                entry.to_value,
                entry.editing_agent
            ])
        })
        .collect();
    let events: Vec<Value> = workspace
        .workspace_events_after(world.event_cursor, 100)
        .unwrap()
        .into_iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect();
    let mut value = json!({ "tickets": shown, "inbox": inbox, "events": events });
    normalize(&mut value);
    value
}

/// Ids are random and times are the database clock's: neither is part of what a change
/// means.
fn normalize(value: &mut Value) {
    match value {
        Value::String(text) => {
            if uuid::Uuid::parse_str(text).is_ok() {
                *text = "<id>".into();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize),
        Value::Object(fields) => {
            for key in ["at", "updated_at", "reported_at", "timestamp", "created_at"] {
                if fields.contains_key(key) {
                    fields.insert(key.into(), Value::Null);
                }
            }
            fields.values_mut().for_each(normalize);
        }
        _ => {}
    }
}

fn batch(reference: &str, change: TicketChange) -> Vec<BatchOperation> {
    vec![BatchOperation::Change {
        ticket: reference.into(),
        change: Box::new(change),
    }]
}

type Entry<'a> = (&'a str, Box<dyn Fn(&mut World) + 'a>);

/// Run `entries` each in a fresh world and require every one to leave the same outcome.
fn same_outcome_through_every_entry(
    prepare: impl Fn(&mut Workspace, &str, &str) + Copy,
    entries: Vec<Entry<'_>>,
) {
    let mut outcomes: Vec<(&str, Value)> = Vec::new();
    for (name, run) in &entries {
        let mut world = world(prepare);
        run(&mut world);
        let (subject, other) = (world.subject.clone(), world.other.clone());
        outcomes.push((name, outcome(&world, &[&subject, &other])));
    }
    let (first_name, first) = &outcomes[0];
    for (name, other) in &outcomes[1..] {
        assert_eq!(
            first, other,
            "{name} left a different state than {first_name}"
        );
    }
}

fn nothing(_: &mut Workspace, _: &str, _: &str) {}

#[test]
fn adding_a_tag_is_the_same_change_through_every_entry() {
    same_outcome_through_every_entry(
        nothing,
        vec![
            (
                "add_tag",
                Box::new(|w| {
                    w.workspace.add_tag(&w.subject, "Urgent").unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        add_tags: vec!["Urgent".into()],
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "apply_batch",
                Box::new(|w| {
                    let change = TicketChange {
                        add_tags: vec!["Urgent".into()],
                        ..Default::default()
                    };
                    w.workspace.apply_batch(batch(&w.subject, change)).unwrap();
                }),
            ),
            (
                "write(AddTag)",
                Box::new(|w| {
                    let request = WriteRequest::AddTag {
                        reference: w.subject.clone(),
                        name: "Urgent".into(),
                        agent: None,
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
            (
                "write(TicketChange)",
                Box::new(|w| {
                    let request = WriteRequest::TicketChange {
                        reference: w.subject.clone(),
                        change: TicketChange {
                            add_tags: vec!["Urgent".into()],
                            ..Default::default()
                        },
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn removing_a_tag_is_the_same_change_through_every_entry() {
    let tagged = |workspace: &mut Workspace, subject: &str, _: &str| {
        workspace.add_tag(subject, "urgent").unwrap();
        workspace.add_tag(subject, "later").unwrap();
    };
    same_outcome_through_every_entry(
        tagged,
        vec![
            (
                "remove_tag",
                Box::new(|w| {
                    w.workspace.remove_tag(&w.subject, "urgent").unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        remove_tags: vec!["urgent".into()],
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "apply_batch",
                Box::new(|w| {
                    let change = TicketChange {
                        remove_tags: vec!["urgent".into()],
                        ..Default::default()
                    };
                    w.workspace.apply_batch(batch(&w.subject, change)).unwrap();
                }),
            ),
            (
                "write(RemoveTag)",
                Box::new(|w| {
                    let request = WriteRequest::RemoveTag {
                        reference: w.subject.clone(),
                        name: "urgent".into(),
                        agent: None,
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn setting_a_parent_is_the_same_change_through_every_entry() {
    same_outcome_through_every_entry(
        nothing,
        vec![
            (
                "set_parent",
                Box::new(|w| {
                    w.workspace
                        .set_parent(&w.subject, Some(&w.other), Some("agent"))
                        .unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        parent: Some(Some(w.other.clone())),
                        patch: TicketPatch {
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "apply_batch",
                Box::new(|w| {
                    let change = TicketChange {
                        parent: Some(Some(w.other.clone())),
                        patch: TicketPatch {
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_batch(batch(&w.subject, change)).unwrap();
                }),
            ),
            (
                "write(SetParent)",
                Box::new(|w| {
                    let request = WriteRequest::SetParent {
                        child: w.subject.clone(),
                        parent: Some(w.other.clone()),
                        agent: Some("agent".into()),
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn clearing_a_parent_is_the_same_change_through_every_entry() {
    let parented = |workspace: &mut Workspace, subject: &str, other: &str| {
        workspace.set_parent(subject, Some(other), None).unwrap();
    };
    same_outcome_through_every_entry(
        parented,
        vec![
            (
                "set_parent",
                Box::new(|w| {
                    w.workspace.set_parent(&w.subject, None, None).unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        parent: Some(None),
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "write(SetParent)",
                Box::new(|w| {
                    let request = WriteRequest::SetParent {
                        child: w.subject.clone(),
                        parent: None,
                        agent: None,
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn adding_a_blocker_is_the_same_change_through_every_entry() {
    same_outcome_through_every_entry(
        nothing,
        vec![
            (
                "add_dependency",
                Box::new(|w| {
                    w.workspace
                        .add_dependency(&w.other, &w.subject, Some("agent"))
                        .unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        add_blockers: vec![w.other.clone()],
                        patch: TicketPatch {
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "apply_batch",
                Box::new(|w| {
                    let change = TicketChange {
                        add_blockers: vec![w.other.clone()],
                        patch: TicketPatch {
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_batch(batch(&w.subject, change)).unwrap();
                }),
            ),
            (
                "write(AddDependency)",
                Box::new(|w| {
                    let request = WriteRequest::AddDependency {
                        blocker: w.other.clone(),
                        dependent: w.subject.clone(),
                        agent: Some("agent".into()),
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn removing_a_blocker_is_the_same_change_through_every_entry() {
    let blocked = |workspace: &mut Workspace, subject: &str, other: &str| {
        workspace.add_dependency(other, subject, None).unwrap();
    };
    same_outcome_through_every_entry(
        blocked,
        vec![
            (
                "remove_dependency",
                Box::new(|w| {
                    w.workspace
                        .remove_dependency(&w.other, &w.subject, None)
                        .unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        remove_blockers: vec![w.other.clone()],
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "write(RemoveDependency)",
                Box::new(|w| {
                    let request = WriteRequest::RemoveDependency {
                        blocker: w.other.clone(),
                        dependent: w.subject.clone(),
                        agent: None,
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn moving_into_a_plan_is_the_same_change_through_every_entry() {
    same_outcome_through_every_entry(
        nothing,
        vec![
            (
                "set_plan",
                Box::new(|w| {
                    w.workspace
                        .set_plan(&w.subject, Some(&w.plan), Some("agent"))
                        .unwrap();
                }),
            ),
            (
                "change_ticket",
                Box::new(|w| {
                    let patch = TicketPatch {
                        plan_id: Some(Some(w.plan.clone())),
                        editing_agent: Some("agent".into()),
                        ..Default::default()
                    };
                    w.workspace.change_ticket(&w.subject, patch).unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        patch: TicketPatch {
                            plan_id: Some(Some(w.plan.clone())),
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "apply_batch",
                Box::new(|w| {
                    let change = TicketChange {
                        patch: TicketPatch {
                            plan_id: Some(Some(w.plan.clone())),
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_batch(batch(&w.subject, change)).unwrap();
                }),
            ),
            (
                "write(SetPlan)",
                Box::new(|w| {
                    let request = WriteRequest::SetPlan {
                        reference: w.subject.clone(),
                        plan: Some(w.plan.clone()),
                        agent: Some("agent".into()),
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
            (
                "write(ChangeTicket)",
                Box::new(|w| {
                    let request = WriteRequest::ChangeTicket {
                        reference: w.subject.clone(),
                        patch: TicketPatch {
                            plan_id: Some(Some(w.plan.clone())),
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn editing_content_and_status_is_the_same_change_through_every_entry() {
    fn patch() -> TicketPatch {
        TicketPatch {
            title: Some("Renamed".into()),
            body: Some("A new body".into()),
            status: Some(Status::InProgress),
            editing_agent: Some("agent".into()),
            ..Default::default()
        }
    }
    same_outcome_through_every_entry(
        nothing,
        vec![
            (
                "change_ticket",
                Box::new(|w| {
                    w.workspace.change_ticket(&w.subject, patch()).unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        patch: patch(),
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "apply_batch",
                Box::new(|w| {
                    let change = TicketChange {
                        patch: patch(),
                        ..Default::default()
                    };
                    w.workspace.apply_batch(batch(&w.subject, change)).unwrap();
                }),
            ),
            (
                "write(ChangeTicket)",
                Box::new(|w| {
                    let request = WriteRequest::ChangeTicket {
                        reference: w.subject.clone(),
                        patch: patch(),
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
            (
                "write(TicketChange)",
                Box::new(|w| {
                    let request = WriteRequest::TicketChange {
                        reference: w.subject.clone(),
                        change: TicketChange {
                            patch: patch(),
                            ..Default::default()
                        },
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn posting_an_update_is_the_same_change_through_every_entry() {
    same_outcome_through_every_entry(
        nothing,
        vec![
            (
                "add_activity",
                Box::new(|w| {
                    w.workspace
                        .add_activity(&w.subject, "Started", Some("agent"))
                        .unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        activities: vec!["Started".into()],
                        patch: TicketPatch {
                            editing_agent: Some("agent".into()),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
            (
                "write(AddActivity)",
                Box::new(|w| {
                    let request = WriteRequest::AddActivity {
                        reference: w.subject.clone(),
                        brief: "Started".into(),
                        agent: Some("agent".into()),
                    };
                    w.workspace.write(Some("r1"), request).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn creating_a_ticket_is_the_same_change_through_every_entry() {
    let created = |world: &World, reference: String| outcome(world, &[&reference]);
    let mut outcomes = Vec::new();
    let mut world_one = world(nothing);
    let reference = world_one
        .workspace
        .create_ticket_in_context("Fresh", Some(&world_one.project), Some(&world_one.plan))
        .unwrap()
        .reference;
    outcomes.push(("create_ticket_in_context", created(&world_one, reference)));

    let mut world_two = world(nothing);
    let operations = vec![
        BatchOperation::Create {
            name: "new".into(),
            title: "Fresh".into(),
            project_id: Some(world_two.project.clone()),
        },
        BatchOperation::Change {
            ticket: "$new".into(),
            change: Box::new(TicketChange {
                patch: TicketPatch {
                    plan_id: Some(Some(world_two.plan.clone())),
                    ..Default::default()
                },
                ..Default::default()
            }),
        },
    ];
    let reference = world_two
        .workspace
        .apply_batch(operations)
        .unwrap()
        .pop()
        .unwrap()
        .reference;
    outcomes.push(("apply_batch", created(&world_two, reference)));

    let mut world_three = world(nothing);
    let request = WriteRequest::CreateTicketWithContent {
        title: "Fresh".into(),
        body: String::new(),
        status: Status::Todo,
        project_id: Some(world_three.project.clone()),
        plan_id: Some(world_three.plan.clone()),
        tags: Vec::new(),
        follow: false,
        blockers: Vec::new(),
    };
    let reference = match world_three.workspace.write(Some("r1"), request).unwrap() {
        ticketd_core::WriteResult::Ticket(ticket) => ticket.reference,
        other => panic!("unexpected result {other:?}"),
    };
    outcomes.push((
        "write(CreateTicketWithContent)",
        created(&world_three, reference),
    ));

    for (name, other) in &outcomes[1..] {
        assert_eq!(
            outcomes[0].1, *other,
            "{name} left a different state than {}",
            outcomes[0].0
        );
    }
}

/// A ticket that duplicates `other`.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn duplicate(workspace: &mut Workspace, subject: &str, other: &str) {
    workspace.mark_duplicate(subject, other, None).unwrap();
}

#[test]
fn leaving_duplicate_clears_the_link_through_change_ticket_and_is_refused_through_a_batch() {
    let leave = || TicketPatch {
        status: Some(Status::Todo),
        ..Default::default()
    };

    let mut direct = world(duplicate);
    let ticket = direct
        .workspace
        .change_ticket(&direct.subject, leave())
        .unwrap();
    assert_eq!(ticket.status, Status::Todo);
    assert_eq!(ticket.duplicate_of, None);

    let mut requested = world(duplicate);
    let request = WriteRequest::ChangeTicket {
        reference: requested.subject.clone(),
        patch: leave(),
    };
    requested.workspace.write(Some("r1"), request).unwrap();
    assert_eq!(
        outcome(&direct, &[&direct.subject, &direct.other]),
        outcome(&requested, &[&requested.subject, &requested.other]),
        "the request leaves the same state as the method"
    );

    // The combined single-ticket change is a one-operation batch and refuses like one.
    let mut combined = world(duplicate);
    let before = outcome(&combined, &[&combined.subject, &combined.other]);
    let change = TicketChange {
        patch: leave(),
        ..Default::default()
    };
    let error = combined
        .workspace
        .apply_ticket_change(&combined.subject, change)
        .unwrap_err();
    assert!(
        matches!(&error, Error::BatchOperation { index: 0, source }
            if matches!(**source, Error::InvalidBatch(_))),
        "{error:?}"
    );
    assert_eq!(
        before,
        outcome(&combined, &[&combined.subject, &combined.other]),
        "a refused change leaves nothing behind"
    );
    let shown = combined.workspace.show_ticket(&combined.subject).unwrap();
    assert_eq!(shown.status, Status::Duplicate);
    assert_eq!(shown.duplicate_of.as_deref(), Some(combined.other.as_str()));

    let mut batched = world(duplicate);
    let change = TicketChange {
        patch: leave(),
        ..Default::default()
    };
    let error = batched
        .workspace
        .apply_batch(batch(&batched.subject, change))
        .unwrap_err();
    assert!(
        matches!(error, Error::BatchOperation { index: 0, .. }),
        "{error:?}"
    );

    let mut replayed = world(duplicate);
    let request = WriteRequest::TicketChange {
        reference: replayed.subject.clone(),
        change: TicketChange {
            patch: leave(),
            ..Default::default()
        },
    };
    assert!(replayed.workspace.write(Some("r1"), request).is_err());
}

#[test]
fn a_change_that_does_not_leave_duplicate_is_allowed_on_a_duplicate_through_every_entry() {
    same_outcome_through_every_entry(
        duplicate,
        vec![
            (
                "add_tag",
                Box::new(|w| {
                    w.workspace.add_tag(&w.subject, "later").unwrap();
                }),
            ),
            (
                "apply_ticket_change",
                Box::new(|w| {
                    let change = TicketChange {
                        add_tags: vec!["later".into()],
                        patch: TicketPatch {
                            status: Some(Status::Duplicate),
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    w.workspace.apply_ticket_change(&w.subject, change).unwrap();
                }),
            ),
        ],
    );
}

#[test]
fn entering_duplicate_needs_a_canonical_ticket_through_every_entry() {
    let enter = || TicketPatch {
        status: Some(Status::Duplicate),
        ..Default::default()
    };
    let mut direct = world(nothing);
    let error = direct
        .workspace
        .change_ticket(&direct.subject, enter())
        .unwrap_err();
    assert!(matches!(error, Error::DuplicateNeedsCanonical), "{error:?}");

    let mut batched = world(nothing);
    let change = TicketChange {
        patch: enter(),
        ..Default::default()
    };
    let error = batched
        .workspace
        .apply_batch(batch(&batched.subject, change))
        .unwrap_err();
    assert!(
        matches!(&error, Error::BatchOperation { source, .. }
            if matches!(**source, Error::DuplicateNeedsCanonical)),
        "{error:?}"
    );
}

#[test]
fn archived_projects_refuse_new_assignments_and_roll_back_the_batch() {
    let mut world = world(|_, _, _| {});
    let workspace = &mut world.workspace;
    let patch = TicketPatch {
        project_id: Some(Some(world.project.clone())),
        ..Default::default()
    };
    workspace
        .change_ticket(&world.subject, patch.clone())
        .unwrap();
    workspace
        .set_project_archived(&world.project, true)
        .unwrap();

    assert!(matches!(
        workspace.create_ticket_in_project("Refused", Some(&world.project)),
        Err(Error::ProjectArchived(name)) if name == "Website"
    ));
    assert!(matches!(
        workspace.change_ticket(&world.other, patch.clone()),
        Err(Error::ProjectArchived(_))
    ));
    let change = TicketChange {
        patch: patch.clone(),
        ..Default::default()
    };
    assert!(matches!(
        workspace.apply_ticket_change(&world.other, change.clone()),
        Err(Error::BatchOperation { index: 0, source }) if matches!(*source, Error::ProjectArchived(_))
    ));
    assert!(matches!(
        workspace.apply_batch(vec![
            BatchOperation::Create {
                name: "first".into(),
                title: "Rolled back".into(),
                project_id: None,
            },
            BatchOperation::Change {
                ticket: world.other.clone(),
                change: Box::new(change),
            },
        ]),
        Err(Error::BatchOperation { index: 1, source }) if matches!(*source, Error::ProjectArchived(_))
    ));
    assert_eq!(workspace.active_tickets(10).unwrap().len(), 2);
    assert!(
        workspace
            .show_ticket(&world.other)
            .unwrap()
            .project_id
            .is_none()
    );

    let updated = workspace
        .change_ticket(
            &world.subject,
            TicketPatch {
                title: Some("Still editable".into()),
                ..patch
            },
        )
        .unwrap();
    assert_eq!(updated.title, "Still editable");
    assert_eq!(updated.project_id.as_deref(), Some(world.project.as_str()));
    assert!(
        workspace
            .change_ticket(
                &world.subject,
                TicketPatch {
                    project_id: Some(None),
                    ..Default::default()
                },
            )
            .unwrap()
            .project_id
            .is_none()
    );
}
