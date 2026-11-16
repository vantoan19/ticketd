//! Backups saved by the code that shipped older format versions, kept as files.
//!
//! The fixtures hold what that code really wrote, so they catch an edit to an old
//! migration step or to the backup check that the current ladder alone would not
//! show. `scripts/regenerate-format-fixtures` makes them through each commit's own
//! CLI: v55 (#214), v65 (#284) and v72 (#375).

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use ticketd_core::{BackupCheck, FORMAT_VERSION, Workspace};

fn fixture(version: i64) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/format")
        .join(format!("v{version}.sqlite3"))
}

/// A copy in a fresh folder, so no test touches the checked-in file.
#[allow(clippy::unwrap_used)]
fn copy_of(version: i64, dir: &Path) -> PathBuf {
    let copy = dir.join(format!("backup-v{version}.sqlite3"));
    std::fs::copy(fixture(version), &copy).unwrap();
    copy
}

#[test]
#[allow(clippy::unwrap_used)]
fn a_backup_saved_by_older_code_validates_restores_and_migrates_to_the_current_version() {
    for version in [55, 65, 72] {
        let dir = tempfile::tempdir().unwrap();
        let backup = copy_of(version, dir.path());
        let stored: i64 = Connection::open(&backup)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(stored, version, "the fixture is a v{version} Workspace");

        let current = Workspace::open(dir.path().join("current.sqlite3")).unwrap();
        let check = current.inspect_backup(&backup).unwrap().check;
        let BackupCheck::Valid {
            format_version,
            summary,
        } = check
        else {
            panic!("v{version} fixture should validate as a backup, got {check:?}");
        };
        assert_eq!(i64::from(format_version), version);
        // Two tickets outside Trash, two Activities, and the Documents made on the way.
        assert_eq!((summary.tickets, summary.activities), (2, 2), "v{version}");
        assert!(summary.documents >= 1, "v{version}");
        drop(current);

        let restored = dir.path().join("restored.sqlite3");
        Workspace::restore(&restored, &backup).unwrap();
        let workspace = Workspace::open(&restored).unwrap();
        assert_eq!(workspace.list_tickets().unwrap().len(), 2, "v{version}");
        drop(workspace);
        let migrated: i64 = Connection::open(&restored)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(migrated, FORMAT_VERSION, "v{version} migrates to current");
    }
}
