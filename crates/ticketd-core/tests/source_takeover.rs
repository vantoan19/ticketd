//! Taking ownership of an unavailable external ticket, through the workspace
//! workflow boundary with a controllable fake connector.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::json;
use ticketd_core::{
    Error, Status, TicketFilter, TicketPatch, WriteRequest, WriteResult, Workspace,
    source::{
        CONTRACT_VERSION, Capability, ChoiceOption, ClosureReason, ConfigSchema, ConfigValues,
        ConnectionInfo, Connector, ConnectorDescriptor, DiscoveryPage, DiscoveryRequest,
        DuplicateTarget, Engine, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState,
        FieldKind, OptionSource, Origin, Ownership, RefreshOptions, SchemaField, SourceError,
        SourceFilter, TicketSource, ValueFormat,
    },
};

type Hook = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Remote {
    issues: BTreeMap<u64, ExternalIssue>,
    outage: bool,
    /// Runs inside discovery, while no database transaction is open: an
    /// in-flight refresh that another actor interrupts.
    during_discovery: Option<Hook>,
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
    fn discover(&self, _: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        let hook = self.0.lock().unwrap().during_discovery.clone();
        if let Some(hook) = hook {
            hook();
        }
        let remote = self.0.lock().unwrap();
        if remote.outage {
            return Err(SourceError::Unavailable("network is down".into()));
        }
        let issues = remote
            .issues
            .values()
            .filter(|issue| issue.state == ExternalState::Open)
            .cloned()
            .collect();
        Ok(DiscoveryPage {
            issues,
            next_cursor: None,
        })
    }
    fn fetch(
        &self,
        _: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        let remote = self.0.lock().unwrap();
        if remote.outage {
            return Err(SourceError::Unavailable("network is down".into()));
        }
        let id: u64 = reference.identity.id.parse().unwrap();
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
        body: "Body".into(),
        state: ExternalState::Open,
        assignees: vec![],
        labels: vec![],
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-02-01T00:00:00Z".into(),
        duplicate_of: None,
    }
}

fn duplicate(id: u64, title: &str, canonical: u64) -> ExternalIssue {
    let mut dup = issue(id, title);
    dup.state = ExternalState::Closed {
        reason: ClosureReason::Duplicate,
    };
    dup.duplicate_of = Some(ExternalRef {
        identity: ExternalIdentity {
            provider: "fake".into(),
            id: canonical.to_string(),
        },
        locator: format!("o/r#{canonical}"),
    });
    dup
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
    fn path(&self) -> PathBuf {
        self.dir.path().join("workspace.sqlite3")
    }
    fn remote(&self, change: impl FnOnce(&mut Remote)) {
        change(&mut self.fake.0.lock().unwrap());
    }
    fn publish(&self, issue: ExternalIssue) {
        self.remote(|remote| {
            remote
                .issues
                .insert(issue.reference.identity.id.parse().unwrap(), issue);
        });
    }
    fn refresh(&mut self) {
        self.workspace
            .refresh_sources(&self.engine, &RefreshOptions::default())
            .unwrap();
    }
    fn source(&self, number: u32) -> TicketSource {
        self.workspace
            .show_ticket(&format!("T-{number}"))
            .unwrap()
            .source
            .unwrap()
    }
    /// Imports `issue` as T-1 and makes it Source unavailable.
    fn unavailable(issue: ExternalIssue) -> Self {
        let mut f = Self::new();
        f.publish(issue);
        f.refresh();
        f.remote(|r| r.outage = true);
        f.refresh();
        assert!(f.source(1).unavailable.is_some());
        f
    }
}

fn patch(title: Option<&str>, status: Option<Status>) -> TicketPatch {
    TicketPatch {
        title: title.map(Into::into),
        status,
        ..TicketPatch::default()
    }
}

#[test]
fn takeover_keeps_the_ticket_and_work_and_reads_local_with_provenance() {
    let mut f = Fixture::unavailable(issue(1, "Imported title"));
    f.workspace.create_ticket("Local blocker").unwrap();
    f.workspace.add_dependency("T-2", "T-1", None).unwrap();
    let parent = f.workspace.create_ticket("Local parent").unwrap();
    f.workspace
        .set_parent("T-1", Some(&parent.reference), None)
        .unwrap();
    f.workspace
        .change_ticket("T-1", patch(None, Some(Status::InProgress)))
        .unwrap();
    f.workspace.add_note("T-1", "my own note", None).unwrap();
    let before = f.workspace.show_ticket("T-1").unwrap();
    // Content is locked while the source owns it.
    assert!(matches!(
        f.workspace.change_ticket("T-1", patch(Some("Mine"), None)),
        Err(Error::ExternalContent { .. })
    ));

    let taken = f.workspace.take_ownership("T-1", Some("agent")).unwrap();

    let source = taken.source.clone().unwrap();
    assert_eq!(source.ownership, Ownership::Local);
    assert_eq!(source.origin, Origin::Imported);
    assert_eq!(source.locator, "o/r#1");
    assert!(source.unavailable.is_none() && source.last_error.is_none());
    assert!(!source.content_locked && !source.status_locked);
    // Same reference, content, status, relationships and notes.
    let mut expected = before.clone();
    expected.source = taken.source.clone();
    assert_eq!(taken, expected);
    assert_eq!(taken.title, "Imported title");
    assert_eq!(taken.status, Status::InProgress);
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 3);
    let history = f.workspace.ticket_history("T-1").unwrap();
    let entry = history.iter().find(|e| e.kind == "ownership").unwrap();
    assert_eq!(
        (entry.from_value.as_str(), entry.to_value.as_str()),
        ("fake", "local")
    );
    assert_eq!(entry.editing_agent.as_deref(), Some("agent"));
    // Ordinary local editing is restored.
    f.workspace
        .change_ticket("T-1", patch(Some("Mine"), Some(Status::Done)))
        .unwrap();
    // It filters and counts as Local, no longer as the provider's.
    let local = TicketFilter {
        source: Some(SourceFilter::Local),
        ..TicketFilter::default()
    };
    let provider = TicketFilter {
        source: Some(SourceFilter::Provider("fake".into())),
        ..TicketFilter::default()
    };
    assert_eq!(f.workspace.find_tickets(&local).unwrap().len(), 3);
    assert!(f.workspace.find_tickets(&provider).unwrap().is_empty());
    let counts = f
        .workspace
        .count_by_source(&TicketFilter::default())
        .unwrap();
    assert_eq!((counts.local, counts.providers.len()), (3, 0));
}

#[test]
fn only_an_unavailable_external_ticket_can_be_taken_over() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Reachable"));
    f.refresh();
    assert!(matches!(
        f.workspace.take_ownership("T-1", None),
        Err(Error::SourceAvailable { .. })
    ));
    assert_eq!(f.source(1).ownership, Ownership::External);

    let local = f.workspace.create_ticket("Plain").unwrap();
    assert!(matches!(
        f.workspace.take_ownership(&local.reference, None),
        Err(Error::NotSynchronized(_))
    ));
    assert!(matches!(
        f.workspace.take_ownership("T-99", None),
        Err(Error::NotFound(_))
    ));

    // Once the source cannot be read it can.
    f.remote(|r| r.outage = true);
    f.refresh();
    f.workspace.take_ownership("T-1", None).unwrap();
}

#[test]
fn a_repeated_takeover_changes_nothing_and_a_replayed_request_returns_its_first_outcome() {
    let mut f = Fixture::unavailable(issue(1, "Once"));
    let request = || WriteRequest::TakeOwnership {
        reference: "T-1".into(),
        agent: None,
    };
    let first = f.workspace.write(Some("take-1"), request()).unwrap();
    f.workspace
        .change_ticket("T-1", patch(Some("Edited later"), None))
        .unwrap();
    let replay = f.workspace.write(Some("take-1"), request()).unwrap();
    let (WriteResult::Ticket(first), WriteResult::Ticket(replay)) = (first, replay) else {
        panic!("takeover returns the ticket");
    };
    assert_eq!(first, replay, "replay returns the stored outcome");
    assert_eq!(f.workspace.show_ticket("T-1").unwrap().title, "Edited later");
    // Without a request id a repeat is a no-op and records no second change.
    f.workspace.take_ownership("T-1", None).unwrap();
    let changes = f
        .workspace
        .ticket_history("T-1")
        .unwrap()
        .iter()
        .filter(|e| e.kind == "ownership")
        .count();
    assert_eq!(changes, 1);
    // The same request id with a different request is refused.
    let other = WriteRequest::TakeOwnership {
        reference: "T-2".into(),
        agent: None,
    };
    assert!(matches!(
        f.workspace.write(Some("take-1"), other),
        Err(Error::RequestConflict(_))
    ));
}

#[test]
fn restored_access_and_rediscovery_never_resume_sync_or_create_another_ticket() {
    let mut f = Fixture::unavailable(issue(1, "Before"));
    f.workspace.take_ownership("T-1", None).unwrap();
    f.remote(|r| r.outage = false);
    f.publish(issue(1, "Rewritten upstream"));
    f.refresh();
    f.refresh();
    let ticket = f.workspace.show_ticket("T-1").unwrap();
    assert_eq!(ticket.title, "Before");
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
    assert_eq!(ticket.source.unwrap().ownership, Ownership::Local);
    // A ticket-scoped refresh has nothing to synchronize.
    assert!(matches!(
        f.workspace.refresh_sources(
            &f.engine,
            &RefreshOptions {
                ticket: Some("T-1".into()),
                now: None
            }
        ),
        Err(Error::NotSynchronized(_))
    ));
}

#[test]
fn a_refresh_already_in_flight_cannot_undo_or_taint_a_takeover() {
    // Access returns, but a takeover lands while the refresh is gathering.
    let mut f = Fixture::unavailable(issue(1, "Before"));
    f.remote(|r| r.outage = false);
    f.publish(issue(1, "Late upstream rewrite"));
    let path = f.path();
    f.remote(|r| {
        r.during_discovery = Some(Arc::new(move || {
            Workspace::open(&path)
                .unwrap()
                .take_ownership("T-1", None)
                .unwrap();
        }));
    });
    f.refresh();
    f.remote(|r| r.during_discovery = None);
    let ticket = f.workspace.show_ticket("T-1").unwrap();
    assert_eq!(ticket.title, "Before");
    assert_eq!(ticket.source.unwrap().ownership, Ownership::Local);
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);

    // The refresh that fails after the takeover must not record a failure on it.
    let mut f = Fixture::unavailable(issue(1, "Before"));
    let path = f.path();
    f.remote(|r| {
        r.during_discovery = Some(Arc::new(move || {
            Workspace::open(&path)
                .unwrap()
                .take_ownership("T-1", None)
                .unwrap();
        }));
    });
    f.refresh();
    let source = f.source(1);
    assert_eq!(source.ownership, Ownership::Local);
    assert!(source.last_error.is_none() && source.unavailable.is_none());
    let status = f.workspace.source_statuses().unwrap();
    assert_eq!(status[0].unavailable_tickets, 0);
}

#[test]
fn a_taken_over_duplicate_keeps_its_status_and_target_until_it_leaves_duplicate() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Dupe"));
    f.publish(issue(2, "Canonical"));
    f.refresh();
    f.publish(duplicate(1, "Dupe", 2));
    f.refresh();
    let reference = "T-1".to_owned();
    assert_eq!(
        f.workspace.show_ticket(&reference).unwrap().status,
        Status::Duplicate
    );
    f.remote(|r| r.outage = true);
    f.refresh();

    let taken = f.workspace.take_ownership(&reference, None).unwrap();
    assert_eq!(taken.status, Status::Duplicate);
    assert!(matches!(
        taken.source.unwrap().duplicate_target,
        Some(DuplicateTarget::External { .. })
    ));
    // Leaving Duplicate is an ordinary local edit and drops the source's target.
    let left = f
        .workspace
        .change_ticket(&reference, patch(None, Some(Status::Todo)))
        .unwrap();
    assert_eq!(left.status, Status::Todo);
    assert!(left.source.unwrap().duplicate_target.is_none());
    // The domain rule for Duplicate still holds: it needs a canonical ticket.
    assert!(matches!(
        f.workspace
            .change_ticket(&reference, patch(None, Some(Status::Duplicate))),
        Err(Error::DuplicateNeedsCanonical)
    ));
}

#[test]
fn takeover_survives_restart_export_backup_and_restore() {
    let mut f = Fixture::unavailable(issue(1, "Kept"));
    f.workspace.take_ownership("T-1", None).unwrap();
    let exported = f.workspace.export().unwrap();
    assert_eq!(exported["external_ownership"][0]["authority"], "local");
    assert_eq!(exported["external_identities"][0]["external_id"], "1");
    assert!(exported["source_sync"][0]["last_error_code"].is_null());
    let path = f.path();
    let backup = f.dir.path().join("backup.sqlite3");
    f.workspace.backup(&backup).unwrap();
    let before = f.workspace.show_ticket("T-1").unwrap();
    let Fixture {
        workspace,
        engine,
        fake,
        dir,
    } = f;
    drop(workspace);
    // Restart.
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket("T-1").unwrap(), before);
    drop(workspace);
    // Restore, then rediscovery with access back.
    Workspace::restore(&path, &backup).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    {
        let mut remote = fake.0.lock().unwrap();
        remote.outage = false;
        remote.issues.insert(1, issue(1, "Upstream differs"));
    }
    workspace
        .refresh_sources(&engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(workspace.show_ticket("T-1").unwrap(), before);
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    drop(dir);
}
