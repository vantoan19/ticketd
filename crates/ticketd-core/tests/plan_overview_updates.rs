use ticketd_core::{
    EvidenceInput, EvidenceKind, Status, TicketPatch, Workspace, WorkspaceEventType,
};

#[test]
fn overview_reads_the_latest_briefs_for_the_plans_active_work() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let mut ticket_with_update = |title, status, member: bool| {
        let ticket = workspace.create_ticket(title).unwrap();
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    status: Some(status),
                    plan_id: member.then(|| Some(plan.id.clone())),
                    ..Default::default()
                },
            )
            .unwrap();
        workspace
            .add_activity(&ticket.reference, "First update.", None)
            .unwrap();
        workspace
            .add_activity(&ticket.reference, "Latest update. Second sentence.", None)
            .unwrap();
        ticket.reference
    };
    let review = ticket_with_update("Review", Status::InReview, true);
    let progress = ticket_with_update("Progress", Status::InProgress, true);
    ticket_with_update("Done work", Status::Done, true);
    ticket_with_update("Other Plan", Status::InProgress, false);

    let overview = workspace.show_plan_overview(&plan.id).unwrap();
    assert_eq!(overview.latest_updates.len(), 2);
    for reference in [review, progress] {
        assert_eq!(
            overview.latest_updates[&reference].brief.text,
            "Latest update. Second sentence."
        );
    }

    let ordinary_view = workspace.show_plan(&plan.id).unwrap();
    assert!(ordinary_view.latest_updates.is_empty());
    assert!(
        serde_json::to_value(ordinary_view)
            .unwrap()
            .get("latest_updates")
            .is_none()
    );
}

#[test]
fn overview_reads_the_current_status_entry_or_the_ticket_creation_time() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let untouched = workspace.create_ticket("Still Todo").unwrap();
    let created = workspace
        .workspace_events_after(0, 20)
        .unwrap()
        .into_iter()
        .find(|event| {
            event.ticket_id == untouched.id && event.kind == WorkspaceEventType::TicketCreated
        })
        .unwrap()
        .at;
    workspace
        .set_plan(&untouched.reference, Some(&plan.id), None)
        .unwrap();
    workspace
        .add_activity(&untouched.reference, "Updated the description.", None)
        .unwrap();

    let review = workspace
        .create_ticket_in_context("Review", None, Some(&plan.id))
        .unwrap();
    for status in [Status::InReview, Status::InProgress, Status::InReview] {
        workspace
            .change_ticket(
                &review.reference,
                TicketPatch {
                    status: Some(status),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    workspace
        .add_activity(&review.reference, "Revised the report.", None)
        .unwrap();
    let current = workspace
        .ticket_history(&review.reference)
        .unwrap()
        .into_iter()
        .rfind(|entry| entry.kind == "status")
        .unwrap();
    let overview = workspace.show_plan_overview(&plan.id).unwrap();
    assert_eq!(overview.status_since[&untouched.reference], created);
    assert_eq!(overview.status_since[&review.reference], current.timestamp);
    let ordinary = serde_json::to_value(workspace.show_plan(&plan.id).unwrap()).unwrap();
    assert!(ordinary.get("status_since").is_none());
}

#[test]
fn overview_uses_the_newest_pull_request_evidence_among_live_plan_members() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let first = workspace
        .create_ticket_in_context("First", None, Some(&plan.id))
        .unwrap();
    let second = workspace
        .create_ticket_in_context("Second", None, Some(&plan.id))
        .unwrap();
    let outside = workspace.create_ticket("Outside the Plan").unwrap();
    let trashed = workspace
        .create_ticket_in_context("Discarded", None, Some(&plan.id))
        .unwrap();
    let older = "https://github.com/example/app/pull/41";
    let latest = "https://github.com/example/app/pull/42";
    let mut add = |reference: &str, kind, value: &str| {
        workspace
            .add_evidence(
                reference,
                EvidenceInput {
                    kind,
                    name: "Implementation".into(),
                    value: value.into(),
                    editing_agent: None,
                },
            )
            .unwrap()
    };
    add(&second.reference, EvidenceKind::PullRequest, older);
    add(&first.reference, EvidenceKind::PullRequest, latest);
    add(&first.reference, EvidenceKind::Commit, "b8d2b7a");
    add(
        &outside.reference,
        EvidenceKind::PullRequest,
        "https://github.com/example/app/pull/43",
    );
    add(
        &trashed.reference,
        EvidenceKind::PullRequest,
        "https://github.com/example/app/pull/44",
    );
    workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();

    let overview = workspace.show_plan_overview(&plan.id).unwrap();
    assert_eq!(overview.pull_request.as_deref(), Some(latest));
    let ordinary = serde_json::to_value(workspace.show_plan(&plan.id).unwrap()).unwrap();
    assert!(ordinary.get("pull_request").is_none());
    let empty = workspace.create_plan("No pull request").unwrap();
    assert!(
        workspace
            .show_plan_overview(&empty.id)
            .unwrap()
            .pull_request
            .is_none()
    );
}
