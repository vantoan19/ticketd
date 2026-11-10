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
    assert_eq!(ticket.reference, "T-1");
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
        "T-2"
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
    assert_eq!(ticket.reference, "T-1");
    assert!(workspace.is_following(&ticket.reference).unwrap());
}
