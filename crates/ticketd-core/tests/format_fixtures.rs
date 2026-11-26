//! Backups saved by the code that shipped older format versions, kept as files.
//!
//! The fixtures hold what that code really wrote, so they catch an edit to an old
//! migration step or to the backup check that the current ladder alone would not
//! show. `scripts/regenerate-format-fixtures` makes them through each commit's own
//! CLI: v55 (#214), v65 (#284), v72 (#375) and v89 (#568).

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
    for version in [55, 65, 72, 89] {
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
        let projects = workspace.list_projects().unwrap();
        assert_eq!(projects.len(), 1, "v{version} kept its Project");
        assert!(!projects[0].archived, "v{version} Project starts active");
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

    const DEVICE_REFERENCE: &str = "73f84c02-9d14-41d9-930f-bb8504b08a92";
    for version in [94, 95] {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("workspace.sqlite3");
        let backup = directory.path().join("backup.sqlite3");
        ticketd_core::create_workspace_at_format_version(&current, version).unwrap();
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
                (id, ticket_id, provider, destination, destination_host, title, body, status, started_at, lease_expires_at, updated_at,
                 external_id, locator, display, url)
                VALUES ('legacy-attempt', 'legacy-publication', 'github', 'owner/repo', 'github.com',
                        'Legacy publication', 'Exact payload', 'unresolved',
                        '2026-01-01T00:01:00Z', '2026-01-01T00:03:00Z', '2026-01-01T00:01:05Z',
                        '42', 'owner/repo#7', 'owner/repo#7', 'https://github.com/owner/repo/issues/7');
             INSERT INTO publication_connections (attempt_id, connection_id)
                VALUES ('legacy-attempt', 'github');",
        ).unwrap();
        if version == 95 {
            // The old format holds a vault pointer. The test does not access the keychain.
            database.execute(
                "INSERT INTO source_secret_references (connection_id, field, reference) VALUES ('github', 'fixture_secret', ?1)",
                ["59f9bc6a-6094-4443-986a-989d61f46f1c"],
            ).unwrap();
        }
        drop(database);
        std::fs::copy(&current, &backup).unwrap();

        let database = Connection::open(&current).unwrap();
        database
            .execute("UPDATE tickets SET title = 'Title before restore'", [])
            .unwrap();
        if version == 95 {
            database
                .execute(
                    "UPDATE source_secret_references SET reference = ?1 WHERE field = 'fixture_secret'",
                    [DEVICE_REFERENCE],
                )
                .unwrap();
        }
        drop(database);

        Workspace::restore(&current, &backup).unwrap();
        let restored = Workspace::open(&current).unwrap();
        assert_eq!(
            restored.show_ticket("T-QZ92").unwrap().title,
            "Legacy publication"
        );
        let connection = restored.source_connection("github").unwrap();
        assert_eq!(connection.name, "Saved on this device");
        assert_eq!(connection.account, "device-account");
        if version == 95 {
            assert_eq!(connection.secret_fields, ["fixture_secret"]);
            let reference: String = Connection::open(&current)
                .unwrap()
                .query_row(
                    "SELECT reference FROM source_secret_references WHERE connection_id = 'github' AND field = 'fixture_secret'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(reference, DEVICE_REFERENCE);
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

#[test]
fn opening_a_format_89_workspace_keeps_github_provenance_and_local_routing() {
    use ticketd_core::source::{Ownership, StateCategory};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 89).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "INSERT INTO projects (id, name, path, remote)
                VALUES ('project-id', 'Site', '/checkout', 'git.example.test/acme/site');
             INSERT INTO tickets (id, reference, title, status, project_id)
                VALUES ('issue-id', 'T-KQ1', 'Imported issue', 'In progress', 'project-id'),
                       ('pending-id', 'T-KQ2', 'Attempted publication', 'Todo', 'project-id');
             INSERT INTO source_configurations (provider, configuration, account, contract_version, saved_at)
                VALUES ('github', '{\"repositories\":[\"acme/site\"]}', 'engineering', 1, '2026-01-01T00:00:00Z');
             INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, repository)
                VALUES ('issue-id', 'github', '@git.example.test:42', 'acme/site#42', 'acme/site#42',
                        'https://git.example.test/acme/site/issues/42', 'imported', 'git.example.test/acme/site');
             INSERT INTO external_ownership (ticket_id, authority) VALUES ('issue-id', 'local');
             INSERT INTO source_sync (ticket_id, external_state)
                VALUES ('issue-id', 'open');
             INSERT INTO publication_attempts
                (id, ticket_id, provider, destination, destination_host, title, body, status, started_at, lease_expires_at, updated_at)
                VALUES ('pending-attempt', 'pending-id', 'github', 'acme/site', 'git.example.test',
                        'Attempted publication', 'Pending payload', 'unresolved',
                        '2026-01-02T00:00:00Z', '2026-01-02T00:02:00Z', '2026-01-02T00:01:00Z');",
        )
        .unwrap();
    drop(connection);

    let workspace = Workspace::open(path).unwrap();
    let ticket = workspace.show_ticket("T-KQ1").unwrap();
    assert_eq!(ticket.status, ticketd_core::Status::InProgress);
    assert_eq!(ticket.project_id.as_deref(), Some("project-id"));
    let source = ticket.source.unwrap();
    assert_eq!(source.id, "@git.example.test:42");
    assert_eq!(source.ownership, Ownership::Local);
    assert_eq!(source.state.category, StateCategory::Open);
    assert_eq!(source.state.name.as_deref(), Some("Open"));
    let exported = workspace.export().unwrap();
    assert_eq!(
        exported["projects"][0]["remote"],
        "git.example.test/acme/site"
    );
    let identity = &exported["external_identities"][0];
    assert_eq!(identity["repository"], "git.example.test/acme/site");
    assert_eq!(identity["partition"], "@git.example.test/acme/site");
    let attempt = &exported["publication_attempts"][0];
    assert_eq!(attempt["destination_host"], "git.example.test");
    assert_eq!(attempt["status"], "unresolved");
    assert_eq!(
        workspace.source_connection("github").unwrap().account,
        "engineering"
    );
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
        connection.execute("INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin) VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'imported')", rusqlite::params![id, provider, (index + 1).to_string(), locator, url]).unwrap();
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
    connection
        .execute(
            "UPDATE tickets SET status = 'Duplicate' WHERE id = 'legacy-1'",
            [],
        )
        .unwrap();
    connection.execute("INSERT INTO external_duplicate_targets (ticket_id, provider, external_id, locator, display, url) VALUES ('legacy-1', 'github', '8', 'acme/site#43', 'acme/site#43', 'https://git.example.test:8443/acme/site/issues/43')", []).unwrap();
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
    let ids: Vec<_> = identities
        .iter()
        .map(|identity| identity["external_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "1",
            "@git.example.test:8443:2",
            "@:3",
            "@:4",
            "@:5",
            "@:6",
            "7",
            "@git.example.test:8443:8"
        ]
    );
    let duplicate = workspace.show_ticket("T-KQ2").unwrap();
    assert!(matches!(duplicate.source.unwrap().duplicate_target,
        Some(ticketd_core::source::DuplicateTarget::External { ticket: Some(reference), .. }) if reference == "T-KQ8"
    ));
    assert!(
        workspace
            .list_tickets()
            .unwrap()
            .iter()
            .all(|ticket| ticket.project_id.is_none())
    );
}

const LEGACY_ISSUES: [(&str, &str, &str, Option<&str>); 8] = [
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
    (
        "github",
        "acme/site#43",
        "https://git.example.test:8443/acme/site/issues/43",
        Some("git.example.test/acme/site"),
    ),
];
