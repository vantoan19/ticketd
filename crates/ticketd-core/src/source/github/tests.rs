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

use super::*;
use crate::source::{Engine, schema::ConfigValues};

const API: &str = "https://api.example.test";
const TOKEN: &str = "ghp_secret_token_value";

#[derive(Default)]
struct Fixture {
    routes: Mutex<BTreeMap<String, VecDeque<Result<HttpResponse, String>>>>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl Fixture {
    fn respond(&self, url: &str, response: Result<HttpResponse, String>) {
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
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
        self.0.requests.lock().unwrap().push(request.clone());
        self.0
            .routes
            .lock()
            .unwrap()
            .get_mut(&request.url)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Err(format!("no fixture for {}", request.url)))
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
    let connector = GithubConnector::new(
        API,
        Box::new(Shared(fixture.clone())),
        Box::new(Token(token)),
    );
    let mut engine = Engine::new();
    engine.register(Box::new(connector)).unwrap();
    (fixture, engine)
}

fn ok(body: Value) -> Result<HttpResponse, String> {
    ok_with(body, &[])
}

fn ok_with(body: Value, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
    Ok(HttpResponse {
        status: 200,
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        body: body.to_string().into_bytes(),
    })
}

fn status(code: u16, body: Value, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
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
    fixture.respond(&second, ok(json!([issue(3, 3, "o/one")])));
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
    let cases: Vec<(Result<HttpResponse, String>, &str)> = vec![
        (
            status(401, json!({"message": "Bad credentials"}), &[]),
            "unauthenticated",
        ),
        (
            status(403, json!({"message": "Resource not accessible"}), &[]),
            "forbidden",
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
        (
            status(404, json!({"message": "Not Found"}), &[]),
            "not_found",
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
    timeline: Result<HttpResponse, String>,
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
    };
    engine
        .fetch(
            "github",
            &config(json!({"repositories": ["o/one"]})),
            &reference,
        )
        .unwrap()
}

fn timeline(nodes: Value) -> Result<HttpResponse, String> {
    ok(json!({"data": {"repository": {"issue": {"timelineItems": {"nodes": nodes}}}}}))
}

fn marked(duplicate: u64, canonical: Value) -> Value {
    json!({"__typename": "MarkedAsDuplicateEvent", "duplicate": {"databaseId": duplicate}, "canonical": canonical})
}

fn issue_node(id: u64, number: u64, repo: &str) -> Value {
    json!({"__typename": "Issue", "databaseId": id, "number": number, "repository": {"nameWithOwner": repo}})
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
