//! Importing and refreshing externally owned tickets through the workspace
//! workflow boundary, with a controllable fake connector and no transport.
#![allow(clippy::unwrap_used)]

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use serde_json::json;
use ticketd_core::{
    Error, Status, Ticket, TicketChange, TicketFilter, TicketPatch, Workspace,
    source::{
        CONTRACT_VERSION, Capability, ChoiceOption, ClosureReason, ConfigSchema, ConfigValues,
        ConnectionInfo, Connector, ConnectorDescriptor, DiscoveryPage, DiscoveryRequest,
        DuplicateTarget, Engine, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState,
        FieldKind, OptionSource, Ownership, RefreshOptions, RefreshReport, SchemaField,
        SourceError, SourceFilter, TargetProblem, ValueFormat,
    },
};

#[derive(Default)]
struct Remote {
    issues: BTreeMap<u64, ExternalIssue>,
    /// Ids the discovery rules match (only open ones are listed, like GitHub).
    matching: Vec<u64>,
    page_size: usize,
    outage: Option<String>,
    discover_calls: usize,
    fetch_calls: Vec<u64>,
}

#[derive(Clone, Default)]
struct Fake(Arc<Mutex<Remote>>);

impl Connector for Fake {
    fn descriptor(&self) -> ConnectorDescriptor {
        ConnectorDescriptor {
            provider: "fake".into(),
            name: "Fake".into(),
            contract_version: CONTRACT_VERSION,
            capabilities: vec![Capability::Discover, Capability::Fetch],
            schema: ConfigSchema {
                fields: vec![SchemaField {
                    key: "repositories".into(),
                    label: "Repositories".into(),
                    help: None,
                    required: true,
                    kind: FieldKind::MultiSelect {
                        options: OptionSource::Dynamic { depends_on: vec![] },
                        allow_custom: true,
                        min_items: 1,
                        max_items: 3,
                        format: Some(ValueFormat::OwnerName),
                    },
                }],
            },
        }
    }

    fn check_connection(&self, _: &ConfigValues) -> Result<ConnectionInfo, SourceError> {
        Ok(ConnectionInfo {
            account: "octo".into(),
        })
    }

    fn options(
        &self,
        _: &str,
        _: &str,
        _: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError> {
        Ok(Vec::new())
    }

    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        let mut remote = self.0.lock().unwrap();
        remote.discover_calls += 1;
        if let Some(message) = remote.outage.clone() {
            return Err(SourceError::Unavailable(message));
        }
        let listed: Vec<ExternalIssue> = remote
            .matching
            .iter()
            .filter_map(|id| remote.issues.get(id))
            .filter(|issue| issue.state == ExternalState::Open)
            .cloned()
            .collect();
        let size = remote.page_size.max(1);
        let start: usize = request.cursor.map_or(0, |c| c.parse().unwrap());
        let end = (start + size).min(listed.len());
        Ok(DiscoveryPage {
            issues: listed[start..end].to_vec(),
            next_cursor: (end < listed.len()).then(|| end.to_string()),
        })
    }

    fn fetch(
        &self,
        _: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        let mut remote = self.0.lock().unwrap();
        let id: u64 = reference.identity.id.parse().unwrap();
        remote.fetch_calls.push(id);
        if let Some(message) = remote.outage.clone() {
            return Err(SourceError::Unavailable(message));
        }
        remote
            .issues
            .get(&id)
            .cloned()
            .ok_or_else(|| SourceError::NotFound("gone".into()))
    }
}

fn issue(id: u64, title: &str) -> ExternalIssue {
    ExternalIssue {
        reference: ExternalRef {
            identity: ExternalIdentity {
                provider: "fake".into(),
                id: id.to_string(),
            },
            locator: format!("o/r#{id}"),
        },
        display: format!("o/r#{id}"),
        url: format!("https://example.test/o/r/issues/{id}"),
        title: title.into(),
        body: format!("Body of {title}"),
        state: ExternalState::Open,
        assignees: vec![],
        labels: vec![],
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        duplicate_of: None,
    }
}

struct Fixture {
    fake: Fake,
    engine: Engine,
    workspace: Workspace,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fake = Fake::default();
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

    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("workspace.sqlite3")
    }

    fn remote(&self, change: impl FnOnce(&mut Remote)) {
        change(&mut self.fake.0.lock().unwrap());
    }

    fn publish(&self, issue: ExternalIssue, matching: bool) {
        self.remote(|remote| {
            let id: u64 = issue.reference.identity.id.parse().unwrap();
            if matching && !remote.matching.contains(&id) {
                remote.matching.push(id);
            }
            remote.issues.insert(id, issue);
        });
    }

    fn refresh(&mut self) -> RefreshReport {
        self.refresh_at("2026-02-01T00:00:00Z")
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

    fn ticket(&self, number: u32) -> Ticket {
        self.workspace.show_ticket(&format!("T-{number}")).unwrap()
    }

    fn set_state(&self, id: u64, state: ExternalState) {
        self.remote(|remote| remote.issues.get_mut(&id).unwrap().state = state);
    }
}

fn closed(reason: ClosureReason) -> ExternalState {
    ExternalState::Closed { reason }
}

fn progress(status: Status) -> TicketPatch {
    TicketPatch {
        status: Some(status),
        ..TicketPatch::default()
    }
}

fn retitle(title: &str) -> TicketPatch {
    TicketPatch {
        title: Some(title.into()),
        ..TicketPatch::default()
    }
}

#[test]
fn matching_issues_import_as_todo_with_stable_identity_across_pages_and_repeats() {
    let mut f = Fixture::new();
    f.remote(|r| r.page_size = 2);
    for id in 1..=5 {
        f.publish(issue(id, &format!("Issue {id}")), true);
    }
    // An overlapping rule: the same issue listed again must not duplicate it.
    f.remote(|r| r.matching.push(3));

    let first = f.refresh();
    assert_eq!(first.imported.len(), 5);
    assert!(first.failures.is_empty());
    let ticket = f.ticket(1);
    assert_eq!(ticket.title, "Issue 1");
    assert_eq!(ticket.body, "Body of Issue 1");
    assert_eq!(ticket.status, Status::Todo);
    let source = ticket.source.clone().unwrap();
    assert_eq!(source.provider, "fake");
    assert_eq!(source.id, "1");
    assert_eq!(source.display, "o/r#1");
    assert_eq!(source.url, "https://example.test/o/r/issues/1");
    assert_eq!(source.ownership, Ownership::External);
    assert!(source.content_locked && !source.status_locked);
    assert_eq!(
        source.last_refreshed_at.as_deref(),
        Some("2026-02-01T00:00:00Z")
    );

    let second = f.refresh();
    assert!(second.imported.is_empty());
    assert_eq!(second.unchanged, 5);
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 5);
    assert_eq!(f.ticket(1).reference, ticket.reference);
}

#[test]
fn refresh_follows_external_edits_and_preserves_local_progress_and_organization() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Original"), true);
    f.refresh();
    let effort = f.workspace.create_effort("Launch").unwrap();
    f.workspace
        .change_ticket(
            "T-1",
            TicketPatch {
                effort_id: Some(Some(effort.id.clone())),
                status: Some(Status::InProgress),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    f.workspace.add_tag("T-1", "backend").unwrap();
    f.workspace
        .add_note("T-1", "local observation", None)
        .unwrap();
    let blocker = f.workspace.create_ticket("Prerequisite").unwrap();
    f.workspace
        .add_dependency(&blocker.reference, "T-1", None)
        .unwrap();
    let child = f.workspace.create_ticket("Detail").unwrap();
    f.workspace
        .set_parent(&child.reference, Some("T-1"), None)
        .unwrap();

    f.publish(issue(1, "Retitled"), true);
    let report = f.refresh();
    assert_eq!(report.updated, vec!["T-1".to_owned()]);
    f.refresh();

    let ticket = f.ticket(1);
    assert_eq!(ticket.title, "Retitled");
    assert_eq!(ticket.body, "Body of Retitled");
    assert_eq!(ticket.status, Status::InProgress);
    assert_eq!(ticket.effort_id.as_deref(), Some(effort.id.as_str()));
    assert_eq!(ticket.tags, vec!["backend".to_owned()]);
    assert_eq!(ticket.prerequisites.len(), 1);
    assert_eq!(ticket.children.len(), 1);
    assert_eq!(f.workspace.notes("T-1", 10, 0).unwrap().len(), 1);
    // Local progress is never sent anywhere: the fake has no write path, and the
    // remote issue is still open.
    assert_eq!(
        f.fake.0.lock().unwrap().issues[&1].state,
        ExternalState::Open
    );
}

#[test]
fn closure_reasons_map_to_statuses_and_unknown_ones_are_flagged_not_guessed() {
    let mut f = Fixture::new();
    for id in 1..=4 {
        f.publish(issue(id, &format!("Issue {id}")), true);
    }
    f.refresh();
    f.workspace
        .change_ticket("T-4", progress(Status::InReview))
        .unwrap();
    f.set_state(1, closed(ClosureReason::Completed));
    f.set_state(2, closed(ClosureReason::NotPlanned));
    f.set_state(3, closed(ClosureReason::Duplicate));
    f.set_state(4, closed(ClosureReason::Unknown));
    f.refresh();

    assert_eq!(f.ticket(1).status, Status::Done);
    assert_eq!(f.ticket(2).status, Status::Canceled);
    assert_eq!(f.ticket(3).status, Status::Duplicate);
    assert!(f.ticket(1).source.unwrap().status_locked);
    let flagged = f.ticket(4);
    assert_eq!(flagged.status, Status::InReview);
    assert!(flagged.source.as_ref().unwrap().closure_unrecognized);
    assert!(!f.ticket(1).source.unwrap().closure_unrecognized);
    // Only Done satisfies a blocker.
    let satisfying: Vec<_> = (1..=4)
        .map(|n| f.ticket(n).status.satisfies_dependency())
        .collect();
    assert_eq!(satisfying, vec![true, false, false, false]);
    // History and counts reflect the mapping.
    let history = f.workspace.ticket_history("T-1").unwrap();
    assert!(
        history
            .iter()
            .any(|h| h.kind == "status" && h.to_value == "Done")
    );
    let counts = f.workspace.count_tickets(&TicketFilter::default()).unwrap();
    assert_eq!(
        (
            counts.done,
            counts.canceled,
            counts.duplicate,
            counts.in_review
        ),
        (1, 1, 1, 1)
    );
}

#[test]
fn an_imported_duplicate_keeps_the_supplied_external_target_or_an_explicit_unknown() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Dup with target"), true);
    f.publish(issue(2, "Dup without target"), true);
    f.refresh();
    let mut named = issue(1, "Dup with target");
    named.state = closed(ClosureReason::Duplicate);
    named.duplicate_of = Some(ExternalRef {
        identity: ExternalIdentity {
            provider: "fake".into(),
            id: "99".into(),
        },
        locator: "o/r#99".into(),
    });
    f.publish(named, true);
    f.set_state(2, closed(ClosureReason::Duplicate));
    f.refresh();

    let with_target = f.ticket(1);
    assert!(with_target.duplicate_of.is_none());
    match with_target.source.unwrap().duplicate_target.unwrap() {
        DuplicateTarget::External {
            identity, display, ..
        } => {
            assert_eq!(identity.id, "99");
            assert_eq!(display, "o/r#99");
        }
        DuplicateTarget::Unknown => panic!("the supplied target must be kept"),
    }
    let unknown = f.ticket(2);
    assert!(unknown.duplicate_of.is_none());
    assert_eq!(
        unknown.source.unwrap().duplicate_target,
        Some(DuplicateTarget::Unknown)
    );
    // Nothing was imported to resolve the reference.
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 2);
}

#[test]
fn reopening_returns_to_todo_clears_duplicate_and_later_open_refreshes_keep_progress() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Flaky"), true);
    f.publish(issue(2, "Dup"), true);
    f.refresh();
    f.set_state(1, closed(ClosureReason::Completed));
    f.set_state(2, closed(ClosureReason::Duplicate));
    f.refresh();
    assert_eq!(f.ticket(1).status, Status::Done);
    assert_eq!(f.ticket(2).status, Status::Duplicate);

    f.set_state(1, ExternalState::Open);
    f.set_state(2, ExternalState::Open);
    f.refresh();
    assert_eq!(f.ticket(1).status, Status::Todo);
    let reopened = f.ticket(2);
    assert_eq!(reopened.status, Status::Todo);
    assert!(reopened.source.unwrap().duplicate_target.is_none());

    f.workspace
        .change_ticket("T-1", progress(Status::InReview))
        .unwrap();
    f.refresh();
    f.refresh();
    assert_eq!(f.ticket(1).status, Status::InReview);
    let history = f.workspace.ticket_history("T-1").unwrap();
    let statuses: Vec<_> = history
        .iter()
        .filter(|h| h.kind == "status")
        .map(|h| h.to_value.as_str())
        .collect();
    assert_eq!(statuses, vec!["Done", "Todo", "In review"]);
}

#[test]
fn the_core_refuses_external_content_edits_and_closed_status_changes_but_allows_open_progress() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Owned"), true);
    f.publish(issue(2, "Closed"), true);
    f.refresh();
    f.set_state(2, closed(ClosureReason::Completed));
    f.refresh();

    assert!(matches!(
        f.workspace.change_ticket("T-1", retitle("Mine")),
        Err(Error::ExternalContent { .. })
    ));
    let body = TicketPatch {
        body: Some("Mine".into()),
        ..TicketPatch::default()
    };
    assert!(matches!(
        f.workspace.change_ticket("T-1", body),
        Err(Error::ExternalContent { .. })
    ));
    for status in [Status::Done, Status::Canceled] {
        assert!(matches!(
            f.workspace.change_ticket("T-1", progress(status)),
            Err(Error::ExternalStatus { open: true, .. })
        ));
    }
    assert!(matches!(
        f.workspace.change_ticket("T-2", progress(Status::Todo)),
        Err(Error::ExternalStatus { open: false, .. })
    ));
    let local = f.workspace.create_ticket("Canonical").unwrap();
    assert!(matches!(
        f.workspace.mark_duplicate("T-1", &local.reference, None),
        Err(Error::ExternalStatus { .. })
    ));
    // Rejected through the cohesive-change path as well.
    let change = TicketChange {
        patch: retitle("Mine"),
        ..Default::default()
    };
    assert!(f.workspace.apply_ticket_change("T-1", change).is_err());
    // Re-submitting unchanged text is not an edit, so a client sending the whole form works.
    let same = TicketPatch {
        title: Some("Owned".into()),
        body: Some("Body of Owned".into()),
        status: Some(Status::InProgress),
        ..TicketPatch::default()
    };
    assert_eq!(
        f.workspace.change_ticket("T-1", same).unwrap().status,
        Status::InProgress
    );
    f.workspace
        .change_ticket("T-1", progress(Status::InReview))
        .unwrap();
    f.workspace
        .change_ticket("T-1", progress(Status::Todo))
        .unwrap();
    // Local organization stays editable on closed tickets too.
    f.workspace.add_tag("T-2", "later").unwrap();
    f.workspace.add_note("T-2", "still mine", None).unwrap();
    // A local ticket is unaffected.
    f.workspace
        .change_ticket(&local.reference, progress(Status::Done))
        .unwrap();
}

#[test]
fn tracked_issues_refresh_after_leaving_the_discovery_rules_and_closure_is_observed() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Reassigned"), true);
    f.refresh();
    // The issue stops matching the rules and then closes.
    f.remote(|r| r.matching.clear());
    let mut next = issue(1, "Reassigned, now elsewhere");
    next.state = closed(ClosureReason::Completed);
    f.publish(next, false);
    let report = f.refresh();
    assert!(report.imported.is_empty());
    assert_eq!(f.fake.0.lock().unwrap().fetch_calls, vec![1]);
    let ticket = f.ticket(1);
    assert_eq!(ticket.title, "Reassigned, now elsewhere");
    assert_eq!(ticket.status, Status::Done);
    // Identity is retained: matching again later does not create a second ticket.
    f.set_state(1, ExternalState::Open);
    f.remote(|r| r.matching.push(1));
    f.refresh();
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
}

#[test]
fn a_failed_refresh_keeps_saved_content_and_records_freshness_truthfully() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Stable"), true);
    f.refresh_at("2026-02-01T00:00:00Z");
    f.publish(issue(1, "Changed upstream"), true);
    f.remote(|r| r.outage = Some("GitHub is down".into()));

    let report = f.refresh_at("2026-02-02T00:00:00Z");
    assert!(
        report
            .failures
            .iter()
            .any(|x| x.code == "unavailable" && x.reference.is_none())
    );
    assert!(
        report
            .failures
            .iter()
            .any(|x| x.reference.as_deref() == Some("T-1"))
    );
    let source = f.ticket(1).source.unwrap();
    assert_eq!(f.ticket(1).title, "Stable");
    assert_eq!(
        source.last_refreshed_at.as_deref(),
        Some("2026-02-01T00:00:00Z")
    );
    assert_eq!(
        source.last_attempt_at.as_deref(),
        Some("2026-02-02T00:00:00Z")
    );
    assert_eq!(source.last_error.unwrap().code, "unavailable");

    f.remote(|r| r.outage = None);
    f.refresh_at("2026-02-03T00:00:00Z");
    let source = f.ticket(1).source.unwrap();
    assert_eq!(f.ticket(1).title, "Changed upstream");
    assert_eq!(
        source.last_refreshed_at.as_deref(),
        Some("2026-02-03T00:00:00Z")
    );
    assert!(source.last_error.is_none());
}

#[test]
fn one_ticket_can_be_refreshed_alone_and_local_tickets_cannot() {
    let mut f = Fixture::new();
    f.publish(issue(1, "One"), true);
    f.publish(issue(2, "Two"), true);
    f.refresh();
    f.publish(issue(1, "One edited"), true);
    f.publish(issue(2, "Two edited"), true);
    let before = f.fake.0.lock().unwrap().discover_calls;
    let report = f
        .workspace
        .refresh_sources(
            &f.engine,
            &RefreshOptions {
                ticket: Some("T-1".into()),
                now: None,
            },
        )
        .unwrap();
    assert_eq!(report.updated, vec!["T-1".to_owned()]);
    assert_eq!(f.ticket(1).title, "One edited");
    assert_eq!(f.ticket(2).title, "Two");
    let calls = f.fake.0.lock().unwrap().discover_calls;
    assert_eq!(
        calls, before,
        "a single-ticket refresh does not run discovery"
    );
    let local = f.workspace.create_ticket("Local").unwrap();
    let refused = f.workspace.refresh_sources(
        &f.engine,
        &RefreshOptions {
            ticket: Some(local.reference),
            now: None,
        },
    );
    assert!(matches!(refused, Err(Error::NotSynchronized(_))));
    let missing = f.workspace.refresh_sources(
        &f.engine,
        &RefreshOptions {
            ticket: Some("T-99".into()),
            now: None,
        },
    );
    assert!(matches!(missing, Err(Error::NotFound(_))));
}

#[test]
fn source_filters_and_counts_agree_with_the_listing() {
    let mut f = Fixture::new();
    f.publish(issue(1, "A"), true);
    f.publish(issue(2, "B"), true);
    f.refresh();
    f.workspace.create_ticket("Local one").unwrap();
    f.workspace
        .change_ticket("T-1", progress(Status::InProgress))
        .unwrap();

    let all = f
        .workspace
        .count_by_source(&TicketFilter::default())
        .unwrap();
    assert_eq!((all.all, all.local, all.providers["fake"]), (3, 1, 2));
    let mut filter = TicketFilter {
        source: Some(SourceFilter::Provider("fake".into())),
        ..TicketFilter::default()
    };
    assert_eq!(f.workspace.find_tickets(&filter).unwrap().len(), 2);
    assert_eq!(f.workspace.count_tickets(&filter).unwrap().total(), 2);
    // Counts ignore the source choice itself but respect the other filters.
    filter.status = Some(Status::InProgress);
    let narrowed = f.workspace.count_by_source(&filter).unwrap();
    assert_eq!(
        (narrowed.all, narrowed.local, narrowed.providers["fake"]),
        (1, 0, 1)
    );
    let local = TicketFilter {
        source: Some(SourceFilter::Local),
        ..TicketFilter::default()
    };
    let tickets = f.workspace.find_tickets(&local).unwrap();
    assert_eq!(tickets.len(), 1);
    assert!(tickets[0].source.is_none());
}

#[test]
fn imported_tickets_survive_reopening_export_backup_and_restore() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Durable"), true);
    f.refresh();
    let path = f.path();
    let backup = f.dir.path().join("backup.sqlite3");
    let before = f.ticket(1);
    let exported = f.workspace.export().unwrap();
    assert_eq!(exported["external_identities"][0]["external_id"], "1");
    assert_eq!(exported["external_ownership"][0]["authority"], "external");
    assert_eq!(exported["source_sync"][0]["external_state"], "open");
    f.workspace.backup(&backup).unwrap();
    let Fixture {
        workspace,
        engine,
        dir,
        ..
    } = f;
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket("T-1").unwrap(), before);
    // Rediscovery after restore reuses the ticket.
    let report = workspace
        .refresh_sources(&engine, &RefreshOptions::default())
        .unwrap();
    assert!(report.imported.is_empty());
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    drop(dir);
}

#[test]
fn a_ticket_whose_ownership_was_taken_is_never_resynchronized_or_recreated() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Mine now"), true);
    f.refresh();
    // Ownership takeover has no workflow yet; flip the stored authority directly.
    let db = rusqlite::Connection::open(f.path()).unwrap();
    db.execute("UPDATE external_ownership SET authority = 'local'", [])
        .unwrap();
    drop(db);
    f.publish(issue(1, "Upstream rewrite"), true);
    f.refresh();
    let ticket = f.ticket(1);
    assert_eq!(ticket.title, "Mine now");
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
    let source = ticket.source.unwrap();
    assert_eq!(source.ownership, Ownership::Local);
    assert!(!source.content_locked);
    // It counts and filters as Local, and may be edited.
    let counts = f
        .workspace
        .count_by_source(&TicketFilter::default())
        .unwrap();
    assert_eq!((counts.local, counts.providers.len()), (1, 0));
    f.workspace.change_ticket("T-1", retitle("Edited")).unwrap();
}

#[test]
fn concurrent_refreshes_create_one_ticket_per_issue() {
    let f = Fixture::new();
    f.publish(issue(1, "Raced"), true);
    f.publish(issue(2, "Raced too"), true);
    let path = f.path();
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let fake = f.fake.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                let mut engine = Engine::new();
                engine.register(Box::new(fake)).unwrap();
                let mut workspace = Workspace::open(&path).unwrap();
                workspace
                    .refresh_sources(&engine, &RefreshOptions::default())
                    .unwrap()
            })
        })
        .collect();
    let imported: usize = handles
        .into_iter()
        .map(|h| h.join().unwrap().imported.len())
        .sum();
    assert_eq!(imported, 2);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.list_tickets().unwrap().len(), 2);
}

fn duplicate_of(id: u64, title: &str, canonical: Option<u64>) -> ExternalIssue {
    let mut dup = issue(id, title);
    dup.state = closed(ClosureReason::Duplicate);
    dup.duplicate_of = canonical.map(|canonical| ExternalRef {
        identity: ExternalIdentity {
            provider: "fake".into(),
            id: canonical.to_string(),
        },
        locator: format!("o/r#{canonical}"),
    });
    dup
}

fn target(ticket: &Ticket) -> DuplicateTarget {
    ticket
        .source
        .clone()
        .unwrap()
        .duplicate_target
        .expect("a duplicate target")
}

/// Imports each issue as open (discovery only lists open issues), then has the
/// source close them as duplicates of the given canonical issues.
fn import_then_close_as_duplicates(f: &mut Fixture, duplicates: &[(u64, Option<u64>)]) {
    for (id, _) in duplicates {
        f.publish(issue(*id, &format!("Issue {id}")), true);
    }
    f.refresh();
    for (id, canonical) in duplicates {
        f.publish(duplicate_of(*id, &format!("Issue {id}"), *canonical), true);
    }
    f.refresh();
}

fn resolved(ticket: &Ticket) -> Option<String> {
    match target(ticket) {
        DuplicateTarget::External { ticket, .. } => ticket,
        other => panic!("expected an external target, got {other:?}"),
    }
}

#[test]
fn an_external_target_resolves_to_the_ticket_discovery_later_imports_without_a_second_ticket() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Dup"), true);
    f.publish(issue(2, "Blocked by dup"), true);
    f.refresh();
    f.workspace.add_dependency("T-1", "T-2", None).unwrap();
    f.publish(duplicate_of(1, "Dup", Some(99)), true);
    f.refresh();

    // Referenced but not imported: shown as an external-only target.
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 2);
    match target(&f.ticket(1)) {
        DuplicateTarget::External {
            display, ticket, ..
        } => {
            assert_eq!(display, "o/r#99");
            assert_eq!(ticket, None);
        }
        other => panic!("expected an external target, got {other:?}"),
    }

    // Ordinary discovery imports the canonical issue; the reference resolves to it.
    f.publish(issue(99, "Canonical"), true);
    f.refresh();
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 3);
    assert_eq!(resolved(&f.ticket(1)).as_deref(), Some("T-3"));
    // Information only: no local designation, and no dependency moved or satisfied.
    let dup = f.ticket(1);
    assert!(dup.duplicate_of.is_none());
    assert_eq!(dup.status, Status::Duplicate);
    assert!(!dup.status.satisfies_dependency());
    assert!(f.ticket(3).duplicates.is_empty());
    assert_eq!(f.ticket(2).prerequisites.len(), 1);
    assert_eq!(f.ticket(2).prerequisites[0].reference, "T-1");
}

#[test]
fn a_changed_target_follows_the_source_and_a_lost_one_is_not_erased() {
    let mut f = Fixture::new();
    import_then_close_as_duplicates(&mut f, &[(1, Some(98))]);
    f.publish(duplicate_of(1, "Dup", Some(99)), true);
    let report = f.refresh();
    assert_eq!(report.updated.len(), 1);
    match target(&f.ticket(1)) {
        DuplicateTarget::External { identity, .. } => assert_eq!(identity.id, "99"),
        other => panic!("expected an external target, got {other:?}"),
    }
    f.publish(duplicate_of(1, "Dup", None), true);
    f.refresh();
    // The source stopped supplying an accessible target: keep what is known.
    match target(&f.ticket(1)) {
        DuplicateTarget::External { identity, .. } => assert_eq!(identity.id, "99"),
        other => panic!("the known target must be kept, got {other:?}"),
    }
}

#[test]
fn a_target_that_is_the_issue_itself_is_unknown_and_a_cycle_is_flagged_not_followed() {
    let mut f = Fixture::new();
    import_then_close_as_duplicates(&mut f, &[(1, Some(1)), (2, Some(3)), (3, Some(2))]);
    assert_eq!(target(&f.ticket(1)), DuplicateTarget::Unknown);
    for number in [2, 3] {
        match target(&f.ticket(number)) {
            DuplicateTarget::External {
                ticket, problem, ..
            } => {
                assert_eq!(ticket, None);
                assert_eq!(problem, Some(TargetProblem::Cycle));
            }
            other => panic!("expected a flagged external target, got {other:?}"),
        }
        assert!(f.ticket(number).duplicate_of.is_none());
    }
}

#[test]
fn a_target_that_is_itself_a_duplicate_resolves_directly_to_the_final_canonical_ticket() {
    let mut f = Fixture::new();
    import_then_close_as_duplicates(&mut f, &[(1, Some(2)), (2, Some(3)), (3, None)]);
    f.publish(issue(3, "Final"), true);
    f.refresh();
    assert_eq!(resolved(&f.ticket(1)).as_deref(), Some("T-3"));
}

#[test]
fn target_identity_survives_export_backup_and_restore() {
    let mut f = Fixture::new();
    import_then_close_as_duplicates(&mut f, &[(1, Some(99))]);
    f.publish(issue(99, "Canonical"), true);
    f.refresh();
    let before = f.ticket(1);
    assert_eq!(resolved(&before).as_deref(), Some("T-2"));
    let exported = f.workspace.export().unwrap();
    assert_eq!(
        exported["external_duplicate_targets"][0]["external_id"],
        "99"
    );
    let path = f.path();
    let backup = f.dir.path().join("backup.sqlite3");
    f.workspace.backup(&backup).unwrap();
    let Fixture { workspace, dir, .. } = f;
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket("T-1").unwrap(), before);
    drop(dir);
}
