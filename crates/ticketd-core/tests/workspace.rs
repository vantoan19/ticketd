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
fn trash_preserves_relationships_and_requires_restoration_for_edits() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let parent = w.create_ticket("Parent").unwrap();
    let child = w.create_ticket("Child").unwrap();
    w.set_parent(&child.reference, Some(&parent.reference), None)
        .unwrap();
    w.add_dependency(&parent.reference, &child.reference, None)
        .unwrap();
    w.set_trashed(&parent.reference, true, None).unwrap();
    assert_eq!(w.list_tickets().unwrap().len(), 1);
    assert_eq!(w.list_trash().unwrap()[0].id, parent.id);
    let visible = w.show_ticket(&child.reference).unwrap();
    assert!(visible.parent.unwrap().trashed);
    assert!(visible.prerequisites[0].trashed);
    assert_eq!(visible.availability.as_deref(), Some("Blocked"));
    assert!(
        w.change_ticket(&parent.reference, TicketPatch::default())
            .is_err()
    );
    assert!(w.add_note(&parent.reference, "note", None).is_err());
    assert!(
        w.add_dependency(&child.reference, &parent.reference, None)
            .is_err()
    );
    w.set_trashed(&parent.reference, false, None).unwrap();
    w.change_ticket(
        &parent.reference,
        TicketPatch {
            status: Some(Status::Done),
            ..Default::default()
        },
    )
    .unwrap();
    w.set_trashed(&parent.reference, true, None).unwrap();
    assert_eq!(
        w.show_ticket(&child.reference)
            .unwrap()
            .availability
            .as_deref(),
        Some("Ready")
    );
    w.remove_dependency(&parent.reference, &child.reference, None)
        .unwrap();
    w.set_parent(&child.reference, None, None).unwrap();
    assert_eq!(
        w.ticket_history(&parent.reference)
            .unwrap()
            .iter()
            .filter(|h| h.kind == "trash")
            .count(),
        3
    );
}

#[test]
fn visible_parent_can_detach_trashed_child() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let parent = w.create_ticket("Parent").unwrap();
    let child = w.create_ticket("Child").unwrap();
    w.set_parent(&child.reference, Some(&parent.reference), None)
        .unwrap();
    w.set_trashed(&child.reference, true, None).unwrap();
    assert!(
        w.set_parent(&child.reference, Some(&parent.reference), None)
            .is_err()
    );
    w.set_trashed(&parent.reference, true, None).unwrap();
    assert!(w.set_parent(&child.reference, None, None).is_err());
    w.set_trashed(&parent.reference, false, None).unwrap();
    w.detach_child(&parent.reference, &child.reference, None)
        .unwrap();
    let restored = w.set_trashed(&child.reference, false, None).unwrap();
    assert_eq!(restored.id, child.id);
    assert!(restored.parent.is_none());
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

#[test]
fn batch_creates_linked_tickets_and_rolls_back_late_failure() {
    use ticketd_core::BatchOperation;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("batch.sqlite")).unwrap();
    let operations: Vec<BatchOperation> = serde_json::from_value(serde_json::json!([
        {"operation":"create", "name":"parent", "title":"Parent"},
        {"operation":"create", "name":"child", "title":"Child"},
        {"operation":"change", "ticket":"$child", "change":{"parent":"$parent", "add_blockers":["$parent"], "add_tags":["Feature"], "notes":["Started"]}}
    ])).unwrap();
    let results = workspace.apply_batch(operations).unwrap();
    let child = workspace.show_ticket(&results[1].reference).unwrap();
    assert_eq!(child.parent.unwrap().reference, results[0].reference);
    assert_eq!(child.prerequisites[0].reference, results[0].reference);
    assert_eq!(child.tags, ["feature"]);
    assert_eq!(workspace.notes(&child.reference, 10, 0).unwrap().len(), 1);
    let history_before = workspace.ticket_history(&child.reference).unwrap();
    let operations: Vec<BatchOperation> = serde_json::from_value(serde_json::json!([
        {"operation":"create", "name":"temporary", "title":"Rolled back"},
        {"operation":"change", "ticket":child.reference, "change":{"status":"Done", "notes":["rolled back"]}},
        {"operation":"change", "ticket":results[0].reference, "change":{"add_blockers":[child.reference]}}
    ])).unwrap();
    let error = workspace.apply_batch(operations).unwrap_err().to_string();
    assert!(error.contains("operation 2"));
    assert_eq!(workspace.list_tickets().unwrap().len(), 2);
    assert_eq!(
        workspace.show_ticket(&child.reference).unwrap().status,
        ticketd_core::Status::Todo
    );
    assert_eq!(workspace.notes(&child.reference, 10, 0).unwrap().len(), 1);
    assert_eq!(
        workspace.ticket_history(&child.reference).unwrap(),
        history_before
    );
}

#[test]
fn context_is_bounded_and_reports_related_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let ticket = ws.create_ticket("Main").unwrap();
    let blocker = ws.create_ticket("Blocker").unwrap();
    ws.add_dependency(&blocker.reference, &ticket.reference, None)
        .unwrap();
    ws.set_trashed(&blocker.reference, true, None).unwrap();
    ws.change_ticket(
        &ticket.reference,
        TicketPatch {
            body: Some("x".repeat(5000)),
            ..Default::default()
        },
    )
    .unwrap();
    ws.add_note(&ticket.reference, "Finding", None).unwrap();
    let context = ws
        .ticket_context(
            &ticket.reference,
            ticketd_core::ContextOptions {
                relationships: true,
                notes: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(context.ticket.body.truncated);
    assert_eq!(context.ticket.body.text.len(), 4096);
    let relationships = context.relationships.unwrap();
    assert_eq!(
        relationships.prerequisites.items[0].reference,
        blocker.reference
    );
    assert!(relationships.prerequisites.items[0].trashed);
    assert!(relationships.prerequisites.items[0].unresolved);
    assert_eq!(context.notes.unwrap().items[0].content.text, "Finding");
    assert_eq!(context.ticket.availability.as_deref(), Some("Blocked"));
}

#[test]
fn context_reads_one_snapshot_during_atomic_changes() {
    use ticketd_core::{BatchOperation, ContextOptions, TicketChange};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let mut writer = Workspace::open(&path).unwrap();
    let ticket = writer.create_ticket("old").unwrap();
    let reader = Workspace::open(&path).unwrap();
    let reference = ticket.reference.clone();
    let handle = std::thread::spawn(move || {
        for i in 0..40 {
            let value = if i % 2 == 0 { "new" } else { "old" };
            writer
                .apply_batch(vec![BatchOperation::Change {
                    ticket: reference.clone(),
                    change: Box::new(TicketChange {
                        patch: TicketPatch {
                            title: Some(value.into()),
                            ..Default::default()
                        },
                        add_tags: if value == "new" {
                            vec!["new".into()]
                        } else {
                            vec![]
                        },
                        remove_tags: if value == "old" {
                            vec!["new".into()]
                        } else {
                            vec![]
                        },
                        ..Default::default()
                    }),
                }])
                .unwrap();
        }
    });
    for _ in 0..40 {
        let result = reader
            .ticket_context(&ticket.reference, ContextOptions::default())
            .unwrap();
        assert_eq!(
            result.ticket.title.text == "new",
            !result.ticket.tags.items.is_empty()
        );
    }
    handle.join().unwrap();
}

#[test]
fn request_retry_returns_original_ticket_and_rejects_changed_content() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("db")).unwrap();
    let request = || WriteRequest::CreateTicket {
        title: "Original".into(),
        project_id: None,
    };
    let first = workspace.write(Some("request-1"), request()).unwrap();
    let WriteResult::Ticket(ticket) = &first else {
        panic!("expected ticket")
    };
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Changed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        workspace.write(Some("request-1"), request()).unwrap(),
        first
    );
    assert!(
        workspace
            .write(
                Some("request-1"),
                WriteRequest::CreateTicket {
                    title: "Different".into(),
                    project_id: None
                }
            )
            .is_err()
    );
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
}

#[test]
fn concurrent_duplicate_batch_is_applied_once() {
    use std::sync::{Arc, Barrier};
    use ticketd_core::{BatchOperation, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    Workspace::open(&path).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut workspace = Workspace::open(path).unwrap();
                barrier.wait();
                workspace
                    .write(
                        Some("batch-1"),
                        WriteRequest::Batch {
                            operations: vec![BatchOperation::Create {
                                name: "a".into(),
                                title: "Once".into(),
                                project_id: None,
                            }],
                        },
                    )
                    .unwrap()
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results[0], results[1]);
    assert_eq!(
        Workspace::open(path).unwrap().list_tickets().unwrap().len(),
        1
    );
}

#[test]
fn failed_request_id_can_be_reused_and_clearing_is_distinct_from_omission() {
    use ticketd_core::WriteRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("db")).unwrap();
    assert!(
        workspace
            .write(
                Some("retry"),
                WriteRequest::CreateTicket {
                    title: " ".into(),
                    project_id: None
                }
            )
            .is_err()
    );
    workspace
        .write(
            Some("retry"),
            WriteRequest::CreateTicket {
                title: "Valid".into(),
                project_id: None,
            },
        )
        .unwrap();
    workspace
        .write(
            Some("patch"),
            WriteRequest::ChangeTicket {
                reference: "T-1".into(),
                patch: TicketPatch::default(),
            },
        )
        .unwrap();
    assert!(
        workspace
            .write(
                Some("patch"),
                WriteRequest::ChangeTicket {
                    reference: "T-1".into(),
                    patch: TicketPatch {
                        project_id: Some(None),
                        ..Default::default()
                    }
                }
            )
            .is_err()
    );
}

#[test]
fn search_tracks_note_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let ticket = workspace.create_ticket("Example").unwrap();
    let note = workspace
        .add_note(&ticket.reference, "A [literal] finding", None)
        .unwrap();
    assert_eq!(
        workspace
            .search_tickets("[literal]", None, false, 50, 0)
            .unwrap()
            .len(),
        1
    );
    workspace.delete_note(&ticket.reference, &note.id).unwrap();
    assert!(
        workspace
            .search_tickets("[literal]", None, false, 50, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn export_preserves_workspace_relationships_and_trash() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let project = workspace
        .create_project("Project", dir.path().to_str().unwrap())
        .unwrap();
    let effort = workspace.create_effort("Effort").unwrap();
    let parent = workspace
        .create_ticket_in_project("Parent", Some(&project.id))
        .unwrap();
    let child = workspace.create_ticket("Child").unwrap();
    workspace
        .set_effort(&child.reference, Some(&effort.id), None)
        .unwrap();
    workspace
        .set_parent(&child.reference, Some(&parent.reference), None)
        .unwrap();
    workspace
        .add_dependency(&parent.reference, &child.reference, None)
        .unwrap();
    workspace.add_tag(&child.reference, "urgent").unwrap();
    let note = workspace
        .add_note(&child.reference, "Finding", Some("agent"))
        .unwrap();
    workspace
        .set_trashed(&parent.reference, true, None)
        .unwrap();
    let export = workspace.export().unwrap();
    assert_eq!(export["format_version"], 1);
    assert_eq!(export["projects"][0]["id"], project.id);
    assert_eq!(export["project_checkouts"][0]["project_id"], project.id);
    assert_eq!(export["efforts"][0]["id"], effort.id);
    assert_eq!(export["tickets"][0]["id"], parent.id);
    assert_eq!(export["tickets"][0]["trashed"], 1);
    assert_eq!(export["tickets"][1]["effort_id"], effort.id);
    assert_eq!(export["notes"][0]["id"], note.id);
    assert_eq!(export["notes"][0]["ticket_id"], child.id);
    assert_eq!(export["ticket_parents"][0]["parent_id"], parent.id);
    assert_eq!(export["dependencies"][0]["dependent_id"], child.id);
    assert_eq!(export["ticket_tags"][0]["tag_name"], "urgent");
    assert!(!export["ticket_history"].as_array().unwrap().is_empty());
}

#[test]
fn export_file_does_not_replace_an_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let path = dir.path().join("export.json");
    std::fs::write(&path, "existing").unwrap();
    assert!(workspace.export_file(&path).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "existing");
}

#[test]
fn combined_filters_search_flat_family_with_all_tags_and_paging() {
    use ticketd_core::{Availability, TicketFilter};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let parent = w.create_ticket("Family needle").unwrap();
    let child = w.create_ticket("Child needle").unwrap();
    w.set_parent(&child.reference, Some(&parent.reference), None)
        .unwrap();
    for ticket in [&parent, &child] {
        w.add_tag(&ticket.reference, "bug").unwrap();
        w.add_tag(&ticket.reference, "urgent").unwrap();
    }
    let other = w.create_ticket("Other needle").unwrap();
    w.add_tag(&other.reference, "bug").unwrap();
    let filter = TicketFilter {
        query: "needle".into(),
        tags: vec!["BUG".into(), "urgent".into()],
        family: Some(parent.reference.clone()),
        availability: Some(Availability::Ready),
        limit: 1,
        ..Default::default()
    };
    assert_eq!(
        w.find_tickets(&filter).unwrap()[0].reference,
        child.reference
    );
    let filter = TicketFilter {
        offset: 1,
        ..filter
    };
    assert_eq!(
        w.find_tickets(&filter).unwrap()[0].reference,
        parent.reference
    );
}

#[test]
fn combined_filters_apply_project_effort_status_and_blocked_before_paging() {
    use ticketd_core::{Availability, TicketFilter};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let effort = w.create_effort("Release").unwrap();
    let blocker = w.create_ticket("Prerequisite").unwrap();
    let blocked = w.create_ticket("Ship release").unwrap();
    w.set_effort(&blocked.reference, Some(&effort.id), None)
        .unwrap();
    w.add_dependency(&blocker.reference, &blocked.reference, None)
        .unwrap();
    w.create_ticket("Newer unrelated ticket").unwrap();
    let filter = TicketFilter {
        query: "release".into(),
        unlinked: true,
        effort: Some(effort.id),
        status: Some(Status::Todo),
        availability: Some(Availability::Blocked),
        limit: 1,
        ..Default::default()
    };
    let results = w.find_tickets(&filter).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].reference, blocked.reference);
}

#[test]
fn backup_restores_trash_relationships_and_request_replay() {
    use ticketd_core::WriteRequest;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let backup = dir.path().join("backup.db");
    let mut w = Workspace::open(&path).unwrap();
    let request = || WriteRequest::CreateTicket {
        title: "Original".into(),
        project_id: None,
    };
    let original = w.write(Some("request-1"), request()).unwrap();
    let blocker = w.create_ticket("Blocker").unwrap();
    let child = w.create_ticket("Child").unwrap();
    w.add_dependency(&blocker.reference, &child.reference, None)
        .unwrap();
    w.set_trashed(&blocker.reference, true, None).unwrap();
    w.backup(&backup).unwrap();
    w.create_ticket("Later").unwrap();
    drop(w);
    Workspace::restore(&path, &backup).unwrap();
    let mut w = Workspace::open(&path).unwrap();
    assert_eq!(w.write(Some("request-1"), request()).unwrap(), original);
    assert_eq!(
        w.show_ticket(&child.reference).unwrap().prerequisites[0].reference,
        blocker.reference
    );
    assert_eq!(w.list_trash().unwrap()[0].id, blocker.id);
    assert!(w.show_ticket("T-4").is_err());
}

#[test]
fn restore_rejects_open_workspace_and_invalid_backup_without_changing_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let backup = dir.path().join("backup.db");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Keep me").unwrap();
    workspace.backup(&backup).unwrap();
    let error = Workspace::restore(&path, &backup).unwrap_err();
    assert!(std::error::Error::source(&error).is_some());
    drop(workspace);
    std::fs::write(&backup, b"not a database").unwrap();
    assert!(Workspace::restore(&path, &backup).is_err());
    std::fs::remove_file(&backup).unwrap();
    let newer = rusqlite::Connection::open(&backup).unwrap();
    newer.pragma_update(None, "user_version", 999).unwrap();
    drop(newer);
    assert!(Workspace::restore(&path, &backup).is_err());
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().title,
        "Keep me"
    );
}

#[test]
fn migration_preserves_workspace_and_recovers_from_failure() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let request = || WriteRequest::CreateTicket {
        title: "Saved".into(),
        project_id: None,
    };
    let original = workspace.write(Some("request-1"), request()).unwrap();
    let reference = match &original {
        WriteResult::Ticket(ticket) => ticket.reference.clone(),
        _ => panic!("expected ticket"),
    };
    workspace.add_tag(&reference, "kept").unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP INDEX ticket_history_ticket_id; DROP TABLE inbox_entries; DROP TABLE ticket_follows; PRAGMA user_version = 12;")
        .unwrap();
    drop(db);
    // Hold a shared lock while both openers observe the old schema, so neither
    // can migrate until both have had an opportunity to contend.
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("{}.lock", path.display()))
        .unwrap();
    fs2::FileExt::lock_shared(&lock).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (sender, receiver) = std::sync::mpsc::channel();
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            let sender = sender.clone();
            std::thread::spawn(move || {
                barrier.wait();
                sender.send(Workspace::open(path).unwrap()).unwrap();
            })
        })
        .collect();
    std::thread::sleep(std::time::Duration::from_millis(200));
    drop(lock);
    let mut workspaces: Vec<_> = (0..2)
        .map(|_| {
            receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("concurrent workspace open timed out")
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(
        workspaces[0].show_ticket(&reference).unwrap().tags,
        vec!["kept"]
    );
    assert_eq!(
        workspaces[0].write(Some("request-1"), request()).unwrap(),
        original
    );
    workspaces.clear();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version = 12;").unwrap();
    drop(db);
    let error = match Workspace::open(&path) {
        Ok(_) => panic!("migration should fail"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("restore-workspace"));
    let backup = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().path()).filter(|p| p.to_string_lossy().contains("pre-migration")).find(|p| {
        let db = rusqlite::Connection::open(p).unwrap();
        db.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name='ticket_history_ticket_id'", [], |r| r.get::<_, i64>(0)).unwrap() == 1
    }).unwrap();
    Workspace::restore(&path, &backup).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP INDEX ticket_history_ticket_id; DROP TABLE inbox_entries; DROP TABLE ticket_follows;",
    )
    .unwrap();
    drop(db);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_ticket(&reference).unwrap().tags,
        vec!["kept"]
    );
}

#[test]
fn concurrent_project_moves_remove_the_previous_checkout() {
    use std::{sync::mpsc, thread, time::Duration};
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&database).unwrap();
    let project = workspace.create_project("Project", "initial").unwrap();
    let lock = rusqlite::Connection::open(&database).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    lock.execute(
        "UPDATE projects SET path = 'intermediate' WHERE id = ?1",
        [&project.id],
    )
    .unwrap();
    lock.execute(
        "DELETE FROM project_checkouts WHERE project_id = ?1",
        [&project.id],
    )
    .unwrap();
    lock.execute(
        "INSERT INTO project_checkouts (project_id, path) VALUES (?1, 'intermediate')",
        [&project.id],
    )
    .unwrap();
    let (started, receiver) = mpsc::channel();
    let id = project.id.clone();
    let worker = thread::spawn(move || {
        let mut workspace = Workspace::open(database).unwrap();
        started.send(()).unwrap();
        workspace.edit_project(&id, "Project", "final").unwrap()
    });
    receiver.recv().unwrap();
    // Give the worker time to reach the blocked SQLite write while the transaction is held.
    thread::sleep(Duration::from_millis(100));
    lock.execute_batch("COMMIT").unwrap();
    let result = worker.join().unwrap();
    assert_eq!(result.path, "final");
    assert_eq!(result.paths, vec!["final"]);
}

#[test]
fn tag_search_includes_unused_vocabulary_and_limits_results() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Outcome").unwrap();
    workspace.add_tag(&ticket.reference, "Bug").unwrap();
    workspace.add_tag(&ticket.reference, "Build").unwrap();
    workspace.remove_tag(&ticket.reference, "bug").unwrap();
    assert_eq!(workspace.search_tags("bu", 1).unwrap(), vec!["bug"]);
    assert_eq!(workspace.search_tags("BUG", 50).unwrap(), vec!["bug"]);
}

#[test]
fn followed_status_changes_persist_and_reading_a_snapshot_leaves_new_entries_unread() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Follow me").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    workspace.set_following(&ticket.reference, true).unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::InReview),
                ..Default::default()
            },
        )
        .unwrap();
    let displayed = workspace.inbox(100, 0).unwrap();
    assert_eq!(displayed.len(), 1);
    assert_eq!(displayed[0].from_value, "In progress");
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    workspace.set_inbox_read(&[displayed[0].id], true).unwrap();
    workspace.set_following(&ticket.reference, false).unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Canceled),
                ..Default::default()
            },
        )
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    let entries = workspace.inbox(100, 0).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(!entries[0].read);
    assert!(entries[1].read);
    assert!(!workspace.is_following(&ticket.reference).unwrap());
}

#[test]
fn inbox_writes_replay_and_failed_batches_leave_no_events() {
    use ticketd_core::{BatchOperation, TicketChange, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Tracked").unwrap();
    workspace
        .write(
            Some("follow"),
            WriteRequest::SetFollowing {
                reference: ticket.reference.clone(),
                following: true,
            },
        )
        .unwrap();
    let batch = vec![
        BatchOperation::Change {
            ticket: ticket.reference.clone(),
            change: Box::new(TicketChange {
                patch: TicketPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
                ..Default::default()
            }),
        },
        BatchOperation::Change {
            ticket: "T-9999".into(),
            change: Box::new(TicketChange::default()),
        },
    ];
    assert!(workspace.apply_batch(batch).is_err());
    assert!(workspace.inbox(100, 0).unwrap().is_empty());
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    let id = workspace.inbox(100, 0).unwrap()[0].id;
    workspace
        .write(
            Some("read"),
            WriteRequest::SetInboxRead {
                ids: vec![id],
                read: true,
            },
        )
        .unwrap();
    workspace.set_inbox_read(&[id], false).unwrap();
    workspace
        .write(
            Some("read"),
            WriteRequest::SetInboxRead {
                ids: vec![id],
                read: true,
            },
        )
        .unwrap();
    assert!(!workspace.inbox(100, 0).unwrap()[0].read);
}

#[test]
fn backup_restore_preserves_personal_inbox_and_follows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Backed up").unwrap();
    workspace.set_following(&ticket.reference, true).unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    let export = workspace.export().unwrap();
    assert_eq!(export["ticket_follows"][0]["person"], "local-person");
    assert_eq!(export["inbox_entries"][0]["to_value"], "Done");
    workspace.backup(&backup).unwrap();
    workspace.set_following(&ticket.reference, false).unwrap();
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert!(workspace.is_following(&ticket.reference).unwrap());
    assert_eq!(workspace.inbox(100, 0).unwrap().len(), 1);
}
