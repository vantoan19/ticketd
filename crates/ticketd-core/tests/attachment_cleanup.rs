use ticketd_core::{AttachmentQuery, DraftRetention, TicketPatch, Workspace};

#[test]
fn explicit_quarantine_retains_identity_and_bytes_until_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"retain these bytes").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("upload", &source, None)
        .unwrap();
    assert!(
        workspace
            .attachment_cleanup_review(&file.id)
            .unwrap()
            .eligible
    );
    let quarantined = workspace.quarantine_attachment(&file.id).unwrap();
    assert!(quarantined.quarantined);
    assert_eq!(quarantined.id, file.id);
    assert_eq!(
        workspace
            .search_attachments(&AttachmentQuery::default())
            .unwrap()
            .len(),
        1
    );
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert!(workspace.attachment(&file.id).unwrap().quarantined);
    let restored = workspace.restore_attachment(&file.id).unwrap();
    assert!(!restored.quarantined);
    let output = dir.path().join("restored.txt");
    workspace.export_attachment(&file.id, &output).unwrap();
    assert_eq!(std::fs::read(output).unwrap(), b"retain these bytes");
    assert_eq!(workspace.restore_attachment(&file.id).unwrap(), restored);
}

#[test]
fn new_reference_restores_quarantined_bytes_before_committing_and_blocks_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"undo bytes").unwrap();
    let file = workspace.import_attachment("upload", source, None).unwrap();
    let ticket = workspace.create_ticket("Undo this removal").unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
    assert!(
        !workspace
            .attachment_cleanup_review(&file.id)
            .unwrap()
            .eligible
    );
    assert!(workspace.quarantine_attachment(&file.id).is_err());
    let out = dir.path().join("undo.txt");
    workspace.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"undo bytes");
}

#[test]
fn complete_backup_restores_quarantined_files_and_recovery_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"backup bytes", |_, _| true)
        .unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let inspection = workspace.inspect_backup(&backup).unwrap();
    assert!(matches!(
        inspection.check,
        ticketd_core::BackupCheck::Valid { .. }
    ));
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let mut restored = Workspace::open(target).unwrap();
    assert!(restored.attachment(&file.id).unwrap().quarantined);
    restored.restore_attachment(&file.id).unwrap();
    let out = dir.path().join("backup.txt");
    restored.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"backup bytes");
}

#[test]
fn portable_export_reads_quarantine_without_restoring_or_rewriting_its_identity() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"portable quarantine", |_, _| true)
        .unwrap();
    let body = format!(
        "Keep [custom label]({})",
        workspace.attachment_uri(&file.id).unwrap()
    );
    workspace.quarantine_attachment(&file.id).unwrap();
    let exported = workspace
        .export_markdown_with_files(
            ticketd_core::MarkdownExportSource::Markdown { body },
            dir.path(),
        )
        .unwrap();
    assert_eq!(exported.status, ticketd_core::ExportStatus::Complete);
    assert_eq!(
        exported.attachments[0].attachment_id.as_deref(),
        Some(file.id.as_str())
    );
    let relative = exported.attachments[0].path.as_ref().unwrap();
    assert_eq!(
        std::fs::read(exported.directory.join(relative)).unwrap(),
        b"portable quarantine"
    );
    assert!(
        std::fs::read_to_string(exported.directory.join("content.md"))
            .unwrap()
            .contains(&format!("[custom label]({relative})"))
    );
    assert!(workspace.attachment(&file.id).unwrap().quarantined);
}

#[test]
fn portable_export_racing_canonical_undo_never_omits_retained_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let mut files = Vec::new();
    let mut body = String::new();
    for index in 0..64 {
        let file = workspace
            .import_attachment_bytes(
                &format!("upload-{index}"),
                "trace.txt",
                b"retained",
                |_, _| true,
            )
            .unwrap();
        body.push_str(&format!(
            "[Trace]({})\n\n",
            workspace.attachment_uri(&file.id).unwrap()
        ));
        workspace.quarantine_attachment(&file.id).unwrap();
        files.push(file);
    }
    let start = std::sync::Barrier::new(2);
    let exported = std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            let mut editor = Workspace::open(&path).unwrap();
            start.wait();
            editor.create_document(None, &body).unwrap();
        });
        start.wait();
        let exported = workspace
            .export_markdown_with_files(
                ticketd_core::MarkdownExportSource::Markdown { body: body.clone() },
                dir.path(),
            )
            .unwrap();
        writer.join().unwrap();
        exported
    });
    assert_eq!(
        exported.status,
        ticketd_core::ExportStatus::Complete,
        "{:?}",
        exported
            .attachments
            .iter()
            .filter_map(|entry| entry.omission.as_ref())
            .collect::<Vec<_>>()
    );
    assert_eq!(exported.attachments.len(), files.len());
    for entry in &exported.attachments {
        assert_eq!(
            std::fs::read(exported.directory.join(entry.path.as_ref().unwrap())).unwrap(),
            b"retained"
        );
    }
}

#[test]
fn checked_snapshot_reads_survive_canonical_undo_location_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let bytes =
        b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";
    let file = workspace
        .import_attachment_bytes("image", "trace.png", bytes, |_, _| true)
        .unwrap();
    let body = format!("[Image]({})", workspace.attachment_uri(&file.id).unwrap());
    workspace.quarantine_attachment(&file.id).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let start = std::sync::Barrier::new(5);
    std::thread::scope(|scope| {
        let readers: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    let reader = Workspace::open(&path).unwrap();
                    start.wait();
                    for _ in 0..256 {
                        let mut media = reader.attachment_media(&identity, &file.id).unwrap();
                        assert_eq!(media.read(0, bytes.len() as u64).unwrap(), bytes);
                    }
                })
            })
            .collect();
        start.wait();
        workspace.create_document(None, &body).unwrap();
        for reader in readers {
            reader.join().unwrap();
        }
    });
}

#[test]
fn added_time_is_truthful_and_stable_across_rename_replay_and_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"dated", |_, _| true)
        .unwrap();
    let added = file.added_at.clone().unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(&added).is_ok());
    workspace.rename_attachment(&file.id, "Renamed").unwrap();
    assert_eq!(
        workspace
            .import_attachment_bytes("upload", "trace.txt", b"dated", |_, _| true)
            .unwrap()
            .added_at,
        Some(added.clone())
    );
    assert_eq!(
        workspace.attachment(&file.id).unwrap().added_at,
        Some(added.clone())
    );
    workspace.quarantine_attachment(&file.id).unwrap();
    let backup = dir.path().join("dated.sqlite3");
    workspace.backup(&backup).unwrap();
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let mut restored = Workspace::open(target).unwrap();
    assert_eq!(
        restored.restore_attachment(&file.id).unwrap().added_at,
        Some(added)
    );
}

#[test]
fn cleanup_rechecks_drafts_undo_saved_content_and_recoverable_trash() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"protected", |_, _| true)
        .unwrap();
    let body = format!("[Trace]({})", workspace.attachment_uri(&file.id).unwrap());
    assert!(
        workspace
            .attachment_cleanup_review(&file.id)
            .unwrap()
            .eligible
    );
    for kind in ["draft", "undo"] {
        let retained = workspace
            .retain_draft(&DraftRetention {
                owner: kind.into(),
                kind: kind.into(),
                revision: 0,
                payload: None,
                markdown: vec![body.clone()],
            })
            .unwrap();
        assert!(workspace.quarantine_attachment(&file.id).is_err());
        assert_eq!(
            workspace
                .attachment_cleanup_review(&file.id)
                .unwrap()
                .usage
                .protections[0]
                .kind,
            kind
        );
        workspace
            .release_draft(&retained.owner, retained.revision)
            .unwrap();
    }
    let document = workspace.create_document(None, &body).unwrap();
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert!(workspace.quarantine_attachment(&file.id).is_err());
    let usage = workspace.attachment_cleanup_review(&file.id).unwrap().usage;
    assert!(
        usage
            .protections
            .iter()
            .any(|p| p.kind == "document_body" && p.trashed)
    );
    workspace.set_document_trashed(&document.id, false).unwrap();
    workspace
        .change_document(
            &document.id,
            ticketd_core::DocumentPatch {
                body: Some("Removed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let ticket = workspace.create_ticket("Restored by Undo").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some(body.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();
    assert!(workspace.quarantine_attachment(&file.id).is_err());
    assert!(
        workspace
            .attachment_cleanup_review(&file.id)
            .unwrap()
            .usage
            .protections
            .iter()
            .any(|p| p.trashed)
    );
}

#[test]
fn failed_database_commit_after_byte_moves_preserves_export_and_safe_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"never lose", |_, _| true)
        .unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_move BEFORE UPDATE OF quarantined ON attachments BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END;").unwrap();
    assert!(
        workspace
            .quarantine_attachment(&file.id)
            .unwrap_err()
            .to_string()
            .contains("injected metadata")
    );
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
    let out = dir.path().join("after-failure.txt");
    workspace.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"never lose");
    let backup = dir.path().join("after-failure.sqlite3");
    workspace.backup(backup).unwrap();
    faults.execute_batch("DROP TRIGGER fail_move;").unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let ticket = workspace.create_ticket("Atomic reference").unwrap();
    faults.execute_batch("CREATE TRIGGER fail_link BEFORE INSERT ON ticket_attachments BEGIN SELECT RAISE(ABORT, 'injected reference failure'); END;").unwrap();
    assert!(
        workspace
            .set_ticket_attachment(&ticket.reference, &file.id, true)
            .is_err()
    );
    assert!(
        workspace
            .ticket_attachments(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    assert!(workspace.attachment(&file.id).unwrap().quarantined);
    faults.execute_batch("DROP TRIGGER fail_link;").unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
}

#[test]
fn concurrent_reference_creation_and_cleanup_never_lose_committed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"racing bytes", |_, _| true)
        .unwrap();
    let ticket = workspace.create_ticket("Race").unwrap();
    let start = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let mut cleaner = Workspace::open(&path).unwrap();
            start.wait();
            let _ = cleaner.quarantine_attachment(&file.id);
        });
        start.wait();
        workspace
            .set_ticket_attachment(&ticket.reference, &file.id, true)
            .unwrap();
    });
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
    let out = dir.path().join("raced.txt");
    workspace.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"racing bytes");
}

#[test]
fn backup_racing_quarantine_and_undo_restores_exact_retained_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", &[42; 262_144], |_, _| true)
        .unwrap();
    let ticket = workspace.create_ticket("Concurrent Undo").unwrap();
    let body = format!("[Trace]({})", workspace.attachment_uri(&file.id).unwrap());
    workspace.quarantine_attachment(&file.id).unwrap();
    let start = std::sync::Barrier::new(2);
    let backup = dir.path().join("raced.sqlite3");
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let backup_workspace = Workspace::open(&path).unwrap();
            start.wait();
            backup_workspace.backup(&backup).unwrap();
        });
        start.wait();
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    body: Some(body.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
    });
    let restored_path = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored_path, &backup).unwrap();
    let restored = Workspace::open(restored_path).unwrap();
    let out = dir.path().join("raced.txt");
    restored.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), vec![42; 262_144]);
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
    // A concurrent cleanup now sees the committed canonical reference.
    assert!(workspace.quarantine_attachment(&file.id).is_err());
}

#[test]
fn filesystem_move_failure_keeps_metadata_and_bytes_available() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"still intact", |_, _| true)
        .unwrap();
    let blocked = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.id)
        .join("quarantine");
    std::fs::write(&blocked, b"injected filesystem obstruction").unwrap();
    assert!(workspace.quarantine_attachment(&file.id).is_err());
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
    let out = dir.path().join("intact.txt");
    workspace.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"still intact");
    std::fs::remove_file(blocked).unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
}

#[test]
fn legacy_upload_receipt_without_added_time_remains_recoverable_and_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"old receipt").unwrap();
    let file = workspace
        .import_attachment("old-upload", &source, None)
        .unwrap();
    drop(workspace);
    // Simulate a completed older-version upload whose metadata commit was interrupted.
    let manifest = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.id)
        .join(".ticketd-upload.json");
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    let metadata = receipt["attachment"].as_object_mut().unwrap();
    metadata.remove("added_at");
    metadata.remove("quarantined");
    std::fs::write(manifest, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults
        .execute("DELETE FROM request_outcomes WHERE id='old-upload'", [])
        .unwrap();
    faults
        .execute("DELETE FROM attachments WHERE id=?1", [&file.id])
        .unwrap();
    drop(faults);
    std::fs::remove_file(&source).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let recovered = workspace
        .import_attachment("old-upload", source, None)
        .unwrap();
    assert_eq!(recovered.id, file.id);
    assert_eq!(recovered.added_at, None);
    assert!(!recovered.quarantined);
    assert_eq!(
        workspace
            .rename_attachment(&file.id, "Legacy")
            .unwrap()
            .added_at,
        None
    );
}

#[test]
fn deferred_commit_failure_after_quarantine_rolls_back_metadata_without_losing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"commit recovery", |_, _| true)
        .unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TABLE cleanup_commit_fault (id TEXT REFERENCES attachments(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_cleanup_commit AFTER UPDATE OF quarantined ON attachments BEGIN INSERT INTO cleanup_commit_fault VALUES ('missing-attachment'); END;").unwrap();
    assert!(workspace.quarantine_attachment(&file.id).is_err());
    assert!(!workspace.attachment(&file.id).unwrap().quarantined);
    faults
        .execute_batch("DROP TRIGGER fail_cleanup_commit; DROP TABLE cleanup_commit_fault;")
        .unwrap();
    let backup = dir.path().join("safe.sqlite3");
    workspace.backup(backup).unwrap();
    let out = dir.path().join("committed.txt");
    workspace.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"commit recovery");
    workspace.quarantine_attachment(&file.id).unwrap();
}

#[test]
fn restore_refuses_schema53_backups_missing_retained_state_or_registration_columns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let workspace = Workspace::open(&path).unwrap();
    let backup = dir.path().join("malformed.sqlite3");
    workspace.backup(&backup).unwrap();
    let faults = rusqlite::Connection::open(&backup).unwrap();
    faults.execute_batch("ALTER TABLE attachments RENAME COLUMN quarantined TO removed_state; ALTER TABLE attachments RENAME COLUMN added_at TO removed_date;").unwrap();
    drop(faults);
    assert!(
        matches!(workspace.inspect_backup(&backup).unwrap().check, ticketd_core::BackupCheck::MissingTables { tables } if tables.contains(&"attachments.quarantined".to_owned()) && tables.contains(&"attachments.added_at".to_owned()))
    );
    assert!(Workspace::restore(dir.path().join("target.sqlite3"), backup).is_err());
}

#[test]
#[ignore = "requires preserved schema52 CLI in TICKETD_SCHEMA52_CLI; run explicitly for real-version upgrade evidence"]
fn real_schema52_upgrade_preserves_unknown_dates_receipts_protections_and_complete_backups() {
    let old_cli =
        std::env::var_os("TICKETD_SCHEMA52_CLI").expect("supply the verified schema52 CLI");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let old = |args: &[&str]| -> serde_json::Value {
        let result = std::process::Command::new(&old_cli)
            .env("TICKETD_TEST_WORKSPACE", &path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice(&result.stdout).unwrap()
    };
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"real schema52 bytes").unwrap();
    let receipt = old(&[
        "attachment",
        "add",
        source.to_str().unwrap(),
        "--request-id",
        "version52",
    ]);
    let id = receipt["id"].as_str().unwrap();
    let uri = old(&["attachment", "uri", id]).as_str().unwrap().to_owned();
    let ticket = old(&["create", "Version52 retained context"]);
    let reference = ticket["reference"].as_str().unwrap();
    old(&["attachment", "link", id, reference]);
    let fixture = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        fixture
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        52
    );
    let body = format!("[Trace]({uri})");
    // Old CLI validates the documented recovery wire format before the new core opens it.
    fixture.execute("INSERT INTO attachment_drafts(owner,kind,revision,payload,markdown) VALUES('version52-undo','undo',1,NULL,?1)", [serde_json::to_string(&vec![body]).unwrap()]).unwrap();
    fixture.execute("INSERT INTO attachment_draft_references(owner,uri,attachment_id) VALUES('version52-undo',?1,?2)", rusqlite::params![uri,id]).unwrap();
    drop(fixture);
    assert_eq!(old(&["attachment", "usage", id])["eligible"], false);
    let previous = old(&["attachment", "recovery-drafts"]);
    std::fs::remove_file(&source).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment(id).unwrap().added_at, None);
    let replay = workspace
        .import_attachment("version52", &source, None)
        .unwrap();
    assert_eq!(replay.id, id);
    assert_eq!(replay.added_at, None);
    assert_eq!(
        serde_json::to_value(workspace.draft_retentions().unwrap()).unwrap(),
        previous
    );
    assert!(workspace.quarantine_attachment(id).is_err());
    let safety = workspace.safety_backups().unwrap();
    assert_eq!(safety.len(), 1);
    assert!(matches!(
        workspace.inspect_backup(&safety[0].path).unwrap().check,
        ticketd_core::BackupCheck::Valid {
            format_version: 52,
            ..
        }
    ));
    workspace
        .set_ticket_attachment(reference, id, false)
        .unwrap();
    workspace.release_draft("version52-undo", 1).unwrap();
    workspace.quarantine_attachment(id).unwrap();
    let backup = dir.path().join("schema53.sqlite3");
    workspace.backup(&backup).unwrap();
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let mut restored = Workspace::open(&target).unwrap();
    assert!(restored.attachment(id).unwrap().quarantined);
    assert_eq!(restored.restore_attachment(id).unwrap().added_at, None);
    let output = dir.path().join("upgraded.txt");
    restored.export_attachment(id, &output).unwrap();
    assert_eq!(std::fs::read(output).unwrap(), b"real schema52 bytes");
}
