use ticketd_core::{Error, Workspace, WriteRequest, WriteResult};

#[allow(clippy::expect_used)] // Reject a broken public request shape during test setup.
fn request(plan: Option<&str>, body: &str) -> WriteRequest {
    serde_json::from_value(serde_json::json!({
        "operation": "create_ticket_with_content",
        "title": "Complete creation",
        "body": body,
        "status": "In progress",
        "project_id": null,
        "plan_id": plan,
        "tags": ["qa"],
        "follow": true,
    }))
    .expect("the complete creation workflow must be replayable")
}

#[test]
fn completed_creation_replays_after_restart_without_duplicate_or_lost_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let plan = workspace.create_plan("Hardening").unwrap();
    let first = workspace
        .write(Some("submission"), request(Some(&plan.id), "Original body"))
        .unwrap();
    let WriteResult::Ticket(ticket) = &first else {
        panic!("expected a created ticket")
    };
    assert_eq!(ticket.reference, "T-KQ1");
    assert_eq!(ticket.body, "Original body");
    assert_eq!(ticket.tags, ["qa"]);
    assert_eq!(ticket.plan_id.as_deref(), Some(plan.id.as_str()));
    assert!(workspace.is_following(&ticket.reference).unwrap());
    drop(workspace);

    let mut reopened = Workspace::open(path).unwrap();
    assert_eq!(
        reopened
            .write(Some("submission"), request(Some(&plan.id), "Original body"))
            .unwrap(),
        first
    );
    assert!(matches!(
        reopened.write(Some("submission"), request(Some(&plan.id), "Changed body")),
        Err(Error::RequestConflict(_))
    ));
    assert_eq!(
        reopened
            .create_ticket("Next deliberate ticket")
            .unwrap()
            .reference,
        "T-KQ2"
    );
}

#[test]
fn failed_complete_creation_rolls_back_ticket_and_receipt_before_retry() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    assert!(
        workspace
            .write(Some("submission"), request(Some("missing-plan"), "Body"))
            .is_err()
    );
    let WriteResult::Ticket(ticket) = workspace
        .write(Some("submission"), request(None, "Body"))
        .unwrap()
    else {
        panic!("expected a created ticket")
    };
    assert_eq!(ticket.reference, "T-KQ1");
    assert!(workspace.is_following(&ticket.reference).unwrap());
}

#[test]
fn blockers_commit_with_creation_and_replay_but_invalid_blocker_rolls_everything_back() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let blocker = workspace.create_ticket("Prerequisite").unwrap();
    let head = workspace.workspace_event_head().unwrap();
    let with_blockers = |blockers: Vec<String>| {
        let mut value = serde_json::to_value(request(None, "Kept body")).unwrap();
        value["blockers"] = serde_json::json!(blockers);
        serde_json::from_value::<WriteRequest>(value).unwrap()
    };
    assert!(
        workspace
            .write(
                Some("atomic-create"),
                with_blockers(vec![blocker.reference.clone(), "T-KQ999".into()])
            )
            .is_err()
    );
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    assert_eq!(
        workspace.search_tags("qa", 10).unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(workspace.workspace_events_after(head, 100).unwrap(), []);
    assert!(matches!(
        workspace.is_following("T-KQ2"),
        Err(Error::NotFound(_))
    ));
    let operation = || with_blockers(vec![blocker.reference.clone()]);
    let result = workspace.write(Some("atomic-create"), operation()).unwrap();
    let WriteResult::Ticket(ticket) = &result else {
        panic!("expected created ticket")
    };
    assert_eq!(ticket.reference, "T-KQ2");
    assert_eq!(ticket.prerequisites[0].reference, blocker.reference);
    assert_eq!(ticket.tags, ["qa"]);
    assert_eq!(ticket.body, "Kept body");
    assert!(workspace.is_following(&ticket.reference).unwrap());
    let events = workspace.workspace_events_after(head, 100).unwrap();
    drop(workspace);
    let mut reopened = Workspace::open(path).unwrap();
    assert_eq!(
        reopened.write(Some("atomic-create"), operation()).unwrap(),
        result
    );
    assert_eq!(reopened.list_tickets().unwrap().len(), 2);
    assert_eq!(reopened.workspace_events_after(head, 100).unwrap(), events);
    assert!(matches!(
        reopened.write(Some("atomic-create"), with_blockers(vec![])),
        Err(Error::RequestConflict(_))
    ));
}

#[test]
fn legacy_creation_payload_keeps_its_serialized_shape_without_blockers() {
    let legacy = serde_json::to_value(request(None, "Body")).unwrap();
    assert!(legacy.get("blockers").is_none());
    let mut empty = legacy.clone();
    empty["blockers"] = serde_json::json!([]);
    let parsed: WriteRequest = serde_json::from_value(empty).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
}
