use ticketd_core::{DocumentPatch, TicketPatch, Workspace};

#[test]
fn canonical_writes_track_inline_files_without_flattening_documents_or_direct_links() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"diagnostic bytes").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("upload", &source, None)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let markdown = format!(
        "Read [custom label]({uri}) here.\n\n![original image label]({uri})\n\n- [trace]({uri})\n\n| File |\n| --- |\n| [table label]({uri}) |\n\n`[not a link](ticketd://attachment/unknown)`"
    );
    let ticket = workspace.create_ticket("Investigate").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some(markdown.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let document = workspace.create_document(None, &markdown).unwrap();
    workspace
        .set_ticket_document(&ticket.reference, &document.id, true)
        .unwrap();
    let activity = workspace
        .add_activity_with_details(
            &ticket.reference,
            &format!("See [trace]({uri})"),
            None,
            Some(&markdown),
            None,
        )
        .unwrap();
    assert_eq!(
        workspace.embedded_attachments(&ticket.id).unwrap(),
        std::slice::from_ref(&file)
    );
    assert_eq!(
        workspace.embedded_attachments(&document.id).unwrap(),
        std::slice::from_ref(&file)
    );
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert_eq!(
        workspace.embedded_attachments(&document.id).unwrap(),
        std::slice::from_ref(&file)
    );
    workspace.set_document_trashed(&document.id, false).unwrap();
    assert_eq!(
        workspace.embedded_attachments(&activity.id).unwrap(),
        std::slice::from_ref(&file)
    );
    assert_eq!(
        workspace
            .embedded_attachments(activity.supporting_document_id.as_ref().unwrap())
            .unwrap(),
        std::slice::from_ref(&file)
    );
    workspace
        .delete_activity(&ticket.reference, &activity.id)
        .unwrap();
    assert!(
        workspace
            .embedded_attachments(&activity.id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        workspace
            .embedded_attachments(activity.supporting_document_id.as_ref().unwrap())
            .unwrap(),
        std::slice::from_ref(&file)
    );
    assert!(
        workspace
            .ticket_attachments(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some("Removed only the inline reference".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        workspace
            .embedded_attachments(&ticket.id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        workspace.ticket_attachments(&ticket.reference).unwrap(),
        std::slice::from_ref(&file)
    );
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_document(&document.id).unwrap().body,
        markdown
    );
    assert_eq!(
        workspace.embedded_attachments(&document.id).unwrap(),
        std::slice::from_ref(&file)
    );
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                body: Some("Reference removed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        workspace
            .embedded_attachments(&document.id)
            .unwrap()
            .is_empty()
    );
    let exported = dir.path().join("export.log");
    workspace.export_attachment(&file.id, &exported).unwrap();
    assert_eq!(std::fs::read(exported).unwrap(), b"diagnostic bytes");
    let other = Workspace::open(dir.path().join("other.sqlite3")).unwrap();
    assert!(other.resolve_attachment_uri(&uri).is_err());
}

#[test]
fn failed_reference_writes_roll_back_content_and_leave_completed_bytes_reusable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("file.txt");
    std::fs::write(&source, b"retained bytes").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("atomic", &source, None)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let linked = format!("[keep this label]({uri})");
    let ticket = workspace.create_ticket("Atomic save").unwrap();
    let document = workspace
        .create_document(None, "Original document")
        .unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_reference BEFORE INSERT ON embedded_attachments BEGIN SELECT RAISE(ABORT, 'reference save failed'); END;").unwrap();
    assert!(
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    body: Some(linked.clone()),
                    ..Default::default()
                }
            )
            .is_err()
    );
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap().body, "");
    assert!(
        workspace
            .change_document(
                &document.id,
                DocumentPatch {
                    body: Some(linked.clone()),
                    ..Default::default()
                }
            )
            .is_err()
    );
    assert_eq!(
        workspace.show_document(&document.id).unwrap().body,
        "Original document"
    );
    assert!(
        workspace
            .add_activity_with_details(&ticket.reference, "Update", None, Some(&linked), None)
            .is_err()
    );
    assert!(
        workspace
            .activities(&ticket.reference, 100, 0)
            .unwrap()
            .is_empty()
    );
    assert!(
        workspace
            .embedded_attachments(&ticket.id)
            .unwrap()
            .is_empty()
    );
    faults
        .execute_batch("DROP TRIGGER fail_reference;")
        .unwrap();
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                body: Some(linked),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        workspace.embedded_attachments(&document.id).unwrap(),
        std::slice::from_ref(&file)
    );
    let exported = dir.path().join("retained.txt");
    workspace.export_attachment(&file.id, &exported).unwrap();
    assert_eq!(std::fs::read(exported).unwrap(), b"retained bytes");
}

#[test]
fn a_rejected_document_commit_rolls_back_content_and_references_before_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("file.txt");
    std::fs::write(&source, b"completed bytes").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("commit-failure", &source, None)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let linked = format!("[Stored file]({uri})");
    let original = workspace.create_document(None, "Original body").unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TABLE reject_document_commit (id TEXT REFERENCES tickets(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_reference_commit AFTER INSERT ON embedded_attachments BEGIN INSERT INTO reject_document_commit VALUES ('missing-ticket'); END;").unwrap();
    assert!(
        workspace
            .change_document(
                &original.id,
                DocumentPatch {
                    body: Some(linked.clone()),
                    ..Default::default()
                }
            )
            .is_err()
    );
    assert_eq!(
        workspace.show_document(&original.id).unwrap().body,
        "Original body"
    );
    assert!(
        workspace
            .embedded_attachments(&original.id)
            .unwrap()
            .is_empty()
    );
    assert!(
        workspace
            .create_document(Some("Rejected"), &linked)
            .is_err()
    );
    assert!(
        workspace
            .search_documents("Rejected", None, 50, 0)
            .unwrap()
            .is_empty()
    );
    faults
        .execute_batch("DROP TRIGGER reject_reference_commit; DROP TABLE reject_document_commit;")
        .unwrap();
    let saved = workspace.create_document(Some("Retry"), &linked).unwrap();
    assert_eq!(
        workspace.embedded_attachments(&saved.id).unwrap(),
        std::slice::from_ref(&file)
    );
    let exported = dir.path().join("completed.txt");
    workspace.export_attachment(&file.id, &exported).unwrap();
    assert_eq!(std::fs::read(exported).unwrap(), b"completed bytes");
}

#[test]
fn broken_existing_links_remain_editable_but_new_links_require_completed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("image.png");
    std::fs::write(&source, b"image fixture").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace.import_attachment("image", &source, None).unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let original = format!("![Authored image label]({uri})");
    let document = workspace.create_document(None, &original).unwrap();
    let bytes =
        std::path::PathBuf::from(format!("{}.attachments", path.display())).join(&file.locator);
    std::fs::remove_file(bytes).unwrap();
    let edited = format!("Retain broken image: {original}");
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                body: Some(edited.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(workspace.show_document(&document.id).unwrap().body, edited);
    assert_eq!(workspace.resolve_attachment_uri(&uri).unwrap(), file);
    assert!(workspace.attachment_uri(&file.id).is_err());
    assert!(workspace.create_document(None, &original).is_err());
    let foreign = "[Foreign](ticketd://attachment/another-workspace/file)";
    let foreign_document = workspace.create_document(None, foreign).unwrap();
    assert!(
        workspace
            .embedded_attachments(&foreign_document.id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        workspace
            .embedded_attachment_uris(&foreign_document.id)
            .unwrap(),
        ["ticketd://attachment/another-workspace/file"]
    );
    assert!(
        workspace
            .resolve_attachment_uri("ticketd://attachment/another-workspace/file")
            .is_err()
    );
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                body: Some("Removed the image only".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        workspace
            .embedded_attachments(&document.id)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn restore_review_requires_the_workspace_identity_and_reference_index() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    for object in [
        "attachment_workspace",
        "embedded_attachments",
        "embedded_activity_delete",
    ] {
        let backup = dir.path().join(format!("without-{object}.sqlite3"));
        workspace.backup(&backup).unwrap();
        let damaged = rusqlite::Connection::open(&backup).unwrap();
        let kind = if object == "embedded_activity_delete" {
            "TRIGGER"
        } else {
            "TABLE"
        };
        damaged
            .execute_batch(&format!("DROP {kind} {object}"))
            .unwrap();
        drop(damaged);
        assert!(matches!(workspace.inspect_backup(&backup).unwrap().check,
            ticketd_core::BackupCheck::MissingTables { tables } if tables.iter().any(|name| name == object)));
    }
}

#[test]
fn schema_47_upgrade_keeps_retained_files_and_a_complete_pre_migration_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("existing.txt");
    std::fs::write(&source, b"existing schema47 snapshot").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Existing attachment").unwrap();
    let file = workspace
        .import_attachment("existing-upload", &source, None)
        .unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    drop(workspace);
    // Reconstruct the prior schema at the system boundary, preserving its actual file layout.
    let previous = rusqlite::Connection::open(&path).unwrap();
    previous.execute_batch("DROP TRIGGER embedded_activity_delete; DROP TABLE embedded_attachments; DROP TABLE attachment_workspace; PRAGMA user_version=47;").unwrap();
    drop(previous);
    std::fs::remove_file(source).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    assert_eq!(workspace.resolve_attachment_uri(&uri).unwrap(), file);
    let backups = workspace.safety_backups().unwrap();
    assert_eq!(backups.len(), 1);
    assert!(matches!(
        workspace.inspect_backup(&backups[0].path).unwrap().check,
        ticketd_core::BackupCheck::Valid {
            format_version: 47,
            ..
        }
    ));
    let restored = dir.path().join("restored.sqlite3");
    drop(Workspace::open(&restored).unwrap());
    Workspace::restore(&restored, &backups[0].path).unwrap();
    let restored = Workspace::open(&restored).unwrap();
    assert_eq!(
        restored.ticket_attachments(&ticket.reference).unwrap(),
        std::slice::from_ref(&file)
    );
    let export = dir.path().join("restored.txt");
    restored.export_attachment(&file.id, &export).unwrap();
    assert_eq!(
        std::fs::read(export).unwrap(),
        b"existing schema47 snapshot"
    );
    drop(workspace);
    let reopened = Workspace::open(&path).unwrap();
    assert_eq!(reopened.attachment_uri(&file.id).unwrap(), uri);
}
