use ticketd_core::{AttachmentQuery, AttachmentState, Workspace};

#[test]
fn library_searches_available_external_metadata_and_renames_without_provider_effects() {
    struct SelectedDocument;
    impl ticketd_core::drive::AttachmentProvider for SelectedDocument {
        fn metadata(
            &self,
            file_id: &str,
            _: Option<&str>,
        ) -> Result<ticketd_core::drive::DriveMetadata, ticketd_core::drive::DriveError> {
            Ok(ticketd_core::drive::DriveMetadata {
                id: file_id.into(),
                name: "Current plan".into(),
                mime_type: "application/vnd.google-apps.document".into(),
                size_bytes: None,
                web_url: format!("https://docs.google.com/document/d/{file_id}/edit"),
                resource_key: None,
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let file = w
        .reference_drive_file(&connection, "selected-plan", None, &SelectedDocument)
        .unwrap();
    let found = w
        .search_attachments(&AttachmentQuery {
            search: "google-apps.document".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].attachment.size_bytes, None);
    assert_eq!(found[0].attachment.id, file.id);
    let original_metadata = w.drive_reference(&file.id).unwrap();
    w.rename_attachment(&file.id, "My readable plan").unwrap();
    assert_eq!(w.drive_reference(&file.id).unwrap(), original_metadata);
    assert_eq!(
        w.reference_drive_file(&connection, "selected-plan", None, &SelectedDocument)
            .unwrap()
            .display_name,
        "My readable plan"
    );
    assert_eq!(
        w.search_attachments(&AttachmentQuery {
            search: "selected-plan".into(),
            ..Default::default()
        })
        .unwrap()[0]
            .attachment
            .id,
        file.id
    );
}

#[test]
fn library_usage_keeps_draft_undo_and_trash_owners_even_when_bytes_are_missing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let file = w
        .import_attachment_bytes("upload", "retained.log", b"safe", |_, _| true)
        .unwrap();
    let body = format!("[Original label]({})", w.attachment_uri(&file.id).unwrap());
    let ticket = w.create_ticket("Retained").unwrap();
    w.set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    w.change_ticket(
        &ticket.reference,
        ticketd_core::TicketPatch {
            body: Some(body.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let activity = w
        .add_activity_with_details(&ticket.reference, &body, None, Some(&body), None)
        .unwrap();
    w.set_trashed(&ticket.reference, true, None).unwrap();
    for kind in ["draft", "undo"] {
        w.retain_draft(&ticketd_core::DraftRetention {
            owner: format!("recovery-{kind}"),
            kind: kind.into(),
            revision: 0,
            payload: None,
            markdown: vec![body.clone()],
        })
        .unwrap();
    }
    let expected = w.attachment_usage(&file.id).unwrap();
    assert_eq!(expected.protections.len(), 6);
    assert!(
        expected
            .protections
            .iter()
            .any(|usage| usage.kind == "document_body"
                && usage.owner == *activity.supporting_document_id.as_ref().unwrap()
                && usage.ticket_id.is_none())
    );
    // Missing bytes remain an identifiable in-use record, rather than disappearing from search.
    let root = std::path::PathBuf::from(format!("{}.attachments", path.display()));
    std::fs::remove_file(root.join(&file.locator)).unwrap();
    let found = w
        .search_attachments(&AttachmentQuery {
            state: AttachmentState::InUse,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(found[0].attachment, file);
    assert_eq!(found[0].usage, expected);
    assert!(
        w.search_attachments(&AttachmentQuery {
            state: AttachmentState::Unused,
            ..Default::default()
        })
        .unwrap()
        .is_empty()
    );
}

#[test]
fn rejected_rename_commit_keeps_previous_metadata_and_can_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let file = w
        .import_attachment_bytes("upload", "file.txt", b"safe", |_, _| true)
        .unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TABLE reject_rename (id TEXT REFERENCES tickets(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_name AFTER UPDATE OF display_name ON attachments BEGIN INSERT INTO reject_rename VALUES ('missing'); END;").unwrap();
    assert!(w.rename_attachment(&file.id, "Rejected").is_err());
    assert_eq!(w.attachment(&file.id).unwrap(), file);
    faults
        .execute_batch("DROP TRIGGER reject_name; DROP TABLE reject_rename;")
        .unwrap();
    assert_eq!(
        w.rename_attachment(&file.id, "Accepted")
            .unwrap()
            .display_name,
        "Accepted"
    );
}

#[test]
fn rename_changes_only_metadata_preserving_authored_labels_bytes_and_retry_outcomes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let original = w
        .import_attachment_bytes("upload", "original.txt", b"exact bytes", |_, _| true)
        .unwrap();
    let uri = w.attachment_uri(&original.id).unwrap();
    let body = format!("[original.txt]({uri}) and [Custom prose]({uri})");
    let document = w.create_document(None, &body).unwrap();
    let request = || ticketd_core::WriteRequest::RenameAttachment {
        id: original.id.clone(),
        display_name: "Descriptive label".into(),
    };
    w.write(Some("rename"), request()).unwrap();
    let changed = w.attachment(&original.id).unwrap();
    assert_eq!(changed.display_name, "Descriptive label");
    assert_eq!(changed.original_filename, "original.txt");
    assert_eq!(changed.locator, original.locator);
    assert_eq!(w.show_document(&document.id).unwrap().body, body);
    assert_eq!(w.resolve_attachment_uri(&uri).unwrap(), changed);
    assert_eq!(
        w.search_attachments(&AttachmentQuery {
            search: "descriptive".into(),
            ..Default::default()
        })
        .unwrap()[0]
            .attachment,
        changed
    );
    assert_eq!(
        w.search_attachments(&AttachmentQuery {
            search: "original".into(),
            ..Default::default()
        })
        .unwrap()
        .len(),
        1
    );
    w.rename_attachment(&original.id, "Newer name").unwrap();
    w.write(Some("rename"), request()).unwrap();
    assert_eq!(
        w.attachment(&original.id).unwrap().display_name,
        "Newer name"
    );
    assert!(w.rename_attachment(&original.id, " \n ").is_err());
    drop(w);
    let w = Workspace::open(path).unwrap();
    let output = dir.path().join("export.txt");
    w.export_attachment(&original.id, &output).unwrap();
    assert_eq!(std::fs::read(output).unwrap(), b"exact bytes");
    assert_eq!(w.show_document(&document.id).unwrap().body, body);
}

#[test]
fn library_searches_metadata_ranks_related_files_and_bounds_results_without_flattening_usage() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let related = w
        .import_attachment_bytes("related", "trace.log", b"trace", |_, _| true)
        .unwrap();
    let recent = w
        .import_attachment_bytes("recent", "screen.png", b"image", |_, _| true)
        .unwrap();
    let ticket = w.create_ticket("Investigate").unwrap();
    let body = format!("[Authored]({})", w.attachment_uri(&related.id).unwrap());
    let document = w.create_document(Some("Evidence"), &body).unwrap();
    w.set_ticket_document(&ticket.reference, &document.id, true)
        .unwrap();
    let query = AttachmentQuery {
        ticket: Some(ticket.reference.clone()),
        ..Default::default()
    };
    let results = w.search_attachments(&query).unwrap();
    assert_eq!(
        results
            .iter()
            .map(|r| r.attachment.id.as_str())
            .collect::<Vec<_>>(),
        [related.id.as_str(), recent.id.as_str()]
    );
    assert!(results[0].related);
    assert_eq!(results[0].usage.protections[0].kind, "document_body");
    assert_eq!(results[0].usage.protections[0].owner, document.id);
    assert!(w.ticket_attachments(&ticket.reference).unwrap().is_empty());
    let files = w
        .search_attachments(&AttachmentQuery {
            search: "PNG".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].attachment, recent);
    assert_eq!(
        w.search_attachments(&AttachmentQuery {
            state: AttachmentState::InUse,
            ..Default::default()
        })
        .unwrap()
        .len(),
        1
    );
    let files = w
        .search_attachments(&AttachmentQuery {
            state: AttachmentState::Unused,
            limit: 1,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(files[0].attachment.id, recent.id);
    assert!(
        w.search_attachments(&AttachmentQuery { limit: 0, ..query })
            .unwrap()
            .is_empty()
    );
    assert!(
        w.search_attachments(&AttachmentQuery {
            search: "%".into(),
            ..Default::default()
        })
        .unwrap()
        .is_empty()
    );
}
