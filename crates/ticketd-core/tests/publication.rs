//! Publishing a local ticket once, through the workspace workflow boundary, with a
//! controllable fake connector. The failure scenarios are the point: every one
//! of them must leave the ticket local, and every one that might have created an
//! issue must block another create.
#![allow(clippy::unwrap_used)]

use std::{
    collections::BTreeMap,
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::json;
use ticketd_core::{
    Error, Status, Ticket, TicketPatch, Workspace,
    source::{
        AttemptState, CONTRACT_VERSION, Capability, ChoiceOption, ConfigSchema, ConfigValues,
        ConnectionInfo, Connector, ConnectorDescriptor, DiscoveryPage, DiscoveryRequest, Eligibility,
        Engine, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState, FieldKind,
        IneligibleReason, OptionSource, Origin, Ownership, PublicationError, PublishOptions,
        PublishRequest, RefreshOptions, SchemaField, SourceError, ValueFormat,
    },
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Create the issue and return it.
    Create,
    /// The provider refuses before creating anything.
    Refuse,
    /// The issue is created but the answer is lost (timeout).
    LoseResponse,
    /// The process dies during the call, after the issue exists.
    Crash,
}

type Hook = Arc<dyn Fn() + Send + Sync>;

struct Remote {
    mode: Mode,
    created: Vec<PublishRequest>,
    issues: BTreeMap<u64, ExternalIssue>,
    /// Runs inside `publish`, after the remote issue exists, before it answers.
    hook: Option<Hook>,
}

#[derive(Clone)]
struct Fake(Arc<Mutex<Remote>>);

impl Fake {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Remote {
            mode: Mode::Create,
            created: Vec::new(),
            issues: BTreeMap::new(),
            hook: None,
        })))
    }
}

impl Connector for Fake {
    fn descriptor(&self) -> ConnectorDescriptor {
        ConnectorDescriptor {
            provider: "fake".into(),
            name: "Fake".into(),
            contract_version: CONTRACT_VERSION,
            capabilities: vec![Capability::Discover, Capability::Fetch, Capability::Publish],
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

    fn options(&self, _: &str, _: &str, _: &ConfigValues) -> Result<Vec<ChoiceOption>, SourceError> {
        Ok(Vec::new())
    }

    fn discover(&self, _: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        let remote = self.0.lock().unwrap();
        Ok(DiscoveryPage {
            issues: remote.issues.values().cloned().collect(),
            next_cursor: None,
        })
    }

    fn fetch(&self, _: &ConfigValues, reference: &ExternalRef) -> Result<ExternalIssue, SourceError> {
        let remote = self.0.lock().unwrap();
        let id: u64 = reference.identity.id.parse().unwrap();
        remote
            .issues
            .get(&id)
            .cloned()
            .ok_or_else(|| SourceError::NotFound("gone".into()))
    }

    fn destinations(&self, config: &ConfigValues) -> Vec<String> {
        config["repositories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    }

    fn publish(&self, _: &ConfigValues, request: &PublishRequest) -> Result<ExternalIssue, SourceError> {
        let (mode, hook) = {
            let mut remote = self.0.lock().unwrap();
            if remote.mode == Mode::Refuse {
                return Err(SourceError::Forbidden("no permission to create issues".into()));
            }
            remote.created.push(request.clone());
            let id = 100 + remote.created.len() as u64;
            let issue = ExternalIssue {
                reference: ExternalRef {
                    identity: ExternalIdentity {
                        provider: "fake".into(),
                        id: id.to_string(),
                    },
                    locator: format!("{}#{id}", request.destination),
                },
                display: format!("{}#{id}", request.destination),
                url: format!("https://example.test/{}/issues/{id}", request.destination),
                title: request.title.clone(),
                body: request.body.clone(),
                state: ExternalState::Open,
                assignees: vec![],
                labels: vec![],
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
                duplicate_of: None,
            };
            remote.issues.insert(id, issue);
            (remote.mode, remote.hook.clone())
        };
        if let Some(hook) = hook {
            hook();
        }
        match mode {
            Mode::LoseResponse => Err(SourceError::Unavailable("request timed out".into())),
            Mode::Crash => panic!("process died during the create call"),
            _ => {
                let remote = self.0.lock().unwrap();
                Ok(remote.issues.values().last().unwrap().clone())
            }
        }
    }
}

struct Fixture {
    fake: Fake,
    engine: Arc<Engine>,
    workspace: Workspace,
    dir: tempfile::TempDir,
}

fn values(value: serde_json::Value) -> ConfigValues {
    value.as_object().unwrap().clone()
}

impl Fixture {
    fn new() -> Self {
        let fake = Fake::new();
        let mut engine = Engine::new();
        engine.register(Box::new(fake.clone())).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        workspace
            .save_source(&engine, "fake", &values(json!({"repositories": ["o/r"]})))
            .unwrap();
        Self {
            fake,
            engine: Arc::new(engine),
            workspace,
            dir,
        }
    }

    fn path(&self) -> PathBuf {
        self.dir.path().join("workspace.sqlite3")
    }

    fn mode(&self, mode: Mode) {
        self.fake.0.lock().unwrap().mode = mode;
    }

    fn created(&self) -> usize {
        self.fake.0.lock().unwrap().created.len()
    }

    fn hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        self.fake.0.lock().unwrap().hook = Some(Arc::new(hook));
    }

    fn publish(&mut self, reference: &str) -> Result<ticketd_core::source::PublishOutcome, Error> {
        self.workspace.publish_ticket(&self.engine, reference, &options())
    }

    fn ticket(&self, reference: &str) -> Ticket {
        self.workspace.show_ticket(reference).unwrap()
    }

    fn reopen(self) -> Self {
        let Self {
            fake,
            engine,
            workspace,
            dir,
        } = self;
        drop(workspace);
        let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        Self {
            fake,
            engine,
            workspace,
            dir,
        }
    }
}

fn options() -> PublishOptions {
    PublishOptions {
        provider: "fake".into(),
        destination: None,
        now: None,
    }
}

fn describe(f: &mut Fixture, title: &str, body: &str) -> Ticket {
    let ticket = f.workspace.create_ticket(title).unwrap();
    f.workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some(body.into()),
                ..TicketPatch::default()
            },
        )
        .unwrap()
}

fn set_status(f: &mut Fixture, reference: &str, status: Status) {
    f.workspace
        .change_ticket(
            reference,
            TicketPatch {
                status: Some(status),
                ..TicketPatch::default()
            },
        )
        .unwrap();
}

fn publication_error(error: Error) -> PublicationError {
    match error {
        Error::Publication(error) => error,
        other => panic!("expected a publication error, got {other}"),
    }
}

#[test]
fn preview_shows_exactly_what_would_be_sent_and_does_not_send_it() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate the cache bug", "Cache entries never expire.");
    f.workspace.add_note(&ticket.reference, "private note", None).unwrap();

    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();

    assert_eq!(preview.title, "Escalate the cache bug");
    assert_eq!(preview.body, "Cache entries never expire.");
    assert_eq!(preview.destination.as_deref(), Some("o/r"));
    assert_eq!(preview.destinations, vec!["o/r".to_owned()]);
    assert_eq!(preview.provider_name, "Fake");
    assert_eq!(preview.eligibility, Eligibility::Eligible);
    assert_eq!(f.created(), 0);
}

#[test]
fn done_canceled_duplicate_trashed_and_unconnected_tickets_are_ineligible_with_a_reason() {
    let mut f = Fixture::new();
    let canonical = f.workspace.create_ticket("Canonical").unwrap();
    for (status, expect) in [(Status::Done, "Done"), (Status::Canceled, "Canceled")] {
        let ticket = f.workspace.create_ticket(expect).unwrap();
        set_status(&mut f, &ticket.reference, status);
        let preview = f
            .workspace
            .preview_publication(&f.engine, &ticket.reference, "fake", None)
            .unwrap();
        let Eligibility::Ineligible { reason, message } = preview.eligibility else {
            panic!("{expect} must be ineligible");
        };
        assert_eq!(reason, IneligibleReason::Status);
        assert!(message.contains(expect) && message.contains("only Todo, In progress"));
        let error = f.publish(&ticket.reference).unwrap_err();
        assert!(matches!(
            publication_error(error),
            PublicationError::Ineligible { reason: IneligibleReason::Status, .. }
        ));
    }
    let duplicate = f.workspace.create_ticket("Copy").unwrap();
    f.workspace
        .mark_duplicate(&duplicate.reference, &canonical.reference, None)
        .unwrap();
    assert!(matches!(
        publication_error(f.publish(&duplicate.reference).unwrap_err()),
        PublicationError::Ineligible { reason: IneligibleReason::Status, .. }
    ));
    let trashed = f.workspace.create_ticket("Gone").unwrap();
    f.workspace.set_trashed(&trashed.reference, true, None).unwrap();
    assert!(matches!(
        publication_error(f.publish(&trashed.reference).unwrap_err()),
        PublicationError::Ineligible { reason: IneligibleReason::Trashed, .. }
    ));
    assert_eq!(f.created(), 0);

    // Nothing saved for the provider: nowhere to publish.
    let dir = tempfile::tempdir().unwrap();
    let mut bare = Workspace::open(dir.path().join("w.sqlite3")).unwrap();
    let ticket = bare.create_ticket("Local").unwrap();
    let error = bare
        .publish_ticket(&f.engine, &ticket.reference, &options())
        .unwrap_err();
    assert!(matches!(
        publication_error(error),
        PublicationError::Ineligible { reason: IneligibleReason::SourceNotConnected, .. }
    ));
}

#[test]
fn successful_publication_transfers_ownership_and_keeps_identity_progress_and_organization() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body text");
    set_status(&mut f, &ticket.reference, Status::InProgress);
    let effort = f.workspace.create_effort("Launch").unwrap();
    f.workspace.set_effort(&ticket.reference, Some(&effort.id), None).unwrap();
    f.workspace.add_tag(&ticket.reference, "backend").unwrap();
    f.workspace.add_note(&ticket.reference, "local note", None).unwrap();
    let blocker = f.workspace.create_ticket("Prerequisite").unwrap();
    f.workspace.add_dependency(&blocker.reference, &ticket.reference, None).unwrap();
    let child = f.workspace.create_ticket("Detail").unwrap();
    f.workspace.set_parent(&child.reference, Some(&ticket.reference), None).unwrap();

    let outcome = f.publish(&ticket.reference).unwrap();

    assert!(!outcome.replayed);
    assert_eq!(outcome.attempt.state, AttemptState::Succeeded);
    assert_eq!(outcome.attempt.issue.as_ref().unwrap().display, "o/r#101");
    let published = f.ticket(&ticket.reference);
    assert_eq!(published.reference, ticket.reference);
    assert_eq!(published.id, ticket.id);
    assert_eq!(published.status, Status::InProgress);
    assert_eq!(published.effort_id.as_deref(), Some(effort.id.as_str()));
    assert_eq!(published.tags, vec!["backend".to_owned()]);
    assert_eq!(published.prerequisites.len(), 1);
    assert_eq!(published.children.len(), 1);
    assert_eq!(f.workspace.notes(&ticket.reference, 10, 0).unwrap().len(), 1);
    let source = published.source.unwrap();
    assert_eq!(source.ownership, Ownership::External);
    assert_eq!(source.origin, Origin::Published);
    assert_eq!(source.id, "101");
    assert!(source.content_locked && !source.status_locked);
    assert!(published.publication.is_none());
    assert!(
        f.workspace
            .ticket_history(&ticket.reference)
            .unwrap()
            .iter()
            .any(|entry| entry.kind == "source" && entry.to_value == "o/r#101")
    );

    // Exactly the previewed text, and nothing about notes, tags, Efforts or children.
    let created = f.fake.0.lock().unwrap().created.clone();
    assert_eq!(
        created,
        vec![PublishRequest {
            title: "Escalate".into(),
            body: "Body text".into(),
            destination: "o/r".into(),
        }]
    );
    // The subticket stays local and unpublished.
    assert!(f.ticket(&child.reference).source.is_none());
}

#[test]
fn inbound_refresh_after_publication_keeps_active_status_and_never_republishes() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    set_status(&mut f, &ticket.reference, Status::InReview);
    f.publish(&ticket.reference).unwrap();

    for _ in 0..2 {
        let report = f
            .workspace
            .refresh_sources(&f.engine, &RefreshOptions::default())
            .unwrap();
        assert!(report.failures.is_empty());
        assert!(report.imported.is_empty(), "discovery must reuse the published ticket");
    }
    assert_eq!(f.ticket(&ticket.reference).status, Status::InReview);
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
    assert_eq!(f.created(), 1);
}

#[test]
fn a_definite_failure_leaves_the_ticket_local_and_allows_a_later_attempt() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    f.mode(Mode::Refuse);

    let error = publication_error(f.publish(&ticket.reference).unwrap_err());
    let PublicationError::Failed { source, .. } = &error else {
        panic!("expected a definite failure, got {error}");
    };
    assert_eq!(source.code(), "forbidden");
    assert!(error.to_string().contains("remains a local ticket"));
    let after = f.ticket(&ticket.reference);
    assert!(after.source.is_none() && after.publication.is_none());
    let attempts = f.workspace.publication_attempts(&ticket.reference).unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].state, AttemptState::Failed);
    assert_eq!(attempts[0].failure.as_ref().unwrap().code, "forbidden");

    f.mode(Mode::Create);
    assert!(f.publish(&ticket.reference).is_ok());
    assert_eq!(f.created(), 1);
    assert_eq!(f.workspace.publication_attempts(&ticket.reference).unwrap().len(), 2);
}

#[test]
fn a_lost_response_is_unresolved_durably_and_blocks_another_create() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    f.mode(Mode::LoseResponse);

    let error = publication_error(f.publish(&ticket.reference).unwrap_err());
    assert!(matches!(error, PublicationError::Unresolved { .. }));
    assert!(error.to_string().contains("may already exist"));
    assert_eq!(f.created(), 1);

    let check = |f: &Fixture| {
        let after = f.ticket(&ticket.reference);
        assert!(after.source.is_none(), "ownership must not transfer");
        let attempt = after.publication.expect("the unresolved attempt is visible");
        assert_eq!(attempt.state, AttemptState::Unresolved);
        assert_eq!(attempt.destination, "o/r");
        assert_eq!(attempt.title, "Escalate");
        assert_eq!(attempt.failure.unwrap().code, "unavailable");
        assert!(attempt.issue.is_none());
    };
    check(&f);

    // Blocked, however it is asked, and across a restart.
    f.mode(Mode::Create);
    let mut f = f.reopen();
    check(&f);
    let blocked = publication_error(f.publish(&ticket.reference).unwrap_err());
    assert!(matches!(
        blocked,
        PublicationError::Ineligible { reason: IneligibleReason::AttemptOpen, .. }
    ));
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    assert!(matches!(
        preview.eligibility,
        Eligibility::Ineligible { reason: IneligibleReason::AttemptOpen, .. }
    ));
    assert_eq!(preview.attempt.unwrap().state, AttemptState::Unresolved);
    assert_eq!(f.created(), 1, "no second create was sent");
}

#[test]
fn a_crash_after_the_attempt_was_saved_reads_as_unresolved_and_blocks_after_restart() {
    let mut f = Fixture::new();
    let live = describe(&mut f, "Live", "Body");
    let dead = describe(&mut f, "Dead", "Body");
    f.mode(Mode::Crash);
    for (ticket, now) in [(&live, "2999-01-01T00:00:00Z"), (&dead, "2000-01-01T00:00:00Z")] {
        let mut o = options();
        o.now = Some(now.into());
        let engine = f.engine.clone();
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let _ = f.workspace.publish_ticket(&engine, &ticket.reference, &o);
        }));
        assert!(crashed.is_err());
    }
    assert_eq!(f.created(), 2);
    f.mode(Mode::Create);

    let mut f = f.reopen();
    // Within its lease an attempt may still be running; past it, it is unresolved.
    assert_eq!(f.ticket(&live.reference).publication.unwrap().state, AttemptState::InFlight);
    let attempt = f.ticket(&dead.reference).publication.unwrap();
    assert_eq!(attempt.state, AttemptState::Unresolved);
    assert_eq!(attempt.failure.unwrap().code, "interrupted");
    for ticket in [&live, &dead] {
        assert!(matches!(
            publication_error(f.publish(&ticket.reference).unwrap_err()),
            PublicationError::Ineligible { reason: IneligibleReason::AttemptOpen, .. }
        ));
        assert!(f.ticket(&ticket.reference).source.is_none());
    }
    assert_eq!(f.created(), 2);
}

#[test]
fn remote_success_that_cannot_be_recorded_keeps_the_created_issue_and_stays_unresolved() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let path = f.path();
    // The workspace refuses to record the identity, as a full disk or a
    // failing write would, after the issue exists.
    f.hook(move || {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TRIGGER refuse_link BEFORE INSERT ON external_identities BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .unwrap();
    });

    let error = publication_error(f.publish(&ticket.reference).unwrap_err());
    let PublicationError::Unresolved { message, .. } = &error else {
        panic!("expected unresolved, got {error}");
    };
    assert!(message.contains("o/r#101") && message.contains("disk full"));
    let after = f.ticket(&ticket.reference);
    assert!(after.source.is_none());
    let attempt = after.publication.unwrap();
    assert_eq!(attempt.state, AttemptState::Unresolved);
    assert_eq!(attempt.failure.as_ref().unwrap().code, "local_persistence_failed");
    // What was learned is kept, so resolving never has to guess an identity.
    let issue = attempt.issue.unwrap();
    assert_eq!(issue.identity.id, "101");
    assert_eq!(issue.display, "o/r#101");
    assert!(matches!(
        publication_error(f.publish(&ticket.reference).unwrap_err()),
        PublicationError::Ineligible { reason: IneligibleReason::AttemptOpen, .. }
    ));
    assert_eq!(f.created(), 1);
}

#[test]
fn concurrent_submission_is_refused_and_the_workspace_stays_writable_during_the_remote_call() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let path = f.path();
    let engine = f.engine.clone();
    let reference = ticket.reference.clone();
    let observed: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = observed.clone();
    f.hook(move || {
        let mut other = Workspace::open(&path).unwrap();
        // No write lock is held across the network call.
        other.add_note(&reference, "written during the remote call", None).unwrap();
        let attempt = other.show_ticket(&reference).unwrap().publication.unwrap();
        sink.lock().unwrap().push(format!("{:?}", attempt.state));
        let error = other
            .publish_ticket(&engine, &reference, &options())
            .unwrap_err();
        sink.lock().unwrap().push(match error {
            Error::Publication(PublicationError::Ineligible { reason, .. }) => {
                format!("{reason:?}")
            }
            other => other.to_string(),
        });
    });

    f.publish(&ticket.reference).unwrap();

    assert_eq!(*observed.lock().unwrap(), vec!["InFlight", "AttemptOpen"]);
    assert_eq!(f.created(), 1);
    assert_eq!(f.workspace.notes(&ticket.reference, 10, 0).unwrap().len(), 1);
}

#[test]
fn replaying_a_published_request_returns_it_without_another_create() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let first = f.publish(&ticket.reference).unwrap();
    let again = f.publish(&ticket.reference).unwrap();

    assert!(again.replayed);
    assert_eq!(again.attempt.id, first.attempt.id);
    assert_eq!(again.ticket.source.unwrap().id, "101");
    assert_eq!(f.created(), 1);
    assert_eq!(f.workspace.publication_attempts(&ticket.reference).unwrap().len(), 1);
}

#[test]
fn edits_made_while_publishing_are_kept_as_a_note_not_dropped_by_the_next_refresh() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let path = f.path();
    let reference = ticket.reference.clone();
    f.hook(move || {
        let mut other = Workspace::open(&path).unwrap();
        other
            .change_ticket(
                &reference,
                TicketPatch {
                    body: Some("Edited meanwhile".into()),
                    ..TicketPatch::default()
                },
            )
            .unwrap();
    });
    f.publish(&ticket.reference).unwrap();
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();

    assert_eq!(f.ticket(&ticket.reference).body, "Body");
    let notes = f.workspace.notes(&ticket.reference, 10, 0).unwrap();
    assert_eq!(notes.len(), 1);
    assert!(notes[0].content.contains("Edited meanwhile"));
}

#[test]
fn discovery_importing_the_created_issue_first_does_not_attach_it_twice() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let path = f.path();
    let engine = f.engine.clone();
    f.hook(move || {
        let mut other = Workspace::open(&path).unwrap();
        other.refresh_sources(&engine, &RefreshOptions::default()).unwrap();
    });

    let error = publication_error(f.publish(&ticket.reference).unwrap_err());
    assert!(matches!(error, PublicationError::Unresolved { .. }));
    let after = f.ticket(&ticket.reference);
    assert!(after.source.is_none(), "identity stays unique");
    let attempt = after.publication.unwrap();
    assert_eq!(attempt.failure.unwrap().code, "identity_conflict");
    assert_eq!(attempt.issue.unwrap().identity.id, "101");
    // Discovery's ticket is the only one that owns the issue.
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 2);
}

#[test]
fn attempts_survive_export_backup_restore_and_the_format_upgrade() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    f.mode(Mode::LoseResponse);
    f.publish(&ticket.reference).unwrap_err();

    let exported = f.workspace.export().unwrap();
    assert_eq!(exported["publication_attempts"][0]["status"], "unresolved");
    assert_eq!(exported["publication_attempts"][0]["destination"], "o/r");

    let backup = f.dir.path().join("backup.sqlite3");
    f.workspace.backup(&backup).unwrap();
    let path = f.path();
    let Fixture { workspace, dir, .. } = f;
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().publication.unwrap().state,
        AttemptState::Unresolved
    );
    drop(workspace);

    // A version 23 workspace gains the table on open and keeps its tickets.
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE publication_attempts; PRAGMA user_version = 23;")
        .unwrap();
    drop(db);
    let workspace = Workspace::open(&path).unwrap();
    let after = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(after.title, "Escalate");
    assert!(after.publication.is_none());
    drop(dir);
}
