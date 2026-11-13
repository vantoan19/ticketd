use serde_json::json;
use ticketd_core::{
    Status, TicketPatch, Workspace, WorkspaceActor, WorkspaceEvent, WorkspaceEventType,
    WriteRequest, WriteResult,
};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("events.sqlite3")).unwrap();
    (dir, workspace)
}

#[allow(clippy::unwrap_used)] // An unreadable log fails the test.
fn events_after(workspace: &Workspace, cursor: i64) -> Vec<WorkspaceEvent> {
    workspace.workspace_events_after(cursor, 100).unwrap()
}

#[test]
fn creating_a_ticket_logs_one_created_event_by_a_person() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();

    let events = events_after(&workspace, 0);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.kind, WorkspaceEventType::TicketCreated);
    assert_eq!(event.ticket_id, ticket.id);
    assert_eq!(event.actor, WorkspaceActor::Person);
    assert_eq!(event.previous, None);
    assert_eq!(
        event.current,
        Some(json!({
            "title": "Fix login", "body": "", "status": "Todo",
            "project_id": null, "plan_id": null,
        }))
    );
    assert!(chrono::DateTime::parse_from_rfc3339(&event.at).is_ok());
    assert_eq!(workspace.workspace_event_head().unwrap(), event.id);
}

#[test]
fn each_kind_of_ticket_change_logs_one_event_with_previous_and_current_values() {
    let (dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    let project = workspace
        .create_project("Website", dir.path().to_str().unwrap())
        .unwrap();
    let mut head = workspace.workspace_event_head().unwrap();
    let mut next = |workspace: &Workspace| {
        let events = events_after(workspace, head);
        assert_eq!(events.len(), 1, "{events:?}");
        head = events[0].id;
        let event = events.into_iter().next().unwrap();
        assert_eq!(event.ticket_id, ticket.id);
        assert_eq!(event.actor, WorkspaceActor::Person);
        (event.kind, event.previous, event.current)
    };
    let change = |workspace: &mut Workspace, patch: TicketPatch| {
        workspace.change_ticket(&ticket.reference, patch).unwrap();
    };

    change(
        &mut workspace,
        TicketPatch {
            title: Some("Fix sign-in".into()),
            ..Default::default()
        },
    );
    assert_eq!(
        next(&workspace),
        (
            WorkspaceEventType::TicketUpdated,
            Some(json!({"title": "Fix login"})),
            Some(json!({"title": "Fix sign-in"}))
        )
    );

    change(
        &mut workspace,
        TicketPatch {
            body: Some("Steps".into()),
            ..Default::default()
        },
    );
    assert_eq!(
        next(&workspace),
        (
            WorkspaceEventType::TicketUpdated,
            Some(json!({"body": ""})),
            Some(json!({"body": "Steps"}))
        )
    );

    change(
        &mut workspace,
        TicketPatch {
            project_id: Some(Some(project.id.clone())),
            ..Default::default()
        },
    );
    assert_eq!(
        next(&workspace),
        (
            WorkspaceEventType::TicketUpdated,
            Some(json!({"project_id": null})),
            Some(json!({"project_id": project.id}))
        )
    );

    change(
        &mut workspace,
        TicketPatch {
            status: Some(Status::InReview),
            ..Default::default()
        },
    );
    assert_eq!(
        next(&workspace),
        (
            WorkspaceEventType::TicketStatusChanged,
            Some(json!({"status": "Todo"})),
            Some(json!({"status": "In review"}))
        )
    );

    workspace.add_tag(&ticket.reference, "Ready").unwrap();
    assert_eq!(
        next(&workspace),
        (
            WorkspaceEventType::TicketTagAdded,
            None,
            Some(json!({"tag": "ready"}))
        )
    );

    workspace.remove_tag(&ticket.reference, "ready").unwrap();
    assert_eq!(
        next(&workspace),
        (
            WorkspaceEventType::TicketTagRemoved,
            Some(json!({"tag": "ready"})),
            None
        )
    );

    let activity = workspace
        .add_activity(&ticket.reference, "Reproduced on staging", Some("codex"))
        .unwrap();
    assert_eq!(
        next(&workspace),
        (
            WorkspaceEventType::ActivityCreated,
            None,
            Some(json!({
                "id": activity.id, "brief": "Reproduced on staging", "editing_agent": "codex",
            }))
        )
    );
}

#[test]
fn a_write_that_changes_nothing_logs_nothing() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace.add_tag(&ticket.reference, "ready").unwrap();
    let head = workspace.workspace_event_head().unwrap();

    workspace.add_tag(&ticket.reference, "ready").unwrap();
    workspace.remove_tag(&ticket.reference, "absent").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Fix login".into()),
                status: Some(Status::Todo),
                ..Default::default()
            },
        )
        .unwrap();

    assert_eq!(events_after(&workspace, head), []);
}

#[test]
fn a_change_that_fails_leaves_no_event() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    let head = workspace.workspace_event_head().unwrap();

    // The second operation fails, so the whole plan, title change included, is undone.
    let plan: Vec<ticketd_core::BatchOperation> = serde_json::from_value(json!([
        {"operation": "change", "ticket": ticket.reference, "change": {"title": "Renamed"}},
        {"operation": "change", "ticket": "T-KQ999", "change": {"title": "Missing"}},
    ]))
    .unwrap();
    assert!(workspace.apply_batch(plan).is_err());

    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().title,
        "Fix login"
    );
    assert_eq!(events_after(&workspace, head), []);
}

#[test]
fn a_ticket_created_with_content_and_tags_logs_created_and_one_tag_added_per_tag() {
    let (_dir, mut workspace) = workspace();
    let request: WriteRequest = serde_json::from_value(json!({
        "operation": "create_ticket_with_content",
        "title": "Complete creation",
        "body": "Details",
        "status": "In progress",
        "project_id": null,
        "plan_id": null,
        "tags": ["qa", "ready-for-triage"],
        "follow": false,
    }))
    .unwrap();
    let WriteResult::Ticket(ticket) = workspace.write(None, request).unwrap() else {
        panic!("expected a created ticket")
    };

    let events = events_after(&workspace, 0);
    let summary: Vec<_> = events
        .iter()
        .map(|event| (event.kind, event.current.clone()))
        .collect();
    assert_eq!(
        summary,
        [
            (
                WorkspaceEventType::TicketCreated,
                Some(json!({
                    "title": "Complete creation", "body": "Details", "status": "In progress",
                    "project_id": null, "plan_id": null,
                }))
            ),
            (
                WorkspaceEventType::TicketTagAdded,
                Some(json!({"tag": "qa"}))
            ),
            (
                WorkspaceEventType::TicketTagAdded,
                Some(json!({"tag": "ready-for-triage"}))
            ),
        ]
    );
    assert!(events.iter().all(|event| event.ticket_id == ticket.id));
}

#[test]
fn reading_after_a_cursor_returns_later_events_oldest_first_up_to_the_limit() {
    let (_dir, mut workspace) = workspace();
    for title in ["One", "Two", "Three"] {
        workspace.create_ticket(title).unwrap();
    }
    let all = events_after(&workspace, 0);
    assert_eq!(all.len(), 3);
    assert!(all[0].id < all[1].id && all[1].id < all[2].id);

    let page = workspace.workspace_events_after(all[0].id, 1).unwrap();
    assert_eq!(page, [all[1].clone()]);
    assert_eq!(events_after(&workspace, all[2].id), []);
}

#[test]
fn a_connection_acting_for_an_automation_logs_its_writes_as_automation() {
    let (dir, mut person) = workspace();
    let ticket = person.create_ticket("Fix login").unwrap();
    let head = person.workspace_event_head().unwrap();

    let mut agent = Workspace::open(dir.path().join("events.sqlite3")).unwrap();
    agent.act_for_automation().unwrap();
    agent.add_tag(&ticket.reference, "triaged").unwrap();
    agent
        .add_activity(&ticket.reference, "Triage done", Some("claude-code"))
        .unwrap();
    // The marker belongs to that connection only.
    person.add_tag(&ticket.reference, "seen").unwrap();

    let actors: Vec<_> = events_after(&person, head)
        .into_iter()
        .map(|event| (event.kind, event.actor))
        .collect();
    assert_eq!(
        actors,
        [
            (
                WorkspaceEventType::TicketTagAdded,
                WorkspaceActor::Automation
            ),
            (
                WorkspaceEventType::ActivityCreated,
                WorkspaceActor::Automation
            ),
            (WorkspaceEventType::TicketTagAdded, WorkspaceActor::Person),
        ]
    );
}

#[test]
fn the_upkeep_removes_only_events_older_than_90_days() {
    let (_dir, mut workspace) = workspace();
    workspace.create_ticket("Fix login").unwrap();
    let expired = events_after(&workspace, 0)[0].id;
    let logged_at =
        chrono::DateTime::parse_from_rfc3339(&events_after(&workspace, 0)[0].at).unwrap();
    let after = |duration: chrono::Duration| Some((logged_at + duration).to_rfc3339());

    let at_90_days = after(chrono::Duration::days(90));
    workspace.upkeep(at_90_days.as_deref()).unwrap();
    assert_eq!(events_after(&workspace, 0).len(), 1);

    let past_90_days = after(chrono::Duration::days(90) + chrono::Duration::seconds(1));
    workspace.upkeep(past_90_days.as_deref()).unwrap();
    assert_eq!(events_after(&workspace, 0), []);
    // Expiry does not move the head back, so a cursor kept from before stays valid.
    assert_eq!(workspace.workspace_event_head().unwrap(), expired);
    workspace.create_ticket("Next").unwrap();
    assert!(events_after(&workspace, expired)[0].id > expired);
}

#[test]
fn the_previous_format_and_its_backups_gain_the_event_log_without_losing_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("old-backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Kept").unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TRIGGER workspace_event_ticket_created;
         DROP TRIGGER workspace_event_ticket_updated;
         DROP TRIGGER workspace_event_ticket_status_changed;
         DROP TRIGGER workspace_event_ticket_tag_added;
         DROP TRIGGER workspace_event_ticket_tag_removed;
         DROP TRIGGER workspace_event_activity_created;
         DROP TABLE workspace_events;
         PRAGMA user_version = 66;",
    )
    .unwrap();
    db.execute("VACUUM INTO ?1", [backup.to_string_lossy()])
        .unwrap();
    drop(db);

    // Tickets that existed before the log are not announced as created.
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    assert_eq!(events_after(&workspace, 0), []);
    workspace.add_tag(&ticket.reference, "ready").unwrap();
    assert_eq!(events_after(&workspace, 0).len(), 1);
    drop(workspace);

    // A backup taken before the log existed still restores and then migrates on open.
    Workspace::restore(&path, &backup).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(events_after(&workspace, 0), []);
    workspace.add_tag(&ticket.reference, "ready").unwrap();
    assert_eq!(events_after(&workspace, 0).len(), 1);
}
