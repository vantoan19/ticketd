#[path = "support/fake_source.rs"]
mod fake_source;

use std::path::Path;

use rusqlite::Connection;
use ticketd_core::source::{Clock, Engine, RefreshCoordinator, RefreshOptions, RefreshPolicy, Run};
use ticketd_core::{self, Status, SyncKind, SyncRecord, TicketPatch, Workspace};

const LOCAL_NAME: &str = "connection-backup-sentinel-5d53837c";

#[test]
fn migrates_the_predecessor_and_keeps_publication_and_recovery_evidence() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 88).unwrap();
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
         INSERT INTO source_sync (ticket_id, state_category, last_error_code, last_error_message)
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
    assert_eq!(format, 88);
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

#[allow(clippy::unwrap_used)] // A broken fixture should fail this test immediately.
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

#[test]
fn refresh_prefers_discovery_then_the_first_local_connection_covering_the_part() {
    let remote = fake_source::FakeSource::default();
    {
        let mut remote = remote.0.lock().unwrap();
        remote.account_from_assignee = true;
        remote
            .issues
            .insert(1, fake_source::issue_in("owner/shared", 1, "Shared issue"));
        remote.matching.push(1);
    }
    let mut engine = Engine::new();
    engine.register(Box::new(remote.clone())).unwrap();
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let alice = values("alice", "owner/shared");
    let bob = values("bob", "owner/shared");
    workspace
        .add_source_connection(&engine, "fake", None, None, &alice)
        .unwrap();
    workspace
        .add_source_connection(&engine, "fake", None, None, &bob)
        .unwrap();

    let import = workspace
        .refresh_connection(&engine, "fake-2", &RefreshOptions::default())
        .unwrap();
    let reference = import.imported[0].clone();
    let only = RefreshOptions {
        ticket: Some(reference.clone()),
        now: None,
    };
    assert!(
        workspace
            .refresh_connection(&engine, "fake", &only)
            .is_err()
    );
    assert!(
        workspace
            .refresh_connection(&engine, "fake-2", &only)
            .unwrap()
            .failures
            .is_empty()
    );
    assert!(
        workspace
            .refresh_sources(&engine, &RefreshOptions::default())
            .unwrap()
            .imported
            .is_empty()
    );
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);

    let backup = folder.path().join("portable.sqlite3");
    workspace.backup(&backup).unwrap();
    let other = folder.path().join("other.sqlite3");
    Workspace::restore(&other, &backup).unwrap();
    let mut restored = Workspace::open(&other).unwrap();
    restored
        .add_source_connection(&engine, "fake", None, None, &alice)
        .unwrap();
    restored
        .add_source_connection(&engine, "fake", None, None, &bob)
        .unwrap();
    assert!(
        restored
            .refresh_connection(&engine, "fake-2", &only)
            .is_err()
    );
    assert!(
        restored
            .refresh_connection(&engine, "fake", &only)
            .unwrap()
            .failures
            .is_empty()
    );
    assert!(
        restored
            .show_ticket(&reference)
            .unwrap()
            .source
            .unwrap()
            .unavailable
            .is_none()
    );
}

#[test]
fn removing_a_connection_preserves_work_and_only_rediscovery_resumes_sync() {
    let remote = fake_source::FakeSource::default();
    {
        let mut remote = remote.0.lock().unwrap();
        remote.account_from_assignee = true;
        remote
            .issues
            .insert(1, fake_source::issue_in("owner/shared", 1, "Original"));
        remote.issues.insert(
            2,
            fake_source::issue_in("owner/shared", 2, "Take this one over"),
        );
        remote.matching = vec![1, 2];
    }
    let mut engine = Engine::new();
    engine.register(Box::new(remote.clone())).unwrap();
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    workspace
        .add_source_connection(
            &engine,
            "fake",
            None,
            None,
            &values("alice", "owner/shared"),
        )
        .unwrap();
    workspace
        .add_source_connection(&engine, "fake", None, None, &values("bob", "owner/shared"))
        .unwrap();
    let import = workspace
        .refresh_connection(&engine, "fake", &RefreshOptions::default())
        .unwrap();
    let first = &import.imported[0];
    let second = &import.imported[1];
    workspace
        .change_ticket(
            first,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .add_activity(first, "My local work", None)
        .unwrap();
    let original = workspace.show_ticket(first).unwrap();

    {
        let mut remote = remote.0.lock().unwrap();
        remote.matching.clear();
        let changed = remote.issues.get_mut(&1).unwrap();
        changed.title = "Edited at the source".into();
        changed.updated_at = "2026-03-01T00:00:00Z".into();
    }
    // A refresh that finished discovery before removal cannot restore the old connection.
    let removal_path = path.clone();
    remote.0.lock().unwrap().before_discovery = Some(std::sync::Arc::new(move || {
        Workspace::open(&removal_path)
            .unwrap()
            .remove_source_connection("fake")
            .unwrap();
    }));
    workspace
        .refresh_connection(&engine, "fake", &RefreshOptions::default())
        .unwrap();

    assert!(workspace.source_connection("fake").is_err());
    let detached = workspace.show_ticket(first).unwrap();
    assert_eq!(detached.title, original.title);
    assert_eq!(detached.body, original.body);
    assert_eq!(detached.status, Status::InProgress);
    assert_eq!(detached.latest_update, original.latest_update);
    let detached_source = detached.source.unwrap();
    assert_eq!(detached_source.id, original.source.unwrap().id);
    assert_eq!(
        detached_source.unavailable.unwrap().code,
        "connection_removed"
    );
    assert!(detached_source.content_locked);

    remote.0.lock().unwrap().fetch_calls.clear();
    workspace
        .refresh_connection(&engine, "fake-2", &RefreshOptions::default())
        .unwrap();
    assert_eq!(workspace.show_ticket(first).unwrap().title, "Original");
    assert_eq!(
        workspace
            .show_ticket(first)
            .unwrap()
            .source
            .unwrap()
            .unavailable
            .unwrap()
            .code,
        "connection_removed"
    );
    assert!(remote.0.lock().unwrap().fetch_calls.is_empty());

    workspace.take_ownership(second, None).unwrap();
    workspace
        .add_source_connection(
            &engine,
            "fake",
            None,
            None,
            &values("alice", "owner/shared"),
        )
        .unwrap();
    assert_eq!(
        workspace
            .show_ticket(first)
            .unwrap()
            .source
            .unwrap()
            .unavailable
            .unwrap()
            .code,
        "connection_removed"
    );
    remote.0.lock().unwrap().matching = vec![1, 2];
    let result = workspace
        .refresh_connection(&engine, "fake", &RefreshOptions::default())
        .unwrap();
    assert!(result.imported.is_empty());
    let resumed = workspace.show_ticket(first).unwrap();
    assert_eq!(resumed.id, original.id);
    assert_eq!(resumed.title, "Edited at the source");
    assert_eq!(resumed.status, Status::InProgress);
    assert!(resumed.source.unwrap().unavailable.is_none());
    let local = workspace.show_ticket(second).unwrap().source.unwrap();
    assert_eq!(local.ownership, ticketd_core::source::Ownership::Local);
    assert_eq!(workspace.list_tickets().unwrap().len(), 2);
}

#[test]
fn a_synced_ticket_without_a_connection_uses_its_cached_provider_and_allows_takeover() {
    const LOCAL_GUIDANCE: &str = "device-local-provider-guidance-8d1a8858";
    const ICON: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>"#;
    let remote = fake_source::FakeSource::default();
    {
        let mut remote = remote.0.lock().unwrap();
        remote.display_name = Some("Beacon Tracker".into());
        remote.presentation.icon_svg = Some(ICON.into());
        remote.presentation.sign_in.desktop_instruction = Some(LOCAL_GUIDANCE.into());
        remote
            .issues
            .insert(1, fake_source::issue_in("owner/shared", 1, "Original"));
        remote.matching = vec![1];
    }
    let mut engine = Engine::new();
    engine.register(Box::new(remote)).unwrap();
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("origin.sqlite3");
    let mut origin = Workspace::open(&path).unwrap();
    origin
        .add_source_connection(
            &engine,
            "fake",
            None,
            Some(LOCAL_NAME),
            &values("alice", "owner/shared"),
        )
        .unwrap();
    let import = origin
        .refresh_connection(&engine, "fake", &RefreshOptions::default())
        .unwrap();
    let reference = &import.imported[0];
    let id = origin.show_ticket(reference).unwrap().id;
    origin.remove_source_connection("fake").unwrap();
    let markdown = origin
        .export_sync_record(SyncKind::Ticket, &id)
        .unwrap()
        .to_markdown();
    assert!(!markdown.contains(LOCAL_NAME));
    assert!(!markdown.contains("connection_removed"));
    assert!(!markdown.contains(LOCAL_GUIDANCE));
    let backup = folder.path().join("portable.sqlite3");
    origin.backup(&backup).unwrap();
    let mut remote = Workspace::open(folder.path().join("other.sqlite3")).unwrap();
    remote
        .apply_sync_record(&SyncRecord::parse(&markdown).unwrap())
        .unwrap();
    let ticket = remote.show_ticket(reference).unwrap();
    assert_eq!(ticket.title, "Original");
    let source = ticket.source.unwrap();
    assert_eq!(source.provider_name, "Beacon Tracker");
    assert_eq!(source.provider_icon_svg.as_deref(), Some(ICON));
    assert!(source.content_locked);
    assert_eq!(source.unavailable.unwrap().code, "not_configured");
    assert_eq!(
        remote
            .take_ownership(reference, None)
            .unwrap()
            .source
            .unwrap()
            .ownership,
        ticketd_core::source::Ownership::Local,
    );

    drop(origin);
    Workspace::restore(&path, &backup).unwrap();
    assert_eq!(
        Workspace::open(&path)
            .unwrap()
            .show_ticket(reference)
            .unwrap()
            .source
            .unwrap()
            .unavailable
            .unwrap()
            .code,
        "connection_removed",
    );
    let portable_path = folder.path().join("restored.sqlite3");
    Workspace::restore(&portable_path, &backup).unwrap();
    let portable = Workspace::open(&portable_path)
        .unwrap()
        .show_ticket(reference)
        .unwrap()
        .source
        .unwrap();
    assert_eq!(portable.provider_name, "Beacon Tracker");
    assert_eq!(portable.provider_icon_svg.as_deref(), Some(ICON));
    assert_eq!(portable.unavailable.unwrap().code, "not_configured");
}

#[test]
fn a_staggered_second_connection_runs_while_the_first_is_rate_limited() {
    let remote = fake_source::FakeSource::default();
    remote.0.lock().unwrap().account_from_assignee = true;
    let mut engine = Engine::new();
    engine.register(Box::new(remote.clone())).unwrap();
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("workspace.sqlite3");
    let open = || Workspace::open(&path);
    let mut workspace = open().unwrap();
    workspace
        .add_source_connection(&engine, "fake", None, None, &values("alice", "owner/alice"))
        .unwrap();
    workspace
        .add_source_connection(&engine, "fake", None, None, &values("bob", "owner/bob"))
        .unwrap();
    drop(workspace);
    remote.0.lock().unwrap().rate_limited_account = Some("alice".into());

    let clock = std::sync::Arc::new(TestClock::default());
    let coordinator = RefreshCoordinator::new(clock.clone(), RefreshPolicy::default());
    let Run::Ran(first) = coordinator.tick(&engine, &open).unwrap() else {
        unreachable!()
    };
    assert_eq!(first.failures[0].connection_id.as_deref(), Some("fake"));
    let statuses = open().unwrap().source_statuses().unwrap();
    assert_eq!(
        statuses[1].health,
        ticketd_core::source::SourceHealth::Waiting
    );
    clock.0.store(2, std::sync::atomic::Ordering::Relaxed);
    let Run::Ran(second) = coordinator.tick(&engine, &open).unwrap() else {
        unreachable!()
    };
    assert!(second.failures.is_empty());
    let statuses = open().unwrap().source_statuses().unwrap();
    assert_eq!(
        statuses[0].health,
        ticketd_core::source::SourceHealth::Delayed
    );
    assert_eq!(
        statuses[1].health,
        ticketd_core::source::SourceHealth::Synced
    );
}

#[derive(Default)]
struct TestClock(std::sync::atomic::AtomicU64);

impl Clock for TestClock {
    fn now_secs(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

fn values(account: &str, repository: &str) -> ticketd_core::source::ConfigValues {
    [
        ("assignee".into(), serde_json::json!(account)),
        ("repositories".into(), serde_json::json!([repository])),
    ]
    .into_iter()
    .collect()
}

#[test]
fn restoring_a_legacy_backup_preserves_the_devices_own_settings() {
    let folder = tempfile::tempdir().unwrap();
    let backup = folder.path().join("legacy-backup.sqlite3");
    let current = folder.path().join("legacy-workspace.sqlite3");
    for (path, account) in [(&backup, "backup-account"), (&current, "device-account")] {
        ticketd_core::create_workspace_at_format_version(path, FORMAT_VERSION - 1).unwrap();
        Connection::open(path)
            .unwrap()
            .execute(
                "INSERT INTO source_configurations (provider, configuration, account, contract_version)
                 VALUES ('github', '{\"repositories\":[\"owner/repo\"]}', ?1, 1)",
                [account],
            )
            .unwrap();
    }

    let empty = folder.path().join("new-workspace.sqlite3");
    Workspace::restore(&empty, &backup).unwrap();
    assert!(
        Workspace::open(&empty)
            .unwrap()
            .saved_sources()
            .unwrap()
            .is_empty()
    );

    let safety = Workspace::restore(&current, &backup).unwrap();
    let restored = Workspace::open(&current).unwrap();
    assert_eq!(
        restored.source_connection("github").unwrap().account,
        "device-account"
    );
    let recovery = Connection::open(safety).unwrap();
    let account: String = recovery
        .query_row("SELECT account FROM source_configurations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(account, "device-account");
}
