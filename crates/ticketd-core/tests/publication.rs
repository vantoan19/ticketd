//! Publishing a local ticket once, through the workspace workflow boundary, with a
//! controllable fake connector. The failure scenarios are the point: every one
//! of them must leave the ticket local, and every one that might have created an
//! issue must block another create.
// Fixture helpers unwrap so a broken setup fails the test loudly.
#![allow(clippy::unwrap_used)]

#[path = "support/old_workspace.rs"]
mod old_workspace;

#[path = "support/fake_source.rs"]
mod fake_source;

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::json;
use ticketd_core::{
    self, Error, Project, ProjectRemoteChange, Status, Ticket, TicketPatch, Workspace,
    source::{
        ActionKind, AttemptState, ConfigValues, Eligibility, Engine, ExternalIssue, ExternalState,
        IneligibleReason, Origin, Ownership, PublicationError, PublishOptions, PublishRequest,
        RefreshOptions, Resolution, ResolveOptions, SourceError,
    },
};

use fake_source::{FakeSource, PublishMode as Mode};

fn fake_at_host(host: &str) -> FakeSource {
    let source = FakeSource::default();
    {
        let mut remote = source.0.lock().unwrap();
        remote.repository_host = Some(host.to_owned());
        remote.repositories_optional = true;
    }
    source
}

struct Fixture {
    fake: FakeSource,
    engine: Arc<Engine>,
    workspace: Workspace,
    dir: tempfile::TempDir,
}

fn values(value: serde_json::Value) -> ConfigValues {
    value.as_object().unwrap().clone()
}

impl Fixture {
    fn new() -> Self {
        let fake = FakeSource::default();
        fake.0.lock().unwrap().repositories_optional = true;
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
        self.fake.0.lock().unwrap().publish_mode = mode;
    }

    fn created(&self) -> usize {
        self.fake.0.lock().unwrap().created.len()
    }

    fn hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        self.fake.0.lock().unwrap().after_publish = Some(Arc::new(hook));
    }

    fn publish(&mut self, reference: &str) -> Result<ticketd_core::source::PublishOutcome, Error> {
        self.workspace
            .publish_ticket(&self.engine, reference, &options())
    }

    fn ticket(&self, reference: &str) -> Ticket {
        self.workspace.show_ticket(reference).unwrap()
    }

    fn project_ticket(&mut self, remote: Option<&str>) -> (Project, Ticket) {
        let project = self
            .workspace
            .create_project_with_remote("Web", self.dir.path().to_str().unwrap(), remote)
            .unwrap();
        let ticket = self
            .workspace
            .create_ticket_in_project("Fix the log-in screen", Some(&project.id))
            .unwrap();
        (project, ticket)
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
        expected_fingerprint: None,
        agent: None,
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

#[allow(clippy::panic)]
fn publication_error(error: Error) -> PublicationError {
    match error {
        Error::Publication(error) => error,
        other => panic!("expected a publication error, got {other}"),
    }
}

#[test]
fn publication_uses_the_last_successful_connection_answers_offline() {
    let mut f = Fixture::new();
    let ticket = f.workspace.create_ticket("Ship this").unwrap();
    f.fake.0.lock().unwrap().publish_destinations = Some(vec!["o/alternate".into()]);
    // A connector can derive a destination other than the literal repository setting.
    f.workspace
        .save_source(&f.engine, "fake", &values(json!({"repositories": ["o/r"]})))
        .unwrap();
    let preview = |fixture: &Fixture| {
        fixture
            .workspace
            .preview_publication(&fixture.engine, &ticket.reference, "fake", None)
            .unwrap()
    };
    assert_eq!(preview(&f).destination.as_deref(), Some("o/alternate"));

    f.fake.0.lock().unwrap().publish_destinations = Some(vec!["o/new".into()]);
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(preview(&f).destination.as_deref(), Some("o/new"));

    {
        let mut remote = f.fake.0.lock().unwrap();
        remote.publish_destinations = Some(vec!["o/unconfirmed".into()]);
        remote.connection_error = Some("credentials expired".into());
    }
    let refreshed = f
        .workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(refreshed.failures[0].code, "unauthenticated");
    let mut f = f.reopen();
    assert_eq!(preview(&f).destination.as_deref(), Some("o/new"));

    f.fake.0.lock().unwrap().connection_error = None;
    let error = publication_error(f.publish(&ticket.reference).unwrap_err());
    assert!(matches!(error, PublicationError::Failed { .. }), "{error}");
    assert!(
        error
            .to_string()
            .contains("destination is no longer available")
    );
    assert_eq!(f.created(), 0);
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    let sent = f.publish(&ticket.reference).unwrap();
    assert_eq!(sent.attempt.destination, "o/unconfirmed");
}

#[test]
fn a_check_for_the_same_settings_cannot_overwrite_a_concurrent_save() {
    let mut f = Fixture::new();
    let ticket = f.workspace.create_ticket("Ship this").unwrap();
    let path = f.path();
    let engine = f.engine.clone();
    let fake = f.fake.clone();
    {
        let mut remote = f.fake.0.lock().unwrap();
        remote.publish_destinations = Some(vec!["o/old".into()]);
        remote.after_check = Some(Arc::new(move || {
            fake.0.lock().unwrap().publish_destinations = Some(vec!["o/saved".into()]);
            Workspace::open(&path)
                .unwrap()
                .save_source(&engine, "fake", &values(json!({"repositories": ["o/r"]})))
                .unwrap();
        }));
    }
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    assert_eq!(preview.destination.as_deref(), Some("o/saved"));
}

#[test]
fn a_delayed_check_cannot_replace_the_answers_from_a_newer_refresh() {
    let mut f = Fixture::new();
    let ticket = f.workspace.create_ticket("Ship this").unwrap();
    let path = f.path();
    let engine = f.engine.clone();
    let fake = f.fake.clone();
    {
        let mut remote = f.fake.0.lock().unwrap();
        remote.publish_destinations = Some(vec!["o/old".into()]);
        remote.after_check = Some(Arc::new(move || {
            fake.0.lock().unwrap().publish_destinations = Some(vec!["o/new".into()]);
            Workspace::open(&path)
                .unwrap()
                .refresh_sources(
                    &engine,
                    &RefreshOptions {
                        now: Some("2026-02-02T00:00:00Z".into()),
                        ..RefreshOptions::default()
                    },
                )
                .unwrap();
        }));
    }
    f.workspace
        .refresh_sources(
            &f.engine,
            &RefreshOptions {
                now: Some("2026-02-01T00:00:00Z".into()),
                ..RefreshOptions::default()
            },
        )
        .unwrap();
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    assert_eq!(preview.destination.as_deref(), Some("o/new"));
}

#[test]
fn workspace_attachment_links_block_preview_and_publication_before_any_remote_write() {
    let mut f = Fixture::new();
    let source = f.dir.path().join("trace.log");
    std::fs::write(&source, b"diagnostic bytes").unwrap();
    let file = f
        .workspace
        .import_attachment("upload", &source, Some("Cache trace"))
        .unwrap();
    let uri = f.workspace.attachment_uri(&file.id).unwrap();
    let ticket = describe(
        &mut f,
        "Share context",
        &format!("Read [custom label]({uri})."),
    );
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    let Eligibility::Ineligible { message, .. } = preview.eligibility else {
        panic!("workspace-only links must block publication");
    };
    assert!(message.contains("Cache trace"), "{message}");
    assert!(message.contains(&file.id), "{message}");
    assert!(message.contains("description"), "{message}");
    assert_eq!(preview.internal_attachments.len(), 1);
    assert_eq!(preview.internal_attachments[0].uri, uri);
    assert_eq!(
        preview.internal_attachments[0].display_name.as_deref(),
        Some("Cache trace")
    );
    let error = f.publish(&ticket.reference).unwrap_err().to_string();
    assert!(error.contains(&message), "{error}");
    assert_eq!(f.created(), 0);
    assert!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn retries_recheck_exact_outgoing_markdown_and_never_send_foreign_attachment_links() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Share context", "Public text");
    f.mode(Mode::LoseResponse);
    f.publish(&ticket.reference).unwrap_err();
    f.fake.0.lock().unwrap().issues.clear();
    f.resolve(&ticket.reference, &not_created()).unwrap();
    let uri = "ticketd://attachment/other-workspace/unknown-file";
    f.workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some(format!(
                    "| File |\n| --- |\n| [trace][file] |\n\n[file]: {uri}"
                )),
                ..Default::default()
            },
        )
        .unwrap();
    let mut f = f.reopen();
    f.mode(Mode::Create);
    let error = f.publish(&ticket.reference).unwrap_err().to_string();
    assert!(error.contains(uri), "{error}");
    assert_eq!(f.created(), 1, "recovery must not create a second issue");
    assert_eq!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .len(),
        1
    );
    f.workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some("Share [trace](https://example.test/trace.log).".into()),
                ..Default::default()
            },
        )
        .unwrap();
    f.publish(&ticket.reference).unwrap();
    assert_eq!(f.created(), 2);
    assert_eq!(
        f.fake.0.lock().unwrap().created[1].body,
        "Share [trace](https://example.test/trace.log)."
    );
}

#[test]
fn publication_and_refresh_preserve_local_context_while_replacing_only_derived_file_uses() {
    let mut f = Fixture::new();
    let source = f.dir.path().join("trace.log");
    std::fs::write(&source, b"diagnostic bytes").unwrap();
    let file = f
        .workspace
        .import_attachment("upload", &source, None)
        .unwrap();
    let uri = f.workspace.attachment_uri(&file.id).unwrap();
    let document = f
        .workspace
        .create_document(Some("Local context"), &format!("[trace]({uri})"))
        .unwrap();
    let ticket = describe(&mut f, "Share context", "Public description");
    f.workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    f.workspace
        .set_ticket_document(&ticket.reference, &document.id, true)
        .unwrap();
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    assert_eq!(preview.eligibility, Eligibility::Eligible);
    assert_eq!(preview.local.attachments, 1);
    f.publish(&ticket.reference).unwrap();
    let missing_uri = uri.replace(&file.id, "unknown-file");
    for body in [
        format!("[trace]({uri})"),
        format!("[missing]({missing_uri})"),
        "Source removed its file link".into(),
    ] {
        f.fake.0.lock().unwrap().issues.get_mut(&101).unwrap().body = body.clone();
        let report = f
            .workspace
            .refresh_sources(&f.engine, &RefreshOptions::default())
            .unwrap();
        assert!(report.failures.is_empty(), "{report:?}");
        assert_eq!(f.ticket(&ticket.reference).body, body);
        assert_eq!(
            f.workspace.ticket_attachments(&ticket.reference).unwrap(),
            std::slice::from_ref(&file)
        );
        assert_eq!(
            f.workspace.embedded_attachments(&document.id).unwrap(),
            std::slice::from_ref(&file)
        );
        assert!(
            f.workspace
                .context_links(&ticket.reference, 100, 0)
                .unwrap()
                .iter()
                .any(|link| link.target_id == document.id && link.explicit)
        );
        let expected = if body.contains(&missing_uri) {
            vec![missing_uri.clone()]
        } else if body.contains(&uri) {
            vec![uri.clone()]
        } else {
            vec![]
        };
        assert_eq!(
            f.workspace.embedded_attachment_uris(&ticket.id).unwrap(),
            expected
        );
    }
    assert!(
        f.workspace
            .embedded_attachments(&ticket.id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.created(), 1);
    // A new workspace imports the same source text without resolving its foreign identity.
    f.fake.0.lock().unwrap().issues.get_mut(&101).unwrap().body =
        format!("[missing]({missing_uri})");
    {
        let mut remote = f.fake.0.lock().unwrap();
        let mut issue = remote.issues[&101].clone();
        issue.reference.identity.id = "102".into();
        issue.reference.locator = "o/r#102".into();
        issue.display = "o/r#102".into();
        remote.issues.insert(102, issue);
        remote.matching.push(102);
    }
    let report = f
        .workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(report.imported.len(), 1);
    let mut imported = Workspace::open(f.dir.path().join("imported.sqlite3")).unwrap();
    imported
        .save_source(&f.engine, "fake", &values(json!({"repositories": ["o/r"]})))
        .unwrap();
    let report = imported
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(report.imported.len(), 2);
    let imported_ticket = imported.show_ticket(&report.imported[0]).unwrap();
    assert_eq!(
        imported
            .embedded_attachment_uris(&imported_ticket.id)
            .unwrap(),
        vec![missing_uri]
    );
}

#[test]
fn preflight_checks_link_destinations_including_source_html_without_treating_code_as_links() {
    let mut f = Fixture::new();
    let ticket = f.workspace.create_ticket("Share").unwrap();
    for body in [
        "<a href=\"ticketd://attachment/foreign/file\">trace</a>",
        "![trace](TICKETD://attachment/foreign/file)",
        "[trace](ticketd&#58;//attachment/foreign/file)",
        "<ticketd://attachment/foreign/file>",
    ] {
        f.workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    body: Some(body.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(f.publish(&ticket.reference).is_err(), "must block: {body}");
        assert_eq!(f.created(), 0, "must not create: {body}");
    }
    f.workspace.change_ticket(&ticket.reference, TicketPatch {
        body: Some("Code example: `[trace](ticketd://attachment/foreign/file)`\n\n```md\n[trace](ticketd://attachment/foreign/file)\n```".into()),
        ..Default::default()
    }).unwrap();
    f.publish(&ticket.reference).unwrap();
    assert_eq!(f.created(), 1);
}

#[test]
fn resolving_an_uncertain_publication_keeps_local_associations_without_resending_its_body() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Share context");
    let source = f.dir.path().join("trace.log");
    std::fs::write(&source, b"diagnostic bytes").unwrap();
    let file = f
        .workspace
        .import_attachment("upload", &source, None)
        .unwrap();
    let uri = f.workspace.attachment_uri(&file.id).unwrap();
    f.workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    let body = format!("Remote text with [trace]({uri})");
    f.fake.0.lock().unwrap().issues.get_mut(&101).unwrap().body = body.clone();
    let outcome = f
        .resolve(&ticket.reference, &accept_different("101"))
        .unwrap();
    assert_eq!(outcome.ticket.body, body);
    assert_eq!(
        f.workspace.embedded_attachment_uris(&ticket.id).unwrap(),
        vec![uri]
    );
    assert_eq!(
        f.workspace.ticket_attachments(&ticket.reference).unwrap(),
        vec![file]
    );
    assert_eq!(
        f.created(),
        1,
        "resolution reads the existing issue, never publishes again"
    );
    assert!(f.publish(&ticket.reference).unwrap().replayed);
    assert_eq!(f.created(), 1);
}

#[test]
fn preview_shows_exactly_what_would_be_sent_and_does_not_send_it() {
    let mut f = Fixture::new();
    let ticket = describe(
        &mut f,
        "Escalate the cache bug",
        "Cache entries never expire.",
    );
    f.workspace
        .add_activity(&ticket.reference, "private note", None)
        .unwrap();

    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();

    assert_eq!(preview.title, "Escalate the cache bug");
    assert_eq!(preview.body, "Cache entries never expire.");
    assert_eq!(preview.local.activities, 1);
    assert_eq!(preview.destination.as_deref(), Some("o/r"));
    assert_eq!(preview.destinations, vec!["o/r".to_owned()]);
    assert_eq!(preview.provider_name, "Fake");
    assert_eq!(preview.eligibility, Eligibility::Eligible);
    assert_eq!(f.created(), 0);
}

#[test]
fn publication_to_the_project_remote_requires_its_reviewed_preview() {
    let mut f = Fixture::new();
    save_repositories(&mut f, &["acme/api", "Acme/Web"]);
    let (_, ticket) = f.project_ticket(Some("example.test/ACME/web"));

    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    assert_eq!(preview.eligibility, Eligibility::Eligible);
    assert_eq!(preview.destination.as_deref(), Some("Acme/Web"));
    assert_eq!(f.created(), 0);

    let error = f.publish(&ticket.reference).unwrap_err();
    assert!(matches!(
        error,
        Error::Publication(PublicationError::Ineligible {
            reason: IneligibleReason::PreviewRequired,
            ..
        })
    ));
    assert!(error.to_string().contains("fingerprint"), "{error}");
    assert!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.created(), 0);

    let publish = PublishOptions {
        expected_fingerprint: Some(preview.fingerprint),
        ..options()
    };
    let outcome = f
        .workspace
        .publish_ticket(&f.engine, &ticket.reference, &publish)
        .unwrap();
    assert_eq!(outcome.attempt.destination, "Acme/Web");
    assert_eq!(f.fake.0.lock().unwrap().created[0].destination, "Acme/Web");
}

#[test]
fn publication_keeps_its_fallbacks_without_a_matching_project_remote() {
    for (has_project, remote) in [
        (false, None),
        (true, None),
        (true, Some("example.test/acme/unlisted")),
        (true, Some("other.example.test/acme/web")),
    ] {
        let mut f = Fixture::new();
        let ticket = if has_project {
            f.project_ticket(remote).1
        } else {
            f.workspace.create_ticket("Fix the log-in screen").unwrap()
        };
        save_repositories(&mut f, &["acme/api", "acme/web"]);
        let preview = f
            .workspace
            .preview_publication(&f.engine, &ticket.reference, "fake", None)
            .unwrap();
        assert_eq!(preview.destination, None, "remote: {remote:?}");
        assert!(matches!(
            f.publish(&ticket.reference),
            Err(Error::Source(SourceError::InvalidConfiguration(_)))
        ));
        assert_eq!(f.created(), 0);

        save_repositories(&mut f, &["acme/api"]);
        let preview = f
            .workspace
            .preview_publication(&f.engine, &ticket.reference, "fake", None)
            .unwrap();
        assert_eq!(preview.destination.as_deref(), Some("acme/api"));
        let outcome = f.publish(&ticket.reference).unwrap();
        assert_eq!(outcome.attempt.destination, "acme/api");
    }
}

#[test]
fn an_explicit_destination_takes_precedence_over_the_project_remote() {
    let mut f = Fixture::new();
    save_repositories(&mut f, &["acme/api", "acme/web"]);
    let (_, ticket) = f.project_ticket(Some("example.test/acme/web"));

    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", Some("acme/api"))
        .unwrap();
    assert_eq!(preview.destination.as_deref(), Some("acme/api"));
    assert_eq!(preview.eligibility, Eligibility::Eligible);
    assert_eq!(
        preview_reason(&f, &ticket.reference, "acme/unlisted"),
        Some(IneligibleReason::DestinationNotAllowed)
    );

    let publish = PublishOptions {
        destination: Some("acme/api".into()),
        ..options()
    };
    let outcome = f
        .workspace
        .publish_ticket(&f.engine, &ticket.reference, &publish)
        .unwrap();
    assert_eq!(outcome.attempt.destination, "acme/api");
}

#[test]
fn changing_or_clearing_the_default_invalidates_its_preview() {
    let mut f = Fixture::new();
    save_repositories(&mut f, &["acme/api", "acme/web"]);
    let (project, ticket) = f.project_ticket(Some("example.test/acme/web"));
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    let publish = PublishOptions {
        expected_fingerprint: Some(preview.fingerprint),
        ..options()
    };

    let mut second_workspace = Workspace::open(f.path()).unwrap();
    for edit in [
        ProjectRemoteChange::Set("example.test/acme/api"),
        ProjectRemoteChange::Clear,
    ] {
        second_workspace
            .edit_project_with_remote(&project.id, &project.name, &project.path, edit)
            .unwrap();
        assert!(matches!(
            f.workspace
                .publish_ticket(&f.engine, &ticket.reference, &publish),
            Err(Error::Publication(
                PublicationError::ChangedSincePreview { .. }
            ))
        ));
    }
    assert!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.created(), 0);
}

#[test]
fn a_preview_cannot_be_used_with_the_same_repository_name_on_another_host() {
    let mut f = Fixture::new();
    save_repositories(&mut f, &["acme/web"]);
    let (_, ticket) = f.project_ticket(Some("example.test/acme/web"));
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    let publish = PublishOptions {
        expected_fingerprint: Some(preview.fingerprint),
        ..options()
    };
    let other = fake_at_host("other.example.test");
    let mut other_engine = Engine::new();
    other_engine.register(Box::new(other.clone())).unwrap();

    assert!(matches!(
        f.workspace
            .publish_ticket(&other_engine, &ticket.reference, &publish),
        Err(Error::Publication(
            PublicationError::ChangedSincePreview { .. }
        ))
    ));
    assert_eq!(f.created(), 0);
    assert!(other.0.lock().unwrap().created.is_empty());
}

#[test]
fn preview_refuses_a_malformed_destination_the_way_publishing_does() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body.");
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", Some("nonsense"))
        .unwrap();
    let Eligibility::Ineligible { reason, message } = preview.eligibility else {
        panic!("a malformed destination must not be eligible");
    };
    assert_eq!(reason, IneligibleReason::InvalidDestination);
    assert!(
        message.contains("nonsense") && message.contains("owner/name"),
        "{message}"
    );
    // The publish refuses it too, before recording an attempt.
    let mut publish = options();
    publish.destination = Some("nonsense".into());
    assert!(
        f.workspace
            .publish_ticket(&f.engine, &ticket.reference, &publish)
            .is_err()
    );
    assert!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.created(), 0);
}

fn save_repositories(f: &mut Fixture, repositories: &[&str]) {
    f.workspace
        .save_source(
            &f.engine,
            "fake",
            &values(json!({"repositories": repositories})),
        )
        .unwrap();
}

fn preview_reason(f: &Fixture, reference: &str, destination: &str) -> Option<IneligibleReason> {
    let preview = f
        .workspace
        .preview_publication(&f.engine, reference, "fake", Some(destination))
        .unwrap();
    match preview.eligibility {
        Eligibility::Eligible => None,
        Eligibility::Ineligible { reason, .. } => Some(reason),
    }
}

#[test]
fn a_listed_destination_is_an_allowlist_for_preview_and_publish() {
    let mut f = Fixture::new();
    save_repositories(&mut f, &["acme/tracker"]);
    let ticket = describe(&mut f, "Escalate", "Private roadmap text.");

    assert_eq!(preview_reason(&f, &ticket.reference, "acme/tracker"), None);
    let preview = f
        .workspace
        .preview_publication(
            &f.engine,
            &ticket.reference,
            "fake",
            Some("acme/secret-roadmap"),
        )
        .unwrap();
    let Eligibility::Ineligible { reason, message } = preview.eligibility else {
        panic!("a destination outside the list must not be eligible");
    };
    assert_eq!(reason, IneligibleReason::DestinationNotAllowed);
    assert!(
        message.contains("acme/secret-roadmap") && message.contains("acme/tracker"),
        "{message}"
    );

    // The publish refuses it before any attempt is recorded or call is made.
    let mut publish = options();
    publish.destination = Some("acme/secret-roadmap".into());
    let error = f
        .workspace
        .publish_ticket(&f.engine, &ticket.reference, &publish)
        .unwrap_err();
    assert!(
        matches!(
            error,
            Error::Publication(PublicationError::Ineligible {
                reason: IneligibleReason::DestinationNotAllowed,
                ..
            })
        ),
        "{error:?}"
    );
    assert!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.created(), 0);

    // The listed one still publishes.
    publish.destination = Some("acme/tracker".into());
    f.workspace
        .publish_ticket(&f.engine, &ticket.reference, &publish)
        .unwrap();
    assert_eq!(f.created(), 1);
}

#[test]
fn destination_names_are_compared_without_regard_to_case() {
    let mut f = Fixture::new();
    save_repositories(&mut f, &["Acme/Tracker"]);
    let ticket = describe(&mut f, "Escalate", "Body.");
    assert_eq!(preview_reason(&f, &ticket.reference, "acme/tracker"), None);
    let mut publish = options();
    publish.destination = Some("ACME/TRACKER".into());
    f.workspace
        .publish_ticket(&f.engine, &ticket.reference, &publish)
        .unwrap();
    assert_eq!(f.created(), 1);
}

#[test]
fn an_empty_destination_list_accepts_any_well_formed_destination() {
    let mut f = Fixture::new();
    save_repositories(&mut f, &[]);
    let ticket = describe(&mut f, "Escalate", "Body.");
    assert_eq!(preview_reason(&f, &ticket.reference, "any/repo"), None);
    // Still checked for form.
    assert_eq!(
        preview_reason(&f, &ticket.reference, "nonsense"),
        Some(IneligibleReason::InvalidDestination)
    );
    let mut publish = options();
    publish.destination = Some("any/repo".into());
    f.workspace
        .publish_ticket(&f.engine, &ticket.reference, &publish)
        .unwrap();
    assert_eq!(f.created(), 1);
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
            PublicationError::Ineligible {
                reason: IneligibleReason::Status,
                ..
            }
        ));
    }
    let duplicate = f.workspace.create_ticket("Copy").unwrap();
    f.workspace
        .mark_duplicate(&duplicate.reference, &canonical.reference, None)
        .unwrap();
    assert!(matches!(
        publication_error(f.publish(&duplicate.reference).unwrap_err()),
        PublicationError::Ineligible {
            reason: IneligibleReason::Status,
            ..
        }
    ));
    let trashed = f.workspace.create_ticket("Gone").unwrap();
    f.workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();
    assert!(matches!(
        publication_error(f.publish(&trashed.reference).unwrap_err()),
        PublicationError::Ineligible {
            reason: IneligibleReason::Trashed,
            ..
        }
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
        PublicationError::Ineligible {
            reason: IneligibleReason::SourceNotConnected,
            ..
        }
    ));
}

#[test]
fn successful_publication_transfers_ownership_and_keeps_identity_progress_and_organization() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body text");
    set_status(&mut f, &ticket.reference, Status::InProgress);
    let plan = f.workspace.create_plan("Launch").unwrap();
    f.workspace
        .set_plan(&ticket.reference, Some(&plan.id), None)
        .unwrap();
    f.workspace.add_tag(&ticket.reference, "backend").unwrap();
    f.workspace
        .add_activity(&ticket.reference, "local note", None)
        .unwrap();
    let blocker = f.workspace.create_ticket("Prerequisite").unwrap();
    f.workspace
        .add_dependency(&blocker.reference, &ticket.reference, None)
        .unwrap();
    let child = f.workspace.create_ticket("Detail").unwrap();
    f.workspace
        .set_parent(&child.reference, Some(&ticket.reference), None)
        .unwrap();

    let outcome = f.publish(&ticket.reference).unwrap();

    assert!(!outcome.replayed);
    assert_eq!(outcome.attempt.state, AttemptState::Succeeded);
    assert_eq!(outcome.attempt.issue.as_ref().unwrap().display, "o/r#101");
    let published = f.ticket(&ticket.reference);
    assert_eq!(published.reference, ticket.reference);
    assert_eq!(published.id, ticket.id);
    assert_eq!(published.status, Status::InProgress);
    assert_eq!(published.plan_id.as_deref(), Some(plan.id.as_str()));
    assert_eq!(published.tags, vec!["backend".to_owned()]);
    assert_eq!(published.prerequisites.len(), 1);
    assert_eq!(published.children.len(), 1);
    assert_eq!(
        f.workspace
            .activities(&ticket.reference, 10, 0)
            .unwrap()
            .len(),
        1
    );
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

    // Exactly the previewed text, and nothing about notes, tags, Plans or children.
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
        assert!(
            report.imported.is_empty(),
            "discovery must reuse the published ticket"
        );
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
    assert_eq!(source.code(), "rejected");
    assert!(error.to_string().contains("remains a local ticket"));
    let after = f.ticket(&ticket.reference);
    assert!(after.source.is_none() && after.publication.is_none());
    let attempts = f.workspace.publication_attempts(&ticket.reference).unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].state, AttemptState::Failed);
    assert_eq!(attempts[0].failure.as_ref().unwrap().code, "rejected");

    f.mode(Mode::Create);
    assert!(f.publish(&ticket.reference).is_ok());
    assert_eq!(f.created(), 1);
    assert_eq!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .len(),
        2
    );
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
        let attempt = after
            .publication
            .expect("the unresolved attempt is visible");
        assert_eq!(attempt.state, AttemptState::Unresolved);
        assert_eq!(attempt.destination, "o/r");
        assert_eq!(attempt.title, "Escalate");
        assert_eq!(attempt.failure.unwrap().code, "unavailable");
        assert!(attempt.issue.is_none());
    };
    check(&f);
    let history = f.workspace.ticket_history(&ticket.reference).unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|entry| entry.kind == "publication_unresolved")
            .count(),
        1
    );
    assert_eq!(
        history
            .iter()
            .find(|entry| entry.kind == "publication_unresolved")
            .unwrap()
            .to_value,
        "o/r"
    );

    // Blocked, however it is asked, and across a restart.
    f.mode(Mode::Create);
    let mut f = f.reopen();
    check(&f);
    let blocked = publication_error(f.publish(&ticket.reference).unwrap_err());
    assert!(matches!(
        blocked,
        PublicationError::Ineligible {
            reason: IneligibleReason::AttemptOpen,
            ..
        }
    ));
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    assert!(matches!(
        preview.eligibility,
        Eligibility::Ineligible {
            reason: IneligibleReason::AttemptOpen,
            ..
        }
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
    for (ticket, now) in [
        (&live, "2999-01-01T00:00:00Z"),
        (&dead, "2000-01-01T00:00:00Z"),
    ] {
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
    assert_eq!(
        f.ticket(&live.reference).publication.unwrap().state,
        AttemptState::InFlight
    );
    let attempt = f.ticket(&dead.reference).publication.unwrap();
    assert_eq!(attempt.state, AttemptState::Unresolved);
    assert_eq!(attempt.failure.unwrap().code, "interrupted");
    for ticket in [&live, &dead] {
        assert!(matches!(
            publication_error(f.publish(&ticket.reference).unwrap_err()),
            PublicationError::Ineligible {
                reason: IneligibleReason::AttemptOpen,
                ..
            }
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
    assert_eq!(
        attempt.failure.as_ref().unwrap().code,
        "local_persistence_failed"
    );
    // What was learned is kept, so resolving never has to guess an identity.
    let issue = attempt.issue.unwrap();
    assert_eq!(issue.identity.id, "101");
    assert_eq!(issue.display, "o/r#101");
    assert!(matches!(
        publication_error(f.publish(&ticket.reference).unwrap_err()),
        PublicationError::Ineligible {
            reason: IneligibleReason::AttemptOpen,
            ..
        }
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
        other
            .add_activity(&reference, "written during the remote call", None)
            .unwrap();
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
    assert_eq!(
        f.workspace
            .activities(&ticket.reference, 10, 0)
            .unwrap()
            .len(),
        1
    );
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
    assert_eq!(
        f.workspace
            .publication_attempts(&ticket.reference)
            .unwrap()
            .len(),
        1
    );
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
    let notes = f.workspace.activities(&ticket.reference, 10, 0).unwrap();
    assert_eq!(notes.len(), 1);
    assert!(notes[0].brief.contains("Edited meanwhile"));
}

#[test]
fn discovery_leaves_an_issue_an_open_attempt_is_creating_to_that_attempt() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let path = f.path();
    let engine = f.engine.clone();
    f.hook(move || {
        let mut other = Workspace::open(&path).unwrap();
        other
            .refresh_sources(&engine, &RefreshOptions::default())
            .unwrap();
    });

    // Discovery runs while the create call is out and does not import the issue
    // as a ticket of its own, so the publish attaches it to the original ticket.
    f.publish(&ticket.reference).unwrap();
    let after = f.ticket(&ticket.reference);
    assert_eq!(after.source.unwrap().id, "101");
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
}

#[test]
fn attempts_survive_export_backup_and_restore() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    f.mode(Mode::LoseResponse);
    f.publish(&ticket.reference).unwrap_err();

    let exported = f.workspace.export().unwrap();
    assert_eq!(exported["publication_attempts"][0]["status"], "unresolved");
    assert_eq!(exported["publication_attempts"][0]["destination"], "o/r");
    assert_eq!(
        exported["publication_attempts"][0]["destination_host"],
        "example.test"
    );

    let backup = f.dir.path().join("backup.sqlite3");
    f.workspace.backup(&backup).unwrap();
    let path = f.path();
    let Fixture { workspace, dir, .. } = f;
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .show_ticket(&ticket.reference)
            .unwrap()
            .publication
            .unwrap()
            .state,
        AttemptState::Unresolved
    );
    drop(workspace);
    drop(dir);
}

/// A version 25 workspace gains the table on open and keeps its tickets.
#[test]
fn a_version_25_workspace_gains_the_attempts_table_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 25).unwrap();
    old_workspace::add_ticket(&path, "11111111-1111-4111-8111-111111111111", "Escalate");

    let workspace = Workspace::open(&path).unwrap();

    let after = workspace.show_ticket("T-KQ1").unwrap();
    assert_eq!(after.title, "Escalate");
    assert!(after.publication.is_none());
}

// ---- Resolving an uncertain publication (#109) ----

fn attach(issue: Option<&str>) -> ResolveOptions {
    ResolveOptions {
        resolution: Resolution::Attach {
            issue: issue.map(str::to_owned),
        },
        now: None,
        agent: None,
        accept_different_content: false,
    }
}

fn accept_different(issue: &str) -> ResolveOptions {
    ResolveOptions {
        accept_different_content: true,
        ..attach(Some(issue))
    }
}

/// An hour after the attempts the tests make: past the create call's lease and
/// the time GitHub needs to list a just-created issue.
fn later() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    chrono::DateTime::from_timestamp(now as i64 + 3600, 0)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn not_created() -> ResolveOptions {
    ResolveOptions {
        resolution: Resolution::NotCreated,
        now: Some(later()),
        agent: None,
        accept_different_content: false,
    }
}

impl Fixture {
    fn resolve(
        &mut self,
        reference: &str,
        options: &ResolveOptions,
    ) -> Result<ticketd_core::source::PublishOutcome, Error> {
        self.workspace
            .resolve_publication(&self.engine, reference, options)
    }

    /// A ticket whose create call was answered with a timeout: the issue exists.
    fn lost_response(&mut self, title: &str) -> Ticket {
        let ticket = describe(self, title, "Body");
        self.mode(Mode::LoseResponse);
        self.publish(&ticket.reference).unwrap_err();
        self.mode(Mode::Create);
        ticket
    }

    fn still_unresolved(&self, reference: &str) {
        let after = self.ticket(reference);
        assert!(after.source.is_none(), "ownership must not transfer");
        assert_eq!(after.publication.unwrap().state, AttemptState::Unresolved);
    }
}

#[test]
fn publication_recovery_cannot_use_the_same_repository_on_a_different_host() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    f.workspace = Workspace::open(f.path()).unwrap();

    let wrong_host = fake_at_host("other.example.test");
    let lookups = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    wrong_host.0.lock().unwrap().after_lookup = Some(Arc::new({
        let lookups = lookups.clone();
        move || {
            lookups.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }));
    let mut other_engine = Engine::new();
    other_engine.register(Box::new(wrong_host)).unwrap();

    for search in [false, true] {
        let review = f
            .workspace
            .review_publication_at(&other_engine, &ticket.reference, search, Some(&later()))
            .unwrap();
        let failure = review.lookup_failure.unwrap();
        assert!(failure.message.contains("sent to example.test"));
        assert!(failure.message.contains("uses other.example.test"));
        assert!(review.actions.iter().all(|action| !action.available));
        assert!(review.candidates_complete.is_none());
    }

    for options in [not_created(), attach(Some("101"))] {
        let error = f
            .workspace
            .resolve_publication(&other_engine, &ticket.reference, &options)
            .unwrap_err();
        assert!(matches!(
            error,
            Error::Publication(PublicationError::Unverified { .. })
        ));
        assert!(error.to_string().contains("sent to example.test"));
        assert!(error.to_string().contains("uses other.example.test"));
        f.still_unresolved(&ticket.reference);
    }
    assert_eq!(lookups.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(
        f.resolve(&ticket.reference, &attach(Some("101")))
            .unwrap()
            .attempt
            .state,
        AttemptState::Succeeded
    );
}

#[test]
fn confirming_the_created_issue_completes_the_handoff_and_keeps_local_progress() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    set_status(&mut f, &ticket.reference, Status::InProgress);
    f.workspace
        .add_activity(&ticket.reference, "local progress", None)
        .unwrap();

    let outcome = f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();

    assert!(!outcome.replayed);
    assert_eq!(outcome.attempt.state, AttemptState::Succeeded);
    let after = f.ticket(&ticket.reference);
    assert_eq!(after.id, ticket.id, "same local ticket");
    assert_eq!(after.status, Status::InProgress);
    assert!(after.publication.is_none());
    let source = after.source.expect("the source now owns the ticket");
    assert_eq!(source.display, "o/r#101");
    assert_eq!(source.origin, Origin::Published);
    assert!(matches!(source.ownership, Ownership::External));
    assert_eq!(
        f.workspace
            .activities(&ticket.reference, 10, 0)
            .unwrap()
            .len(),
        1
    );
    // Attached once, and nothing further is ever created.
    assert_eq!(f.created(), 1);
    assert!(f.publish(&ticket.reference).unwrap().replayed);
    assert_eq!(f.created(), 1);
}

#[test]
fn a_replayed_or_duplicate_resolution_attaches_nothing_more() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();

    let again = f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();
    assert!(again.replayed);
    // A different resolver (another process) sees the settled attempt too.
    let mut other = Workspace::open(f.path()).unwrap();
    let from_other = other
        .resolve_publication(&f.engine, &ticket.reference, &attach(None))
        .unwrap();
    assert!(from_other.replayed);
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
    // The opposite claim cannot overturn a settled attempt.
    assert!(matches!(
        publication_error(f.resolve(&ticket.reference, &not_created()).unwrap_err()),
        PublicationError::Settled { .. }
    ));
    assert!(f.ticket(&ticket.reference).source.is_some());
}

#[test]
fn the_issue_recorded_on_the_attempt_can_be_confirmed_without_naming_it() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let path = f.path();
    f.hook(move || {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TRIGGER refuse_link BEFORE INSERT ON external_identities BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .unwrap();
    });
    f.publish(&ticket.reference).unwrap_err();
    let db = rusqlite::Connection::open(f.path()).unwrap();
    db.execute_batch("DROP TRIGGER refuse_link").unwrap();
    drop(db);

    // The known issue means "created" is the only honest answer.
    assert!(matches!(
        publication_error(f.resolve(&ticket.reference, &not_created()).unwrap_err()),
        PublicationError::Mismatch { .. }
    ));
    f.still_unresolved(&ticket.reference);
    let outcome = f.resolve(&ticket.reference, &attach(None)).unwrap();
    assert_eq!(outcome.attempt.issue.unwrap().display, "o/r#101");
    assert_eq!(
        f.ticket(&ticket.reference).source.unwrap().display,
        "o/r#101"
    );
}

#[test]
fn an_issue_that_cannot_be_verified_or_is_not_this_one_leaves_the_attempt_unresolved() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");

    // Provider unreachable: not proof of anything.
    f.fake.0.lock().unwrap().lookup_down = true;
    for options in [attach(Some("101")), not_created()] {
        assert!(matches!(
            publication_error(f.resolve(&ticket.reference, &options).unwrap_err()),
            PublicationError::Unverified { .. }
        ));
        f.still_unresolved(&ticket.reference);
    }
    f.fake.0.lock().unwrap().lookup_down = false;

    // No such issue, an issue in another repository, and nothing named at all.
    for text in [Some("999"), Some("elsewhere/repo#101"), None] {
        let error = publication_error(f.resolve(&ticket.reference, &attach(text)).unwrap_err());
        assert!(
            matches!(
                error,
                PublicationError::Unverified { .. } | PublicationError::Mismatch { .. }
            ),
            "{error}"
        );
        f.still_unresolved(&ticket.reference);
    }

    // An issue that existed before the attempt began cannot be its result.
    {
        let mut remote = f.fake.0.lock().unwrap();
        let mut old = remote.issues[&101].clone();
        old.reference.identity.id = "7".into();
        old.reference.locator = "o/r#7".into();
        old.created_at = "2020-01-01T00:00:00Z".into();
        remote.issues.insert(7, old);
    }
    assert!(matches!(
        publication_error(
            f.resolve(&ticket.reference, &attach(Some("7")))
                .unwrap_err()
        ),
        PublicationError::Mismatch { .. }
    ));
    f.still_unresolved(&ticket.reference);
    assert_eq!(f.created(), 1);
}

#[test]
fn a_candidate_after_a_crash_must_be_confirmed_across_restart() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    f.mode(Mode::Crash);
    let engine = f.engine.clone();
    let mut o = options();
    o.now = Some("2000-01-01T00:00:00Z".into());
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let _ = f.workspace.publish_ticket(&engine, &ticket.reference, &o);
    }));
    let mut f = f.reopen();
    f.mode(Mode::Create);

    // The process died after creating: a match exists, so it cannot be ruled out.
    let error = publication_error(f.resolve(&ticket.reference, &not_created()).unwrap_err());
    let PublicationError::Candidates { issues, .. } = error else {
        panic!("expected candidates");
    };
    assert_eq!(issues[0].display, "o/r#101");
    f.still_unresolved(&ticket.reference);

    let done = f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();
    assert_eq!(done.attempt.state, AttemptState::Succeeded);
}

#[test]
fn not_created_needs_a_complete_empty_search_and_then_allows_another_attempt() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Never sent");
    // The create never actually landed.
    f.fake.0.lock().unwrap().issues.clear();

    // An incomplete read proves nothing.
    f.fake.0.lock().unwrap().search_incomplete = true;
    assert!(matches!(
        publication_error(f.resolve(&ticket.reference, &not_created()).unwrap_err()),
        PublicationError::Unverified { .. }
    ));
    f.still_unresolved(&ticket.reference);
    assert!(matches!(
        publication_error(f.publish(&ticket.reference).unwrap_err()),
        PublicationError::Ineligible {
            reason: IneligibleReason::AttemptOpen,
            ..
        }
    ));

    f.fake.0.lock().unwrap().search_incomplete = false;
    let outcome = f.resolve(&ticket.reference, &not_created()).unwrap();
    assert_eq!(outcome.attempt.state, AttemptState::Failed);
    assert_eq!(outcome.attempt.failure.unwrap().code, "ruled_out");
    assert!(f.ticket(&ticket.reference).source.is_none());
    assert!(f.ticket(&ticket.reference).publication.is_none());
    // Now, and only now, publishing again is allowed.
    let created = f.publish(&ticket.reference).unwrap();
    assert_eq!(created.attempt.state, AttemptState::Succeeded);
}

#[test]
fn a_lost_response_is_not_imported_by_discovery_and_attach_finishes_it() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(
        f.workspace.list_tickets().unwrap().len(),
        1,
        "no second ticket while the attempt is open"
    );

    let done = f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();
    assert_eq!(done.attempt.state, AttemptState::Succeeded);
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
}

#[test]
fn discovery_holds_matching_issues_only_in_the_open_publication_repository_and_host() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    save_repositories(&mut f, &["o/r", "o/other"]);
    let mut different_repository = unrelated_issue(&f, 102, "Escalate", "Body");
    different_repository.repository = Some("example.test/o/other".into());
    {
        let mut remote = f.fake.0.lock().unwrap();
        // Repository matching follows the provider's case-insensitive comparison.
        remote.issues.get_mut(&101).unwrap().repository = Some("example.test/O/R".into());
        remote.issues.insert(102, different_repository);
        remote.matching.push(102);
    }

    let refresh = f
        .workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(refresh.imported.len(), 1);
    assert_eq!(f.ticket(&refresh.imported[0]).source.unwrap().id, "102");

    let other_host = fake_at_host("other.example.test");
    let mut same_repository_on_other_host = unrelated_issue(&f, 103, "Escalate", "Body");
    same_repository_on_other_host.repository = Some("other.example.test/o/r".into());
    {
        let mut remote = other_host.0.lock().unwrap();
        remote.issues.insert(103, same_repository_on_other_host);
        remote.matching.push(103);
    }
    let mut other_engine = Engine::new();
    other_engine.register(Box::new(other_host)).unwrap();
    let refresh = f
        .workspace
        .refresh_sources(&other_engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(refresh.imported.len(), 1);
    assert_eq!(f.ticket(&refresh.imported[0]).source.unwrap().id, "103");
    f.still_unresolved(&ticket.reference);
}

#[test]
fn discovery_holds_matches_in_a_legacy_publications_repository_until_the_host_is_confirmed() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    save_repositories(&mut f, &["o/r", "o/other"]);
    // An unresolved attempt migrated from format 88 can have no saved host.
    rusqlite::Connection::open(f.path())
        .unwrap()
        .execute(
            "UPDATE publication_attempts SET destination_host = NULL WHERE ticket_id = ?1",
            [&ticket.id],
        )
        .unwrap();

    let other_host = fake_at_host("other.example.test");
    let mut same_repository = unrelated_issue(&f, 102, "Escalate", "Body");
    same_repository.repository = Some("other.example.test/o/r".into());
    let mut different_repository = unrelated_issue(&f, 103, "Escalate", "Body");
    different_repository.repository = Some("other.example.test/o/other".into());
    {
        let mut remote = other_host.0.lock().unwrap();
        remote
            .issues
            .extend([(102, same_repository), (103, different_repository)]);
        remote.matching.extend([102, 103]);
    }
    let mut other_engine = Engine::new();
    other_engine.register(Box::new(other_host)).unwrap();
    let refresh = f
        .workspace
        .refresh_sources(&other_engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(refresh.imported.len(), 1);
    assert_eq!(f.ticket(&refresh.imported[0]).source.unwrap().id, "103");

    f.workspace
        .confirm_publication_host(&f.engine, &ticket.reference, "example.test")
        .unwrap();
    let refresh = f
        .workspace
        .refresh_sources(&other_engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(refresh.imported.len(), 1);
    assert_eq!(f.ticket(&refresh.imported[0]).source.unwrap().id, "102");
    f.still_unresolved(&ticket.reference);
}

#[test]
fn attach_adopts_an_issue_discovery_imported_after_the_attempt_began() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    f.workspace
        .add_activity(&ticket.reference, "local work", None)
        .unwrap();
    // A teammate rewrote the title and the description, so discovery no longer
    // recognizes the issue as this attempt's result and imports it as T-KQ2.
    {
        let mut remote = f.fake.0.lock().unwrap();
        let issue = remote.issues.get_mut(&101).unwrap();
        issue.title = "Renamed".into();
        issue.body = "Rewritten".into();
    }
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 2);

    let done = f
        .resolve(&ticket.reference, &accept_different("101"))
        .unwrap();
    assert_eq!(done.attempt.state, AttemptState::Succeeded);
    let source = done.ticket.source.unwrap();
    assert_eq!(
        (source.id.as_str(), source.origin),
        ("101", Origin::Published)
    );
    // The local note, and the text the issue replaced.
    assert_eq!(
        f.workspace
            .activities(&ticket.reference, 10, 0)
            .unwrap()
            .len(),
        2
    );
    // The imported ticket is in the trash, not deleted, and the identity is unique.
    assert!(f.workspace.show_ticket("T-KQ2").unwrap().trashed);
    assert!(f.workspace.show_ticket("T-KQ2").unwrap().source.is_none());
}

#[test]
fn publishing_sends_exactly_what_was_previewed_or_nothing() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let preview = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    // An agent edits the description while the preview is on screen.
    f.workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some("internal notes the agent added".into()),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    let mut changed = options();
    changed.expected_fingerprint = Some(preview.fingerprint.clone());
    let error = publication_error(
        f.workspace
            .publish_ticket(&f.engine, &ticket.reference, &changed)
            .unwrap_err(),
    );
    assert!(matches!(
        error,
        PublicationError::ChangedSincePreview { .. }
    ));
    assert_eq!(f.created(), 0, "nothing was sent");
    assert!(f.ticket(&ticket.reference).publication.is_none());

    let fresh = f
        .workspace
        .preview_publication(&f.engine, &ticket.reference, "fake", None)
        .unwrap();
    changed.expected_fingerprint = Some(fresh.fingerprint);
    f.workspace
        .publish_ticket(&f.engine, &ticket.reference, &changed)
        .unwrap();
    assert_eq!(
        f.fake.0.lock().unwrap().created[0].body,
        "internal notes the agent added"
    );
}

#[test]
fn attach_rechecks_eligibility_and_brings_a_closed_issues_closure() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    // While unresolved the ticket is local, so the person finishes it.
    set_status(&mut f, &ticket.reference, Status::Done);
    let error = publication_error(
        f.resolve(&ticket.reference, &attach(Some("101")))
            .unwrap_err(),
    );
    assert!(
        matches!(error, PublicationError::Mismatch { .. }),
        "{error}"
    );
    f.still_unresolved(&ticket.reference);

    // Back in progress, and a teammate has meanwhile closed the issue as completed.
    set_status(&mut f, &ticket.reference, Status::InProgress);
    f.fake.0.lock().unwrap().issues.get_mut(&101).unwrap().state =
        ExternalState::named(ticketd_core::source::StateCategory::Completed, "Closed");
    let done = f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();
    assert_eq!(done.ticket.status, Status::Done);
    assert!(done.ticket.source.unwrap().status_locked);
}

#[test]
fn a_preflight_that_loses_its_attempt_never_dispatches_a_mutation() {
    let mut f = Fixture::new();
    let ticket = f.workspace.create_ticket("Racing publication").unwrap();
    let reference = ticket.reference.clone();
    let path = f.path();
    let engine = f.engine.clone();
    f.fake.0.lock().unwrap().after_check = Some(Arc::new(move || {
        let mut other = Workspace::open(&path).unwrap();
        other
            .resolve_publication(
                &engine,
                &reference,
                &ResolveOptions {
                    now: Some("2026-02-01T00:10:00Z".into()),
                    ..not_created()
                },
            )
            .unwrap();
    }));
    let options = PublishOptions {
        now: Some("2026-02-01T00:00:00Z".into()),
        ..options()
    };
    assert!(matches!(
        publication_error(
            f.workspace
                .publish_ticket(&f.engine, &ticket.reference, &options)
                .unwrap_err()
        ),
        PublicationError::Failed { .. }
    ));
    assert_eq!(f.created(), 0);
}

#[test]
fn a_late_creation_after_a_not_created_verdict_reopens_the_attempt_with_the_issue() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    let path = f.path();
    let engine = f.engine.clone();
    let reference = ticket.reference.clone();
    let fake = f.fake.clone();
    // The publisher stalls past its lease; a resolver searches while the issue is
    // not yet visible and confirms "not created"; then the late answer arrives.
    f.hook(move || {
        let hidden = fake.0.lock().unwrap().issues.remove(&101).unwrap();
        let mut other = Workspace::open(&path).unwrap();
        let mut verdict = not_created();
        verdict.now = Some("2999-01-01T00:00:00Z".into());
        other
            .resolve_publication(&engine, &reference, &verdict)
            .unwrap();
        fake.0.lock().unwrap().issues.insert(101, hidden);
    });
    let error = publication_error(f.publish(&ticket.reference).unwrap_err());
    assert!(matches!(error, PublicationError::Unresolved { .. }));
    let after = f.ticket(&ticket.reference);
    let attempt = after.publication.expect("the attempt is open again");
    assert_eq!(attempt.state, AttemptState::Unresolved);
    assert_eq!(attempt.issue.unwrap().identity.id, "101");
    assert!(after.source.is_none());
}

#[test]
fn one_clock_judges_the_lease_so_a_crashed_attempt_is_settled_consistently() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    f.mode(Mode::Crash);
    let mut crashed = options();
    crashed.now = Some("2000-01-01T00:00:00Z".into());
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        f.workspace
            .publish_ticket(&f.engine, &ticket.reference, &crashed)
    }));
    assert!(outcome.is_err(), "the process died during the create call");
    f.mode(Mode::Create);
    f.fake.0.lock().unwrap().issues.clear();

    // Thirty seconds later the lease has not run out: still running, by one clock.
    let mut early = not_created();
    early.now = Some("2000-01-01T00:00:30Z".into());
    assert!(matches!(
        publication_error(f.resolve(&ticket.reference, &early).unwrap_err()),
        PublicationError::StillRunning { .. }
    ));
    // After the lease the attempt settles as not created.
    let mut late = not_created();
    late.now = Some("2000-01-01T00:08:00Z".into());
    late.agent = Some("assistant".into());
    let settled = f.resolve(&ticket.reference, &late).unwrap();
    assert_eq!(settled.attempt.state, AttemptState::Failed);
    // The verdict is in the history, attributed to who asked.
    let history = f.workspace.ticket_history(&ticket.reference).unwrap();
    let entry = history.iter().find(|e| e.kind == "publication").unwrap();
    assert_eq!(entry.to_value, "not created");
    assert_eq!(entry.editing_agent.as_deref(), Some("assistant"));
}

#[test]
fn a_request_that_never_left_is_a_definite_failure_not_an_unresolved_attempt() {
    let mut f = Fixture::new();
    let ticket = describe(&mut f, "Escalate", "Body");
    f.mode(Mode::NotSent);
    let error = publication_error(f.publish(&ticket.reference).unwrap_err());
    assert!(matches!(error, PublicationError::Failed { .. }), "{error}");
    assert!(f.ticket(&ticket.reference).publication.is_none());
}

#[test]
fn the_review_offers_only_actions_that_can_succeed() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    f.fake.0.lock().unwrap().issues.clear();
    // The search cannot run: "nothing was created" must not be offered.
    f.fake.0.lock().unwrap().lookup_down = true;
    let review = f
        .workspace
        .review_publication_at(&f.engine, &ticket.reference, true, Some(&later()))
        .unwrap();
    assert!(review.lookup_failure.is_some());
    let not_created = review
        .actions
        .iter()
        .find(|a| a.kind == ActionKind::NotCreated)
        .unwrap();
    assert!(!not_created.available, "{}", not_created.detail);
    // Neither is it offered when only part of the window could be read.
    {
        let mut remote = f.fake.0.lock().unwrap();
        remote.lookup_down = false;
        remote.search_incomplete = true;
    }
    let review = f
        .workspace
        .review_publication_at(&f.engine, &ticket.reference, true, Some(&later()))
        .unwrap();
    assert!(
        !review
            .actions
            .iter()
            .any(|a| a.kind == ActionKind::NotCreated && a.available)
    );
    // With a complete empty search it is.
    f.fake.0.lock().unwrap().search_incomplete = false;
    let review = f
        .workspace
        .review_publication_at(&f.engine, &ticket.reference, true, Some(&later()))
        .unwrap();
    assert!(
        review
            .actions
            .iter()
            .any(|a| a.kind == ActionKind::NotCreated && a.available)
    );
}

#[test]
fn a_resolver_that_loses_a_race_to_the_same_attach_reports_a_replay() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    let path = f.path();
    let engine = f.engine.clone();
    let reference = ticket.reference.clone();
    // Another resolver attaches while this one is still verifying.
    f.fake.0.lock().unwrap().after_lookup = Some(Arc::new(move || {
        let mut other = Workspace::open(&path).unwrap();
        other
            .resolve_publication(&engine, &reference, &attach(Some("101")))
            .unwrap();
    }));
    let racing = f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();
    assert!(
        racing.replayed,
        "same issue, already attached by the winner"
    );
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
    assert_eq!(
        f.ticket(&ticket.reference).source.unwrap().display,
        "o/r#101"
    );
}

#[test]
fn a_not_created_verdict_that_loses_to_an_attach_does_not_discard_the_issue() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    // The search sees nothing (the issue is hidden), then another resolver finds and
    // attaches it before this verdict is saved.
    let hidden = f.fake.0.lock().unwrap().issues.remove(&101).unwrap();
    let path = f.path();
    let engine = f.engine.clone();
    let reference = ticket.reference.clone();
    let fake = f.fake.clone();
    f.fake.0.lock().unwrap().after_lookup = Some(Arc::new(move || {
        fake.0.lock().unwrap().issues.insert(101, hidden.clone());
        let mut other = Workspace::open(&path).unwrap();
        other
            .resolve_publication(&engine, &reference, &attach(Some("101")))
            .unwrap();
    }));

    let error = publication_error(f.resolve(&ticket.reference, &not_created()).unwrap_err());
    assert!(matches!(error, PublicationError::Settled { .. }), "{error}");
    assert_eq!(
        f.ticket(&ticket.reference).source.unwrap().display,
        "o/r#101"
    );
    assert_eq!(
        f.workspace.publication_attempts(&ticket.reference).unwrap()[0].state,
        AttemptState::Succeeded
    );
}

#[test]
fn a_running_attempt_is_not_resolvable_and_a_clean_ticket_has_nothing_to_resolve() {
    let mut f = Fixture::new();
    let live = describe(&mut f, "Live", "Body");
    f.mode(Mode::Crash);
    let engine = f.engine.clone();
    let mut o = options();
    o.now = Some("2999-01-01T00:00:00Z".into());
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let _ = f.workspace.publish_ticket(&engine, &live.reference, &o);
    }));
    f.mode(Mode::Create);
    let mut f = f.reopen();
    assert!(matches!(
        publication_error(
            f.resolve(&live.reference, &attach(Some("101")))
                .unwrap_err()
        ),
        PublicationError::StillRunning { .. }
    ));
    let clean = describe(&mut f, "Clean", "Body");
    assert!(matches!(
        publication_error(
            f.resolve(&clean.reference, &attach(Some("101")))
                .unwrap_err()
        ),
        PublicationError::NothingToResolve { .. }
    ));
}

#[test]
fn the_review_states_what_is_known_and_unknown_and_which_actions_are_safe() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");

    let review = f
        .workspace
        .review_publication_at(&f.engine, &ticket.reference, true, Some(&later()))
        .unwrap();
    assert_eq!(review.attempt.state, AttemptState::Unresolved);
    assert!(review.known.iter().any(|line| line.contains("o/r")));
    assert!(review.unknown.contains("whether"));
    assert_eq!(review.candidates.len(), 1);
    assert_eq!(review.candidates_complete, Some(true));
    let kinds: Vec<_> = review
        .actions
        .iter()
        .map(|a| (a.kind, a.available))
        .collect();
    assert_eq!(
        kinds,
        vec![(ActionKind::Attach, true), (ActionKind::NotCreated, false)]
    );

    // A failed search is reported, not mistaken for an empty one.
    f.fake.0.lock().unwrap().lookup_down = true;
    let down = f
        .workspace
        .review_publication_at(&f.engine, &ticket.reference, true, Some(&later()))
        .unwrap();
    assert!(down.candidates.is_empty());
    assert_eq!(down.candidates_complete, None);
    assert_eq!(down.lookup_failure.unwrap().code, "unavailable");
}

#[test]
fn resolution_outcomes_survive_export_backup_and_restore() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();
    let exported = f.workspace.export().unwrap();
    assert_eq!(exported["publication_attempts"][0]["status"], "succeeded");

    let backup = f.dir.path().join("backup.sqlite3");
    f.workspace.backup(&backup).unwrap();
    let path = f.path();
    let Fixture { workspace, .. } = f;
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    let restored = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(restored.source.unwrap().display, "o/r#101");
}

// ---- Live-test fixes (#98): attach safety, blocking rules, listing lag ----

/// An issue the same account created in the window that is not this ticket's.
fn unrelated_issue(f: &Fixture, id: u64, title: &str, body: &str) -> ExternalIssue {
    let mut issue = f.fake.0.lock().unwrap().issues[&101].clone();
    issue.reference.identity.id = id.to_string();
    issue.reference.locator = format!("o/r#{id}");
    issue.display = format!("o/r#{id}");
    issue.title = title.into();
    issue.body = body.into();
    issue
}

#[test]
fn attaching_an_issue_with_other_text_needs_confirmation_and_keeps_the_local_text() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    let other = unrelated_issue(&f, 22, "Unrelated probe", "Unrelated text");
    f.fake.0.lock().unwrap().issues.insert(22, other);
    f.fake.0.lock().unwrap().issues.remove(&101);

    // Refused, and nothing about the attempt or the ticket changes.
    let error = publication_error(
        f.resolve(&ticket.reference, &attach(Some("22")))
            .unwrap_err(),
    );
    let PublicationError::DifferentContent(difference) = error else {
        panic!("expected a content difference");
    };
    assert_eq!(difference.issue.display, "o/r#22");
    assert!(difference.title_differs && difference.body_differs);
    f.still_unresolved(&ticket.reference);
    assert_eq!(f.ticket(&ticket.reference).title, "Escalate");

    // Confirmed: the issue's text applies and the ticket's own is kept as a note.
    f.resolve(&ticket.reference, &accept_different("22"))
        .unwrap();
    let after = f.ticket(&ticket.reference);
    assert_eq!(after.title, "Unrelated probe");
    assert_eq!(after.body, "Unrelated text");
    let notes = f.workspace.activities(&ticket.reference, 10, 0).unwrap();
    assert!(
        notes
            .iter()
            .any(|n| n.brief.contains("Title: Escalate") && n.brief.contains("Body")),
        "{notes:?}"
    );
    // A refresh finds nothing further to lose.
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(f.ticket(&ticket.reference).title, "Unrelated probe");
}

#[test]
fn attaching_the_issue_that_holds_the_sent_text_needs_no_confirmation() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    f.resolve(&ticket.reference, &attach(Some("101"))).unwrap();
    assert_eq!(f.ticket(&ticket.reference).title, "Escalate");
}

#[test]
fn an_edited_issue_may_be_the_attempt_and_blocks_not_created() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Initially published");
    {
        let mut source = f.fake.0.lock().unwrap();
        let edited = source.issues.get_mut(&101).unwrap();
        edited.title = "Edited title".into();
        edited.body = "Edited body".into();
    }

    let review = f
        .workspace
        .review_publication_at(&f.engine, &ticket.reference, true, Some(&later()))
        .unwrap();
    assert!(review.candidates.is_empty());
    assert_eq!(review.other_recent.len(), 1);
    assert_eq!(review.other_recent[0].title, "Edited title");
    assert!(
        review
            .actions
            .iter()
            .any(|a| a.kind == ActionKind::NotCreated && !a.available)
    );
    let error = publication_error(f.resolve(&ticket.reference, &not_created()).unwrap_err());
    assert!(matches!(error, PublicationError::Candidates { .. }));
    assert_eq!(f.created(), 1);
}

#[test]
fn an_uncertain_reply_preserves_the_dispatch_lease() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    let attempt = f.ticket(&ticket.reference).publication.unwrap();
    let review = f
        .workspace
        .review_publication(&f.engine, &ticket.reference, false)
        .unwrap();
    let started = chrono::DateTime::parse_from_rfc3339(&attempt.started_at).unwrap();
    let ready = chrono::DateTime::parse_from_rfc3339(&review.search_ready_at.unwrap()).unwrap();
    assert!(ready - started >= chrono::Duration::minutes(6));
}

#[test]
fn an_unresolved_publication_does_not_hide_discovery_in_another_destination() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    let mut unrelated = unrelated_issue(&f, 42, "Escalate", "Different body");
    unrelated.reference.partition = "o/other".into();
    unrelated.reference.locator = "o/other#42".into();
    unrelated.display = "o/other#42".into();
    unrelated.created_at = chrono::Utc::now().to_rfc3339();
    {
        let mut remote = f.fake.0.lock().unwrap();
        remote.matching.push(42);
        remote.issues.insert(42, unrelated);
    }
    f.workspace
        .save_source(
            &f.engine,
            "fake",
            &values(json!({"repositories": ["o/r", "o/other"]})),
        )
        .unwrap();
    let report = f
        .workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    assert_eq!(report.imported.len(), 1, "{report:?}");
    let imported = f.ticket(&report.imported[0]);
    assert_eq!(imported.source.unwrap().display, "o/other#42");
    f.still_unresolved(&ticket.reference);
}

#[test]
fn a_refused_attach_of_an_issue_owned_elsewhere_leaves_the_attempt_untouched() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    // Another ticket published its own issue (#102) and owns it.
    let other = describe(&mut f, "Other ticket", "Other body");
    f.publish(&other.reference).unwrap();
    assert_eq!(f.ticket(&other.reference).source.unwrap().id, "102");

    let error = publication_error(
        f.resolve(&ticket.reference, &accept_different("102"))
            .unwrap_err(),
    );
    assert!(
        matches!(error, PublicationError::Mismatch { .. }),
        "{error}"
    );
    assert!(error.to_string().contains("published"), "{error}");
    let attempt = f.ticket(&ticket.reference).publication.unwrap();
    assert!(attempt.issue.is_none(), "no issue may be recorded");
    assert_ne!(
        attempt.failure.map(|x| x.code),
        Some("identity_conflict".into())
    );
    let review = f
        .workspace
        .review_publication_at(&f.engine, &ticket.reference, false, Some(&later()))
        .unwrap();
    assert!(
        review
            .actions
            .iter()
            .any(|a| a.kind == ActionKind::Attach && a.available)
    );
}

#[test]
fn nothing_created_is_not_concluded_before_a_just_created_issue_could_be_listed() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Never landed");
    f.fake.0.lock().unwrap().issues.clear();

    // A search that begins too soon is refused before it can obtain a listing.
    f.fake.0.lock().unwrap().after_lookup = Some(Arc::new(|| {
        panic!("looked up issues before the listing delay ended")
    }));
    let mut early = not_created();
    early.now = None;
    let error = publication_error(f.resolve(&ticket.reference, &early).unwrap_err());
    f.fake.0.lock().unwrap().after_lookup = None;
    assert!(
        matches!(error, PublicationError::Unverified { .. }),
        "{error}"
    );
    assert!(error.to_string().contains("look again"), "{error}");
    f.still_unresolved(&ticket.reference);
    let review = f
        .workspace
        .review_publication(&f.engine, &ticket.reference, true)
        .unwrap();
    assert!(review.search_ready_at.is_some());
    assert!(
        !review
            .actions
            .iter()
            .any(|a| a.kind == ActionKind::NotCreated && a.available)
    );

    f.resolve(&ticket.reference, &not_created()).unwrap();
}

#[test]
fn an_imported_ticket_says_only_local_tickets_are_published() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    // Discovery imports an issue nobody here published.
    let mut stranger = unrelated_issue(&f, 30, "Someone else's", "Their text");
    stranger.created_at = "2030-01-01T00:00:00Z".into();
    {
        let mut remote = f.fake.0.lock().unwrap();
        remote.issues.insert(30, stranger);
        remote.matching.push(30);
        remote.issues.remove(&101);
    }
    f.workspace
        .refresh_sources(&f.engine, &RefreshOptions::default())
        .unwrap();
    let imported = f
        .workspace
        .list_tickets()
        .unwrap()
        .into_iter()
        .find(|t| t.reference != ticket.reference)
        .unwrap();

    let preview = f
        .workspace
        .preview_publication(&f.engine, &imported.reference, "fake", None)
        .unwrap();
    let Eligibility::Ineligible { reason, message } = preview.eligibility else {
        panic!("an imported ticket is not publishable");
    };
    assert_eq!(reason, IneligibleReason::ExternallyOwned);
    assert!(message.contains("imported from o/r#30"), "{message}");
    assert!(
        message.contains("only local tickets are published"),
        "{message}"
    );
}

#[test]
fn an_unresolved_publication_never_advises_retrying_later() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    let attempt = f.ticket(&ticket.reference).publication.unwrap();
    let failure = attempt.failure.unwrap();
    assert!(
        failure.message.contains("status 502"),
        "{}",
        failure.message
    );
    assert!(
        !failure.message.contains("retry later"),
        "{}",
        failure.message
    );
}

#[test]
fn an_issue_in_another_repository_is_a_plain_mistake_not_an_internal_error() {
    let mut f = Fixture::new();
    let ticket = f.lost_response("Escalate");
    let error = publication_error(
        f.resolve(&ticket.reference, &attach(Some("elsewhere/repo#101")))
            .unwrap_err(),
    );
    assert!(
        matches!(error, PublicationError::Mismatch { .. }),
        "{error}"
    );
    let text = error.to_string();
    assert!(text.contains("the issue is not in o/r"), "{text}");
    assert!(!text.contains("invalid source configuration"), "{text}");
    assert!(!text.contains("could not be verified"), "{text}");
}
