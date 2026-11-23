//! Backups saved by the code that shipped older format versions, kept as files.
//!
//! The fixtures hold what that code really wrote, so they catch an edit to an old
//! migration step or to the backup check that the current ladder alone would not
//! show. `scripts/regenerate-format-fixtures` makes them through each commit's own
//! CLI: v55 (#214), v65 (#284), v72 (#375) and v90 (#562).

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
    for version in [55, 65, 72, 90] {
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
fn restoring_older_source_workspaces_keeps_local_binding_and_credential_reference() {
    use ticketd_core::source::{ActionKind, AttemptState, Engine};

    for version in [90, 91] {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("workspace.sqlite3");
        let backup = directory.path().join("backup.sqlite3");
        if version == 90 {
            let original = copy_of(version, directory.path());
            // Extract the fixture's real attachments, then use its historical
            // SQLite schema as the active file beside them.
            Workspace::restore(&current, &original).unwrap();
            std::fs::copy(original, &current).unwrap();
        } else {
            ticketd_core::create_workspace_at_format_version(&current, version).unwrap();
        }
        let database = Connection::open(&current).unwrap();
        database.execute_batch(
            "INSERT INTO tickets (id, reference, title, status)
                VALUES ('legacy-publication', 'T-QZ92', 'Legacy publication', 'Todo');
             INSERT INTO source_connections
                (id, name, provider, site, configuration, account, account_key,
                 contract_version, saved_at, revision)
                VALUES ('github', 'Saved on this device', 'github', '', '{\"repositories\":[\"owner/repo\"]}',
                        'device-account', 'device-account', 2, '2026-01-01T00:00:00Z', 'old-revision');
             INSERT INTO publication_attempts
                (id, ticket_id, provider, destination, title, body, status, started_at, lease_expires_at, updated_at)
                VALUES ('legacy-attempt', 'legacy-publication', 'github', 'owner/repo',
                        'Legacy publication', 'Exact payload', 'unresolved',
                        '2026-01-01T00:01:00Z', '2026-01-01T00:03:00Z', '2026-01-01T00:01:05Z');
             INSERT INTO publication_connections (attempt_id, connection_id)
                VALUES ('legacy-attempt', 'github');",
        ).unwrap();
        if version == 91 {
            // The old format holds a vault pointer. The test does not access the keychain.
            database.execute(
                "INSERT INTO source_secret_references (connection_id, field, reference) VALUES ('github', 'fixture_secret', ?1)",
                ["59f9bc6a-6094-4443-986a-989d61f46f1c"],
            ).unwrap();
        }
        drop(database);
        std::fs::copy(&current, &backup).unwrap();
        if version == 90 {
            // Only the incoming backup keeps its container wrapper.
            Connection::open(&current)
                .unwrap()
                .execute_batch(
                    "DROP TABLE ticketd_backup_files; DROP TABLE ticketd_backup_container;",
                )
                .unwrap();
        }

        Workspace::restore(&current, &backup).unwrap();
        let restored = Workspace::open(current).unwrap();
        let connection = restored.source_connection("github").unwrap();
        assert_eq!(connection.name, "Saved on this device");
        assert_eq!(connection.account, "device-account");
        if version == 91 {
            assert_eq!(connection.secret_fields, ["fixture_secret"]);
        }
        let review = restored
            .review_publication(&Engine::builtin(), "T-QZ92", false)
            .unwrap();
        assert_eq!(review.attempt.id, "legacy-attempt");
        assert_eq!(review.attempt.state, AttemptState::Unresolved);
        assert_eq!(review.attempt.body, "Exact payload");
        assert!(
            review
                .actions
                .iter()
                .any(|action| action.kind == ActionKind::Attach && action.available)
        );
    }
}
