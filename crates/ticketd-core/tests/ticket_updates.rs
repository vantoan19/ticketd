use ticketd_core::{ActivityPatch, TicketFilter, TicketPatch, Workspace};

#[test]
fn list_and_detail_report_the_latest_authored_note_apart_from_other_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("updates.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Progress").unwrap();
    assert!(ticket.updated_at.is_some());
    assert!(ticket.latest_update.is_none());
    let first = workspace
        .add_activity(&ticket.reference, "First report", Some("agent-one"))
        .unwrap();
    let latest = workspace
        .add_activity(&ticket.reference, "Latest report", Some("agent-two"))
        .unwrap();
    workspace
        .edit_activity(
            &ticket.reference,
            &first.id,
            ActivityPatch {
                brief: Some("Edited the older note".into()),
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
    assert_eq!(summary.activity_id, latest.id);
    assert_eq!(summary.reported_at, latest.reported_at);
    assert_eq!(summary.editing_agent.as_deref(), Some("agent-two"));
    let listed = workspace.find_tickets(&TicketFilter::default()).unwrap();
    assert_eq!(listed[0].latest_update, shown.latest_update);
    workspace
        .delete_activity(&ticket.reference, &latest.id)
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(&ticket.reference)
            .unwrap()
            .latest_update
            .unwrap()
            .activity_id,
        first.id
    );
    assert_eq!(workspace.sidebar_counts().unwrap().total, 1);
}

#[test]
fn latest_progress_is_bounded_and_follows_insertion_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("updates.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Progress").unwrap();
    assert!(
        workspace
            .latest_update(&ticket.reference)
            .unwrap()
            .is_none()
    );
    let older = workspace
        .add_activity(&ticket.reference, "Older", None)
        .unwrap();
    let latest = workspace
        .add_activity(&ticket.reference, &"é".repeat(1025), Some("agent"))
        .unwrap();
    workspace
        .edit_activity(
            &ticket.reference,
            &older.id,
            ActivityPatch {
                brief: Some("Edited".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let summary = workspace.latest_update(&ticket.reference).unwrap().unwrap();
    assert_eq!(summary.activity_id, latest.id);
    assert_eq!(summary.brief.text.chars().count(), 1024);
    assert!(summary.brief.truncated);
    assert_eq!(summary.reported_at, latest.reported_at);
    assert_eq!(summary.updated_at, latest.updated_at);
    assert_eq!(summary.editing_agent.as_deref(), Some("agent"));
}

#[test]
fn filtered_page_and_reopened_workspace_preserve_latest_progress() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    workspace.create_ticket("Other").unwrap();
    let ticket = workspace.create_ticket("Matching").unwrap();
    let activity = workspace
        .add_activity(&ticket.reference, "Checkpoint", None)
        .unwrap();
    let filter = TicketFilter {
        query: "Matching".into(),
        limit: 1,
        ..Default::default()
    };
    let page = workspace.find_tickets_with_updates(&filter).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].ticket.reference, ticket.reference);
    assert_eq!(
        page[0].latest_update.as_ref().unwrap().activity_id,
        activity.id
    );
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .latest_update(&ticket.reference)
            .unwrap()
            .unwrap()
            .brief
            .text,
        "Checkpoint"
    );
}

#[test]
fn plan_filter_with_latest_updates_uses_one_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let filter = TicketFilter {
        plan: Some(plan.id.clone()),
        ..Default::default()
    };
    assert!(
        workspace
            .find_tickets_with_updates(&filter)
            .unwrap()
            .is_empty()
    );
    let ticket = workspace
        .create_ticket_in_context("Work", None, Some(&plan.id))
        .unwrap();
    workspace
        .add_activity(&ticket.reference, "Progress", None)
        .unwrap();
    let result = workspace.find_tickets_with_updates(&filter).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(
        result[0].latest_update.as_ref().unwrap().brief.text,
        "Progress"
    );
}

#[test]
fn ticket_context_pages_recent_reports_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    for n in 1..=22 {
        workspace
            .add_activity(&ticket.reference, &format!("Report {n}"), None)
            .unwrap();
    }
    let options = |offset| ticketd_core::ContextOptions {
        activities: true,
        offset,
        ..Default::default()
    };
    let first = workspace
        .ticket_context(&ticket.reference, options(0))
        .unwrap()
        .activities
        .unwrap();
    assert_eq!(first.items.len(), 20);
    assert_eq!(first.items[0].brief.text, "Report 22");
    assert_eq!(first.items[19].brief.text, "Report 3");
    assert_eq!(first.next_offset, Some(20));
    let next = workspace
        .ticket_context(&ticket.reference, options(20))
        .unwrap()
        .activities
        .unwrap();
    assert_eq!(next.items[0].brief.text, "Report 2");
    assert_eq!(next.items[1].brief.text, "Report 1");
    assert_eq!(next.next_offset, None);
}

#[test]
fn a_cut_short_brief_in_context_says_how_to_read_all_of_it() {
    use ticketd_core::{ContextOptions, Workspace};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("w.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Long").unwrap();
    let long = workspace
        .add_activity(&ticket.reference, &"x".repeat(5000), None)
        .unwrap();
    workspace
        .add_activity(&ticket.reference, "short", None)
        .unwrap();
    let context = workspace
        .ticket_context(
            &ticket.reference,
            ContextOptions {
                activities: true,
                ..Default::default()
            },
        )
        .unwrap();
    let items = context.activities.unwrap().items;
    assert_eq!(items[0].fetch_brief, None);
    assert_eq!(
        items[1].fetch_brief.as_deref(),
        Some(format!("ticketd activity show T-1 {}", long.id).as_str())
    );
}

#[test]
fn a_stale_editor_cannot_overwrite_a_description_changed_elsewhere() {
    use ticketd_core::Error;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("guard.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Guarded").unwrap();
    let change = |body: &str, expected: Option<&str>| TicketPatch {
        body: Some(body.into()),
        expected_body: expected.map(Into::into),
        ..Default::default()
    };
    workspace
        .change_ticket(&ticket.reference, change("Agent wrote this", None))
        .unwrap();
    let stale = workspace.change_ticket(&ticket.reference, change("My draft", Some("")));
    assert!(matches!(stale, Err(Error::TicketChanged(_))));
    assert!(stale.unwrap_err().to_string().contains("changed elsewhere"));
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().body,
        "Agent wrote this"
    );
    // A matching revision saves, and a change that omits it (the CLI) is unguarded.
    workspace
        .change_ticket(
            &ticket.reference,
            change("My draft", Some("Agent wrote this")),
        )
        .unwrap();
    workspace
        .change_ticket(&ticket.reference, change("CLI edit", None))
        .unwrap();
    // The title guard ignores a stale expectation for a field that is not changing.
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some("Again".into()),
                expected_title: Some("Old title".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let stale_title = workspace.change_ticket(
        &ticket.reference,
        TicketPatch {
            title: Some("Mine".into()),
            expected_title: Some("Old title".into()),
            ..Default::default()
        },
    );
    assert!(matches!(stale_title, Err(Error::TicketChanged(_))));
}
