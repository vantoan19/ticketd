//! Attachments, backups and restores fail clearly and recoverably: bounded uploads, named
//! files and folders, one wording for an unusable backup, and no leftovers.
use std::{fs, path::Path};

use rusqlite::Connection;
use ticketd_core::{BackupCheck, DISPLAY_NAME_LIMIT, MAX_BACKUP_FILE_BYTES, Workspace};

// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
fn workspace(dir: &Path) -> Workspace {
    Workspace::open(dir.join("workspace.sqlite3")).unwrap()
}

#[test]
fn the_upload_limit_never_exceeds_what_a_backup_can_hold() {
    let dir = tempfile::tempdir().unwrap();
    let w = workspace(dir.path());
    let error = w
        .set_attachment_upload_limit(9_223_372_036_854_775_806)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains(&MAX_BACKUP_FILE_BYTES.to_string()),
        "{error}"
    );
    w.set_attachment_upload_limit(MAX_BACKUP_FILE_BYTES)
        .unwrap();
    drop(w);
    // A larger limit saved by an earlier version is held to the same bound.
    Connection::open(dir.path().join("workspace.sqlite3"))
        .unwrap()
        .execute(
            "UPDATE attachment_upload_settings SET limit_bytes = 9223372036854775806",
            [],
        )
        .unwrap();
    assert_eq!(
        workspace(dir.path()).attachment_upload_limit().unwrap(),
        MAX_BACKUP_FILE_BYTES
    );
}

#[test]
fn a_blob_of_the_largest_backup_file_fits_in_sqlite() {
    let connection = Connection::open_in_memory().unwrap();
    let length = |bytes: u64| {
        connection.query_row("SELECT length(zeroblob(?1))", [bytes], |r| {
            r.get::<_, i64>(0)
        })
    };
    // Room for the row's path, size and checksum beside the bytes.
    assert!(length(MAX_BACKUP_FILE_BYTES + 4096).is_ok());
    // The bound is SQLite's own: a blob past it cannot be stored at all.
    assert!(length(1_000_000_001).is_err());
    assert!(MAX_BACKUP_FILE_BYTES <= i32::MAX as u64);
}

#[test]
fn a_backup_that_cannot_hold_a_file_names_it_and_says_what_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = workspace(dir.path());
    let file = w
        .import_attachment_bytes("up", "huge.bin", b"x", |_, _| true)
        .unwrap();
    // A sparse file stands in for one past the limit without writing gigabytes.
    let stored = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.locator);
    fs::OpenOptions::new()
        .write(true)
        .open(stored)
        .unwrap()
        .set_len(MAX_BACKUP_FILE_BYTES + 1)
        .unwrap();
    let error = w
        .backup(dir.path().join("b.sqlite3"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("huge.bin"), "{error}");
    assert!(error.contains(&file.id), "{error}");
    assert!(error.contains("attachment export"), "{error}");
    assert!(error.contains("attachment purge"), "{error}");
    assert!(!dir.path().join("b.sqlite3").exists());
}

#[test]
fn a_backup_carries_no_free_pages_for_the_files_it_holds() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = workspace(dir.path());
    let bytes: Vec<u8> = (0..2_000_000u32)
        .map(|n| (n.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    w.import_attachment_bytes("up", "data.bin", &bytes, |_, _| true)
        .unwrap();
    let backup = dir.path().join("b.sqlite3");
    w.backup(&backup).unwrap();
    let connection = Connection::open(&backup).unwrap();
    let free: i64 = connection
        .pragma_query_value(None, "freelist_count", |r| r.get(0))
        .unwrap();
    let pages: i64 = connection
        .pragma_query_value(None, "page_count", |r| r.get(0))
        .unwrap();
    assert!(pages > 400, "the file is in the backup: {pages} pages");
    assert!(free * 20 < pages, "{free} of {pages} pages are free");
}

#[test]
fn unusable_backups_are_worded_alike_by_inspection_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let w = workspace(dir.path());
    let backup = dir.path().join("good.sqlite3");
    w.backup(&backup).unwrap();
    let bytes = fs::read(&backup).unwrap();
    let text = dir.path().join("text.sqlite3");
    fs::write(&text, b"not a backup").unwrap();
    let cut = dir.path().join("cut.sqlite3");
    fs::write(&cut, &bytes[..5000]).unwrap();
    let mut flipped = bytes.clone();
    for byte in &mut flipped[110..170] {
        *byte ^= 0xFF;
    }
    let flip = dir.path().join("flip.sqlite3");
    fs::write(&flip, flipped).unwrap();
    let newer = dir.path().join("newer.sqlite3");
    fs::copy(&backup, &newer).unwrap();
    Connection::open(&newer)
        .unwrap()
        .pragma_update(None, "user_version", 999)
        .unwrap();

    for (file, expected) in [
        (&text, "not a ticketd backup"),
        (&cut, "damaged"),
        (&flip, "damaged"),
        (&newer, "update ticketd"),
    ] {
        let check = w.inspect_backup(file).unwrap().check;
        let refusal = check.refusal().unwrap_or_else(|| panic!("{check:?}"));
        assert!(refusal.contains(expected), "{refusal}");
        assert!(refusal.len() < 400 && !refusal.contains('\n'), "{refusal}");
        let target = dir.path().join("restored.sqlite3");
        let error = Workspace::restore(&target, file).unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
        assert!(error.len() < 400 && !error.contains('\n'), "{error}");
        assert!(
            error.matches("backup or restore failed").count() <= 1,
            "{error}"
        );
        assert!(!target.exists());
        assert!(
            !Path::new(&format!("{}.lock", target.display())).exists(),
            "a failed restore leaves no lock file"
        );
    }
    assert!(matches!(
        w.inspect_backup(&flip).unwrap().check,
        BackupCheck::Damaged { .. }
    ));
}

#[test]
fn a_damaged_attachment_inventory_has_one_failure_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = workspace(dir.path());
    w.import_attachment_bytes("up", "a.txt", b"bytes", |_, _| true)
        .unwrap();
    let backup = dir.path().join("b.sqlite3");
    w.backup(&backup).unwrap();
    Connection::open(&backup)
        .unwrap()
        .execute("DELETE FROM ticketd_backup_files", [])
        .unwrap();
    let error = Workspace::restore(dir.path().join("t.sqlite3"), &backup)
        .unwrap_err()
        .to_string();
    assert_eq!(
        error.matches("backup or restore failed").count(),
        1,
        "{error}"
    );
}

#[test]
fn the_backup_and_target_paths_are_named_when_they_are_wrong() {
    let dir = tempfile::tempdir().unwrap();
    let w = workspace(dir.path());
    let backup = dir.path().join("b.sqlite3");
    w.backup(&backup).unwrap();
    let missing = dir.path().join("missing.sqlite3");
    let folder = dir.path().join("folder");
    fs::create_dir(&folder).unwrap();
    for path in [&missing, &folder] {
        let inspected = w.inspect_backup(path).unwrap_err().to_string();
        let restored = Workspace::restore(dir.path().join("t.sqlite3"), path)
            .unwrap_err()
            .to_string();
        assert!(
            inspected.contains(&path.display().to_string()),
            "{inspected}"
        );
        assert!(restored.contains(&path.display().to_string()), "{restored}");
    }
    let target = dir.path().join("nodir/restored.sqlite3");
    let error = Workspace::restore(&target, &backup)
        .unwrap_err()
        .to_string();
    assert!(error.contains("target folder not found"), "{error}");
    assert!(error.contains("nodir"), "{error}");
}

#[cfg(unix)]
#[test]
fn files_that_cannot_be_used_are_refused_by_name_without_waiting() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let mut w = workspace(dir.path());
    let fifo = dir.path().join("pipe");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let error = w
        .import_attachment("fifo", &fifo, None)
        .unwrap_err()
        .to_string();
    assert!(error.contains("regular file"), "{error}");

    let secret = dir.path().join("secret.txt");
    fs::write(&secret, b"s").unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();
    let readonly = dir.path().join("readonly");
    fs::create_dir(&readonly).unwrap();
    fs::set_permissions(&readonly, fs::Permissions::from_mode(0o555)).unwrap();
    // Permissions do not bind a privileged user.
    if fs::File::open(&secret).is_err() {
        let error = w
            .import_attachment("secret", &secret, None)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("secret.txt") && error.contains("permission denied"),
            "{error}"
        );
        assert!(!error.contains("workspace directory"), "{error}");
        let error = w
            .export_file(readonly.join("out.json"))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("readonly") && error.contains("permission denied"),
            "{error}"
        );
        assert!(!error.contains("workspace directory"), "{error}");
    }
    fs::set_permissions(&readonly, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).unwrap();
}

#[test]
fn a_purged_attachment_is_unavailable_everywhere_and_cannot_be_quarantined_again() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = workspace(dir.path());
    let file = w
        .import_attachment_bytes("up", "trace.txt", b"gone", |_, _| true)
        .unwrap();
    w.quarantine_attachment(&file.id).unwrap();
    w.purge_attachment(&file.id).unwrap();
    assert!(!w.attachment_usage(&file.id).unwrap().eligible);
    let error = w.quarantine_attachment(&file.id).unwrap_err().to_string();
    assert!(error.contains("purged"), "{error}");
}

#[test]
fn display_names_are_trimmed_single_line_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = workspace(dir.path());
    let file = w
        .import_attachment_bytes("up", "a.txt", b"a", |_, _| true)
        .unwrap();
    assert_eq!(
        w.rename_attachment(&file.id, "  Trim me  ")
            .unwrap()
            .display_name,
        "Trim me"
    );
    for bad in [
        "x\ny",
        "tab\there",
        "   ",
        &"n".repeat(DISPLAY_NAME_LIMIT + 1),
    ] {
        assert!(w.rename_attachment(&file.id, bad).is_err(), "{bad:?}");
    }
    let named = w
        .import_attachment("up2", dir.path().join("workspace.sqlite3"), Some(" Name "))
        .unwrap();
    assert_eq!(named.display_name, "Name");
    assert!(
        w.import_attachment("up3", dir.path().join("workspace.sqlite3"), Some("a\nb"))
            .is_err()
    );
}
