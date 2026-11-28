use ticketd_core::{Error, Status, TicketPatch, Workspace};

#[test]
fn plan_files_groups_direct_attachments_from_current_members() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let mut member = |title, status| {
        let ticket = workspace.create_ticket(title).unwrap();
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    status: Some(status),
                    plan_id: Some(Some(plan.id.clone())),
                    ..Default::default()
                },
            )
            .unwrap()
    };
    let review = member("Check screenshots", Status::InReview);
    let done = member("Export results", Status::Done);
    let empty = member("No evidence", Status::Todo);
    let trashed = member("Discarded", Status::InProgress);
    let outside = workspace.create_ticket("Outside the Plan").unwrap();

    let screenshot = workspace
        .import_attachment_bytes("screenshot", "capture.png", b"screenshot", |_, _| true)
        .unwrap();
    let shared = workspace
        .import_attachment_bytes("shared", "report.txt", b"report", |_, _| true)
        .unwrap();
    let detached = workspace
        .import_attachment_bytes("detached", "unused.txt", b"unused", |_, _| true)
        .unwrap();
    for (ticket, file) in [
        (&review, &shared),
        (&review, &screenshot),
        (&done, &shared),
        (&empty, &detached),
        (&trashed, &screenshot),
        (&outside, &shared),
    ] {
        workspace
            .set_ticket_attachment(&ticket.reference, &file.id, true)
            .unwrap();
    }
    workspace
        .set_ticket_attachment(&empty.reference, &detached.id, false)
        .unwrap();
    workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();

    let groups = workspace.plan_files(&plan.id).unwrap();
    assert_eq!(groups.len(), 2);
    let group_for = |reference: &str| {
        groups
            .iter()
            .find(|group| group.reference == reference)
            .unwrap()
    };
    let review_files = group_for(&review.reference);
    assert_eq!(review_files.title, "Check screenshots");
    assert_eq!(review_files.status, Status::InReview);
    assert_eq!(review_files.files, [screenshot, shared.clone()]);
    assert_eq!(group_for(&done.reference).files, [shared]);

    workspace.change_plan(&plan.id, None, Some(true)).unwrap();
    assert_eq!(workspace.plan_files(&plan.id).unwrap(), groups);
    let empty_plan = workspace.create_plan("Empty").unwrap();
    assert!(workspace.plan_files(&empty_plan.id).unwrap().is_empty());
    assert!(matches!(
        workspace.plan_files("missing"),
        Err(Error::PlanNotFound(_))
    ));
}
