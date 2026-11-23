use std::path::Path;

use rusqlite::Connection;
use ticketd_core::source::{Engine, RefreshOptions};
use ticketd_core::{FORMAT_VERSION, Workspace};

const LOCAL_NAME: &str = "connection-backup-sentinel-5d53837c";

#[test]
fn migrates_the_predecessor_and_keeps_publication_and_recovery_evidence() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, FORMAT_VERSION - 1).unwrap();
    let old = Connection::open(&path).unwrap();
    old.execute_batch(
        "INSERT INTO tickets (id, reference, title, status) VALUES
             ('source-ticket', 'T-QZ1', 'Cached title', 'Todo'),
             ('pending-ticket', 'T-QZ2', 'Title to send', 'Todo');
         INSERT INTO source_configurations
             (provider, configuration, account, contract_version, saved_at, derived_configuration, revision)
             VALUES ('github', '{\"repositories\":[\"work/fixtures\"]}', 'first-account', 1,
                     '2026-01-01T00:00:00Z', NULL, 'old-revision');
         INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, partition)
             VALUES ('source-ticket', 'github', '123', 'work/fixtures#1', 'work/fixtures#1',
                     'https://github.com/work/fixtures/issues/1', 'imported', 'work/fixtures');
         INSERT INTO external_ownership (ticket_id, authority) VALUES ('source-ticket', 'external');
         INSERT INTO source_sync (ticket_id, external_state, last_error_code, last_error_message)
             VALUES ('source-ticket', 'open', 'unauthenticated', 'The earlier refresh failed');
         INSERT INTO source_status (provider, last_attempt_at, error_code, error_message, last_checked_tickets)
             VALUES ('github', '2026-01-02T00:00:00Z', 'unauthenticated', 'The earlier refresh failed', 1);
         INSERT INTO publication_attempts
             (id, ticket_id, provider, destination, title, body, status, started_at, lease_expires_at, updated_at, failure_code)
             VALUES ('pending-attempt', 'pending-ticket', 'github', 'work/fixtures', 'Title to send',
                     'Exact payload', 'unresolved', '2026-01-02T00:00:00Z', '2026-01-02T00:00:01Z',
                     '2026-01-02T00:00:01Z', 'unavailable');",
    ).unwrap();
    drop(old);

    let workspace = Workspace::open(&path).unwrap();
    let connection = workspace.source_connection("github").unwrap();
    assert_eq!(connection.id, "github");
    assert_eq!(connection.account, "first-account");
    assert_eq!(connection.saved_at, "2026-01-01T00:00:00Z");
    assert_eq!(
        connection.config["repositories"],
        serde_json::json!(["work/fixtures"])
    );
    let ticket = workspace.show_ticket("T-QZ1").unwrap();
    let source = ticket.source.unwrap();
    assert_eq!(ticket.title, "Cached title");
    assert_eq!(source.id, "123");
    assert_eq!(source.last_error.unwrap().code, "unauthenticated");
    assert_eq!(
        workspace.source_statuses().unwrap()[0].last_checked_tickets,
        Some(1)
    );
    let pending = workspace.publication_attempts("T-QZ2").unwrap().remove(0);
    assert_eq!(pending.id, "pending-attempt");
    assert_eq!(pending.destination, "work/fixtures");
    assert_eq!(pending.body, "Exact payload");

    let recovery = std::fs::read_dir(folder.path())
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(".pre-migration-")
        })
        .unwrap()
        .path();
    let raw = Connection::open(recovery).unwrap();
    let format: i64 = raw
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(format, FORMAT_VERSION - 1);
    let account: String = raw
        .query_row("SELECT account FROM source_configurations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(account, "first-account");
    drop(raw);
    drop(workspace);
    assert_portable_boundary(&path, folder.path());
}

fn assert_portable_boundary(path: &Path, folder: &Path) {
    let backup = folder.join("portable.sqlite3");
    let mut workspace = Workspace::open(path).unwrap();
    workspace.rename_source("github", LOCAL_NAME).unwrap();
    assert!(!workspace.export().unwrap().to_string().contains(LOCAL_NAME));
    workspace.backup(&backup).unwrap();
    assert!(
        !std::fs::read(&backup)
            .unwrap()
            .windows(LOCAL_NAME.len())
            .any(|part| part == LOCAL_NAME.as_bytes())
    );
    let raw = Connection::open(&backup).unwrap();
    let connected: u32 = raw
        .query_row("SELECT COUNT(*) FROM source_connections", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(connected, 0);
    let bound: u32 = raw
        .query_row("SELECT COUNT(*) FROM publication_connections", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(bound, 0);
    drop(raw);
    assert_eq!(
        workspace.source_connection("github").unwrap().name,
        LOCAL_NAME
    );
    drop(workspace);

    let other = folder.join("other.sqlite3");
    Workspace::restore(&other, &backup).unwrap();
    let mut restored = Workspace::open(&other).unwrap();
    assert!(restored.saved_sources().unwrap().is_empty());
    let ticket = restored.show_ticket("T-QZ1").unwrap();
    assert_eq!(
        ticket.source.unwrap().unavailable.unwrap().code,
        "not_configured"
    );
    let review = restored
        .review_publication(&Engine::builtin(), "T-QZ2", true)
        .unwrap();
    assert_eq!(review.attempt.id, "pending-attempt");
    assert!(review.actions.iter().all(|action| !action.available));
    let failure = restored
        .refresh_sources(
            &Engine::builtin(),
            &RefreshOptions {
                ticket: Some("T-QZ1".into()),
                now: None,
            },
        )
        .unwrap();
    assert_eq!(failure.failures[0].code, "not_configured");

    Workspace::restore(path, &backup).unwrap();
    let same = Workspace::open(path).unwrap();
    assert_eq!(same.source_connection("github").unwrap().name, LOCAL_NAME);
    assert_eq!(
        same.publication_attempts("T-QZ2").unwrap()[0].id,
        "pending-attempt"
    );
}
