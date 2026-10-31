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
