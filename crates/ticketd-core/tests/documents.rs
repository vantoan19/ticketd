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
                ..Default::default()
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
        follow: false,
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
                ..Default::default()
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
                ..Default::default()
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
        format!("[Context](ticketd://document/{})", document.id)
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
                    body: Some("lost".into()),
                    ..Default::default()
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
                ..Default::default()
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

#[test]
fn activity_context_references_follow_edits_and_deletion() {
    use ticketd_core::ActivityPatch;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Source").unwrap();
    let doc = workspace.create_document(Some("Target"), "").unwrap();
    let activity = workspace
        .add_activity(
            &ticket.reference,
            &format!("See [target](ticketd://document/{})", doc.id),
            None,
        )
        .unwrap();
    let links = workspace.context_backlinks(&doc.id, 20, 0).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].activity_id.as_deref(), Some(activity.id.as_str()));
    workspace
        .edit_activity(
            &ticket.reference,
            &activity.id,
            ActivityPatch {
                brief: Some("No link".into()),
                editing_agent: None,
            },
        )
        .unwrap();
    assert!(
        workspace
            .context_backlinks(&doc.id, 20, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn activity_references_include_visible_link_text_and_disappear_on_delete() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let target = workspace.create_ticket("Target").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    let activity = workspace
        .add_activity(
            &source.reference,
            &format!("[{}](https://example.com)", target.reference),
            None,
        )
        .unwrap();
    let links = workspace.context_backlinks(&target.id, 20, 0).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].activity_id.as_deref(), Some(activity.id.as_str()));
    workspace
        .delete_activity(&source.reference, &activity.id)
        .unwrap();
    assert!(
        workspace
            .context_backlinks(&target.id, 20, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn trash_pages_return_bounded_summaries_and_open_retains_body() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let body = "long body".repeat(10000);
    let mut ids = Vec::new();
    for n in 0..3 {
        let doc = workspace
            .create_document(Some(&format!("Document {n}")), &body)
            .unwrap();
        workspace.set_document_trashed(&doc.id, true).unwrap();
        ids.push(doc.id);
    }
    let first = workspace.trashed_documents_page(2, 0).unwrap();
    let second = workspace.trashed_documents_page(2, 2).unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].id, second[0].id);
    assert_eq!(workspace.open_document(&ids[0]).unwrap().body, body);
}

#[test]
fn opened_untitled_document_exposes_its_bounded_heading() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let doc = workspace
        .create_document(None, "\nFirst line\nMore text")
        .unwrap();
    assert_eq!(
        workspace.open_document(&doc.id).unwrap().heading,
        "First line"
    );
}

#[test]
fn list_rows_carry_plain_snippet_tags_and_date_so_same_titled_documents_differ() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let first = workspace
        .create_document(
            Some("Plan"),
            "# Heading\n\n- **Bold** [link](ticketd://document/x) item\n\n```\ncode\n```",
        )
        .unwrap();
    let second = workspace.create_document(Some("Plan"), "Other").unwrap();
    workspace.set_document_tag(&first.id, "b", true).unwrap();
    workspace.set_document_tag(&first.id, "a", true).unwrap();
    workspace.open_document(&first.id).unwrap();
    workspace.open_document(&second.id).unwrap();
    let rows = workspace.recent_documents().unwrap();
    let row = rows.iter().find(|row| row.id == first.id).unwrap();
    assert_eq!(row.snippet, "Heading Bold link item");
    assert_eq!(row.tags, ["a", "b"]);
    assert!(!row.updated_at.is_empty());
    let found = workspace.search_documents("link", None, 10, 0).unwrap();
    assert!(found[0].snippet.contains("link item"));
}

#[test]
fn snippets_keep_literal_characters_and_drop_table_syntax() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let doc = workspace
        .create_document(
            Some("T"),
            "2\\*3\\*4 and \\[x]\n\n| a | b |\n|---|---|\n| 1 | 2 |",
        )
        .unwrap();
    let rows = workspace.all_documents_page(50, 0, false).unwrap();
    let row = rows.iter().find(|row| row.id == doc.id).unwrap();
    assert_eq!(row.snippet, "2*3*4 and [x] a b 1 2");
}

#[test]
fn heading_is_first_plain_text_line_without_markdown_markers() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let cases = [
        ("# Heading probe\n\nbody", "Heading probe"),
        (
            "\n\n- [ ] **Ship** the [report](https://x.test) now\n",
            "Ship the report now",
        ),
        ("2\\*3\\*4 \\[brackets]", "2*3*4 [brackets]"),
    ];
    for (body, expected) in cases {
        let document = workspace.create_document(None, body).unwrap();
        assert_eq!(document.heading, expected);
    }
    let long = workspace
        .create_document(None, &"word ".repeat(60))
        .unwrap();
    assert!(long.heading.chars().count() <= 120);
    let titled = workspace
        .create_document(Some("Explicit"), "# Other")
        .unwrap();
    assert_eq!(titled.heading, "Explicit");
    let blank = workspace.create_document(None, " \n").unwrap();
    assert_eq!(blank.heading, "Untitled");
}

#[test]
fn source_document_link_uses_the_documents_heading() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let document = workspace
        .create_document(None, "# Launch notes\nmore")
        .unwrap();
    let ticket = workspace
        .create_ticket_from_document(&document.id, "Follow up")
        .unwrap();
    assert_eq!(
        ticket.body,
        format!("[Launch notes](ticketd://document/{})", document.id)
    );
}

#[allow(clippy::unwrap_used)] // test setup
fn temp_workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    (dir, workspace)
}

#[test]
fn concurrent_document_changes_wait_instead_of_failing_busy() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let document = workspace.create_document(None, "Start").unwrap();
    drop(workspace);
    let failures: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|worker| {
                let (path, id) = (path.clone(), document.id.clone());
                scope.spawn(move || {
                    let mut workspace = Workspace::open(&path).unwrap();
                    (0..10)
                        .filter_map(|n| {
                            workspace
                                .change_document(
                                    &id,
                                    DocumentPatch {
                                        body: Some(format!("{worker}-{n}")),
                                        ..Default::default()
                                    },
                                )
                                .err()
                                .map(|error| error.to_string())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap())
            .collect()
    });
    assert!(failures.is_empty(), "{failures:?}");
}

#[test]
fn search_matches_partial_words_and_stays_safe_with_quotes() {
    let (_dir, mut workspace) = temp_workspace();
    workspace
        .create_document(Some("Meeting notes"), "Weekly sync log")
        .unwrap();
    for query in ["Meet", "meeting no", "lo", "\"Meet"] {
        assert_eq!(
            workspace
                .search_documents(query, None, 10, 0)
                .unwrap()
                .len(),
            1,
            "{query}"
        );
    }
    assert!(
        workspace
            .search_documents("zzz", None, 10, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn context_links_use_document_headings_and_accept_ticket_references() {
    let (_dir, mut workspace) = temp_workspace();
    let ticket = workspace.create_ticket("Task").unwrap();
    let untitled = workspace
        .create_document(None, "# Plain heading\nBody")
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            ticketd_core::TicketPatch {
                body: Some(format!("[x](ticketd://document/{})", untitled.id)),
                ..Default::default()
            },
        )
        .unwrap();
    let outgoing = workspace.context_links(&ticket.reference, 10, 0).unwrap();
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].target_label, "Plain heading");
    let incoming = workspace.context_backlinks(&untitled.id, 10, 0).unwrap();
    assert_eq!(incoming[0].source_label, "T-1");
    assert_eq!(incoming[0].target_label, "Plain heading");
}

#[test]
fn document_mentions_cover_link_text_and_tickets_created_later() {
    let (_dir, mut workspace) = temp_workspace();
    workspace.create_ticket("First").unwrap();
    let document = workspace
        .create_document(
            Some("Notes"),
            "See [T-1](https://example.com) and T-2 which does not exist yet",
        )
        .unwrap();
    let before: Vec<_> = workspace
        .context_links(&document.id, 10, 0)
        .unwrap()
        .into_iter()
        .map(|link| link.target_label)
        .collect();
    assert_eq!(before, ["T-1"]);
    let second = workspace.create_ticket("Second").unwrap();
    let mut after: Vec<_> = workspace
        .context_links(&document.id, 10, 0)
        .unwrap()
        .into_iter()
        .map(|link| link.target_label)
        .collect();
    after.sort();
    assert_eq!(after, ["T-1", "T-2"]);
    let back = workspace.document_backlinks(&document.id, 10, 0).unwrap();
    assert!(back.is_empty(), "documents are not ticket sources");
    let incoming = workspace.context_backlinks(&second.id, 10, 0).unwrap();
    assert_eq!(incoming.len(), 1);
}

#[test]
fn blank_activity_details_create_no_document_and_trashed_support_is_explained() {
    let (_dir, mut workspace) = temp_workspace();
    let ticket = workspace.create_ticket("Task").unwrap();
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Brief", None, Some("  \n"), None)
        .unwrap();
    assert_eq!(activity.supporting_document_id, None);
    let document = workspace.create_document(None, "Support").unwrap();
    workspace.set_document_trashed(&document.id, true).unwrap();
    let error = workspace
        .add_activity_with_details(&ticket.reference, "Again", None, None, Some(&document.id))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("in trash") && error.contains("document restore"),
        "{error}"
    );
}

#[test]
fn pinned_activity_details_are_listed_and_trashed_documents_cannot_join_plans() {
    let (_dir, mut workspace) = temp_workspace();
    let ticket = workspace.create_ticket("Task").unwrap();
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Brief", None, Some("Details"), None)
        .unwrap();
    let id = activity.supporting_document_id.unwrap();
    workspace.set_document_pin(&id, true).unwrap();
    assert_eq!(workspace.pinned_documents(10, 0).unwrap().len(), 1);
    let plan = workspace.create_plan("Plan").unwrap();
    workspace.set_document_trashed(&id, true).unwrap();
    let error = workspace
        .set_plan_document(&plan.id, &id, true)
        .unwrap_err()
        .to_string();
    assert!(error.contains("in trash"), "{error}");
}

#[test]
fn deleting_an_activity_keeps_a_kept_details_document_out_of_recents() {
    let (_dir, mut workspace) = temp_workspace();
    let ticket = workspace.create_ticket("Task").unwrap();
    let opened = workspace.create_document(None, "Opened").unwrap();
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Brief", None, Some("Kept details"), None)
        .unwrap();
    let id = activity.supporting_document_id.clone().unwrap();
    workspace.keep_document(&id).unwrap();
    workspace
        .delete_activity(&ticket.reference, &activity.id)
        .unwrap();
    assert_eq!(workspace.recent_documents().unwrap()[0].id, opened.id);
}

#[test]
fn ticket_created_from_a_document_can_be_followed() {
    let (_dir, mut workspace) = temp_workspace();
    let source = workspace.create_document(None, "Source").unwrap();
    let followed = workspace
        .create_ticket_from_document_following(&source.id, "Followed", true)
        .unwrap();
    let plain = workspace
        .create_ticket_from_document(&source.id, "Plain")
        .unwrap();
    assert!(workspace.is_following(&followed.reference).unwrap());
    assert!(!workspace.is_following(&plain.reference).unwrap());
}

#[test]
fn plan_context_flags_truncated_ticket_titles() {
    let (_dir, mut workspace) = temp_workspace();
    let plan = workspace.create_plan("Plan").unwrap();
    let ticket = workspace.create_ticket(&"t".repeat(300)).unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&plan.id), None)
        .unwrap();
    let context = workspace.plan_context(&plan.id, false).unwrap();
    assert_eq!(context["tickets"][0]["title_truncated"], true);
}

#[test]
fn stale_expected_revision_rejects_a_document_change() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let doc = workspace.create_document(None, "Original").unwrap();
    let patch = |body: &str, expected: &str| DocumentPatch {
        body: Some(body.into()),
        expected_updated_at: Some(expected.into()),
        ..Default::default()
    };
    workspace
        .change_document(&doc.id, patch("Elsewhere", &doc.updated_at))
        .unwrap();
    // Sleep past the millisecond clock so the revision visibly moves.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let current = workspace.show_document(&doc.id).unwrap();
    workspace
        .change_document(&doc.id, patch("Fresh", &current.updated_at))
        .unwrap();
    let error = workspace
        .change_document(&doc.id, patch("Stale", &current.updated_at))
        .unwrap_err();
    assert!(error.to_string().contains("changed elsewhere"));
    assert_eq!(workspace.show_document(&doc.id).unwrap().body, "Fresh");
}

#[test]
fn heading_keeps_literal_html_text() {
    use ticketd_core::derive_heading;
    assert_eq!(
        derive_heading("Use <b>bold</b> tags").as_deref(),
        Some("Use <b>bold</b> tags")
    );
    assert_eq!(
        derive_heading("<div>raw</div>").as_deref(),
        Some("<div>raw</div>")
    );
}

#[test]
fn an_update_brief_names_its_details_by_its_first_sentence() {
    use ticketd_core::derive_brief_heading;
    assert_eq!(
        derive_brief_heading("Fixed the parser in v1.2. Then reran everything.").as_deref(),
        Some("Fixed the parser in v1.2")
    );
    assert_eq!(
        derive_brief_heading("Did it work? Yes.").as_deref(),
        Some("Did it work?")
    );
    let long = "word ".repeat(40);
    let heading = derive_brief_heading(&long).unwrap();
    assert!(heading.chars().count() <= 80 && heading.ends_with('…'));
}
