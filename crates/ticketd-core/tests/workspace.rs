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
fn content_patch_preserves_omitted_fields_and_survives_restart() {
    use ticketd_core::TicketPatch;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Original").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: None,
                body: Some("First\n- [ ] item".into()),
            },
        )
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Revised".into()),
                body: None,
            },
        )
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    let saved = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(saved.title, "Revised");
    assert_eq!(saved.body, "First\n- [ ] item");
}

#[test]
fn tags_are_shared_and_independent_additions_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut first = Workspace::open(&path).unwrap();
    let ticket = first.create_ticket("Outcome").unwrap();
    let other = first.create_ticket("Another outcome").unwrap();
    let mut second = Workspace::open(&path).unwrap();
    first.add_tag(&ticket.reference, " Bug ").unwrap();
    second.add_tag(&ticket.reference, "research").unwrap();
    second.add_tag(&other.reference, "BUG").unwrap();
    first.add_tag(&ticket.reference, "bug").unwrap();
    assert_eq!(
        first.show_ticket(&ticket.reference).unwrap().tags,
        vec!["bug", "research"]
    );
    assert_eq!(
        first.show_ticket(&other.reference).unwrap().tags,
        vec!["bug"]
    );
    first.remove_tag(&ticket.reference, " BUG ").unwrap();
    assert_eq!(
        second
            .list_tickets()
            .unwrap()
            .iter()
            .find(|t| t.reference == ticket.reference)
            .unwrap()
            .tags,
        vec!["research"]
    );
}
