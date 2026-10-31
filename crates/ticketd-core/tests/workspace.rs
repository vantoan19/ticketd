use ticketd_core::Workspace;

#[test]
fn ticket_survives_reopening_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("A useful outcome").unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    assert_eq!(workspace.list_tickets().unwrap(), vec![ticket]);
}

#[test]
fn status_changes_are_recorded_with_optional_agent() {
    use ticketd_core::Status;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Ship it").unwrap();
    workspace
        .change_status(&ticket.reference, Status::InReview, Some("codex"))
        .unwrap();
    workspace
        .change_status(&ticket.reference, Status::Canceled, None)
        .unwrap();
    let history = workspace.ticket_history(&ticket.reference).unwrap();
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().status,
        Status::Canceled
    );
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].from_value, "Todo");
    assert_eq!(history[0].to_value, "In review");
    assert_eq!(history[0].editing_agent.as_deref(), Some("codex"));
    assert_eq!(history[1].editing_agent, None);
    assert!(!history[0].timestamp.is_empty());
}
