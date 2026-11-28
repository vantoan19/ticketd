use ticketd_core::{Status, TicketPatch, Workspace};

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
