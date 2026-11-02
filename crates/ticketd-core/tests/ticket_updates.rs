use ticketd_core::{NotePatch, TicketFilter, TicketPatch, Workspace};

#[test]
fn list_and_detail_report_the_latest_authored_note_apart_from_other_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("updates.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Progress").unwrap();
    assert!(ticket.updated_at.is_some());
    assert!(ticket.latest_update.is_none());
    let first = workspace
        .add_note(&ticket.reference, "First report", Some("agent-one"))
        .unwrap();
    let latest = workspace
        .add_note(&ticket.reference, "Latest report", Some("agent-two"))
        .unwrap();
    workspace
        .edit_note(
            &ticket.reference,
            &first.id,
            NotePatch {
                content: Some("Edited the older note".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Changed title".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let shown = workspace.show_ticket(&ticket.reference).unwrap();
    let summary = shown.latest_update.as_ref().unwrap();
    assert_eq!(summary.note_id, latest.id);
    assert_eq!(summary.reported_at, latest.created_at);
    assert_eq!(summary.editing_agent.as_deref(), Some("agent-two"));
    let listed = workspace.find_tickets(&TicketFilter::default()).unwrap();
    assert_eq!(listed[0].latest_update, shown.latest_update);
    workspace
        .delete_note(&ticket.reference, &latest.id)
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&ticket.reference)
            .unwrap()
            .latest_update
            .unwrap()
            .note_id,
        first.id
    );
    assert_eq!(workspace.sidebar_counts().unwrap().total, 1);
}
