//! Automatic refresh, freshness, and the Source unavailable state, through the
//! workspace workflow boundary with a controllable fake connector and a manual clock.
// Clippy exempts #[test] functions but not the fake connector and fixture helpers they
// share; those unwrap so a broken setup fails the test loudly.
#![allow(clippy::unwrap_used)]

#[path = "support/fake_source.rs"]
mod fake_source;

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

use serde_json::json;
use ticketd_core::{
    self, Status, Workspace,
    source::{
        Clock, Engine, ExternalIssue, ExternalState, FailureScope, RefreshCoordinator,
        RefreshOptions, RefreshPolicy, RefreshReport, Run, Skip, SourceHealth, StateCategory,
        TicketSource,
    },
};

use fake_source::{Failure, FakeSource, Remote};

fn issue(id: u64, updated_at: &str) -> ExternalIssue {
    let mut issue = fake_source::issue(id, &format!("Issue {id}"));
    issue.body = "Body".into();
    issue.author = None;
    issue.updated_at = updated_at.into();
    issue
}

const T0: &str = "2026-02-01T00:00:00Z";
const T1: &str = "2026-02-01T00:10:00Z";
const T2: &str = "2026-02-01T00:20:00Z";
const T3: &str = "2026-02-01T00:30:00Z";
/// Seconds since the Unix epoch of 2026-02-01T00:00:00Z.
const DAY: u64 = 20_485 * 86_400;

struct Fixture {
    fake: FakeSource,
    engine: Engine,
    workspace: Workspace,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fake = FakeSource::default();
        let mut engine = Engine::new();
        engine.register(Box::new(fake.clone())).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        let config = json!({"repositories": ["o/r"]})
            .as_object()
            .unwrap()
            .clone();
        workspace.save_source(&engine, "fake", &config).unwrap();
        Self {
            fake,
            engine,
            workspace,
            dir,
        }
    }
    fn remote(&self, change: impl FnOnce(&mut Remote)) {
        change(&mut self.fake.0.lock().unwrap());
    }
    fn publish(&self, issue: ExternalIssue) {
        self.remote(|remote| {
            let id: u64 = issue.reference.identity.id.parse().unwrap();
            if !remote.matching.contains(&id) {
                remote.matching.push(id);
            }
            remote.issues.insert(id, issue);
        });
    }
    fn refresh_at(&mut self, now: &str) -> RefreshReport {
        self.workspace
            .refresh_sources(
                &self.engine,
                &RefreshOptions {
                    ticket: None,
                    now: Some(now.into()),
                },
            )
            .unwrap()
    }
    fn source(&self, number: u32) -> TicketSource {
        self.workspace
            .show_ticket(&format!("T-KQ{number}"))
            .unwrap()
            .source
            .unwrap()
    }
    fn open_workspace(&self) -> Result<Workspace, ticketd_core::Error> {
        Workspace::open(self.dir.path().join("workspace.sqlite3"))
    }
}

#[test]
fn refresh_checks_the_connection_before_reading_discovery_or_tracked_issues() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.refresh_at(T0);
    f.remote(|remote| {
        remote.issues.get_mut(&1).unwrap().title = "Title without a verified connection".into();
        remote.matching.clear();
        remote.connection_error = Some("the credential expired".into());
    });
    let report = f.refresh_at(T1);
    assert_eq!(report.failures[0].scope, FailureScope::Source);
    assert_eq!(report.failures[0].code, "unauthenticated");
    assert_eq!(f.workspace.show_ticket("T-KQ1").unwrap().title, "Issue 1");
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(status.last_refreshed_at.as_deref(), Some(T0));
    assert_eq!(status.error.unwrap().code, "unauthenticated");
}

#[test]
fn provider_checked_count_tracks_accepted_runs_and_survives_failures_and_reopen() {
    let mut f = Fixture::new();
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(
        (status.last_checked_tickets, status.tracked_tickets),
        (None, 0)
    );
    f.publish(issue(1, T0));
    f.publish(issue(2, T0));
    f.remote(|remote| remote.matching.push(1));
    f.refresh_at(T0);
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(
        (status.last_checked_tickets, status.tracked_tickets),
        (Some(2), 2)
    );

    // One discovered issue is also tracked; another leaves discovery and its
    // direct read fails. A newly discovered issue counts once as well.
    f.publish(issue(3, T0));
    f.remote(|remote| {
        remote.matching.retain(|id| *id != 2);
        remote.deleted.push(2);
    });
    f.refresh_at(T1);
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(status.health, SourceHealth::Partial);
    assert_eq!(
        (status.last_checked_tickets, status.tracked_tickets),
        (Some(3), 3)
    );
    assert_eq!(status.last_refreshed_at.as_deref(), Some(T1));
    assert_eq!(
        f.workspace.export().unwrap()["source_status"],
        serde_json::json!([])
    );

    // A single-ticket read is not a whole-provider run.
    f.workspace
        .refresh_sources(
            &f.engine,
            &RefreshOptions {
                ticket: Some("T-KQ1".into()),
                now: Some(T2.into()),
            },
        )
        .unwrap();
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(
        (
            status.last_checked_tickets,
            status.last_refreshed_at.as_deref()
        ),
        (Some(3), Some(T1))
    );
    f.workspace.take_ownership("T-KQ2", None).unwrap();
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(
        (status.last_checked_tickets, status.tracked_tickets),
        (Some(3), 2)
    );

    f.remote(|remote| remote.outage = Some(Failure::Unavailable));
    f.refresh_at(T3);
    let reopened = f.open_workspace().unwrap();
    let status = reopened.source_statuses().unwrap().remove(0);
    assert_eq!(
        (status.last_checked_tickets, status.tracked_tickets),
        (Some(3), 2)
    );
    assert_eq!(status.last_refreshed_at.as_deref(), Some(T1));
    assert!(status.error.is_some());
}

#[test]
fn older_serialized_source_status_defaults_the_added_fields() {
    let f = Fixture::new();
    let mut value = serde_json::to_value(&f.workspace.source_statuses().unwrap()[0]).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("last_checked_tickets");
    object.remove("tracked_tickets");
    let status: ticketd_core::source::SourceStatus = serde_json::from_value(value).unwrap();
    assert_eq!(
        (status.last_checked_tickets, status.tracked_tickets),
        (None, 0)
    );
}

#[test]
fn migration_from_28_keeps_freshness_but_does_not_invent_a_count() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 28).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "INSERT INTO tickets (id, title, status) VALUES ('issue-1', 'Old ticket', 'Todo');
         INSERT INTO source_configurations (provider, configuration, account, contract_version)
           VALUES ('fake', '{\"repositories\":[\"o/r\"]}', 'octo', 1);
         INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin)
           VALUES ('issue-1', 'fake', '1', 'o/r#1', 'o/r#1', 'https://example.test/o/r/issues/1', 'imported');
         INSERT INTO external_ownership (ticket_id, authority) VALUES ('issue-1', 'external');
         INSERT INTO source_sync (ticket_id, external_state) VALUES ('issue-1', 'open');",
    )
    .unwrap();
    db.execute(
        "INSERT INTO source_status (provider, last_refreshed_at) VALUES ('fake', ?1)",
        [T0],
    )
    .unwrap();
    drop(db);
    let migrated = Workspace::open(path).unwrap();
    let status = migrated.source_statuses().unwrap().remove(0);
    assert_eq!(status.last_refreshed_at.as_deref(), Some(T0));
    assert_eq!(
        (status.last_checked_tickets, status.tracked_tickets),
        (None, 1)
    );
}

#[test]
fn an_outage_marks_tickets_unavailable_since_the_first_failure_and_keeps_everything() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.refresh_at(T0);
    assert!(f.source(1).unavailable.is_none());

    f.remote(|r| r.outage = Some(Failure::Unavailable));
    let report = f.refresh_at(T1);
    assert_eq!(report.failures.len(), 2, "discovery and the ticket");
    let source = f.source(1);
    let unavailable = source.unavailable.clone().unwrap();
    assert_eq!(unavailable.code, "unavailable");
    assert_eq!(unavailable.since, T1);
    // Nothing is deleted, completed, or presented as refreshed.
    assert_eq!(source.last_refreshed_at.as_deref(), Some(T0));
    assert_eq!(source.last_attempt_at.as_deref(), Some(T1));
    let ticket = f.workspace.show_ticket("T-KQ1").unwrap();
    assert_eq!(ticket.status, Status::Todo);
    assert_eq!(ticket.title, "Issue 1");
    let metadata = f
        .workspace
        .find_ticket_metadata(
            &ticketd_core::TicketFilter::default(),
            Some(ticketd_core::MetadataSelection::Ids(std::slice::from_ref(
                &ticket.id,
            ))),
            true,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&metadata.items[0].source.as_ref().unwrap().unavailable).unwrap(),
        serde_json::to_value(&source.unavailable).unwrap()
    );

    // A second failure keeps the original "since".
    f.refresh_at(T2);
    assert_eq!(f.source(1).unavailable.unwrap().since, T1);

    // Recovery clears the state and advances freshness.
    f.remote(|r| r.outage = None);
    f.refresh_at(T3);
    let source = f.source(1);
    assert!(source.unavailable.is_none() && source.last_error.is_none());
    assert_eq!(source.last_refreshed_at.as_deref(), Some(T3));
    let metadata = f
        .workspace
        .find_ticket_metadata(
            &ticketd_core::TicketFilter::default(),
            Some(ticketd_core::MetadataSelection::Ids(std::slice::from_ref(
                &ticket.id,
            ))),
            true,
        )
        .unwrap();
    assert!(
        metadata.items[0]
            .source
            .as_ref()
            .unwrap()
            .unavailable
            .is_none()
    );
}

#[test]
fn a_failed_discovery_is_recorded_per_source_even_with_no_tracked_tickets() {
    let mut f = Fixture::new();
    f.remote(|r| r.outage = Some(Failure::Forbidden));
    f.refresh_at(T1);
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(status.provider, "fake");
    assert_eq!(status.error.as_ref().unwrap().code, "forbidden");
    assert_eq!(status.failing_since.as_deref(), Some(T1));
    assert_eq!(status.last_attempt_at.as_deref(), Some(T1));
    assert_eq!(status.last_refreshed_at, None);

    f.remote(|r| r.outage = None);
    f.refresh_at(T2);
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert!(status.error.is_none() && status.failing_since.is_none());
    assert_eq!(status.last_refreshed_at.as_deref(), Some(T2));
}

#[test]
fn an_unreachable_source_is_not_an_empty_discovery_result() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.publish(issue(2, T0));
    f.refresh_at(T0);
    f.remote(|r| r.outage = Some(Failure::Unavailable));
    f.refresh_at(T1);
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 2);
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(status.unavailable_tickets, 2);
    assert_eq!(status.last_refreshed_at.as_deref(), Some(T0));
}

#[test]
fn a_rate_limit_is_delayed_not_unavailable_and_records_when_to_ask_again() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.refresh_at(T0);
    f.remote(|r| r.outage = Some(Failure::RateLimited(Some(600))));
    let report = f.refresh_at(T1);
    assert_eq!(report.failures[0].code, "rate_limited");
    assert_eq!(report.failures[0].retry_after_secs, Some(600));
    assert!(f.source(1).unavailable.is_none());
    assert_eq!(f.source(1).last_error.unwrap().code, "rate_limited");
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(
        status.retry_after.as_deref(),
        Some("2026-02-01T00:20:00.000Z")
    );
    assert_eq!(status.unavailable_tickets, 0);
    // Only discovery was attempted; the limit stopped the per-ticket fetches.
    assert!(f.fake.0.lock().unwrap().fetch_calls.is_empty());
}

#[test]
fn a_deleted_or_revoked_issue_is_unavailable_alone_and_others_keep_refreshing() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.publish(issue(2, T0));
    f.refresh_at(T0);
    // Issue 1 leaves discovery scope but stays accessible; issue 2 is deleted.
    f.remote(|r| {
        r.matching.clear();
        r.deleted.push(2);
        let moved = r.issues.get_mut(&1).unwrap();
        moved.title = "Moved out of scope".into();
        moved.updated_at = T1.into();
    });
    f.refresh_at(T1);
    assert_eq!(
        f.workspace.show_ticket("T-KQ1").unwrap().title,
        "Moved out of scope"
    );
    assert!(f.source(1).unavailable.is_none());
    let gone = f.source(2).unavailable.unwrap();
    assert_eq!(gone.code, "not_found");
    assert_eq!(gone.since, T1);
    assert!(f.workspace.source_statuses().unwrap()[0].error.is_none());
}

#[test]
fn an_older_observation_never_regresses_confirmed_source_state() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.refresh_at(T0);
    let mut closed = issue(1, "2026-02-01T00:20:00.500Z");
    closed.state = ExternalState::named(StateCategory::Completed, "Closed");
    f.publish(closed);
    f.refresh_at(T2);
    assert_eq!(
        f.workspace.show_ticket("T-KQ1").unwrap().status,
        Status::Done
    );

    // A slower overlapping run delivers what it saw before the closure.
    f.remote(|r| {
        let stale = r.issues.get_mut(&1).unwrap();
        stale.state = ExternalState::named(StateCategory::Open, "Open");
        stale.updated_at = "2026-02-01T00:20:00Z".into();
        stale.title = "Stale title".into();
    });
    f.refresh_at(T3);
    let ticket = f.workspace.show_ticket("T-KQ1").unwrap();
    assert_eq!(ticket.status, Status::Done);
    assert_eq!(ticket.title, "Issue 1");
}

#[test]
fn a_rate_limit_persists_a_hold_that_survives_a_restart() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.refresh_at(T0);
    assert_eq!(f.workspace.source_hold_until().unwrap(), None);
    f.remote(|r| r.outage = Some(Failure::RateLimited(Some(600))));
    f.refresh_at(T1);
    let calls = f.fake.0.lock().unwrap().discover_calls;
    assert_eq!(
        f.workspace.source_hold_until().unwrap(),
        Some(DAY + 20 * 60)
    );

    // A new process starts 100 seconds before the hold ends.
    let clock = ManualClock::at(DAY + 20 * 60 - 100);
    let restarted = coordinator(&clock);
    let open = || f.open_workspace();
    assert!(matches!(
        restarted.tick(&f.engine, &open).unwrap(),
        Run::Skipped(Skip::NotDue { in_secs: 100 })
    ));
    assert_eq!(
        f.fake.0.lock().unwrap().discover_calls,
        calls,
        "no new attempt"
    );
}

#[test]
fn one_unreadable_issue_neither_stops_the_others_nor_backs_off_the_source() {
    let mut f = Fixture::new();
    for id in 1..=3 {
        f.publish(issue(id, T0));
    }
    f.refresh_at(T0);
    // All three leave the discovery rules. Issue 1 now answers unusably; issue 2 was closed.
    f.remote(|r| {
        r.matching.clear();
        r.broken.push(1);
        let closed = r.issues.get_mut(&2).unwrap();
        closed.state = ExternalState::named(StateCategory::Completed, "Closed");
        closed.updated_at = T1.into();
    });
    let report = f.refresh_at(T1);
    assert_eq!(
        f.workspace.show_ticket("T-KQ2").unwrap().status,
        Status::Done
    );
    assert!(f.source(2).unavailable.is_none() && f.source(3).unavailable.is_none());
    let own = f.source(1).unavailable.unwrap();
    assert_eq!(own.code, "protocol");
    assert!(!own.message.contains("not refreshed"), "{}", own.message);
    assert!(!report.interrupted_by_source());
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert!(status.error.is_none());
    assert_eq!(status.health, SourceHealth::Partial);
    assert_eq!(status.unavailable_tickets, 1);
}

#[test]
fn an_unreadable_repository_is_skipped_visibly_without_stopping_discovery() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.remote(|r| r.inaccessible = vec!["o/gone".into()]);
    let report = f.refresh_at(T0);
    assert_eq!(report.imported, vec!["T-KQ1".to_owned()]);
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].scope, FailureScope::Partition);
    assert!(!report.interrupted_by_source());
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(status.health, SourceHealth::Partial);
    assert!(status.partial_message.unwrap().contains("o/gone"));
    assert!(status.error.is_none());

    f.remote(|r| r.inaccessible.clear());
    f.refresh_at(T1);
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert_eq!(status.health, SourceHealth::Synced);
    assert!(status.partial_message.is_none());
}

#[test]
fn a_failure_from_a_run_that_started_earlier_never_overwrites_a_newer_confirmation() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    f.refresh_at(T0);
    f.publish(issue(2, T0));
    // The run that started at T2 confirms the ticket and commits first.
    f.refresh_at(T2);
    // The slower run, which started at T1 and failed, commits last.
    f.remote(|r| r.outage = Some(Failure::Unavailable));
    f.refresh_at(T1);
    let source = f.source(1);
    assert!(source.unavailable.is_none() && source.last_error.is_none());
    assert_eq!(source.last_refreshed_at.as_deref(), Some(T2));
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert!(status.error.is_none() && status.failing_since.is_none());
    assert_eq!(status.last_attempt_at.as_deref(), Some(T2));
    assert_eq!(status.health, SourceHealth::Synced);
    assert_eq!(status.last_checked_tickets, Some(2));
}

#[test]
fn the_core_states_how_each_source_is_doing() {
    let mut f = Fixture::new();
    f.publish(issue(1, T0));
    let health = |f: &Fixture| f.workspace.source_statuses().unwrap().remove(0).health;
    assert_eq!(health(&f), SourceHealth::Waiting);
    f.refresh_at(T0);
    assert_eq!(health(&f), SourceHealth::Synced);
    f.remote(|r| r.outage = Some(Failure::RateLimited(Some(60))));
    f.refresh_at(T1);
    assert_eq!(health(&f), SourceHealth::Delayed);
    f.remote(|r| r.outage = Some(Failure::Unavailable));
    f.refresh_at(T2);
    assert_eq!(health(&f), SourceHealth::Unavailable);
    f.remote(|r| r.outage = None);
    f.refresh_at(T3);
    assert_eq!(health(&f), SourceHealth::Synced);
    // One deleted issue is a partial result, never an unavailable source.
    f.remote(|r| {
        r.matching.clear();
        r.deleted.push(1);
    });
    f.refresh_at("2026-02-01T00:40:00Z");
    assert_eq!(health(&f), SourceHealth::Partial);
}

#[test]
fn retrying_one_ticket_does_not_reset_the_schedule_of_the_full_refresh() {
    let f = Fixture::new();
    f.publish(issue(1, T0));
    let clock = ManualClock::default();
    let coordinator = coordinator(&clock);
    let open = || f.open_workspace();
    ran(coordinator.tick(&f.engine, &open).unwrap());
    f.remote(|r| r.outage = Some(Failure::Unavailable));
    clock.advance(300);
    ran(coordinator.tick(&f.engine, &open).unwrap());
    assert_eq!(not_due_in(coordinator.tick(&f.engine, &open).unwrap()), 600);

    // The source recovers and the person retries one ticket.
    f.remote(|r| r.outage = None);
    coordinator
        .refresh_now(&f.engine, &open, Some("T-KQ1"))
        .unwrap();
    assert_eq!(
        not_due_in(coordinator.tick(&f.engine, &open).unwrap()),
        600,
        "the full refresh keeps its own schedule"
    );
}

// ---- coordination ----

#[derive(Clone, Default)]
struct ManualClock(Arc<AtomicU64>);
impl Clock for ManualClock {
    fn now_secs(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
impl ManualClock {
    fn at(secs: u64) -> Self {
        Self(Arc::new(AtomicU64::new(secs)))
    }
    fn advance(&self, secs: u64) {
        self.0.fetch_add(secs, Ordering::SeqCst);
    }
}

fn coordinator(clock: &ManualClock) -> RefreshCoordinator {
    RefreshCoordinator::new(
        Arc::new(clock.clone()),
        RefreshPolicy {
            interval_secs: 300,
            max_backoff_secs: 3600,
        },
    )
}

// A helper, so Clippy does not exempt its panic like it does a #[test] function's.
#[allow(clippy::panic)]
fn ran<T>(run: Run<T>) -> T {
    match run {
        Run::Ran(value) => value,
        Run::Skipped(skip) => panic!("skipped: {skip:?}"),
    }
}

#[allow(clippy::panic)]
fn not_due_in<T>(run: Run<T>) -> u64 {
    match run {
        Run::Skipped(Skip::NotDue { in_secs }) => in_secs,
        _ => panic!("expected a skipped run"),
    }
}

#[test]
fn startup_runs_immediately_then_waits_one_interval() {
    let f = Fixture::new();
    f.publish(issue(1, T0));
    let clock = ManualClock::default();
    let coordinator = coordinator(&clock);
    let open = || f.open_workspace();

    let report = ran(coordinator.tick(&f.engine, &open).unwrap());
    assert_eq!(report.imported, vec!["T-KQ1".to_owned()]);
    let before = f.fake.0.lock().unwrap().discover_calls;
    assert_eq!(not_due_in(coordinator.tick(&f.engine, &open).unwrap()), 300);
    clock.advance(299);
    assert_eq!(not_due_in(coordinator.tick(&f.engine, &open).unwrap()), 1);
    clock.advance(1);
    ran(coordinator.tick(&f.engine, &open).unwrap());
    assert_eq!(f.fake.0.lock().unwrap().discover_calls, before + 1);
}

#[test]
fn failures_back_off_without_a_tight_retry_loop_and_recovery_resets() {
    let f = Fixture::new();
    f.publish(issue(1, T0));
    let clock = ManualClock::default();
    let coordinator = coordinator(&clock);
    let open = || f.open_workspace();
    f.remote(|r| r.outage = Some(Failure::Unavailable));

    ran(coordinator.tick(&f.engine, &open).unwrap());
    for expected in [600, 1200, 2400, 3600, 3600] {
        assert_eq!(
            not_due_in(coordinator.tick(&f.engine, &open).unwrap()),
            expected
        );
        clock.advance(expected);
        ran(coordinator.tick(&f.engine, &open).unwrap());
    }
    f.remote(|r| r.outage = None);
    clock.advance(3600);
    ran(coordinator.tick(&f.engine, &open).unwrap());
    assert_eq!(not_due_in(coordinator.tick(&f.engine, &open).unwrap()), 300);
}

#[test]
fn a_rate_limit_delays_the_next_run_by_what_the_source_asked() {
    let f = Fixture::new();
    f.publish(issue(1, T0));
    let clock = ManualClock::default();
    let coordinator = coordinator(&clock);
    let open = || f.open_workspace();
    f.remote(|r| r.outage = Some(Failure::RateLimited(Some(1800))));
    ran(coordinator.tick(&f.engine, &open).unwrap());
    assert_eq!(
        not_due_in(coordinator.tick(&f.engine, &open).unwrap()),
        1800
    );
}

#[test]
fn a_missing_ticket_alone_does_not_back_off_the_schedule() {
    let f = Fixture::new();
    f.publish(issue(1, T0));
    let clock = ManualClock::default();
    let coordinator = coordinator(&clock);
    let open = || f.open_workspace();
    ran(coordinator.tick(&f.engine, &open).unwrap());
    f.remote(|r| {
        r.deleted.push(1);
        r.matching.clear();
    });
    clock.advance(300);
    let report = ran(coordinator.tick(&f.engine, &open).unwrap());
    assert_eq!(report.failures.len(), 1);
    assert_eq!(not_due_in(coordinator.tick(&f.engine, &open).unwrap()), 300);
}

#[test]
fn a_manual_refresh_overlapping_a_running_one_waits_instead_of_interleaving() {
    use std::sync::mpsc;
    let clock = ManualClock::default();
    let coordinator = Arc::new(coordinator(&clock));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (waiting_tx, waiting_rx) = mpsc::channel::<()>();
    let order = Arc::new(Mutex::new(Vec::new()));
    let background = {
        let coordinator = Arc::clone(&coordinator);
        let order = Arc::clone(&order);
        thread::spawn(move || {
            coordinator.run_if_due(|| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                order.lock().unwrap().push("background");
                Ok(RefreshReport::default())
            })
        })
    };
    started_rx.recv().unwrap();
    assert!(coordinator.is_refreshing());
    // A periodic tick during a run is skipped, never queued or run twice.
    assert!(matches!(
        coordinator
            .run_if_due(|| panic!("must not run while another refresh is running"))
            .unwrap(),
        Run::Skipped(Skip::Running)
    ));
    let manual = {
        let coordinator = Arc::clone(&coordinator);
        let order = Arc::clone(&order);
        thread::spawn(move || {
            waiting_tx.send(()).unwrap();
            coordinator
                .run_now(|| {
                    order.lock().unwrap().push("manual");
                    Ok(RefreshReport::default())
                })
                .unwrap()
        })
    };
    // The manual refresh is on its way to the coordinator. If it did not wait for
    // the running one it would record itself before the background run is released.
    waiting_rx.recv().unwrap();
    release_tx.send(()).unwrap();
    background.join().unwrap().unwrap();
    manual.join().unwrap();
    assert_eq!(*order.lock().unwrap(), vec!["background", "manual"]);
    assert!(!coordinator.is_refreshing());
}

#[test]
fn a_manual_refresh_failure_still_backs_off_and_a_success_reschedules() {
    let f = Fixture::new();
    f.publish(issue(1, T0));
    let clock = ManualClock::default();
    let coordinator = coordinator(&clock);
    let open = || f.open_workspace();
    f.remote(|r| r.outage = Some(Failure::Unavailable));
    let report = coordinator.refresh_now(&f.engine, &open, None).unwrap();
    assert!(!report.failures.is_empty());
    assert_eq!(not_due_in(coordinator.tick(&f.engine, &open).unwrap()), 600);

    f.remote(|r| r.outage = None);
    coordinator.refresh_now(&f.engine, &open, None).unwrap();
    assert_eq!(not_due_in(coordinator.tick(&f.engine, &open).unwrap()), 300);
}
