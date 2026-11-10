use ticketd_core::Workspace;

#[test]
fn upload_limit_is_workspace_configuration_and_applies_to_actual_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment_upload_limit().unwrap(), 104_857_600);
    assert!(workspace.set_attachment_upload_limit(0).is_err());
    workspace.set_attachment_upload_limit(8).unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment_upload_limit().unwrap(), 8);
    let source = dir.path().join("growing.bin");
    std::fs::write(&source, b"1234").unwrap();
    let error = workspace
        .import_attachment_with_progress("growing", &source, None, |copied, _| {
            if copied == 0 {
                std::fs::write(&source, b"123456789").unwrap();
            }
            true
        })
        .unwrap_err();
    assert!(error.to_string().contains("8 bytes"));
    assert!(workspace.attachments(50, 0).unwrap().is_empty());
    std::fs::write(&source, b"12345678").unwrap();
    let stored = workspace
        .import_attachment("growing", &source, None)
        .unwrap();
    assert_eq!(stored.size_bytes, Some(8));
    workspace.set_attachment_upload_limit(1).unwrap();
    std::fs::remove_file(&source).unwrap();
    assert_eq!(
        workspace
            .import_attachment("growing", &source, None)
            .unwrap(),
        stored
    );
}

#[test]
fn screenshot_capture_cancels_independently_and_replays_completed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let bytes = vec![42; 131_073];
    let mut progress = Vec::new();
    assert!(
        workspace
            .import_attachment_bytes("capture", "screenshot.png", &bytes, |copied, total| {
                progress.push((copied, total));
                copied < 65_536
            })
            .unwrap_err()
            .to_string()
            .contains("canceled")
    );
    assert_eq!(progress, [(0, 131_073), (65_536, 131_073)]);
    assert!(workspace.attachments(50, 0).unwrap().is_empty());
    let stored = workspace
        .import_attachment_bytes("capture", "screenshot.png", &bytes, |_, _| true)
        .unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .import_attachment_bytes("capture", "screenshot.png", &bytes, |_, _| false)
            .unwrap(),
        stored
    );
    assert!(matches!(
        workspace.import_attachment_bytes("capture", "screenshot.png", b"other", |_, _| true),
        Err(ticketd_core::Error::RequestConflict(_))
    ));
    assert!(
        workspace
            .import_attachment_bytes("bad-name", "../escape.png", b"bytes", |_, _| true)
            .is_err()
    );
    let exported = dir.path().join("export.png");
    workspace.export_attachment(&stored.id, &exported).unwrap();
    assert_eq!(std::fs::read(exported).unwrap(), bytes);
    workspace.set_attachment_upload_limit(2).unwrap();
    assert!(
        workspace
            .import_attachment_bytes("too-large", "large.png", b"123", |_, _| true)
            .is_err()
    );
    assert_eq!(workspace.attachments(50, 0).unwrap(), [stored]);
}

#[test]
fn upload_configuration_upgrade_and_backup_preserve_existing_snapshots_and_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("existing.txt");
    std::fs::write(&source, b"preserve").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("existing", &source, None)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    drop(workspace);
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture
        .execute_batch("DROP TABLE attachment_upload_settings; PRAGMA user_version=48;")
        .unwrap();
    drop(fixture);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment_upload_limit().unwrap(), 104857600);
    assert_eq!(workspace.attachment_uri(&file.id).unwrap(), uri);
    workspace.set_attachment_upload_limit(17).unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    drop(workspace);
    let restored = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored, &backup).unwrap();
    let workspace = Workspace::open(&restored).unwrap();
    assert_eq!(workspace.attachment_upload_limit().unwrap(), 17);
    let file = ticketd_core::Attachment {
        added_at: None,
        ..file
    };
    assert_eq!(workspace.resolve_attachment_uri(&uri).unwrap(), file);
    let export = dir.path().join("export.txt");
    workspace.export_attachment(&file.id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"preserve");
}

#[test]
fn snapshots_survive_source_deletion_reopen_and_detaching_one_ticket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.bin");
    std::fs::write(&source, [0, 255, 13, 10, 42]).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace.create_ticket("Investigate").unwrap();
    let second = workspace.create_ticket("Verify").unwrap();
    let file = workspace
        .import_attachment("upload-1", &source, Some("Diagnostic trace"))
        .unwrap();
    workspace
        .set_ticket_attachment(&first.reference, &file.id, true)
        .unwrap();
    workspace
        .set_ticket_attachment(&second.reference, &file.id, true)
        .unwrap();
    std::fs::remove_file(&source).unwrap();
    drop(workspace);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment(&file.id).unwrap(), file);
    assert_eq!(file.original_filename, "trace.bin");
    assert_eq!(file.size_bytes, Some(5));
    assert_eq!(
        workspace
            .import_attachment("upload-1", &source, Some("Diagnostic trace"))
            .unwrap(),
        file
    );
    workspace
        .set_ticket_attachment(&first.reference, &file.id, false)
        .unwrap();
    assert!(
        workspace
            .ticket_attachments(&first.reference)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        workspace.ticket_attachments(&second.reference).unwrap(),
        std::slice::from_ref(&file)
    );
    assert_eq!(
        workspace.attachments(50, 0).unwrap(),
        std::slice::from_ref(&file)
    );
    let exported = dir.path().join("export.bin");
    workspace.export_attachment(&file.id, &exported).unwrap();
    assert_eq!(std::fs::read(&exported).unwrap(), [0, 255, 13, 10, 42]);
    assert!(workspace.export_attachment(&file.id, &exported).is_err());
}

#[test]
fn completed_bytes_and_identity_survive_a_failed_database_commit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join(".ticketd-upload.json");
    std::fs::write(&source, b"original valid bytes").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE commit_failure (id TEXT REFERENCES tickets(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER fail_upload_commit AFTER INSERT ON attachments BEGIN INSERT INTO commit_failure VALUES ('missing-ticket'); END;").unwrap();
    assert!(
        workspace
            .import_attachment("recover-upload", &source, None)
            .is_err()
    );
    std::fs::remove_file(&source).unwrap();
    faults
        .execute_batch("DROP TRIGGER fail_upload_commit; DROP TABLE commit_failure;")
        .unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    let recovered = workspace.attachments(50, 0).unwrap();
    assert_eq!(recovered.len(), 1);
    let retried = workspace
        .import_attachment("recover-upload", &source, None)
        .unwrap();
    assert_eq!(retried, recovered[0]);
    let export = dir.path().join("recovered.json");
    workspace.export_attachment(&retried.id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"original valid bytes");
}

#[test]
fn a_completed_upload_keeps_its_retry_id_reserved_after_database_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"keep these bytes").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_upload BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'failed metadata save'); END;").unwrap();
    assert!(
        workspace
            .import_attachment("reserved", &source, None)
            .is_err()
    );
    faults.execute_batch("DROP TRIGGER fail_upload;").unwrap();
    let other = ticketd_core::WriteRequest::CreateTicket {
        title: "Different operation".into(),
        project_id: None,
    };
    assert!(matches!(
        workspace.write(Some("reserved"), other),
        Err(ticketd_core::Error::RequestConflict(_))
    ));
    let file = workspace
        .import_attachment("reserved", &source, None)
        .unwrap();
    let export = dir.path().join("export.log");
    workspace.export_attachment(&file.id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"keep these bytes");
}

#[test]
fn backup_restore_and_safety_copy_preserve_retained_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Keep my file").unwrap();
    let old = dir.path().join("before.sqlite3");
    workspace.backup(&old).unwrap();
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"retained").unwrap();
    let file = workspace
        .import_attachment("backup-file", &source, None)
        .unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    let complete = dir.path().join("complete.sqlite3");
    workspace.backup(&complete).unwrap();
    drop(workspace);
    let safety = Workspace::restore(&path, &old).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert!(workspace.attachments(50, 0).unwrap().is_empty());
    drop(workspace);
    Workspace::restore(&path, &safety).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.ticket_attachments(&ticket.reference).unwrap(),
        std::slice::from_ref(&file)
    );
    let exported = dir.path().join("restored.log");
    workspace.export_attachment(&file.id, &exported).unwrap();
    assert_eq!(std::fs::read(exported).unwrap(), b"retained");
    drop(workspace);
    let elsewhere = dir.path().join("elsewhere.sqlite3");
    Workspace::restore(&elsewhere, &complete).unwrap();
    let workspace = Workspace::open(&elsewhere).unwrap();
    let exported = dir.path().join("elsewhere.log");
    workspace.export_attachment(&file.id, &exported).unwrap();
    assert_eq!(std::fs::read(exported).unwrap(), b"retained");
}

#[test]
fn revised_uploads_create_new_identities_and_retry_ids_cannot_change_content() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = dir.path().join("report.txt");
    std::fs::write(&source, b"version one").unwrap();
    let original = workspace
        .import_attachment("original", &source, None)
        .unwrap();
    std::fs::write(&source, b"version two").unwrap();
    let revision = workspace
        .import_attachment("revision", &source, None)
        .unwrap();
    assert_ne!(original.id, revision.id);
    assert_eq!(
        workspace
            .import_attachment("original", &source, None)
            .unwrap(),
        original
    );
    assert!(matches!(
        workspace.import_attachment("original", &source, Some("Changed")),
        Err(ticketd_core::Error::RequestConflict(_))
    ));
    workspace
        .write(
            Some("already-used"),
            ticketd_core::WriteRequest::CreateTicket {
                title: "Other operation".into(),
                project_id: None,
            },
        )
        .unwrap();
    assert!(matches!(
        workspace.import_attachment("already-used", &source, None),
        Err(ticketd_core::Error::RequestConflict(_))
    ));
    for (file, expected) in [(original, b"version one"), (revision, b"version two")] {
        let export = dir.path().join(&file.id);
        workspace.export_attachment(&file.id, &export).unwrap();
        assert_eq!(std::fs::read(export).unwrap(), expected);
    }
}

#[test]
fn failed_association_keeps_the_snapshot_reusable_and_retry_changes_only_one_reference() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Investigate").unwrap();
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"valid bytes").unwrap();
    let file = workspace
        .import_attachment("stored", &source, None)
        .unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_association BEFORE INSERT ON ticket_attachments BEGIN SELECT RAISE(ABORT, 'simulated failed association'); END;").unwrap();
    let link = || ticketd_core::WriteRequest::SetTicketAttachment {
        reference: ticket.reference.clone(),
        attachment_id: file.id.clone(),
        present: true,
    };
    assert!(workspace.write(Some("association"), link()).is_err());
    assert!(
        workspace
            .ticket_attachments(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        workspace.attachments(50, 0).unwrap(),
        std::slice::from_ref(&file)
    );
    faults
        .execute_batch("DROP TRIGGER fail_association;")
        .unwrap();
    std::fs::remove_file(source).unwrap();
    let result = workspace.write(Some("association"), link()).unwrap();
    assert_eq!(
        workspace.write(Some("association"), link()).unwrap(),
        result
    );
    assert_eq!(
        workspace.ticket_attachments(&ticket.reference).unwrap(),
        std::slice::from_ref(&file)
    );
    let export = dir.path().join("export.log");
    workspace.export_attachment(&file.id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"valid bytes");
}

#[test]
fn invalid_or_oversized_files_and_filesystem_failure_never_create_valid_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let source = dir.path().join("trace.bin");
    let file = std::fs::File::create(&source).unwrap();
    file.set_len(ticketd_core::DEFAULT_ATTACHMENT_LIMIT + 1)
        .unwrap();
    drop(file);
    assert!(
        workspace
            .import_attachment("size", &source, None)
            .unwrap_err()
            .to_string()
            .contains("100 MiB")
    );
    assert!(
        workspace
            .import_attachment("directory", dir.path(), None)
            .is_err()
    );
    assert!(
        workspace
            .import_attachment("missing", dir.path().join("absent"), None)
            .is_err()
    );
    assert!(workspace.attachments(50, 0).unwrap().is_empty());
    std::fs::write(&source, b"valid source").unwrap();
    let root = dir.path().join("workspace.sqlite3.attachments");
    std::fs::remove_file(root.join(".uploads.lock")).unwrap();
    std::fs::remove_dir(&root).unwrap();
    std::fs::write(&root, b"existing valid file").unwrap();
    assert!(
        workspace
            .import_attachment("file-retry", &source, None)
            .is_err()
    );
    assert_eq!(std::fs::read(&root).unwrap(), b"existing valid file");
    assert_eq!(std::fs::read(&source).unwrap(), b"valid source");
    std::fs::remove_file(root).unwrap();
    let file = workspace
        .import_attachment("file-retry", &source, None)
        .unwrap();
    assert_eq!(workspace.attachments(50, 0).unwrap(), [file]);
}

#[test]
fn concurrent_workspace_instances_retry_one_upload_without_duplicating_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    drop(Workspace::open(&path).unwrap());
    let source = dir.path().join("concurrent.txt");
    std::fs::write(&source, b"concurrent bytes").unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let source = source.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut workspace = Workspace::open(path).unwrap();
                barrier.wait();
                workspace
                    .import_attachment("same-upload", source, None)
                    .unwrap()
            })
        })
        .collect();
    let files: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert!(files.iter().all(|file| file == &files[0]));
    let workspace = Workspace::open(path).unwrap();
    assert_eq!(workspace.attachments(50, 0).unwrap(), [files[0].clone()]);
}

#[test]
fn missing_bytes_retain_identity_and_references_but_cannot_be_exported_or_newly_linked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("program.exe");
    std::fs::write(&source, b"arbitrary file").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Keep reference").unwrap();
    let file = workspace
        .import_attachment("arbitrary", &source, None)
        .unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    assert!(
        workspace
            .attachment_open_path(&file.id)
            .unwrap_err()
            .to_string()
            .contains("export")
    );
    std::fs::remove_file(
        dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&file.locator),
    )
    .unwrap();
    assert_eq!(
        workspace.ticket_attachments(&ticket.reference).unwrap(),
        std::slice::from_ref(&file)
    );
    assert_eq!(workspace.attachment(&file.id).unwrap(), file);
    let export = dir.path().join("export.exe");
    assert!(workspace.export_attachment(&file.id, &export).is_err());
    assert!(!export.exists());
    let other = workspace.create_ticket("Another ticket").unwrap();
    assert!(
        workspace
            .set_ticket_attachment(&other.reference, &file.id, true)
            .is_err()
    );
    assert!(
        workspace
            .ticket_attachments(&other.reference)
            .unwrap()
            .is_empty()
    );
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, false)
        .unwrap();
}
