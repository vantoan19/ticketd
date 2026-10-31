use ticketd_core::{Status, TicketPatch, Workspace};

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
fn notes_can_be_paged_edited_and_deleted_after_reopening() {
    use ticketd_core::NotePatch;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Notes").unwrap();
    let first = workspace
        .add_note(&ticket.reference, "First\nline", Some("codex"))
        .unwrap();
    let second = workspace
        .add_note(&ticket.reference, "Second", None)
        .unwrap();
    let edited = workspace
        .edit_note(
            &ticket.reference,
            &first.id,
            NotePatch {
                content: Some("Revised".into()),
                editing_agent: None,
            },
        )
        .unwrap();
    assert_eq!(edited.editing_agent.as_deref(), Some("codex"));
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.notes(&ticket.reference, 1, 0).unwrap(),
        vec![edited]
    );
    assert_eq!(
        workspace.notes(&ticket.reference, 1, 1).unwrap(),
        vec![second.clone()]
    );
    workspace.delete_note(&ticket.reference, &first.id).unwrap();
    assert_eq!(
        workspace.notes(&ticket.reference, 10, 0).unwrap(),
        vec![second]
    );
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap().body, "");
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

#[test]
fn dependencies_derive_availability_and_keep_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let blocker = workspace.create_ticket("blocker").unwrap();
    let dependent = workspace.create_ticket("dependent").unwrap();
    workspace
        .add_dependency(&blocker.reference, &dependent.reference, None)
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&dependent.reference)
            .unwrap()
            .availability
            .as_deref(),
        Some("Blocked")
    );
    workspace
        .change_ticket(
            &blocker.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&dependent.reference)
            .unwrap()
            .availability
            .as_deref(),
        Some("Ready")
    );
    workspace
        .change_ticket(
            &blocker.reference,
            TicketPatch {
                status: Some(Status::Canceled),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&dependent.reference)
            .unwrap()
            .availability
            .as_deref(),
        Some("Blocked")
    );
    workspace
        .change_ticket(
            &blocker.reference,
            TicketPatch {
                status: Some(Status::InReview),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&dependent.reference)
            .unwrap()
            .availability
            .as_deref(),
        Some("Blocked")
    );
    workspace
        .change_ticket(
            &dependent.reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    let started = workspace.show_ticket(&dependent.reference).unwrap();
    assert_eq!(started.availability, None);
    assert_eq!(started.prerequisites[0].status, Status::InReview);
    assert!(
        workspace
            .add_dependency(&blocker.reference, &blocker.reference, None)
            .is_err()
    );
    workspace
        .add_dependency(&blocker.reference, &dependent.reference, None)
        .unwrap();
    assert!(
        workspace
            .add_dependency(&dependent.reference, &blocker.reference, None)
            .is_err()
    );
    workspace
        .remove_dependency(&blocker.reference, &dependent.reference, None)
        .unwrap();
    assert_eq!(
        workspace
            .ticket_history(&dependent.reference)
            .unwrap()
            .iter()
            .filter(|entry| entry.kind == "dependency")
            .count(),
        2
    );
}

#[test]
fn concurrent_opposing_dependencies_cannot_form_cycle() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let mut workspace = Workspace::open(&path).unwrap();
    let a = workspace.create_ticket("A").unwrap();
    let b = workspace.create_ticket("B").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [
        (a.reference.clone(), b.reference.clone()),
        (b.reference, a.reference),
    ]
    .into_iter()
    .map(|(blocker, dependent)| {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let mut workspace = Workspace::open(path).unwrap();
            barrier.wait();
            workspace.add_dependency(&blocker, &dependent, None).is_ok()
        })
    })
    .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|result| *result)
            .count(),
        1
    );
}

#[test]
fn hierarchy_rejects_grandchildren_and_records_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let a = workspace.create_ticket("A").unwrap();
    let b = workspace.create_ticket("B").unwrap();
    let c = workspace.create_ticket("C").unwrap();
    workspace
        .set_parent(&b.reference, Some(&a.reference), None)
        .unwrap();
    assert!(
        workspace
            .set_parent(&c.reference, Some(&b.reference), None)
            .is_err()
    );
    assert_eq!(
        workspace.show_ticket(&a.reference).unwrap().children[0].reference,
        b.reference
    );
    assert_eq!(
        workspace
            .show_ticket(&b.reference)
            .unwrap()
            .parent
            .unwrap()
            .reference,
        a.reference
    );
    workspace.set_parent(&b.reference, None, None).unwrap();
    assert_eq!(
        workspace
            .ticket_history(&b.reference)
            .unwrap()
            .iter()
            .filter(|entry| entry.kind == "parent")
            .count(),
        2
    );
}

#[test]
fn concurrent_hierarchy_assignments_preserve_one_level() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let mut workspace = Workspace::open(&path).unwrap();
    let a = workspace.create_ticket("A").unwrap();
    let b = workspace.create_ticket("B").unwrap();
    let c = workspace.create_ticket("C").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [
        (b.reference.clone(), a.reference),
        (c.reference, b.reference),
    ]
    .into_iter()
    .map(|(child, parent)| {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let mut workspace = Workspace::open(path).unwrap();
            barrier.wait();
            workspace.set_parent(&child, Some(&parent), None).is_ok()
        })
    })
    .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|result| *result)
            .count(),
        1
    );
}

#[test]
fn effort_membership_progress_and_archiving_preserve_tickets() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let effort = workspace.create_effort("Launch").unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    workspace
        .set_effort(&ticket.reference, Some(&effort.id), Some("agent"))
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    let view = workspace.show_effort(&effort.id).unwrap();
    assert_eq!(view.members.len(), 1);
    assert_eq!(view.counts.done, 1);
    workspace
        .change_effort(&effort.id, None, Some(true))
        .unwrap();
    assert!(workspace.list_efforts(false).unwrap().is_empty());
    workspace
        .change_effort(&effort.id, Some("Release"), Some(false))
        .unwrap();
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().status,
        Status::Done
    );
    workspace.set_effort(&ticket.reference, None, None).unwrap();
    let history = workspace.ticket_history(&ticket.reference).unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|entry| entry.kind == "effort")
            .count(),
        2
    );
    assert!(
        workspace
            .show_effort(&effort.id)
            .unwrap()
            .members
            .is_empty()
    );
}

#[test]
fn moving_effort_membership_is_atomic_and_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace.create_effort("First").unwrap();
    let second = workspace.create_effort("Second").unwrap();
    let ticket = workspace.create_ticket("Shared outcome").unwrap();
    workspace
        .set_effort(&ticket.reference, Some(&first.id), None)
        .unwrap();
    assert!(
        workspace
            .set_effort(&ticket.reference, Some("missing"), None)
            .is_err()
    );
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().effort_id,
        Some(first.id.clone())
    );
    workspace
        .set_effort(&ticket.reference, Some(&second.id), None)
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    assert!(workspace.show_effort(&first.id).unwrap().members.is_empty());
    assert_eq!(workspace.show_effort(&second.id).unwrap().members.len(), 1);
    let history = workspace.ticket_history(&ticket.reference).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].from_value, first.id);
    assert_eq!(history[1].to_value, second.id);
}

#[test]
fn project_membership_preserves_ticket_identity_and_records_changes() {
    use ticketd_core::TicketPatch;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let project = workspace.create_project("Alpha", "/repo/a").unwrap();
    let ticket = workspace.create_ticket("Outcome").unwrap();
    let linked = workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                project_id: Some(Some(project.id.clone())),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(linked.id, ticket.id);
    assert_eq!(linked.reference, ticket.reference);
    workspace
        .edit_project(&project.id, "Renamed", "/repo/b")
        .unwrap();
    assert_eq!(workspace.show_project(&project.id).unwrap().name, "Renamed");
    let cleared = workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                project_id: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(cleared.id, ticket.id);
    assert_eq!(cleared.project_id, None);
    let history = workspace.ticket_history(&ticket.reference).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].to_value, project.id);
    assert_eq!(history[1].to_value, "");
}

#[test]
fn project_patch_distinguishes_omitted_and_null() {
    use ticketd_core::TicketPatch;
    let omitted: TicketPatch = serde_json::from_str("{}").unwrap();
    let cleared: TicketPatch = serde_json::from_str(r#"{"project_id":null}"#).unwrap();
    let assigned: TicketPatch = serde_json::from_str(r#"{"project_id":"project-id"}"#).unwrap();
    assert_eq!(omitted.project_id, None);
    assert_eq!(cleared.project_id, Some(None));
    assert_eq!(assigned.project_id, Some(Some("project-id".into())));
}

#[test]
fn effort_patch_combines_membership_and_status_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Combined change").unwrap();
    assert!(
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    effort_id: Some(Some("missing".into())),
                    status: Some(Status::Done),
                    ..Default::default()
                }
            )
            .is_err()
    );
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().status,
        Status::Todo
    );
    assert!(
        workspace
            .ticket_history(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    let clear: TicketPatch = serde_json::from_str(r#"{"effort_id":null}"#).unwrap();
    assert_eq!(clear.effort_id, Some(None));
}

#[test]
fn checkout_context_is_local_and_ambiguous_matches_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    let nested = first.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let project = workspace
        .create_project("one", first.to_str().unwrap())
        .unwrap();
    workspace
        .register_checkout(&project.id, second.to_str().unwrap())
        .unwrap();
    assert_eq!(
        workspace.resolve_project(&nested).unwrap().unwrap().id,
        project.id
    );
    assert_eq!(
        workspace.resolve_project(&second).unwrap().unwrap().id,
        project.id
    );
    assert!(workspace.resolve_project(dir.path()).unwrap().is_none());
    let other = workspace
        .create_project("two", nested.to_str().unwrap())
        .unwrap();
    assert!(workspace.resolve_project(&nested).is_err());
    let ticket = workspace
        .create_ticket_in_project("override", Some(&other.id))
        .unwrap();
    assert_eq!(ticket.project_id.as_deref(), Some(other.id.as_str()));
    workspace
        .remove_checkout(&other.id, nested.to_str().unwrap())
        .unwrap();
    assert_eq!(
        workspace.resolve_project(&nested).unwrap().unwrap().id,
        project.id
    );
}

#[test]
fn dependency_graph_is_bounded_and_reports_direction_and_availability() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("graph.sqlite")).unwrap();
    let a = workspace.create_ticket("A").unwrap();
    let b = workspace.create_ticket("B").unwrap();
    let c = workspace.create_ticket("C").unwrap();
    let d = workspace.create_ticket("D").unwrap();
    workspace
        .add_dependency(&a.reference, &b.reference, None)
        .unwrap();
    workspace
        .add_dependency(&b.reference, &c.reference, None)
        .unwrap();
    workspace
        .add_dependency(&c.reference, &d.reference, None)
        .unwrap();
    let graph = workspace.dependency_graph(&a.reference).unwrap();
    assert_eq!(graph.nodes.len(), 3);
    assert!(graph.truncated);
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.blocker == a.reference && edge.dependent == b.reference)
    );
    assert_eq!(
        graph
            .nodes
            .iter()
            .find(|node| node.reference == b.reference)
            .unwrap()
            .availability
            .as_deref(),
        Some("Blocked")
    );
}
