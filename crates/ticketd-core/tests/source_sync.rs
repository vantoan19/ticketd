//! Importing and refreshing externally owned tickets through the workspace
//! workflow boundary, with a controllable fake connector and no transport.
// Clippy exempts #[test] functions but not the fake connector and fixture helpers they
// share; those unwrap so a broken setup fails the test loudly.
#![allow(clippy::unwrap_used)]

#[path = "support/fake_source.rs"]
mod fake_source;

use std::sync::{Arc, Condvar, Mutex, mpsc};

use serde_json::json;
use ticketd_core::{
    self, ContextOptions, Error, ProjectRemoteChange, Status, Ticket, TicketChange, TicketFilter,
    TicketPatch, Workspace,
    source::{
        ConnectSourceAction, Conversation, ConversationEntry, DuplicateTarget, Engine,
        ExternalComment, ExternalEvent, ExternalEventKind, ExternalIdentity, ExternalIssue,
        ExternalRef, ExternalState, FailureScope, IssueName, Ownership, RefreshOptions,
        RefreshReport, SourceFilter, SourceHealth, StateCategory, TargetProblem,
    },
};

use fake_source::{Failure, FakeSource, Remote, issue, issue_in};
fn reported_issue(host: &str, repository: &str, id: u64, title: &str) -> ExternalIssue {
    let mut issue = issue_in(repository, id, title);
    issue.url = format!("https://{host}/{repository}/issues/{id}");
    issue.repository = Some(format!("{host}/{repository}"));
    issue
}

struct Fixture {
    fake: FakeSource,
    engine: Engine,
    workspace: Workspace,
    dir: tempfile::TempDir,
}

#[test]
fn saved_discovery_repositories_report_their_routed_project_on_the_source_host() {
    let mut f = Fixture::new();
    let config = json!({"repositories": ["o/r", "other/repo"]});
    f.workspace
        .save_source(&f.engine, "fake", config.as_object().unwrap())
        .unwrap();
    let matching = f
        .workspace
        .create_project_with_remote(
            "Matching checkout",
            f.dir.path().to_str().unwrap(),
            Some("example.test/O/R"),
        )
        .unwrap();
    let other_checkout = tempfile::tempdir().unwrap();
    f.workspace
        .create_project_with_remote(
            "Different host",
            other_checkout.path().to_str().unwrap(),
            Some("github.com/other/repo"),
        )
        .unwrap();
    f.remote(|remote| remote.outage = Some(Failure::Unavailable));

    let routes = f
        .workspace
        .source_repository_routes(&f.engine, "fake")
        .unwrap();
    assert_eq!(routes.len(), 2);
    assert_eq!(routes[0].repository, "o/r");
    assert_eq!(
        routes[0].project_remote.as_deref(),
        Some("example.test/o/r")
    );
    let project = routes[0].project.as_ref().unwrap();
    assert_eq!(project.id, matching.id);
    assert_eq!(project.name, "Matching checkout");
    assert_eq!(routes[1].repository, "other/repo");
    assert!(routes[1].project.is_none());
}

#[test]
fn routing_from_settings_requires_a_checkout_and_a_still_saved_repository() {
    let mut f = Fixture::new();
    let path = f.dir.path().to_str().unwrap();
    let project = f.workspace.create_project("No checkout", path).unwrap();
    f.workspace.remove_checkout(&project.id, path).unwrap();
    let refused = f
        .workspace
        .link_source_repository_project(&f.engine, "fake", "o/r", &project.id)
        .unwrap_err();
    assert!(refused.to_string().contains("Register a checkout"));
    assert!(
        f.workspace
            .show_project(&project.id)
            .unwrap()
            .remote
            .is_none()
    );

    let config = json!({"repositories": ["other/repo"]});
    f.workspace
        .save_source(&f.engine, "fake", config.as_object().unwrap())
        .unwrap();
    assert!(matches!(
        f.workspace.create_source_repository_project(&f.engine, "fake", "o/r", "Stale", path),
        Err(Error::SourceRepositoryNotListed(repository)) if repository == "o/r"
    ));
    assert_eq!(f.workspace.list_projects().unwrap().len(), 1);

    let created = f
        .workspace
        .create_source_repository_project(&f.engine, "fake", "other/repo", "Current", path)
        .unwrap();
    assert_eq!(created.remote.as_deref(), Some("example.test/other/repo"));
    let canonical = std::fs::canonicalize(path).unwrap();
    assert_eq!(created.paths, [canonical.to_str().unwrap()]);
}

#[test]
fn linking_a_saved_repository_sets_only_an_unclaimed_projects_remote() {
    let mut f = Fixture::new();
    let path = f.dir.path().to_str().unwrap();
    let project = f.workspace.create_project("Before rename", path).unwrap();
    let checkout = tempfile::tempdir().unwrap();
    let renamed = f
        .workspace
        .edit_project(
            &project.id,
            "After rename",
            checkout.path().to_str().unwrap(),
        )
        .unwrap();

    let linked = f
        .workspace
        .link_source_repository_project(&f.engine, "fake", "o/r", &project.id)
        .unwrap();
    assert_eq!(linked.remote.as_deref(), Some("example.test/o/r"));
    assert_eq!(linked.name, renamed.name);
    assert_eq!(linked.paths, renamed.paths);
    assert_eq!(
        f.workspace
            .preview_connect_source(&f.engine, "fake", &project.id)
            .unwrap()
            .source,
        ConnectSourceAction::AlreadyListed
    );

    let config = json!({"repositories": ["other/repo"]});
    f.workspace
        .save_source(&f.engine, "fake", config.as_object().unwrap())
        .unwrap();
    assert_eq!(f.workspace.show_project(&project.id).unwrap(), linked);
    assert!(
        f.workspace
            .source_repository_routes(&f.engine, "fake")
            .unwrap()[0]
            .project
            .is_none()
    );
    assert!(matches!(
        f.workspace
            .link_source_repository_project(&f.engine, "fake", "other/repo", &project.id),
        Err(Error::ProjectAlreadyHasRemote(name)) if name == "After rename"
    ));
    assert_eq!(f.workspace.show_project(&project.id).unwrap(), linked);

    let unclaimed = f
        .workspace
        .create_project("Unclaimed checkout", path)
        .unwrap();
    assert!(matches!(
        f.workspace
            .link_source_repository_project(&f.engine, "fake", "o/r", &unclaimed.id),
        Err(Error::SourceRepositoryNotListed(repo)) if repo == "o/r"
    ));
    assert_eq!(f.workspace.show_project(&unclaimed.id).unwrap(), unclaimed);
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
        self.workspace
            .show_ticket(&format!("T-KQ{number}"))
            .unwrap()
    }

    fn set_state(&self, id: u64, state: ExternalState) {
        self.remote(|remote| remote.issues.get_mut(&id).unwrap().state = state);
    }
}

fn closed(reason: StateCategory) -> ExternalState {
    ExternalState::named(reason, "Closed")
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
fn connecting_an_already_listed_repository_links_only_eligible_tickets_offline() {
    let mut f = Fixture::new();
    for (id, host) in [
        (1, "example.test"),
        (2, "example.test"),
        (3, "example.test"),
        (4, "other.test"),
        (5, "example.test"),
    ] {
        f.publish(reported_issue(host, "o/r", id, "Imported issue"), true);
    }
    assert_eq!(f.refresh().imported.len(), 5);
    let other_checkout = tempfile::tempdir().unwrap();
    let other = f
        .workspace
        .create_project("Other", other_checkout.path().to_str().unwrap())
        .unwrap();
    f.workspace
        .change_ticket(
            "T-KQ2",
            TicketPatch {
                project_id: Some(Some(other.id.clone())),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    f.workspace.set_trashed("T-KQ3", true, None).unwrap();
    f.set_state(1, closed(StateCategory::Completed));
    f.refresh();
    f.remote(|remote| remote.outage = Some(Failure::Unavailable));
    f.refresh();
    f.workspace.take_ownership("T-KQ5", None).unwrap();
    let project = f
        .workspace
        .create_project_with_remote(
            "Matching",
            f.dir.path().to_str().unwrap(),
            Some("example.test/O/R"),
        )
        .unwrap();
    let network_calls = {
        let remote = f.fake.0.lock().unwrap();
        (remote.connection_calls, remote.discover_calls)
    };
    let saved = f.workspace.saved_source("fake").unwrap();

    let preview = f
        .workspace
        .preview_connect_source(&f.engine, "fake", &project.id)
        .unwrap();
    assert_eq!(preview.source, ConnectSourceAction::AlreadyListed);
    assert_eq!(preview.tickets, ["T-KQ1"]);
    assert_eq!(f.ticket(1).project_id, None);
    let outcome = f
        .workspace
        .connect_source(&f.engine, "fake", &project.id, &preview.fingerprint)
        .unwrap();
    assert!(!outcome.repository_added);
    assert_eq!(outcome.linked_tickets, ["T-KQ1"]);
    assert_eq!(f.ticket(1).project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(f.ticket(1).status, Status::Done);
    assert!(
        f.workspace
            .ticket_history("T-KQ1")
            .unwrap()
            .iter()
            .any(|entry| {
                entry.kind == "project"
                    && entry.from_value.is_empty()
                    && entry.to_value == project.id
            })
    );
    assert_eq!(f.ticket(2).project_id, Some(other.id));
    for number in [3, 4, 5] {
        assert_eq!(f.ticket(number).project_id, None);
    }
    assert_eq!(f.workspace.saved_source("fake").unwrap(), saved);
    let remote = f.fake.0.lock().unwrap();
    assert_eq!(
        (remote.connection_calls, remote.discover_calls),
        network_calls
    );
}

#[test]
fn backfill_keeps_a_known_repository_until_the_external_location_changes() {
    let mut f = Fixture::new();
    let mut found = reported_issue("example.test", "o/r", 1, "Original issue");
    f.publish(found.clone(), true);
    f.refresh();
    let project = f
        .workspace
        .create_project_with_remote(
            "Original repository",
            f.dir.path().to_str().unwrap(),
            Some("example.test/o/r"),
        )
        .unwrap();

    found.repository = None;
    found.title = "Still at the original repository".into();
    f.publish(found.clone(), true);
    f.refresh();
    let preview = f
        .workspace
        .preview_connect_source(&f.engine, "fake", &project.id)
        .unwrap();
    assert_eq!(preview.tickets, ["T-KQ1"]);

    found.reference.locator = "o/moved#1".into();
    found.url = "https://example.test/o/moved/issues/1".into();
    f.publish(found, true);
    f.refresh();
    let preview = f
        .workspace
        .preview_connect_source(&f.engine, "fake", &project.id)
        .unwrap();
    assert!(preview.tickets.is_empty());
}

#[test]
fn live_connection_count_uses_only_the_target_repository_and_keeps_the_filters() {
    let mut f = Fixture::new();
    let mut matching = reported_issue("example.test", "o/target", 1, "Matches both filters");
    matching.labels = vec!["selected".into()];
    matching.assignees = vec!["octo".into()];
    let mut wrong_label = matching.clone();
    wrong_label.reference.identity.id = "2".into();
    wrong_label.labels.clear();
    let mut wrong_assignee = matching.clone();
    wrong_assignee.reference.identity.id = "3".into();
    wrong_assignee.assignees.clear();
    for issue in [matching, wrong_label, wrong_assignee] {
        f.publish(issue, false);
    }
    f.remote(|remote| {
        remote.filter_by_assignee = true;
        remote.matching_by_repository.insert("o/r".into(), vec![]);
        remote
            .matching_by_repository
            .insert("o/target".into(), vec![1, 2, 3]);
    });
    let config = json!({"repositories": ["o/r"], "labels": ["selected"], "assignee": "octo"});
    f.workspace
        .save_source(&f.engine, "fake", config.as_object().unwrap())
        .unwrap();
    let project = f
        .workspace
        .create_project_with_remote(
            "Target",
            f.dir.path().to_str().unwrap(),
            Some("example.test/o/target"),
        )
        .unwrap();
    let preview = f
        .workspace
        .preview_connect_source(&f.engine, "fake", &project.id)
        .unwrap();
    assert_eq!(preview.source, ConnectSourceAction::AddRepository);
    let count = f
        .workspace
        .connect_source_match_count(&f.engine, "fake", &project.id, &preview.fingerprint)
        .unwrap()
        .unwrap();
    assert_eq!(count.matched, 1);
    assert!(count.complete);
    assert_eq!(
        f.workspace
            .preview_connect_source(&f.engine, "fake", &project.id)
            .unwrap(),
        preview
    );
    assert!(f.workspace.list_tickets().unwrap().is_empty());
}

#[test]
fn connection_review_tracks_discovery_rules_only_when_it_would_change_them() {
    let mut f = Fixture::new();
    let project = f
        .workspace
        .create_project_with_remote(
            "Target",
            f.dir.path().to_str().unwrap(),
            Some("example.test/o/target"),
        )
        .unwrap();
    let preview = |workspace: &Workspace| {
        workspace
            .preview_connect_source(&f.engine, "fake", &project.id)
            .unwrap()
    };
    let initial = preview(&f.workspace);
    let unchanged = json!({"repositories": ["o/r"]});
    f.workspace
        .save_source(&f.engine, "fake", unchanged.as_object().unwrap())
        .unwrap();
    assert_eq!(preview(&f.workspace), initial);
    let filtered = json!({"repositories": ["o/r"], "labels": ["bug"]});
    f.workspace
        .save_source(&f.engine, "fake", filtered.as_object().unwrap())
        .unwrap();
    assert_ne!(preview(&f.workspace).fingerprint, initial.fingerprint);

    let listed = json!({"repositories": ["o/r", "o/target"]});
    f.workspace
        .save_source(&f.engine, "fake", listed.as_object().unwrap())
        .unwrap();
    let backfill = preview(&f.workspace);
    assert_eq!(backfill.source, ConnectSourceAction::AlreadyListed);
    let listed_with_filter = json!({"repositories": ["o/target"], "labels": ["bug"]});
    f.workspace
        .save_source(&f.engine, "fake", listed_with_filter.as_object().unwrap())
        .unwrap();
    assert_eq!(preview(&f.workspace), backfill);
}

#[test]
fn connecting_rechecks_the_exact_ticket_set_after_remote_validation() {
    let mut f = Fixture::new();
    for id in [1, 2] {
        f.publish(
            reported_issue("example.test", "o/r", id, "Imported issue"),
            true,
        );
    }
    assert_eq!(f.refresh().imported, ["T-KQ1", "T-KQ2"]);
    let alternate = tempfile::tempdir().unwrap();
    let other = f
        .workspace
        .create_project("Other", alternate.path().to_str().unwrap())
        .unwrap();
    f.workspace
        .change_ticket(
            "T-KQ2",
            TicketPatch {
                project_id: Some(Some(other.id)),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    let mut other_issue = reported_issue("example.test", "o/other", 3, "Kept in discovery");
    other_issue.labels = vec!["selected".into()];
    f.publish(other_issue, false);
    f.remote(|remote| {
        remote
            .matching_by_repository
            .insert("o/other".into(), vec![3]);
    });
    let config = json!({"repositories": ["o/other"], "labels": ["selected"]});
    let saved = f
        .workspace
        .save_source(&f.engine, "fake", config.as_object().unwrap())
        .unwrap()
        .source;
    assert_eq!(f.refresh().imported, ["T-KQ3"]);
    assert_eq!(f.ticket(3).source.unwrap().discovery_matches, Some(true));
    let project = f
        .workspace
        .create_project_with_remote(
            "Matching",
            f.dir.path().to_str().unwrap(),
            Some("example.test/o/r"),
        )
        .unwrap();
    let preview = f
        .workspace
        .preview_connect_source(&f.engine, "fake", &project.id)
        .unwrap();
    assert_eq!(preview.source, ConnectSourceAction::AddRepository);
    assert_eq!(preview.tickets, ["T-KQ1"]);

    let (entered_tx, entered_rx) = mpsc::sync_channel(0);
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    f.remote(|remote| {
        let release = release.clone();
        remote.before_discovery = Some(Arc::new(move || {
            entered_tx.send(()).unwrap();
            let (released, changed) = &*release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = changed.wait(released).unwrap();
            }
        }));
    });
    let id = project.id.clone();
    let expected = preview.fingerprint.clone();
    let path = f.path();
    let fake = f.fake.clone();
    let connecting = std::thread::spawn(move || {
        let mut engine = Engine::new();
        engine.register(Box::new(fake)).unwrap();
        let mut workspace = Workspace::open(path).unwrap();
        workspace.connect_source(&engine, "fake", &id, &expected)
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    let trash = f.workspace.set_trashed("T-KQ1", true, None);
    let unlink = f.workspace.change_ticket(
        "T-KQ2",
        TicketPatch {
            project_id: Some(None),
            ..TicketPatch::default()
        },
    );
    {
        let (released, changed) = &*release;
        *released.lock().unwrap() = true;
        changed.notify_all();
    }
    trash.unwrap();
    unlink.unwrap();
    assert!(matches!(
        connecting.join().unwrap(),
        Err(Error::ConnectSourceChanged)
    ));
    assert_eq!(f.workspace.saved_source("fake").unwrap(), Some(saved));
    assert_eq!(f.ticket(2).project_id, None);
    assert_eq!(f.ticket(3).source.unwrap().discovery_matches, Some(true));

    let calls = f.fake.0.lock().unwrap().connection_calls;
    assert!(matches!(
        f.workspace
            .connect_source(&f.engine, "fake", &project.id, &preview.fingerprint),
        Err(Error::ConnectSourceChanged)
    ));
    assert_eq!(f.fake.0.lock().unwrap().connection_calls, calls);
    let updated = f
        .workspace
        .preview_connect_source(&f.engine, "fake", &project.id)
        .unwrap();
    assert_eq!(updated.tickets, ["T-KQ2"]);
    let applied = f
        .workspace
        .connect_source(&f.engine, "fake", &project.id, &updated.fingerprint)
        .unwrap();
    assert!(applied.repository_added);
    assert_eq!(applied.linked_tickets, ["T-KQ2"]);
    assert_eq!(f.ticket(2).project_id, Some(project.id));
    assert_eq!(f.ticket(3).source.unwrap().discovery_matches, None);
    let config = f.workspace.saved_source("fake").unwrap().unwrap().config;
    assert_eq!(config["repositories"], json!(["o/other", "o/r"]));
    assert_eq!(config["labels"], json!(["selected"]));
}

#[test]
fn connecting_without_a_saved_source_previews_setup_and_requires_a_compatible_remote() {
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().to_str().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let mut engine = Engine::new();
    let fake = FakeSource::default();
    engine.register(Box::new(fake.clone())).unwrap();
    let project = workspace.create_project("Project", checkout).unwrap();
    assert!(matches!(
        workspace.preview_connect_source(&engine, "fake", &project.id),
        Err(Error::ProjectRemoteRequired(_))
    ));
    workspace
        .edit_project_with_remote(
            &project.id,
            "Project",
            checkout,
            ProjectRemoteChange::Set("other.test/o/r"),
        )
        .unwrap();
    assert!(matches!(
        workspace.preview_connect_source(&engine, "fake", &project.id),
        Err(Error::ProjectSourceHostMismatch { .. })
    ));
    workspace
        .edit_project_with_remote(
            &project.id,
            "Project",
            checkout,
            ProjectRemoteChange::Set("example.test/o/r"),
        )
        .unwrap();
    let preview = workspace
        .preview_connect_source(&engine, "fake", &project.id)
        .unwrap();
    assert_eq!(preview.source, ConnectSourceAction::NotConnected);
    assert_eq!(preview.repository, "o/r");
    assert_eq!(preview.project_remote, "example.test/o/r");
    assert!(preview.tickets.is_empty());
    assert!(matches!(
        workspace.connect_source(&engine, "fake", &project.id, &preview.fingerprint),
        Err(Error::ProjectSourceNotConnected { .. })
    ));
    assert_eq!(workspace.saved_source("fake").unwrap(), None);
    assert_eq!(fake.0.lock().unwrap().connection_calls, 0);
}

#[test]
fn new_imports_route_to_the_project_claiming_the_whole_repository_identity() {
    let mut f = Fixture::new();
    let project = f
        .workspace
        .create_project_with_remote(
            "Matching",
            f.dir.path().to_str().unwrap(),
            Some("example.test/O/R"),
        )
        .unwrap();
    f.publish(
        reported_issue("example.test", "o/r", 1, "Matching repository"),
        true,
    );
    f.publish(
        reported_issue("other.test", "o/r", 2, "Same name on another host"),
        true,
    );
    f.publish(issue(3, "Repository unknown"), true);

    assert_eq!(f.refresh().imported.len(), 3);
    let ticket = f.ticket(1);
    assert_eq!(ticket.project_id.as_deref(), Some(project.id.as_str()));
    let history = f.workspace.ticket_history(&ticket.reference).unwrap();
    let project_change = history
        .iter()
        .find(|entry| entry.kind == "project")
        .unwrap();
    assert_eq!(project_change.from_value, "");
    assert_eq!(project_change.to_value, project.id);
    assert_eq!(f.ticket(2).project_id, None);
    assert_eq!(f.ticket(3).project_id, None);
    let exported = f.workspace.export().unwrap();
    let identity = exported["external_identities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|identity| identity["ticket_id"] == ticket.id)
        .unwrap();
    assert_eq!(identity["repository"], "example.test/o/r");
}

#[test]
fn refresh_keeps_a_manual_project_link_after_the_issue_transfers() {
    let mut f = Fixture::new();
    let original = f
        .workspace
        .create_project_with_remote(
            "Original project",
            f.dir.path().to_str().unwrap(),
            Some("example.test/o/r"),
        )
        .unwrap();
    let target_checkout = f.dir.path().join("target");
    let manual_checkout = f.dir.path().join("manual");
    std::fs::create_dir(&target_checkout).unwrap();
    std::fs::create_dir(&manual_checkout).unwrap();
    f.workspace
        .create_project_with_remote(
            "Transfer target",
            target_checkout.to_str().unwrap(),
            Some("example.test/o/moved"),
        )
        .unwrap();
    let manual = f
        .workspace
        .create_project("My project", manual_checkout.to_str().unwrap())
        .unwrap();
    f.publish(reported_issue("example.test", "o/r", 1, "An issue"), true);
    f.refresh();
    let ticket = f.ticket(1);
    assert_eq!(ticket.project_id.as_deref(), Some(original.id.as_str()));
    f.workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                project_id: Some(Some(manual.id.clone())),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    let history = f.workspace.ticket_history(&ticket.reference).unwrap();
    let mut transferred = reported_issue("example.test", "o/moved", 1, "An issue");
    transferred.updated_at = "2026-02-03T00:00:00Z".into();
    f.publish(transferred, false);

    let refreshed = f
        .workspace
        .refresh_sources(
            &f.engine,
            &RefreshOptions {
                ticket: Some(ticket.reference.clone()),
                ..RefreshOptions::default()
            },
        )
        .unwrap();
    assert_eq!(
        refreshed.updated.as_slice(),
        std::slice::from_ref(&ticket.reference)
    );
    assert_eq!(f.ticket(1).project_id.as_deref(), Some(manual.id.as_str()));
    assert_eq!(
        f.workspace.ticket_history(&ticket.reference).unwrap(),
        history
    );
    assert_eq!(
        f.workspace.export().unwrap()["external_identities"][0]["repository"],
        "example.test/o/moved"
    );
}

#[test]
fn changing_and_clearing_project_remotes_only_affects_future_imports() {
    let mut f = Fixture::new();
    let project = f
        .workspace
        .create_project_with_remote(
            "Project",
            f.dir.path().to_str().unwrap(),
            Some("example.test/o/r"),
        )
        .unwrap();
    f.publish(
        reported_issue("example.test", "o/r", 1, "Original repository"),
        true,
    );
    f.refresh();
    let ticket = f.ticket(1);
    assert_eq!(ticket.project_id.as_deref(), Some(project.id.as_str()));
    let history = f.workspace.ticket_history(&ticket.reference).unwrap();

    f.workspace
        .edit_project_with_remote(
            &project.id,
            &project.name,
            &project.path,
            ProjectRemoteChange::Set("example.test/o/next"),
        )
        .unwrap();
    f.publish(
        reported_issue("example.test", "o/next", 2, "New repository"),
        true,
    );
    f.refresh();
    assert_eq!(f.ticket(2).project_id.as_deref(), Some(project.id.as_str()));

    f.workspace
        .edit_project_with_remote(
            &project.id,
            &project.name,
            &project.path,
            ProjectRemoteChange::Clear,
        )
        .unwrap();
    f.publish(
        reported_issue("example.test", "o/next", 3, "Repository no longer claimed"),
        true,
    );
    f.refresh();
    assert_eq!(f.ticket(3).project_id, None);
    assert_eq!(f.ticket(1).project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(f.ticket(2).project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(
        f.workspace.ticket_history(&ticket.reference).unwrap(),
        history
    );
}

#[test]
fn matching_issues_import_as_todo_with_stable_identity_across_pages_and_repeats() {
    let mut f = Fixture::new();
    f.remote(|r| r.page_size = Some(2));
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
    assert_eq!(source.author.as_deref(), Some("alice"));
    assert_eq!(source.created_at.as_deref(), Some("2026-01-01T00:00:00Z"));
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
fn a_reopened_workspace_names_issues_using_the_configured_sources_description() {
    let mut fixture = Fixture::new();
    fixture.remote(|remote| {
        remote.display_name = Some("Beacon Tracker".into());
        remote.presentation.issue_name = IssueName {
            separator: "#".into(),
            ..IssueName::default()
        };
    });
    let mut beacon = issue(42, "Beacon case");
    beacon.reference.locator = "o/r#BEACON-42".into();
    beacon.display = "BEACON-42".into();
    fixture.publish(beacon, true);
    let saved = fixture.workspace.saved_source("fake").unwrap().unwrap();
    let saved = fixture
        .workspace
        .save_source(&fixture.engine, "fake", &saved.config)
        .unwrap();
    assert_eq!(saved.preview.issues[0].label, "BEACON-42");
    let imported = fixture.refresh().imported;
    assert_eq!(imported.len(), 1);

    let reopened = Workspace::open(fixture.path()).unwrap();
    let source = reopened.show_ticket(&imported[0]).unwrap().source.unwrap();
    assert_eq!(source.provider, "fake");
    assert_eq!(source.provider_name, "Beacon Tracker");
    assert_eq!(source.place, "o/r");
    assert_eq!(source.number, "BEACON-42");
    let rows = reopened.find_ticket_rows(&TicketFilter::default()).unwrap();
    let source = rows[0].source.as_ref().unwrap();
    assert_eq!(source.provider_name, "Beacon Tracker");
    assert_eq!(source.number, "BEACON-42");
}

#[test]
fn the_issue_author_and_opening_fill_on_a_later_refresh_and_are_not_forgotten() {
    let mut f = Fixture::new();
    let mut unknown = issue(1, "Older connector");
    unknown.author = None;
    unknown.created_at = String::new();
    f.publish(unknown.clone(), true);
    f.refresh();
    let source = f.ticket(1).source.unwrap();
    assert_eq!((source.author, source.created_at), (None, None));

    f.publish(issue(1, "Older connector"), true);
    let report = f.refresh();
    // Provenance, not an edit of the ticket.
    assert_eq!(report.unchanged, 1);
    let source = f.ticket(1).source.unwrap();
    assert_eq!(source.author.as_deref(), Some("alice"));
    assert_eq!(source.created_at.as_deref(), Some("2026-01-01T00:00:00Z"));

    // A read that cannot say keeps what an earlier one said.
    f.publish(unknown, true);
    f.refresh();
    let source = f.ticket(1).source.unwrap();
    assert_eq!(source.author.as_deref(), Some("alice"));
    assert_eq!(source.created_at.as_deref(), Some("2026-01-01T00:00:00Z"));
}

#[test]
fn an_imported_title_becomes_one_bounded_line_instead_of_failing_the_import() {
    let mut f = Fixture::new();
    f.publish(issue(1, "First line\r\n\r\n  second line\nthird"), true);
    f.publish(issue(2, &"x".repeat(1500)), true);
    f.publish(issue(3, " \n "), true);
    let report = f.refresh();
    assert_eq!(report.imported.len(), 3);
    assert!(report.failures.is_empty());
    assert_eq!(f.ticket(1).title, "First line second line third");
    assert_eq!(f.ticket(2).title, "x".repeat(1000));
    // A title with nothing in it falls back to the issue's own name.
    assert_eq!(f.ticket(3).title, "o/r#3");

    // A later edit at the provider is normalized the same way.
    f.publish(issue(1, "Edited\nagain"), true);
    f.refresh_at("2026-02-02T00:00:00Z");
    assert_eq!(f.ticket(1).title, "Edited again");
}

#[test]
fn refresh_follows_external_edits_and_preserves_local_progress_and_organization() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Original"), true);
    f.refresh();
    let plan = f.workspace.create_plan("Launch").unwrap();
    f.workspace
        .change_ticket(
            "T-KQ1",
            TicketPatch {
                plan_id: Some(Some(plan.id.clone())),
                status: Some(Status::InProgress),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    f.workspace.add_tag("T-KQ1", "backend").unwrap();
    f.workspace
        .add_activity("T-KQ1", "local observation", None)
        .unwrap();
    let blocker = f.workspace.create_ticket("Prerequisite").unwrap();
    f.workspace
        .add_dependency(&blocker.reference, "T-KQ1", None)
        .unwrap();
    let child = f.workspace.create_ticket("Detail").unwrap();
    f.workspace
        .set_parent(&child.reference, Some("T-KQ1"), None)
        .unwrap();

    f.publish(issue(1, "Retitled"), true);
    let report = f.refresh();
    assert_eq!(report.updated, vec!["T-KQ1".to_owned()]);
    f.refresh();

    let ticket = f.ticket(1);
    assert_eq!(ticket.title, "Retitled");
    assert_eq!(ticket.body, "Body of Retitled");
    assert_eq!(ticket.status, Status::InProgress);
    assert_eq!(ticket.plan_id.as_deref(), Some(plan.id.as_str()));
    assert_eq!(ticket.tags, vec!["backend".to_owned()]);
    assert_eq!(ticket.prerequisites.len(), 1);
    assert_eq!(ticket.children.len(), 1);
    assert_eq!(f.workspace.activities("T-KQ1", 10, 0).unwrap().len(), 1);
    // Local progress is never sent anywhere: the fake has no write path, and the
    // remote issue is still open.
    assert_eq!(
        f.fake.0.lock().unwrap().issues[&1].state,
        ExternalState::named(StateCategory::Open, "Open")
    );
}

#[test]
fn a_source_state_rename_keeps_local_progress_and_is_captured_for_sync() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Tracked work"), true);
    f.refresh();
    let reference = &f.ticket(1).reference;
    f.workspace
        .change_ticket(reference, progress(Status::InProgress))
        .unwrap();
    for record in f.workspace.dirty_records().unwrap() {
        assert!(f.workspace.clear_dirty(&record).unwrap());
    }

    // Only the label changes. Its spelling resembles a terminal category.
    f.set_state(1, ExternalState::named(StateCategory::Open, "Completed"));
    f.refresh();

    let ticket = f.ticket(1);
    assert_eq!(ticket.status, Status::InProgress);
    assert_eq!(
        ticket.source.unwrap().state.name.as_deref(),
        Some("Completed")
    );
    assert!(
        f.workspace
            .dirty_records()
            .unwrap()
            .iter()
            .any(|record| record.id == ticket.id)
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
        .change_ticket("T-KQ4", progress(Status::InReview))
        .unwrap();
    f.set_state(1, closed(StateCategory::Completed));
    f.set_state(2, closed(StateCategory::NotPlanned));
    f.set_state(3, closed(StateCategory::Duplicate));
    f.set_state(4, closed(StateCategory::Unknown));
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
    let history = f.workspace.ticket_history("T-KQ1").unwrap();
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
    named.state = closed(StateCategory::Duplicate);
    named.duplicate_of = Some(ExternalRef {
        identity: ExternalIdentity {
            provider: "fake".into(),
            id: "99".into(),
        },
        locator: "o/r#99".into(),
        partition: "o/r".into(),
    });
    f.publish(named, true);
    f.set_state(2, closed(StateCategory::Duplicate));
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
    f.set_state(1, closed(StateCategory::Completed));
    f.set_state(2, closed(StateCategory::Duplicate));
    f.refresh();
    assert_eq!(f.ticket(1).status, Status::Done);
    assert_eq!(f.ticket(2).status, Status::Duplicate);

    f.set_state(1, ExternalState::named(StateCategory::Open, "Open"));
    f.set_state(2, ExternalState::named(StateCategory::Open, "Open"));
    f.refresh();
    assert_eq!(f.ticket(1).status, Status::Todo);
    let reopened = f.ticket(2);
    assert_eq!(reopened.status, Status::Todo);
    assert!(reopened.source.unwrap().duplicate_target.is_none());

    f.workspace
        .change_ticket("T-KQ1", progress(Status::InReview))
        .unwrap();
    f.refresh();
    f.refresh();
    assert_eq!(f.ticket(1).status, Status::InReview);
    let history = f.workspace.ticket_history("T-KQ1").unwrap();
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
    f.set_state(2, closed(StateCategory::Completed));
    f.refresh();

    assert!(matches!(
        f.workspace.change_ticket("T-KQ1", retitle("Mine")),
        Err(Error::ExternalContent { .. })
    ));
    let body = TicketPatch {
        body: Some("Mine".into()),
        ..TicketPatch::default()
    };
    assert!(matches!(
        f.workspace.change_ticket("T-KQ1", body),
        Err(Error::ExternalContent { .. })
    ));
    for status in [Status::Done, Status::Canceled] {
        assert!(matches!(
            f.workspace.change_ticket("T-KQ1", progress(status)),
            Err(Error::ExternalStatus { open: true, .. })
        ));
    }
    assert!(matches!(
        f.workspace.change_ticket("T-KQ2", progress(Status::Todo)),
        Err(Error::ExternalStatus { open: false, .. })
    ));
    let local = f.workspace.create_ticket("Canonical").unwrap();
    assert!(matches!(
        f.workspace.mark_duplicate("T-KQ1", &local.reference, None),
        Err(Error::ExternalStatus { .. })
    ));
    // Rejected through the cohesive-change path as well.
    let change = TicketChange {
        patch: retitle("Mine"),
        ..Default::default()
    };
    assert!(f.workspace.apply_ticket_change("T-KQ1", change).is_err());
    // Re-submitting unchanged text is not an edit, so a client sending the whole form works.
    let same = TicketPatch {
        title: Some("Owned".into()),
        body: Some("Body of Owned".into()),
        status: Some(Status::InProgress),
        ..TicketPatch::default()
    };
    assert_eq!(
        f.workspace.change_ticket("T-KQ1", same).unwrap().status,
        Status::InProgress
    );
    f.workspace
        .change_ticket("T-KQ1", progress(Status::InReview))
        .unwrap();
    f.workspace
        .change_ticket("T-KQ1", progress(Status::Todo))
        .unwrap();
    // Local organization stays editable on closed tickets too.
    f.workspace.add_tag("T-KQ2", "later").unwrap();
    f.workspace
        .add_activity("T-KQ2", "still mine", None)
        .unwrap();
    // A local ticket is unaffected.
    f.workspace
        .change_ticket(&local.reference, progress(Status::Done))
        .unwrap();
}

#[test]
fn replayable_status_changes_validate_current_source_authority() {
    use ticketd_core::{WriteRequest, WriteResult};
    let mut f = Fixture::new();
    f.publish(issue(1, "Owned"), true);
    f.refresh();
    let request = |status| WriteRequest::ChangeTicket {
        reference: "T-KQ1".into(),
        patch: progress(status),
    };
    let original = f
        .workspace
        .write(Some("board-progress"), request(Status::InProgress))
        .unwrap();
    assert!(
        matches!(&original, WriteResult::Ticket(ticket) if ticket.status == Status::InProgress)
    );
    f.set_state(1, closed(StateCategory::Completed));
    f.refresh();
    let current = f.ticket(1);
    let history = f.workspace.ticket_history("T-KQ1").unwrap();
    assert!(matches!(
        f.workspace
            .write(Some("board-new-change"), request(Status::Todo)),
        Err(Error::ExternalStatus { open: false, .. })
    ));
    assert_eq!(
        f.workspace
            .write(Some("board-progress"), request(Status::InProgress))
            .unwrap(),
        original
    );
    assert_eq!(f.ticket(1), current);
    assert_eq!(f.workspace.ticket_history("T-KQ1").unwrap(), history);
}

#[test]
fn tracked_issues_refresh_after_leaving_the_discovery_rules_and_closure_is_observed() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Reassigned"), true);
    f.refresh();
    // The issue stops matching the rules and then closes.
    f.remote(|r| r.matching.clear());
    let mut next = issue(1, "Reassigned, now elsewhere");
    next.state = closed(StateCategory::Completed);
    f.publish(next, false);
    let report = f.refresh();
    assert!(report.imported.is_empty());
    assert_eq!(f.fake.0.lock().unwrap().fetch_calls, vec![1]);
    let ticket = f.ticket(1);
    assert_eq!(ticket.title, "Reassigned, now elsewhere");
    assert_eq!(ticket.status, Status::Done);
    // Identity is retained: matching again later does not create a second ticket.
    f.set_state(1, ExternalState::named(StateCategory::Open, "Open"));
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
    f.remote(|r| r.outage = Some(Failure::UnavailableWith("GitHub is down".into())));

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
            .any(|x| x.reference.as_deref() == Some("T-KQ1"))
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
                ticket: Some("T-KQ1".into()),
                now: None,
            },
        )
        .unwrap();
    assert_eq!(report.updated, vec!["T-KQ1".to_owned()]);
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
            ticket: Some("T-KQ99".into()),
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
        .change_ticket("T-KQ1", progress(Status::InProgress))
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
    let mut before = f.ticket(1);
    let exported = f.workspace.export().unwrap();
    assert_eq!(exported["external_identities"][0]["external_id"], "1");
    assert_eq!(exported["external_ownership"][0]["authority"], "external");
    assert_eq!(exported["source_sync"][0]["state_category"], "open");
    assert_eq!(exported["source_sync"][0]["external_author"], "alice");
    assert_eq!(
        exported["source_sync"][0]["external_created_at"],
        "2026-01-01T00:00:00Z"
    );
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
    before.source.as_mut().unwrap().discovery_matches = None;
    assert_eq!(workspace.show_ticket("T-KQ1").unwrap(), before);
    // Rediscovery after restore reuses the ticket.
    let report = workspace
        .refresh_sources(&engine, &RefreshOptions::default())
        .unwrap();
    assert!(report.imported.is_empty());
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    drop(dir);
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
    dup.state = closed(StateCategory::Duplicate);
    dup.duplicate_of = canonical.map(|canonical| ExternalRef {
        identity: ExternalIdentity {
            provider: "fake".into(),
            id: canonical.to_string(),
        },
        locator: format!("o/r#{canonical}"),
        partition: "o/r".into(),
    });
    dup
}

fn target(ticket: &Ticket) -> DuplicateTarget {
    ticket.source.clone().unwrap().duplicate_target.unwrap()
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
        DuplicateTarget::Unknown => None,
    }
}

#[test]
fn an_external_target_resolves_to_the_ticket_discovery_later_imports_without_a_second_ticket() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Dup"), true);
    f.publish(issue(2, "Blocked by dup"), true);
    f.refresh();
    f.workspace.add_dependency("T-KQ1", "T-KQ2", None).unwrap();
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
    assert_eq!(resolved(&f.ticket(1)).as_deref(), Some("T-KQ3"));
    // Information only: no local designation, and no dependency moved or satisfied.
    let dup = f.ticket(1);
    assert!(dup.duplicate_of.is_none());
    assert_eq!(dup.status, Status::Duplicate);
    assert!(!dup.status.satisfies_dependency());
    assert!(f.ticket(3).duplicates.is_empty());
    assert_eq!(f.ticket(2).prerequisites.len(), 1);
    assert_eq!(f.ticket(2).prerequisites[0].reference, "T-KQ1");
    // The CLI/agent context carries the same target, not a local relationship.
    let context = f
        .workspace
        .ticket_context(
            "T-KQ1",
            ticketd_core::ContextOptions {
                relationships: true,
                ..Default::default()
            },
        )
        .unwrap();
    let relationships = context.relationships.unwrap();
    assert!(relationships.duplicate_of.is_none());
    assert_eq!(
        relationships.external_duplicate_of,
        Some(target(&f.ticket(1)))
    );
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
    assert_eq!(resolved(&f.ticket(1)).as_deref(), Some("T-KQ3"));
}

#[test]
fn target_identity_survives_export_backup_and_restore() {
    let mut f = Fixture::new();
    import_then_close_as_duplicates(&mut f, &[(1, Some(99))]);
    f.publish(issue(99, "Canonical"), true);
    f.refresh();
    let mut before = f.ticket(1);
    assert_eq!(resolved(&before).as_deref(), Some("T-KQ2"));
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
    before.source.as_mut().unwrap().discovery_matches = None;
    assert_eq!(workspace.show_ticket("T-KQ1").unwrap(), before);
    drop(dir);
}

fn comment(id: &str, author: &str, body: &str, at: &str) -> ExternalComment {
    ExternalComment {
        id: id.into(),
        author: author.into(),
        body: body.into(),
        url: format!("https://example.test/o/r/issues/1#comment-{id}"),
        created_at: at.into(),
        updated_at: at.into(),
    }
}

fn event(id: &str, kind: ExternalEventKind, actor: &str, at: &str) -> ExternalEvent {
    ExternalEvent {
        id: id.into(),
        kind,
        actor: Some(actor.into()),
        subject: None,
        created_at: at.into(),
    }
}

impl Fixture {
    /// Replaces an issue's conversation and moves its update time, as GitHub does
    /// whenever a comment or event is added.
    fn converse(&self, id: u64, conversation: Conversation) {
        self.remote(|remote| {
            remote.conversations.insert(id, conversation);
            remote.revision += 1;
            let revision = remote.revision;
            remote.issues.get_mut(&id).unwrap().updated_at =
                format!("2026-01-02T00:{:02}:00Z", revision);
        });
    }

    fn conversation(&self, number: u32) -> Vec<ConversationEntry> {
        self.workspace
            .source_conversation(&format!("T-KQ{number}"))
            .unwrap()
    }
}

fn labels(entries: &[ConversationEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| match entry {
            ConversationEntry::Comment { id, .. } => format!("comment {id}"),
            ConversationEntry::Event {
                id,
                event,
                state_category,
                ..
            } => {
                format!("event {id} {event} {state_category:?}")
            }
        })
        .collect()
}

#[test]
fn comments_and_events_are_persisted_chronologically_and_repeated_refresh_adds_nothing() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Talked about"), true);
    f.converse(
        1,
        Conversation {
            // Deliberately out of order and repeated: the source's paging is not trusted.
            comments: vec![
                comment("c2", "bob", "second", "2026-01-03T00:00:00Z"),
                comment("c1", "alice", "first", "2026-01-02T00:00:00Z"),
                comment("c1", "alice", "first", "2026-01-02T00:00:00Z"),
            ],
            events: vec![
                event(
                    "e2",
                    ExternalEventKind::Closed(StateCategory::Completed),
                    "bob",
                    "2026-01-03T00:00:00Z",
                ),
                event(
                    "e1",
                    ExternalEventKind::Reopened,
                    "alice",
                    "2026-01-01T12:00:00Z",
                ),
            ],
        },
    );
    let report = f.refresh();
    assert_eq!(report.imported, vec!["T-KQ1".to_owned()]);
    let entries = f.conversation(1);
    assert_eq!(
        labels(&entries),
        vec![
            "event e1 reopened Some(Open)",
            "comment c1",
            "comment c2",
            "event e2 closed Some(Completed)"
        ]
    );
    let ConversationEntry::Comment {
        author, body, url, ..
    } = &entries[1]
    else {
        panic!("expected a comment");
    };
    assert_eq!((author.as_str(), body.as_str()), ("alice", "first"));
    assert_eq!(url, "https://example.test/o/r/issues/1#comment-c1");

    let again = f.refresh();
    assert_eq!(again.unchanged, 1);
    assert_eq!(f.conversation(1), entries);
}

#[test]
fn an_edited_comment_updates_a_deleted_one_disappears_and_unchanged_issues_are_not_re_read() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Edited"), true);
    f.converse(
        1,
        Conversation {
            comments: vec![
                comment("c1", "alice", "typo", "2026-01-02T00:00:00Z"),
                comment("c2", "bob", "doomed", "2026-01-03T00:00:00Z"),
            ],
            events: vec![],
        },
    );
    f.refresh();
    f.refresh();
    assert_eq!(
        f.fake.0.lock().unwrap().conversation_calls,
        vec![1],
        "an issue unchanged since its conversation was read is not asked again"
    );

    f.converse(
        1,
        Conversation {
            comments: vec![comment("c1", "alice", "fixed", "2026-01-02T00:00:00Z")],
            events: vec![],
        },
    );
    let report = f.refresh();
    assert_eq!(report.updated, vec!["T-KQ1".to_owned()]);
    let entries = f.conversation(1);
    assert_eq!(labels(&entries), vec!["comment c1"]);
    let ConversationEntry::Comment { body, .. } = &entries[0] else {
        panic!("expected a comment");
    };
    assert_eq!(body, "fixed");
}

#[test]
fn local_notes_stay_separate_and_the_conversation_survives_failure_and_takeover() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Kept"), true);
    f.converse(
        1,
        Conversation {
            comments: vec![comment("c1", "alice", "context", "2026-01-02T00:00:00Z")],
            events: vec![],
        },
    );
    f.refresh();
    f.workspace
        .add_activity("T-KQ1", "my own thought", Some("agent-x"))
        .unwrap();
    assert_eq!(f.workspace.activities("T-KQ1", 10, 0).unwrap().len(), 1);
    assert_eq!(f.conversation(1).len(), 1);

    // The source stops answering about comments: what was retrieved stays.
    f.remote(|r| {
        r.conversation_outage = Some("down".into());
        r.issues.get_mut(&1).unwrap().updated_at = "2026-03-01T00:00:00Z".into();
    });
    let report = f.refresh();
    assert_eq!(report.failures.len(), 1);
    assert_eq!(labels(&f.conversation(1)), vec!["comment c1"]);

    // Recovery reads it again, because the failed read did not count as synchronized.
    f.remote(|r| r.conversation_outage = None);
    let calls = f.fake.0.lock().unwrap().conversation_calls.len();
    assert!(f.refresh().failures.is_empty());
    assert_eq!(f.fake.0.lock().unwrap().conversation_calls.len(), calls + 1);

    // The source goes down, the person takes ownership, and the conversation stays.
    f.remote(|r| r.outage = Some(Failure::UnavailableWith("down".into())));
    f.refresh();
    f.workspace.take_ownership("T-KQ1", None).unwrap();
    assert_eq!(labels(&f.conversation(1)), vec!["comment c1"]);
    assert_eq!(f.workspace.activities("T-KQ1", 10, 0).unwrap().len(), 1);
}

#[test]
fn local_tickets_have_no_conversation_and_unknown_tickets_are_rejected() {
    let mut f = Fixture::new();
    f.workspace.create_ticket("Plain").unwrap();
    assert!(f.conversation(1).is_empty());
    assert!(matches!(
        f.workspace.source_conversation("T-KQ99"),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn the_conversation_is_exported_and_survives_backup_and_restore() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Durable"), true);
    f.converse(
        1,
        Conversation {
            comments: vec![comment("c1", "alice", "kept", "2026-01-02T00:00:00Z")],
            events: vec![event(
                "e1",
                ExternalEventKind::Assigned,
                "alice",
                "2026-01-02T01:00:00Z",
            )],
        },
    );
    f.refresh();
    let before = f.conversation(1);
    let exported = f.workspace.export().unwrap();
    assert_eq!(exported["source_conversation"].as_array().unwrap().len(), 2);
    assert_eq!(exported["source_conversation"][0]["actor"], "alice");
    let path = f.path();
    let backup = f.dir.path().join("backup.sqlite3");
    f.workspace.backup(&backup).unwrap();
    let Fixture { workspace, dir, .. } = f;
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.source_conversation("T-KQ1").unwrap(), before);
    drop(dir);
}

#[test]
fn agent_context_carries_the_conversation_labelled_as_source_authored() {
    let mut f = Fixture::new();
    f.publish(issue(1, "For agents"), true);
    f.converse(
        1,
        Conversation {
            comments: vec![comment(
                "c1",
                "alice",
                "please do X",
                "2026-01-02T00:00:00Z",
            )],
            events: vec![],
        },
    );
    f.refresh();
    f.workspace
        .add_activity("T-KQ1", "note", Some("agent-x"))
        .unwrap();
    let context = f
        .workspace
        .ticket_context(
            "T-KQ1",
            ContextOptions {
                activities: true,
                conversation: true,
                ..ContextOptions::default()
            },
        )
        .unwrap();
    let value = serde_json::to_value(&context).unwrap();
    let item = &value["source_conversation"]["items"][0];
    assert_eq!(item["author"], "alice");
    assert_eq!(item["body"]["text"], "please do X");
    assert!(item.get("editing_agent").is_none());
    assert_eq!(
        value["activities"]["items"][0]["editing_agent"]["text"],
        "agent-x"
    );
    let without = f
        .workspace
        .ticket_context("T-KQ1", ContextOptions::default())
        .unwrap();
    assert!(
        serde_json::to_value(&without)
            .unwrap()
            .get("source_conversation")
            .is_none()
    );
}

#[test]
fn a_failed_comment_read_is_recorded_apart_and_never_makes_a_confirmed_ticket_unavailable() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Talked about"), true);
    f.refresh();
    // The issue changed upstream, so its comments are due; reading them fails.
    f.remote(|r| {
        let issue = r.issues.get_mut(&1).unwrap();
        issue.title = "Renamed upstream".into();
        issue.updated_at = "2026-02-01T00:01:00Z".into();
        r.conversation_outage = Some("comments timed out".into());
    });
    f.publish(issue(2, "New and talked about"), true);
    let report = f.refresh_at("2026-02-01T00:10:00Z");

    let ticket = f.ticket(1);
    assert_eq!(ticket.title, "Renamed upstream");
    let source = ticket.source.unwrap();
    assert_eq!(
        source.last_refreshed_at.as_deref(),
        Some("2026-02-01T00:10:00Z")
    );
    assert!(source.unavailable.is_none() && source.last_error.is_none());
    assert!(
        source
            .conversation_error
            .unwrap()
            .message
            .contains("comments timed out")
    );
    // Taking ownership is for an unreadable source, not an unreadable thread.
    assert!(f.workspace.take_ownership("T-KQ1", None).is_err());

    // The new issue was imported; its failed thread is reported, not a source failure.
    assert_eq!(report.imported, vec!["T-KQ2".to_owned()]);
    assert!(
        report
            .failures
            .iter()
            .all(|failure| failure.scope == FailureScope::Conversation)
    );
    assert!(!report.interrupted_by_source());
    let status = f.workspace.source_statuses().unwrap().remove(0);
    assert!(status.error.is_none());
    assert_eq!(status.health, SourceHealth::Synced);

    // The next run that can read the thread clears the note.
    f.remote(|r| r.conversation_outage = None);
    f.refresh_at("2026-02-01T00:20:00Z");
    assert!(f.ticket(1).source.unwrap().conversation_error.is_none());
}

#[test]
fn a_local_duplicate_never_points_at_a_ticket_the_source_closed_as_a_duplicate() {
    let mut f = Fixture::new();
    // T-KQ1 is the true original, T-KQ2 and T-KQ3 were imported open.
    f.publish(issue(1, "Original"), true);
    f.publish(
        issue(2, "Closed later as a duplicate of the original"),
        true,
    );
    f.publish(
        issue(3, "Closed later as a duplicate of something unknown"),
        true,
    );
    f.publish(issue(4, "Local-looking duplicate of T-KQ2"), true);
    f.refresh();
    // A local ticket the person already marked as a duplicate of T-KQ2 (still open).
    let local = f.workspace.create_ticket("Local duplicate").unwrap();
    f.workspace
        .mark_duplicate(&local.reference, "T-KQ2", None)
        .unwrap();
    // The source now closes T-KQ2 as a duplicate of T-KQ1, and T-KQ3 of an issue nobody imported.
    f.publish(duplicate_of(2, "Dup 2", Some(1)), true);
    f.publish(duplicate_of(3, "Dup 3", Some(99)), true);
    f.refresh();

    // (a) A new marking against T-KQ2 follows it to the real original, T-KQ1.
    let fresh = f.workspace.create_ticket("Another duplicate").unwrap();
    let marked = f
        .workspace
        .mark_duplicate(&fresh.reference, "T-KQ2", None)
        .unwrap();
    assert_eq!(marked.duplicate_of.as_deref(), Some("T-KQ1"));
    // An original that is itself a duplicate of nothing known is refused.
    let refused = f
        .workspace
        .mark_duplicate(&fresh.reference, "T-KQ3", None)
        .unwrap_err();
    assert!(
        matches!(refused, Error::DuplicateCanonicalUnresolved(_)),
        "{refused}"
    );

    // (b) The earlier local designation is flagged, never rewritten behind the
    // person's back, and moving it is one explicit marking.
    let flagged = f.workspace.show_ticket(&local.reference).unwrap();
    assert_eq!(flagged.duplicate_of.as_deref(), Some("T-KQ2"));
    assert_eq!(flagged.duplicate_redirect.as_deref(), Some("T-KQ1"));
    let moved = f
        .workspace
        .mark_duplicate(&local.reference, "T-KQ2", None)
        .unwrap();
    assert_eq!(moved.duplicate_of.as_deref(), Some("T-KQ1"));
    assert_eq!(moved.duplicate_redirect, None);
}

#[test]
fn a_closed_issue_with_an_unrecognized_reason_is_never_ready_and_allows_a_local_decision() {
    use ticketd_core::Availability;
    let mut f = Fixture::new();
    f.publish(issue(1, "Closed for a reason nobody recognizes"), true);
    f.refresh();
    assert_eq!(f.ticket(1).availability.as_deref(), Some("Ready"));
    f.set_state(1, closed(StateCategory::Unknown));
    f.refresh();

    // Flagged and held: it keeps its status but is not offered as work to pick up.
    let held = f.ticket(1);
    assert_eq!(held.status, Status::Todo);
    assert!(held.source.as_ref().unwrap().closure_unrecognized);
    assert_eq!(held.availability, None);
    let held_source = held.source.as_ref().unwrap();
    assert!(!held_source.status_locked, "a local decision is allowed");
    assert_eq!(
        held_source.status_choices,
        vec![Status::Done, Status::Canceled]
    );
    let ready = TicketFilter {
        availability: Some(Availability::Ready),
        ..TicketFilter::default()
    };
    assert!(f.workspace.find_tickets(&ready).unwrap().is_empty());
    assert_eq!(f.workspace.sidebar_counts().unwrap().ready, 0);

    // The person can decide locally; the message for anything else says so.
    let error = f
        .workspace
        .change_ticket("T-KQ1", progress(Status::InProgress))
        .unwrap_err();
    assert!(error.to_string().contains("Done or Canceled"), "{error}");
    let decided = f
        .workspace
        .change_ticket("T-KQ1", progress(Status::Canceled))
        .unwrap();
    assert_eq!(decided.status, Status::Canceled);
    // A later refresh of the unchanged closure keeps the decision and the flag.
    f.refresh();
    let after = f.ticket(1);
    assert_eq!(after.status, Status::Canceled);
    assert!(after.source.unwrap().closure_unrecognized);
}

fn history_of(f: &Fixture, reference: &str, kind: &str) -> Vec<(String, String)> {
    f.workspace
        .ticket_history(reference)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.kind == kind)
        .map(|entry| (entry.from_value, entry.to_value))
        .collect()
}

#[test]
fn an_external_canonical_is_linked_recorded_in_history_and_never_erased_without_a_trace() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Dup"), true);
    f.refresh();
    let mut named = duplicate_of(1, "Dup", Some(2));
    named.duplicate_of_url = Some("https://example.test/o/r/issues/2".into());
    f.publish(named, true);
    f.refresh();
    match target(&f.ticket(1)) {
        DuplicateTarget::External {
            url, last_known, ..
        } => {
            assert_eq!(url.as_deref(), Some("https://example.test/o/r/issues/2"));
            assert!(!last_known);
        }
        other => panic!("expected an external target, got {other:?}"),
    }
    assert_eq!(
        history_of(&f, "T-KQ1", "external_duplicate"),
        vec![("".to_owned(), "o/r#2".to_owned())]
    );

    // The source reopens the issue: the designation leaves, the history stays.
    f.publish(issue(1, "Dup"), true);
    f.refresh();
    assert!(f.ticket(1).source.unwrap().duplicate_target.is_none());
    assert_eq!(
        history_of(&f, "T-KQ1", "external_duplicate"),
        vec![
            ("".to_owned(), "o/r#2".to_owned()),
            ("o/r#2".to_owned(), "".to_owned())
        ]
    );
}

#[test]
fn a_withdrawn_target_clears_to_unknown_but_a_missing_answer_keeps_the_last_known_one() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Dup"), true);
    f.refresh();
    f.publish(duplicate_of(1, "Dup", Some(2)), true);
    f.refresh();

    // The lookup returned nothing (permissions changed): the target stays, flagged.
    f.publish(duplicate_of(1, "Dup", None), true);
    f.refresh();
    match target(&f.ticket(1)) {
        DuplicateTarget::External {
            display,
            last_known,
            ..
        } => {
            assert_eq!(display, "o/r#2");
            assert!(last_known, "no longer confirmed by the source");
        }
        other => panic!("expected the last known target, got {other:?}"),
    }

    // The source says the marking was withdrawn: the target is unknown, and says so.
    let mut withdrawn = duplicate_of(1, "Dup", None);
    withdrawn.duplicate_withdrawn = true;
    f.publish(withdrawn, true);
    f.refresh();
    assert_eq!(target(&f.ticket(1)), DuplicateTarget::Unknown);
    assert_eq!(
        history_of(&f, "T-KQ1", "external_duplicate").last(),
        Some(&("o/r#2".to_owned(), "".to_owned()))
    );
}

#[test]
fn preview_reports_existing_stable_identities_and_discovery_membership_survives_restart() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Already imported"), true);
    let imported = f.refresh().imported.remove(0);
    assert_eq!(
        f.workspace
            .show_ticket(&imported)
            .unwrap()
            .source
            .unwrap()
            .discovery_matches,
        Some(true)
    );
    f.publish(issue(2, "New match"), true);
    let config = f.workspace.saved_source("fake").unwrap().unwrap().config;
    let preview = f
        .workspace
        .preview_source(&f.engine, "fake", Some("fake"), &config)
        .unwrap();
    assert_eq!((preview.new, preview.already_here), (1, 1));
    assert_eq!(preview.issues[0].ticket.as_deref(), Some(imported.as_str()));
    assert_eq!(preview.issues[1].ticket, None);
    f.remote(|r| r.matching.retain(|id| *id != 1));
    f.refresh_at("2026-02-02T00:00:00Z");
    assert_eq!(
        f.workspace
            .show_ticket(&imported)
            .unwrap()
            .source
            .unwrap()
            .discovery_matches,
        Some(false)
    );
    let path = f.path();
    drop(f.workspace);
    let reopened = Workspace::open(path).unwrap();
    let source = reopened.show_ticket(&imported).unwrap().source.unwrap();
    assert_eq!(source.discovery_matches, Some(false));
    assert_eq!(
        source.last_refreshed_at.as_deref(),
        Some("2026-02-02T00:00:00Z")
    );
}

#[test]
fn a_format_27_import_gains_history_without_changing_its_update_time() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 27).unwrap();
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "INSERT INTO tickets (id, title, status) VALUES ('legacy-ticket', 'Already imported', 'Todo');
             INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, linked_at)
             VALUES ('legacy-ticket', 'github', '1', 'o/r#1', 'o/r#1', 'https://github.com/o/r/issues/1',
                     'imported', '2026-02-01T00:00:00Z');
             INSERT INTO external_ownership (ticket_id, authority) VALUES ('legacy-ticket', 'external');
             INSERT INTO source_sync (ticket_id, external_state, external_updated_at)
             VALUES ('legacy-ticket', 'open', '2026-02-02T00:00:00Z');",
        )
        .unwrap();
    drop(legacy);
    let migrated = Workspace::open(path).unwrap();
    let imported = migrated.list_tickets().unwrap().remove(0);
    assert_eq!(imported.updated_at.as_deref(), Some("2026-02-02T00:00:00Z"));
    assert_eq!(
        migrated
            .ticket_history(&imported.reference)
            .unwrap()
            .iter()
            .filter(|entry| entry.kind == "source_import")
            .count(),
        1
    );
}

#[test]
fn an_in_flight_refresh_does_not_apply_discovery_from_a_replaced_configuration() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Tracked in A"), false);
    f.publish(issue(2, "Only in A"), false);
    f.publish(issue(3, "Only in B"), false);
    f.remote(|remote| {
        remote.matching_by_repository.insert("o/a".into(), vec![1]);
        remote.matching_by_repository.insert("o/b".into(), vec![3]);
    });
    let config_a = json!({"repositories": ["o/a"]});
    f.workspace
        .save_source(&f.engine, "fake", config_a.as_object().unwrap())
        .unwrap();
    assert_eq!(f.refresh().imported, ["T-KQ1"]);
    f.remote(|remote| {
        remote
            .matching_by_repository
            .insert("o/a".into(), vec![1, 2]);
    });

    let (entered_tx, entered_rx) = mpsc::sync_channel(0);
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    f.remote(|remote| {
        let release = release.clone();
        remote.after_discovery = Some(Arc::new(move || {
            entered_tx.send(()).unwrap();
            let (released, changed) = &*release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = changed.wait(released).unwrap();
            }
        }));
    });
    let path = f.path();
    let fake = f.fake.clone();
    let refresh = std::thread::spawn(move || {
        let mut engine = Engine::new();
        engine.register(Box::new(fake)).unwrap();
        let mut workspace = Workspace::open(path).unwrap();
        workspace
            .refresh_sources(
                &engine,
                &RefreshOptions {
                    ticket: None,
                    now: Some("2026-02-02T00:00:00Z".into()),
                },
            )
            .unwrap()
    });
    entered_rx.recv().unwrap();

    let config_b = json!({"repositories": ["o/b"]});
    let mut second_workspace = Workspace::open(f.path()).unwrap();
    second_workspace
        .save_source(&f.engine, "fake", config_b.as_object().unwrap())
        .unwrap();
    drop(second_workspace);
    {
        let (released, changed) = &*release;
        *released.lock().unwrap() = true;
        changed.notify_all();
    }

    let stale_report = refresh.join().unwrap();
    let stale_membership = f.ticket(1).source.as_ref().unwrap().discovery_matches;
    let stale_status = f.workspace.source_statuses().unwrap();
    assert_eq!(
        stale_membership, None,
        "membership must be unknown until a complete refresh under config B; stale run={stale_report:?}; source status={stale_status:?}"
    );
    assert!(
        stale_report.imported.is_empty(),
        "the in-flight run used config A after config B was saved: {stale_report:?}"
    );
    assert_eq!(f.workspace.list_tickets().unwrap().len(), 1);
    assert_eq!(
        stale_status[0].last_refreshed_at.as_deref(),
        Some("2026-02-01T00:00:00Z"),
        "the rejected A discovery must not advance accepted provider health"
    );
    assert_eq!(stale_status[0].last_checked_tickets, Some(1));

    f.publish(issue(1, "Still syncing outside B"), false);
    let b_report = f.refresh_at("2026-02-03T00:00:00Z");
    assert_eq!(b_report.imported, ["T-KQ2"]);
    assert_eq!(f.ticket(2).title, "Only in B");
    assert_eq!(f.ticket(1).title, "Still syncing outside B");
    assert_eq!(
        f.workspace.source_statuses().unwrap()[0].last_checked_tickets,
        Some(2)
    );
    assert_eq!(
        f.ticket(1).source.as_ref().unwrap().discovery_matches,
        Some(false)
    );
}

#[test]
fn only_the_latest_closure_borrows_the_current_issues_reason() {
    let mut f = Fixture::new();
    let mut closed = issue(1, "Closed with a reason");
    closed.state = ExternalState::named(StateCategory::Completed, "Closed");
    f.publish(closed, true);
    f.remote(|remote| {
        remote.conversations.insert(
            1,
            Conversation {
                comments: Vec::new(),
                events: vec![
                    event(
                        "old",
                        ExternalEventKind::Closed(StateCategory::Unknown),
                        "octo",
                        "2026-01-01T00:00:00Z",
                    ),
                    event(
                        "reopen",
                        ExternalEventKind::Reopened,
                        "octo",
                        "2026-01-02T00:00:00Z",
                    ),
                    event(
                        "latest",
                        ExternalEventKind::Closed(StateCategory::Unknown),
                        "octo",
                        "2026-01-03T00:00:00Z",
                    ),
                ],
            },
        );
    });
    // Closed issues are not discovered, so first import it open, then observe closure.
    f.remote(|remote| {
        remote.issues.get_mut(&1).unwrap().state = ExternalState::named(StateCategory::Open, "Open")
    });
    f.refresh();
    f.remote(|remote| {
        let issue = remote.issues.get_mut(&1).unwrap();
        issue.state = ExternalState::named(StateCategory::Completed, "Closed");
        issue.updated_at = "2026-02-02T00:00:00Z".into();
    });
    f.refresh_at("2026-02-03T00:00:00Z");
    let events = f.workspace.source_conversation("T-KQ1").unwrap();
    assert!(matches!(&events[0], ConversationEntry::Event {event, ..} if event == "closed"));
    assert!(
        matches!(&events[2], ConversationEntry::Event {event, state_category: Some(StateCategory::Completed), ..} if event == "closed")
    );
    assert_eq!(
        f.ticket(1).source.unwrap().closed_at.as_deref(),
        Some("2026-01-03T00:00:00Z")
    );
}

#[test]
fn closed_at_uses_only_fresh_latest_closures_and_never_an_observed_time() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Lifecycle"), true);
    f.refresh();
    assert_eq!(f.ticket(1).source.unwrap().closed_at, None);
    let mut legacy = serde_json::to_value(f.ticket(1).source.unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("closed_at");
    let source: ticketd_core::source::TicketSource = serde_json::from_value(legacy).unwrap();
    assert_eq!(source.closed_at, None);
    f.remote(|remote| {
        let issue = remote.issues.get_mut(&1).unwrap();
        issue.state = closed(StateCategory::Completed);
        issue.updated_at = "2026-02-02T00:00:00Z".into();
        remote.conversations.insert(
            1,
            Conversation {
                comments: vec![],
                events: vec![
                    event(
                        "old",
                        ExternalEventKind::Closed(StateCategory::Unknown),
                        "octo",
                        "2026-01-01T00:00:00Z",
                    ),
                    event(
                        "reopen",
                        ExternalEventKind::Reopened,
                        "octo",
                        "2026-01-02T00:00:00Z",
                    ),
                    event(
                        "latest",
                        ExternalEventKind::Closed(StateCategory::Completed),
                        "octo",
                        "2026-01-03T00:00:00Z",
                    ),
                ],
            },
        );
    });
    f.refresh_at("2026-02-03T00:00:00Z");
    assert_eq!(
        f.ticket(1).source.unwrap().closed_at.as_deref(),
        Some("2026-01-03T00:00:00Z")
    );
    f.remote(|remote| {
        remote.issues.get_mut(&1).unwrap().updated_at = "2026-02-04T00:00:00Z".into();
        remote.conversation_outage = Some("offline".into());
    });
    f.refresh_at("2026-02-05T00:00:00Z");
    assert_eq!(
        f.ticket(1).source.unwrap().closed_at,
        None,
        "stale conversation"
    );

    f.remote(|remote| {
        remote.conversation_outage = None;
        remote.conversations.get_mut(&1).unwrap().events.push(event(
            "later-reopen",
            ExternalEventKind::Reopened,
            "octo",
            "2026-01-04T00:00:00Z",
        ));
    });
    f.refresh_at("2026-02-06T00:00:00Z");
    assert_eq!(
        f.ticket(1).source.unwrap().closed_at,
        None,
        "latest lifecycle event is reopened"
    );
    f.remote(|remote| {
        let issue = remote.issues.get_mut(&1).unwrap();
        issue.state = ExternalState::named(StateCategory::Open, "Open");
        issue.updated_at = "2026-02-07T00:00:00Z".into();
    });
    f.refresh_at("2026-02-08T00:00:00Z");
    assert_eq!(
        f.ticket(1).source.unwrap().closed_at,
        None,
        "the issue reopened"
    );
    f.remote(|remote| {
        let issue = remote.issues.get_mut(&1).unwrap();
        issue.state = closed(StateCategory::Completed);
        issue.updated_at = "2026-02-09T00:00:00Z".into();
        remote.conversations.get_mut(&1).unwrap().events.push(event(
            "invalid",
            ExternalEventKind::Closed(StateCategory::Completed),
            "octo",
            "not-a-time",
        ));
    });
    f.refresh_at("2026-02-10T00:00:00Z");
    assert_eq!(
        f.ticket(1).source.unwrap().closed_at,
        None,
        "invalid source timestamp"
    );
}

#[test]
fn legacy_latest_closure_is_enriched_only_while_the_conversation_is_fresh() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Duplicate"), true);
    f.refresh();
    let mut duplicate = duplicate_of(1, "Duplicate", Some(9));
    duplicate.updated_at = "2026-02-02T00:00:00Z".into();
    f.publish(duplicate, true);
    f.remote(|remote| {
        remote.conversations.insert(
            1,
            Conversation {
                comments: vec![],
                events: vec![
                    event(
                        "old",
                        ExternalEventKind::Closed(StateCategory::Unknown),
                        "octo",
                        "2026-01-01T00:00:00Z",
                    ),
                    event(
                        "reopen",
                        ExternalEventKind::Reopened,
                        "octo",
                        "2026-01-02T00:00:00Z",
                    ),
                    event(
                        "latest",
                        ExternalEventKind::Closed(StateCategory::Unknown),
                        "octo",
                        "2026-01-03T00:00:00Z",
                    ),
                ],
            },
        );
    });
    f.refresh_at("2026-02-03T00:00:00Z");
    // Simulate a row saved by an older version without reason or subject.
    let db = rusqlite::Connection::open(f.path()).unwrap();
    db.execute(
        "UPDATE source_conversation SET state_category = 'unknown', subject = NULL WHERE entry_id = 'latest'",
        [],
    )
    .unwrap();
    let entries = f.conversation(1);
    assert!(matches!(&entries[0], ConversationEntry::Event { event, .. } if event == "closed"));
    assert!(
        matches!(&entries[2], ConversationEntry::Event { event, state_category: Some(StateCategory::Duplicate), subject, .. } if event == "closed" && subject.as_deref() == Some("o/r#9"))
    );
    // Reading is an overlay, not a mutation of stored historical source data.
    let stored: (String, Option<String>) = db
        .query_row(
            "SELECT state_category, subject FROM source_conversation WHERE entry_id = 'latest'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, ("unknown".into(), None));
    db.execute("UPDATE source_conversation SET state_category = 'duplicate', subject = 'o/r#7' WHERE entry_id = 'latest'", []).unwrap();
    let explicit = f.conversation(1);
    assert!(
        matches!(&explicit[2], ConversationEntry::Event { subject, .. } if subject.as_deref() == Some("o/r#7"))
    );
    db.execute(
        "UPDATE source_conversation SET state_category = 'unknown', subject = NULL WHERE entry_id = 'latest'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE source_sync SET external_updated_at = '2026-02-04T00:00:00Z'",
        [],
    )
    .unwrap();
    let stale = f.conversation(1);
    assert!(
        matches!(&stale[2], ConversationEntry::Event { event, subject, .. } if event == "closed" && subject.is_none())
    );
    assert_eq!(f.ticket(1).source.unwrap().closed_at, None);
}

#[test]
fn lifecycle_events_compare_instants_not_timestamp_text() {
    let mut f = Fixture::new();
    f.publish(issue(1, "Offsets"), true);
    f.refresh();
    f.remote(|remote| {
        let issue = remote.issues.get_mut(&1).unwrap();
        issue.state = closed(StateCategory::Completed);
        issue.updated_at = "2026-02-02T00:00:00Z".into();
        remote.conversations.insert(
            1,
            Conversation {
                comments: vec![],
                events: vec![
                    event(
                        "close",
                        ExternalEventKind::Closed(StateCategory::Unknown),
                        "octo",
                        "2026-01-01T23:00:00-02:00",
                    ),
                    event(
                        "reopen",
                        ExternalEventKind::Reopened,
                        "octo",
                        "2026-01-02T00:00:00Z",
                    ),
                ],
            },
        );
    });
    f.refresh_at("2026-02-03T00:00:00Z");
    assert_eq!(
        f.ticket(1).source.unwrap().closed_at.as_deref(),
        Some("2026-01-01T23:00:00-02:00")
    );
    assert!(f.conversation(1).iter().any(|entry| matches!(entry, ConversationEntry::Event { id, event, state_category: Some(StateCategory::Completed), .. } if id == "close" && event == "closed")));
}

#[test]
fn the_first_import_logs_no_workspace_events_and_later_inbound_changes_log_as_sync() {
    use ticketd_core::{WorkspaceActor, WorkspaceEventType};

    let mut f = Fixture::new();
    f.publish(issue(1, "Original"), true);
    f.refresh();
    assert_eq!(f.workspace.workspace_events_after(0, 100).unwrap(), []);

    f.publish(issue(1, "Retitled"), true);
    f.set_state(1, closed(StateCategory::Completed));
    f.publish(issue(2, "Arrived later"), true);
    f.refresh_at("2026-02-02T00:00:00Z");

    let events = f.workspace.workspace_events_after(0, 100).unwrap();
    assert!(
        events
            .iter()
            .all(|event| event.actor == WorkspaceActor::Sync),
        "{events:?}"
    );
    let of = |number: u32| {
        let id = f.ticket(number).id;
        events
            .iter()
            .filter(|event| event.ticket_id == id)
            .map(|event| (event.kind, event.previous.clone(), event.current.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        of(1),
        [
            (
                WorkspaceEventType::TicketUpdated,
                Some(json!({"title": "Original", "body": "Body of Original"})),
                Some(json!({"title": "Retitled", "body": "Body of Retitled"}))
            ),
            (
                WorkspaceEventType::TicketStatusChanged,
                Some(json!({"status": "Todo"})),
                Some(json!({"status": "Done"}))
            ),
        ]
    );
    assert_eq!(
        of(2),
        [(
            WorkspaceEventType::TicketCreated,
            None,
            Some(json!({
                "title": "Arrived later", "body": "Body of Arrived later", "status": "Todo",
                "project_id": null, "plan_id": null,
            }))
        )]
    );

    // The refresh's actor does not outlive it: the same connection writes as a person again.
    let head = f.workspace.workspace_event_head().unwrap();
    f.workspace.add_tag("T-KQ2", "backend").unwrap();
    let after = f.workspace.workspace_events_after(head, 100).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].actor, WorkspaceActor::Person);
}

/// A repository added to a source that has been read before brings in its backlog.
/// That is a first import too: nothing is logged for it, so no Automation starts a
/// run for every issue it held. What changes or arrives afterwards is news.
#[test]
fn a_backlog_a_widened_source_brings_in_logs_nothing_and_what_follows_logs_as_sync() {
    use ticketd_core::{WorkspaceActor, WorkspaceEventType};

    let mut f = Fixture::new();
    f.publish(issue(1, "Original"), true);
    f.refresh();
    let widened = json!({"repositories": ["o/r", "o/more"]});
    f.workspace
        .save_source(&f.engine, "fake", widened.as_object().unwrap())
        .unwrap();
    f.publish(issue_in("o/more", 2, "Backlog"), true);
    f.publish(issue(1, "Retitled"), true);

    f.refresh_at("2026-02-02T00:00:00Z");

    let kinds = |f: &Fixture, number: u32| {
        let id = f.ticket(number).id;
        f.workspace
            .workspace_events_after(0, 100)
            .unwrap()
            .into_iter()
            .filter(|event| event.ticket_id == id)
            .map(|event| (event.kind, event.actor))
            .collect::<Vec<_>>()
    };
    // The backlog is silent; the ticket already here still logs its change.
    assert_eq!(kinds(&f, 2), []);
    assert_eq!(
        kinds(&f, 1),
        [(WorkspaceEventType::TicketUpdated, WorkspaceActor::Sync)]
    );

    // The added repository has now been read: a later change and a later arrival log.
    f.publish(issue_in("o/more", 2, "Backlog, retitled"), true);
    f.publish(issue_in("o/more", 3, "Arrived later"), true);
    f.refresh_at("2026-02-03T00:00:00Z");
    assert_eq!(
        kinds(&f, 2),
        [(WorkspaceEventType::TicketUpdated, WorkspaceActor::Sync)]
    );
    assert_eq!(
        kinds(&f, 3),
        [(WorkspaceEventType::TicketCreated, WorkspaceActor::Sync)]
    );
}

/// The events logged for the ticket numbered `number`, as (type, actor).
fn logged(
    f: &Fixture,
    number: u32,
) -> Vec<(
    ticketd_core::WorkspaceEventType,
    ticketd_core::WorkspaceActor,
)> {
    let id = f.ticket(number).id;
    f.workspace
        .workspace_events_after(0, 100)
        .unwrap()
        .into_iter()
        .filter(|event| event.ticket_id == id)
        .map(|event| (event.kind, event.actor))
        .collect()
}

/// "First import" is per repository. A read that skips a repository has not read
/// it: its backlog is still silent when it can be read at last. Meanwhile the
/// repository read before goes on logging what arrives in it.
#[test]
fn a_repository_skipped_when_added_is_silent_when_first_read_and_the_rest_keep_logging() {
    use ticketd_core::{WorkspaceActor, WorkspaceEventType};

    let created = [(WorkspaceEventType::TicketCreated, WorkspaceActor::Sync)];
    let mut f = Fixture::new();
    f.publish(issue(1, "Original"), true);
    f.refresh();
    // A repository is added before the account can read it.
    let widened = json!({"repositories": ["o/r", "o/more"]});
    f.workspace
        .save_source(&f.engine, "fake", widened.as_object().unwrap())
        .unwrap();
    f.remote(|remote| remote.inaccessible = vec!["o/more".into()]);
    f.publish(issue_in("o/more", 2, "Backlog"), true);
    f.publish(issue(3, "Arrived where it was read before"), true);

    f.refresh_at("2026-02-02T00:00:00Z");

    // Issue 3 is the second ticket: the skipped repository brought nothing in.
    assert_eq!(f.ticket(2).title, "Arrived where it was read before");
    assert_eq!(logged(&f, 2), created);

    // Access is granted: this is the first time the repository is read.
    f.remote(|remote| remote.inaccessible.clear());
    f.refresh_at("2026-02-03T00:00:00Z");
    assert_eq!(f.ticket(3).title, "Backlog");
    assert_eq!(logged(&f, 3), []);

    // From then on what arrives in it is news, and a later skip does not undo that.
    f.remote(|remote| remote.inaccessible = vec!["o/more".into()]);
    f.refresh_at("2026-02-04T00:00:00Z");
    f.remote(|remote| remote.inaccessible.clear());
    f.publish(issue_in("o/more", 4, "Arrived later"), true);
    f.refresh_at("2026-02-05T00:00:00Z");
    assert_eq!(logged(&f, 4), created);
}

fn save_labels(f: &mut Fixture, labels: &[&str]) {
    let config = json!({"repositories": ["o/r"], "labels": labels});
    f.workspace
        .save_source(&f.engine, "fake", config.as_object().unwrap())
        .unwrap();
}

fn labelled(id: u64, title: &str, labels: &[&str]) -> ExternalIssue {
    let mut issue = issue(id, title);
    issue.labels = labels.iter().map(|label| (*label).to_owned()).collect();
    issue
}

/// A repository is read under its discovery rules. Loosening a filter shows a
/// backlog that was always there, so its issues come in silently, as on a first
/// read; changes to tickets already here, and what arrives once the loosened rules
/// have been read, log as `sync` and start Automations.
#[test]
fn loosening_a_filter_brings_its_backlog_in_silently_and_what_follows_logs() {
    use ticketd_core::{WorkspaceActor, WorkspaceEventType};

    let created = [(WorkspaceEventType::TicketCreated, WorkspaceActor::Sync)];
    let mut f = Fixture::new();
    save_labels(&mut f, &["triage"]);
    f.publish(labelled(1, "Bug", &["bug"]), true);
    f.publish(labelled(2, "Triage", &["triage"]), true);
    f.refresh();
    assert_eq!(f.ticket(1).title, "Triage");
    assert_eq!(logged(&f, 1), []);

    // With the rules unchanged, an old issue that gains the label is news.
    f.publish(labelled(1, "Bug", &["bug", "triage"]), true);
    f.refresh_at("2026-02-02T00:00:00Z");
    assert_eq!(f.ticket(2).title, "Bug");
    assert_eq!(logged(&f, 2), created);

    // Loosened: the backlog it shows is silent, the ticket already here still logs.
    f.publish(labelled(3, "Enhancement", &["enhancement"]), true);
    f.publish(labelled(2, "Triage, retitled", &["triage"]), true);
    save_labels(&mut f, &[]);
    f.refresh_at("2026-02-03T00:00:00Z");
    assert_eq!(f.ticket(3).title, "Enhancement");
    assert_eq!(logged(&f, 3), []);
    assert_eq!(
        logged(&f, 1),
        [(WorkspaceEventType::TicketUpdated, WorkspaceActor::Sync)]
    );

    // Read under the loosened rules, what arrives next is news.
    f.publish(labelled(4, "Arrived later", &["question"]), true);
    f.refresh_at("2026-02-04T00:00:00Z");
    assert_eq!(logged(&f, 4), created);
}

/// Tightened, then loosened again: the loosened rules were forgotten when they
/// stopped being asked for, so what reappears is a backlog again and is silent.
/// An issue that arrives in the same refresh as a change of rules cannot be told
/// from that backlog, and is silent too: the safer side.
#[test]
fn a_filter_tightened_then_loosened_and_an_arrival_with_the_change_stay_silent() {
    use ticketd_core::{WorkspaceActor, WorkspaceEventType};

    let mut f = Fixture::new();
    f.publish(labelled(1, "Triage", &["triage"]), true);
    f.refresh();
    save_labels(&mut f, &["triage"]);
    f.refresh_at("2026-02-02T00:00:00Z");
    // Hidden while the rules were tight, arriving with the change back.
    f.publish(labelled(2, "Hidden while tight", &["bug"]), true);
    f.refresh_at("2026-02-03T00:00:00Z");
    f.publish(labelled(3, "Arrived with the change", &["bug"]), true);
    save_labels(&mut f, &[]);
    f.refresh_at("2026-02-04T00:00:00Z");
    assert_eq!(f.ticket(2).title, "Hidden while tight");
    assert_eq!(logged(&f, 2), []);
    assert_eq!(f.ticket(3).title, "Arrived with the change");
    assert_eq!(logged(&f, 3), []);

    // A new issue the tightened rules match still logs while they apply.
    save_labels(&mut f, &["triage"]);
    f.refresh_at("2026-02-05T00:00:00Z");
    f.publish(labelled(4, "Triage arrival", &["triage"]), true);
    f.refresh_at("2026-02-06T00:00:00Z");
    assert_eq!(
        logged(&f, 4),
        [(WorkspaceEventType::TicketCreated, WorkspaceActor::Sync)]
    );
}

/// A Workspace from before the repositories read were kept: one with tickets
/// already imported counts as read, one without does not.
#[test]
fn before_the_repositories_read_were_kept_one_with_imported_tickets_counts_as_read() {
    use ticketd_core::{WorkspaceActor, WorkspaceEventType};

    let mut f = Fixture::new();
    f.publish(issue(1, "Original"), true);
    f.refresh();
    let widened = json!({"repositories": ["o/r", "o/more"]});
    f.workspace
        .save_source(&f.engine, "fake", widened.as_object().unwrap())
        .unwrap();
    let db = rusqlite::Connection::open(f.path()).unwrap();
    db.execute(
        "UPDATE source_connection_status SET read_partitions = NULL",
        [],
    )
    .unwrap();
    drop(db);
    f.publish(issue(2, "Arrived where tickets were imported"), true);
    f.publish(issue_in("o/more", 3, "Backlog"), true);

    f.refresh_at("2026-02-02T00:00:00Z");

    assert_eq!(
        logged(&f, 2),
        [(WorkspaceEventType::TicketCreated, WorkspaceActor::Sync)]
    );
    assert_eq!(logged(&f, 3), []);
}

/// Format 82 replaces the configuration unreleased builds kept with the repositories read.
#[test]
fn a_format_81_workspace_gains_the_repositories_read_and_loses_the_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 81).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("ALTER TABLE source_status ADD COLUMN refreshed_configuration TEXT;")
        .unwrap();
    drop(db);

    drop(Workspace::open(&path).unwrap());

    let db = rusqlite::Connection::open(&path).unwrap();
    let columns: Vec<String> = db
        .prepare("SELECT name FROM pragma_table_info('source_status')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(columns.contains(&"read_partitions".to_owned()));
    assert!(!columns.contains(&"refreshed_configuration".to_owned()));
}

#[test]
fn format_91_source_states_conversation_and_retry_results_upgrade_together() {
    use rusqlite::params;
    use ticketd_core::{WriteRequest, WriteResult};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 91).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let at = "2026-02-03T00:00:00Z";
    let inputs = [
        (
            "github",
            "open",
            None,
            Status::InReview,
            StateCategory::Open,
            Some("Open"),
        ),
        (
            "github",
            "closed",
            Some("completed"),
            Status::Done,
            StateCategory::Completed,
            Some("Closed"),
        ),
        (
            "github",
            "closed",
            Some("not_planned"),
            Status::Canceled,
            StateCategory::NotPlanned,
            Some("Closed"),
        ),
        (
            "github",
            "closed",
            Some("duplicate"),
            Status::Duplicate,
            StateCategory::Duplicate,
            Some("Closed"),
        ),
        (
            "github",
            "closed",
            Some("unknown"),
            Status::InProgress,
            StateCategory::Unknown,
            Some("Closed"),
        ),
        (
            "github",
            "closed",
            None,
            Status::Todo,
            StateCategory::Unknown,
            Some("Closed"),
        ),
        (
            "another-tracker",
            "open",
            None,
            Status::InProgress,
            StateCategory::Open,
            None,
        ),
    ];
    for (index, (provider, state, reason, status, _, _)) in inputs.iter().enumerate() {
        let reference = format!("T-KQ{}", index + 10);
        let id = uuid::Uuid::new_v4().to_string();
        let locator = format!("Org/Kit#{}", index + 10);
        db.execute("INSERT INTO tickets (id, reference, title, status) VALUES (?1, ?2, 'Tracked issue', ?3)",
            params![id, reference, status.to_string()]).unwrap();
        db.execute("INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin)
            VALUES (?1, ?2, ?3, ?4, ?4, 'https://example.test/issue', 'imported')",
            params![id, provider, reference, locator]).unwrap();
        let authority = if index == 6 { "local" } else { "external" };
        db.execute(
            "INSERT INTO external_ownership (ticket_id, authority, changed_at) VALUES (?1, ?2, ?3)",
            params![id, authority, at],
        )
        .unwrap();
        db.execute("INSERT INTO source_sync (ticket_id, external_state, closure_reason, external_updated_at,
            last_refreshed_at, last_attempt_at, conversation_updated_at, external_author, external_created_at)
            VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?4, 'octo', ?4)",
            params![id, state, reason, at]).unwrap();
        if index == 1 {
            for (position, event) in [
                "closed_duplicate",
                "reopened",
                "closed_not_planned",
                "closed",
                "closed_completed",
            ]
            .iter()
            .enumerate()
            {
                db.execute("INSERT INTO source_conversation (ticket_id, kind, entry_id, position, actor, event, created_at)
                    VALUES (?1, 'event', ?2, ?3, 'octo', ?4, ?5)",
                    params![id, format!("event-{position}"), position, event, at]).unwrap();
            }
        }
    }
    let unresolved: String = db
        .query_row(
            "SELECT id FROM tickets WHERE reference = 'T-KQ10'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    for (field, base, remote) in [
        ("source_state", Some("open"), "closed"),
        ("source_closure_reason", None, "not_planned"),
        ("title", Some("First title"), "Other title"),
    ] {
        let encode = |value: &str| {
            serde_json::to_string(&ticketd_core::SyncValue::Text(value.into())).unwrap()
        };
        db.execute("INSERT INTO sync_conflicts (kind, id, field, base, remote, remote_device, detected_at, remote_changed_at)
            VALUES ('ticket', ?1, ?2, ?3, ?4, 'Other desktop', ?5, ?5)",
            params![unresolved, field, base.map(encode), encode(remote), at]).unwrap();
    }
    // An upload advanced the cached sync base without settling the pending
    // review. The cached file now represents the local open observation.
    let uploaded = format!(
        "---\nkind: ticket\nformat: 1\nid: \"{unresolved}\"\nref: \"T-KQ10\"\n\
         title: \"Tracked issue\"\nstatus: \"In review\"\ntrashed: false\nfollowing: false\n\
         source_provider: \"github\"\nsource_external_id: \"T-KQ10\"\n\
         source_locator: \"Org/Kit#10\"\nsource_display: \"Org/Kit#10\"\n\
         source_url: \"https://example.test/issue\"\nsource_origin: \"imported\"\n\
         source_linked_at: \"{at}\"\nsource_authority: \"external\"\n\
         source_authority_changed_at: \"{at}\"\nsource_state: \"open\"\nsource_updated_at: \"{at}\"\n---\n"
    );
    ticketd_core::SyncRecord::parse(&uploaded).unwrap();
    db.execute(
        "INSERT INTO sync_files (kind, id, version, content) VALUES ('ticket', ?1, 'our-upload', ?2)",
        params![unresolved, uploaded],
    )
    .unwrap();
    let mut f = Fixture::new();
    f.publish(issue(1, "Old snapshot"), true);
    f.refresh();
    let mut snapshot = serde_json::to_value(f.ticket(1)).unwrap();
    snapshot["source"]["provider"] = json!("github");
    snapshot["source"]["state"] = json!({"state": "closed", "reason": "not_planned"});
    let request = || WriteRequest::CreateTicket {
        title: "Recorded request".into(),
        project_id: None,
    };
    for (request_id, kind, value) in [
        ("single", "ticket", snapshot.clone()),
        ("batch", "tickets", json!([snapshot])),
    ] {
        db.execute(
            "INSERT INTO request_outcomes (id, request, outcome) VALUES (?1, ?2, ?3)",
            params![
                request_id,
                serde_json::to_string(&request()).unwrap(),
                json!({"kind": kind, "value": value}).to_string()
            ],
        )
        .unwrap();
    }
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    for (index, (_, _, _, status, category, name)) in inputs.into_iter().enumerate() {
        let ticket = workspace
            .show_ticket(&format!("T-KQ{}", index + 10))
            .unwrap();
        assert_eq!(ticket.status, status);
        let source = ticket.source.unwrap();
        assert_eq!(source.state.category, category);
        assert_eq!(source.state.name.as_deref(), name);
        assert_eq!(
            source.ownership,
            if index == 6 {
                Ownership::Local
            } else {
                Ownership::External
            }
        );
        assert_eq!(source.ownership_changed_at.as_deref(), Some(at));
        assert_eq!(source.last_refreshed_at.as_deref(), Some(at));
        assert_eq!(source.author.as_deref(), Some("octo"));
    }
    let review = workspace
        .sync_conflict(ticketd_core::SyncKind::Ticket, &unresolved)
        .unwrap();
    assert!(!review.read);
    let reviewed = review
        .fields
        .iter()
        .map(|field| (field.field.as_str(), &field.remote))
        .collect::<std::collections::BTreeMap<_, _>>();
    let remote = |value: &str| Some(ticketd_core::SyncValue::Text(value.into()));
    assert_eq!(reviewed.len(), 3);
    assert_eq!(*reviewed["source_state_category"], remote("not_planned"));
    assert_eq!(*reviewed["source_state_name"], remote("Closed"));
    assert_eq!(*reviewed["title"], remote("Other title"));
    assert!(
        review
            .fields
            .iter()
            .all(|field| field.remote_changed_at.as_deref() == Some(at))
    );
    let events = workspace.source_conversation("T-KQ11").unwrap();
    for (position, (event, category)) in [
        ("closed", StateCategory::Duplicate),
        ("reopened", StateCategory::Open),
        ("closed", StateCategory::NotPlanned),
        ("closed", StateCategory::Unknown),
        ("closed", StateCategory::Completed),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            matches!(&events[position], ConversationEntry::Event { id, event: kind, state_category: Some(observed), actor, .. }
            if id == &format!("event-{position}") && kind == event && *observed == category && actor.as_deref() == Some("octo"))
        );
    }
    assert_eq!(
        workspace
            .show_ticket("T-KQ11")
            .unwrap()
            .source
            .unwrap()
            .closed_at
            .as_deref(),
        Some(at)
    );
    let WriteResult::Ticket(single) = workspace.write(Some("single"), request()).unwrap() else {
        unreachable!()
    };
    let WriteResult::Tickets(batch) = workspace.write(Some("batch"), request()).unwrap() else {
        unreachable!()
    };
    assert_eq!(single.title, "Old snapshot");
    assert_eq!(
        single.source.as_ref().unwrap().state,
        ExternalState::named(StateCategory::NotPlanned, "Closed")
    );
    assert_eq!(batch, vec![single]);
}

#[test]
fn a_change_a_refresh_brings_in_starts_an_automation_narrowed_to_that_source() {
    use ticketd_core::{
        AutomationAgentSettings, AutomationDefinition, Condition, Step, StepAction, Trigger,
    };

    let mut f = Fixture::new();
    f.publish(issue(1, "From the tracker"), true);
    f.refresh();
    let local = f.workspace.create_ticket("Local").unwrap();
    let agent = f
        .workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    let mut done_from = |source: &str| {
        let automation = f
            .workspace
            .create_automation(AutomationDefinition {
                name: "Closed".into(),
                trigger: Some(Trigger::StatusChanged {
                    to: Some(Status::Done),
                    from: None,
                }),
                conditions: vec![Condition::Source {
                    any_of: vec![source.into()],
                }],
                steps: vec![Step {
                    id: "review".into(),
                    action: StepAction::RunAgent {
                        agent_id: Some(agent.id.clone()),
                        execution_folder: Some("/work/app".into()),
                        on_failure: None,
                    },
                }],
            })
            .unwrap();
        f.workspace
            .set_automation_enabled(&automation.id, true)
            .unwrap();
        automation.id
    };
    let [from_fake, from_local] = ["fake", "local"].map(&mut done_from);

    // The tracker closes its issue; a person closes the local ticket.
    f.set_state(1, closed(StateCategory::Completed));
    f.refresh_at("2026-02-02T00:00:00Z");
    let done = TicketPatch {
        status: Some(Status::Done),
        ..Default::default()
    };
    f.workspace.change_ticket(&local.reference, done).unwrap();

    f.workspace.queue_automation_runs().unwrap();
    let started = |automation: &str| {
        f.workspace
            .automation_runs(automation)
            .unwrap()
            .into_iter()
            .map(|run| run.ticket.unwrap().id)
            .collect::<Vec<_>>()
    };
    assert_eq!(started(&from_fake), [f.ticket(1).id]);
    assert_eq!(started(&from_local), [local.id]);
}

/// Ready and Blocked are one rule, whichever read asks: the ticket detail, the
/// availability filter, the sidebar count, the dependency graph and the duplicate review.
#[test]
fn ready_and_blocked_agree_on_every_read() {
    use ticketd_core::{Availability, DependencyChoice, DependencyDecision, Readiness, ReviewMode};
    struct Case {
        name: &'static str,
        status: Status,
        trashed: bool,
        held: bool,
        blocker: Option<Status>,
        expected: Option<&'static str>,
    }
    let todo = |name, blocker, expected| Case {
        name,
        status: Status::Todo,
        trashed: false,
        held: false,
        blocker,
        expected,
    };
    let cases = [
        todo("ready", None, Some("Ready")),
        todo("a Done blocker", Some(Status::Done), Some("Ready")),
        todo("an open blocker", Some(Status::Todo), Some("Blocked")),
        todo(
            "a started blocker",
            Some(Status::InProgress),
            Some("Blocked"),
        ),
        todo(
            "an In review blocker",
            Some(Status::InReview),
            Some("Blocked"),
        ),
        todo(
            "a Canceled blocker",
            Some(Status::Canceled),
            Some("Blocked"),
        ),
        todo(
            "a Duplicate blocker",
            Some(Status::Duplicate),
            Some("Blocked"),
        ),
        Case {
            name: "in Trash",
            trashed: true,
            ..todo("", Some(Status::Todo), None)
        },
        Case {
            name: "started",
            status: Status::InProgress,
            ..todo("", None, None)
        },
        Case {
            name: "held",
            held: true,
            ..todo("", None, None)
        },
        Case {
            name: "held with an open blocker",
            held: true,
            ..todo("", Some(Status::Todo), None)
        },
    ];
    let label = |readiness: Readiness| match readiness {
        Readiness::Ready => Some("Ready"),
        Readiness::Blocked => Some("Blocked"),
        Readiness::NoReadyState => None,
    };

    for case in cases {
        let mut f = Fixture::new();
        let name = case.name;
        let set_status = |f: &mut Fixture, reference: &str, status: Status| {
            let patch = TicketPatch {
                status: Some(status),
                ..Default::default()
            };
            f.workspace.change_ticket(reference, patch).unwrap();
        };
        // The ticket under judgment, then a canonical ticket, a duplicate whose review moves
        // its dependencies away, and the ticket's blocker.
        let subject = if case.held {
            f.publish(issue(1, "Held"), true);
            f.refresh();
            f.ticket(1).reference
        } else {
            f.workspace.create_ticket("Subject").unwrap().reference
        };
        let canonical = f.workspace.create_ticket("Canonical").unwrap().reference;
        let duplicate = f.workspace.create_ticket("Duplicate").unwrap().reference;
        f.workspace
            .add_dependency(&duplicate, &subject, None)
            .unwrap();
        if let Some(status) = case.blocker {
            let blocker = f.workspace.create_ticket("Blocker").unwrap().reference;
            f.workspace
                .add_dependency(&blocker, &subject, None)
                .unwrap();
            if status == Status::Duplicate {
                // It already blocks the subject, so retaining that edge is a reviewed choice.
                let review = f
                    .workspace
                    .preview_duplicate_dependencies(&blocker, &canonical)
                    .unwrap();
                let retain: Vec<_> = review
                    .edges
                    .iter()
                    .map(|edge| DependencyDecision {
                        edge: edge.clone(),
                        choice: DependencyChoice::Retain,
                    })
                    .collect();
                f.workspace
                    .mark_duplicate_reviewed(&blocker, &canonical, &review.canonical, retain, None)
                    .unwrap();
            } else if status != Status::Todo {
                set_status(&mut f, &blocker, status);
            }
        }
        if case.status != Status::Todo {
            set_status(&mut f, &subject, case.status);
        }
        if case.trashed {
            f.workspace.set_trashed(&subject, true, None).unwrap();
        }
        if case.held {
            f.set_state(1, closed(StateCategory::Unknown));
            f.refresh();
        }

        // The duplicate review judges the subject as if the duplicate no longer blocked it.
        let preview = f
            .workspace
            .preview_duplicate_dependencies(&duplicate, &canonical)
            .unwrap();
        let decisions: Vec<_> = preview
            .edges
            .iter()
            .map(|edge| DependencyDecision {
                edge: edge.clone(),
                choice: if edge.dependent == subject {
                    DependencyChoice::Remove
                } else {
                    DependencyChoice::Retain
                },
            })
            .collect();
        let outcomes = f
            .workspace
            .evaluate_dependency_review(&duplicate, &canonical, ReviewMode::Duplicate, &decisions)
            .unwrap();
        let outcome = outcomes.iter().find(|o| o.ticket == subject).unwrap();
        assert_eq!(label(outcome.after), case.expected, "review, {name}");

        // Every other read sees the duplicate still blocking, so settle it first.
        f.workspace
            .remove_dependency(&duplicate, &subject, None)
            .unwrap();
        let detail = f.workspace.show_ticket(&subject).unwrap();
        assert_eq!(
            detail.availability.as_deref(),
            case.expected,
            "detail, {name}"
        );

        let graph = f.workspace.dependency_graph(&subject).unwrap();
        let node = graph.nodes.iter().find(|n| n.reference == subject).unwrap();
        assert_eq!(node.availability.as_deref(), case.expected, "graph, {name}");

        let listed = |availability| {
            let filter = TicketFilter {
                availability: Some(availability),
                ..Default::default()
            };
            let found = f.workspace.find_tickets(&filter).unwrap();
            (found.len(), found.iter().any(|t| t.reference == subject))
        };
        let (ready_len, ready_listed) = listed(Availability::Ready);
        let (_, blocked_listed) = listed(Availability::Blocked);
        assert_eq!(
            ready_listed,
            case.expected == Some("Ready"),
            "Ready list, {name}"
        );
        assert_eq!(
            blocked_listed,
            case.expected == Some("Blocked"),
            "Blocked list, {name}"
        );
        // The sidebar counts exactly the Ready list: held and trashed tickets stay out.
        let counts = f.workspace.sidebar_counts().unwrap();
        assert_eq!(counts.ready as usize, ready_len, "Ready count, {name}");

        // A list carries the indicator it was selected with, which is the detail's.
        let availability_in = |tickets: Vec<ticketd_core::Ticket>| {
            tickets
                .into_iter()
                .find(|t| t.reference == subject)
                .map(|t| t.availability)
        };
        let (listing, trash) = (
            availability_in(f.workspace.list_tickets().unwrap()),
            availability_in(f.workspace.list_trash().unwrap()),
        );
        let found = availability_in(f.workspace.find_tickets(&TicketFilter::default()).unwrap());
        let searched = availability_in(
            f.workspace
                .search_tickets(&subject, None, false, 10, 0)
                .unwrap(),
        );
        let metadata = f
            .workspace
            .find_ticket_metadata(&TicketFilter::default(), None, false)
            .unwrap()
            .items
            .into_iter()
            .find(|t| t.reference == subject)
            .map(|t| t.availability);
        let expected = case.expected.map(str::to_owned);
        if case.trashed {
            assert_eq!(trash, Some(expected), "trash list, {name}");
            assert_eq!(listing, None, "list, {name}");
        } else {
            assert_eq!(listing, Some(expected.clone()), "list, {name}");
            assert_eq!(found, Some(expected.clone()), "find, {name}");
            assert_eq!(searched, Some(expected.clone()), "search, {name}");
            assert_eq!(metadata, Some(expected), "metadata, {name}");
        }
    }
}
