//! Narrow transport-level tests: GitHub's wire format in, neutral contract
//! types out. No test touches the network except the loopback server.

use std::{
    collections::{BTreeMap, VecDeque},
    ops::ControlFlow,
    sync::{Arc, Mutex},
};

use serde_json::{Value, json};

use super::{credentials::Secret, transport::TransportError, *};
use crate::source::{Engine, Surface, schema::ConfigValues};

#[path = "conformance.rs"]
mod conformance_fixture;

const API: &str = "https://api.example.test";
const TOKEN: &str = "ghp_secret_token_value";

#[derive(Default)]
struct Fixture {
    routes: Mutex<BTreeMap<String, VecDeque<Result<HttpResponse, TransportError>>>>,
    requests: Mutex<Vec<HttpRequest>>,
    on_request: Mutex<Option<RequestHook>>,
    accounts: Mutex<BTreeMap<String, (String, u64)>>,
}

struct RequestHook {
    url: String,
    run: Box<dyn FnOnce() + Send>,
}

impl Fixture {
    fn respond(&self, url: &str, response: Result<HttpResponse, TransportError>) {
        self.routes
            .lock()
            .unwrap()
            .entry(url.to_owned())
            .or_default()
            .push_back(response);
    }

    fn authenticate_as(&self, api: &str, account: &str) {
        self.authenticate_account(api, account, if account == "bob" { 2 } else { 1 });
    }

    fn authenticate_account(&self, api: &str, account: &str, id: u64) {
        self.accounts
            .lock()
            .unwrap()
            .insert(format!("{api}/user"), (account.into(), id));
    }

    fn urls(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.url.clone())
            .collect()
    }
}

struct Shared(Arc<Fixture>);

impl HttpTransport for Shared {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, TransportError> {
        self.0.requests.lock().unwrap().push(request.clone());
        let hook = {
            let mut hook = self.0.on_request.lock().unwrap();
            if hook.as_ref().is_some_and(|hook| hook.url == request.url) {
                hook.take()
            } else {
                None
            }
        };
        if let Some(hook) = hook {
            (hook.run)();
        }
        self.0
            .routes
            .lock()
            .unwrap()
            .get_mut(&request.url)
            .and_then(VecDeque::pop_front)
            .or_else(|| {
                self.0
                    .accounts
                    .lock()
                    .unwrap()
                    .get(&request.url)
                    .map(|(account, id)| ok(json!({"login": account, "id": id})))
            })
            .unwrap_or_else(|| Err(format!("no fixture for {}", request.url).into()))
    }
}

struct Token(Option<&'static str>);

impl CredentialSource for Token {
    fn token(&self) -> Option<Secret> {
        self.0.map(Secret::new)
    }
}

fn setup(token: Option<&'static str>) -> (Arc<Fixture>, Engine) {
    setup_at(API, token)
}

fn setup_at(api: &str, token: Option<&'static str>) -> (Arc<Fixture>, Engine) {
    let fixture = Arc::new(Fixture::default());
    let mut engine = Engine::new();
    engine
        .register(Box::new(connector_at(api, &fixture, token)))
        .unwrap();
    (fixture, engine)
}

fn connector_at(api: &str, fixture: &Arc<Fixture>, token: Option<&'static str>) -> GithubConnector {
    GithubConnector::new(
        api,
        Box::new(Shared(fixture.clone())),
        Box::new(Token(token)),
    )
}

fn ok(body: Value) -> Result<HttpResponse, TransportError> {
    ok_with(body, &[])
}

fn ok_with(body: Value, headers: &[(&str, &str)]) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse {
        status: 200,
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        body: body.to_string().into_bytes(),
    })
}

fn status(
    code: u16,
    body: Value,
    headers: &[(&str, &str)],
) -> Result<HttpResponse, TransportError> {
    let mut response = ok_with(body, headers)?;
    response.status = code;
    Ok(response)
}

fn issue(id: u64, number: u64, repo: &str) -> Value {
    json!({
        "id": id, "number": number, "title": format!("Issue {number}"),
        "body": "Details", "state": "open", "state_reason": null,
        "html_url": format!("{API}/{repo}/issues/{number}"),
        "repository_url": format!("{API}/repos/{repo}"),
        "assignees": [{"login": "octo"}], "labels": [{"name": "bug"}, "plain"],
        "user": {"login": "alice", "id": 1},
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z"
    })
}

#[test]
fn repository_picker_filters_paginated_results_from_the_github_cli() {
    let http = Arc::new(Fixture::default());
    let mut connector = connector_at(DEFAULT_API_URL, &http, None);
    connector.gh = Some(gh::GhApi::new(|args, body, auth, _| {
        assert_eq!(&args[..4], ["api", "--hostname", "github.com", "--include"]);
        assert!(matches!(auth, gh::Authentication::Ambient));
        assert!(body.is_none());
        let endpoint = *args.last().unwrap();
        let first = "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member";
        let next = "user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&page=2&per_page=100&sort=pushed";
        let (page, link) = match endpoint {
            endpoint if endpoint == first => (
                json!([{"full_name": "acme/gizmo", "private": false}]),
                format!("Link: <https://api.github.com/{next}>; rel=\"next\"\r\n"),
            ),
            endpoint if endpoint == next => (
                json!([{"full_name": "acme/widgets", "private": true}]),
                String::new(),
            ),
            _ => panic!("unexpected GitHub endpoint: {endpoint}"),
        };
        Ok(gh::Output {
            success: true,
            stdout: format!(
                "HTTP/2.0 200 OK\r\n{link}Content-Type: application/json\r\n\r\n{page}"
            )
            .into_bytes(),
            stderr: Vec::new(),
        })
    }));
    let options = connector
        .options("repositories", "WIDGET", &ConfigValues::new())
        .unwrap();
    assert_eq!(options.len(), 1);
    assert_eq!(options[0].value, "acme/widgets");
    assert_eq!(options[0].description.as_deref(), Some("Private"));
    assert!(http.urls().is_empty());
}

fn public_issue(id: u64, number: u64, repository: &str) -> Value {
    let mut item = issue(id, number, repository);
    item["url"] = json!(format!(
        "{DEFAULT_API_URL}/repos/{repository}/issues/{number}"
    ));
    item["repository_url"] = json!(format!("{DEFAULT_API_URL}/repos/{repository}"));
    item["html_url"] = json!(format!("https://github.com/{repository}/issues/{number}"));
    item
}

fn config(value: Value) -> ConfigValues {
    value.as_object().unwrap().clone()
}

fn discover_all(engine: &Engine, values: &ConfigValues) -> Result<Vec<ExternalIssue>, SourceError> {
    let mut found = Vec::new();
    engine.discover("github", values, |issue| {
        found.push(issue);
        ControlFlow::Continue(())
    })?;
    Ok(found)
}

#[test]
fn configured_repositories_use_the_github_web_host_without_network_access() {
    for (api, repository) in [
        ("https://api.github.com", "github.com/Owner/Name"),
        (
            "https://api.octocorp.ghe.com",
            "octocorp.ghe.com/Owner/Name",
        ),
        (
            "https://Api.Git.Example.test:8443/api/v3",
            "api.git.example.test/Owner/Name",
        ),
    ] {
        let fixture = Arc::new(Fixture::default());
        let connector = GithubConnector::new(
            api,
            Box::new(Shared(fixture.clone())),
            Box::new(Token(None)),
        );
        let mut engine = Engine::new();
        engine.register(Box::new(connector)).unwrap();
        assert_eq!(
            engine
                .repository_for_destination("github", "Owner/Name")
                .unwrap()
                .as_deref(),
            Some(repository)
        );
        assert!(fixture.urls().is_empty());
    }
}

#[test]
fn a_legacy_publication_holds_matching_github_issues_without_project_remote_provenance() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("legacy.db");
    crate::create_workspace_at_format_version(&path, 88).unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "INSERT INTO tickets (id, reference, title, body, status)
             VALUES ('legacy', 'T-KQ5', 'Issue 7', 'Details', 'Todo');
             INSERT INTO publication_attempts
                (id, ticket_id, provider, destination, title, body, status, started_at, lease_expires_at, updated_at)
             VALUES ('attempt', 'legacy', 'github', 'O/ONE', 'Issue 7', 'Details', 'unresolved',
                '2026-01-01T00:00:00Z', '2026-01-01T00:02:00Z', '2026-01-01T00:00:00Z');",
        )
        .unwrap();
    let mut workspace = crate::Workspace::open(&path).unwrap();

    // The connector can identify this host even though Project remotes reject it.
    let api = "https://git_hub.example.test";
    let (fixture, engine) = setup_at(api, Some(TOKEN));
    assert_eq!(
        engine
            .repository_for_destination("github", "o/one")
            .unwrap(),
        None
    );
    fixture.authenticate_as(api, "octo");
    for (id, repository) in [(7, "o/one"), (8, "o/other")] {
        let listed = format!("{api}/repos/{repository}/issues?state=open&per_page=100");
        fixture.respond(&listed, ok(json!([])));
        for _ in 0..2 {
            fixture.respond(&listed, ok(json!([issue(id, 7, repository)])));
            for suffix in ["comments", "events"] {
                fixture.respond(
                    &format!("{api}/repos/{repository}/issues/7/{suffix}?per_page=100"),
                    ok(json!([])),
                );
            }
        }
    }
    workspace
        .save_source(
            &engine,
            "github",
            &config(json!({"repositories": ["o/one", "o/other"]})),
        )
        .unwrap();
    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();

    assert_eq!(report.imported.len(), 1);
    let imported = workspace.show_ticket(&report.imported[0]).unwrap();
    assert_eq!(imported.source.unwrap().id, "@git_hub.example.test:8");
    assert!(
        workspace
            .show_ticket("T-KQ5")
            .unwrap()
            .publication
            .is_some()
    );

    let (_, original_engine) = setup(None);
    workspace
        .confirm_publication_host(&original_engine, "T-KQ5", "api.example.test")
        .unwrap();
    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert_eq!(report.imported.len(), 1);
    let imported = workspace.show_ticket(&report.imported[0]).unwrap();
    assert_eq!(imported.source.unwrap().id, "@git_hub.example.test:7");
}

#[test]
fn switching_github_hosts_keeps_colliding_issue_ids_and_locators_separate() {
    let folder = tempfile::tempdir().unwrap();
    let mut workspace = crate::Workspace::open(folder.path().join("workspace.db")).unwrap();
    let values = config(json!({"repositories": ["o/one"]}));
    let public_api = "https://api.github.com";
    let (public, public_engine) = setup_at(public_api, Some(TOKEN));
    public.authenticate_as(public_api, "octo");
    assert_eq!(
        public_engine
            .check("github", &values)
            .unwrap()
            .derived
            .partitions,
        ["o/one"]
    );
    let mut public_issue = issue(7, 7, "o/one");
    public_issue["title"] = json!("Public issue");
    public_issue["html_url"] = json!("https://github.com/o/one/issues/7");
    let listed = |api| format!("{api}/repos/o/one/issues?state=open&per_page=100");
    public.respond(&listed(public_api), ok(json!([public_issue])));
    workspace
        .save_source(&public_engine, "github", &values)
        .unwrap();
    public.respond(&listed(public_api), ok(json!([public_issue])));
    for suffix in ["comments", "events"] {
        public.respond(
            &format!("{public_api}/repos/o/one/issues/7/{suffix}?per_page=100"),
            ok(json!([])),
        );
    }
    workspace
        .refresh_sources(&public_engine, &Default::default())
        .unwrap();
    let public_ticket = workspace.list_tickets().unwrap().remove(0);
    assert_eq!(public_ticket.title, "Public issue");
    assert_eq!(
        workspace.export().unwrap()["external_identities"][0]["external_id"],
        "7"
    );

    let (enterprise, enterprise_engine) = setup(Some(TOKEN));
    let mut enterprise_issue = issue(7, 7, "o/one");
    enterprise_issue["title"] = json!("Enterprise issue");
    enterprise.authenticate_as(API, "octo");
    enterprise.respond(&listed(API), ok(json!([enterprise_issue])));
    enterprise.respond(&listed(API), ok(json!([enterprise_issue])));
    let enterprise_source = workspace
        .add_source_connection(&enterprise_engine, "github", None, None, &values)
        .unwrap()
        .source;
    for suffix in ["comments", "events"] {
        enterprise.respond(
            &format!("{API}/repos/o/one/issues/7/{suffix}?per_page=100"),
            ok(json!([])),
        );
    }
    workspace
        .refresh_connection(
            &enterprise_engine,
            &enterprise_source.id,
            &Default::default(),
        )
        .unwrap();
    let tickets = workspace.list_tickets().unwrap();
    assert_eq!(tickets.len(), 2);
    assert!(tickets.iter().any(
        |ticket| ticket.reference == public_ticket.reference && ticket.title == "Public issue"
    ));
    assert!(
        tickets
            .iter()
            .any(|ticket| ticket.title == "Enterprise issue")
    );
    assert!(
        !enterprise
            .urls()
            .contains(&format!("{API}/repos/o/one/issues/7"))
    );
    assert!(workspace.workspace_events_after(0, 100).unwrap().is_empty());

    let membership = |workspace: &crate::Workspace, reference: &str| {
        workspace
            .show_ticket(reference)
            .unwrap()
            .source
            .unwrap()
            .discovery_matches
    };
    let enterprise_ticket = tickets
        .iter()
        .find(|ticket| ticket.title == "Enterprise issue")
        .unwrap();
    assert_eq!(membership(&workspace, &public_ticket.reference), Some(true));
    assert_eq!(
        membership(&workspace, &enterprise_ticket.reference),
        Some(true)
    );

    enterprise.respond(&listed(API), ok(json!([])));
    enterprise.respond(&format!("{API}/repos/o/one/issues/7"), ok(enterprise_issue));
    workspace
        .refresh_connection(
            &enterprise_engine,
            &enterprise_source.id,
            &Default::default(),
        )
        .unwrap();
    assert_eq!(membership(&workspace, &public_ticket.reference), Some(true));
    assert_eq!(
        membership(&workspace, &enterprise_ticket.reference),
        Some(false)
    );
}

#[test]
fn enterprise_issue_scopes_keep_nondefault_ports_separate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    crate::create_workspace_at_format_version(&path, 96).unwrap();
    rusqlite::Connection::open(&path).unwrap().execute_batch(
        "INSERT INTO tickets (id, reference, title, body, status) VALUES
             ('known', 'T-KQ7', 'Original port', '', 'Todo'),
             ('default', 'T-KQ8', 'Default port', '', 'Todo'),
             ('ambiguous', 'T-KQ9', 'Unverified port', '', 'Todo');
         INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, partition, repository)
         VALUES ('known', 'github', '@forge.example:7', 'o/r#7', 'o/r#7', 'https://forge.example:8443/o/r/issues/7', 'imported', '@forge.example/o/r', 'forge.example/o/r'),
                ('default', 'github', '@forge.example:8', 'o/r#8', 'o/r#8', 'https://forge.example/o/r/issues/8', 'imported', '@forge.example/o/r', 'forge.example/o/r'),
                ('ambiguous', 'github', '@forge.example:9', 'o/r#9', 'o/r#9', '', 'imported', '@forge.example/o/r', 'forge.example/o/r');
         INSERT INTO external_ownership (ticket_id, authority) VALUES
                ('known', 'external'), ('default', 'external'), ('ambiguous', 'external');
         INSERT INTO source_sync (ticket_id, state_category) VALUES
                ('known', 'open'), ('default', 'open'), ('ambiguous', 'open');"
    ).unwrap();
    let mut workspace = crate::Workspace::open(&path).unwrap();
    let id = |workspace: &crate::Workspace, reference: &str| {
        workspace.show_ticket(reference).unwrap().source.unwrap().id
    };
    assert_eq!(id(&workspace, "T-KQ7"), "@forge.example:8443:7");
    assert_eq!(id(&workspace, "T-KQ8"), "@forge.example:8");
    assert_eq!(id(&workspace, "T-KQ9"), "@forge.example:9");

    let first_api = "https://forge.example:8443/api/v3";
    let (first, first_engine) = setup_at(first_api, Some(TOKEN));
    first.authenticate_as(first_api, "octo");
    let values = config(json!({"repositories": ["o/r"]}));
    first.respond(
        &format!("{first_api}/repos/o/r/issues?state=open&per_page=100"),
        ok(json!([issue(7, 7, "o/r")])),
    );
    let first_saved = workspace
        .save_source(&first_engine, PROVIDER, &values)
        .unwrap();
    assert_eq!(first_saved.preview.already_here, 1);
    assert_eq!(
        workspace
            .ticket_source_connection("T-KQ7")
            .unwrap()
            .as_deref(),
        Some("github")
    );

    let second_site = "https://forge.example:9443";
    let second_api = &format!("{second_site}/api/v3");
    let (second, second_engine) = setup_at(second_api, Some(TOKEN));
    second.authenticate_as(second_api, "octo");
    let list = format!("{second_api}/repos/o/r/issues?state=open&per_page=100");
    let items: Vec<_> = [7, 8, 9]
        .into_iter()
        .map(|id| {
            let mut item = issue(id, id, "o/r");
            item["html_url"] = json!(format!("{second_site}/o/r/issues/{id}"));
            item
        })
        .collect();
    second.respond(&list, ok(json!(items)));
    let second_saved = workspace
        .add_source_connection(&second_engine, PROVIDER, Some("github-2"), None, &values)
        .unwrap();
    assert_eq!(second_saved.preview.already_here, 0);
    second.respond(&list, ok(json!(items)));
    for id in [7, 8] {
        for part in ["comments", "events"] {
            second.respond(
                &format!("{second_api}/repos/o/r/issues/{id}/{part}?per_page=100"),
                ok(json!([])),
            );
        }
    }
    let outcome = workspace
        .refresh_connection(&second_engine, "github-2", &Default::default())
        .unwrap();
    assert_eq!(
        outcome
            .imported
            .iter()
            .map(|reference| id(&workspace, reference))
            .collect::<Vec<_>>(),
        ["@forge.example:9443:7", "@forge.example:9443:8"]
    );
    assert!(
        outcome
            .failures
            .iter()
            .any(|failure| failure.reference.as_deref() == Some("T-KQ9")
                && failure.message.contains("reconcile-github"))
    );
    assert_eq!(id(&workspace, "T-KQ7"), "@forge.example:8443:7");
    assert_eq!(id(&workspace, "T-KQ8"), "@forge.example:8");
    assert_eq!(id(&workspace, "T-KQ9"), "@forge.example:9");

    let project = workspace
        .create_project_with_remote(
            "Second site",
            dir.path().to_str().unwrap(),
            Some("forge.example/o/r"),
        )
        .unwrap();
    let preview = workspace
        .preview_connect_source(&second_engine, "github-2", &project.id)
        .unwrap();
    let mut imported = outcome.imported;
    imported.sort();
    assert_eq!(preview.tickets, imported);
    let backfill = workspace
        .connect_source(
            &second_engine,
            "github-2",
            &project.id,
            &preview.fingerprint,
        )
        .unwrap();
    assert_eq!(backfill.linked_tickets, imported);
    for reference in ["T-KQ7", "T-KQ8", "T-KQ9"] {
        assert!(
            workspace
                .show_ticket(reference)
                .unwrap()
                .project_id
                .is_none()
        );
    }

    let default_api = "https://forge.example/api/v3";
    let (default_site, default_engine) = setup_at(default_api, Some(TOKEN));
    default_site.authenticate_as(default_api, "octo");
    default_site.respond(
        &format!("{default_api}/repos/o/r/issues?state=open&per_page=100"),
        ok(json!([])),
    );
    workspace
        .add_source_connection(&default_engine, PROVIDER, Some("github-3"), None, &values)
        .unwrap();
    let preview = workspace
        .preview_connect_source(&default_engine, "github-3", &project.id)
        .unwrap();
    assert_eq!(preview.tickets, ["T-KQ8"]);
    let backfill = workspace
        .connect_source(
            &default_engine,
            "github-3",
            &project.id,
            &preview.fingerprint,
        )
        .unwrap();
    assert_eq!(backfill.linked_tickets, ["T-KQ8"]);
    assert!(workspace.show_ticket("T-KQ9").unwrap().project_id.is_none());
}

#[test]
fn data_residency_discovery_reuses_legacy_tickets_and_routes_by_their_web_host() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("legacy.db");
    crate::create_workspace_at_format_version(&path, 87).unwrap();
    let old = rusqlite::Connection::open(&path).unwrap();
    for (id, repository) in [(7, Some("api.octocorp.ghe.com/o/one")), (8, None)] {
        let key = format!("legacy-{id}");
        let reference = format!("T-KQ{id}");
        let locator = format!("o/one#{id}");
        let url = format!("https://octocorp.ghe.com/o/one/issues/{id}");
        old.execute("INSERT INTO tickets (id, reference, title, status) VALUES (?1, ?2, 'Legacy issue', 'Todo')", rusqlite::params![key, reference]).unwrap();
        old.execute("INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, repository) VALUES (?1, 'github', ?2, ?3, ?3, ?4, 'imported', ?5)", rusqlite::params![key, id.to_string(), locator, url, repository]).unwrap();
        old.execute(
            "INSERT INTO external_ownership (ticket_id, authority) VALUES (?1, 'external')",
            [&key],
        )
        .unwrap();
        old.execute(
            "INSERT INTO source_sync (ticket_id, external_state) VALUES (?1, 'open')",
            [&key],
        )
        .unwrap();
    }
    drop(old);

    let mut workspace = crate::Workspace::open(&path).unwrap();
    let api = "https://api.octocorp.ghe.com";
    let (fixture, engine) = setup_at(api, Some(TOKEN));
    let mut issues = Vec::new();
    for id in [7, 8] {
        let mut item = issue(id, id, "o/one");
        item["html_url"] = json!(format!("https://octocorp.ghe.com/o/one/issues/{id}"));
        issues.push(item);
        for suffix in ["comments", "events"] {
            fixture.respond(
                &format!("{api}/repos/o/one/issues/{id}/{suffix}?per_page=100"),
                ok(json!([])),
            );
        }
    }
    let values = config(json!({"repositories": ["o/one"]}));
    let listed = format!("{api}/repos/o/one/issues?state=open&per_page=100");
    fixture.authenticate_as(api, "octo");
    fixture.respond(&listed, ok(json!(issues)));
    let saved = workspace.save_source(&engine, "github", &values).unwrap();
    assert_eq!(saved.preview.already_here, 2);
    let project = workspace
        .create_project_with_remote(
            "Tenant project",
            folder.path().to_str().unwrap(),
            Some("octocorp.ghe.com/o/one"),
        )
        .unwrap();
    let preview = workspace
        .preview_connect_source(&engine, "github", &project.id)
        .unwrap();
    assert_eq!(preview.tickets, ["T-KQ7", "T-KQ8"]);
    fixture.respond(&listed, ok(json!(issues)));
    let refresh = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert!(refresh.imported.is_empty());
    assert_eq!(workspace.list_tickets().unwrap().len(), 2);
}

fn unverified_github_workspace(path: &std::path::Path) -> crate::Workspace {
    crate::create_workspace_at_format_version(path, 87).unwrap();
    let old = rusqlite::Connection::open(path).unwrap();
    old.execute_batch(
        "INSERT INTO tickets (id, reference, title, body, status) VALUES ('legacy', 'T-KQ5', 'Saved issue', 'Saved details', 'Todo');
         INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin)
         VALUES ('legacy', 'github', '5', 'O/One#12', 'O/One#12', '', 'imported');
         INSERT INTO external_ownership (ticket_id, authority) VALUES ('legacy', 'external');
         INSERT INTO source_sync (ticket_id, external_state) VALUES ('legacy', 'open');",
    )
    .unwrap();
    drop(old);
    crate::Workspace::open(path).unwrap()
}

#[test]
fn discovery_withholds_a_possible_legacy_match_even_after_takeover() {
    let folder = tempfile::tempdir().unwrap();
    let mut workspace = unverified_github_workspace(&folder.path().join("legacy.db"));
    let public_api = "https://api.github.com";
    let (fixture, engine) = setup_at(public_api, Some(TOKEN));
    let listed = format!("{public_api}/repos/o/one/issues?state=open&per_page=100");
    let mut candidate = issue(5, 12, "o/one");
    candidate["html_url"] = json!("https://github.com/o/one/issues/12");
    fixture.authenticate_as(public_api, "octo");
    fixture.respond(&listed, ok(json!([candidate])));
    workspace
        .save_source(
            &engine,
            "github",
            &config(json!({"repositories": ["o/one"]})),
        )
        .unwrap();

    fixture.respond(&listed, ok(json!([candidate])));
    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert!(report.imported.is_empty());
    assert!(report.failures.iter().any(|failure| {
        failure.reference.as_deref() == Some("T-KQ5")
            && failure.message.contains("reconcile-github")
    }));
    workspace.take_ownership("T-KQ5", None).unwrap();
    fixture.respond(&listed, ok(json!([candidate])));
    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert!(report.imported.is_empty());
    assert!(report.failures.iter().any(|failure| {
        failure.reference.as_deref() == Some("T-KQ5")
            && failure.message.contains("reconcile-github")
    }));
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    assert_eq!(workspace.show_ticket("T-KQ5").unwrap().title, "Saved issue");
    assert_eq!(
        workspace.export().unwrap()["external_identities"][0]["external_id"],
        "@:5"
    );

    let requests_before = fixture.urls().len();
    for wrong_url in [
        "https://elsewhere.example/o/one/issues/12",
        "https://github.com/o/one/pull/12",
    ] {
        assert!(
            workspace
                .reconcile_github_issue(&engine, "T-KQ5", wrong_url)
                .is_err()
        );
    }
    assert_eq!(fixture.urls().len(), requests_before);
    let read = format!("{public_api}/repos/o/one/issues/12");
    let issue_url = "https://github.com/o/one/issues/12";
    for answer in [issue(8, 12, "o/one"), issue(5, 13, "o/one")] {
        fixture.respond(&read, ok(answer));
        assert!(
            workspace
                .reconcile_github_issue(&engine, "T-KQ5", issue_url)
                .unwrap_err()
                .to_string()
                .contains("saved issue ID")
        );
    }
    let before = workspace.show_ticket("T-KQ5").unwrap();
    fixture.respond(&read, ok(candidate.clone()));
    let recovered = workspace
        .reconcile_github_issue(&engine, "T-KQ5", issue_url)
        .unwrap();
    assert_eq!(recovered.id, before.id);
    assert_eq!(recovered.title, before.title);
    assert_eq!(recovered.body, before.body);
    assert_eq!(recovered.status, before.status);
    let source = recovered.source.unwrap();
    assert_eq!(source.id, "5");
    assert_eq!(source.url, issue_url);
    assert_eq!(source.ownership, crate::source::Ownership::Local);
    fixture.respond(&listed, ok(json!([candidate])));
    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert!(report.failures.is_empty());
    assert!(report.imported.is_empty());
    assert_eq!(workspace.show_ticket("T-KQ5").unwrap().title, "Saved issue");
}

#[test]
fn a_legacy_issue_at_a_different_location_waits_for_explicit_confirmation() {
    let folder = tempfile::tempdir().unwrap();
    let mut workspace = unverified_github_workspace(&folder.path().join("legacy.db"));
    let project = workspace
        .create_project("Original project", folder.path().to_str().unwrap())
        .unwrap();
    workspace
        .change_ticket(
            "T-KQ5",
            crate::TicketPatch {
                project_id: Some(Some(project.id.clone())),
                ..Default::default()
            },
        )
        .unwrap();
    let (fixture, engine) = setup(Some(TOKEN));
    let candidate = issue(5, 17, "o/other");
    let listed = format!("{API}/repos/o/other/issues?state=open&per_page=100");
    fixture.authenticate_as(API, "octo");
    fixture.respond(&listed, ok(json!([candidate])));
    workspace
        .save_source(
            &engine,
            "github",
            &config(json!({"repositories": ["o/other"]})),
        )
        .unwrap();
    fixture.respond(&listed, ok(json!([candidate])));
    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert!(report.imported.is_empty());
    assert!(report.failures.iter().any(|failure| {
        failure.reference.as_deref() == Some("T-KQ5")
            && failure.message.contains("reconcile-github")
    }));
    assert_eq!(workspace.show_ticket("T-KQ5").unwrap().title, "Saved issue");
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);

    fixture.respond(
        &format!("{API}/repos/o/other/issues/17"),
        ok(candidate.clone()),
    );
    let verified = workspace
        .reconcile_github_issue(
            &engine,
            "T-KQ5",
            "https://api.example.test/o/other/issues/17",
        )
        .unwrap();
    assert_eq!(verified.title, "Saved issue");
    assert_eq!(verified.project_id.as_deref(), Some(project.id.as_str()));
    let source = verified.source.unwrap();
    assert_eq!(source.id, "@api.example.test:5");
    assert_eq!(source.locator, "o/other#17");
    assert_eq!(source.display, "o/other#17");
    assert_eq!(source.url, "https://api.example.test/o/other/issues/17");
    assert_eq!(source.ownership, crate::source::Ownership::External);
    assert_eq!(
        workspace.export().unwrap()["external_identities"][0]["repository"],
        "api.example.test/o/other"
    );
    fixture.respond(&listed, ok(json!([candidate])));
    for suffix in ["comments", "events"] {
        fixture.respond(
            &format!("{API}/repos/o/other/issues/17/{suffix}?per_page=100"),
            ok(json!([])),
        );
    }
    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert!(report.failures.is_empty());
    assert!(report.imported.is_empty());
    assert_eq!(workspace.show_ticket("T-KQ5").unwrap().title, "Issue 17");
}

#[test]
fn a_confirmed_identity_keeps_its_ticket_when_an_unverified_id_also_matches() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("legacy.db");
    let mut workspace = unverified_github_workspace(&path);
    // An older workspace could already have imported the now-verified issue.
    rusqlite::Connection::open(&path).unwrap().execute_batch(
        "INSERT INTO tickets (id, reference, title, status) VALUES ('verified', 'T-KQ6', 'Verified issue', 'Todo');
         INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin)
         VALUES ('verified', 'github', '@api.example.test:5', 'o/other#17', 'o/other#17', 'https://api.example.test/o/other/issues/17', 'imported');
         INSERT INTO external_ownership (ticket_id, authority) VALUES ('verified', 'local');
         INSERT INTO source_sync (ticket_id, state_category) VALUES ('verified', 'open');",
    ).unwrap();
    let (fixture, engine) = setup(Some(TOKEN));
    let issue = issue(5, 17, "o/other");
    let listed = format!("{API}/repos/o/other/issues?state=open&per_page=100");
    fixture.authenticate_as(API, "octo");
    fixture.respond(&listed, ok(json!([issue])));
    workspace
        .save_source(
            &engine,
            "github",
            &config(json!({"repositories": ["o/other"]})),
        )
        .unwrap();
    fixture.respond(&listed, ok(json!([issue])));
    let refresh = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert!(refresh.imported.is_empty());
    assert!(
        refresh
            .failures
            .iter()
            .all(|failure| failure.scope != crate::source::FailureScope::Partition)
    );

    fixture.respond(&format!("{API}/repos/o/other/issues/17"), ok(issue));
    let failure = workspace
        .reconcile_github_issue(
            &engine,
            "T-KQ5",
            "https://api.example.test/o/other/issues/17",
        )
        .unwrap_err();
    assert!(failure.to_string().contains("already linked to T-KQ6"));
    let legacy = workspace.show_ticket("T-KQ5").unwrap().source.unwrap();
    assert_eq!(legacy.id, "@:5");
    assert_eq!(legacy.locator, "O/One#12");
}

#[test]
fn holding_a_legacy_match_defers_first_read_for_its_repository_only() {
    use crate::{WorkspaceActor, WorkspaceEventType};

    let folder = tempfile::tempdir().unwrap();
    let mut workspace = unverified_github_workspace(&folder.path().join("legacy.db"));
    let head = workspace.workspace_event_head().unwrap();
    let public_api = "https://api.github.com";
    let (public, public_engine) = setup_at(public_api, Some(TOKEN));
    let one = format!("{public_api}/repos/o/other/issues?state=open&per_page=100&labels=bug");
    let two = format!("{public_api}/repos/o/two/issues?state=open&per_page=100&labels=bug");
    let held = issue(5, 16, "o/other");
    let first = issue(6, 13, "o/other");
    let mut new = issue(7, 14, "o/two");
    new["created_at"] = json!("2026-01-02T00:00:00Z");

    public.authenticate_as(public_api, "octo");
    public.respond(&one, ok(json!([held, first])));
    public.respond(&two, ok(json!([])));
    workspace
        .save_source(
            &public_engine,
            "github",
            &config(json!({"repositories": ["o/other", "o/two"], "labels": ["bug"]})),
        )
        .unwrap();
    let conversation = |locator: &str| {
        for suffix in ["comments", "events"] {
            public.respond(
                &format!("{public_api}/repos/{locator}/{suffix}?per_page=100"),
                ok(json!([])),
            );
        }
    };
    public.respond(&one, ok(json!([held, first])));
    public.respond(&two, ok(json!([])));
    conversation("o/other/issues/13");
    let refresh = workspace
        .refresh_connection(&public_engine, "github", &Default::default())
        .unwrap();
    assert_eq!(refresh.imported.len(), 1);
    assert_eq!(workspace.workspace_events_after(head, 100).unwrap(), []);

    let (enterprise, enterprise_engine) = setup(Some(TOKEN));
    enterprise.authenticate_as(API, "octo");
    enterprise.respond(
        &format!("{API}/repos/o/one/issues?state=open&per_page=100"),
        ok(json!([])),
    );
    workspace
        .add_source_connection(
            &enterprise_engine,
            "github",
            None,
            None,
            &config(json!({"repositories": ["o/one"]})),
        )
        .unwrap();
    enterprise.respond(
        &format!("{API}/repos/o/one/issues/12"),
        ok(issue(5, 12, "o/one")),
    );
    workspace
        .reconcile_github_issue(
            &enterprise_engine,
            "T-KQ5",
            "https://api.example.test/o/one/issues/12",
        )
        .unwrap();
    public.respond(&one, ok(json!([held, first])));
    public.respond(&two, ok(json!([new])));
    conversation("o/other/issues/16");
    conversation("o/two/issues/14");
    let refresh = workspace
        .refresh_connection(&public_engine, "github", &Default::default())
        .unwrap();
    assert_eq!(refresh.imported.len(), 2);
    assert!(workspace.list_tickets().unwrap().into_iter().any(|ticket| {
        ticket
            .source
            .is_some_and(|source| source.id == "5" && source.locator == "o/other#16")
    }));

    let events = workspace.workspace_events_after(head, 100).unwrap();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].current.as_ref().unwrap()["title"], "Issue 14");
    assert_eq!(events[0].actor, WorkspaceActor::Sync);
    assert_eq!(events[0].kind, WorkspaceEventType::TicketCreated);
}

#[test]
fn adding_a_repository_checks_it_even_when_the_first_repository_fills_the_preview() {
    let folder = tempfile::tempdir().unwrap();
    let mut workspace = crate::Workspace::open(folder.path().join("workspace.db")).unwrap();
    let (fixture, engine) = setup(Some(TOKEN));
    let config = config(json!({"repositories": ["o/one"]}));
    let first = format!("{API}/repos/o/one/issues?state=open&per_page=100");
    let second = format!("{API}/repos/o/one/issues?page=2");
    let target = format!("{API}/repos/o/target/issues?state=open&per_page=100");
    let validate_account = || {
        fixture.respond(
            &format!("{API}/user"),
            ok(json!({"login": "octo", "id": 1})),
        )
    };
    validate_account();
    fixture.respond(&first, ok(json!([])));
    let saved = workspace
        .save_source(&engine, "github", &config)
        .unwrap()
        .source;
    let project = workspace
        .create_project_with_remote(
            "Target",
            folder.path().to_str().unwrap(),
            Some("api.example.test/o/target"),
        )
        .unwrap();
    let preview = workspace
        .preview_connect_source(&engine, "github", &project.id)
        .unwrap();

    validate_account();
    fixture.respond(
        &first,
        ok_with(
            json!(
                (1..=100)
                    .map(|id| issue(id, id, "o/one"))
                    .collect::<Vec<_>>()
            ),
            &[("link", &format!("<{second}>; rel=\"next\""))],
        ),
    );
    fixture.respond(
        &second,
        ok(json!(
            (101..=200)
                .map(|id| issue(id, id, "o/one"))
                .collect::<Vec<_>>()
        )),
    );
    validate_account();
    fixture.respond(&target, status(404, json!({"message": "Not Found"}), &[]));

    let refused = workspace
        .connect_source(&engine, "github", &project.id, &preview.fingerprint)
        .unwrap_err();
    assert!(refused.to_string().contains("o/target"));
    assert_eq!(workspace.saved_source("github").unwrap(), Some(saved));
    assert!(fixture.urls().contains(&target));
}

#[test]
fn discovery_pages_through_every_repository_and_skips_pull_requests() {
    let (fixture, engine) = setup(Some(TOKEN));
    let first = format!("{API}/repos/o/one/issues?state=open&per_page=100");
    let second = format!("{API}/repos/o/one/issues?page=2");
    let third = format!("{API}/repos/o/two/issues?state=open&per_page=100");
    let mut pull_request = issue(2, 2, "o/one");
    pull_request["pull_request"] = json!({"url": "x"});
    fixture.respond(
        &first,
        ok_with(
            json!([issue(1, 1, "o/one"), pull_request]),
            &[(
                "link",
                &format!("<{second}>; rel=\"next\", <{API}/last>; rel=\"last\""),
            )],
        ),
    );
    // A deleted account's issue has no user.
    let mut orphaned = issue(3, 3, "o/one");
    orphaned["user"] = Value::Null;
    fixture.respond(&second, ok(json!([orphaned])));
    fixture.respond(&third, ok(json!([issue(4, 1, "o/two")])));

    let issues = discover_all(
        &engine,
        &config(json!({"repositories": ["o/one", "o/two"]})),
    )
    .unwrap();

    let displays: Vec<_> = issues.iter().map(|i| i.display.as_str()).collect();
    assert_eq!(displays, ["o/one#1", "o/one#3", "o/two#1"]);
    assert_eq!(
        issues[0].repository.as_deref(),
        Some("api.example.test/o/one")
    );
    assert_eq!(
        issues[2].repository.as_deref(),
        Some("api.example.test/o/two")
    );
    assert_eq!(issues[0].reference.identity.id, "@api.example.test:1");
    assert_eq!(issues[0].assignees, ["octo"]);
    assert_eq!(issues[0].labels, ["bug", "plain"]);
    assert_eq!(issues[0].author.as_deref(), Some("alice"));
    assert_eq!(issues[0].created_at, "2026-01-01T00:00:00Z");
    assert_eq!(issues[1].author.as_deref(), Some("ghost"));
    assert_eq!(fixture.urls(), [first, second, third]);
}

#[test]
fn assignee_and_labels_become_query_filters_and_are_encoded() {
    let (fixture, engine) = setup(Some(TOKEN));
    let url = format!(
        "{API}/repos/o/one/issues?state=open&per_page=100&assignee=octo&labels=good%20first%20issue,bug"
    );
    fixture.respond(&url, ok(json!([])));

    let values = config(json!({
        "repositories": ["o/one"], "assignee": "octo", "labels": ["good first issue", "bug"]
    }));
    assert!(discover_all(&engine, &values).unwrap().is_empty());
    assert_eq!(fixture.urls(), [url]);
}

#[test]
fn a_page_of_only_pull_requests_does_not_end_discovery() {
    let (fixture, engine) = setup(Some(TOKEN));
    let first = format!("{API}/repos/o/one/issues?state=open&per_page=100");
    let second = format!("{API}/repos/o/one/issues?page=2");
    let mut pull_request = issue(1, 1, "o/one");
    pull_request["pull_request"] = json!({});
    fixture.respond(
        &first,
        ok_with(
            json!([pull_request]),
            &[("link", &format!("<{second}>; rel=\"next\""))],
        ),
    );
    fixture.respond(&second, ok(json!([issue(2, 2, "o/one")])));

    let issues = discover_all(&engine, &config(json!({"repositories": ["o/one"]}))).unwrap();
    assert_eq!(issues.len(), 1);
}

#[test]
fn closure_reasons_map_to_neutral_states() {
    let (fixture, engine) = setup(Some(TOKEN));
    for (reason, expected) in [
        (json!("completed"), StateCategory::Completed),
        (json!("not_planned"), StateCategory::NotPlanned),
        (json!("duplicate"), StateCategory::Duplicate),
        (json!(null), StateCategory::Unknown),
        (json!("something_new"), StateCategory::Unknown),
    ] {
        let mut closed = issue(7, 7, "o/one");
        closed["state"] = json!("closed");
        closed["state_reason"] = reason;
        fixture.respond(&format!("{API}/repos/o/one/issues/7"), ok(closed));
        let reference = ExternalRef {
            identity: ExternalIdentity {
                provider: "github".into(),
                id: "@api.example.test:7".into(),
            },
            locator: "o/one#7".into(),
            partition: "o/one".into(),
        };
        let fetched = engine
            .fetch(
                "github",
                &config(json!({"repositories": ["o/one"]})),
                &reference,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&fetched.state).unwrap(),
            json!({
                "category": expected.as_str(),
                "name": "Closed",
            }),
        );
    }
}

#[test]
fn fetch_reports_the_repository_a_transferred_issue_is_now_in() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/one/issues/7"),
        ok(issue(77, 12, "moved/away")),
    );
    let reference = ExternalRef {
        identity: ExternalIdentity {
            provider: "github".into(),
            id: "@api.example.test:77".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };

    let issue = engine
        .fetch(
            "github",
            &config(json!({"repositories": ["o/one"]})),
            &reference,
        )
        .unwrap();
    assert_eq!(
        issue.repository.as_deref(),
        Some("api.example.test/moved/away")
    );
}

#[test]
fn workspace_refresh_follows_a_github_transfer_that_changes_the_issue_id() {
    enum Case {
        Targeted,
        Discovery,
        DuringDiscovery,
        UnverifiedDuringDiscovery,
        SeparateIssueWithSameOpening,
        Collision,
        LocalCollision,
        ReusedPath,
        MissingOpening,
        ReplacedConfiguration,
    }
    for case in [
        Case::Targeted,
        Case::Discovery,
        Case::DuringDiscovery,
        Case::UnverifiedDuringDiscovery,
        Case::SeparateIssueWithSameOpening,
        Case::Collision,
        Case::LocalCollision,
        Case::ReusedPath,
        Case::MissingOpening,
        Case::ReplacedConfiguration,
    ] {
        let targeted = matches!(case, Case::Targeted);
        let collision = matches!(case, Case::Collision | Case::LocalCollision);
        let (fixture, engine) = setup_at(DEFAULT_API_URL, Some(TOKEN));
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("destination");
        std::fs::create_dir(&destination).unwrap();
        let mut workspace = crate::Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        let project = workspace
            .create_project_with_remote(
                "Original",
                dir.path().to_str().unwrap(),
                Some("github.com/o/one"),
            )
            .unwrap();
        let destination_project = workspace
            .create_project_with_remote(
                "Destination",
                destination.to_str().unwrap(),
                Some("github.com/o/two"),
            )
            .unwrap();
        let old = format!("{DEFAULT_API_URL}/repos/o/one/issues/7");
        let new = format!("{DEFAULT_API_URL}/repos/o/two/issues/12");
        let discovery =
            |repo| format!("{DEFAULT_API_URL}/repos/o/{repo}/issues?state=open&per_page=100");
        let respond_conversation = |base| {
            for part in ["comments", "events"] {
                fixture.respond(&format!("{base}/{part}?per_page=100"), ok(json!([])));
            }
        };
        let initial_destination = if collision {
            respond_conversation(new.as_str());
            json!([public_issue(99, 12, "o/two")])
        } else {
            json!([])
        };
        fixture.authenticate_as(DEFAULT_API_URL, "alice");
        let mut original_issue = public_issue(77, 7, "o/one");
        if matches!(case, Case::MissingOpening) {
            original_issue["created_at"] = Value::Null;
        }
        for _ in 0..2 {
            fixture.respond(&discovery("one"), ok(json!([original_issue.clone()])));
            fixture.respond(&discovery("two"), ok(initial_destination.clone()));
        }
        workspace
            .save_source(
                &engine,
                "github",
                &config(json!({"repositories": ["o/one", "o/two"]})),
            )
            .unwrap();
        respond_conversation(old.as_str());
        let initial = workspace
            .refresh_sources(&engine, &crate::source::RefreshOptions::default())
            .unwrap();
        let reference = &initial.imported[0];
        let original = workspace.show_ticket(reference).unwrap();
        assert_eq!(original.project_id.as_deref(), Some(project.id.as_str()));
        workspace
            .add_activity(reference, "Local note", None)
            .unwrap();
        let history = workspace.ticket_history(reference).unwrap();
        if matches!(case, Case::LocalCollision) {
            let destination_ref = &initial.imported[1];
            fixture.respond(&new, status(404, json!({}), &[]));
            workspace
                .refresh_sources(
                    &engine,
                    &crate::source::RefreshOptions {
                        ticket: Some(destination_ref.clone()),
                        ..Default::default()
                    },
                )
                .unwrap();
            workspace.take_ownership(destination_ref, None).unwrap();
            workspace
                .change_ticket(
                    destination_ref,
                    crate::TicketPatch {
                        title: Some("Local destination title".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }

        let mut moved = public_issue(99, 12, "o/two");
        moved["updated_at"] = json!("2026-01-03T00:00:00Z");
        moved["title"] = json!("Transferred issue");
        if matches!(case, Case::ReusedPath) {
            moved["created_at"] = json!("2026-01-02T00:00:00Z");
        } else if matches!(case, Case::DuringDiscovery) {
            moved["created_at"] = json!("2026-01-01T01:00:00+01:00");
        }
        match case {
            Case::UnverifiedDuringDiscovery => fixture.respond(&old, status(503, json!({}), &[])),
            Case::SeparateIssueWithSameOpening => fixture.respond(&old, ok(original_issue.clone())),
            _ => {
                fixture.respond(&old, status(301, json!({}), &[("location", &new)]));
                fixture.respond(&new, ok(moved.clone()));
            }
        }
        fixture.respond(
            &discovery("one"),
            ok(
                if matches!(
                    case,
                    Case::DuringDiscovery
                        | Case::UnverifiedDuringDiscovery
                        | Case::SeparateIssueWithSameOpening
                ) {
                    json!([original_issue])
                } else {
                    json!([])
                },
            ),
        );
        fixture.respond(&discovery("two"), ok(json!([moved])));
        respond_conversation(new.as_str());
        if matches!(case, Case::ReplacedConfiguration) {
            let db = dir.path().join("workspace.sqlite3");
            *fixture.on_request.lock().unwrap() = Some(RequestHook {
                url: old.clone(),
                run: Box::new(move || {
                    rusqlite::Connection::open(db).unwrap().execute(
                        "UPDATE source_connections SET configuration = json_set(configuration, '$.assignee', 'alice'), revision = 'changed' WHERE id = 'github'",
                        [],
                    ).unwrap();
                }),
            });
        }

        let report = workspace
            .refresh_sources(
                &engine,
                &crate::source::RefreshOptions {
                    ticket: targeted.then(|| reference.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        if matches!(case, Case::SeparateIssueWithSameOpening) {
            assert!(report.failures.is_empty());
            assert_eq!(report.imported.len(), 1);
            let new_ticket = workspace.show_ticket(&report.imported[0]).unwrap();
            assert_eq!(new_ticket.project_id, Some(destination_project.id));
            assert_eq!(
                workspace.show_ticket(reference).unwrap().source.unwrap().id,
                "77"
            );
            continue;
        }
        assert!(report.imported.is_empty(), "{:#?}", report.imported);
        let after = workspace.show_ticket(reference).unwrap();
        assert_eq!(after.id, original.id);
        assert_eq!(after.project_id, original.project_id);
        let source = after.source.unwrap();
        assert_eq!(workspace.activities(reference, 10, 0).unwrap().len(), 1);
        if matches!(case, Case::ReplacedConfiguration) {
            assert!(report.updated.is_empty());
            assert_eq!(source.id, "77");
            assert_eq!(workspace.list_tickets().unwrap().len(), 1);
            continue;
        }
        if matches!(case, Case::UnverifiedDuringDiscovery) {
            assert_eq!(report.failures.len(), 1);
            assert_eq!(
                report.failures[0].scope,
                crate::source::FailureScope::Partition
            );
            assert!(report.updated.is_empty());
            assert_eq!(source.id, "77");
            assert!(source.unavailable.is_none());
            assert_eq!(workspace.list_tickets().unwrap().len(), 1);
            continue;
        }
        if collision {
            let other = workspace.show_ticket(&initial.imported[1]).unwrap();
            assert_eq!(report.failures.len(), 1);
            assert!(report.failures[0].message.contains(&other.reference));
            assert_eq!(source.id, "77");
            assert!(source.unavailable.is_some());
            let other_source = other.source.unwrap();
            assert_eq!(other_source.id, "99");
            assert!(other_source.unavailable.is_none());
            if matches!(case, Case::LocalCollision) {
                assert!(report.updated.is_empty());
                assert_eq!(other_source.ownership, crate::source::Ownership::Local);
                assert_eq!(other.title, "Local destination title");
            } else {
                assert_eq!(
                    report.updated.as_slice(),
                    std::slice::from_ref(&other.reference)
                );
                assert_eq!(other.title, "Transferred issue");
            }
            assert_eq!(other.project_id, Some(destination_project.id));
            assert_eq!(workspace.list_tickets().unwrap().len(), 2);
            continue;
        }
        if matches!(case, Case::ReusedPath | Case::MissingOpening) {
            assert_eq!(report.failures.len(), 1);
            assert!(report.failures[0].message.contains("creation time"));
            assert!(report.updated.is_empty());
            assert_eq!(source.id, "77");
            assert!(source.unavailable.is_some());
            assert_eq!(after.title, original.title);
            assert_eq!(workspace.list_tickets().unwrap().len(), 1);
            continue;
        }
        assert!(report.failures.is_empty(), "{:#?}", report.failures);
        assert_eq!(report.updated, std::slice::from_ref(reference));
        assert_eq!(source.id, "99");
        assert_eq!(source.url, "https://github.com/o/two/issues/12");
        assert_eq!(source.discovery_matches, (!targeted).then_some(true));
        assert_eq!(workspace.ticket_history(reference).unwrap(), history);
        assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    }
}

/// A transport fixture that binds each test connection to its own account.
struct AccountFixtures {
    first: GithubConnector,
    second: Arc<Fixture>,
}

impl Connector for AccountFixtures {
    fn descriptor(&self) -> ConnectorDescriptor {
        self.first.descriptor()
    }

    fn for_connection(&self, id: &str, _: &ConfigValues) -> Option<Box<dyn Connector>> {
        (id == "github-2").then(|| {
            Box::new(connector_at(DEFAULT_API_URL, &self.second, Some(TOKEN))) as Box<dyn Connector>
        })
    }

    fn check_connection(&self, config: &ConfigValues) -> Result<ConnectionCheck, SourceError> {
        self.first.check_connection(config)
    }

    fn options(
        &self,
        field: &str,
        query: &str,
        config: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError> {
        self.first.options(field, query, config)
    }

    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        self.first.discover(request)
    }

    fn fetch(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        self.first.fetch(config, reference)
    }

    fn fetch_tracked(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<FetchedIssue, SourceError> {
        self.first.fetch_tracked(config, reference)
    }

    fn conversation(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Conversation, SourceError> {
        self.first.conversation(config, reference)
    }

    fn issue_site(&self) -> Option<&str> {
        self.first.issue_site()
    }

    fn publication(&self) -> Option<&dyn Publication> {
        self.first.publication()
    }
}

#[test]
fn a_transfer_observed_by_two_connections_keeps_one_ticket() {
    for verified in [true, false] {
        let original = Arc::new(Fixture::default());
        let destination = Arc::new(Fixture::default());
        original.authenticate_as(DEFAULT_API_URL, "alice");
        destination.authenticate_as(DEFAULT_API_URL, "bob");
        let mut engine = Engine::new();
        engine
            .register(Box::new(AccountFixtures {
                first: connector_at(DEFAULT_API_URL, &original, Some(TOKEN)),
                second: destination.clone(),
            }))
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mut workspace = crate::Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        let old_issue = public_issue(77, 7, "o/one");
        let new_issue = public_issue(99, 12, "o/two");
        let old = format!("{DEFAULT_API_URL}/repos/o/one/issues/7");
        let new = format!("{DEFAULT_API_URL}/repos/o/two/issues/12");
        let old_list = format!("{DEFAULT_API_URL}/repos/o/one/issues?state=open&per_page=100");
        let new_list = format!("{DEFAULT_API_URL}/repos/o/two/issues?state=open&per_page=100");
        original.respond(&old_list, ok(json!([old_issue])));
        destination.respond(&new_list, ok(json!([])));
        workspace
            .save_source(
                &engine,
                "github",
                &config(json!({"repositories": ["o/one"]})),
            )
            .unwrap();
        workspace
            .add_source_connection(
                &engine,
                "github",
                Some("github-2"),
                None,
                &config(json!({"repositories": ["o/two"]})),
            )
            .unwrap();

        original.respond(&old_list, ok(json!([old_issue])));
        for part in ["comments", "events"] {
            original.respond(&format!("{old}/{part}?per_page=100"), ok(json!([])));
        }
        let first = workspace
            .refresh_connection(&engine, "github", &Default::default())
            .unwrap();
        let reference = &first.imported[0];

        original.respond(&old_list, ok(json!([old_issue])));
        destination.respond(&new_list, ok(json!([new_issue])));
        if verified {
            original.respond(&old, status(301, json!({}), &[("location", &new)]));
            original.respond(&new, ok(new_issue));
            for part in ["comments", "events"] {
                original.respond(&format!("{new}/{part}?per_page=100"), ok(json!([])));
            }
        } else {
            original.respond(&old, status(503, json!({}), &[]));
        }
        let second = workspace
            .refresh_sources(&engine, &Default::default())
            .unwrap();
        assert!(second.imported.is_empty());
        let ticket = workspace.show_ticket(reference).unwrap();
        assert_eq!(workspace.list_tickets().unwrap().len(), 1);
        assert_eq!(
            ticket.source.unwrap().id,
            if verified { "99" } else { "77" }
        );
        if verified {
            assert_eq!(second.updated, std::slice::from_ref(reference));
        } else {
            assert!(second.failures.iter().any(|failure| {
                failure.scope == crate::source::FailureScope::Partition
                    && failure.reference.as_ref() == Some(reference)
            }));
        }
    }
}

#[test]
fn a_conflicting_legacy_github_account_does_not_abort_another_connections_refresh() {
    let legacy = Arc::new(Fixture::default());
    let healthy = Arc::new(Fixture::default());
    legacy.authenticate_account(DEFAULT_API_URL, "octo", 41);
    healthy.authenticate_as(DEFAULT_API_URL, "bob");
    let mut engine = Engine::new();
    engine
        .register(Box::new(AccountFixtures {
            first: connector_at(DEFAULT_API_URL, &legacy, Some(TOKEN)),
            second: healthy.clone(),
        }))
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = crate::Workspace::open(&path).unwrap();
    let legacy_list = format!("{DEFAULT_API_URL}/repos/o/legacy/issues?state=open&per_page=100");
    let healthy_list = format!("{DEFAULT_API_URL}/repos/o/healthy/issues?state=open&per_page=100");
    legacy.respond(&legacy_list, ok(json!([])));
    healthy.respond(&healthy_list, ok(json!([])));
    workspace
        .save_source(
            &engine,
            PROVIDER,
            &config(json!({"repositories": ["o/legacy"]})),
        )
        .unwrap();
    workspace
        .add_source_connection(
            &engine,
            PROVIDER,
            Some("github-2"),
            None,
            &config(json!({"repositories": ["o/healthy"]})),
        )
        .unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE source_connections SET account_key = 'octo' WHERE id = 'github'",
            [],
        )
        .unwrap();

    *legacy.on_request.lock().unwrap() = Some(RequestHook {
        url: legacy_list.clone(),
        run: Box::new(move || {
            let (renamed, renamed_engine) = setup_at(DEFAULT_API_URL, Some(TOKEN));
            renamed.authenticate_account(DEFAULT_API_URL, "octo-renamed", 41);
            renamed.respond(
                &format!("{DEFAULT_API_URL}/repos/o/renamed/issues?state=open&per_page=100"),
                ok(json!([])),
            );
            crate::Workspace::open(path)
                .unwrap()
                .add_source_connection(
                    &renamed_engine,
                    PROVIDER,
                    Some("github-3"),
                    None,
                    &config(json!({"repositories": ["o/renamed"]})),
                )
                .unwrap();
        }),
    });
    legacy.respond(&legacy_list, ok(json!([public_issue(77, 7, "o/legacy")])));
    healthy.respond(&healthy_list, ok(json!([public_issue(88, 8, "o/healthy")])));
    for (fixture, repo, issue) in [(&legacy, "legacy", 7), (&healthy, "healthy", 8)] {
        for part in ["comments", "events"] {
            fixture.respond(
                &format!("{DEFAULT_API_URL}/repos/o/{repo}/issues/{issue}/{part}?per_page=100"),
                ok(json!([])),
            );
        }
    }

    let report = workspace
        .refresh_sources(&engine, &Default::default())
        .unwrap();
    assert_eq!(report.failures.len(), 1);
    let conflict = &report.failures[0];
    assert_eq!(conflict.connection_id.as_deref(), Some("github"));
    assert_eq!(conflict.scope, crate::source::FailureScope::Source);
    assert!(conflict.message.contains("already connected"));
    assert_eq!(report.imported.len(), 1);
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    let ticket = workspace.show_ticket(&report.imported[0]).unwrap();
    assert_eq!(ticket.source.unwrap().id, "88");
    let status = workspace
        .source_statuses()
        .unwrap()
        .into_iter()
        .find(|source| source.connection_id.as_deref() == Some("github"))
        .unwrap();
    assert_eq!(status.error.unwrap().message, conflict.message);
}

#[test]
fn a_destination_only_refresh_defers_a_move_and_imports_unrelated_issues() {
    enum OriginRead {
        Moved,
        Unavailable,
        Unrelated,
        ReusedPath,
    }
    for observation in [
        OriginRead::Moved,
        OriginRead::Unavailable,
        OriginRead::Unrelated,
        OriginRead::ReusedPath,
    ] {
        let original = Arc::new(Fixture::default());
        let destination = Arc::new(Fixture::default());
        original.authenticate_as(DEFAULT_API_URL, "alice");
        destination.authenticate_as(DEFAULT_API_URL, "bob");
        let mut engine = Engine::new();
        engine
            .register(Box::new(AccountFixtures {
                first: connector_at(DEFAULT_API_URL, &original, Some(TOKEN)),
                second: destination.clone(),
            }))
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut workspace = crate::Workspace::open(&path).unwrap();
        let old_issue = public_issue(77, 7, "o/one");
        let new_issue = public_issue(99, 12, "o/two");
        let mut unrelated = public_issue(100, 13, "o/two");
        unrelated["created_at"] = json!("2026-01-02T00:00:00Z");
        let old = format!("{DEFAULT_API_URL}/repos/o/one/issues/7");
        let new = format!("{DEFAULT_API_URL}/repos/o/two/issues/12");
        let unrelated_url = format!("{DEFAULT_API_URL}/repos/o/two/issues/13");
        let old_list = format!("{DEFAULT_API_URL}/repos/o/one/issues?state=open&per_page=100");
        let new_list = format!("{DEFAULT_API_URL}/repos/o/two/issues?state=open&per_page=100");
        let old_repo = config(json!({"repositories": ["o/one"]}));
        let new_repo = config(json!({"repositories": ["o/two"]}));
        original.respond(&old_list, ok(json!([old_issue])));
        destination.respond(&new_list, ok(json!([])));
        workspace.save_source(&engine, PROVIDER, &old_repo).unwrap();
        workspace
            .add_source_connection(&engine, PROVIDER, Some("github-2"), None, &new_repo)
            .unwrap();

        original.respond(&old_list, ok(json!([old_issue])));
        for part in ["comments", "events"] {
            original.respond(&format!("{old}/{part}?per_page=100"), ok(json!([])));
        }
        let first = workspace
            .refresh_connection(&engine, "github", &Default::default())
            .unwrap();
        let reference = &first.imported[0];
        let original_requests = original.urls();

        let tracked_unrelated = if matches!(observation, OriginRead::ReusedPath) {
            destination.respond(&new_list, ok(json!([unrelated])));
            for part in ["comments", "events"] {
                destination.respond(
                    &format!("{unrelated_url}/{part}?per_page=100"),
                    ok(json!([])),
                );
            }
            let imported = workspace
                .refresh_connection(&engine, "github-2", &Default::default())
                .unwrap();
            unrelated["title"] = json!("Unrelated issue updated");
            unrelated["updated_at"] = json!("2026-01-04T00:00:00Z");
            Some(imported.imported[0].clone())
        } else {
            None
        };
        destination.respond(&new_list, ok(json!([new_issue, unrelated])));
        match observation {
            OriginRead::Moved => {
                destination.respond(&old, status(301, json!({}), &[("location", &new)]));
                destination.respond(&new, ok(new_issue.clone()));
            }
            OriginRead::Unavailable => destination.respond(&old, status(404, json!({}), &[])),
            OriginRead::ReusedPath => {
                destination.respond(
                    &old,
                    status(301, json!({}), &[("location", &unrelated_url)]),
                );
                destination.respond(&unrelated_url, ok(unrelated));
            }
            OriginRead::Unrelated => {
                destination.respond(&old, ok(old_issue));
                for part in ["comments", "events"] {
                    destination.respond(&format!("{new}/{part}?per_page=100"), ok(json!([])));
                }
            }
        }
        for part in ["comments", "events"] {
            destination.respond(
                &format!("{DEFAULT_API_URL}/repos/o/two/issues/13/{part}?per_page=100"),
                ok(json!([])),
            );
        }
        let second = workspace
            .refresh_connection(&engine, "github-2", &Default::default())
            .unwrap();
        assert_eq!(original.urls(), original_requests);
        assert!(destination.urls().contains(&old));
        let (listed_parts, partial): (String, Option<String>) = rusqlite::Connection::open(&path).unwrap().query_row(
            "SELECT read_partitions, partial_message FROM source_connection_status WHERE connection_id = 'github-2'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        if let Some(reference) = tracked_unrelated {
            assert!(second.imported.is_empty());
            assert!(
                partial.is_some_and(|message| message.contains("possible GitHub issue transfer"))
            );
            assert_eq!(second.updated, std::slice::from_ref(&reference));
            assert_eq!(
                workspace.show_ticket(&reference).unwrap().title,
                "Unrelated issue updated"
            );
            continue;
        }
        if matches!(observation, OriginRead::Unrelated) {
            assert_eq!(second.imported.len(), 2);
            assert_eq!(listed_parts, r#"["o/two"]"#);
            continue;
        }
        assert_eq!(second.imported.len(), 1);
        assert_eq!(listed_parts, "[]");
        assert_eq!(
            workspace
                .show_ticket(&second.imported[0])
                .unwrap()
                .source
                .unwrap()
                .id,
            "100",
        );
        assert_eq!(
            workspace.show_ticket(reference).unwrap().source.unwrap().id,
            "77"
        );

        original.respond(&old, status(301, json!({}), &[("location", &new)]));
        original.respond(&new, ok(new_issue));
        for part in ["comments", "events"] {
            original.respond(&format!("{new}/{part}?per_page=100"), ok(json!([])));
        }
        let third = workspace
            .refresh_connection(
                &engine,
                "github",
                &crate::source::RefreshOptions {
                    ticket: Some(reference.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(third.updated, std::slice::from_ref(reference));
        assert_eq!(
            workspace.show_ticket(reference).unwrap().source.unwrap().id,
            "99"
        );
        assert_eq!(workspace.list_tickets().unwrap().len(), 2);
    }
}

#[test]
fn tracked_fetch_resolves_an_enterprise_transfer_redirect_from_the_origin() {
    let api = "https://github.example.test/api/v3";
    let (fixture, engine) = setup_at(api, Some(TOKEN));
    let destination = format!("{api}/repos/o/two/issues/12");
    let mut item = issue(99, 12, "o/two");
    item["url"] = json!(destination);
    item["repository_url"] = json!(format!("{api}/repos/o/two"));
    item["html_url"] = json!("https://github.example.test/o/two/issues/12");
    fixture.respond(
        &format!("{api}/repos/o/one/issues/7"),
        status(
            301,
            json!({}),
            &[("location", "/api/v3/repos/o/two/issues/12")],
        ),
    );
    fixture.respond(&destination, ok(item));
    let reference = ExternalRef {
        identity: ExternalIdentity {
            provider: PROVIDER.into(),
            id: "@github.example.test:77".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    let fetched = engine
        .fetch_tracked(
            PROVIDER,
            &config(json!({"repositories": ["o/one"]})),
            &reference,
        )
        .unwrap();
    assert_eq!(fetched.transferred_from, Some(reference));
    assert_eq!(
        fetched.issue.reference.identity.id,
        "@github.example.test:99"
    );
}

#[test]
fn tracked_fetch_requires_permanent_redirect_to_the_corroborated_issue_path() {
    let values = config(json!({"repositories": ["o/one"]}));
    let reference = ExternalRef {
        identity: ExternalIdentity {
            provider: PROVIDER.into(),
            id: "77".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    let old = format!("{DEFAULT_API_URL}/repos/o/one/issues/7");
    let new = format!("{DEFAULT_API_URL}/repos/o/two/issues/12");
    let foreign = "https://api.other.example/repos/o/two/issues/12";
    for (redirect, target, number, repository) in [
        (200, old.as_str(), 12, "o/two"),
        (302, new.as_str(), 12, "o/two"),
        (301, new.as_str(), 13, "o/two"),
        (301, foreign, 12, "o/two"),
    ] {
        let (fixture, engine) = setup_at(DEFAULT_API_URL, Some(TOKEN));
        if redirect != 200 {
            fixture.respond(&old, status(redirect, json!({}), &[("location", target)]));
        }
        fixture.respond(target, ok(public_issue(99, number, repository)));
        assert!(
            matches!(
                engine.fetch_tracked(PROVIDER, &values, &reference),
                Err(SourceError::Protocol(_))
            ),
            "{redirect} to {target}"
        );
        assert!(!fixture.urls().iter().any(|url| url == foreign));
    }
}

#[test]
fn stale_discovery_cannot_reimport_or_overwrite_an_issue_after_an_overlapping_transfer() {
    use crate::{Workspace, source::RefreshOptions};

    let initial_at = "2026-02-01T00:00:00Z";
    let stale_at = "2026-02-02T00:00:00Z";
    let fresh_at = "2026-02-03T00:00:00Z";
    for stale_destination in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut workspace = Workspace::open(&path).unwrap();
        let (fixture, engine) = setup_at(DEFAULT_API_URL, Some(TOKEN));
        let discovery = |repository: &str| {
            format!("{DEFAULT_API_URL}/repos/o/{repository}/issues?state=open&per_page=100")
        };
        let old = format!("{DEFAULT_API_URL}/repos/o/one/issues/7");
        let new = format!("{DEFAULT_API_URL}/repos/o/two/issues/12");
        let original = public_issue(77, 7, "o/one");
        let mut latest = public_issue(99, 12, "o/two");
        latest["title"] = json!("Fresh observation");
        fixture.authenticate_as(DEFAULT_API_URL, "alice");
        for _ in 0..2 {
            fixture.respond(&discovery("one"), ok(json!([original])));
            fixture.respond(&discovery("two"), ok(json!([])));
            for part in ["comments", "events"] {
                fixture.respond(&format!("{old}/{part}?per_page=100"), ok(json!([])));
            }
        }
        workspace
            .save_source(
                &engine,
                PROVIDER,
                &config(json!({"repositories": ["o/one", "o/two"]})),
            )
            .unwrap();
        let initial = workspace
            .refresh_sources(
                &engine,
                &RefreshOptions {
                    now: Some(initial_at.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let reference = initial.imported[0].clone();

        let (transfer, transfer_engine) = setup_at(DEFAULT_API_URL, Some(TOKEN));
        transfer.authenticate_as(DEFAULT_API_URL, "alice");
        transfer.respond(&old, status(301, json!({}), &[("location", &new)]));
        transfer.respond(&new, ok(latest.clone()));
        for part in ["comments", "events"] {
            transfer.respond(&format!("{new}/{part}?per_page=100"), ok(json!([])));
        }

        let overlap_at = if stale_destination {
            let mut older = latest.clone();
            older["title"] = json!("Stale observation");
            fixture.respond(&discovery("one"), ok(json!([])));
            fixture.respond(&discovery("two"), ok(json!([older])));
            fixture.respond(&old, status(301, json!({}), &[("location", &new)]));
            fixture.respond(&new, ok(older));
            new
        } else {
            fixture.respond(&discovery("one"), ok(json!([original])));
            fixture.respond(&discovery("two"), ok(json!([])));
            discovery("one")
        };
        let tracked = reference.clone();
        *fixture.on_request.lock().unwrap() = Some(RequestHook {
            url: overlap_at,
            run: Box::new(move || {
                let mut overlapping = Workspace::open(path).unwrap();
                let report = overlapping
                    .refresh_sources(
                        &transfer_engine,
                        &RefreshOptions {
                            ticket: Some(tracked.clone()),
                            now: Some(fresh_at.into()),
                        },
                    )
                    .unwrap();
                assert!(report.failures.is_empty());
                assert_eq!(report.updated, [tracked]);
            }),
        });
        let stale = workspace
            .refresh_sources(
                &engine,
                &RefreshOptions {
                    now: Some(stale_at.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(stale.failures.is_empty());
        assert!(stale.imported.is_empty(), "{:#?}", stale.imported);
        assert_eq!(workspace.list_tickets().unwrap().len(), 1);
        let ticket = workspace.show_ticket(&reference).unwrap();
        let source = ticket.source.unwrap();
        assert_eq!(source.id, "99");
        assert_eq!(source.last_refreshed_at.as_deref(), Some(fresh_at));
        assert_eq!(source.last_attempt_at.as_deref(), Some(fresh_at));
        assert_eq!(source.ownership, crate::source::Ownership::External);
        assert_eq!(ticket.title, "Fresh observation");
    }
}

#[test]
fn fetch_refuses_a_pull_request_and_a_different_identity() {
    let (fixture, engine) = setup(Some(TOKEN));
    let values = config(json!({"repositories": ["o/one"]}));
    let reference = |id: &str| ExternalRef {
        identity: ExternalIdentity {
            provider: "github".into(),
            id: id.into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    let mut pull_request = issue(7, 7, "o/one");
    pull_request["pull_request"] = json!({});
    fixture.respond(&format!("{API}/repos/o/one/issues/7"), ok(pull_request));
    assert!(matches!(
        engine.fetch("github", &values, &reference("@api.example.test:7")),
        Err(SourceError::NotFound(_))
    ));
    fixture.respond(
        &format!("{API}/repos/o/one/issues/7"),
        ok(issue(8, 7, "o/one")),
    );
    assert!(matches!(
        engine.fetch("github", &values, &reference("@api.example.test:7")),
        Err(SourceError::Protocol(_))
    ));
}

#[test]
fn failures_are_classified_and_never_contain_the_token() {
    let url = format!("{API}/repos/o/one/issues?state=open&per_page=100");
    let values = config(json!({"repositories": ["o/one"]}));
    let cases: Vec<(Result<HttpResponse, TransportError>, &str)> = vec![
        (
            status(401, json!({"message": "Bad credentials"}), &[]),
            "unauthenticated",
        ),
        (
            status(
                403,
                json!({"message": "x"}),
                &[("x-ratelimit-remaining", "0")],
            ),
            "rate_limited",
        ),
        (
            status(429, json!({}), &[("retry-after", "30")]),
            "rate_limited",
        ),
        (status(503, json!({}), &[]), "unavailable"),
        (Err("connection refused".into()), "unavailable"),
        (
            Ok(HttpResponse {
                status: 200,
                body: b"<html>".to_vec(),
                ..HttpResponse::default()
            }),
            "protocol",
        ),
    ];
    for (response, code) in cases {
        let (fixture, engine) = setup(Some(TOKEN));
        fixture.respond(&url, response);
        let error = discover_all(&engine, &values).unwrap_err();
        assert_eq!(error.code(), code, "{error}");
        assert!(!error.to_string().contains(TOKEN));
        assert!(!format!("{error:?}").contains(TOKEN));
    }
}

#[test]
fn the_built_in_connector_is_accepted_by_the_registration_check_it_skips() {
    let mut engine = Engine::new();
    assert!(
        engine
            .register(Box::new(GithubConnector::ambient()))
            .is_ok()
    );
    assert_eq!(Engine::builtin().connectors().len(), 1);
}

#[test]
fn a_gone_issue_is_not_found_not_an_unusable_answer() {
    let (fixture, engine) = setup(Some(TOKEN));
    let values = config(json!({"repositories": ["o/one"]}));
    let reference = ExternalRef {
        identity: ExternalIdentity {
            provider: "github".into(),
            id: "@api.example.test:7".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    for code in [404, 410] {
        fixture.respond(
            &format!("{API}/repos/o/one/issues/7"),
            status(code, json!({"message": "This issue was deleted"}), &[]),
        );
        let error = engine.fetch("github", &values, &reference).unwrap_err();
        assert_eq!(error.code(), "not_found", "status {code}");
    }
}

#[test]
fn an_inaccessible_repository_is_skipped_and_the_next_one_still_discovered() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/gone/issues?state=open&per_page=100"),
        status(404, json!({"message": "Not Found"}), &[]),
    );
    fixture.respond(
        &format!("{API}/repos/o/live/issues?state=open&per_page=100"),
        ok(json!([issue(1, 1, "o/live")])),
    );
    let values = config(json!({"repositories": ["o/gone", "o/live"]}));
    let mut found = Vec::new();
    let summary = engine
        .discover("github", &values, |issue| {
            found.push(issue.display);
            ControlFlow::Continue(())
        })
        .unwrap();
    assert_eq!(found, ["o/live#1"]);
    assert_eq!(summary.skipped.len(), 1);
    assert_eq!(summary.skipped[0].code, "not_found");
    assert_eq!(
        summary.skipped[0].message,
        "o/gone was not found, or your account cannot see it"
    );
    // A repository closed to the account is skipped the same way, with its own code.
    fixture.respond(
        &format!("{API}/repos/o/gone/issues?state=open&per_page=100"),
        status(403, json!({"message": "Resource not accessible"}), &[]),
    );
    fixture.respond(
        &format!("{API}/repos/o/live/issues?state=open&per_page=100"),
        ok(json!([])),
    );
    let summary = engine
        .discover("github", &values, |_| ControlFlow::Continue(()))
        .unwrap();
    assert_eq!(summary.skipped[0].code, "forbidden");
    // Saving rules that name an unreadable repository is still refused.
    fixture.respond(
        &format!("{API}/user"),
        ok(json!({"login": "octo", "id": 1})),
    );
    fixture.respond(
        &format!("{API}/repos/o/gone/issues?state=open&per_page=100"),
        status(404, json!({"message": "Not Found"}), &[]),
    );
    fixture.respond(
        &format!("{API}/repos/o/live/issues?state=open&per_page=100"),
        ok(json!([])),
    );
    // The refusal points at the repositories field and names the repository once.
    let error = engine.preview("github", &values).unwrap_err();
    assert_eq!(error.issues().len(), 1);
    assert_eq!(error.issues()[0].field.as_deref(), Some("repositories"));
    assert_eq!(
        error.issues()[0].message,
        "cannot be used: o/gone was not found, or your account cannot see it"
    );
}

/// The repositories asked for, the one an issue is in and a skipped one are named
/// alike, whatever case the settings use: ticketd compares them to tell a
/// repository's first read.
#[test]
fn a_repository_has_one_name_as_a_part_of_the_source() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/user"),
        ok(json!({"login": "octo", "id": 1})),
    );
    fixture.respond(
        &format!("{API}/repos/O/Gone/issues?state=open&per_page=100"),
        status(404, json!({"message": "Not Found"}), &[]),
    );
    fixture.respond(
        &format!("{API}/repos/o/Live/issues?state=open&per_page=100"),
        ok(json!([issue(1, 1, "o/Live")])),
    );
    let values = config(json!({"repositories": ["O/Gone", "o/Live"]}));
    let mut found = Vec::new();
    let summary = engine
        .discover("github", &values, |issue| {
            found.push(issue.reference.partition);
            ControlFlow::Continue(())
        })
        .unwrap();
    assert_eq!(
        engine.check("github", &values).unwrap().derived.partitions,
        ["@api.example.test/o/gone", "@api.example.test/o/live"]
    );
    assert_eq!(found, ["@api.example.test/o/live"]);
    assert_eq!(summary.skipped[0].partition, "@api.example.test/o/gone");
}

/// A repository is read under its assignee and labels, named alike whatever their
/// case or order, and by its bare name when neither narrows discovery.
#[test]
fn a_repository_is_read_under_its_assignee_and_labels() {
    let (fixture, engine) = setup(Some(TOKEN));
    let scope = |values: serde_json::Value| {
        fixture.respond(
            &format!("{API}/user"),
            ok(json!({"login": "octo", "id": 1})),
        );
        engine
            .check("github", &config(values))
            .unwrap()
            .derived
            .discovery_scope
    };
    assert_eq!(scope(json!({"repositories": ["o/r"]})), "");
    assert_eq!(
        scope(json!({"repositories": ["o/r"], "assignee": "Octo", "labels": ["Bug", "a"]})),
        "assignee=octo&labels=a,bug"
    );
    assert_eq!(
        scope(json!({"repositories": ["o/r"], "assignee": "octo", "labels": ["bug", "A"]})),
        "assignee=octo&labels=a,bug"
    );
}

#[test]
fn a_credential_is_never_sent_over_plain_http_except_to_this_machine() {
    for (url, allowed) in [
        ("https://ghe.corp.example/api/v3", true),
        ("http://ghe.corp.example/api/v3", false),
        ("http://localhost:8080", true),
        ("http://127.0.0.1:9", true),
        ("http://localhost.evil.example", false),
    ] {
        assert_eq!(credential_may_travel(url), allowed, "{url}");
    }
    let fixture = Arc::new(Fixture::default());
    let connector = GithubConnector::new(
        "http://ghe.corp.example/api/v3",
        Box::new(Shared(fixture.clone())),
        Box::new(Token(Some(TOKEN))),
    );
    let mut engine = Engine::new();
    engine.register(Box::new(connector)).unwrap();
    let error = engine
        .check_connection("github", &config(json!({"repositories": ["o/one"]})))
        .unwrap_err();
    assert_eq!(error.code(), "invalid_configuration");
    assert!(fixture.urls().is_empty(), "nothing was sent");
}

#[test]
fn rate_limit_reports_when_to_retry() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/one/issues?state=open&per_page=100"),
        status(429, json!({}), &[("retry-after", "42")]),
    );
    let error = discover_all(&engine, &config(json!({"repositories": ["o/one"]}))).unwrap_err();
    assert!(matches!(
        error,
        SourceError::RateLimited {
            retry_after_secs: Some(42)
        }
    ));
    assert!(error.to_string().contains("42 seconds"));
}

#[test]
fn a_missing_credential_fails_before_any_request() {
    let (fixture, engine) = setup(None);
    let error = engine
        .check_connection("github", &ConfigValues::new())
        .unwrap_err();
    assert_eq!(error.code(), "unauthenticated");
    assert!(error.to_string().contains("gh auth login"));
    assert!(fixture.urls().is_empty());
}

#[test]
fn the_credential_is_sent_only_to_the_api_and_redirects_stay_there() {
    let (fixture, engine) = setup(Some(TOKEN));
    let url = format!("{API}/repos/o/one/issues?state=open&per_page=100");
    let moved = format!("{API}/repositories/9/issues?state=open&per_page=100");
    fixture.respond(
        &url,
        ok_with(json!({}), &[("location", &moved)]).map(|mut r| {
            r.status = 301;
            r
        }),
    );
    fixture.respond(&moved, ok(json!([])));
    let values = config(json!({"repositories": ["o/one"]}));
    discover_all(&engine, &values).unwrap();
    for request in fixture.requests.lock().unwrap().iter() {
        assert!(request.url.starts_with(API));
        assert!(
            request
                .headers
                .iter()
                .any(|(k, v)| k == "Authorization" && v == &format!("Bearer {TOKEN}"))
        );
    }

    // A redirect, or a forged paging link, to another host is refused unsent.
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &url,
        ok_with(json!({}), &[("location", "https://evil.example/steal")]).map(|mut r| {
            r.status = 302;
            r
        }),
    );
    assert_eq!(
        discover_all(&engine, &values).unwrap_err().code(),
        "protocol"
    );
    assert_eq!(fixture.urls(), std::slice::from_ref(&url));

    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &url,
        ok_with(
            json!([]),
            &[("link", "<https://evil.example/next>; rel=\"next\"")],
        ),
    );
    assert_eq!(
        discover_all(&engine, &values).unwrap_err().code(),
        "protocol"
    );
    assert_eq!(fixture.urls(), [url]);
}

#[test]
fn a_legacy_github_login_pins_the_account_before_it_can_be_renamed() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.authenticate_account(API, "octo", 41);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = crate::Workspace::open(&path).unwrap();
    let listed = format!("{API}/repos/o/one/issues?state=open&per_page=100");
    let settings = config(json!({"repositories": ["o/one"], "account": "octo"}));
    fixture.respond(&listed, ok(json!([])));
    workspace.save_source(&engine, PROVIDER, &settings).unwrap();
    let database = rusqlite::Connection::open(&path).unwrap();
    let saved_id = || {
        database
            .query_row(
                "SELECT account_key FROM source_connections WHERE id = 'github'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
    };
    assert_eq!(saved_id(), "id:41");
    database
        .execute(
            "UPDATE source_connections SET account_key = 'octo' WHERE id = 'github'",
            [],
        )
        .unwrap();

    fixture.respond(&listed, ok(json!([])));
    let duplicate = workspace
        .add_source_connection(&engine, PROVIDER, None, None, &settings)
        .unwrap_err();
    assert!(duplicate.to_string().contains("already connected"));

    fixture.authenticate_account(API, "octo-renamed", 41);
    assert!(workspace.test_source_connection(&engine, "github").is_err());
    assert_eq!(saved_id(), "octo");

    fixture.authenticate_account(API, "octo", 41);
    fixture.respond(&listed, ok(json!([])));
    assert!(
        workspace
            .refresh_connection(&engine, "github", &Default::default())
            .unwrap()
            .failures
            .is_empty()
    );
    assert_eq!(saved_id(), "id:41");

    fixture.authenticate_account(API, "octo-renamed", 41);
    fixture.respond(&listed, ok(json!([])));
    assert!(
        workspace
            .refresh_connection(&engine, "github", &Default::default())
            .unwrap()
            .failures
            .is_empty()
    );
    assert_eq!(
        workspace.saved_source("github").unwrap().unwrap().account,
        "octo-renamed"
    );
    fixture.respond(&listed, ok(json!([])));
    let preview = workspace
        .preview_source(&engine, PROVIDER, Some("github"), &settings)
        .unwrap();
    assert_eq!(preview.account, "octo-renamed");
    fixture.respond(&listed, ok(json!([])));
    workspace
        .update_source_connection(&engine, "github", &settings)
        .unwrap();

    fixture.authenticate_account(API, "octo", 57);
    assert!(workspace.test_source_connection(&engine, "github").is_err());
    assert_eq!(saved_id(), "id:41");
}

#[test]
fn connection_check_names_the_account_and_preview_lists_matches() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/user"),
        ok(json!({"login": "octo", "id": 1})),
    );
    fixture.respond(
        &format!("{API}/user"),
        ok(json!({"login": "octo", "id": 1})),
    );
    fixture.respond(
        &format!("{API}/repos/o/one/issues?state=open&per_page=100"),
        ok(json!([issue(1, 1, "o/one")])),
    );
    assert_eq!(
        engine
            .check_connection("github", &ConfigValues::new())
            .unwrap()
            .account,
        "octo"
    );
    let preview = engine
        .preview("github", &config(json!({"repositories": ["o/one"]})))
        .unwrap();
    assert_eq!(
        (preview.account.as_str(), preview.matched, preview.complete),
        ("octo", 1, true)
    );
    assert_eq!(preview.issues[0].display, "o/one#1");
}

#[test]
fn repository_options_come_from_the_account_and_filter_by_query() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"),
        ok(json!([
            {"full_name": "o/alpha", "private": true},
            {"full_name": "o/beta", "private": false}
        ])),
    );
    let options = engine
        .options("github", "repositories", "ALP", &ConfigValues::new())
        .unwrap();
    assert_eq!(options.len(), 1);
    assert_eq!(options[0].value, "o/alpha");
    assert_eq!(options[0].description.as_deref(), Some("Private"));
}

#[test]
fn label_options_come_from_the_selected_repositories() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/one/labels?per_page=100"),
        ok(json!([{"name": "bug"}, {"name": "docs"}])),
    );
    fixture.respond(
        &format!("{API}/repos/o/two/labels?per_page=100"),
        ok(json!([{"name": "bug"}, {"name": "bugfix"}])),
    );
    let options = engine
        .options(
            "github",
            "labels",
            "bug",
            &config(json!({"repositories": ["o/one", "o/two", "not a repo"]})),
        )
        .unwrap();
    let values: Vec<_> = options.iter().map(|o| o.value.as_str()).collect();
    assert_eq!(values, ["bug", "bugfix"]);
}

#[test]
fn secrets_and_requests_never_debug_print_the_credential() {
    let secret = Secret::new(TOKEN);
    assert!(!format!("{secret:?}").contains(TOKEN));
    let request = HttpRequest {
        method: Method::Get,
        url: API.into(),
        headers: vec![("Authorization".into(), format!("Bearer {TOKEN}"))],
        body: None,
    };
    assert!(!format!("{request:?}").contains(TOKEN));
}

const GRAPHQL: &str = "https://api.example.test/graphql";

fn closed_duplicate(id: u64, number: u64) -> Value {
    let mut closed = issue(id, number, "o/one");
    closed["state"] = json!("closed");
    closed["state_reason"] = json!("duplicate");
    closed
}

fn fetch_duplicate(
    fixture: &Fixture,
    engine: &Engine,
    timeline: Result<HttpResponse, TransportError>,
) -> ExternalIssue {
    fixture.respond(
        &format!("{API}/repos/o/one/issues/7"),
        ok(closed_duplicate(7, 7)),
    );
    fixture.respond(GRAPHQL, timeline);
    let reference = ExternalRef {
        identity: ExternalIdentity {
            provider: "github".into(),
            id: "@api.example.test:7".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    engine
        .fetch(
            "github",
            &config(json!({"repositories": ["o/one"]})),
            &reference,
        )
        .unwrap()
}

fn timeline(nodes: Value) -> Result<HttpResponse, TransportError> {
    ok(json!({"data": {"repository": {"issue": {"timelineItems": {"nodes": nodes}}}}}))
}

fn marked(duplicate: u64, canonical: Value) -> Value {
    json!({"__typename": "MarkedAsDuplicateEvent", "duplicate": {"databaseId": duplicate}, "canonical": canonical})
}

fn issue_node(id: u64, number: u64, repo: &str) -> Value {
    json!({"__typename": "Issue", "databaseId": id, "number": number, "url": format!("https://github.example/{repo}/issues/{number}"), "repository": {"nameWithOwner": repo}})
}

#[test]
fn a_duplicate_names_its_canonical_issue_from_the_graphql_timeline_in_another_repository() {
    let (fixture, engine) = setup(Some(TOKEN));
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([marked(7, issue_node(900, 12, "o/other"))])),
    );
    let target = fetched.duplicate_of.expect("a canonical issue");
    assert_eq!(target.identity.provider, "github");
    assert_eq!(target.identity.id, "@api.example.test:900");
    assert_eq!(target.locator, "o/other#12");
    assert_eq!(
        fetched.duplicate_of_url.as_deref(),
        Some("https://github.example/o/other/issues/12")
    );
    assert!(!fetched.duplicate_withdrawn);
    // One authenticated POST to the GraphQL endpoint, asking about this issue only.
    let requests = fixture.requests.lock().unwrap();
    let post = requests
        .iter()
        .find(|request| request.url == GRAPHQL)
        .unwrap();
    assert!(matches!(post.method, Method::Post));
    assert!(
        post.headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v.contains(TOKEN))
    );
    let body: Value = serde_json::from_slice(post.body.as_ref().unwrap()).unwrap();
    assert_eq!(
        body["variables"],
        json!({"owner": "o", "name": "one", "number": 7})
    );
}

#[test]
fn only_events_about_this_issue_count_and_the_latest_wins() {
    let (fixture, engine) = setup(Some(TOKEN));
    // Someone else was marked a duplicate of this issue (the event also appears on
    // the canonical issue's timeline): that is not this issue's target.
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([marked(55, issue_node(7, 7, "o/one"))])),
    );
    assert!(fetched.duplicate_of.is_none());
    // A later mark replaces an earlier one; an unmark withdraws it.
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([
            marked(7, issue_node(800, 8, "o/one")),
            marked(7, issue_node(900, 9, "o/one")),
        ])),
    );
    assert_eq!(
        fetched.duplicate_of.unwrap().identity.id,
        "@api.example.test:900"
    );
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([
            marked(7, issue_node(800, 8, "o/one")),
            {"__typename": "UnmarkedAsDuplicateEvent", "duplicate": {"databaseId": 7}},
        ])),
    );
    assert!(fetched.duplicate_of.is_none());
    assert!(
        fetched.duplicate_withdrawn,
        "an unmark is a withdrawal, not a missing answer"
    );
}

fn closed_as_duplicate(canonical: Value) -> Value {
    json!({"__typename": "ClosedEvent", "stateReason": "DUPLICATE", "duplicateOf": canonical})
}

#[test]
fn closing_as_a_duplicate_names_the_canonical_on_the_duplicates_own_closed_event() {
    let (fixture, engine) = setup(Some(TOKEN));
    // `gh issue close 7 --duplicate-of 12`: the duplicate's timeline holds only the
    // closed event; the marked event appears on the canonical's timeline instead.
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([closed_as_duplicate(issue_node(900, 12, "o/other"))])),
    );
    let target = fetched.duplicate_of.expect("the closed event names it");
    assert_eq!(target.identity.id, "@api.example.test:900");
    assert_eq!(target.locator, "o/other#12");
    assert_eq!(
        fetched.duplicate_of_url.as_deref(),
        Some("https://github.example/o/other/issues/12")
    );
    // The latest event wins, whichever shape it has.
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([
            marked(7, issue_node(800, 8, "o/one")),
            closed_as_duplicate(issue_node(900, 9, "o/one")),
        ])),
    );
    assert_eq!(
        fetched.duplicate_of.unwrap().identity.id,
        "@api.example.test:900"
    );
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([
            closed_as_duplicate(issue_node(800, 8, "o/one")),
            marked(7, issue_node(900, 9, "o/one")),
        ])),
    );
    assert_eq!(
        fetched.duplicate_of.unwrap().identity.id,
        "@api.example.test:900"
    );
    // A closure that names nothing leaves an earlier mark standing.
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([
            marked(7, issue_node(800, 8, "o/one")),
            closed_as_duplicate(Value::Null),
        ])),
    );
    assert_eq!(
        fetched.duplicate_of.unwrap().identity.id,
        "@api.example.test:800"
    );
}

#[test]
fn an_unreadable_pull_request_or_failed_lookup_is_an_unknown_target_not_a_failed_fetch() {
    let (fixture, engine) = setup(Some(TOKEN));
    let pull_request = json!({"__typename": "PullRequest"});
    for response in [
        timeline(json!([marked(7, pull_request)])),
        timeline(json!([marked(7, Value::Null)])),
        ok(json!({"data": null, "errors": [{"message": "Could not resolve"}]})),
        status(502, json!({}), &[]),
        Err("connection reset".into()),
    ] {
        let fetched = fetch_duplicate(&fixture, &engine, response);
        assert!(fetched.duplicate_of.is_none());
        assert!(
            !fetched.duplicate_withdrawn,
            "nothing supplied is not a withdrawal"
        );
        assert_eq!(
            fetched.state,
            ExternalState::named(StateCategory::Duplicate, "Closed")
        );
    }
}

#[test]
fn only_duplicate_closures_ask_for_a_canonical_issue() {
    let (fixture, engine) = setup(Some(TOKEN));
    let mut closed = issue(7, 7, "o/one");
    closed["state"] = json!("closed");
    closed["state_reason"] = json!("completed");
    fixture.respond(&format!("{API}/repos/o/one/issues/7"), ok(closed));
    let reference = ExternalRef {
        identity: ExternalIdentity {
            provider: "github".into(),
            id: "@api.example.test:7".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    engine
        .fetch(
            "github",
            &config(json!({"repositories": ["o/one"]})),
            &reference,
        )
        .unwrap();
    assert!(!fixture.urls().iter().any(|url| url == GRAPHQL));
}

#[test]
fn enterprise_graphql_lives_beside_the_rest_root() {
    let connector = |api: &str| {
        GithubConnector::new(api, Box::new(Shared(Arc::default())), Box::new(Token(None)))
    };
    assert_eq!(
        connector("https://ghe.example/api/v3/").graphql_url(),
        "https://ghe.example/api/graphql"
    );
    assert_eq!(
        connector("https://api.github.com").graphql_url(),
        "https://api.github.com/graphql"
    );
}

fn publish_request() -> PublishRequest {
    PublishRequest {
        title: "Escalate".into(),
        body: "Details".into(),
        destination: "o/r".into(),
    }
}

fn publish_to(engine: &Engine) -> Result<ExternalIssue, SourceError> {
    engine.publish(
        "github",
        &config(json!({"repositories": ["o/r"]})),
        &publish_request(),
    )
}

#[test]
fn publishing_posts_only_the_title_and_description_and_returns_the_created_issue() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/r/issues"),
        status(201, issue(77, 12, "o/r"), &[]),
    );

    let created = publish_to(&engine).unwrap();

    assert_eq!(created.reference.identity.id, "@api.example.test:77");
    assert_eq!(created.reference.locator, "o/r#12");
    assert_eq!(
        created.state,
        ExternalState::named(StateCategory::Open, "Open")
    );
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, Method::Post);
    // Nothing ticketd-specific: no labels, assignees, milestone or markers.
    let sent: Value = serde_json::from_slice(requests[0].body.as_ref().unwrap()).unwrap();
    assert_eq!(sent, json!({"title": "Escalate", "body": "Details"}));
}

#[test]
fn a_refusal_proves_nothing_was_created_but_an_unclear_answer_does_not() {
    let url = format!("{API}/repos/o/r/issues");
    for (response, code, ruled_out) in [
        (status(401, json!({}), &[]), "unauthenticated", true),
        (
            status(403, json!({"message": "nope"}), &[]),
            "forbidden",
            true,
        ),
        (status(404, json!({}), &[]), "not_found", true),
        (
            status(410, json!({"message": "Issues are disabled"}), &[]),
            "rejected",
            true,
        ),
        (
            status(422, json!({"message": "Validation Failed"}), &[]),
            "rejected",
            true,
        ),
        (
            status(429, json!({}), &[("retry-after", "30")]),
            "rate_limited",
            true,
        ),
        // The create may have happened: a server error, a redirect, a lost answer
        // and an unreadable success.
        (status(502, json!({}), &[]), "unavailable", false),
        (
            status(307, json!({}), &[("location", &url)]),
            "protocol",
            false,
        ),
        (Err("connection reset".into()), "unavailable", false),
        (status(201, json!("not an issue"), &[]), "protocol", false),
    ] {
        let (fixture, engine) = setup(Some(TOKEN));
        fixture.respond(&url, response);
        let error = publish_to(&engine).unwrap_err();
        assert_eq!(error.code(), code);
        assert_eq!(error.ruled_out_creation(), ruled_out, "{code}");
        // The POST is never retried or redirected.
        assert_eq!(fixture.urls().len(), 1);
        assert!(!error.to_string().contains(TOKEN));
    }
}

#[test]
fn publishing_without_a_credential_sends_nothing() {
    let (fixture, engine) = setup(None);
    let error = publish_to(&engine).unwrap_err();
    assert!(error.ruled_out_creation());
    assert!(fixture.urls().is_empty());
}

fn conversation_of(engine: &Engine) -> Result<Conversation, SourceError> {
    let reference = ExternalRef {
        identity: ExternalIdentity {
            provider: "github".into(),
            id: "@api.example.test:7".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    engine
        .conversation(
            "github",
            &config(json!({"repositories": ["o/one"]})),
            &reference,
        )
        .map(|read| read.expect("github reads conversations"))
}

fn gh_comment(id: u64, login: Option<&str>, body: &str, at: &str) -> Value {
    json!({
        "id": id, "user": login.map(|l| json!({"login": l})), "body": body,
        "html_url": format!("https://github.example/o/one/issues/7#issuecomment-{id}"),
        "created_at": at, "updated_at": at
    })
}

#[test]
fn comments_and_events_follow_every_page_and_translate_to_neutral_entries() {
    let (fixture, engine) = setup(Some(TOKEN));
    let comments = format!("{API}/repos/o/one/issues/7/comments?per_page=100");
    let comments_two = format!("{API}/repos/o/one/issues/7/comments?per_page=100&page=2");
    let events = format!("{API}/repos/o/one/issues/7/events?per_page=100");
    fixture.respond(
        &comments,
        ok_with(
            json!([gh_comment(
                11,
                Some("alice"),
                "first",
                "2026-01-02T00:00:00Z"
            )]),
            &[("link", &format!("<{comments_two}>; rel=\"next\""))],
        ),
    );
    let mut edited = gh_comment(12, None, "from a deleted account", "2026-01-03T00:00:00Z");
    edited["updated_at"] = json!("2026-01-04T00:00:00Z");
    fixture.respond(&comments_two, ok(json!([edited])));
    fixture.respond(
        &events,
        ok(json!([
            {"id": 21, "event": "labeled", "actor": {"login": "alice"}, "created_at": "2026-01-01T00:00:00Z"},
            {"id": 22, "event": "assigned", "actor": {"login": "alice"}, "assignee": {"login": "bob"}, "created_at": "2026-01-01T01:00:00Z"},
            {"id": 23, "event": "unassigned", "actor": {"login": "alice"}, "assignee": {"login": "bob"}, "created_at": "2026-01-01T02:00:00Z"},
            {"id": 24, "event": "closed", "actor": {"login": "carol"}, "state_reason": "duplicate", "created_at": "2026-01-05T00:00:00Z"},
            {"id": 25, "event": "reopened", "actor": {"login": "carol"}, "created_at": "2026-01-06T00:00:00Z"},
            {"id": 26, "event": "closed", "actor": {"login": "carol"}, "state_reason": "not_planned", "created_at": "2026-01-07T00:00:00Z"},
            {"id": 27, "event": "closed", "actor": null, "created_at": "2026-01-08T00:00:00Z"}
        ])),
    );

    let read = conversation_of(&engine).unwrap();

    assert_eq!(read.comments.len(), 2);
    assert_eq!(read.comments[0].id, "11");
    assert_eq!(read.comments[0].author, "alice");
    assert_eq!(
        read.comments[0].url,
        "https://github.example/o/one/issues/7#issuecomment-11"
    );
    assert_eq!(read.comments[1].author, "ghost");
    assert_eq!(read.comments[1].updated_at, "2026-01-04T00:00:00Z");
    let kinds: Vec<_> = read.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        [
            ExternalEventKind::Assigned,
            ExternalEventKind::Unassigned,
            ExternalEventKind::Closed(StateCategory::Duplicate),
            ExternalEventKind::Reopened,
            ExternalEventKind::Closed(StateCategory::NotPlanned),
            ExternalEventKind::Closed(StateCategory::Unknown),
        ],
        "unrelated events such as labels are left out"
    );
    assert_eq!(read.events[0].subject.as_deref(), Some("bob"));
    assert_eq!(read.events[0].actor.as_deref(), Some("alice"));
    assert_eq!(read.events[5].actor, None);
    assert_eq!(fixture.urls(), [comments, comments_two, events]);
}

#[test]
fn conversation_failures_are_classified_and_never_follow_foreign_links() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/one/issues/7/comments?per_page=100"),
        status(404, json!({"message": "Not Found"}), &[]),
    );
    assert!(matches!(
        conversation_of(&engine),
        Err(SourceError::NotFound(_))
    ));

    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/one/issues/7/comments?per_page=100"),
        ok_with(
            json!([]),
            &[("link", "<https://elsewhere.example/steal>; rel=\"next\"")],
        ),
    );
    assert!(matches!(
        conversation_of(&engine),
        Err(SourceError::Protocol(_))
    ));
    assert!(!fixture.urls().iter().any(|u| u.contains("elsewhere")));
}

#[test]
fn github_declares_that_it_reads_comments() {
    let (_, engine) = setup(Some(TOKEN));
    assert!(
        engine.connectors()[0]
            .capabilities
            .contains(&Capability::Comments)
    );
}

fn locate_in(engine: &Engine, text: &str) -> Result<ExternalIssue, SourceError> {
    engine.locate(
        "github",
        &config(json!({"repositories": ["o/r"]})),
        "o/r",
        text,
    )
}

#[test]
fn locating_reads_an_issue_only_inside_the_destination() {
    for text in [
        "12",
        "#12",
        "o/r#12",
        "O/R#12",
        "https://api.example.test/o/r/issues/12",
    ] {
        let (fixture, engine) = setup(Some(TOKEN));
        fixture.respond(
            &format!("{API}/repos/o/r/issues/12"),
            ok(issue(77, 12, "o/r")),
        );
        let found = locate_in(&engine, text).unwrap();
        assert_eq!(
            found.reference.identity.id, "@api.example.test:77",
            "{text}"
        );
        assert_eq!(found.display, "o/r#12");
    }
    for text in [
        "other/repo#12",
        "https://github.example/other/repo/issues/12",
        "https://github.com/o/r/issues/12",
        "https://[:::1]/o/r/issues/12",
        "abc",
        "0",
        "",
    ] {
        let (fixture, engine) = setup(Some(TOKEN));
        let error = locate_in(&engine, text).unwrap_err();
        assert_eq!(error.code(), "invalid_configuration", "{text}");
        assert!(fixture.urls().is_empty(), "nothing is requested for {text}");
    }
    // A pull request and an issue transferred elsewhere are refused.
    let (fixture, engine) = setup(Some(TOKEN));
    let mut pull = issue(5, 12, "o/r");
    pull["pull_request"] = json!({"url": "x"});
    fixture.respond(&format!("{API}/repos/o/r/issues/12"), ok(pull));
    assert_eq!(locate_in(&engine, "12").unwrap_err().code(), "not_found");
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/repos/o/r/issues/12"),
        ok(issue(5, 3, "moved/away")),
    );
    assert_eq!(
        locate_in(&engine, "12").unwrap_err().code(),
        "invalid_configuration"
    );
}

const SEARCH_URL: &str = "https://api.example.test/repos/o/r/issues?state=all&sort=created&direction=desc&per_page=100&since=2026-03-01T00%3A00%3A00Z";

#[test]
fn an_enterprise_site_includes_its_nondefault_port() {
    assert_eq!(site_of("https://forge.example/api/v3"), "forge.example");
    assert_eq!(
        site_of("https://forge.example:8443/api/v3"),
        "forge.example:8443"
    );
    assert_eq!(site_of("https://api.github.com:443"), "");
}

fn search_for_title(engine: &Engine) -> Result<PublicationCandidates, SourceError> {
    engine.find_published(
        "github",
        &config(json!({"repositories": ["o/r"]})),
        &PublicationSearch {
            tracker_since: Some("2026-03-01T00:00:00Z".into()),
            account: None,
            request: publish_request(),
            since: "2026-03-01T00:00:00Z".into(),
        },
    )
}

fn created(mut item: Value, at: &str) -> Value {
    item["created_at"] = json!(at);
    item
}

#[test]
fn searching_reads_the_whole_window_and_matches_by_content() {
    let (fixture, engine) = setup(Some(TOKEN));
    let second = format!("{API}/repos/o/r/issues?page=2");
    let mut mine = created(issue(9, 9, "o/r"), "2026-03-02T00:00:00Z");
    mine["title"] = json!("Escalate");
    let mut unrelated = created(issue(8, 8, "o/r"), "2026-03-02T00:00:00Z");
    unrelated["body"] = json!("Something else");
    let mut pull = created(issue(7, 7, "o/r"), "2026-03-02T00:00:00Z");
    pull["title"] = json!("Escalate");
    pull["pull_request"] = json!({"url": "x"});
    let mut same_body = created(issue(6, 6, "o/r"), "2026-03-02T00:00:00Z");
    same_body["body"] = json!("Details\r\n");
    let old = created(issue(5, 5, "o/r"), "2026-01-01T00:00:00Z");
    fixture.respond(
        SEARCH_URL,
        ok_with(
            json!([mine, unrelated, pull]),
            &[("link", &format!("<{second}>; rel=\"next\""))],
        ),
    );
    // An issue older than the window ends the read: complete without more pages.
    fixture.respond(&second, ok(json!([same_body, old])));

    let found = search_for_title(&engine).unwrap();

    assert!(found.complete);
    let ids: Vec<_> = found
        .matches
        .iter()
        .map(|i| i.reference.identity.id.as_str())
        .collect();
    assert_eq!(
        ids,
        ["@api.example.test:9", "@api.example.test:6"],
        "title and normalized body match only"
    );
}

#[test]
fn the_accounts_other_issues_in_the_window_are_listed_apart_from_text_matches() {
    let (fixture, engine) = setup(Some(TOKEN));
    let mut rewritten = created(issue(9, 9, "o/r"), "2026-03-02T00:00:00Z");
    rewritten["title"] = json!("Renamed by a teammate");
    rewritten["body"] = json!("Rewritten by an automation");
    rewritten["user"] = json!({"login": "Octo"});
    let mut someone_else = created(issue(8, 8, "o/r"), "2026-03-02T00:00:00Z");
    someone_else["user"] = json!({"login": "other"});
    someone_else["title"] = json!("Unrelated");
    someone_else["body"] = json!("Unrelated");
    fixture.respond(SEARCH_URL, ok(json!([rewritten, someone_else])));
    let found = engine
        .find_published(
            "github",
            &config(json!({"repositories": ["o/r"]})),
            &PublicationSearch {
                tracker_since: Some("2026-03-01T00:00:00Z".into()),
                account: Some("octo".into()),
                request: publish_request(),
                since: "2026-03-01T00:00:00Z".into(),
            },
        )
        .unwrap();
    // The rewritten issue has no text match but remains a recovery candidate.
    assert!(found.matches.is_empty());
    let ids: Vec<_> = found
        .recent
        .iter()
        .map(|i| i.reference.identity.id.as_str())
        .collect();
    assert_eq!(ids, ["@api.example.test:9"]);
}

#[test]
fn publication_recovery_matches_the_creator_id_across_a_login_change() {
    let (fixture, engine) = setup(Some(TOKEN));
    let mut rewritten = created(issue(9, 9, "o/r"), "2026-03-02T00:00:00Z");
    rewritten["user"] = json!({"login": "octo-renamed", "id": 41});
    rewritten["body"] = json!("Rewritten by an automation");
    let mut reused_login = created(issue(8, 8, "o/r"), "2026-03-02T00:00:00Z");
    reused_login["user"] = json!({"login": "octo", "id": 57});
    reused_login["body"] = json!("Unrelated");
    let search = PublicationSearch {
        tracker_since: Some("2026-03-01T00:00:00Z".into()),
        account: Some("id:41".into()),
        request: publish_request(),
        since: "2026-03-01T00:00:00Z".into(),
    };
    let values = config(json!({"repositories": ["o/r"]}));
    fixture.respond(SEARCH_URL, ok(json!([rewritten, reused_login])));
    let found = engine.find_published(PROVIDER, &values, &search).unwrap();
    assert!(found.complete);
    assert!(found.matches.is_empty());
    assert_eq!(found.recent[0].reference.identity.id, "@api.example.test:9");
    assert_eq!(found.recent.len(), 1);

    reused_login["user"] = Value::Null;
    fixture.respond(SEARCH_URL, ok(json!([reused_login])));
    let unknown = engine.find_published(PROVIDER, &values, &search).unwrap();
    assert!(!unknown.complete);
    assert!(unknown.matches.is_empty() && unknown.recent.is_empty());
}

#[test]
fn a_recovery_search_uses_the_authenticated_clock_observed_at_dispatch() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/user"),
        ok_with(
            json!({ "login": "octo", "id": 1 }),
            &[("date", "Sun, 01 Mar 2026 00:00:00 GMT")],
        ),
    );
    let settings = config(json!({"repositories": ["o/r"]}));
    let checked = engine.check("github", &settings).unwrap();
    assert_eq!(
        checked.connection.tracker_time.as_deref(),
        Some("2026-03-01T00:00:00Z")
    );
    let mut received = created(issue(9, 9, "o/r"), "2026-03-01T00:30:00Z");
    received["title"] = json!("Escalate");
    fixture.respond(SEARCH_URL, ok(json!([received])));
    let found = engine
        .find_published(
            "github",
            &settings,
            &PublicationSearch {
                tracker_since: checked.connection.tracker_time,
                account: None,
                request: publish_request(),
                since: "2026-03-01T02:00:00Z".into(),
            },
        )
        .unwrap();
    assert!(found.complete);
    assert_eq!(
        found.matches[0].reference.identity.id,
        "@api.example.test:9"
    );
}

#[test]
fn an_older_attempt_can_rule_out_an_issue_only_in_an_empty_complete_destination() {
    let unbounded = SEARCH_URL.split("&since=").next().unwrap();
    let search = PublicationSearch {
        tracker_since: None,
        account: None,
        request: publish_request(),
        since: "2026-03-01T00:00:00Z".into(),
    };
    let read = |engine: &Engine| {
        engine
            .find_published("github", &config(json!({"repositories": ["o/r"]})), &search)
            .unwrap()
    };

    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(unbounded, ok(json!([])));
    let empty = read(&engine);
    assert!(empty.complete);
    assert!(empty.matches.is_empty() && empty.recent.is_empty());

    let (fixture, engine) = setup(Some(TOKEN));
    let mut old = created(issue(1, 1, "o/r"), "2026-02-28T21:00:00Z");
    old["title"] = json!("Escalate");
    fixture.respond(unbounded, ok(json!([old])));
    let clock_ahead = read(&engine);
    assert!(!clock_ahead.complete);
    assert_eq!(clock_ahead.matches.len(), 1);

    let (fixture, engine) = setup(Some(TOKEN));
    let again = format!("{API}/repos/o/r/issues?page=2");
    let link = format!("<{again}>; rel=\"next\"");
    fixture.respond(unbounded, ok_with(json!([]), &[("link", &link)]));
    for _ in 1..SEARCH_PAGES {
        fixture.respond(&again, ok_with(json!([]), &[("link", &link)]));
    }
    assert!(!read(&engine).complete);
}

#[test]
fn a_request_that_never_left_is_not_sent_but_a_lost_answer_is_not_proof() {
    let url = format!("{API}/repos/o/r/issues");
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &url,
        Err(TransportError {
            message: "dns error".into(),
            before_send: true,
        }),
    );
    let error = publish_to(&engine).unwrap_err();
    assert!(matches!(error, SourceError::NotSent(_)), "{error}");
    assert!(error.ruled_out_creation());
    // The same failure after the request went out proves nothing.
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(&url, Err("operation timed out".into()));
    let error = publish_to(&engine).unwrap_err();
    assert!(matches!(error, SourceError::Unavailable(_)), "{error}");
    assert!(!error.ruled_out_creation());
}

#[test]
fn a_create_is_not_sent_when_credentials_take_past_the_dispatch_window() {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::{Duration, Instant},
    };

    struct LateToken {
        deadline: Instant,
        read: Arc<AtomicBool>,
    }

    impl CredentialSource for LateToken {
        fn token(&self) -> Option<Secret> {
            self.read.store(true, Ordering::Relaxed);
            std::thread::sleep(
                self.deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(5),
            );
            Some(Secret::new(TOKEN))
        }
    }

    let fixture = Arc::new(Fixture::default());
    let read = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(1);
    let github = GithubConnector::new(
        API,
        Box::new(Shared(fixture.clone())),
        Box::new(LateToken {
            deadline,
            read: read.clone(),
        }),
    );
    let request = PublishRequest {
        destination: "o/r".into(),
        title: "Publish issue".into(),
        body: String::new(),
    };
    let error = github
        .publish_before(&ConfigValues::new(), &request, deadline)
        .unwrap_err();
    assert!(matches!(error, SourceError::NotSent(_)), "{error}");
    assert!(read.load(Ordering::Relaxed));
    assert!(fixture.urls().is_empty());
}

#[test]
fn a_search_that_cannot_finish_is_incomplete_or_an_error_never_empty_and_complete() {
    // The window is longer than the pages read: incomplete.
    let (fixture, engine) = setup(Some(TOKEN));
    let again = format!("{API}/repos/o/r/issues?page=2");
    let link = format!("<{again}>; rel=\"next\"");
    let recent = created(issue(1, 1, "o/r"), "2026-03-02T00:00:00Z");
    fixture.respond(
        SEARCH_URL,
        ok_with(json!([recent.clone()]), &[("link", &link)]),
    );
    for _ in 1..SEARCH_PAGES {
        fixture.respond(&again, ok_with(json!([recent.clone()]), &[("link", &link)]));
    }
    let found = search_for_title(&engine).unwrap();
    assert!(!found.complete);

    // An outage and a missing credential are errors, not "nothing found".
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(SEARCH_URL, status(502, json!({}), &[]));
    assert_eq!(search_for_title(&engine).unwrap_err().code(), "unavailable");
    let (_, engine) = setup(None);
    assert_eq!(
        search_for_title(&engine).unwrap_err().code(),
        "unauthenticated"
    );
}

/// A credential failure is two readable sentences: the shared cause, then the
/// guidance for the surface reading it. The terminal never mentions a Settings
/// button, and the desktop never mentions an environment variable.
#[test]
fn credential_failures_end_in_a_sentence_and_take_the_hint_of_their_surface() {
    let (_, engine) = setup(None);
    let missing = engine
        .check_connection("github", &config(json!({})))
        .unwrap_err();
    assert!(matches!(missing, SourceError::SignIn { .. }), "{missing}");
    assert_eq!(
        missing.to_string(),
        "no GitHub credential found. Run `gh auth login` to sign in."
    );

    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/user"),
        status(401, json!({"message": "Bad credentials"}), &[]),
    );
    let rejected = engine
        .check_connection("github", &config(json!({})))
        .unwrap_err();
    assert_eq!(
        rejected.to_string(),
        "GitHub rejected the credential. Run `gh auth login` to sign in again."
    );

    for error in [&missing, &rejected] {
        let terminal = error.message_for(Surface::Terminal);
        assert!(
            terminal
                .ends_with(". For scripts, the GitHub CLI reads GH_TOKEN or GH_ENTERPRISE_TOKEN."),
            "{terminal}"
        );
        assert!(!terminal.contains("Settings"), "{terminal}");
        let desktop = error.message_for(Surface::Desktop);
        assert!(
            desktop.ends_with(". Then choose Check connection in Settings › Ticket sources."),
            "{desktop}"
        );
        assert!(!desktop.contains("GH_TOKEN"), "{desktop}");
    }
    // Other failures read the same everywhere.
    let other = SourceError::Unavailable("GitHub is unavailable".into());
    assert_eq!(other.message_for(Surface::Desktop), other.to_string());
}

#[test]
fn a_missing_repository_list_reads_as_a_sentence() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!(
            "{API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"
        ),
        status(404, json!({"message": "Not Found"}), &[]),
    );
    let error = engine
        .options("github", "repositories", "x", &config(json!({})))
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "the list of your repositories was not found, or the credential cannot see it"
    );
}

#[test]
fn github_connection_answers_describe_repository_destinations() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(
        &format!("{API}/user"),
        ok(json!({"login": "octo", "id": 1})),
    );
    let config = config(json!({"repositories": ["Acme/Tracker"]}));
    let rules = engine.check("github", &config).unwrap().derived.publication;
    assert_eq!(rules.destinations, ["Acme/Tracker"]);
    assert!(rules.case_insensitive);
    assert_eq!(rules.validation.unwrap().format, ValueFormat::OwnerName);
}

#[test]
fn github_describes_how_to_present_its_configuration() {
    let (_, engine) = setup(None);
    let description = engine.description("github").unwrap();
    assert_eq!(description.descriptor.name, "GitHub");
    assert_eq!(description.presentation.hosts, vec![host_of(API)]);
    assert!(
        description
            .presentation
            .icon_svg
            .as_deref()
            .unwrap()
            .starts_with("<svg")
    );
    assert_eq!(
        description
            .presentation
            .sign_in
            .desktop_instruction
            .as_deref(),
        Some("Run “gh auth login” in a terminal, then choose Check connection.")
    );
    let summary = engine.configuration_summary(
        "github",
        &config(json!({"repositories": ["example/api"], "labels": ["bug", "help"], "assignee": "someone"})),
    ).unwrap();
    assert_eq!(
        summary
            .iter()
            .map(|part| part.text.as_str())
            .collect::<String>(),
        "Imports open issues from example/api that have the labels bug and help, assigned to someone."
    );
}

#[test]
fn removing_a_rule_during_auth_preflight_prevents_dispatch_without_a_project_destination() {
    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::source::{AttemptState, GithubRepositoryRule, PublicationError, PublishOptions};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    let remove = Arc::new(AtomicBool::new(false));
    let gh = gh::GhApi::new({
        let path = path.clone();
        let remove = remove.clone();
        move |args, _, _, _| {
            let response = match *args.last().unwrap() {
                "github.com" if args[0] == "auth" => gh::Output {
                    success: true,
                    stdout: b"fixture-token".to_vec(),
                    stderr: Vec::new(),
                },
                "user" => {
                    if remove.swap(false, Ordering::AcqRel) {
                        crate::Workspace::open(&path)
                            .unwrap()
                            .remove_github_repository("github.com/o/r")
                            .unwrap();
                    }
                    recorded_gh(200, &json!({"id": 1, "login": "octo"}))
                }
                "repos/o/r/issues?state=open&per_page=100" => recorded_gh(200, &json!([])),
                "repos/o/r/issues" => recorded_gh(201, &public_issue(107, 7, "o/r")),
                endpoint => panic!("unexpected GitHub endpoint: {endpoint}"),
            };
            Ok(response)
        }
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let mut workspace = crate::Workspace::open(path).unwrap();
    workspace
        .save_github_repository(
            &engine,
            GithubRepositoryRule {
                repository: "github.com/o/r".into(),
                assignee: None,
                labels: vec![],
            },
        )
        .unwrap();
    let ticket = workspace.create_ticket("Publish this ticket").unwrap();
    remove.store(true, Ordering::Release);
    let result = workspace.publish_ticket(&engine, &ticket.reference, &PublishOptions::default());
    assert!(
        matches!(
            result,
            Err(crate::Error::Publication(PublicationError::Failed { .. }))
        ),
        "{result:?}"
    );
    let attempts = workspace.publication_attempts(&ticket.reference).unwrap();
    assert_eq!(attempts[0].state, AttemptState::Failed);
    assert!(
        attempts[0]
            .failure
            .as_ref()
            .unwrap()
            .message
            .contains("before the request could be sent")
    );
    assert!(
        workspace
            .show_ticket(&ticket.reference)
            .unwrap()
            .source
            .is_none()
    );
}

#[test]
fn publication_keeps_its_verified_login_and_recovers_a_lost_answer_without_repeating_the_write() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use crate::source::{
        GithubRepositoryRule, PublicationError, PublishOptions, Resolution, ResolveOptions,
    };

    let active_changed = Arc::new(AtomicBool::new(false));
    let armed = Arc::new(AtomicBool::new(false));
    let writes = Arc::new(AtomicUsize::new(0));
    let gh = gh::GhApi::new({
        let active_changed = active_changed.clone();
        let armed = armed.clone();
        let writes = writes.clone();
        move |args, input, auth, _| {
            if args[0] == "auth" {
                if matches!(auth, gh::Authentication::NamedLookup) {
                    return Ok(gh::Output {
                        success: false,
                        stdout: Vec::new(),
                        stderr: b"no stored GitHub CLI credentials".to_vec(),
                    });
                }
                assert!(matches!(auth, gh::Authentication::Ambient));
                let token = if active_changed.load(Ordering::Acquire) {
                    "different-credential"
                } else {
                    "first-credential"
                };
                return Ok(gh::Output {
                    success: true,
                    stdout: token.as_bytes().to_vec(),
                    stderr: Vec::new(),
                });
            }
            let endpoint = *args.last().unwrap();
            let body = match endpoint {
                "user" => {
                    if matches!(auth, gh::Authentication::Scoped("different-credential")) {
                        return Ok(recorded_gh(200, &json!({"id": 2, "login": "other"})));
                    }
                    assert!(matches!(
                        auth,
                        gh::Authentication::Scoped("first-credential")
                    ));
                    if armed.load(Ordering::Acquire) {
                        active_changed.store(true, Ordering::Release);
                    }
                    json!({"id": 1, "login": "octo"})
                }
                "repos/o/r/issues?state=open&per_page=100" => json!([]),
                "repos/o/r/issues" => {
                    assert!(matches!(
                        auth,
                        gh::Authentication::Scoped("first-credential")
                    ));
                    writes.fetch_add(1, Ordering::AcqRel);
                    let body: Value = serde_json::from_slice(input.unwrap()).unwrap();
                    assert_eq!(body["title"], "Publish this ticket");
                    return Ok(gh::Output {
                        success: false,
                        stdout: Vec::new(),
                        stderr: b"connection reset after sending".to_vec(),
                    });
                }
                "repos/o/r/issues/7" => {
                    assert!(matches!(
                        auth,
                        gh::Authentication::Scoped("first-credential")
                    ));
                    let mut remote = public_issue(107, 7, "o/r");
                    remote["title"] = json!("Publish this ticket");
                    remote["body"] = json!("");
                    remote["user"] = json!({"id": 1, "login": "octo"});
                    remote["created_at"] = json!("2026-01-02T00:00:00Z");
                    remote
                }
                _ => panic!("unexpected GitHub endpoint: {endpoint}"),
            };
            Ok(recorded_gh(200, &body))
        }
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = crate::Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    workspace
        .save_github_repository(
            &engine,
            GithubRepositoryRule {
                repository: "github.com/o/r".into(),
                assignee: None,
                labels: vec![],
            },
        )
        .unwrap();
    let ticket = workspace.create_ticket("Publish this ticket").unwrap();

    armed.store(true, Ordering::Release);
    let error = workspace
        .publish_ticket(&engine, &ticket.reference, &PublishOptions::default())
        .unwrap_err();
    assert!(matches!(
        error,
        crate::Error::Publication(PublicationError::Unresolved { .. })
    ));
    assert_eq!(writes.load(Ordering::Acquire), 1);

    armed.store(false, Ordering::Release);
    let options = ResolveOptions {
        resolution: Resolution::Attach {
            issue: Some("7".into()),
        },
        now: None,
        agent: None,
        accept_different_content: false,
    };
    let error = workspace
        .resolve_publication(&engine, &ticket.reference, &options)
        .unwrap_err();
    assert!(matches!(
        error,
        crate::Error::Publication(PublicationError::Unverified { .. })
    ));
    assert_eq!(writes.load(Ordering::Acquire), 1);

    active_changed.store(false, Ordering::Release);
    let resolved = workspace
        .resolve_publication(&engine, &ticket.reference, &options)
        .unwrap();
    assert_eq!(resolved.ticket.source.unwrap().id, "107");
    assert_eq!(writes.load(Ordering::Acquire), 1);
}

#[test]
fn a_project_publication_syncs_without_discovering_issues_until_a_rule_is_saved() {
    use crate::source::{GithubRepositoryRule, PublishOptions, RefreshOptions};

    let allow_discovery = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let gh = gh::GhApi::new({
        let allow_discovery = allow_discovery.clone();
        move |args, _, _, _| {
            let response = match *args.last().unwrap() {
                "github.com" if args[0] == "auth" => gh::Output {
                    success: true,
                    stdout: b"fixture-token".to_vec(),
                    stderr: Vec::new(),
                },
                "user" => recorded_gh(200, &json!({"id": 1, "login": "octo"})),
                "repos/o/r/issues" => recorded_gh(201, &public_issue(107, 7, "o/r")),
                "repos/o/r/issues/7" => {
                    let mut issue = public_issue(107, 7, "o/r");
                    issue["title"] = json!("Changed on GitHub");
                    recorded_gh(200, &issue)
                }
                "repos/o/r/issues/7/comments?per_page=100"
                | "repos/o/r/issues/7/events?per_page=100" => recorded_gh(200, &json!([])),
                "repos/o/r/issues?state=open&per_page=100" => {
                    assert!(allow_discovery.load(std::sync::atomic::Ordering::Acquire));
                    recorded_gh(200, &json!([]))
                }
                "graphql" => recorded_gh(200, &json!({"data": {}})),
                endpoint => panic!("unexpected GitHub endpoint: {endpoint}"),
            };
            Ok(response)
        }
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = crate::Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    let project = workspace
        .create_project_with_remote(
            "Project",
            directory.path().to_str().unwrap(),
            Some("github.com/o/r"),
        )
        .unwrap();
    let ticket = workspace.create_ticket("Publish this ticket").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            crate::TicketPatch {
                project_id: Some(Some(project.id)),
                ..Default::default()
            },
        )
        .unwrap();
    let preview = workspace
        .preview_publication(&engine, &ticket.reference, PROVIDER, None)
        .unwrap();
    workspace
        .publish_ticket(
            &engine,
            &ticket.reference,
            &PublishOptions {
                expected_fingerprint: Some(preview.fingerprint),
                ..Default::default()
            },
        )
        .unwrap();
    let note = workspace
        .add_activity(&ticket.reference, "Local note", None)
        .unwrap();
    assert_eq!(
        workspace
            .ticket_source_connection(&ticket.reference)
            .unwrap()
            .as_deref(),
        Some("github")
    );
    assert!(workspace.github_repositories().unwrap().is_empty());

    let report = workspace
        .refresh_connection(&engine, "github", &RefreshOptions::default())
        .unwrap();
    assert_eq!(report.updated, [ticket.reference.clone()], "{report:?}");
    assert!(report.imported.is_empty());
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().title,
        "Changed on GitHub"
    );

    allow_discovery.store(true, std::sync::atomic::Ordering::Release);
    workspace
        .save_github_repository(
            &engine,
            GithubRepositoryRule {
                repository: "github.com/o/r".into(),
                assignee: None,
                labels: vec![],
            },
        )
        .unwrap();
    workspace
        .remove_github_repository("github.com/o/r")
        .unwrap();
    assert_eq!(
        workspace
            .ticket_source_connection(&ticket.reference)
            .unwrap(),
        None
    );
    let report = workspace
        .refresh_connection(&engine, "github", &RefreshOptions::default())
        .unwrap();
    assert!(report.updated.is_empty());
    let cached = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(cached.title, "Changed on GitHub");
    assert_eq!(
        workspace
            .activity(&ticket.reference, &note.id)
            .unwrap()
            .brief,
        "Local note"
    );
}

#[test]
fn the_project_account_resolver_uses_a_pin_without_an_import_rule_and_can_clear_it() {
    let gh = gh::GhApi::new(|args, _, auth, _| {
        if args[0] == "auth" {
            let token = match auth {
                gh::Authentication::Ambient => "ambient-credential",
                gh::Authentication::NamedLookup => {
                    assert_eq!(
                        args,
                        ["auth", "token", "--hostname", "github.com", "--user", "pat"]
                    );
                    "pinned-credential"
                }
                gh::Authentication::Scoped(_) => panic!("unexpected scoped lookup"),
            };
            return Ok(gh::Output {
                success: true,
                stdout: token.as_bytes().to_vec(),
                stderr: Vec::new(),
            });
        }
        assert_eq!(args.last(), Some(&"user"));
        let account = match auth {
            gh::Authentication::Scoped("pinned-credential") => json!({ "id": 22, "login": "pat" }),
            gh::Authentication::Scoped("ambient-credential") => json!({ "id": 1, "login": "octo" }),
            _ => panic!("account was not scoped"),
        };
        Ok(recorded_gh(200, &account))
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = crate::Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    let project = workspace
        .create_project_with_remote(
            "Platform",
            directory.path().to_str().unwrap(),
            Some("github.com/o/r"),
        )
        .unwrap();
    let first_token = workspace.change_token().unwrap();
    workspace
        .set_github_project_login(&engine, &project.id, "github.com", Some("pat"))
        .unwrap();
    assert!(workspace.change_token().unwrap() > first_token);
    let (_, verified) = workspace
        .github_account_for_project(&engine, Some(&project.id), "github.com")
        .unwrap();
    assert_eq!(verified.account, "pat");
    let integration = workspace.github_integration(&engine).unwrap();
    assert!(integration.repositories.is_empty());
    assert_eq!(
        integration.project_sites_without_rules[0].login.as_deref(),
        Some("pat")
    );
    workspace
        .set_github_project_login(&engine, &project.id, "github.com", None)
        .unwrap();
    let (_, verified) = workspace
        .github_account_for_project(&engine, Some(&project.id), "github.com")
        .unwrap();
    assert_eq!(verified.account, "octo");
}

#[test]
fn a_migrated_ticket_still_refreshes_after_its_issue_moved_outside_import_rules() {
    use crate::source::RefreshOptions;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    crate::create_workspace_at_format_version(&path, 105).unwrap();
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture.execute_batch(
        "INSERT INTO source_connections
           (id, name, provider, site, configuration, account, account_key, contract_version, saved_at, revision)
         VALUES ('github','Account','github','','{\"repositories\":[\"o/original\"]}','octo','id:1',2,'2026-01-01T00:00:00Z','old');
         INSERT INTO tickets (id, reference, title, status) VALUES ('moved', 'T-OLD', 'Before transfer', 'In progress');
         INSERT INTO external_identities (ticket_id,provider,external_id,locator,display,url,origin,partition,repository)
         VALUES ('moved','github','107','o/destination#7','o/destination#7','https://github.com/o/destination/issues/7','imported','o/destination','github.com/o/destination');
         INSERT INTO external_ownership (ticket_id,authority) VALUES ('moved','external');
         INSERT INTO source_sync (ticket_id,state_category,state_name) VALUES ('moved','open','Open');
         INSERT INTO source_connection_tickets VALUES ('moved','github');",
    ).unwrap();
    drop(fixture);
    let gh = gh::GhApi::new(|args, _, auth, _| {
        let response = match *args.last().unwrap() {
            "github.com" if args[0] == "auth" => gh::Output {
                success: true,
                stdout: b"fixture-token".to_vec(),
                stderr: Vec::new(),
            },
            "user" => {
                assert!(matches!(auth, gh::Authentication::Scoped("fixture-token")));
                recorded_gh(200, &json!({ "id": 1, "login": "octo" }))
            }
            "repos/o/destination/issues/7" => {
                let mut issue = public_issue(107, 7, "o/destination");
                issue["title"] = json!("After transfer");
                recorded_gh(200, &issue)
            }
            "repos/o/destination/issues/7/comments?per_page=100"
            | "repos/o/destination/issues/7/events?per_page=100" => recorded_gh(200, &json!([])),
            "graphql" => recorded_gh(200, &json!({"data": {}})),
            endpoint => panic!("unexpected GitHub endpoint: {endpoint}"),
        };
        Ok(response)
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let mut workspace = crate::Workspace::open(path).unwrap();
    let report = workspace
        .refresh_connection(
            &engine,
            PROVIDER,
            &RefreshOptions {
                ticket: Some("T-OLD".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(report.updated, ["T-OLD"], "{report:?}");
    let ticket = workspace.show_ticket("T-OLD").unwrap();
    assert_eq!(ticket.title, "After transfer");
    assert_eq!(ticket.status, crate::Status::InProgress);
    assert_eq!(
        workspace.github_repositories().unwrap()[0].rule.repository,
        "github.com/o/original"
    );
    workspace
        .remove_github_repository("github.com/o/original")
        .unwrap();
    assert_eq!(workspace.ticket_source_connection("T-OLD").unwrap(), None);
    assert_eq!(
        workspace.show_ticket("T-OLD").unwrap().title,
        "After transfer"
    );
}

fn recorded_gh(status: u16, body: &Value) -> gh::Output {
    gh::Output {
        success: (200..300).contains(&status),
        stdout: format!(
            "HTTP/2.0 {status} recorded\r\nDate: Thu, 01 Jan 2026 00:00:00 GMT\r\nContent-Type: application/json\r\n\r\n{body}"
        ).into_bytes(),
        stderr: Vec::new(),
    }
}

#[test]
fn refresh_batches_empty_conversations_and_reads_existing_events_with_their_rest_ids() {
    let gh = gh::GhApi::new(|args, input, _, _| {
        if args[0] == "auth" {
            return Ok(gh::Output {
                success: true,
                stdout: b"fixture".to_vec(),
                stderr: Vec::new(),
            });
        }
        let body = match *args.last().unwrap() {
            "user" => json!({"id": 1, "login": "octo"}),
            "repos/o/r/issues?state=open&per_page=100" => {
                json!([public_issue(107, 7, "o/r"), public_issue(108, 8, "o/r"),])
            }
            "graphql" => {
                let body: Value = serde_json::from_slice(input.unwrap()).unwrap();
                let query = body["query"].as_str().unwrap();
                assert!(query.contains("i0:"));
                assert!(query.contains("i1:"));
                json!({"data": {
                    "i0": {"issue": {
                        "databaseId": 107,
                        "comments": {"totalCount": 0},
                        "timelineItems": {"nodes": [], "pageInfo": {"hasNextPage": false}}
                    }},
                    "i1": {"issue": {
                        "databaseId": 108,
                        "comments": {"totalCount": 0},
                        "timelineItems": {"nodes": [{"__typename": "AssignedEvent"}], "pageInfo": {"hasNextPage": false}}
                    }}
                }})
            }
            "repos/o/r/issues/8/comments?per_page=100" => json!([]),
            "repos/o/r/issues/8/events?per_page=100" => json!([{
                "id": 901, "event": "assigned", "assignee": {"login": "octo"}, "created_at": "2026-01-01T00:00:00Z"
            }]),
            endpoint => panic!("unexpected GitHub endpoint: {endpoint}"),
        };
        Ok(recorded_gh(200, &body))
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = crate::Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    workspace
        .add_source_connection(
            &engine,
            PROVIDER,
            None,
            None,
            &config(json!({"repositories": ["o/r"]})),
        )
        .unwrap();

    let refresh = workspace
        .refresh_connection(&engine, PROVIDER, &Default::default())
        .unwrap();
    assert!(refresh.failures.is_empty());
    assert_eq!(refresh.imported.len(), 2);
    let event = |reference| {
        workspace
            .source_conversation(reference)
            .unwrap()
            .iter()
            .any(|entry| {
                matches!(
                    entry, crate::source::ConversationEntry::Event { id, .. } if id == "901"
                )
            })
    };
    assert!(!event(&refresh.imported[0]));
    assert!(event(&refresh.imported[1]));
}

#[test]
fn the_github_cli_confirms_each_permanent_hop_of_a_transferred_issue() {
    let gh = gh::GhApi::new(|args, _, _, _| {
        let endpoint = *args.last().unwrap();
        if endpoint == "repos/o/one/issues/7" {
            return Ok(recorded_gh(200, &public_issue(785, 10, "o/two")));
        }
        assert_eq!(endpoint, "https://api.github.com/repos/o/one/issues/7");
        assert!(args.windows(2).any(|pair| pair == ["--method", "HEAD"]));
        Ok(gh::Output {
            success: true,
            stdout: b"< HTTP/2.0 301 Moved Permanently\n< Location: /repos/o/renamed/issues/7\n\n< HTTP/2.0 308 Permanent Redirect\n< Location: /repos/o/two/issues/10\n\n< HTTP/2.0 200 OK\n\n".to_vec(),
            stderr: Vec::new(),
        })
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let original = ExternalRef {
        identity: ExternalIdentity {
            provider: PROVIDER.into(),
            id: "700".into(),
        },
        locator: "o/one#7".into(),
        partition: "o/one".into(),
    };
    let found = engine
        .fetch_tracked(
            PROVIDER,
            &config(json!({"repositories": ["o/one"]})),
            &original,
        )
        .unwrap();
    assert_eq!(found.transferred_from, Some(original));
    assert_eq!(found.issue.reference.identity.id, "785");
}

#[test]
fn removing_a_repository_during_refresh_preserves_its_tickets_and_leaves_the_other_rule_running() {
    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::source::GithubRepositoryRule;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    let mut workspace = crate::Workspace::open(&path).unwrap();
    let removing = Arc::new(AtomicBool::new(false));
    let gh = gh::GhApi::new({
        let removing = removing.clone();
        let path = path.clone();
        move |args, _, _, _| {
            if args[0] == "auth" {
                return Ok(gh::Output {
                    success: true,
                    stdout: b"fixture".to_vec(),
                    stderr: Vec::new(),
                });
            }
            let endpoint = *args.last().unwrap();
            let body = match endpoint {
                "user" => json!({"id": 1, "login": "octo"}),
                "repos/o/one/issues?state=open&per_page=100" => {
                    if removing.swap(false, Ordering::AcqRel) {
                        crate::Workspace::open(&path)
                            .unwrap()
                            .remove_github_repository("GITHUB.COM/O/one")
                            .unwrap();
                        json!([public_issue(101, 1, "o/one"), public_issue(102, 2, "o/one")])
                    } else {
                        json!([public_issue(101, 1, "o/one")])
                    }
                }
                "repos/o/two/issues?state=open&per_page=100" => {
                    json!([public_issue(201, 1, "o/two")])
                }
                "repos/o/one/issues/1" => public_issue(101, 1, "o/one"),
                "repos/o/two/issues/1" => public_issue(201, 1, "o/two"),
                "graphql" => json!({"data": {}}),
                "/user" => json!({"id": 1, "login": "octo"}),
                endpoint if endpoint.ends_with("per_page=100") => json!([]),
                _ => panic!("unexpected GitHub endpoint: {endpoint}"),
            };
            Ok(recorded_gh(200, &body))
        }
    });
    let mut engine = Engine::new();
    engine
        .register(Box::new(GithubConnector::using_gh(
            DEFAULT_API_URL.into(),
            gh,
        )))
        .unwrap();
    let rule = |repository: &str| GithubRepositoryRule {
        repository: repository.into(),
        assignee: None,
        labels: Vec::new(),
    };
    workspace
        .save_github_repository(&engine, rule("github.com/o/one"))
        .unwrap();
    workspace
        .save_github_repository(&engine, rule("github.com/o/two"))
        .unwrap();

    let first = workspace
        .refresh_connection(&engine, PROVIDER, &Default::default())
        .unwrap();
    assert!(first.failures.is_empty(), "{:?}", first.failures);
    assert_eq!(first.imported.len(), 2);
    let one = workspace
        .list_tickets()
        .unwrap()
        .into_iter()
        .find(|ticket| {
            ticket
                .source
                .as_ref()
                .is_some_and(|source| source.id == "101")
        })
        .unwrap();

    removing.store(true, Ordering::Release);
    let removed_during_refresh = workspace
        .refresh_connection(&engine, PROVIDER, &Default::default())
        .unwrap();
    assert!(
        removed_during_refresh.failures.is_empty(),
        "{:?}",
        removed_during_refresh.failures
    );
    assert!(removed_during_refresh.imported.is_empty());
    let repositories = workspace.github_repositories().unwrap();
    assert_eq!(repositories.len(), 1);
    assert_eq!(repositories[0].rule.repository, "github.com/o/two");
    assert_eq!(repositories[0].tracked_tickets, 1);
    assert!(repositories[0].last_refreshed_at.is_some());
    let preserved = workspace.show_ticket(&one.reference).unwrap();
    assert_eq!(preserved.id, one.id);
    let source = preserved.source.unwrap();
    assert_eq!(source.id, "101");
    assert_eq!(source.unavailable.unwrap().code, "connection_removed");

    workspace
        .save_github_repository(&engine, rule("github.com/o/one"))
        .unwrap();
    let again = workspace
        .refresh_connection(&engine, PROVIDER, &Default::default())
        .unwrap();
    assert!(again.imported.is_empty());
    assert_eq!(workspace.show_ticket(&one.reference).unwrap().id, one.id);
    assert!(
        workspace
            .show_ticket(&one.reference)
            .unwrap()
            .source
            .unwrap()
            .unavailable
            .is_none()
    );
}
