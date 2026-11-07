use ticketd_core::Workspace;

#[test]
fn explicit_purge_requires_quarantine_and_retains_unavailable_identity_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"permanent cleanup", |_, _| true)
        .unwrap();
    assert!(workspace.purge_attachment(&file.id).is_err());
    workspace.quarantine_attachment(&file.id).unwrap();
    let purged = workspace.purge_attachment(&file.id).unwrap();
    assert_eq!(purged.id, file.id);
    assert_eq!(purged.display_name, "trace.txt");
    assert_eq!(
        serde_json::to_value(&purged).unwrap()["purge_state"],
        "purged"
    );
    assert!(
        !dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&file.id)
            .join("quarantine/trace.txt")
            .exists()
    );
    drop(workspace);
    let mut workspace = Workspace::open(path).unwrap();
    assert_eq!(workspace.attachment(&file.id).unwrap(), purged);
    assert_eq!(workspace.purge_attachment(&file.id).unwrap(), purged);
    let failure = workspace
        .restore_attachment(&file.id)
        .unwrap_err()
        .to_string();
    assert!(failure.contains("purged"), "{failure}");
    assert!(failure.contains("backup"), "{failure}");
    assert!(
        workspace
            .export_attachment(&file.id, dir.path().join("out.txt"))
            .is_err()
    );
}

#[test]
fn purged_replays_never_recreate_bytes_and_new_backups_restore_unavailability() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"old backup", |_, _| true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let old_backup = dir.path().join("old.sqlite3");
    workspace.backup(&old_backup).unwrap();
    workspace.purge_attachment(&file.id).unwrap();
    assert_eq!(
        workspace.export().unwrap()["attachments"][0]["purge_state"],
        "purged"
    );
    let replay = workspace
        .import_attachment_bytes("upload", "trace.txt", b"old backup", |_, _| true)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&replay).unwrap()["purge_state"],
        "purged"
    );
    assert_eq!(workspace.resolve_attachment_uri(&uri).unwrap().id, file.id);
    let backup = dir.path().join("purged.sqlite3");
    workspace.backup(&backup).unwrap();
    let content = workspace
        .inspect_backup(&backup)
        .unwrap()
        .attachment_content
        .unwrap();
    assert_eq!(
        content.local_snapshots, 0,
        "purged metadata must not be counted as backed-up local snapshots"
    );
    assert_eq!(content.retained_files, 0);
    assert_eq!(content.retained_bytes, 0);
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let restored = Workspace::open(&target).unwrap();
    assert_eq!(
        serde_json::to_value(restored.attachment(&file.id).unwrap()).unwrap()["purge_state"],
        "purged"
    );
    assert!(
        restored
            .export_attachment(&file.id, dir.path().join("missing.txt"))
            .is_err()
    );
    let old_target = dir.path().join("deliberate-old.sqlite3");
    Workspace::restore(&old_target, &old_backup).unwrap();
    let mut older = Workspace::open(&old_target).unwrap();
    older.restore_attachment(&file.id).unwrap();
    let out = dir.path().join("recovered.txt");
    older.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"old backup");
}

#[test]
fn database_failures_never_delete_before_intent_or_confirm_incomplete_purge() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"failure boundary", |_, _| true)
        .unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_intent BEFORE UPDATE OF purge_state ON attachments WHEN new.purge_state='pending' BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END;").unwrap();
    assert!(
        workspace
            .purge_attachment(&file.id)
            .unwrap_err()
            .to_string()
            .contains("injected intent")
    );
    let out = dir.path().join("before-intent.txt");
    workspace.export_attachment(&file.id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"failure boundary");
    faults.execute_batch("DROP TRIGGER fail_intent; CREATE TRIGGER fail_completion BEFORE UPDATE OF purge_state ON attachments WHEN new.purge_state='purged' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END;").unwrap();
    let error = workspace
        .purge_attachment(&file.id)
        .unwrap_err()
        .to_string();
    assert!(error.contains("pending"), "{error}");
    assert!(error.contains("injected completion"), "{error}");
    assert_eq!(
        serde_json::to_value(workspace.attachment(&file.id).unwrap()).unwrap()["purge_state"],
        "pending"
    );
    assert!(
        !dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&file.id)
            .join("quarantine/trace.txt")
            .exists()
    );
    let backup = dir.path().join("pending.sqlite3");
    assert!(
        workspace
            .backup(&backup)
            .unwrap_err()
            .to_string()
            .contains("pending")
    );
    assert!(!backup.exists());
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert!(
        workspace
            .restore_attachment(&file.id)
            .unwrap_err()
            .to_string()
            .contains("pending")
    );
    faults
        .execute_batch("DROP TRIGGER fail_completion")
        .unwrap();
    assert_eq!(
        serde_json::to_value(workspace.purge_attachment(&file.id).unwrap()).unwrap()["purge_state"],
        "purged"
    );
    workspace.backup(&backup).unwrap();
}

#[test]
fn deferred_commit_failures_preserve_intent_and_completion_boundaries() {
    for state in ["pending", "purged"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut workspace = Workspace::open(&path).unwrap();
        let file = workspace
            .import_attachment_bytes("upload", "trace.txt", b"commit boundary", |_, _| true)
            .unwrap();
        workspace.quarantine_attachment(&file.id).unwrap();
        let faults = rusqlite::Connection::open(&path).unwrap();
        faults.execute_batch(&format!("CREATE TABLE fault_parent(id INTEGER PRIMARY KEY); CREATE TABLE fault_child(id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER UPDATE OF purge_state ON attachments WHEN new.purge_state='{state}' BEGIN INSERT INTO fault_child VALUES(1); END;")).unwrap();
        let error = workspace
            .purge_attachment(&file.id)
            .unwrap_err()
            .to_string();
        assert!(error.contains("FOREIGN KEY"), "{error}");
        let current = workspace.attachment(&file.id).unwrap();
        let bytes = dir
            .path()
            .join("workspace.sqlite3.attachments")
            .join(&file.id)
            .join("quarantine/trace.txt");
        if state == "pending" {
            assert_eq!(
                current.purge_state,
                ticketd_core::AttachmentPurgeState::Retained
            );
            assert_eq!(std::fs::read(&bytes).unwrap(), b"commit boundary");
        } else {
            assert_eq!(
                current.purge_state,
                ticketd_core::AttachmentPurgeState::Pending
            );
            assert!(error.contains("pending"), "{error}");
            assert!(!bytes.exists());
        }
        faults.execute_batch("DROP TRIGGER fail_commit").unwrap();
        assert_eq!(
            workspace.purge_attachment(&file.id).unwrap().purge_state,
            ticketd_core::AttachmentPurgeState::Purged
        );
    }
}

#[test]
fn purge_rechecks_new_saved_draft_undo_trash_and_legacy_protections() {
    use ticketd_core::{DocumentPatch, DraftRetention};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"protected", |_, _| true)
        .unwrap();
    let body = format!(
        "[Authored label]({})",
        workspace.attachment_uri(&file.id).unwrap()
    );
    workspace.quarantine_attachment(&file.id).unwrap();
    assert!(
        workspace
            .attachment_cleanup_review(&file.id)
            .unwrap()
            .purge_eligible
    );
    for kind in ["draft", "undo"] {
        let draft = workspace
            .retain_draft(&DraftRetention {
                owner: kind.into(),
                kind: kind.into(),
                revision: 0,
                payload: Some(serde_json::json!({"body":body})),
                markdown: vec![body.clone()],
            })
            .unwrap();
        assert!(workspace.purge_attachment(&file.id).is_err());
        let out = dir.path().join(format!("{kind}.txt"));
        workspace.export_attachment(&file.id, &out).unwrap();
        assert_eq!(std::fs::read(out).unwrap(), b"protected");
        workspace
            .release_draft(&draft.owner, draft.revision)
            .unwrap();
        workspace.quarantine_attachment(&file.id).unwrap();
    }
    let document = workspace.create_document(None, &body).unwrap();
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert!(workspace.purge_attachment(&file.id).is_err());
    workspace.set_document_trashed(&document.id, false).unwrap();
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                body: Some("removed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults
        .execute_batch("UPDATE attachment_draft_cutover SET pending=1")
        .unwrap();
    assert!(
        workspace
            .purge_attachment(&file.id)
            .unwrap_err()
            .to_string()
            .contains("legacy")
    );
    workspace.complete_draft_cutover().unwrap();
    workspace.purge_attachment(&file.id).unwrap();
}

#[test]
fn canonical_undo_racing_purge_either_restores_usable_bytes_or_fails_honestly() {
    for _ in 0..8 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut writer = Workspace::open(&path).unwrap();
        let mut cleaner = Workspace::open(&path).unwrap();
        let file = writer
            .import_attachment_bytes("upload", "trace.txt", b"racing undo", |_, _| true)
            .unwrap();
        let body = format!(
            "[Original label]({})",
            writer.attachment_uri(&file.id).unwrap()
        );
        cleaner.quarantine_attachment(&file.id).unwrap();
        let start = std::sync::Barrier::new(2);
        let (saved, purged) = std::thread::scope(|scope| {
            let purge = scope.spawn(|| {
                start.wait();
                cleaner.purge_attachment(&file.id)
            });
            start.wait();
            let saved = writer.create_document(None, &body);
            (saved, purge.join().unwrap())
        });
        assert_ne!(saved.is_ok(), purged.is_ok());
        if let Ok(document) = saved {
            assert_eq!(document.body, body);
            let out = dir.path().join("undo.txt");
            writer.export_attachment(&file.id, &out).unwrap();
            assert_eq!(std::fs::read(out).unwrap(), b"racing undo");
        } else {
            let error = saved.unwrap_err().to_string();
            assert!(error.contains("purge"), "{error}");
            assert!(
                writer
                    .attachment_usage(&file.id)
                    .unwrap()
                    .protections
                    .is_empty()
            );
        }
    }
}

#[test]
fn recovered_post_purge_undo_keeps_prose_identity_and_unavailable_preview() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"undo", |_, _| true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let body = format!("[Keep this literal label]({uri})");
    workspace
        .write(
            Some("quarantine"),
            ticketd_core::WriteRequest::QuarantineAttachment {
                id: file.id.clone(),
            },
        )
        .unwrap();
    workspace.purge_attachment(&file.id).unwrap();
    let replay = workspace
        .write(
            Some("quarantine"),
            ticketd_core::WriteRequest::QuarantineAttachment {
                id: file.id.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(replay).unwrap()["value"]["purge_state"],
        "purged"
    );
    let draft = workspace
        .retain_draft(&ticketd_core::DraftRetention {
            owner: "late-recovery".into(),
            kind: "undo".into(),
            revision: 0,
            payload: Some(serde_json::json!({"body":body})),
            markdown: vec![body.clone()],
        })
        .unwrap();
    assert_eq!(draft.markdown, vec![body]);
    let preview = workspace
        .attachment_preview(&workspace.attachment_workspace_id().unwrap(), &file.id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&preview).unwrap()["status"],
        "unavailable"
    );
    assert!(preview.message.unwrap().contains("purged"));
    assert!(!preview.can_open);
    assert_eq!(preview.attachment.display_name, "trace.txt");
    assert!(workspace.restore_attachment(&file.id).is_err());
}

#[cfg(windows)]
#[test]
fn deletion_failure_stays_pending_without_automatic_retry_or_unrelated_file_deletion() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"locked bytes", |_, _| true)
        .unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let bytes = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.id)
        .join("quarantine/trace.txt");
    let unrelated = bytes.parent().unwrap().join("unrelated.txt");
    std::fs::write(&unrelated, b"never delete this").unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&bytes)
        .unwrap();
    let error = workspace
        .purge_attachment(&file.id)
        .unwrap_err()
        .to_string();
    assert!(error.contains("pending"), "{error}");
    assert!(error.contains("Retry explicit purge"), "{error}");
    drop(lock);
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        serde_json::to_value(workspace.attachment(&file.id).unwrap()).unwrap()["purge_state"],
        "pending"
    );
    assert_eq!(std::fs::read(&bytes).unwrap(), b"locked bytes");
    assert!(
        workspace
            .backup(dir.path().join("pending.sqlite3"))
            .is_err()
    );
    assert!(bytes.exists(), "backup/read must not retry deletion");
    workspace.purge_attachment(&file.id).unwrap();
    assert!(!bytes.exists());
    assert_eq!(std::fs::read(unrelated).unwrap(), b"never delete this");
}

#[test]
fn interrupted_purge_rejects_unsafe_storage_without_deleting_another_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"managed", |_, _| true)
        .unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let outside = dir.path().join("unrelated.txt");
    std::fs::write(&outside, b"outside storage").unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    // Reproduce restart after committed intent, then damaged metadata. No private hooks.
    faults
        .execute(
            "UPDATE attachments SET purge_state='pending', locator='../unrelated.txt' WHERE id=?1",
            [&file.id],
        )
        .unwrap();
    let error = workspace
        .purge_attachment(&file.id)
        .unwrap_err()
        .to_string();
    assert!(error.contains("Invalid managed"), "{error}");
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside storage");
    faults
        .execute(
            "UPDATE attachments SET locator=?1 WHERE id=?2",
            rusqlite::params![file.locator, file.id],
        )
        .unwrap();
    let bytes = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.id)
        .join("quarantine/trace.txt");
    std::fs::rename(&bytes, bytes.with_extension("preserved")).unwrap();
    std::fs::create_dir(&bytes).unwrap();
    std::fs::write(bytes.join("unrelated.txt"), b"do not recurse").unwrap();
    assert!(
        workspace
            .purge_attachment(&file.id)
            .unwrap_err()
            .to_string()
            .contains("regular file")
    );
    assert_eq!(
        std::fs::read(bytes.join("unrelated.txt")).unwrap(),
        b"do not recurse"
    );
}

#[test]
fn backup_racing_purge_is_a_complete_before_or_after_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "trace.txt", b"consistent snapshot", |_, _| true)
        .unwrap();
    workspace.quarantine_attachment(&file.id).unwrap();
    let backup = dir.path().join("race.sqlite3");
    let start = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let backup_run = scope.spawn(|| {
            let reader = Workspace::open(&path).unwrap();
            start.wait();
            reader.backup(&backup).unwrap();
        });
        start.wait();
        workspace.purge_attachment(&file.id).unwrap();
        backup_run.join().unwrap();
    });
    let target = dir.path().join("restore.sqlite3");
    Workspace::restore(&target, backup).unwrap();
    let mut restored = Workspace::open(target).unwrap();
    match restored.attachment(&file.id).unwrap().purge_state {
        ticketd_core::AttachmentPurgeState::Retained => {
            restored.restore_attachment(&file.id).unwrap();
            let out = dir.path().join("backup.txt");
            restored.export_attachment(&file.id, &out).unwrap();
            assert_eq!(std::fs::read(out).unwrap(), b"consistent snapshot");
        }
        ticketd_core::AttachmentPurgeState::Purged => {
            assert!(restored.restore_attachment(&file.id).is_err())
        }
        ticketd_core::AttachmentPurgeState::Pending => {
            panic!("backup must not publish pending purge")
        }
    }
}

#[test]
fn backup_without_required_purge_status_is_incomplete_and_cannot_restore() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let backup = dir.path().join("damaged.sqlite3");
    workspace.backup(&backup).unwrap();
    rusqlite::Connection::open(&backup)
        .unwrap()
        .execute_batch("ALTER TABLE attachments DROP COLUMN purge_state")
        .unwrap();
    assert!(
        matches!(workspace.inspect_backup(&backup).unwrap().check, ticketd_core::BackupCheck::MissingTables { tables } if tables.contains(&"attachments.purge_state".to_owned()))
    );
    let target = dir.path().join("target.sqlite3");
    assert!(Workspace::restore(&target, &backup).is_err());
    assert!(!target.exists());
}

#[test]
#[ignore = "requires preserved schema53 CLI in TICKETD_SCHEMA53_CLI; run explicitly for real-version upgrade evidence"]
fn real_schema53_upgrade_preserves_quarantine_receipts_and_deliberate_old_backup_restore() {
    let old_cli = std::env::var_os("TICKETD_SCHEMA53_CLI").expect("supply verified schema53 CLI");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let old = |args: &[&str]| -> serde_json::Value {
        let output = std::process::Command::new(&old_cli)
            .env("TICKETD_TEST_WORKSPACE", &path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    };
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"actual schema53 bytes").unwrap();
    let file = old(&[
        "attachment",
        "add",
        source.to_str().unwrap(),
        "--request-id",
        "old-upload",
    ]);
    let id = file["id"].as_str().unwrap();
    old(&[
        "attachment",
        "quarantine",
        id,
        "--request-id",
        "old-quarantine",
    ]);
    let previous = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        previous
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        53
    );
    drop(previous);
    std::fs::remove_file(&source).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let current = workspace.attachment(id).unwrap();
    assert_eq!(
        current.purge_state,
        ticketd_core::AttachmentPurgeState::Retained
    );
    assert!(current.quarantined);
    assert_eq!(
        serde_json::to_value(&current).unwrap()["added_at"],
        file["added_at"]
    );
    assert_eq!(
        workspace
            .import_attachment("old-upload", &source, None)
            .unwrap()
            .id,
        id
    );
    let backups = workspace.safety_backups().unwrap();
    assert_eq!(backups.len(), 1);
    assert!(matches!(
        workspace.inspect_backup(&backups[0].path).unwrap().check,
        ticketd_core::BackupCheck::Valid {
            format_version: 53,
            ..
        }
    ));
    workspace.purge_attachment(id).unwrap();
    assert_eq!(
        workspace
            .import_attachment("old-upload", &source, None)
            .unwrap()
            .purge_state,
        ticketd_core::AttachmentPurgeState::Purged
    );
    let target = dir.path().join("deliberate-restore.sqlite3");
    Workspace::restore(&target, &backups[0].path).unwrap();
    let mut restored = Workspace::open(target).unwrap();
    restored.restore_attachment(id).unwrap();
    let out = dir.path().join("restored.txt");
    restored.export_attachment(id, &out).unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"actual schema53 bytes");
}
