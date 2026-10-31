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
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Revised".into()),
                body: None,
                ..Default::default()
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
fn status_changes_are_recorded_with_optional_agent() {
    use ticketd_core::{Status, TicketPatch};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Ship it").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::InReview),
                editing_agent: Some("codex".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Canceled),
                ..Default::default()
            },
        )
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

#[test]
fn version_one_workspace_upgrades_content_history_and_tags() {
    use ticketd_core::{Status, TicketPatch};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE tickets (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL); INSERT INTO tickets (id, title, status) VALUES ('old-id', 'Existing', 'Todo'); PRAGMA user_version = 1;").unwrap();
    drop(connection);
    let mut workspace = Workspace::open(&path).unwrap();
    workspace.add_tag("T-1", "Bug").unwrap();
    let updated = workspace
        .change_ticket(
            "T-1",
            TicketPatch {
                body: Some("Details".into()),
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.body, "Details");
    assert_eq!(updated.tags, vec!["bug"]);
    assert_eq!(workspace.ticket_history("T-1").unwrap().len(), 1);
    drop(workspace);
    let reopened = Workspace::open(&path).unwrap();
    assert_eq!(reopened.show_ticket("T-1").unwrap(), updated);
}
