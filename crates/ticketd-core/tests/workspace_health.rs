use std::fs;

use ticketd_core::{FORMAT_VERSION, Workspace, workspace_health};

#[test]
fn a_sound_workspace_reports_its_format_its_size_and_its_rows_without_changing_anything() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    workspace.create_ticket("First").unwrap();
    workspace.create_ticket("Second").unwrap();

    // The Workspace stays open, as it does while the desktop runs.
    let health = workspace_health(&path);

    assert_eq!(health.format_version, Some(FORMAT_VERSION));
    assert_eq!(health.quick_check, "ok");
    assert!(health.file_bytes > 0);
    assert_eq!(health.row_counts["tickets"], 2);
    assert!(health.row_counts.contains_key("documents"));
    // Only what the Workspace stores, not what a search index keeps for itself.
    assert!(
        health
            .row_counts
            .keys()
            .all(|table| !table.starts_with("sqlite_"))
    );
    // The log of the write-ahead journal, if it is there, is counted too.
    let wal = path.with_file_name("workspace.sqlite3-wal");
    assert_eq!(
        health.wal_bytes,
        fs::metadata(wal).map_or(0, |meta| meta.len())
    );
}

#[test]
fn a_file_that_is_not_a_workspace_is_described_rather_than_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    fs::write(&path, vec![b'x'; 4096]).unwrap();

    let health = workspace_health(&path);

    assert_eq!(health.format_version, None);
    assert_ne!(health.quick_check, "ok");
    assert_eq!(health.file_bytes, 4096);
    assert!(health.row_counts.is_empty());
}

#[test]
fn a_missing_file_is_described_too() {
    let dir = tempfile::tempdir().unwrap();

    let health = workspace_health(dir.path().join("nothing.sqlite3"));

    assert_eq!(health.format_version, None);
    assert_eq!(health.file_bytes, 0);
    assert_ne!(health.quick_check, "ok");
}
