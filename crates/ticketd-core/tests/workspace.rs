use ticketd_core::FORMAT_VERSION;
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
fn authored_activity_requires_a_nonempty_brief() {
    use ticketd_core::ActivityPatch;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Outcome").unwrap();
    assert!(
        workspace
            .add_activity(&ticket.reference, "  \n", None)
            .is_err()
    );
    let activity = workspace
        .add_activity(&ticket.reference, "A brief", None)
        .unwrap();
    assert!(
        workspace
            .edit_activity(
                &ticket.reference,
                &activity.id,
                ActivityPatch {
                    brief: Some("  ".into()),
                    editing_agent: None,
                }
            )
            .is_err()
    );
    assert_eq!(
        workspace
            .activity(&ticket.reference, &activity.id)
            .unwrap()
            .brief,
        "A brief"
    );
}

#[test]
fn notes_can_be_paged_edited_and_deleted_after_reopening() {
    use ticketd_core::ActivityPatch;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Notes").unwrap();
    let first = workspace
        .add_activity(&ticket.reference, "First\nline", Some("codex"))
        .unwrap();
    let second = workspace
        .add_activity(&ticket.reference, "Second", None)
        .unwrap();
    let edited = workspace
        .edit_activity(
            &ticket.reference,
            &first.id,
            ActivityPatch {
                brief: Some("Revised".into()),
                editing_agent: None,
            },
        )
        .unwrap();
    assert_eq!(edited.editing_agent.as_deref(), Some("codex"));
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.activities(&ticket.reference, 1, 0).unwrap(),
        vec![edited]
    );
    assert_eq!(
        workspace.activities(&ticket.reference, 1, 1).unwrap(),
        vec![second.clone()]
    );
    workspace
        .delete_activity(&ticket.reference, &first.id)
        .unwrap();
    assert_eq!(
        workspace.activities(&ticket.reference, 10, 0).unwrap(),
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
fn plan_membership_progress_and_archiving_preserve_tickets() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&plan.id), Some("agent"))
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
    let view = workspace.show_plan(&plan.id).unwrap();
    assert_eq!(view.members.len(), 1);
    assert_eq!(view.counts.done, 1);
    workspace.change_plan(&plan.id, None, Some(true)).unwrap();
    assert!(workspace.list_plans(false).unwrap().is_empty());
    workspace
        .change_plan(&plan.id, Some("Release"), Some(false))
        .unwrap();
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().status,
        Status::Done
    );
    workspace.set_plan(&ticket.reference, None, None).unwrap();
    let history = workspace.ticket_history(&ticket.reference).unwrap();
    assert_eq!(
        history.iter().filter(|entry| entry.kind == "plan").count(),
        2
    );
    assert!(workspace.show_plan(&plan.id).unwrap().members.is_empty());
}

#[test]
fn moving_plan_membership_is_atomic_and_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace.create_plan("First").unwrap();
    let second = workspace.create_plan("Second").unwrap();
    let ticket = workspace.create_ticket("Shared outcome").unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&first.id), None)
        .unwrap();
    assert!(
        workspace
            .set_plan(&ticket.reference, Some("missing"), None)
            .is_err()
    );
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().plan_id,
        Some(first.id.clone())
    );
    workspace
        .set_plan(&ticket.reference, Some(&second.id), None)
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    assert!(workspace.show_plan(&first.id).unwrap().members.is_empty());
    assert_eq!(workspace.show_plan(&second.id).unwrap().members.len(), 1);
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
fn plan_patch_combines_membership_and_status_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Combined change").unwrap();
    assert!(
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    plan_id: Some(Some("missing".into())),
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
    let clear: TicketPatch = serde_json::from_str(r#"{"plan_id":null}"#).unwrap();
    assert_eq!(clear.plan_id, Some(None));
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
    assert!(w.add_activity(&parent.reference, "note", None).is_err());
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
        {"operation":"change", "ticket":"$child", "change":{"parent":"$parent", "add_blockers":["$parent"], "add_tags":["Feature"], "activities":["Started"]}}
    ])).unwrap();
    let results = workspace.apply_batch(operations).unwrap();
    let child = workspace.show_ticket(&results[1].reference).unwrap();
    assert_eq!(child.parent.unwrap().reference, results[0].reference);
    assert_eq!(child.prerequisites[0].reference, results[0].reference);
    assert_eq!(child.tags, ["feature"]);
    assert_eq!(
        workspace.activities(&child.reference, 10, 0).unwrap().len(),
        1
    );
    let history_before = workspace.ticket_history(&child.reference).unwrap();
    let operations: Vec<BatchOperation> = serde_json::from_value(serde_json::json!([
        {"operation":"create", "name":"temporary", "title":"Rolled back"},
        {"operation":"change", "ticket":child.reference, "change":{"status":"Done", "activities":["rolled back"]}},
        {"operation":"change", "ticket":results[0].reference, "change":{"add_blockers":[child.reference]}}
    ])).unwrap();
    let error = workspace.apply_batch(operations).unwrap_err().to_string();
    assert!(error.contains("operation 2"));
    assert_eq!(workspace.list_tickets().unwrap().len(), 2);
    assert_eq!(
        workspace.show_ticket(&child.reference).unwrap().status,
        ticketd_core::Status::Todo
    );
    assert_eq!(
        workspace.activities(&child.reference, 10, 0).unwrap().len(),
        1
    );
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
    ws.add_activity(&ticket.reference, "Finding", None).unwrap();
    let context = ws
        .ticket_context(
            &ticket.reference,
            ticketd_core::ContextOptions {
                relationships: true,
                activities: true,
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
    assert_eq!(context.activities.unwrap().items[0].brief.text, "Finding");
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
        .add_activity(&ticket.reference, "A [literal] finding", None)
        .unwrap();
    assert_eq!(
        workspace
            .search_tickets("[literal]", None, false, 50, 0)
            .unwrap()
            .len(),
        1
    );
    workspace
        .delete_activity(&ticket.reference, &note.id)
        .unwrap();
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
    let plan = workspace.create_plan("Plan").unwrap();
    let parent = workspace
        .create_ticket_in_project("Parent", Some(&project.id))
        .unwrap();
    let child = workspace.create_ticket("Child").unwrap();
    workspace
        .set_plan(&child.reference, Some(&plan.id), None)
        .unwrap();
    workspace
        .set_parent(&child.reference, Some(&parent.reference), None)
        .unwrap();
    workspace
        .add_dependency(&parent.reference, &child.reference, None)
        .unwrap();
    workspace.add_tag(&child.reference, "urgent").unwrap();
    let note = workspace
        .add_activity(&child.reference, "Finding", Some("agent"))
        .unwrap();
    workspace
        .set_trashed(&parent.reference, true, None)
        .unwrap();
    let export = workspace.export().unwrap();
    assert_eq!(export["format_version"], 1);
    assert_eq!(export["projects"][0]["id"], project.id);
    assert_eq!(export["project_checkouts"][0]["project_id"], project.id);
    assert_eq!(export["plans"][0]["id"], plan.id);
    assert_eq!(export["tickets"][0]["id"], parent.id);
    assert_eq!(export["tickets"][0]["trashed"], 1);
    assert_eq!(export["tickets"][1]["plan_id"], plan.id);
    assert_eq!(export["activities"][0]["id"], note.id);
    assert_eq!(export["activities"][0]["ticket_id"], child.id);
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
fn combined_filters_apply_project_plan_status_and_blocked_before_paging() {
    use ticketd_core::{Availability, TicketFilter};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = w.create_plan("Release").unwrap();
    let blocker = w.create_ticket("Prerequisite").unwrap();
    let blocked = w.create_ticket("Ship release").unwrap();
    w.set_plan(&blocked.reference, Some(&plan.id), None)
        .unwrap();
    w.add_dependency(&blocker.reference, &blocked.reference, None)
        .unwrap();
    w.create_ticket("Newer unrelated ticket").unwrap();
    let filter = TicketFilter {
        query: "release".into(),
        unlinked: true,
        plan: Some(plan.id),
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
    db.execute_batch("DROP INDEX ticket_history_ticket_id; DROP TABLE publication_attempts; DROP TABLE source_status; DROP TABLE source_conversation; DROP TABLE source_configurations; DROP TABLE external_duplicate_targets; DROP TABLE source_sync; DROP TABLE external_ownership; DROP TABLE external_identities; DROP TABLE last_backup; DROP TABLE contextual_relationships; DROP TABLE ticket_reminders; DROP TABLE inbox_entries; DROP TABLE ticket_follows; DROP TABLE duplicate_tickets; DROP TABLE evidence; ALTER TABLE activities RENAME COLUMN brief TO content; ALTER TABLE activities RENAME COLUMN reported_at TO created_at; ALTER TABLE activities RENAME TO notes; PRAGMA user_version = 12;")
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
    db.execute_batch("ALTER TABLE activities RENAME COLUMN brief TO content; ALTER TABLE activities RENAME COLUMN reported_at TO created_at; ALTER TABLE activities RENAME TO notes; PRAGMA user_version = 12;").unwrap();
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
        "DROP INDEX ticket_history_ticket_id; DROP TABLE publication_attempts; DROP TABLE source_status; DROP TABLE source_conversation; DROP TABLE source_configurations; DROP TABLE external_duplicate_targets; DROP TABLE source_sync; DROP TABLE external_ownership; DROP TABLE external_identities; DROP TABLE last_backup; DROP TABLE contextual_relationships; DROP TABLE ticket_reminders; DROP TABLE inbox_entries; DROP TABLE ticket_follows; DROP TABLE duplicate_tickets; DROP TABLE evidence;",
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
fn batch_creates_and_follows_a_ticket_in_one_write() {
    use ticketd_core::BatchOperation;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("follow.sqlite")).unwrap();
    let plan = |title: &str| -> Vec<BatchOperation> {
        serde_json::from_value(serde_json::json!([
            {"operation":"create", "name":"new", "title":title},
            {"operation":"change", "ticket":"$new", "change":{"status":"In progress"}}
        ]))
        .unwrap()
    };
    let followed = workspace
        .apply_batch_following(plan("Followed"), true)
        .unwrap();
    let plain = workspace.apply_batch(plan("Plain")).unwrap();
    assert!(workspace.is_following(&followed[0].reference).unwrap());
    assert!(!workspace.is_following(&plain[0].reference).unwrap());
    assert!(workspace.inbox(100, 0).unwrap().is_empty());
    workspace
        .change_ticket(
            &followed[0].reference,
            ticketd_core::TicketPatch {
                status: Some(ticketd_core::Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(workspace.inbox(100, 0).unwrap().len(), 1);

    let failing: Vec<BatchOperation> = serde_json::from_value(serde_json::json!([
        {"operation":"create", "name":"new", "title":"Rolled back"},
        {"operation":"change", "ticket":"T-999", "change":{"status":"Done"}}
    ]))
    .unwrap();
    assert!(workspace.apply_batch_following(failing, true).is_err());
    assert_eq!(workspace.list_tickets().unwrap().len(), 2);
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

/// The source text each backlink of T-1 in `body` covers.
fn mention_spans(body: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3"))?;
    let target = workspace.create_ticket("Target")?;
    assert_eq!(target.reference, "T-1");
    let source = workspace.create_ticket("Source")?;
    workspace.change_ticket(
        &source.reference,
        TicketPatch {
            body: Some(body.to_string()),
            ..Default::default()
        },
    )?;
    // The span counts chars from the body without a leading byte order mark.
    let text: Vec<char> = body.trim_start_matches('\u{feff}').chars().collect();
    Ok(workspace
        .backlinks(&target.reference, 20, 0)?
        .iter()
        .map(|link| text[link.mention_start..link.mention_end].iter().collect())
        .collect())
}

#[test]
fn backlink_spans_count_chars_not_utf16_units_or_bytes() {
    let body = "Émoji 😀 first.\n\n| T-1 | Done |\n|---|---|\n\nSee T-1 here.";
    assert_eq!(mention_spans(body).unwrap(), ["T-1", "T-1"]);
}

#[test]
fn backlink_spans_ignore_a_leading_byte_order_mark_and_survive_crlf() {
    assert_eq!(mention_spans("\u{feff}See T-1 here.").unwrap(), ["T-1"]);
    assert_eq!(
        mention_spans("\u{feff}First line.\r\n\r\nBlocked on T-1 now.\r\n").unwrap(),
        ["T-1"]
    );
}

#[test]
fn backlink_span_is_the_whole_run_when_the_source_uses_entities_or_escapes() {
    assert_eq!(
        mention_spans("&#120;T-1 and T-1").unwrap(),
        ["&#120;T-1 and T-1"],
        "a decoded run is not searched in its raw source"
    );
    assert_eq!(mention_spans("a \\* T-1").unwrap(), ["a \\* T-1"]);
}

#[test]
fn backlinks_follow_markdown_content_and_note_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    workspace
        .change_ticket(
            &source.reference,
            TicketPatch {
                body: Some(format!(
                    "See {} here.\n\n`{}` and [link](https://example.com/{})",
                    target.reference, target.reference, target.reference
                )),
                ..Default::default()
            },
        )
        .unwrap();
    let note = workspace
        .add_activity(
            &source.reference,
            &format!("A note about {}", target.reference),
            None,
        )
        .unwrap();
    let links = workspace.backlinks(&target.reference, 20, 0).unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].source_reference, source.reference);
    assert_eq!(links[0].passage, "See T-1 here.");
    assert_eq!(links[1].activity_id.as_deref(), Some(note.id.as_str()));
    workspace
        .delete_activity(&source.reference, &note.id)
        .unwrap();
    assert_eq!(
        workspace.backlinks(&target.reference, 20, 0).unwrap().len(),
        1
    );
}

#[test]
fn backlinks_ignore_fenced_code_and_reference_prefixes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    workspace
        .change_ticket(
            &source.reference,
            TicketPatch {
                body: Some(format!(
                    "```\n{}\n```\n\n{}0",
                    target.reference, target.reference
                )),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        workspace
            .backlinks(&target.reference, 20, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn backlink_pages_follow_edits_and_trash_visibility() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let first = workspace
        .add_activity(&source.reference, "T-1 first", None)
        .unwrap();
    workspace
        .add_activity(&source.reference, "T-1 second", None)
        .unwrap();
    assert_eq!(
        workspace.backlinks(&target.reference, 1, 1).unwrap()[0].passage,
        "T-1 second"
    );
    workspace
        .edit_activity(
            &source.reference,
            &first.id,
            ticketd_core::ActivityPatch {
                brief: Some("Changed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        workspace.backlinks(&target.reference, 20, 0).unwrap().len(),
        1
    );
    workspace
        .set_trashed(&source.reference, true, None)
        .unwrap();
    assert!(
        workspace
            .backlinks(&target.reference, 20, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn long_backlink_passage_keeps_the_reference_visible() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    workspace
        .change_ticket(
            &source.reference,
            TicketPatch {
                body: Some(format!("{} T-1 context", "x".repeat(600))),
                ..Default::default()
            },
        )
        .unwrap();
    let links = workspace.backlinks(&target.reference, 20, 0).unwrap();
    assert!(links[0].passage.contains("T-1"));
    assert!(links[0].passage.chars().count() <= 512);
}

#[test]
fn backlinks_recognize_escaped_markdown_references() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    workspace
        .change_ticket(
            &source.reference,
            TicketPatch {
                body: Some("See T\\-1 and &#84;-1".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let links = workspace.backlinks(&target.reference, 20, 0).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].source_reference, source.reference);
}

#[test]
fn bulk_status_rolls_back_when_a_selected_ticket_is_trashed() {
    use ticketd_core::{BatchOperation, Status, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("bulk.sqlite")).unwrap();
    let first = workspace.create_ticket("First").unwrap();
    let second = workspace.create_ticket("Second").unwrap();
    workspace
        .set_trashed(&second.reference, true, None)
        .unwrap();
    let before = workspace.ticket_history(&first.reference).unwrap();
    let operations: Vec<BatchOperation> = serde_json::from_value(serde_json::json!([
        {"operation":"change", "ticket":first.reference, "change":{"status":"Done"}},
        {"operation":"change", "ticket":second.reference, "change":{"status":"Done"}}
    ]))
    .unwrap();
    let error = workspace
        .write(Some("bulk-failed"), WriteRequest::Batch { operations })
        .unwrap_err();
    assert!(error.to_string().contains("operation 1"));
    assert_eq!(
        workspace.show_ticket(&first.reference).unwrap().status,
        Status::Todo
    );
    assert_eq!(workspace.ticket_history(&first.reference).unwrap(), before);
}

#[test]
fn followed_note_remains_understandable_after_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Tracked").unwrap();
    workspace.set_following(&ticket.reference, true).unwrap();
    let note = workspace
        .add_activity(&ticket.reference, "Original finding", Some("agent"))
        .unwrap();
    workspace
        .delete_activity(&ticket.reference, &note.id)
        .unwrap();
    let entries = workspace.inbox(100, 0).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "activity");
    assert_eq!(entries[0].from_value, note.id);
    assert_eq!(entries[0].to_value, "Original finding");
}

#[test]
fn followed_batch_notes_and_relationships_are_atomic_and_retry_safe() {
    use ticketd_core::{BatchOperation, TicketChange, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Tracked").unwrap();
    let blocker = workspace.create_ticket("Blocker").unwrap();
    workspace.set_following(&ticket.reference, true).unwrap();
    let request = || WriteRequest::Batch {
        operations: vec![BatchOperation::Change {
            ticket: ticket.reference.clone(),
            change: Box::new(TicketChange {
                activities: vec!["Batch note".into()],
                add_blockers: vec![blocker.reference.clone()],
                ..Default::default()
            }),
        }],
    };
    let failed = vec![
        BatchOperation::Change {
            ticket: ticket.reference.clone(),
            change: Box::new(TicketChange {
                activities: vec!["Rolled back".into()],
                ..Default::default()
            }),
        },
        BatchOperation::Change {
            ticket: "T-9999".into(),
            change: Box::new(TicketChange::default()),
        },
    ];
    assert!(workspace.apply_batch(failed).is_err());
    assert!(workspace.inbox(100, 0).unwrap().is_empty());
    workspace.write(Some("batch"), request()).unwrap();
    workspace.write(Some("batch"), request()).unwrap();
    let entries = workspace.inbox(100, 0).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(
        entries
            .iter()
            .any(|e| e.kind == "activity" && e.to_value == "Batch note")
    );
    assert!(
        entries
            .iter()
            .any(|e| e.kind == "dependency" && e.to_value == blocker.reference)
    );
}

#[test]
fn followed_relationship_endpoints_receive_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let parent = workspace.create_ticket("Parent").unwrap();
    let child = workspace.create_ticket("Child").unwrap();
    workspace.set_following(&parent.reference, true).unwrap();
    workspace
        .set_parent(&child.reference, Some(&parent.reference), Some("agent"))
        .unwrap();
    let entries = workspace.inbox(100, 0).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].reference, parent.reference);
    assert_eq!(entries[0].to_value, child.reference);
    assert_eq!(entries[0].editing_agent.as_deref(), Some("agent"));
}

#[test]
fn duplicate_consolidation_and_undo_preserve_original_status() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let a = workspace.create_ticket("A").unwrap();
    let b = workspace.create_ticket("B").unwrap();
    let c = workspace.create_ticket("C").unwrap();
    workspace
        .change_ticket(
            &a.reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .mark_duplicate(&a.reference, &b.reference, None)
        .unwrap();
    workspace
        .mark_duplicate(&b.reference, &c.reference, None)
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&a.reference)
            .unwrap()
            .duplicate_of
            .as_deref(),
        Some(c.reference.as_str())
    );
    workspace.remove_duplicate(&a.reference, None).unwrap();
    assert_eq!(
        workspace.show_ticket(&a.reference).unwrap().status,
        Status::InProgress
    );
}

#[test]
fn duplicate_rejects_dependencies_and_undo_respects_later_status() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    workspace
        .add_dependency(&source.reference, &target.reference, None)
        .unwrap();
    assert!(
        workspace
            .mark_duplicate(&source.reference, &target.reference, None)
            .unwrap_err()
            .to_string()
            .contains("blocking dependencies")
    );
    workspace
        .remove_dependency(&source.reference, &target.reference, None)
        .unwrap();
    workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    workspace
        .change_ticket(
            &source.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    workspace.remove_duplicate(&source.reference, None).unwrap();
    assert_eq!(
        workspace.show_ticket(&source.reference).unwrap().status,
        Status::Done
    );
}

#[test]
fn duplicate_write_replay_does_not_undo_a_later_change() {
    use ticketd_core::WriteRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let request = || WriteRequest::MarkDuplicate {
        source: source.reference.clone(),
        canonical: target.reference.clone(),
        agent: None,
    };
    workspace
        .write(Some("duplicate-request"), request())
        .unwrap();
    workspace
        .change_ticket(
            &source.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .write(Some("duplicate-request"), request())
        .unwrap();
    workspace.remove_duplicate(&source.reference, None).unwrap();
    assert_eq!(
        workspace.show_ticket(&source.reference).unwrap().status,
        Status::Done
    );
}

#[test]
fn concurrent_opposing_duplicate_marks_cannot_form_a_cycle() {
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
    .map(|(source, target)| {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let mut workspace = Workspace::open(path).unwrap();
            barrier.wait();
            workspace.mark_duplicate(&source, &target, None).is_ok()
        })
    })
    .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|success| *success)
            .count(),
        1
    );
}

#[test]
fn followed_duplicate_changes_appear_in_attention_inbox() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    workspace.set_following(&source.reference, true).unwrap();
    workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    workspace.remove_duplicate(&source.reference, None).unwrap();
    let entries = workspace.inbox(100, 0).unwrap();
    let duplicate_events: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == "relationship:duplicate")
        .collect();
    assert_eq!(duplicate_events.len(), 2);
    assert_eq!(duplicate_events[0].from_value, target.reference);
    assert_eq!(duplicate_events[1].to_value, target.reference);
}

#[test]
fn duplicate_relationship_survives_export_and_backup_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let backup = dir.path().join("backup.db");
    let mut workspace = Workspace::open(&path).unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    let export = workspace.export().unwrap();
    assert_eq!(export["duplicate_tickets"][0]["source_id"], source.id);
    assert_eq!(export["duplicate_tickets"][0]["canonical_id"], target.id);
    workspace.backup(&backup).unwrap();
    workspace.remove_duplicate(&source.reference, None).unwrap();
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .show_ticket(&source.reference)
            .unwrap()
            .duplicate_of,
        Some(target.reference)
    );
    workspace.remove_duplicate(&source.reference, None).unwrap();
    assert_eq!(
        workspace.show_ticket(&source.reference).unwrap().status,
        Status::Todo
    );
}

#[test]
fn named_evidence_survives_reopening_and_can_be_edited_and_removed() {
    use ticketd_core::{EvidenceInput, EvidenceKind};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    let input = EvidenceInput {
        kind: EvidenceKind::Verification,
        name: "Tests".into(),
        value: "cargo test: passed".into(),
        editing_agent: Some("agent".into()),
    };
    let evidence = workspace.add_evidence(&ticket.reference, input).unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.evidence(&ticket.reference, 20, 0).unwrap(),
        vec![evidence.clone()]
    );
    let revised = EvidenceInput {
        kind: EvidenceKind::Branch,
        name: "Branch".into(),
        value: "feature/full-name".into(),
        editing_agent: None,
    };
    let edited = workspace
        .edit_evidence(&ticket.reference, &evidence.id, revised)
        .unwrap();
    assert_eq!(edited.value, "feature/full-name");
    workspace
        .delete_evidence(&ticket.reference, &evidence.id)
        .unwrap();
    assert!(
        workspace
            .evidence(&ticket.reference, 20, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn evidence_retry_context_export_and_trash_rules() {
    use ticketd_core::{ContextOptions, EvidenceInput, EvidenceKind, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = ws.create_ticket("Check").unwrap();
    let request = || WriteRequest::AddEvidence {
        reference: ticket.reference.clone(),
        input: EvidenceInput {
            kind: EvidenceKind::Worktree,
            name: "Checkout".into(),
            value: "/missing/full/path".into(),
            editing_agent: Some("agent".into()),
        },
    };
    assert_eq!(
        ws.write(Some("evidence-retry"), request()).unwrap(),
        ws.write(Some("evidence-retry"), request()).unwrap()
    );
    assert_eq!(ws.evidence(&ticket.reference, 50, 0).unwrap().len(), 1);
    let context = ws
        .ticket_context(
            &ticket.reference,
            ContextOptions {
                evidence: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        context.evidence.unwrap().items[0].value.text,
        "/missing/full/path"
    );
    assert_eq!(
        ws.export().unwrap()["evidence"][0]["editing_agent"],
        "agent"
    );
    ws.set_trashed(&ticket.reference, true, None).unwrap();
    assert!(ws.write(None, request()).is_err());
    assert_eq!(ws.evidence(&ticket.reference, 50, 0).unwrap().len(), 1);
}

#[test]
fn backup_restores_evidence_and_its_retry_outcome() {
    use ticketd_core::{EvidenceInput, EvidenceKind, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut ws = Workspace::open(&path).unwrap();
    let ticket = ws.create_ticket("Ship").unwrap();
    let request = || WriteRequest::AddEvidence {
        reference: ticket.reference.clone(),
        input: EvidenceInput {
            kind: EvidenceKind::Commit,
            name: "Commit".into(),
            value: "abcdef0123456789".into(),
            editing_agent: None,
        },
    };
    let original = ws.write(Some("save-evidence"), request()).unwrap();
    ws.backup(&backup).unwrap();
    drop(ws);
    Workspace::restore(&path, &backup).unwrap();
    let mut ws = Workspace::open(&path).unwrap();
    assert_eq!(
        ws.write(Some("save-evidence"), request()).unwrap(),
        original
    );
    assert_eq!(
        ws.evidence(&ticket.reference, 50, 0).unwrap()[0].value,
        "abcdef0123456789"
    );
}

#[test]
fn evidence_rejects_empty_fields_and_incomplete_pull_request_urls() {
    use ticketd_core::{EvidenceInput, EvidenceKind};
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = ws.create_ticket("Ship").unwrap();
    for (name, value) in [
        ("", "https://example.com/pr/1"),
        ("PR", "https://"),
        ("PR", "https://example.com/bad path"),
    ] {
        assert!(
            ws.add_evidence(
                &ticket.reference,
                EvidenceInput {
                    kind: EvidenceKind::PullRequest,
                    name: name.into(),
                    value: value.into(),
                    editing_agent: None
                }
            )
            .is_err()
        );
    }
    assert!(ws.evidence(&ticket.reference, 50, 0).unwrap().is_empty());
}

#[test]
fn version_sixteen_workspace_keeps_evidence_and_adds_inbox_attribution() {
    use ticketd_core::{EvidenceInput, EvidenceKind};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace
        .create_ticket("Evidence survives migration")
        .unwrap();
    workspace
        .add_evidence(
            &ticket.reference,
            EvidenceInput {
                kind: EvidenceKind::Commit,
                name: "Commit".into(),
                value: "abc123".into(),
                editing_agent: None,
            },
        )
        .unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TABLE publication_attempts; DROP TABLE source_status; DROP TABLE source_conversation; DROP TABLE source_configurations; DROP TABLE external_duplicate_targets; DROP TABLE source_sync; DROP TABLE external_ownership; DROP TABLE external_identities; DROP TABLE last_backup; DROP TABLE contextual_relationships; DROP TABLE ticket_reminders; ALTER TABLE inbox_entries DROP COLUMN editing_agent; ALTER TABLE activities RENAME COLUMN brief TO content; ALTER TABLE activities RENAME COLUMN reported_at TO created_at; ALTER TABLE activities RENAME TO notes; PRAGMA user_version = 16;",
    )
    .unwrap();
    drop(db);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.evidence(&ticket.reference, 10, 0).unwrap()[0].value,
        "abc123"
    );
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let db = rusqlite::Connection::open(backup).unwrap();
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, FORMAT_VERSION);
    assert!(
        db.prepare("SELECT editing_agent FROM inbox_entries")
            .is_ok()
    );
}

#[test]
fn duplicate_preview_explains_why_a_replacement_is_invalid() {
    use ticketd_core::ReplacementIssue;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Duplicate").unwrap();
    let canonical = workspace.create_ticket("Canonical").unwrap();
    let exists = workspace.create_ticket("Already blocked").unwrap();
    let cycle = workspace.create_ticket("Blocks canonical").unwrap();
    let fine = workspace.create_ticket("Plain dependent").unwrap();
    let (s, c) = (&source.reference, &canonical.reference);
    workspace
        .add_dependency(s, &exists.reference, None)
        .unwrap();
    workspace
        .add_dependency(c, &exists.reference, None)
        .unwrap();
    workspace.add_dependency(s, &cycle.reference, None).unwrap();
    workspace.add_dependency(&cycle.reference, c, None).unwrap();
    workspace.add_dependency(s, &fine.reference, None).unwrap();
    workspace.add_dependency(s, c, None).unwrap();
    let preview = workspace.preview_duplicate_dependencies(s, c).unwrap();
    assert_eq!(preview.edges.len(), preview.replacement_issues.len());
    let issue_for = |blocker: &str, dependent: &str| {
        let index = preview
            .edges
            .iter()
            .position(|e| e.blocker == blocker && e.dependent == dependent)
            .unwrap();
        preview.replacement_issues[index]
    };
    assert_eq!(
        issue_for(s, &exists.reference),
        Some(ReplacementIssue::AlreadyExists)
    );
    assert_eq!(
        issue_for(s, &cycle.reference),
        Some(ReplacementIssue::Cycle)
    );
    assert_eq!(issue_for(s, c), Some(ReplacementIssue::SelfBlock));
    assert_eq!(issue_for(s, &fine.reference), None);
}

#[test]
fn duplicate_review_replaces_a_blocker_atomically() {
    use ticketd_core::{DependencyChoice, DependencyDecision};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Duplicate").unwrap();
    let canonical = workspace.create_ticket("Canonical").unwrap();
    let dependent = workspace.create_ticket("Dependent").unwrap();
    workspace
        .add_dependency(&source.reference, &dependent.reference, None)
        .unwrap();
    let preview = workspace
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let choices = preview
        .edges
        .clone()
        .into_iter()
        .map(|edge| DependencyDecision {
            edge,
            choice: DependencyChoice::Replace,
        })
        .collect();
    workspace
        .mark_duplicate_reviewed(
            &source.reference,
            &canonical.reference,
            &preview.canonical,
            choices,
            None,
        )
        .unwrap();
    let saved = workspace.show_ticket(&dependent.reference).unwrap();
    assert_eq!(saved.prerequisites[0].reference, canonical.reference);
    assert_eq!(saved.availability.as_deref(), Some("Blocked"));
}

#[test]
fn duplicate_review_rejects_new_edges_without_partial_changes() {
    use ticketd_core::{DependencyChoice, DependencyDecision};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut first = Workspace::open(&path).unwrap();
    let source = first.create_ticket("Duplicate").unwrap();
    let canonical = first.create_ticket("Canonical").unwrap();
    let dependent = first.create_ticket("Dependent").unwrap();
    let other = first.create_ticket("Other").unwrap();
    first
        .add_dependency(&source.reference, &dependent.reference, None)
        .unwrap();
    let preview = first
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let decisions = preview
        .edges
        .clone()
        .into_iter()
        .map(|edge| DependencyDecision {
            edge,
            choice: DependencyChoice::Replace,
        })
        .collect();
    let mut second = Workspace::open(&path).unwrap();
    second
        .add_dependency(&source.reference, &other.reference, None)
        .unwrap();
    assert!(
        first
            .mark_duplicate_reviewed(
                &source.reference,
                &canonical.reference,
                &preview.canonical,
                decisions,
                None
            )
            .is_err()
    );
    assert_eq!(
        first.show_ticket(&source.reference).unwrap().status,
        Status::Todo
    );
    assert_eq!(
        first
            .show_ticket(&dependent.reference)
            .unwrap()
            .prerequisites[0]
            .reference,
        source.reference
    );
}

#[test]
fn reviewed_duplicate_rollback_cycle_and_separate_undo_edit() {
    use ticketd_core::{DependencyChoice, DependencyDecision};
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = ws.create_ticket("Duplicate").unwrap();
    let canonical = ws.create_ticket("Canonical").unwrap();
    let dependent = ws.create_ticket("Dependent").unwrap();
    ws.add_dependency(&source.reference, &dependent.reference, None)
        .unwrap();
    ws.add_dependency(&dependent.reference, &canonical.reference, None)
        .unwrap();
    let preview = ws
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let decisions = preview
        .edges
        .iter()
        .cloned()
        .map(|edge| DependencyDecision {
            edge,
            choice: DependencyChoice::Replace,
        })
        .collect();
    assert!(
        ws.mark_duplicate_reviewed(
            &source.reference,
            &canonical.reference,
            &preview.canonical,
            decisions,
            None
        )
        .is_err()
    );
    assert_eq!(
        ws.show_ticket(&source.reference).unwrap().status,
        Status::Todo
    );
    assert_eq!(
        ws.show_ticket(&dependent.reference).unwrap().prerequisites[0].reference,
        source.reference
    );
    ws.remove_dependency(&dependent.reference, &canonical.reference, None)
        .unwrap();
    let preview = ws
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let decisions = preview
        .edges
        .iter()
        .cloned()
        .map(|edge| DependencyDecision {
            edge,
            choice: DependencyChoice::Replace,
        })
        .collect();
    ws.mark_duplicate_reviewed(
        &source.reference,
        &canonical.reference,
        &preview.canonical,
        decisions,
        None,
    )
    .unwrap();
    ws.remove_duplicate(&source.reference, None).unwrap();
    assert_eq!(
        ws.show_ticket(&dependent.reference).unwrap().prerequisites[0].reference,
        canonical.reference
    );
    let review = ws
        .preview_dependency_move(&canonical.reference, &source.reference)
        .unwrap();
    let decisions = review
        .edges
        .iter()
        .cloned()
        .map(|edge| DependencyDecision {
            edge,
            choice: DependencyChoice::Replace,
        })
        .collect();
    ws.edit_dependencies_reviewed(
        &canonical.reference,
        &source.reference,
        &review.canonical,
        decisions,
        None,
    )
    .unwrap();
    assert_eq!(
        ws.show_ticket(&dependent.reference).unwrap().prerequisites[0].reference,
        source.reference
    );
}

#[test]
fn reviewed_duplicate_retry_preserves_later_graph_edits() {
    use ticketd_core::{DependencyChoice, DependencyDecision, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = ws.create_ticket("Duplicate").unwrap();
    let canonical = ws.create_ticket("Canonical").unwrap();
    let dependent = ws.create_ticket("Dependent").unwrap();
    ws.add_dependency(&source.reference, &dependent.reference, None)
        .unwrap();
    let preview = ws
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let request = || WriteRequest::MarkDuplicateReviewed {
        source: source.reference.clone(),
        canonical: canonical.reference.clone(),
        expected_canonical: preview.canonical.clone(),
        decisions: preview
            .edges
            .iter()
            .cloned()
            .map(|edge| DependencyDecision {
                edge,
                choice: DependencyChoice::Replace,
            })
            .collect(),
        agent: None,
    };
    ws.write(Some("review"), request()).unwrap();
    ws.remove_dependency(&canonical.reference, &dependent.reference, None)
        .unwrap();
    ws.write(Some("review"), request()).unwrap();
    assert!(
        ws.show_ticket(&dependent.reference)
            .unwrap()
            .prerequisites
            .is_empty()
    );
}

#[test]
fn retained_duplicate_blocker_stays_unresolved_and_review_notifies_followers() {
    use ticketd_core::{DependencyChoice, DependencyDecision};
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = ws.create_ticket("Duplicate").unwrap();
    let canonical = ws.create_ticket("Canonical").unwrap();
    let kept = ws.create_ticket("Kept").unwrap();
    let moved = ws.create_ticket("Moved").unwrap();
    ws.add_dependency(&source.reference, &kept.reference, None)
        .unwrap();
    ws.add_dependency(&source.reference, &moved.reference, None)
        .unwrap();
    ws.set_following(&moved.reference, true).unwrap();
    let preview = ws
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let decisions = preview
        .edges
        .iter()
        .cloned()
        .map(|edge| {
            let choice = if edge.dependent == kept.reference {
                DependencyChoice::Retain
            } else {
                DependencyChoice::Replace
            };
            DependencyDecision { edge, choice }
        })
        .collect();
    ws.mark_duplicate_reviewed(
        &source.reference,
        &canonical.reference,
        &preview.canonical,
        decisions,
        None,
    )
    .unwrap();
    let kept = ws.show_ticket(&kept.reference).unwrap();
    assert_eq!(kept.availability.as_deref(), Some("Blocked"));
    assert_eq!(kept.prerequisites[0].status, Status::Duplicate);
    assert!(
        ws.inbox(100, 0)
            .unwrap()
            .iter()
            .any(|entry| entry.kind == "dependency" && entry.reference == moved.reference)
    );
}

#[test]
fn concurrent_new_edge_is_never_silently_replaced_by_duplicate_review() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut ws = Workspace::open(&path).unwrap();
    let source = ws.create_ticket("Duplicate").unwrap();
    let canonical = ws.create_ticket("Canonical").unwrap();
    let dependent = ws.create_ticket("New dependent").unwrap();
    let preview = ws
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let thread_path = path.clone();
    let thread_barrier = barrier.clone();
    let blocker = source.reference.clone();
    let target = dependent.reference.clone();
    let worker = std::thread::spawn(move || {
        let mut other = Workspace::open(thread_path).unwrap();
        thread_barrier.wait();
        other.add_dependency(&blocker, &target, None).unwrap();
    });
    barrier.wait();
    let result = ws.mark_duplicate_reviewed(
        &source.reference,
        &canonical.reference,
        &preview.canonical,
        vec![],
        None,
    );
    worker.join().unwrap();
    let saved = ws.show_ticket(&dependent.reference).unwrap();
    assert_eq!(saved.prerequisites[0].reference, source.reference);
    if result.is_err() {
        assert_eq!(
            ws.show_ticket(&source.reference).unwrap().status,
            Status::Todo
        );
    }
}

#[test]
fn concurrent_inbox_reads_deliver_one_reminder_and_backup_restores_it() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Concurrent reminder").unwrap();
    workspace
        .set_reminder(&ticket.reference, Some("2020-01-01T00:00:00Z"))
        .unwrap();
    workspace.backup(&backup).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let workspace = Workspace::open(path).unwrap();
                barrier.wait();
                workspace.inbox(100, 0).unwrap()
            })
        })
        .collect();
    for thread in threads {
        assert_eq!(thread.join().unwrap().len(), 1);
    }
    assert_eq!(
        workspace.export().unwrap()["ticket_reminders"][0]["person"],
        "local-person"
    );
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(path).unwrap();
    assert_eq!(
        workspace.reminder(&ticket.reference).unwrap().as_deref(),
        Some("2020-01-01T00:00:00Z")
    );
    assert_eq!(workspace.inbox(100, 0).unwrap().len(), 1);
}

#[test]
fn contextual_relationships_are_symmetric_or_directed() {
    use ticketd_core::{ContextOptions, RelationshipKind};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let a = w.create_ticket("Original work").unwrap();
    let b = w.create_ticket("Discovered work").unwrap();
    w.add_contextual_relationship(&a.reference, &b.reference, RelationshipKind::Related, None)
        .unwrap();
    w.add_contextual_relationship(
        &a.reference,
        &b.reference,
        RelationshipKind::Discovered,
        None,
    )
    .unwrap();
    let context = w
        .ticket_context(
            &b.reference,
            ContextOptions {
                relationships: true,
                ..Default::default()
            },
        )
        .unwrap()
        .relationships
        .unwrap();
    assert_eq!(context.related.items[0].reference, a.reference);
    assert_eq!(context.discovered_while.items[0].reference, a.reference);
    assert!(context.discoveries.items.is_empty());
    assert_eq!(
        w.show_ticket(&b.reference).unwrap().availability.as_deref(),
        Some("Ready")
    );
}

#[test]
fn contextual_relationships_reject_self_links_and_deduplicate_and_detach_from_trash() {
    use ticketd_core::{ContextOptions, RelationshipKind};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let a = w.create_ticket("A").unwrap();
    let b = w.create_ticket("B").unwrap();
    assert!(
        w.add_contextual_relationship(&a.reference, &a.reference, RelationshipKind::Related, None)
            .is_err()
    );
    w.add_contextual_relationship(&a.reference, &b.reference, RelationshipKind::Related, None)
        .unwrap();
    w.add_contextual_relationship(&b.reference, &a.reference, RelationshipKind::Related, None)
        .unwrap();
    assert_eq!(w.ticket_history(&a.reference).unwrap().len(), 1);
    w.set_trashed(&b.reference, true, None).unwrap();
    w.remove_contextual_relationship(&a.reference, &b.reference, RelationshipKind::Related, None)
        .unwrap();
    let context = w
        .ticket_context(
            &a.reference,
            ContextOptions {
                relationships: true,
                ..Default::default()
            },
        )
        .unwrap()
        .relationships
        .unwrap();
    assert!(context.related.items.is_empty());
}

#[test]
fn contextual_relationship_retry_notifies_both_endpoints_and_exports() {
    use ticketd_core::{RelationshipKind, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let a = w.create_ticket("A").unwrap();
    let b = w.create_ticket("B").unwrap();
    w.set_following(&a.reference, true).unwrap();
    w.set_following(&b.reference, true).unwrap();
    let request = || WriteRequest::AddContextualRelationship {
        source: a.reference.clone(),
        target: b.reference.clone(),
        kind: RelationshipKind::Discovered,
        agent: Some("agent".into()),
    };
    w.write(Some("relationship-request"), request()).unwrap();
    w.write(Some("relationship-request"), request()).unwrap();
    let inbox = w.inbox(20, 0).unwrap();
    assert_eq!(inbox.len(), 2);
    assert!(
        inbox
            .iter()
            .all(|entry| entry.kind.starts_with("relationship:"))
    );
    assert_eq!(
        w.export().unwrap()["contextual_relationships"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn contextual_relationships_and_retry_survive_backup_restore() {
    use ticketd_core::{ContextOptions, RelationshipKind, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let a = w.create_ticket("A").unwrap();
    let b = w.create_ticket("B").unwrap();
    let request = || WriteRequest::AddContextualRelationship {
        source: a.reference.clone(),
        target: b.reference.clone(),
        kind: RelationshipKind::Related,
        agent: None,
    };
    let original = w.write(Some("link"), request()).unwrap();
    w.backup(&backup).unwrap();
    drop(w);
    Workspace::restore(&path, &backup).unwrap();
    let mut w = Workspace::open(&path).unwrap();
    assert_eq!(w.write(Some("link"), request()).unwrap(), original);
    let links = w
        .ticket_context(
            &b.reference,
            ContextOptions {
                relationships: true,
                ..Default::default()
            },
        )
        .unwrap()
        .relationships
        .unwrap();
    assert_eq!(links.related.items[0].reference, a.reference);
}

#[test]
fn version_eighteen_reminders_survive_contextual_relationship_migration_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("version-18.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Remember after migration").unwrap();
    workspace
        .set_reminder(&ticket.reference, Some("2030-01-01T00:00:00Z"))
        .unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TABLE publication_attempts; DROP TABLE source_status; DROP TABLE source_conversation; DROP TABLE source_configurations; DROP TABLE external_duplicate_targets; DROP TABLE source_sync; DROP TABLE external_ownership; DROP TABLE external_identities; DROP TABLE last_backup; DROP TABLE contextual_relationships; ALTER TABLE activities RENAME COLUMN brief TO content; ALTER TABLE activities RENAME COLUMN reported_at TO created_at; ALTER TABLE activities RENAME TO notes; PRAGMA user_version = 18;",
    )
    .unwrap();
    drop(db);
    std::fs::copy(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.reminder(&ticket.reference).unwrap().as_deref(),
        Some("2030-01-01T00:00:00Z")
    );
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.reminder(&ticket.reference).unwrap().as_deref(),
        Some("2030-01-01T00:00:00Z")
    );
    let db = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, FORMAT_VERSION);
    assert!(db.prepare("SELECT * FROM contextual_relationships").is_ok());
}

#[test]
fn bulk_organization_preserves_unrelated_tags_and_rolls_back_invalid_selection() {
    use ticketd_core::{BatchOperation, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("bulk-organization.sqlite")).unwrap();
    let project = workspace.create_project("Project", "/project").unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let first = workspace.create_ticket("First").unwrap();
    let second = workspace.create_ticket("Second").unwrap();
    workspace.add_tag(&first.reference, "keep").unwrap();
    workspace.add_tag(&second.reference, "remove").unwrap();
    let changes = || {
        serde_json::from_value::<Vec<BatchOperation>>(serde_json::json!([
        {"operation":"change", "ticket":first.reference, "change":{"project_id":project.id,"plan_id":plan.id,"add_tags":["new"],"remove_tags":["remove"]}},
        {"operation":"change", "ticket":second.reference, "change":{"project_id":project.id,"plan_id":plan.id,"add_tags":["new"],"remove_tags":["remove"]}}
    ])).unwrap()
    };
    workspace
        .write(
            Some("organize"),
            WriteRequest::Batch {
                operations: changes(),
            },
        )
        .unwrap();
    workspace
        .write(
            Some("organize"),
            WriteRequest::Batch {
                operations: changes(),
            },
        )
        .unwrap();
    let saved = workspace.show_ticket(&first.reference).unwrap();
    assert_eq!(saved.project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(saved.plan_id.as_deref(), Some(plan.id.as_str()));
    assert_eq!(saved.tags, vec!["keep", "new"]);
    assert_eq!(
        workspace.show_ticket(&second.reference).unwrap().tags,
        vec!["new"]
    );
    let invalid: Vec<BatchOperation> = serde_json::from_value(serde_json::json!([
        {"operation":"change", "ticket":first.reference, "change":{"project_id":null,"plan_id":null}},
        {"operation":"change", "ticket":second.reference, "change":{"project_id":"missing"}}
    ])).unwrap();
    assert!(workspace.apply_batch(invalid).is_err());
    let saved = workspace.show_ticket(&first.reference).unwrap();
    assert_eq!(saved.project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(saved.plan_id.as_deref(), Some(plan.id.as_str()));
    let clear: Vec<BatchOperation> = serde_json::from_value(serde_json::json!([
        {"operation":"change", "ticket":first.reference, "change":{"project_id":null,"plan_id":null}}
    ])).unwrap();
    workspace.apply_batch(clear).unwrap();
    let saved = workspace.show_ticket(&first.reference).unwrap();
    assert_eq!(saved.project_id, None);
    assert_eq!(saved.plan_id, None);
    assert_eq!(saved.tags, vec!["keep", "new"]);
}

#[test]
fn reviewed_dependency_replacement_records_each_change_once_and_replay_is_silent() {
    use ticketd_core::{DependencyChoice, DependencyDecision, WriteRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = ws.create_ticket("Duplicate").unwrap();
    let canonical = ws.create_ticket("Canonical").unwrap();
    let dependent = ws.create_ticket("Dependent").unwrap();
    ws.add_dependency(&source.reference, &dependent.reference, None)
        .unwrap();
    for ticket in [&source, &canonical, &dependent] {
        ws.set_following(&ticket.reference, true).unwrap();
    }
    let preview = ws
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let request = || WriteRequest::MarkDuplicateReviewed {
        source: source.reference.clone(),
        canonical: canonical.reference.clone(),
        expected_canonical: preview.canonical.clone(),
        decisions: preview
            .edges
            .iter()
            .cloned()
            .map(|edge| DependencyDecision {
                edge,
                choice: DependencyChoice::Replace,
            })
            .collect(),
        agent: None,
    };
    let history_before: Vec<_> = [&source, &canonical, &dependent]
        .iter()
        .map(|ticket| ws.ticket_history(&ticket.reference).unwrap().len())
        .collect();
    ws.write(Some("review-once"), request()).unwrap();
    let histories: Vec<_> = [&source, &canonical, &dependent]
        .iter()
        .map(|ticket| ws.ticket_history(&ticket.reference).unwrap())
        .collect();
    for (history, start) in histories.iter().zip(history_before) {
        assert!(
            !history[start..]
                .iter()
                .any(|entry| entry.kind == "relationship:dependency_review")
        );
    }
    let edge_counts: Vec<_> = histories
        .iter()
        .map(|history| {
            history
                .iter()
                .filter(|entry| entry.kind == "dependency" || entry.kind == "relationship:blocks")
                .count()
        })
        .collect();
    assert_eq!(edge_counts, vec![2, 1, 3]);
    let entries = ws.inbox(100, 0).unwrap();
    let edge_entries: Vec<_> = entries
        .iter()
        .filter(|e| {
            e.kind == "dependency"
                || e.kind.starts_with("relationship:blocks")
                || e.kind == "relationship:dependency_review"
        })
        .collect();
    assert_eq!(edge_entries.len(), 4);
    assert_eq!(
        edge_entries
            .iter()
            .filter(|e| e.reference == source.reference)
            .count(),
        1
    );
    assert_eq!(
        edge_entries
            .iter()
            .filter(|e| e.reference == canonical.reference)
            .count(),
        1
    );
    assert_eq!(
        edge_entries
            .iter()
            .filter(|e| e.reference == dependent.reference)
            .count(),
        2
    );
    ws.write(Some("review-once"), request()).unwrap();
    assert_eq!(ws.inbox(100, 0).unwrap().len(), entries.len());
    assert!(ws.write(Some("different-review"), request()).is_err());
    assert_eq!(ws.inbox(100, 0).unwrap().len(), entries.len());
    for (ticket, history) in [&source, &canonical, &dependent].iter().zip(histories) {
        assert_eq!(ws.ticket_history(&ticket.reference).unwrap(), history);
    }
}

#[test]
fn unread_observation_delivers_reminders_once_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Remember").unwrap();
    assert_eq!(workspace.sidebar_counts().unwrap().unread_inbox, 0);
    workspace
        .set_reminder(&ticket.reference, Some("2020-01-01T00:00:00Z"))
        .unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.sidebar_counts().unwrap().unread_inbox, 1);
    assert_eq!(workspace.sidebar_counts().unwrap().unread_inbox, 1);
    let entries = workspace.inbox(100, 0).unwrap();
    assert_eq!(entries.len(), 1);
    workspace.set_inbox_read(&[entries[0].id], true).unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.sidebar_counts().unwrap().unread_inbox, 0);
    assert_eq!(workspace.inbox(100, 0).unwrap().len(), 1);
}

#[test]
fn retrying_a_delivered_reminder_does_not_create_another_occurrence() {
    use ticketd_core::WriteRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = ws.create_ticket("Remember once").unwrap();
    let request = || WriteRequest::SetReminder {
        reference: ticket.reference.clone(),
        due_at: Some("2020-01-01T00:00:00Z".into()),
    };
    ws.write(Some("lost-response"), request()).unwrap();
    assert_eq!(ws.inbox(100, 0).unwrap().len(), 1);
    ws.write(Some("lost-response"), request()).unwrap();
    assert_eq!(ws.inbox(100, 0).unwrap().len(), 1);
    ws.write(Some("new-occurrence"), request()).unwrap();
    assert_eq!(ws.inbox(100, 0).unwrap().len(), 2);
}

#[test]
fn workspace_info_reports_location_counts_size_and_format() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    workspace.create_ticket("Kept").unwrap();
    let trashed = workspace.create_ticket("Trashed").unwrap();
    workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();
    workspace.create_project("Core", "/tmp/core").unwrap();
    workspace.create_plan("Active").unwrap();
    let archived = workspace.create_plan("Old").unwrap();
    workspace
        .change_plan(&archived.id, None, Some(true))
        .unwrap();

    let info = workspace.workspace_info().unwrap();
    // Compare files, not spellings: Windows reports the path as opened (which may
    // use 8.3 short names), while canonicalize returns a `\\?\` long-name path.
    assert_eq!(
        std::path::Path::new(&info.path).canonicalize().unwrap(),
        path.canonicalize().unwrap()
    );
    assert_eq!(info.tickets, 1);
    assert_eq!(info.projects, 1);
    assert_eq!(info.active_plans, 1);
    assert_eq!(i64::from(info.format_version), FORMAT_VERSION);
    assert_eq!(info.size_bytes, std::fs::metadata(&path).unwrap().len());
    assert!(info.size_bytes > 0);
}

#[test]
fn sidebar_counts_follow_readiness_rules_and_unread_inbox() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let set = |w: &mut Workspace, reference: &str, status: Status| {
        w.change_ticket(
            reference,
            TicketPatch {
                status: Some(status),
                ..Default::default()
            },
        )
        .unwrap();
    };
    let blocker = w.create_ticket("Blocker").unwrap();
    let blocked = w.create_ticket("Blocked").unwrap();
    let canceled_blocker = w.create_ticket("Canceled blocker").unwrap();
    let after_canceled = w.create_ticket("After canceled").unwrap();
    let trashed = w.create_ticket("Trashed").unwrap();
    let active = w.create_ticket("Active").unwrap();
    let trashed_active = w.create_ticket("Trashed active").unwrap();
    w.add_dependency(&blocker.reference, &blocked.reference, None)
        .unwrap();
    w.add_dependency(&canceled_blocker.reference, &after_canceled.reference, None)
        .unwrap();
    set(&mut w, &canceled_blocker.reference, Status::Canceled);
    set(&mut w, &active.reference, Status::InProgress);
    set(&mut w, &trashed_active.reference, Status::InProgress);
    w.set_trashed(&trashed.reference, true, None).unwrap();
    w.set_trashed(&trashed_active.reference, true, None)
        .unwrap();
    // Only the unblocked Todo "Blocker" is Ready: "Blocked" waits for it, only Done
    // satisfies a dependency (so "After canceled" stays blocked), trashed tickets are excluded.
    let counts = w.sidebar_counts().unwrap();
    assert_eq!((counts.ready, counts.in_progress), (1, 1));
    assert_eq!(counts.unread_inbox, 0);

    // Finishing the blocker removes it from Ready and releases "Blocked".
    set(&mut w, &blocker.reference, Status::Done);
    assert_eq!(w.sidebar_counts().unwrap().ready, 1);

    w.set_following(&active.reference, true).unwrap();
    set(&mut w, &active.reference, Status::InReview);
    set(&mut w, &active.reference, Status::Done);
    let counts = w.sidebar_counts().unwrap();
    assert_eq!(counts.unread_inbox, 2);
    assert_eq!(counts.in_progress, 0);
    let ids: Vec<i64> = w
        .inbox(100, 0)
        .unwrap()
        .iter()
        .map(|entry| entry.id)
        .collect();
    w.set_inbox_read(&ids, true).unwrap();
    assert_eq!(w.sidebar_counts().unwrap().unread_inbox, 0);
}

#[test]
fn unread_inbox_filter_pages_over_unread_entries_only() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Busy ticket").unwrap();
    workspace.set_following(&ticket.reference, true).unwrap();
    for status in [
        Status::InProgress,
        Status::InReview,
        Status::Done,
        Status::Canceled,
    ] {
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    status: Some(status),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let all = workspace.inbox(100, 0).unwrap();
    assert_eq!(all.len(), 4);
    // Read the first and third newest so unread and read entries interleave.
    workspace
        .set_inbox_read(&[all[0].id, all[2].id], true)
        .unwrap();

    let first = workspace.inbox_page(1, 0, true).unwrap();
    let second = workspace.inbox_page(1, 1, true).unwrap();
    let third = workspace.inbox_page(1, 2, true).unwrap();
    assert_eq!(first.iter().map(|e| e.id).collect::<Vec<_>>(), [all[1].id]);
    assert_eq!(second.iter().map(|e| e.id).collect::<Vec<_>>(), [all[3].id]);
    assert!(third.is_empty());
    assert!(first.iter().chain(&second).all(|entry| !entry.read));
    let everything = workspace.inbox_page(100, 0, false).unwrap();
    assert_eq!(everything.len(), 4);
    assert_eq!(everything, workspace.inbox(100, 0).unwrap());
}

#[test]
fn last_backup_records_successes_and_ignores_failures() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    assert_eq!(workspace.last_backup().unwrap(), None);

    let first = dir.path().join("first.sqlite3");
    workspace.backup(&first).unwrap();
    let recorded = workspace.last_backup().unwrap().unwrap();
    assert_eq!(
        recorded.path,
        first.canonicalize().unwrap().display().to_string()
    );
    assert!(recorded.completed_at.ends_with('Z'));

    // An existing file is refused and the previous record stays.
    assert!(workspace.backup(&first).is_err());
    assert_eq!(workspace.last_backup().unwrap().unwrap(), recorded);

    let second = dir.path().join("second.sqlite3");
    workspace.backup(&second).unwrap();
    assert_eq!(
        workspace.last_backup().unwrap().unwrap().path,
        second.canonicalize().unwrap().display().to_string()
    );
}

#[test]
fn backup_and_export_name_an_existing_file_instead_of_blaming_the_directory() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let existing = dir.path().join("existing.sqlite3");
    std::fs::write(&existing, b"keep me").unwrap();
    for error in [
        workspace.backup(&existing).unwrap_err().to_string(),
        workspace.export_file(&existing).unwrap_err().to_string(),
    ] {
        assert!(error.contains("a file already exists at"), "{error}");
        assert!(error.contains("existing.sqlite3"), "{error}");
        assert!(!error.contains("workspace directory"), "{error}");
    }
    assert_eq!(std::fs::read(&existing).unwrap(), b"keep me");
}

#[test]
fn backup_reports_that_it_was_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    assert!(workspace.backup(dir.path().join("b.sqlite3")).unwrap());
}

#[test]
fn restoring_keeps_the_last_backup_record_from_before_the_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let older = dir.path().join("older.sqlite3");
    let newer = dir.path().join("newer.sqlite3");
    let workspace = Workspace::open(&path).unwrap();
    workspace.backup(&older).unwrap();
    workspace.backup(&newer).unwrap();
    let recorded = workspace.last_backup().unwrap().unwrap();
    drop(workspace);
    // The older file holds a record that predates the newer backup.
    Workspace::restore(&path, &older).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.last_backup().unwrap().unwrap(), recorded);
}

#[test]
fn a_replacement_that_became_a_cycle_since_the_preview_is_a_stale_review() {
    use ticketd_core::{DependencyChoice, DependencyDecision, Error};
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = ws.create_ticket("Duplicate").unwrap();
    let canonical = ws.create_ticket("Canonical").unwrap();
    let dependent = ws.create_ticket("Dependent").unwrap();
    ws.add_dependency(&source.reference, &dependent.reference, None)
        .unwrap();
    let preview = ws
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    assert!(preview.replacement_issues.iter().all(Option::is_none));
    let decisions = preview
        .edges
        .iter()
        .cloned()
        .map(|edge| DependencyDecision {
            edge,
            choice: DependencyChoice::Replace,
        })
        .collect();
    // An unrelated edit, perhaps from the CLI, makes the replacement circular.
    ws.add_dependency(&dependent.reference, &canonical.reference, None)
        .unwrap();
    let error = ws
        .mark_duplicate_reviewed(
            &source.reference,
            &canonical.reference,
            &preview.canonical,
            decisions,
            None,
        )
        .unwrap_err();
    assert!(matches!(error, Error::DependencyReviewChanged), "{error}");
}

#[test]
fn a_prerequisite_is_unresolved_until_it_is_done() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let waiting = ws.create_ticket("Waiting").unwrap();
    let mut blockers = Vec::new();
    for (title, status) in [
        ("Review", Status::InReview),
        ("Canceled", Status::Canceled),
        ("Finished", Status::Done),
    ] {
        let blocker = ws.create_ticket(title).unwrap();
        ws.change_ticket(
            &blocker.reference,
            TicketPatch {
                status: Some(status),
                ..Default::default()
            },
        )
        .unwrap();
        ws.add_dependency(&blocker.reference, &waiting.reference, None)
            .unwrap();
        blockers.push(blocker.reference);
    }
    let prerequisites = ws.show_ticket(&waiting.reference).unwrap().prerequisites;
    let unresolved: Vec<_> = prerequisites
        .iter()
        .map(|item| (item.reference.clone(), item.unresolved))
        .collect();
    assert_eq!(
        unresolved,
        vec![
            (blockers[0].clone(), true),
            (blockers[1].clone(), true),
            (blockers[2].clone(), false)
        ]
    );
}

// Clippy only exempts #[test] functions, not the helpers they call.
#[allow(clippy::unwrap_used)]
fn set_status(workspace: &mut Workspace, reference: &str, status: Status) {
    workspace
        .change_ticket(
            reference,
            TicketPatch {
                status: Some(status),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn marking_duplicate_sets_the_duplicate_status_and_link_together() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let marked = workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    assert_eq!(marked.status, Status::Duplicate);
    assert_eq!(
        marked.duplicate_of.as_deref(),
        Some(target.reference.as_str())
    );
    let history = workspace.ticket_history(&source.reference).unwrap();
    assert!(
        history
            .iter()
            .any(|e| e.kind == "status" && e.from_value == "Todo" && e.to_value == "Duplicate")
    );
    assert!(!history.iter().any(|e| e.to_value == "Canceled"));
    assert_eq!("Duplicate".parse::<Status>().unwrap(), Status::Duplicate);
}

#[test]
fn choosing_duplicate_without_a_canonical_is_rejected_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Lonely").unwrap();
    let error = workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::Duplicate),
                title: Some("Renamed".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("canonical ticket"));
    let unchanged = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(unchanged.status, Status::Todo);
    assert_eq!(unchanged.title, "Lonely");
}

#[test]
fn leaving_duplicate_removes_the_link_and_keeps_the_chosen_status() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    set_status(&mut workspace, &source.reference, Status::InReview);
    workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    set_status(&mut workspace, &source.reference, Status::InProgress);
    let left = workspace.show_ticket(&source.reference).unwrap();
    assert_eq!(left.status, Status::InProgress);
    assert_eq!(left.duplicate_of, None);
    assert!(
        workspace
            .show_ticket(&target.reference)
            .unwrap()
            .duplicates
            .is_empty()
    );
    assert!(
        workspace
            .ticket_history(&source.reference)
            .unwrap()
            .iter()
            .any(|e| e.kind == "relationship:duplicate"
                && e.from_value == target.reference
                && e.to_value.is_empty())
    );
    // Undo after leaving has nothing to remove and keeps the chosen status.
    workspace.remove_duplicate(&source.reference, None).unwrap();
    assert_eq!(
        workspace.show_ticket(&source.reference).unwrap().status,
        Status::InProgress
    );
    // Choosing Duplicate again while already Duplicate keeps the designation.
    workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    set_status(&mut workspace, &source.reference, Status::Duplicate);
    assert_eq!(
        workspace
            .show_ticket(&source.reference)
            .unwrap()
            .duplicate_of
            .as_deref(),
        Some(target.reference.as_str())
    );
    workspace.remove_duplicate(&source.reference, None).unwrap();
    assert_eq!(
        workspace.show_ticket(&source.reference).unwrap().status,
        Status::InProgress
    );
}

#[test]
fn a_duplicate_blocker_stays_unresolved_and_is_neither_ready_nor_blocked() {
    use ticketd_core::{Availability, DependencyChoice, DependencyDecision, TicketFilter};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_ticket("Duplicate").unwrap();
    let canonical = workspace.create_ticket("Canonical").unwrap();
    let dependent = workspace.create_ticket("Dependent").unwrap();
    workspace
        .add_dependency(&source.reference, &dependent.reference, None)
        .unwrap();
    let preview = workspace
        .preview_duplicate_dependencies(&source.reference, &canonical.reference)
        .unwrap();
    let decisions = preview
        .edges
        .iter()
        .map(|edge| DependencyDecision {
            edge: edge.clone(),
            choice: DependencyChoice::Retain,
        })
        .collect();
    workspace
        .mark_duplicate_reviewed(
            &source.reference,
            &canonical.reference,
            &preview.canonical,
            decisions,
            None,
        )
        .unwrap();
    assert!(!Status::Duplicate.satisfies_dependency());
    let find = |availability| {
        workspace
            .find_tickets(&TicketFilter {
                availability: Some(availability),
                ..Default::default()
            })
            .unwrap()
            .into_iter()
            .map(|t| t.reference)
            .collect::<Vec<_>>()
    };
    assert!(!find(Availability::Ready).contains(&source.reference));
    assert!(!find(Availability::Blocked).contains(&source.reference));
    assert!(!find(Availability::Ready).contains(&dependent.reference));
    assert!(find(Availability::Blocked).contains(&dependent.reference));
}

#[test]
fn plan_progress_counts_duplicates_separately() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let canceled = workspace.create_ticket("Canceled").unwrap();
    for ticket in [&source, &target, &canceled] {
        workspace
            .set_plan(&ticket.reference, Some(&plan.id), None)
            .unwrap();
    }
    set_status(&mut workspace, &canceled.reference, Status::Canceled);
    workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    let counts = workspace.show_plan(&plan.id).unwrap().counts;
    assert_eq!((counts.duplicate, counts.canceled, counts.todo), (1, 1, 1));
}

#[test]
fn duplicate_status_survives_export_and_backup_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let backup = dir.path().join("backup.db");
    let mut workspace = Workspace::open(&path).unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    workspace
        .mark_duplicate(&source.reference, &target.reference, None)
        .unwrap();
    let export = workspace.export().unwrap();
    let exported = export["tickets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == source.id)
        .unwrap();
    assert_eq!(exported["status"], "Duplicate");
    workspace.backup(&backup).unwrap();
    set_status(&mut workspace, &source.reference, Status::Done);
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    let restored = workspace.show_ticket(&source.reference).unwrap();
    assert_eq!(restored.status, Status::Duplicate);
    assert_eq!(restored.duplicate_of, Some(target.reference));
}

#[test]
fn workflow_order_and_status_counts_describe_the_same_filtered_result() {
    use ticketd_core::{StatusCounts, TicketFilter, TicketOrder};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let mut make = |title: &str, status: Status| {
        let ticket = w.create_ticket(title).unwrap();
        set_status(&mut w, &ticket.reference, status);
        ticket.reference
    };
    let todo_old = make("Todo old", Status::Todo);
    let done = make("Done", Status::Done);
    let review = make("Review", Status::InReview);
    let progress = make("Progress", Status::InProgress);
    let canceled = make("Canceled", Status::Canceled);
    let todo_new = make("Todo new", Status::Todo);
    let trashed = make("Trashed progress", Status::InProgress);
    w.set_trashed(&trashed, true, None).unwrap();
    let grouped = TicketFilter {
        order: TicketOrder::Workflow,
        ..Default::default()
    };
    let order: Vec<_> = w
        .find_tickets(&grouped)
        .unwrap()
        .into_iter()
        .map(|ticket| ticket.reference)
        .collect();
    assert_eq!(
        order,
        [progress, review, todo_new.clone(), todo_old, done, canceled]
    );
    assert_eq!(
        w.count_tickets(&grouped).unwrap(),
        StatusCounts {
            todo: 2,
            in_progress: 1,
            in_review: 1,
            done: 1,
            canceled: 1,
            duplicate: 0,
        }
    );
    // Paging walks the grouped order, and the counts ignore the page.
    let second_page = TicketFilter {
        limit: 2,
        offset: 2,
        ..grouped.clone()
    };
    let page = w.find_tickets(&second_page).unwrap();
    assert_eq!(page[0].reference, todo_new);
    assert_eq!(w.count_tickets(&second_page).unwrap().total(), 6);
    // A filter narrows both the same way.
    let query = TicketFilter {
        query: "todo".into(),
        ..grouped
    };
    assert_eq!(w.find_tickets(&query).unwrap().len(), 2);
    assert_eq!(w.count_tickets(&query).unwrap().todo, 2);
    assert_eq!(w.count_tickets(&query).unwrap().total(), 2);
}

/// Build a version-20 workspace holding every legacy duplicate shape, then open it so
/// migration step 21 runs.
#[test]
fn legacy_canceled_duplicates_migrate_deliberately() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let mut workspace = Workspace::open(&path).unwrap();
    let canonical = workspace.create_ticket("Canonical").unwrap();
    let ordinary = workspace.create_ticket("Ordinary canceled").unwrap();
    let plain = workspace.create_ticket("Marked from in progress").unwrap();
    let independent = workspace.create_ticket("Canceled again later").unwrap();
    let moved_on = workspace.create_ticket("Moved on").unwrap();
    for t in [&ordinary, &plain, &independent, &moved_on] {
        set_status(&mut workspace, &t.reference, Status::InProgress);
    }
    set_status(&mut workspace, &ordinary.reference, Status::Canceled);
    for t in [&plain, &independent, &moved_on] {
        workspace
            .mark_duplicate(&t.reference, &canonical.reference, None)
            .unwrap();
    }
    drop(workspace);
    // Rewrite to the legacy shape: duplicates were Canceled plus a link.
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE tickets SET status = 'Canceled' WHERE id IN (?1, ?2, ?3)",
        [&plain.id, &independent.id, &moved_on.id],
    )
    .unwrap();
    // Independent later status changes cleared the remembered status.
    db.execute(
        "UPDATE duplicate_tickets SET restore_status = NULL WHERE source_id IN (?1, ?2)",
        [&independent.id, &moved_on.id],
    )
    .unwrap();
    db.execute(
        "UPDATE tickets SET status = 'Done' WHERE id = ?1",
        [&moved_on.id],
    )
    .unwrap();
    db.execute_batch("DROP TABLE publication_attempts; DROP TABLE source_status; DROP TABLE source_conversation; DROP TABLE source_configurations; DROP TABLE external_duplicate_targets; DROP TABLE source_sync; DROP TABLE external_ownership; DROP TABLE external_identities; ALTER TABLE activities RENAME COLUMN brief TO content; ALTER TABLE activities RENAME COLUMN reported_at TO created_at; ALTER TABLE activities RENAME TO notes; PRAGMA user_version = 20;")
        .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_ticket(&ordinary.reference).unwrap().status,
        Status::Canceled
    );
    let plain_now = workspace.show_ticket(&plain.reference).unwrap();
    assert_eq!(plain_now.status, Status::Duplicate);
    assert_eq!(
        plain_now.duplicate_of.as_deref(),
        Some(canonical.reference.as_str())
    );
    assert_eq!(
        workspace
            .show_ticket(&independent.reference)
            .unwrap()
            .status,
        Status::Duplicate
    );
    let moved_now = workspace.show_ticket(&moved_on.reference).unwrap();
    assert_eq!(moved_now.status, Status::Done);
    assert_eq!(moved_now.duplicate_of, None);
    assert_eq!(
        workspace
            .show_ticket(&canonical.reference)
            .unwrap()
            .duplicates,
        vec![plain.reference.clone(), independent.reference.clone()]
    );
    // History survives and records what the migration did.
    let history = workspace.ticket_history(&plain.reference).unwrap();
    assert!(
        history
            .iter()
            .any(|e| e.kind == "relationship:duplicate" && e.to_value == canonical.reference)
    );
    assert!(
        history
            .iter()
            .any(|e| e.kind == "status" && e.from_value == "Canceled" && e.to_value == "Duplicate")
    );
    let history = workspace.ticket_history(&moved_on.reference).unwrap();
    assert!(history.iter().any(|e| e.kind == "relationship:duplicate"
        && e.from_value == canonical.reference
        && e.to_value.is_empty()));
    // Undo returns to the status before marking, or to Canceled when that had been chosen
    // independently.
    workspace.remove_duplicate(&plain.reference, None).unwrap();
    assert_eq!(
        workspace.show_ticket(&plain.reference).unwrap().status,
        Status::InProgress
    );
    workspace
        .remove_duplicate(&independent.reference, None)
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&independent.reference)
            .unwrap()
            .status,
        Status::Canceled
    );
}

mod duplicate_review_outcomes {
    // Helpers here set up and read back fixtures; a failure should abort the test, as unwrap
    // does inside a #[test] function, which Clippy permits but not in these shared helpers.
    #![allow(clippy::unwrap_used)]
    use ticketd_core::{
        DependencyChoice, DependencyDecision, DuplicateDependencyPreview, Error, Readiness,
        ReviewMode, Status, TicketPatch, WaitingOutcome, Workspace,
    };

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        (dir, ws)
    }

    /// Creates T-1 (the duplicate), T-2 (the canonical) and `others` more tickets.
    fn tickets(ws: &mut Workspace, others: usize) {
        for title in ["Duplicate", "Canonical"] {
            ws.create_ticket(title).unwrap();
        }
        for n in 0..others {
            ws.create_ticket(&format!("Other {n}")).unwrap();
        }
    }

    fn set_status(ws: &mut Workspace, reference: &str, status: Status) {
        let patch = TicketPatch {
            status: Some(status),
            ..Default::default()
        };
        ws.change_ticket(reference, patch).unwrap();
    }

    fn block(ws: &mut Workspace, blocker: &str, dependent: &str) {
        ws.add_dependency(blocker, dependent, None).unwrap();
    }

    fn decide(
        preview: &DuplicateDependencyPreview,
        choices: &[(&str, &str, DependencyChoice)],
    ) -> Vec<DependencyDecision> {
        preview
            .edges
            .iter()
            .map(|edge| DependencyDecision {
                edge: edge.clone(),
                choice: choices
                    .iter()
                    .find(|(b, d, _)| *b == edge.blocker && *d == edge.dependent)
                    .map_or(DependencyChoice::Retain, |(_, _, choice)| choice.clone()),
            })
            .collect()
    }

    fn outcome(outcomes: &[WaitingOutcome], ticket: &str) -> WaitingOutcome {
        outcomes
            .iter()
            .find(|o| o.ticket == ticket)
            .unwrap()
            .clone()
    }

    fn evaluate(
        ws: &Workspace,
        preview: &DuplicateDependencyPreview,
        decisions: &[DependencyDecision],
    ) -> Vec<WaitingOutcome> {
        ws.evaluate_dependency_review("T-1", "T-2", preview.mode, decisions)
            .unwrap()
    }

    fn availability(ws: &Workspace, reference: &str) -> Option<String> {
        ws.show_ticket(reference).unwrap().availability
    }

    #[test]
    fn outcomes_judge_all_choices_together_and_match_what_apply_does() {
        use DependencyChoice::{Remove, Replace};
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        // T-1 (duplicate) blocks canonical T-2, and T-3 blocks T-1.
        block(&mut ws, "T-1", "T-2");
        block(&mut ws, "T-3", "T-1");
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        assert_eq!(preview.source, "T-1");
        assert_eq!(preview.mode, ReviewMode::Duplicate);
        let decisions = decide(&preview, &[("T-1", "T-2", Remove), ("T-3", "T-1", Replace)]);
        let outcomes = evaluate(&ws, &preview, &decisions);
        // Removing T-1's edge alone would make T-2 Ready, but Replace gives it T-3.
        let canonical = outcome(&outcomes, "T-2");
        assert_eq!(canonical.before, Readiness::Blocked);
        assert_eq!(canonical.after, Readiness::Blocked);
        assert_eq!(canonical.unresolved_after, ["T-3"]);
        assert_eq!(outcome(&outcomes, "T-1").after, Readiness::NoReadyState);

        ws.mark_duplicate_reviewed("T-1", "T-2", &preview.canonical, decisions, None)
            .unwrap();
        assert_eq!(availability(&ws, "T-2").as_deref(), Some("Blocked"));
        // What is left to wait for is what the outcome said, not just the label.
        let applied: Vec<String> = ws
            .show_ticket("T-2")
            .unwrap()
            .prerequisites
            .into_iter()
            .filter(|p| p.unresolved)
            .map(|p| p.reference)
            .collect();
        assert_eq!(applied, canonical.unresolved_after);
    }

    #[test]
    fn canonical_readiness_is_reported_when_the_duplicate_is_the_dependent() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        block(&mut ws, "T-3", "T-1");
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let replaced = decide(&preview, &[("T-3", "T-1", DependencyChoice::Replace)]);
        let canonical = outcome(&evaluate(&ws, &preview, &replaced), "T-2");
        assert_eq!(canonical.before, Readiness::Ready);
        assert_eq!(canonical.after, Readiness::Blocked);
        assert_eq!(canonical.unresolved_after, ["T-3"]);
        let kept = decide(&preview, &[]);
        assert_eq!(
            outcome(&evaluate(&ws, &preview, &kept), "T-2").after,
            Readiness::Ready
        );
    }

    #[test]
    fn a_replacement_that_is_already_done_leaves_the_dependent_ready() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        block(&mut ws, "T-1", "T-3");
        set_status(&mut ws, "T-2", Status::Done);
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let decisions = decide(&preview, &[("T-1", "T-3", DependencyChoice::Replace)]);
        let dependent = outcome(&evaluate(&ws, &preview, &decisions), "T-3");
        assert_eq!(dependent.before, Readiness::Blocked);
        assert_eq!(dependent.after, Readiness::Ready);
        assert!(dependent.unresolved_after.is_empty());
    }

    #[test]
    fn other_blockers_stay_listed_and_a_started_or_trashed_dependent_has_no_ready_state() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 4);
        block(&mut ws, "T-1", "T-3");
        block(&mut ws, "T-4", "T-3");
        block(&mut ws, "T-1", "T-5");
        block(&mut ws, "T-1", "T-6");
        set_status(&mut ws, "T-5", Status::InProgress);
        ws.set_trashed("T-6", true, None).unwrap();
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let remove = |dependent: &'static str| ("T-1", dependent, DependencyChoice::Remove);
        let decisions = decide(&preview, &[remove("T-3"), remove("T-5"), remove("T-6")]);
        let outcomes = evaluate(&ws, &preview, &decisions);
        let blocked = outcome(&outcomes, "T-3");
        assert_eq!(blocked.after, Readiness::Blocked);
        assert_eq!(blocked.unresolved_after, ["T-4"]);
        let started = outcome(&outcomes, "T-5");
        assert_eq!(
            (started.status, started.after),
            (Status::InProgress, Readiness::NoReadyState)
        );
        let trashed = outcome(&outcomes, "T-6");
        assert!(trashed.trashed);
        assert_eq!(
            (trashed.before, trashed.after),
            (Readiness::NoReadyState, Readiness::NoReadyState)
        );
        // The detail view agrees: a trashed ticket has no Ready indicator either.
        assert_eq!(availability(&ws, "T-6"), None);
    }

    #[test]
    fn a_separate_review_does_not_cancel_the_existing_endpoint() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        block(&mut ws, "T-1", "T-3");
        set_status(&mut ws, "T-1", Status::Done);
        let separate = ws.preview_dependency_move("T-1", "T-2").unwrap();
        assert_eq!(separate.mode, ReviewMode::Separate);
        let kept = decide(&separate, &[]);
        assert_eq!(
            outcome(&evaluate(&ws, &separate, &kept), "T-3").after,
            Readiness::Ready
        );
        let duplicate = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let kept = decide(&duplicate, &[]);
        assert_eq!(
            outcome(&evaluate(&ws, &duplicate, &kept), "T-3").after,
            Readiness::Blocked
        );
    }

    #[test]
    fn a_preview_applied_in_the_other_mode_is_rejected_with_its_own_error() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        block(&mut ws, "T-1", "T-3");
        let duplicate = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let decisions = decide(&duplicate, &[("T-1", "T-3", DependencyChoice::Remove)]);
        let error = ws
            .edit_dependencies_reviewed("T-1", "T-2", &duplicate.canonical, decisions.clone(), None)
            .unwrap_err();
        assert!(matches!(error, Error::DependencyReviewMode(_)), "{error}");
        assert!(error.to_string().contains("different kind of review"));
        let error = ws
            .evaluate_dependency_review("T-1", "T-2", ReviewMode::Separate, &decisions)
            .unwrap_err();
        assert!(matches!(error, Error::DependencyReviewMode(_)), "{error}");
        // Nothing was applied, and the matching mode still works.
        ws.mark_duplicate_reviewed("T-1", "T-2", &duplicate.canonical, decisions, None)
            .unwrap();
    }

    #[test]
    fn a_change_to_anything_the_outcomes_depend_on_is_stale_but_unrelated_edits_are_not() {
        type Change = fn(&mut Workspace);
        let changes: [(&str, Change); 3] = [
            // The replacement is In progress when previewed and Done by apply time.
            ("canonical status", |ws| set_status(ws, "T-2", Status::Done)),
            ("other blocker status", |ws| {
                set_status(ws, "T-4", Status::Done)
            }),
            ("dependent status", |ws| {
                set_status(ws, "T-3", Status::InProgress)
            }),
        ];
        for (name, change) in changes {
            let (_dir, mut ws) = workspace();
            tickets(&mut ws, 3);
            block(&mut ws, "T-1", "T-3");
            block(&mut ws, "T-4", "T-3");
            set_status(&mut ws, "T-2", Status::InProgress);
            let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
            let decisions = decide(&preview, &[("T-1", "T-3", DependencyChoice::Replace)]);
            change(&mut ws);
            let error = ws
                .mark_duplicate_reviewed("T-1", "T-2", &preview.canonical, decisions, None)
                .unwrap_err();
            assert!(
                matches!(error, Error::DependencyReviewChanged),
                "{name}: {error}"
            );
            assert_eq!(
                ws.show_ticket("T-1").unwrap().status,
                Status::Todo,
                "{name}"
            );
        }

        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 3);
        block(&mut ws, "T-1", "T-3");
        block(&mut ws, "T-4", "T-3");
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let decisions = decide(&preview, &[("T-1", "T-3", DependencyChoice::Remove)]);
        set_status(&mut ws, "T-5", Status::Done);
        ws.mark_duplicate_reviewed("T-1", "T-2", &preview.canonical, decisions, None)
            .unwrap();
    }

    #[test]
    fn the_preview_names_the_normalized_source_and_refuses_an_oversized_review() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        let preview = ws.preview_dependency_move("T-01", "T-2").unwrap();
        assert_eq!(preview.source, "T-1");
        for n in 0..1001 {
            let dependent = ws.create_ticket(&format!("Dependent {n}")).unwrap();
            block(&mut ws, "T-1", &dependent.reference);
        }
        let error = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap_err();
        assert!(matches!(error, Error::InvalidBatch(_)), "{error}");
    }

    #[test]
    fn the_preview_lists_each_dependent_with_its_current_status_and_readiness() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 3);
        block(&mut ws, "T-1", "T-3");
        block(&mut ws, "T-1", "T-4");
        block(&mut ws, "T-5", "T-4");
        set_status(&mut ws, "T-5", Status::Done);
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let rows: Vec<_> = preview
            .waiting
            .iter()
            .map(|w| {
                (
                    w.ticket.as_str(),
                    w.status,
                    w.readiness,
                    w.unresolved.clone(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (
                    "T-3",
                    Status::Todo,
                    Readiness::Blocked,
                    vec!["T-1".to_string()]
                ),
                (
                    "T-4",
                    Status::Todo,
                    Readiness::Blocked,
                    vec!["T-1".to_string()]
                ),
            ]
        );
        // The baseline is the detail view's answer.
        assert_eq!(availability(&ws, "T-3").as_deref(), Some("Blocked"));
    }

    #[test]
    fn a_trashed_ticket_has_no_ready_state_in_detail_graph_and_context() {
        use ticketd_core::ContextOptions;
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        block(&mut ws, "T-2", "T-3"); // a blocked, trashed Todo
        ws.set_trashed("T-1", true, None).unwrap(); // an unblocked, trashed Todo
        ws.set_trashed("T-3", true, None).unwrap();
        for reference in ["T-1", "T-3"] {
            let detail = ws.show_ticket(reference).unwrap().availability;
            let context = ws
                .ticket_context(reference, ContextOptions::default())
                .unwrap()
                .ticket
                .availability;
            let graph = ws
                .dependency_graph(reference)
                .unwrap()
                .nodes
                .into_iter()
                .find(|n| n.reference == reference)
                .unwrap()
                .availability;
            assert_eq!((detail, context, graph), (None, None, None), "{reference}");
        }
        ws.set_trashed("T-3", false, None).unwrap();
        assert_eq!(availability(&ws, "T-3").as_deref(), Some("Blocked"));
    }

    #[test]
    fn trashed_endpoints_and_the_same_ticket_are_reported_before_apply() {
        use ticketd_core::ReplacementIssue;
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 2);
        block(&mut ws, "T-1", "T-3");
        block(&mut ws, "T-4", "T-1");
        ws.set_trashed("T-3", true, None).unwrap();
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        // Replace would add T-2 -> T-3, which cannot be done to a trashed ticket.
        assert_eq!(
            preview.replacement_issues[0],
            Some(ReplacementIssue::Trashed)
        );
        assert_eq!(preview.replacement_issues[1], None);

        let error = ws.preview_duplicate_dependencies("T-1", "T-1").unwrap_err();
        assert!(matches!(error, Error::ReviewSameTicket), "{error}");
        let error = ws.preview_dependency_move("T-01", "T-1").unwrap_err();
        assert!(matches!(error, Error::ReviewSameTicket), "{error}");

        // A trashed canonical fails whatever the choices, so a duplicate review says so now.
        ws.set_trashed("T-2", true, None).unwrap();
        let error = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap_err();
        assert!(matches!(error, Error::Trashed(_)), "{error}");
        // A separate review only needs to add edges, so each Replace is marked instead.
        let separate = ws.preview_dependency_move("T-1", "T-2").unwrap();
        assert_eq!(
            separate.replacement_issues[1],
            Some(ReplacementIssue::Trashed)
        );
    }

    #[test]
    fn a_replacement_that_became_impossible_is_a_changed_review_when_evaluating_too() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        block(&mut ws, "T-1", "T-3");
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let decisions = decide(&preview, &[("T-1", "T-3", DependencyChoice::Replace)]);
        evaluate(&ws, &preview, &decisions);
        // An unrelated edit makes T-2 -> T-3 circular; no readiness input changed.
        block(&mut ws, "T-3", "T-2");
        let error = ws
            .evaluate_dependency_review("T-1", "T-2", preview.mode, &decisions)
            .unwrap_err();
        assert!(matches!(error, Error::DependencyReviewChanged), "{error}");
    }

    #[test]
    fn the_canonical_only_matters_to_the_review_when_a_replace_uses_it() {
        let (_dir, mut ws) = workspace();
        tickets(&mut ws, 1);
        block(&mut ws, "T-1", "T-3");
        let preview = ws.preview_duplicate_dependencies("T-1", "T-2").unwrap();
        let remove = decide(&preview, &[("T-1", "T-3", DependencyChoice::Remove)]);
        let replace = decide(&preview, &[("T-1", "T-3", DependencyChoice::Replace)]);
        set_status(&mut ws, "T-2", Status::Done);
        let error = ws
            .evaluate_dependency_review("T-1", "T-2", preview.mode, &replace)
            .unwrap_err();
        assert!(matches!(error, Error::DependencyReviewChanged), "{error}");
        ws.mark_duplicate_reviewed("T-1", "T-2", &preview.canonical, remove, None)
            .unwrap();
    }
}

#[test]
fn subticket_progress_counts_every_subticket_not_only_the_first_page() {
    use ticketd_core::ContextOptions;
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let parent = w.create_ticket("Parent").unwrap();
    for number in 0..30 {
        let child = w.create_ticket(&format!("Child {number}")).unwrap();
        w.set_parent(&child.reference, Some(&parent.reference), None)
            .unwrap();
        if number < 25 {
            set_status(&mut w, &child.reference, Status::Done);
        }
    }
    let relationships = w
        .ticket_context(
            &parent.reference,
            ContextOptions {
                relationships: true,
                ..Default::default()
            },
        )
        .unwrap()
        .relationships
        .unwrap();
    assert_eq!(relationships.children.items.len(), 20, "one page is read");
    assert_eq!(relationships.children_progress.total, 30);
    assert_eq!(relationships.children_progress.done, 25);
}

#[test]
fn status_counts_serialize_their_total_so_clients_never_sum_them() {
    let counts = ticketd_core::StatusCounts {
        todo: 2,
        in_progress: 1,
        in_review: 0,
        done: 3,
        canceled: 1,
        duplicate: 1,
    };
    let value = serde_json::to_value(counts).unwrap();
    assert_eq!(value["total"], 8);
    assert_eq!(value["duplicate"], 1);
}

#[test]
fn plan_can_be_created_with_only_a_name() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    assert_eq!(plan.name, "Launch");
    assert!(workspace.show_plan(&plan.id).unwrap().members.is_empty());
}

#[test]
fn plan_purpose_can_be_edited_and_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    assert_eq!(plan.purpose, "");
    workspace.set_plan_purpose(&plan.id, "Ship safely").unwrap();
    drop(workspace);
    let workspace = Workspace::open(path).unwrap();
    assert_eq!(
        workspace.show_plan(&plan.id).unwrap().plan.purpose,
        "Ship safely"
    );
}

#[test]
fn ticket_created_in_plan_is_a_member_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let ticket = workspace
        .create_ticket_in_context("Work", None, Some(&plan.id))
        .unwrap();
    assert_eq!(ticket.plan_id.as_deref(), Some(plan.id.as_str()));
    assert!(
        workspace
            .create_ticket_in_context("Invalid", None, Some("missing"))
            .is_err()
    );
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
}

#[test]
fn legacy_workspace_is_rejected_without_deleting_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE efforts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO efforts VALUES ('old', 'Existing'); PRAGMA user_version = 29;").unwrap();
    drop(connection);
    let error = match Workspace::open(&path) {
        Ok(_) => panic!("legacy workspace unexpectedly opened"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("previous Effort schema"));
    let connection = rusqlite::Connection::open(&path).unwrap();
    let name: String = connection
        .query_row("SELECT name FROM efforts WHERE id = 'old'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(name, "Existing");
}

#[test]
fn dependency_graph_reports_hub_omissions_and_can_recenter() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("hub.sqlite")).unwrap();
    let hub = workspace.create_ticket("Hub").unwrap();
    let mut leaves = Vec::new();
    for _ in 0..55 {
        let leaf = workspace.create_ticket("Leaf").unwrap();
        workspace
            .add_dependency(&hub.reference, &leaf.reference, None)
            .unwrap();
        leaves.push(leaf);
    }
    let graph = workspace.dependency_graph(&hub.reference).unwrap();
    assert!(graph.truncated);
    assert!(graph.omitted_neighbors);
    assert_eq!(graph.nodes.len(), graph.max_nodes);
    assert_eq!(graph.edges.len(), graph.nodes.len() - 1);
    let recentered = workspace.dependency_graph(&leaves[54].reference).unwrap();
    assert!(
        recentered
            .nodes
            .iter()
            .any(|node| node.reference == hub.reference)
    );
}

#[test]
fn dependency_graph_reports_omitted_edges_in_dense_graph() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("dense.sqlite")).unwrap();
    let tickets: Vec<_> = (0..26)
        .map(|_| workspace.create_ticket("Node").unwrap())
        .collect();
    for i in 0..tickets.len() {
        for j in i + 1..tickets.len() {
            workspace
                .add_dependency(&tickets[i].reference, &tickets[j].reference, None)
                .unwrap();
        }
    }
    let graph = workspace.dependency_graph(&tickets[0].reference).unwrap();
    assert_eq!(graph.nodes.len(), 26);
    assert_eq!(graph.edges.len(), graph.max_edges);
    assert!(graph.omitted_edges);
    assert!(graph.truncated);
}

#[test]
fn activity_feed_interleaves_reports_and_automatic_events_with_bounded_pages() {
    use ticketd_core::ActivityFeedEntry;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Outcome").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    let report = workspace
        .add_activity(&ticket.reference, "First finding", Some("agent"))
        .unwrap();
    let page = workspace.activity_feed(&ticket.reference, 1, 0).unwrap();
    assert_eq!(page.len(), 1);
    assert!(
        matches!(&page[0], ActivityFeedEntry::Authored { activity } if activity.id == report.id)
    );
    let older = workspace.activity_feed(&ticket.reference, 1, 1).unwrap();
    assert!(
        matches!(&older[0], ActivityFeedEntry::Automatic { event, .. } if event.to_value == "In progress")
    );
}

#[test]
fn plan_dependency_graph_includes_external_blockers_without_changing_scope() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("plan-graph.sqlite")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let first = workspace.create_project("First", "/first").unwrap();
    let second = workspace.create_project("Second", "/second").unwrap();
    let member = workspace
        .create_ticket_in_project("Member", Some(&first.id))
        .unwrap();
    let other = workspace
        .create_ticket_in_project("Other member", Some(&second.id))
        .unwrap();
    let outside = workspace.create_ticket("Outside").unwrap();
    workspace
        .set_plan(&member.reference, Some(&plan.id), None)
        .unwrap();
    workspace
        .set_plan(&other.reference, Some(&plan.id), None)
        .unwrap();
    workspace
        .add_dependency(&outside.reference, &member.reference, None)
        .unwrap();
    let graph = workspace.plan_dependency_graph(&plan.id).unwrap();
    assert_eq!(graph.nodes.len(), 3);
    assert!(
        graph
            .nodes
            .iter()
            .any(|n| n.reference == outside.reference && n.boundary)
    );
    assert!(graph.nodes.iter().any(|n| n.reference == member.reference
        && !n.boundary
        && n.availability.as_deref() == Some("Blocked")));
    // A member that blocks an outside ticket shows that ticket too.
    let waiting = workspace.create_ticket("Waiting outside").unwrap();
    workspace
        .add_dependency(&member.reference, &waiting.reference, None)
        .unwrap();
    let graph = workspace.plan_dependency_graph(&plan.id).unwrap();
    assert!(
        graph
            .nodes
            .iter()
            .any(|n| n.reference == waiting.reference && n.boundary)
    );
    assert_eq!(graph.total_members, Some(2));
    workspace
        .remove_dependency(&member.reference, &waiting.reference, None)
        .unwrap();
    assert_eq!(workspace.show_plan(&plan.id).unwrap().counts.todo, 2);
    assert!(
        workspace
            .add_dependency(&member.reference, &outside.reference, None)
            .is_err()
    );
    workspace
        .change_ticket(
            &outside.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    let graph = workspace.plan_dependency_graph(&plan.id).unwrap();
    assert!(
        graph
            .nodes
            .iter()
            .any(|n| n.reference == member.reference && n.availability.as_deref() == Some("Ready"))
    );
    workspace
        .change_ticket(
            &other.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    let counts = workspace.show_plan(&plan.id).unwrap().counts;
    assert_eq!((counts.todo, counts.done), (1, 1));
}

#[test]
fn plan_graph_discloses_omissions_and_cycle_validation_uses_full_graph() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("bounded-plan.sqlite")).unwrap();
    let plan = workspace.create_plan("Large Plan").unwrap();
    let mut tickets: Vec<String> = Vec::new();
    for i in 0..55 {
        let ticket = workspace.create_ticket(&format!("Ticket {i}")).unwrap();
        workspace
            .set_plan(&ticket.reference, Some(&plan.id), None)
            .unwrap();
        if let Some(previous) = tickets.last() {
            workspace
                .add_dependency(previous, &ticket.reference, None)
                .unwrap();
        }
        tickets.push(ticket.reference);
    }
    let graph = workspace.plan_dependency_graph(&plan.id).unwrap();
    assert!(graph.omitted_neighbors);
    assert_eq!(graph.nodes.len(), 50);
    assert_eq!(graph.total_members, Some(55));
    assert!(
        workspace
            .add_dependency(&tickets[54], &tickets[0], None)
            .is_err()
    );
}

#[test]
fn blank_briefs_made_of_whitespace_entities_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Updates").unwrap();
    for brief in ["", "  \n", "&#x20;\n&#x20;", "&nbsp; \u{200b}"] {
        assert!(
            workspace
                .add_activity(&ticket.reference, brief, None)
                .is_err(),
            "{brief:?} should be blank"
        );
    }
    assert!(
        workspace
            .add_activity(&ticket.reference, "&amp; done", None)
            .is_ok()
    );
}

#[test]
fn a_ticket_is_not_mentioned_in_itself() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Self").unwrap();
    workspace
        .add_activity(&ticket.reference, "Relates to T-1 itself", None)
        .unwrap();
    assert!(workspace.backlinks("T-1", 20, 0).unwrap().is_empty());
}

#[test]
fn the_author_is_not_notified_and_deleted_updates_read_as_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Follow").unwrap();
    workspace.set_following(&ticket.reference, true).unwrap();
    let own = workspace
        .add_activity(&ticket.reference, "My own update", None)
        .unwrap();
    workspace.discard_inbox_for_own_update(&own.id).unwrap();
    assert!(workspace.inbox(100, 0).unwrap().is_empty());
    let agent = workspace
        .add_activity(&ticket.reference, "Agent update", Some("claude"))
        .unwrap();
    let entries = workspace.inbox(100, 0).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].read && !entries[0].deleted);
    workspace
        .delete_activity(&ticket.reference, &agent.id)
        .unwrap();
    let entries = workspace.inbox(100, 0).unwrap();
    assert!(entries[0].read && entries[0].deleted);
}

#[test]
fn dependency_graph_shows_blockers_of_a_ticket_with_many_dependents() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("many.sqlite")).unwrap();
    let hub = workspace.create_ticket("Hub").unwrap();
    for _ in 0..60 {
        let dependent = workspace.create_ticket("Dependent").unwrap();
        workspace
            .add_dependency(&hub.reference, &dependent.reference, None)
            .unwrap();
    }
    let blocker = workspace.create_ticket("Blocker").unwrap();
    workspace
        .add_dependency(&blocker.reference, &hub.reference, None)
        .unwrap();
    let graph = workspace.dependency_graph(&hub.reference).unwrap();
    assert!(graph.nodes.iter().any(|n| n.reference == blocker.reference));
    let again = workspace.dependency_graph(&hub.reference).unwrap();
    let refs = |g: &ticketd_core::DependencyGraph| {
        g.nodes
            .iter()
            .map(|n| n.reference.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(refs(&graph), refs(&again));
}
