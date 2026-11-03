use ticketd_core::{DocumentPatch, Workspace};

#[test]
fn document_fields_survive_restart_and_edits_do_not_change_recent_order() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace
        .create_document(None, "\nFirst thought\n")
        .unwrap();
    let second = workspace.create_document(Some("Second"), "Body").unwrap();
    workspace.open_document(&first.id).unwrap();
    workspace
        .change_document(
            &second.id,
            DocumentPatch {
                title: None,
                body: Some("Updated".into()),
            },
        )
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .recent_documents()
            .unwrap()
            .iter()
            .map(|d| d.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.id.as_str(), second.id.as_str()]
    );
    assert_eq!(
        workspace.show_document(&first.id).unwrap().body,
        "\nFirst thought\n"
    );
    assert_eq!(
        workspace
            .show_document(&second.id)
            .unwrap()
            .title
            .as_deref(),
        Some("Second")
    );
    assert_eq!(workspace.show_document(&second.id).unwrap().body, "Updated");
}

#[test]
fn retry_and_export_preserve_document_identity_and_markdown() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let request = || WriteRequest::CreateDocument {
        title: None,
        body: "# Source\n\n- [ ] Work\n".into(),
    };
    let first = workspace.write(Some("capture-1"), request()).unwrap();
    let second = workspace.write(Some("capture-1"), request()).unwrap();
    assert_eq!(first, second);
    let WriteResult::Document(document) = first else {
        panic!("expected document")
    };
    assert_eq!(workspace.recent_documents().unwrap().len(), 1);
    let export = workspace.export().unwrap();
    assert_eq!(export["documents"][0]["id"], document.id);
    assert_eq!(export["documents"][0]["body"], "# Source\n\n- [ ] Work\n");
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored = Workspace::open(&backup).unwrap();
    assert_eq!(
        restored.show_document(&document.id).unwrap().body,
        "# Source\n\n- [ ] Work\n"
    );
}

#[test]
fn replayed_patch_can_clear_title_without_replacing_body() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let doc = workspace.create_document(Some("Old"), "Keep this").unwrap();
    let request: WriteRequest = serde_json::from_value(
        serde_json::json!({"operation":"change_document", "id":doc.id, "patch":{"title":null}}),
    )
    .unwrap();
    let WriteResult::Document(updated) = workspace.write(Some("clear-title"), request).unwrap()
    else {
        panic!("expected document")
    };
    assert_eq!(updated.title, None);
    assert_eq!(updated.body, "Keep this");
}

#[test]
fn creating_multiple_tickets_from_a_document_preserves_the_source_and_links() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace
        .create_document(Some("Investigation"), "Evidence remains here")
        .unwrap();
    let first = workspace
        .create_ticket_from_document(&source.id, "First task")
        .unwrap();
    let second = workspace
        .create_ticket_from_document(&source.id, "Second task")
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(workspace.show_document(&source.id).unwrap(), source);
    let links = workspace.document_backlinks(&source.id, 20, 0).unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].source_reference, first.reference);
    assert_eq!(links[1].source_reference, second.reference);
}

#[test]
fn editing_ticket_markdown_removes_document_backlinks() {
    use ticketd_core::TicketPatch;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_document(None, "Source").unwrap();
    let ticket = workspace
        .create_ticket_from_document(&source.id, "Task")
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some("No link".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        workspace
            .document_backlinks(&source.id, 20, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn retrying_create_ticket_from_document_does_not_duplicate_ticket() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = workspace.create_document(None, "Source").unwrap();
    let request = || WriteRequest::CreateTicketFromDocument {
        id: source.id.clone(),
        title: "Task".into(),
    };
    let first = workspace.write(Some("source-ticket"), request()).unwrap();
    let second = workspace.write(Some("source-ticket"), request()).unwrap();
    assert_eq!(first, second);
    assert!(matches!(first, WriteResult::Ticket(_)));
    assert_eq!(
        workspace
            .document_backlinks(&source.id, 20, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn document_references_are_indexed_in_both_directions_and_updated_with_markdown() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_document(Some("Target"), "Body").unwrap();
    let source = workspace
        .create_document(
            None,
            &format!("Reason: [target](ticketd://document/{})", target.id),
        )
        .unwrap();
    let links = workspace.context_links(&source.id, 20, 0).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_id, target.id);
    assert!(links[0].passage.starts_with("Reason:"));
    assert_eq!(
        workspace.context_backlinks(&target.id, 20, 0).unwrap()[0].source_id,
        source.id
    );
    workspace
        .change_document(
            &source.id,
            DocumentPatch {
                title: None,
                body: Some("Removed".into()),
            },
        )
        .unwrap();
    assert!(
        workspace
            .context_backlinks(&target.id, 20, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn document_ticket_mentions_create_backlinks_without_creating_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Task").unwrap();
    let document = workspace
        .create_document(None, &format!("Related to {}", ticket.reference))
        .unwrap();
    let links = workspace.context_backlinks(&ticket.id, 20, 0).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].source_id, document.id);
    assert!(
        workspace
            .show_ticket(&ticket.reference)
            .unwrap()
            .prerequisites
            .is_empty()
    );
}

#[test]
fn link_insertion_validates_target_identity() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Task").unwrap();
    let document = workspace.create_document(Some("Context"), "Body").unwrap();
    assert_eq!(
        workspace.context_link_markdown(&ticket.reference).unwrap(),
        format!(
            "[{}](ticketd://ticket/{})",
            ticket.reference, ticket.reference
        )
    );
    assert_eq!(
        workspace.context_link_markdown(&document.id).unwrap(),
        format!("[Document](ticketd://document/{})", document.id)
    );
    assert!(workspace.context_link_markdown("T-999999").is_err());
}

#[test]
fn trash_and_restore_preserve_document_across_restart_and_backup() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let doc = workspace
        .create_document(Some("Context"), "# Original\n")
        .unwrap();
    let request = || WriteRequest::TrashDocument { id: doc.id.clone() };
    let first = workspace.write(Some("trash"), request()).unwrap();
    assert_eq!(first, workspace.write(Some("trash"), request()).unwrap());
    assert!(workspace.recent_documents().unwrap().is_empty());
    assert!(workspace.open_document(&doc.id).unwrap().trashed);
    assert!(
        workspace
            .change_document(
                &doc.id,
                DocumentPatch {
                    title: None,
                    body: Some("lost".into())
                }
            )
            .is_err()
    );
    assert_eq!(workspace.trashed_documents().unwrap()[0].id, doc.id);
    assert_eq!(workspace.export().unwrap()["documents"][0]["trashed"], 1);
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&backup).unwrap();
    assert!(workspace.show_document(&doc.id).unwrap().trashed);
    let WriteResult::Document(restored) = workspace
        .write(None, WriteRequest::RestoreDocument { id: doc.id.clone() })
        .unwrap()
    else {
        panic!("expected document")
    };
    assert!(!restored.trashed);
    assert_eq!(restored.body, "# Original\n");
    assert_eq!(workspace.recent_documents().unwrap()[0].id, doc.id);
}

#[test]
fn trashed_document_links_remain_navigable_and_identify_trash() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_document(None, "Keep me").unwrap();
    let source = workspace
        .create_document(None, &format!("[source](ticketd://document/{})", target.id))
        .unwrap();
    workspace.set_document_trashed(&target.id, true).unwrap();
    assert!(workspace.context_links(&source.id, 20, 0).unwrap()[0].target_trashed);
    assert!(workspace.open_document(&target.id).unwrap().trashed);
    workspace.set_document_trashed(&target.id, false).unwrap();
    assert!(!workspace.context_links(&source.id, 20, 0).unwrap()[0].target_trashed);
}

#[test]
fn document_reference_cycles_are_allowed_without_implying_ticket_relationships() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let first = workspace.create_document(None, "first").unwrap();
    let second = workspace
        .create_document(None, &format!("[first](ticketd://document/{})", first.id))
        .unwrap();
    workspace
        .change_document(
            &first.id,
            DocumentPatch {
                title: None,
                body: Some(format!("[second](ticketd://document/{})", second.id)),
            },
        )
        .unwrap();
    assert_eq!(
        workspace.context_links(&first.id, 20, 0).unwrap()[0].target_id,
        second.id
    );
    assert_eq!(
        workspace.context_links(&second.id, 20, 0).unwrap()[0].target_id,
        first.id
    );
}

#[test]
fn context_passages_are_bounded_and_keep_the_link_visible() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_document(None, "target").unwrap();
    let body = format!(
        "{} [source](ticketd://document/{}) {}",
        "a".repeat(1000),
        target.id,
        "z".repeat(1000)
    );
    let source = workspace.create_document(None, &body).unwrap();
    let links = workspace.context_links(&source.id, 20, 0).unwrap();
    assert!(links[0].passage.chars().count() <= 512);
    assert!(links[0].passage.contains("[source]"));
}
