use ticketd_core::{Error, PlanActivityChange, Status, TicketPatch, Workspace};

#[test]
fn plan_activity_reads_the_latest_change_per_current_member_in_bounded_order() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let joined = workspace.create_ticket("New member").unwrap();
    let status = workspace.create_ticket("Reviewed work").unwrap();
    let update = workspace.create_ticket("Progress report").unwrap();
    let more = workspace.create_ticket("Another member").unwrap();
    let final_member = workspace.create_ticket("Final member").unwrap();
    let unrelated = workspace.create_ticket("Outside the Plan").unwrap();
    for ticket in [&final_member, &more, &joined, &status, &update, &unrelated] {
        workspace
            .set_plan(&ticket.reference, Some(&plan.id), Some("planner"))
            .unwrap();
    }
    workspace
        .set_plan(&unrelated.reference, None, None)
        .unwrap();
    workspace
        .change_ticket(
            &status.reference,
            TicketPatch {
                status: Some(Status::InReview),
                editing_agent: Some("reviewer".into()),
                ..Default::default()
            },
        )
        .unwrap();
    for _ in 0..8 {
        workspace
            .add_activity(&update.reference, "Earlier report.", None)
            .unwrap();
    }
    let newest = workspace
        .add_activity(&update.reference, "Verified the release.", Some("agent"))
        .unwrap();
    workspace
        .add_activity(&unrelated.reference, "Unrelated newer report.", None)
        .unwrap();

    let changes = workspace.latest_plan_activity(&plan.id, 5).unwrap();
    assert_eq!(changes.len(), 5);
    assert_eq!(changes[0].reference, update.reference);
    assert_eq!(changes[0].title, "Progress report");
    assert_eq!(changes[0].timestamp, newest.reported_at);
    assert_eq!(changes[0].editing_agent.as_deref(), Some("agent"));
    assert_eq!(
        changes[0].change,
        PlanActivityChange::Update {
            brief: "Verified the release.".into(),
        }
    );
    assert_eq!(changes[1].reference, status.reference);
    assert_eq!(changes[1].editing_agent.as_deref(), Some("reviewer"));
    assert_eq!(
        changes[1].change,
        PlanActivityChange::Status {
            from: Status::Todo,
            to: Status::InReview,
        }
    );
    assert_eq!(changes[2].reference, joined.reference);
    assert_eq!(changes[2].editing_agent.as_deref(), Some("planner"));
    assert_eq!(changes[2].change, PlanActivityChange::Joined);
    assert!(
        changes
            .windows(2)
            .all(|row| row[0].timestamp >= row[1].timestamp)
    );
    assert_eq!(
        workspace.latest_plan_activity(&plan.id, 2).unwrap(),
        changes[..2]
    );
    assert!(workspace.plan_activity(&plan.id, 0).unwrap().is_empty());
    assert!(matches!(
        workspace.plan_activity("missing", 5),
        Err(Error::PlanNotFound(_))
    ));
}

#[test]
fn plan_activity_can_read_multiple_changes_from_the_same_ticket() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let ticket = workspace
        .create_ticket_in_context("Member", None, Some(&plan.id))
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .add_activity(&ticket.reference, "Shipped.", None)
        .unwrap();

    let entries = workspace.plan_activity(&plan.id, 3).unwrap();
    assert_eq!(
        entries
            .into_iter()
            .map(|event| event.change)
            .collect::<Vec<_>>(),
        [
            PlanActivityChange::Update {
                brief: "Shipped.".into()
            },
            PlanActivityChange::Status {
                from: Status::Todo,
                to: Status::Done
            },
            PlanActivityChange::Joined,
        ]
    );
}
