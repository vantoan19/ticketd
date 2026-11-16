#[path = "support/old_workspace.rs"]
mod old_workspace;

use std::fs;

use ticketd_core::{BackupCheck, Workspace};

#[test]
fn complete_backup_includes_unused_trash_and_quarantined_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.txt");
    fs::write(&source, b"retained").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let unused = workspace
        .import_attachment("unused", &source, None)
        .unwrap();
    let trashed = workspace
        .import_attachment("trash", &source, Some("Trashed file"))
        .unwrap();
    let ticket = workspace.create_ticket("Recoverable").unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &trashed.id, true)
        .unwrap();
    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();
    // The retained-byte contract is recursive, independent of reference state.
    // Cleanup will introduce its own public quarantine workflow in a later slice.
    let quarantine = dir
        .path()
        .join("workspace.sqlite3.attachments/quarantine/retained.log");
    fs::create_dir_all(quarantine.parent().unwrap()).unwrap();
    fs::write(quarantine, b"quarantine").unwrap();
    let backup = dir.path().join("complete.sqlite3");
    workspace.backup(&backup).unwrap();
    let inspection = workspace.inspect_backup(&backup).unwrap();
    assert!(matches!(inspection.check, BackupCheck::Valid { .. }));
    let content = inspection.attachment_content.unwrap();
    assert_eq!(content.container_version, Some(1));
    assert_eq!(content.local_snapshots, 2);
    assert_eq!(content.retained_files, 3);
    assert_eq!(content.retained_bytes, 26);
    assert_eq!(content.remote_references, 0);
    fs::remove_file(&source).unwrap();
    drop(workspace);
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let mut restored = Workspace::open(&target).unwrap();
    restored
        .set_trashed(&ticket.reference, false, None)
        .unwrap();
    assert_eq!(
        restored.ticket_attachments(&ticket.reference).unwrap(),
        std::slice::from_ref(&trashed)
    );
    for file in [unused, trashed] {
        let output = dir.path().join(&file.id);
        restored.export_attachment(&file.id, &output).unwrap();
        assert_eq!(fs::read(output).unwrap(), b"retained");
    }
    assert_eq!(
        fs::read(
            dir.path()
                .join("restored.sqlite3.attachments/quarantine/retained.log")
        )
        .unwrap(),
        b"quarantine"
    );
    assert!(
        !restored
            .export()
            .unwrap()
            .to_string()
            .contains("ticketd_backup_files")
    );
    let error = Workspace::open(&backup).err().unwrap().to_string();
    assert!(error.contains("restore-workspace"), "{error}");
}

#[test]
fn missing_retained_bytes_fail_review_and_restore_without_changing_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    workspace.create_ticket("Keep this workspace").unwrap();
    let quarantine = dir
        .path()
        .join("workspace.sqlite3.attachments/quarantine/retained.log");
    fs::create_dir_all(quarantine.parent().unwrap()).unwrap();
    fs::write(&quarantine, b"quarantine").unwrap();
    let backup = dir.path().join("incomplete.sqlite3");
    workspace.backup(&backup).unwrap();
    // Corrupt a backup at the storage boundary, not the workspace's public API.
    rusqlite::Connection::open(&backup)
        .unwrap()
        .execute(
            "DELETE FROM ticketd_backup_files WHERE path='quarantine/retained.log'",
            [],
        )
        .unwrap();
    let check = workspace.inspect_backup(&backup).unwrap().check;
    assert!(matches!(check, BackupCheck::Damaged { .. }), "{check:?}");
    drop(workspace);
    assert!(Workspace::restore(&path, &backup).is_err());
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_ticket("T-KQ1").unwrap().title,
        "Keep this workspace"
    );
    assert_eq!(fs::read(quarantine).unwrap(), b"quarantine");
    assert!(workspace.safety_backups().unwrap().is_empty());
}

#[test]
fn backup_of_missing_local_bytes_is_not_published_or_recorded_as_successful() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.txt");
    fs::write(&source, b"retained").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("missing", &source, None)
        .unwrap();
    let good = dir.path().join("good.sqlite3");
    workspace.backup(&good).unwrap();
    let recorded = workspace.last_backup().unwrap();
    fs::remove_file(
        dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&file.locator),
    )
    .unwrap();
    let bad = dir.path().join("bad.sqlite3");
    let error = workspace.backup(&bad).unwrap_err().to_string();
    assert!(error.contains("missing attachment bytes"), "{error}");
    assert!(!bad.exists());
    assert_eq!(workspace.last_backup().unwrap(), recorded);
    assert_eq!(workspace.attachment(&file.id).unwrap(), file);
}

#[test]
fn missing_current_bytes_name_the_safety_failure_and_allow_separate_target_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("important.txt");
    fs::write(&source, b"recover me").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("recover", &source, None)
        .unwrap();
    let backup = dir.path().join("complete.sqlite3");
    workspace.backup(&backup).unwrap();
    fs::remove_file(
        dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&file.locator),
    )
    .unwrap();
    drop(workspace);
    let error = Workspace::restore(&path, &backup).unwrap_err().to_string();
    assert!(error.contains("current workspace"), "{error}");
    assert!(error.contains("important.txt"), "{error}");
    assert!(error.contains("--target"), "{error}");
    let original = Workspace::open(&path).unwrap();
    assert_eq!(original.attachment(&file.id).unwrap(), file);
    assert!(original.safety_backups().unwrap().is_empty());
    let recovered = dir.path().join("recovered.sqlite3");
    Workspace::restore(&recovered, &backup).unwrap();
    let recovered = Workspace::open(recovered).unwrap();
    let output = dir.path().join("recovered.txt");
    recovered.export_attachment(&file.id, &output).unwrap();
    assert_eq!(fs::read(output).unwrap(), b"recover me");
}

#[test]
fn restored_live_database_does_not_retain_packaged_byte_copies() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("large.bin");
    fs::File::create(&source)
        .unwrap()
        .set_len(2 * 1024 * 1024)
        .unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace.import_attachment("large", &source, None).unwrap();
    let backup = dir.path().join("large.sqlite3");
    workspace.backup(&backup).unwrap();
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let restored = Workspace::open(target).unwrap();
    assert!(
        restored.workspace_info().unwrap().size_bytes < fs::metadata(backup).unwrap().len() / 2
    );
    let output = dir.path().join("export.bin");
    restored.export_attachment(&file.id, &output).unwrap();
    assert_eq!(fs::metadata(output).unwrap().len(), 2 * 1024 * 1024);
}

#[test]
fn same_sized_corruption_and_database_only_copies_with_local_records_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.txt");
    fs::write(&source, b"retained").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .import_attachment("snapshot", &source, None)
        .unwrap();
    let corrupted = dir.path().join("corrupted.sqlite3");
    workspace.backup(&corrupted).unwrap();
    rusqlite::Connection::open(&corrupted)
        .unwrap()
        .execute(
            "UPDATE ticketd_backup_files SET data=?1 WHERE path=?2",
            rusqlite::params![b"replaced", file.locator],
        )
        .unwrap();
    let check = workspace.inspect_backup(&corrupted).unwrap().check;
    assert!(matches!(check, BackupCheck::Damaged { .. }), "{check:?}");
    let raw = dir.path().join("database-only.sqlite3");
    fs::copy(&path, &raw).unwrap();
    let check = workspace.inspect_backup(&raw).unwrap().check;
    assert!(
        matches!(check, BackupCheck::Damaged { ref reason } if reason.contains("missing attachment bytes")),
        "{check:?}"
    );
    drop(workspace);
    for backup in [raw, corrupted] {
        assert!(Workspace::restore(&path, backup).is_err());
    }
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment(&file.id).unwrap(), file);
}

#[test]
fn backup_racing_uploads_restores_only_identities_with_complete_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    drop(Workspace::open(&path).unwrap());
    let source = dir.path().join("race.txt");
    fs::write(&source, b"racing bytes").unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let uploads = {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let mut workspace = Workspace::open(path).unwrap();
            barrier.wait();
            for i in 0..8 {
                workspace
                    .import_attachment(&format!("upload-{i}"), &source, None)
                    .unwrap();
            }
        })
    };
    let workspace = Workspace::open(&path).unwrap();
    barrier.wait();
    let backups: Vec<_> = (0..4)
        .map(|i| {
            let backup = dir.path().join(format!("race-{i}.sqlite3"));
            workspace.backup(&backup).unwrap();
            assert!(matches!(
                workspace.inspect_backup(&backup).unwrap().check,
                BackupCheck::Valid { .. }
            ));
            backup
        })
        .collect();
    uploads.join().unwrap();
    assert_eq!(workspace.attachments(50, 0).unwrap().len(), 8);
    drop(workspace);
    for (i, backup) in backups.iter().enumerate() {
        let restored = dir.path().join(format!("restored-{i}.sqlite3"));
        Workspace::restore(&restored, backup).unwrap();
        let restored = Workspace::open(restored).unwrap();
        for file in restored.attachments(50, 0).unwrap() {
            let output = dir.path().join(format!("{i}-{}", file.id));
            restored.export_attachment(&file.id, &output).unwrap();
            assert_eq!(fs::read(output).unwrap(), b"racing bytes");
        }
    }
}

#[test]
fn attachment_bearing_migration_keeps_a_complete_pre_migration_copy() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    // Format version 47 is the first with Attachments; opening it runs the steps after it.
    let id = old_workspace::workspace_with_attachment(&path, 47, "trace.txt", b"retained");
    let workspace = Workspace::open(&path).unwrap();
    let backups = workspace.safety_backups().unwrap();
    assert_eq!(backups.len(), 1);
    assert!(matches!(
        workspace.inspect_backup(&backups[0].path).unwrap().check,
        BackupCheck::Valid {
            format_version: 47,
            ..
        }
    ));
    let restored = dir.path().join("migrated-copy.sqlite3");
    Workspace::restore(&restored, &backups[0].path).unwrap();
    let restored = Workspace::open(restored).unwrap();
    let output = dir.path().join("migrated.txt");
    restored.export_attachment(&id, &output).unwrap();
    assert_eq!(fs::read(output).unwrap(), b"retained");
}

#[test]
fn reopening_recovers_both_sides_of_an_interrupted_restore_commit() {
    use sha2::{Digest, Sha256};
    for committed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let next = dir.path().join("next.sqlite3");
        let source = dir.path().join("source.txt");
        fs::write(&source, b"old bytes").unwrap();
        let mut previous = Workspace::open(&path).unwrap();
        let old = previous.import_attachment("old", &source, None).unwrap();
        drop(previous);
        fs::write(&source, b"new bytes").unwrap();
        let mut replacement = Workspace::open(&next).unwrap();
        let new = replacement.import_attachment("new", &source, None).unwrap();
        drop(replacement);
        let hash = format!("{:x}", Sha256::digest(fs::read(&next).unwrap()));
        let token = "082f848f-9598-4fe4-b78d-5e8a8c926166";
        let retired = dir
            .path()
            .join(format!("workspace.sqlite3.restore-{token}.attachments"));
        fs::rename(dir.path().join("workspace.sqlite3.attachments"), &retired).unwrap();
        fs::rename(
            dir.path().join("next.sqlite3.attachments"),
            dir.path().join("workspace.sqlite3.attachments"),
        )
        .unwrap();
        if committed {
            fs::copy(&next, &path).unwrap();
        }
        // Seed the durable filesystem boundary as if the process stopped after
        // the root swap, on either side of atomic database replacement.
        let marker = dir.path().join("workspace.sqlite3.restore.json");
        fs::write(
            &marker,
            serde_json::to_vec(&serde_json::json!({
                "token": token, "had_root": true, "database_sha256": hash
            }))
            .unwrap(),
        )
        .unwrap();
        let workspace = Workspace::open(&path).unwrap();
        let expected = if committed { new } else { old };
        assert_eq!(
            workspace.attachments(50, 0).unwrap(),
            std::slice::from_ref(&expected)
        );
        let output = dir.path().join("recovered.txt");
        workspace.export_attachment(&expected.id, &output).unwrap();
        assert_eq!(
            fs::read(output).unwrap(),
            if committed {
                b"new bytes"
            } else {
                b"old bytes"
            }
        );
        assert!(!marker.exists());
        assert!(!retired.exists());
    }
}

#[cfg(windows)]
#[test]
fn failed_atomic_replacement_rolls_back_files_and_keeps_a_complete_safety_copy() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    workspace.create_ticket("Original").unwrap();
    let older = dir.path().join("older.sqlite3");
    workspace.backup(&older).unwrap();
    let source = dir.path().join("trace.txt");
    fs::write(&source, b"retained").unwrap();
    let file = workspace.import_attachment("keep", &source, None).unwrap();
    workspace
        .create_ticket("Keep after failed restore")
        .unwrap();
    drop(workspace);
    // Permit SQLite reads/writes but deny Windows replacement of the live file.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1 | 2)
        .open(&path)
        .unwrap();
    let error = Workspace::restore(&path, &older).unwrap_err();
    let ticketd_core::Error::Restore { safety, .. } = error else {
        panic!("{error}")
    };
    drop(held);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_ticket("T-KQ2").unwrap().title,
        "Keep after failed restore"
    );
    assert_eq!(workspace.attachment(&file.id).unwrap(), file);
    let output = dir.path().join("after-failure.txt");
    workspace.export_attachment(&file.id, &output).unwrap();
    assert_eq!(fs::read(output).unwrap(), b"retained");
    assert!(matches!(
        workspace.inspect_backup(safety).unwrap().check,
        BackupCheck::Valid { .. }
    ));
    assert!(!dir.path().join("workspace.sqlite3.restore.json").exists());
}
