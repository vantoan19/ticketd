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
fn search_tracks_edits_and_organization_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace
        .create_document(None, "\nA rare compass in the forest")
        .unwrap();
    let second = workspace
        .create_document(Some("Compass notes"), "other")
        .unwrap();
    workspace.set_document_pin(&first.id, true).unwrap();
    workspace
        .set_document_tag(&first.id, "research", true)
        .unwrap();
    assert_eq!(
        workspace
            .search_documents("compass", None, 10, 0)
            .unwrap()
            .len(),
        2
    );
    workspace
        .change_document(
            &second.id,
            DocumentPatch {
                title: Some(Some("Changed".into())),
                body: None,
            },
        )
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    let results = workspace
        .search_documents("compass", Some("research"), 1, 0)
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, first.id);
    assert!(results[0].snippet.contains("compass"));
    assert_eq!(workspace.pinned_documents(10, 0).unwrap()[0].id, first.id);
    assert_eq!(
        workspace
            .search_documents("compass", None, 1, 1)
            .unwrap()
            .len(),
        0
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
fn organization_writes_are_replayable_and_exported() {
    use ticketd_core::WriteRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let document = workspace.create_document(None, "Example").unwrap();
    let pin = || WriteRequest::SetDocumentPin {
        id: document.id.clone(),
        pinned: true,
    };
    assert_eq!(
        workspace.write(Some("pin"), pin()).unwrap(),
        workspace.write(Some("pin"), pin()).unwrap()
    );
    workspace
        .write(
            Some("tag"),
            WriteRequest::SetDocumentTag {
                id: document.id.clone(),
                tag: "  Research ".into(),
                present: true,
            },
        )
        .unwrap();
    assert_eq!(
        workspace.document_tags(&document.id).unwrap(),
        vec!["research"]
    );
    let export = workspace.export().unwrap();
    assert_eq!(export["document_pins"][0]["document_id"], document.id);
    assert_eq!(export["document_tags"][0]["tag_name"], "research");
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

#[test]
fn activity_details_are_atomic_hidden_and_preserved_on_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    let reference = ticket.reference;
    assert!(
        workspace
            .add_activity_with_details(&reference, " ", None, Some("details"), None)
            .is_err()
    );
    assert!(workspace.recent_documents().unwrap().is_empty());
    let activity = workspace
        .add_activity_with_details(&reference, "Progress", None, Some("# Evidence\n"), None)
        .unwrap();
    let id = activity.supporting_document_id.as_deref().unwrap();
    assert_eq!(workspace.show_document(id).unwrap().body, "# Evidence\n");
    assert_eq!(
        workspace.show_document(id).unwrap().origin_brief.as_deref(),
        Some("Progress")
    );
    assert!(workspace.recent_documents().unwrap().is_empty());
    let export = workspace.export().unwrap();
    assert_eq!(
        export["documents"][0]["originating_activity_id"],
        activity.id
    );
    let backup = dir.path().join("activity-backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored = Workspace::open(&backup).unwrap();
    assert_eq!(
        restored
            .activity(&reference, &activity.id)
            .unwrap()
            .supporting_document_id
            .as_deref(),
        Some(id)
    );
    assert_eq!(restored.show_document(id).unwrap().body, "# Evidence\n");
    workspace.delete_activity(&reference, &activity.id).unwrap();
    assert_eq!(workspace.show_document(id).unwrap().body, "# Evidence\n");
    assert_eq!(workspace.recent_documents().unwrap()[0].id, id);
}

#[test]
fn retry_replays_activity_and_its_details() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    let request = || WriteRequest::AddActivityWithDetails {
        reference: ticket.reference.clone(),
        brief: "Report".into(),
        agent: None,
        details: Some("Evidence".into()),
        existing_document_id: None,
    };
    let first = workspace.write(Some("report-1"), request()).unwrap();
    let second = workspace.write(Some("report-1"), request()).unwrap();
    assert_eq!(first, second);
    let WriteResult::Activity(activity) = first else {
        panic!("expected activity")
    };
    assert_eq!(
        workspace
            .show_document(activity.supporting_document_id.as_deref().unwrap())
            .unwrap()
            .body,
        "Evidence"
    );
    assert_eq!(
        workspace
            .activities(&ticket.reference, 100, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn shared_support_and_trash_preserve_briefs_and_existing_document_visibility() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    let document = workspace
        .create_document(Some("Investigation"), "Evidence")
        .unwrap();
    let one = workspace
        .add_activity_with_details(&ticket.reference, "First", None, None, Some(&document.id))
        .unwrap();
    let two = workspace
        .add_activity_with_details(&ticket.reference, "Second", None, None, Some(&document.id))
        .unwrap();
    assert_eq!(workspace.recent_documents().unwrap()[0].id, document.id);
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert_eq!(
        workspace
            .activity(&ticket.reference, &two.id)
            .unwrap()
            .brief,
        "Second"
    );
    workspace
        .delete_activity(&ticket.reference, &one.id)
        .unwrap();
    assert_eq!(
        workspace
            .activity(&ticket.reference, &two.id)
            .unwrap()
            .supporting_document_id
            .as_deref(),
        Some(document.id.as_str())
    );
    workspace.set_document_trashed(&document.id, false).unwrap();
    assert_eq!(
        workspace.show_document(&document.id).unwrap().body,
        "Evidence"
    );
    assert!(
        workspace
            .add_activity_with_details(&ticket.reference, "Failed", None, None, Some("missing"))
            .is_err()
    );
    assert_eq!(
        workspace
            .activities(&ticket.reference, 100, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn activity_support_is_searchable_when_included_and_indexes_references() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    let target = workspace.create_document(Some("Target"), "body").unwrap();
    let body = format!("rarecompass [target](ticketd://document/{})", target.id);
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Progress", None, Some(&body), None)
        .unwrap();
    let id = activity.supporting_document_id.unwrap();
    assert!(
        workspace
            .search_documents("rarecompass", None, 10, 0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        workspace
            .search_documents_including_support("rarecompass", None, 10, 0, true)
            .unwrap()[0]
            .id,
        id
    );
    assert_eq!(
        workspace.context_backlinks(&target.id, 20, 0).unwrap()[0].source_id,
        id
    );
    assert_eq!(
        workspace
            .latest_update(&ticket.reference)
            .unwrap()
            .unwrap()
            .supporting_document_id
            .as_deref(),
        Some(id.as_str())
    );
}

#[test]
fn keeping_activity_details_preserves_identity_and_makes_them_visible() {
    use ticketd_core::WriteRequest;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let ticket = w.create_ticket("Outcome").unwrap();
    let activity = w
        .add_activity_with_details(
            &ticket.reference,
            "Update",
            None,
            Some("unique detail"),
            None,
        )
        .unwrap();
    let id = activity.supporting_document_id.unwrap();
    w.open_document(&id).unwrap();
    assert!(
        w.search_documents("unique", None, 50, 0)
            .unwrap()
            .is_empty()
    );
    let included = w
        .search_documents_including_support("unique", None, 50, 0, true)
        .unwrap();
    assert_eq!(
        included[0].origin_ticket.as_deref(),
        Some(ticket.reference.as_str())
    );
    assert_eq!(
        w.recent_documents_including_support(50, 0, true).unwrap()[0].id,
        id
    );
    let request = || WriteRequest::KeepDocument { id: id.clone() };
    assert_eq!(
        w.write(Some("keep"), request()).unwrap(),
        w.write(Some("keep"), request()).unwrap()
    );
    drop(w);
    let mut w = Workspace::open(&path).unwrap();
    assert_eq!(w.search_documents("unique", None, 50, 0).unwrap()[0].id, id);
    assert_eq!(w.recent_documents().unwrap()[0].id, id);
    assert_eq!(w.export().unwrap()["documents"][0]["kept"], 1);
    let backup = dir.path().join("backup.sqlite3");
    w.backup(&backup).unwrap();
    let restored = Workspace::open(&backup).unwrap();
    assert_eq!(
        restored.search_documents("unique", None, 50, 0).unwrap()[0].id,
        id
    );
    drop(restored);
    w.delete_activity(&ticket.reference, &activity.id).unwrap();
    assert_eq!(w.show_document(&id).unwrap().body, "unique detail");
}
