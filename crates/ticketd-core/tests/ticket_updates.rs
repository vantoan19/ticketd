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
        Some(format!("ticketd activity show T-KQ1 {}", long.id).as_str())
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

#[test]
fn saving_an_activity_unchanged_keeps_its_update_time() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("updates.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Progress").unwrap();
    let activity = workspace
        .add_activity(&ticket.reference, "Report", Some("agent"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    for patch in [
        ActivityPatch::default(),
        ActivityPatch {
            brief: Some("Report".into()),
            editing_agent: Some("agent".into()),
        },
    ] {
        let saved = workspace
            .edit_activity(&ticket.reference, &activity.id, patch)
            .unwrap();
        assert_eq!(saved.updated_at, activity.updated_at);
    }
}

#[test]
fn context_latest_update_bounds_the_editing_agent_like_every_other_label() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("updates.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Progress").unwrap();
    workspace
        .add_activity(&ticket.reference, "Report", Some(&"a".repeat(300)))
        .unwrap();
    let context = workspace
        .ticket_context(
            &ticket.reference,
            ticketd_core::ContextOptions {
                latest_update: true,
                ..Default::default()
            },
        )
        .unwrap();
    let agent =
        serde_json::to_value(context.latest_update.unwrap().unwrap()).unwrap()["editing_agent"]
            .clone();
    assert_eq!(agent["text"].as_str().unwrap().chars().count(), 256);
    assert_eq!(agent["truncated"], true);
}

#[test]
fn the_first_update_an_agent_wrote_is_found_without_reading_any_ticket() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("updates.sqlite3")).unwrap();
    assert!(workspace.first_agent_update().unwrap().is_none());
    let ticket = workspace.create_ticket("Progress").unwrap();
    workspace
        .add_activity(&ticket.reference, "Written by a person", None)
        .unwrap();
    assert!(workspace.first_agent_update().unwrap().is_none());
    let other = workspace.create_ticket("Other").unwrap();
    let first = workspace
        .add_activity(&other.reference, "Written by an agent", Some("codex"))
        .unwrap();
    workspace
        .add_activity(&ticket.reference, "Written later", Some("claude-code"))
        .unwrap();
    let found = workspace.first_agent_update().unwrap().unwrap();
    assert_eq!(found.reference, other.reference);
    assert_eq!(found.editing_agent, "codex");
    assert_eq!(found.reported_at, first.reported_at);
}

#[test]
fn send_back_moves_the_review_and_posts_the_persons_update_together() {
    use ticketd_core::{Error, Status, WriteRequest, WriteResult};

    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("reviews.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Review the rail").unwrap();
    let reference = ticket.reference.as_str();
    let send = |brief: &str| WriteRequest::SendBack {
        reference: reference.into(),
        brief: brief.into(),
    };
    assert!(matches!(
        workspace.write(Some("return"), send("Handle a narrow window.")),
        Err(Error::TicketChanged(_))
    ));
    assert!(workspace.activities(reference, 10, 0).unwrap().is_empty());
    assert!(workspace.ticket_history(reference).unwrap().is_empty());

    workspace
        .change_ticket(
            reference,
            TicketPatch {
                status: Some(Status::InReview),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(workspace.write(Some("return"), send("  ")).is_err());
    assert_eq!(
        workspace.show_ticket(reference).unwrap().status,
        Status::InReview
    );
    assert!(workspace.activities(reference, 10, 0).unwrap().is_empty());
    assert_eq!(workspace.ticket_history(reference).unwrap().len(), 1);

    let report = workspace
        .add_activity(reference, "Implemented the rail.", Some("codex"))
        .unwrap();
    let outcome = workspace
        .write(Some("return"), send("Handle a narrow window."))
        .unwrap();
    assert_eq!(
        workspace
            .write(Some("return"), send("Handle a narrow window."))
            .unwrap(),
        outcome
    );
    assert!(matches!(
        workspace.write(Some("return"), send("Something else")),
        Err(Error::RequestConflict(_))
    ));
    let updates = workspace.activities(reference, 10, 0).unwrap();
    assert_eq!(updates.len(), 2);
    assert_eq!(updates[1].brief, "Handle a narrow window.");
    assert!(updates[1].editing_agent.is_none());
    assert_eq!(
        workspace.show_ticket(reference).unwrap().status,
        Status::InProgress
    );
    let history = workspace.ticket_history(reference).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(
        (&*history[1].from_value, &*history[1].to_value),
        ("In review", "In progress")
    );

    let undo = || WriteRequest::UndoSendBack {
        reference: reference.into(),
        send_request_id: "return".into(),
    };
    let restored = workspace.write(Some("undo"), undo()).unwrap();
    assert_eq!(workspace.write(Some("undo"), undo()).unwrap(), restored);
    assert!(matches!(restored, WriteResult::Ticket(ticket) if ticket.status == Status::InReview));
    assert_eq!(
        workspace.activities(reference, 10, 0).unwrap(),
        vec![report]
    );
    assert_eq!(workspace.ticket_history(reference).unwrap().len(), 3);
    assert_eq!(
        workspace
            .write(Some("return"), send("Handle a narrow window."))
            .unwrap(),
        outcome
    );
    assert_eq!(
        workspace.show_ticket(reference).unwrap().status,
        Status::InReview
    );
}

#[test]
fn undo_send_back_preserves_a_later_status_change_and_an_edited_update() {
    use ticketd_core::{Error, Status, WriteRequest};

    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("reviews.sqlite3")).unwrap();
    for (suffix, edit) in [("status", false), ("update", true)] {
        let ticket = workspace.create_ticket("Review the rail").unwrap();
        let reference = ticket.reference.as_str();
        let change = |workspace: &mut Workspace, status| {
            workspace
                .change_ticket(
                    reference,
                    TicketPatch {
                        status: Some(status),
                        ..Default::default()
                    },
                )
                .unwrap();
        };
        change(&mut workspace, Status::InReview);
        workspace
            .write(
                Some(suffix),
                WriteRequest::SendBack {
                    reference: reference.into(),
                    brief: "Handle a narrow window.".into(),
                },
            )
            .unwrap();
        let update = workspace.latest_update(reference).unwrap().unwrap();
        if edit {
            workspace
                .edit_activity(
                    reference,
                    &update.activity_id,
                    ActivityPatch {
                        brief: Some("Handle a narrow window and improve keyboard focus.".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        } else {
            change(&mut workspace, Status::InReview);
            change(&mut workspace, Status::InProgress);
        }
        let history = workspace.ticket_history(reference).unwrap();
        let updates = workspace.activities(reference, 10, 0).unwrap();
        assert!(matches!(
            workspace.write(
                Some("undo"),
                WriteRequest::UndoSendBack {
                    reference: reference.into(),
                    send_request_id: suffix.into(),
                }
            ),
            Err(Error::TicketChanged(_))
        ));
        assert_eq!(
            workspace.show_ticket(reference).unwrap().status,
            Status::InProgress
        );
        assert_eq!(workspace.activities(reference, 10, 0).unwrap(), updates);
        assert_eq!(workspace.ticket_history(reference).unwrap(), history);
    }
}

#[test]
fn undo_done_applies_to_the_completion_that_offered_it() {
    use ticketd_core::{Error, Status, WriteRequest, WriteResult};

    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("reviews.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Review a change").unwrap();
    let reference = ticket.reference.as_str();
    let review = || TicketPatch {
        status: Some(Status::InReview),
        ..Default::default()
    };
    let complete = || WriteRequest::ChangeTicket {
        reference: reference.into(),
        patch: TicketPatch {
            expected_status: Some(Status::InReview),
            status: Some(Status::Done),
            ..Default::default()
        },
    };
    let undo = |number| WriteRequest::ChangeTicket {
        reference: reference.into(),
        patch: TicketPatch {
            expected_status: Some(Status::Done),
            expected_status_history_number: Some(number),
            status: Some(Status::InReview),
            ..Default::default()
        },
    };

    workspace.change_ticket(reference, review()).unwrap();
    let first = workspace.write(Some("complete-first"), complete()).unwrap();
    let WriteResult::Ticket(first_ticket) = &first else {
        panic!("completion returns a ticket");
    };
    let first_number = first_ticket.status_history_number.unwrap();
    workspace.change_ticket(reference, review()).unwrap();
    let WriteResult::Ticket(second_ticket) = workspace
        .write(Some("complete-second"), complete())
        .unwrap()
    else {
        panic!("completion returns a ticket");
    };
    let second_number = second_ticket.status_history_number.unwrap();
    assert_ne!(first_number, second_number);
    assert_eq!(
        workspace.write(Some("complete-first"), complete()).unwrap(),
        first
    );
    assert!(matches!(
        workspace.write(Some("undo-first"), undo(first_number)),
        Err(Error::TicketChanged(_))
    ));
    assert_eq!(
        workspace.show_ticket(reference).unwrap().status,
        Status::Done
    );

    workspace
        .change_ticket(
            reference,
            TicketPatch {
                title: Some("Title edited after completion".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let WriteResult::Ticket(restored) = workspace
        .write(Some("undo-second"), undo(second_number))
        .unwrap()
    else {
        panic!("Undo returns a ticket");
    };
    assert_eq!(restored.status, Status::InReview);
    assert_eq!(restored.title, "Title edited after completion");
}
