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
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn copy_of(version: i64, dir: &Path) -> PathBuf {
    let copy = dir.join(format!("backup-v{version}.sqlite3"));
    std::fs::copy(fixture(version), &copy).unwrap();
    copy
}

#[test]
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

#[test]
fn opening_a_legacy_workspace_identifies_github_repositories_without_refreshing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 86).unwrap();
    let connection = Connection::open(&path).unwrap();
    for (index, (provider, locator, url, _)) in LEGACY_ISSUES.iter().enumerate() {
        let id = format!("legacy-{index}");
        let reference = format!("T-KQ{}", index + 1);
        connection.execute("INSERT INTO tickets (id, reference, title, status) VALUES (?1, ?2, 'Legacy issue', 'Todo')", rusqlite::params![id, reference]).unwrap();
        connection.execute("INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin) VALUES (?1, ?2, ?1, ?3, ?3, ?4, 'imported')", rusqlite::params![id, provider, locator, url]).unwrap();
        connection
            .execute(
                "INSERT INTO external_ownership (ticket_id, authority) VALUES (?1, 'external')",
                [&id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO source_sync (ticket_id, external_state) VALUES (?1, 'open')",
                [&id],
            )
            .unwrap();
    }
    drop(connection);

    let workspace = Workspace::open(&path).unwrap();
    let exported = workspace.export().unwrap();
    let identities = exported["external_identities"].as_array().unwrap();
    assert_eq!(identities.len(), LEGACY_ISSUES.len());
    for (identity, (_, locator, url, expected)) in identities.iter().zip(LEGACY_ISSUES) {
        assert_eq!(identity["locator"], locator);
        assert_eq!(identity["url"], url);
        assert_eq!(identity["repository"], serde_json::json!(expected), "{url}");
    }
    assert!(
        workspace
            .list_tickets()
            .unwrap()
            .iter()
            .all(|ticket| ticket.project_id.is_none())
    );
}

const LEGACY_ISSUES: [(&str, &str, &str, Option<&str>); 7] = [
    (
        "github",
        "Owner/Site#42",
        "https://GitHub.com/owner/Site/issues/42",
        Some("github.com/owner/Site"),
    ),
    (
        "github",
        "acme/site#42",
        "https://Git.Example.test:8443/acme/site/issues/42",
        Some("git.example.test/acme/site"),
    ),
    (
        "github",
        "acme/site#42",
        "https://github.com/other/site/issues/42",
        None,
    ),
    (
        "github",
        "acme/site#42",
        "https://github.com/acme/site/issues/43",
        None,
    ),
    ("github", "acme/site#42", "", None),
    (
        "github",
        "acme/site#42",
        "https://github.com/other/../acme/site/issues/42",
        None,
    ),
    (
        "different",
        "acme/site#42",
        "https://github.com/acme/site/issues/42",
        None,
    ),
];
