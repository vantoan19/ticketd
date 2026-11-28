#![allow(clippy::unwrap_used)] // Setup failures fail the test.

use ticketd_core::{AttachmentHome, AttachmentHomePlan, Status, TicketPatch, Workspace};

fn workspace_with_file() -> (tempfile::TempDir, Workspace, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let path = dir.path().join("evidence.txt");
    std::fs::write(&path, b"evidence").unwrap();
    let file = workspace
        .import_attachment("evidence", &path, None)
        .unwrap();
    let link = format!(
        "[Evidence]({})",
        workspace.attachment_uri(&file.id).unwrap()
    );
    (dir, workspace, file.id, link)
}

#[test]
fn files_prefer_direct_attachments_then_ticket_descriptions_then_update_details_then_documents() {
    let (_dir, mut workspace, file, link) = workspace_with_file();
    let document = workspace.create_document(Some("Log"), &link).unwrap();
    let update_ticket = workspace.create_ticket("Update").unwrap();
    let update = workspace
        .add_activity_with_details(
            &update_ticket.reference,
            "Progress",
            None,
            Some(&link),
            None,
        )
        .unwrap();
    let linked_ticket = workspace.create_ticket("Description").unwrap();
    workspace
        .change_ticket(
            &linked_ticket.reference,
            TicketPatch {
                body: Some(link),
                ..Default::default()
            },
        )
        .unwrap();
    let ticket = workspace.create_ticket("Attached").unwrap();
    let plan = workspace.create_plan("Release").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::InReview),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&plan.id), None)
        .unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file, true)
        .unwrap();

    assert_eq!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Ticket {
            id: ticket.id,
            reference: ticket.reference.clone(),
            title: "Attached".into(),
            status: Status::InReview,
            plan: Some(AttachmentHomePlan {
                id: plan.id,
                name: "Release".into(),
                archived: false,
            }),
        })
    );
    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();
    assert!(matches!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Ticket { reference, .. }) if reference == linked_ticket.reference
    ));
    workspace
        .set_trashed(&linked_ticket.reference, true, None)
        .unwrap();
    assert!(matches!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Ticket { reference, .. }) if reference == update_ticket.reference
    ));
    workspace
        .set_document_trashed(update.supporting_document_id.as_deref().unwrap(), true)
        .unwrap();
    assert_eq!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Document {
            id: document.id.clone(),
            title: "Log".into(),
            plan: None,
            spec: false,
        })
    );
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert_eq!(workspace.attachment_home(&file).unwrap(), None);
}

#[test]
fn equal_priority_references_keep_their_order_through_unrelated_markdown_edits() {
    let (_dir, mut workspace, file, link) = workspace_with_file();
    // Owner creation order differs from the order the link was added.
    let other = workspace.create_document(Some("Other"), "No file").unwrap();
    let first = workspace.create_document(Some("First"), &link).unwrap();
    let change_body = |workspace: &mut Workspace, id: &str, body: &str| {
        workspace
            .change_document(
                id,
                ticketd_core::DocumentPatch {
                    body: Some(body.into()),
                    ..Default::default()
                },
            )
            .unwrap();
    };
    change_body(&mut workspace, &other.id, &link);

    assert!(matches!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Document { id, .. }) if id == first.id
    ));
    change_body(
        &mut workspace,
        &first.id,
        &format!("Revised text\n\n{link}"),
    );
    assert!(matches!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Document { id, .. }) if id == first.id
    ));
    change_body(&mut workspace, &first.id, "Removed");
    change_body(&mut workspace, &first.id, &link);
    assert!(matches!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Document { id, .. }) if id == other.id
    ));
}

#[test]
fn drafts_and_undo_protect_unused_files_without_giving_them_a_home() {
    let (_dir, mut workspace, file, link) = workspace_with_file();
    assert_eq!(workspace.attachment_home(&file).unwrap(), None);
    assert!(workspace.attachment_usage(&file).unwrap().eligible);

    for kind in ["draft", "undo"] {
        workspace
            .retain_draft(&ticketd_core::DraftRetention {
                owner: kind.into(),
                kind: kind.into(),
                revision: 0,
                payload: None,
                markdown: vec![link.clone()],
            })
            .unwrap();
    }

    assert_eq!(workspace.attachment_home(&file).unwrap(), None);
    let usage = workspace.attachment_usage(&file).unwrap();
    assert!(!usage.eligible);
    assert_eq!(
        usage
            .protections
            .iter()
            .map(|protection| protection.kind.as_str())
            .collect::<Vec<_>>(),
        ["draft", "undo"]
    );
}

#[test]
fn a_document_home_names_its_active_plan_and_whether_it_is_the_spec() {
    let (_dir, mut workspace, file, link) = workspace_with_file();
    let plan = workspace.create_plan("Release").unwrap();
    let document = workspace.create_document(Some("Notes"), &link).unwrap();
    workspace
        .set_plan_document(&plan.id, &document.id, true)
        .unwrap();

    let expected = |spec| AttachmentHome::Document {
        id: document.id.clone(),
        title: "Notes".into(),
        plan: Some(AttachmentHomePlan {
            id: plan.id.clone(),
            name: "Release".into(),
            archived: false,
        }),
        spec,
    };
    assert_eq!(
        workspace.attachment_home(&file).unwrap(),
        Some(expected(false))
    );

    workspace
        .set_plan_spec(&plan.id, Some(&document.id))
        .unwrap();
    assert_eq!(
        workspace.attachment_home(&file).unwrap(),
        Some(expected(true))
    );
}

#[test]
fn trashed_update_tickets_do_not_own_files_in_unkept_details() {
    let (_dir, mut workspace, file, link) = workspace_with_file();
    let ticket = workspace.create_ticket("Update").unwrap();
    let update = workspace
        .add_activity_with_details(&ticket.reference, "Details", None, Some(&link), None)
        .unwrap();

    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();
    assert_eq!(workspace.attachment_home(&file).unwrap(), None);

    workspace
        .set_trashed(&ticket.reference, false, None)
        .unwrap();
    workspace
        .delete_activity(&ticket.reference, &update.id)
        .unwrap();
    assert!(matches!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Document { id, .. }) if update.supporting_document_id.as_deref() == Some(id.as_str())
    ));
}

#[test]
fn direct_attachments_tie_by_link_order() {
    let (_dir, mut workspace, file, _link) = workspace_with_file();
    let newer_link = workspace.create_ticket("Newer link").unwrap();
    let older_link = workspace.create_ticket("Older link").unwrap();
    for ticket in [&older_link, &newer_link] {
        workspace
            .set_ticket_attachment(&ticket.reference, &file, true)
            .unwrap();
    }

    assert!(matches!(
        workspace.attachment_home(&file).unwrap(),
        Some(AttachmentHome::Ticket { reference, .. }) if reference == older_link.reference
    ));
}
