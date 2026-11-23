//! Narrow transport-level tests: GitHub's wire format in, neutral contract
//! types out. No test touches the network except the loopback server.

use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    net::TcpListener,
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
        self.0
            .routes
            .lock()
            .unwrap()
            .get_mut(&request.url)
            .and_then(VecDeque::pop_front)
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
    let fixture = Arc::new(Fixture::default());
    let mut engine = Engine::new();
    engine
        .register(Box::new(connector(&fixture, token)))
        .unwrap();
    (fixture, engine)
}

fn connector(fixture: &Arc<Fixture>, token: Option<&'static str>) -> GithubConnector {
    GithubConnector::new(
        API,
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
        "html_url": format!("https://github.example/{repo}/issues/{number}"),
        "repository_url": format!("{API}/repos/{repo}"),
        "assignees": [{"login": "octo"}], "labels": [{"name": "bug"}, "plain"],
        "user": {"login": "alice"},
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z"
    })
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
    assert_eq!(issues[0].reference.identity.id, "1");
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
        (
            json!("completed"),
            ExternalState::Closed {
                reason: ClosureReason::Completed,
            },
        ),
        (
            json!("not_planned"),
            ExternalState::Closed {
                reason: ClosureReason::NotPlanned,
            },
        ),
        (
            json!("duplicate"),
            ExternalState::Closed {
                reason: ClosureReason::Duplicate,
            },
        ),
        (
            json!(null),
            ExternalState::Closed {
                reason: ClosureReason::Unknown,
            },
        ),
        (
            json!("something_new"),
            ExternalState::Closed {
                reason: ClosureReason::Unknown,
            },
        ),
    ] {
        let mut closed = issue(7, 7, "o/one");
        closed["state"] = json!("closed");
        closed["state_reason"] = reason;
        fixture.respond(&format!("{API}/repos/o/one/issues/7"), ok(closed));
        let reference = ExternalRef {
            identity: ExternalIdentity {
                provider: "github".into(),
                id: "7".into(),
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
        assert_eq!(fetched.state, expected);
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
        engine.fetch("github", &values, &reference("7")),
        Err(SourceError::NotFound(_))
    ));
    fixture.respond(
        &format!("{API}/repos/o/one/issues/7"),
        ok(issue(8, 7, "o/one")),
    );
    assert!(matches!(
        engine.fetch("github", &values, &reference("7")),
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
            id: "7".into(),
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
    fixture.respond(&format!("{API}/user"), ok(json!({"login": "octo"})));
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
    assert_eq!(error.issues()[0].field, "repositories");
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
    fixture.respond(&format!("{API}/user"), ok(json!({"login": "octo"})));
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
        ["o/gone", "o/live"]
    );
    assert_eq!(found, ["o/live"]);
    assert_eq!(summary.skipped[0].partition, "o/gone");
}

/// A repository is read under its assignee and labels, named alike whatever their
/// case or order, and by its bare name when neither narrows discovery.
#[test]
fn a_repository_is_read_under_its_assignee_and_labels() {
    let (fixture, engine) = setup(Some(TOKEN));
    let scope = |values: serde_json::Value| {
        fixture.respond(&format!("{API}/user"), ok(json!({"login": "octo"})));
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
fn connection_check_names_the_account_and_preview_lists_matches() {
    let (fixture, engine) = setup(Some(TOKEN));
    fixture.respond(&format!("{API}/user"), ok(json!({"login": "octo"})));
    fixture.respond(&format!("{API}/user"), ok(json!({"login": "octo"})));
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
fn the_real_transport_pages_over_http_and_sends_the_credential() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server_base = base.clone();
    let server = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let path = request.split_whitespace().nth(1).unwrap().to_owned();
            let (body, link) = if path.contains("page=2") {
                (json!([issue(2, 2, "o/one")]).to_string(), String::new())
            } else {
                (
                    json!([issue(1, 1, "o/one")]).to_string(),
                    format!("Link: <{server_base}/repos/o/one/issues?page=2>; rel=\"next\"\r\n"),
                )
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{link}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            seen.push(request);
        }
        seen
    });

    let connector = GithubConnector::new(
        base,
        Box::new(UreqTransport::new()),
        Box::new(Token(Some(TOKEN))),
    );
    let mut engine = Engine::new();
    engine.register(Box::new(connector)).unwrap();
    let issues = discover_all(&engine, &config(json!({"repositories": ["o/one"]}))).unwrap();
    assert_eq!(issues.len(), 2);
    let requests = server.join().unwrap();
    for request in &requests {
        let lower = request.to_lowercase();
        assert!(lower.contains(&format!("authorization: bearer {TOKEN}").to_lowercase()));
        assert!(lower.contains("user-agent: ticketd"));
    }
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
            id: "7".into(),
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
    assert_eq!(target.identity.id, "900");
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
    assert_eq!(fetched.duplicate_of.unwrap().identity.id, "900");
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
    assert_eq!(target.identity.id, "900");
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
    assert_eq!(fetched.duplicate_of.unwrap().identity.id, "900");
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([
            closed_as_duplicate(issue_node(800, 8, "o/one")),
            marked(7, issue_node(900, 9, "o/one")),
        ])),
    );
    assert_eq!(fetched.duplicate_of.unwrap().identity.id, "900");
    // A closure that names nothing leaves an earlier mark standing.
    let fetched = fetch_duplicate(
        &fixture,
        &engine,
        timeline(json!([
            marked(7, issue_node(800, 8, "o/one")),
            closed_as_duplicate(Value::Null),
        ])),
    );
    assert_eq!(fetched.duplicate_of.unwrap().identity.id, "800");
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
            ExternalState::Closed {
                reason: ClosureReason::Duplicate
            }
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
            id: "7".into(),
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

    assert_eq!(created.reference.identity.id, "77");
    assert_eq!(created.reference.locator, "o/r#12");
    assert_eq!(created.state, ExternalState::Open);
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
            id: "7".into(),
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
            ExternalEventKind::Closed(ClosureReason::Duplicate),
            ExternalEventKind::Reopened,
            ExternalEventKind::Closed(ClosureReason::NotPlanned),
            ExternalEventKind::Closed(ClosureReason::Unknown),
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
        "https://github.example/o/r/issues/12",
    ] {
        let (fixture, engine) = setup(Some(TOKEN));
        fixture.respond(
            &format!("{API}/repos/o/r/issues/12"),
            ok(issue(77, 12, "o/r")),
        );
        let found = locate_in(&engine, text).unwrap();
        assert_eq!(found.reference.identity.id, "77", "{text}");
        assert_eq!(found.display, "o/r#12");
    }
    for text in [
        "other/repo#12",
        "https://github.example/other/repo/issues/12",
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

fn search_for_title(engine: &Engine) -> Result<PublicationCandidates, SourceError> {
    engine.find_published(
        "github",
        &config(json!({"repositories": ["o/r"]})),
        &PublicationSearch {
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
    assert_eq!(ids, ["9", "6"], "title and normalized body match only");
}

#[test]
fn the_accounts_other_issues_in_the_window_are_listed_apart_and_only_a_text_match_blocks() {
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
                account: Some("octo".into()),
                request: publish_request(),
                since: "2026-03-01T00:00:00Z".into(),
            },
        )
        .unwrap();
    // The rewritten issue does not match the sent text, so it is listed for
    // information only; someone else's issue is not listed at all.
    assert!(found.matches.is_empty());
    let ids: Vec<_> = found
        .recent
        .iter()
        .map(|i| i.reference.identity.id.as_str())
        .collect();
    assert_eq!(ids, ["9"]);
}

#[test]
fn a_local_clock_ahead_of_githubs_moves_the_search_window_back() {
    let (fixture, engine) = setup(Some(TOKEN));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // GitHub says it is an hour earlier than this machine thinks.
    let github_now = chrono::DateTime::from_timestamp(i64::try_from(now).unwrap() - 3600, 0)
        .unwrap()
        .to_rfc2822();
    fixture.respond(
        &format!("{API}/rate_limit"),
        ok_with(json!({}), &[("date", &github_now)]),
    );
    // Whether the search itself is answered does not matter; its window does.
    let _ = search_for_title(&engine);
    let urls = fixture.urls();
    let search = urls.iter().find(|url| url.contains("since=")).unwrap();
    let since = search.split("since=").nth(1).unwrap().replace("%3A", ":");
    let since = chrono::DateTime::parse_from_rfc3339(&since).unwrap();
    let expected = chrono::DateTime::parse_from_rfc3339("2026-03-01T00:00:00Z").unwrap()
        - chrono::Duration::seconds(3600);
    assert!((since - expected).num_seconds().abs() <= 5, "{since}");
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
            terminal.ends_with(
                ". From a script, set TICKETD_GITHUB_TOKEN to a token that can read and create issues instead."
            ),
            "{terminal}"
        );
        assert!(!terminal.contains("Settings"), "{terminal}");
        let desktop = error.message_for(Surface::Desktop);
        assert!(
            desktop.ends_with(". Then choose Check connection in Settings."),
            "{desktop}"
        );
        assert!(!desktop.contains("TICKETD_GITHUB_TOKEN"), "{desktop}");
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
    fixture.respond(&format!("{API}/user"), ok(json!({"login": "octo"})));
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
