#![cfg(debug_assertions)]
#![allow(clippy::unwrap_used)]

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::Command,
    thread,
    time::{Duration, SystemTime},
};

use serde_json::{Value, json};
use ticketd_core::{
    Error, Workspace,
    source::{
        ActionKind, ConfigValues, ConformanceOptions, ConformanceOutcome, ExtensionRegistry,
        PublicationError, PublicationSearch, PublishOptions, PublishRequest, RefreshOptions,
        Resolution, ResolveOptions,
    },
};

const ENDPOINT: &str = "LINEAR_GRAPHQL_TEST_ENDPOINT";
const TEAM: &str = "10000000-0000-4000-8000-000000000001";
const TEAM_TWO: &str = "10000000-0000-4000-8000-000000000002";
const ISSUE: &str = "20000000-0000-4000-8000-000000000001";
const ISSUE_TWO: &str = "20000000-0000-4000-8000-000000000002";
const USER: &str = "30000000-0000-4000-8000-000000000001";
const USER_TWO: &str = "30000000-0000-4000-8000-000000000002";
const CREATED: &str = "20000000-0000-4000-8000-000000000003";
const LOST: &str = "20000000-0000-4000-8000-000000000004";
const LOST_TITLE: &str = "Mutation committed before its answer was lost";
const DEVICE_AHEAD: &str = "2025-01-03T15:20:00Z";
const READY: &str = "2025-01-03T15:35:00Z";
const SITE: &str = "40000000-0000-4000-8000-000000000001";
const KEY: &str = "lin_api_synthetic_ticketd";
const TIME: &str = "2025-01-03T09:20:00.000Z";

#[test]
fn linear_passes_strict_conformance_through_the_host() {
    // Set an endpoint on the test process before starting the host. The
    // extension must receive it through its ordinary manifest environment.
    if let Ok(endpoint) = std::env::var("LINEAR_CONFORMANCE_CHILD") {
        assert_eq!(std::env::var(ENDPOINT).unwrap(), endpoint);
        return verify_connector();
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let mut created = None;
        let mut lost = None;
        for stream in listener.incoming() {
            let stream = stream.unwrap();
            if !serve(stream, &mut created, &mut lost) {
                break;
            }
        }
        (created, lost)
    });
    let endpoint = format!("http://{address}/graphql");
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "linear_passes_strict_conformance_through_the_host",
            "--nocapture",
        ])
        .env("LINEAR_CONFORMANCE_CHILD", &endpoint)
        .env(ENDPOINT, &endpoint)
        .env("TICKETD_SOURCE_CONFORMANCE_API_KEY", KEY)
        .env("TICKETD_SOURCE_LINEAR_API_KEY", KEY)
        .output()
        .unwrap();
    drop(TcpStream::connect(address).unwrap());
    let (created, lost) = server.join().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(created.unwrap()["id"], CREATED);
    assert_eq!(lost.unwrap()["id"], LOST);
}

fn verify_connector() {
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("extension");
    std::fs::create_dir(&package).unwrap();
    let artifact = Path::new(env!("CARGO_BIN_EXE_ticketd-source-linear"));
    let name = artifact.file_name().unwrap().to_str().unwrap();
    std::fs::copy(artifact, package.join(name)).unwrap();
    std::fs::write(
        package.join("ticketd-source.json"),
        json!({
            "id": "linear",
            "version": env!("CARGO_PKG_VERSION"),
            "executable": format!("./{name}"),
            "env": [ENDPOINT],
            "hosts": ["api.linear.app"],
        })
        .to_string(),
    )
    .unwrap();

    let registry = ExtensionRegistry::new(root.path().join("registry"));
    registry.link(&package).unwrap();
    let config: ConfigValues = serde_json::from_value(json!({
        "team": [TEAM_TWO, TEAM],
        "assignee": ["me"],
    }))
    .unwrap();
    let connector = registry
        .engine()
        .unwrap()
        .for_connection("linear", "conformance", &config);
    let assignees = connector
        .options("linear", "assignee", "", &config)
        .unwrap();
    assert_eq!(
        assignees
            .iter()
            .map(|option| option.value.as_str())
            .collect::<Vec<_>>(),
        ["me", USER, USER_TWO]
    );
    let labels = connector.options("linear", "labels", "", &config).unwrap();
    assert_eq!(labels[0].label, "Across teams");
    assert_conformance(&registry, &config, None);

    let mut bare_teams = config;
    bare_teams.remove("assignee");
    assert_conformance(&registry, &bare_teams, None);
    assert_conformance(&registry, &bare_teams, Some(TEAM_TWO));

    let incomplete = connector
        .find_published(
            "linear",
            &bare_teams,
            &PublicationSearch {
                request: PublishRequest {
                    title: "Fixture issue".into(),
                    body: String::new(),
                    destination: TEAM_TWO.into(),
                },
                since: TIME.into(),
                tracker_since: Some("2025-01-03T09:19:00Z".into()),
                account: Some(USER.into()),
            },
        )
        .unwrap();
    assert!(
        !incomplete.complete,
        "a repeated continuation cannot prove absence"
    );
    assert_eq!(incomplete.matches.len(), 1);
    assert_eq!(incomplete.matches[0].reference.identity.id, ISSUE_TWO);
    recover_lost_publication(&registry, root.path(), &bare_teams);
}

fn recover_lost_publication(registry: &ExtensionRegistry, root: &Path, config: &ConfigValues) {
    let path = root.join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let engine = registry.engine().unwrap();
    workspace
        .add_source_connection(&engine, "linear", None, None, config)
        .unwrap();
    let reference = workspace.create_ticket(LOST_TITLE).unwrap().reference;
    let options = PublishOptions {
        provider: "linear".into(),
        destination: Some(TEAM_TWO.into()),
        now: Some(DEVICE_AHEAD.into()),
        ..Default::default()
    };
    assert!(matches!(
        workspace.publish_ticket(&engine, &reference, &options),
        Err(Error::Publication(PublicationError::Unresolved { .. }))
    ));
    drop(workspace);
    let mut workspace = Workspace::open(path).unwrap();

    let report = workspace
        .refresh_connection(
            &engine,
            "linear",
            &RefreshOptions {
                ticket: None,
                now: Some(READY.into()),
            },
        )
        .unwrap();
    assert_eq!(
        report.imported.len(),
        2,
        "a refresh must reserve the uncertain issue"
    );
    let review = workspace
        .review_publication_at(&engine, &reference, true, Some(READY))
        .unwrap();
    assert_eq!(review.candidates.len(), 1, "{review:?}");
    assert_eq!(review.candidates[0].identity.id, LOST);
    assert_eq!(review.attempt.destination, TEAM_TWO);
    assert_eq!(
        review.attempt.destination_label.as_deref(),
        Some("Second Team (SECOND)")
    );
    assert!(review.known[0].contains("Second Team (SECOND)"));
    assert!(!review.known[0].contains(TEAM_TWO));
    assert!(
        review
            .actions
            .iter()
            .any(|action| action.kind == ActionKind::NotCreated && !action.available)
    );
    assert!(matches!(
        workspace.publish_ticket(
            &engine,
            &reference,
            &PublishOptions {
                now: Some(READY.into()),
                ..options
            }
        ),
        Err(Error::Publication(PublicationError::Ineligible { .. }))
    ));
    assert!(matches!(
        workspace.resolve_publication(
            &engine,
            &reference,
            &ResolveOptions {
                resolution: Resolution::Attach { issue: Some("#1".into()) },
                now: Some(READY.into()),
                agent: None,
                accept_different_content: true,
            },
        ),
        Err(Error::Publication(PublicationError::Mismatch { message, .. }))
            if message.contains("created before this publication began")
    ));
    let candidates_without_tracker_time = engine
        .for_connection("linear", "linear", config)
        .find_published(
            "linear",
            config,
            &PublicationSearch {
                request: PublishRequest {
                    destination: TEAM_TWO.into(),
                    title: LOST_TITLE.into(),
                    body: String::new(),
                },
                since: DEVICE_AHEAD.into(),
                tracker_since: None,
                account: Some(USER.into()),
            },
        )
        .unwrap();
    assert!(!candidates_without_tracker_time.complete);
    assert_eq!(
        candidates_without_tracker_time.matches[0]
            .reference
            .identity
            .id,
        LOST
    );

    let result = workspace
        .resolve_publication(
            &engine,
            &reference,
            &ResolveOptions {
                resolution: Resolution::Attach {
                    issue: Some("https://linear.app/fixture/issue/SECOND-3".into()),
                },
                now: Some(READY.into()),
                agent: None,
                accept_different_content: false,
            },
        )
        .unwrap();
    assert_eq!(result.ticket.reference, reference);
    assert_eq!(result.attempt.issue.unwrap().identity.id, LOST);

    let ticket = workspace.create_ticket("Untrusted tracker time").unwrap();
    let error = workspace
        .publish_ticket(
            &engine,
            &ticket.reference,
            &PublishOptions {
                provider: "linear".into(),
                destination: Some(TEAM_TWO.into()),
                now: Some(DEVICE_AHEAD.into()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(
        error,
        Error::Publication(PublicationError::Failed { .. })
    ));
    assert!(
        error.to_string().contains("did not confirm its clock"),
        "{error}"
    );
}

fn assert_conformance(registry: &ExtensionRegistry, config: &ConfigValues, publish: Option<&str>) {
    let report = registry
        .conformance(
            "linear",
            config,
            &ConformanceOptions {
                strict: true,
                publish: publish.map(str::to_owned),
                past_end_cursor: Some("fixture-end".into()),
                skip_reasons: [
                    (
                        "typed_closure".into(),
                        "this fixture does not model all typed states".into(),
                    ),
                    (
                        "publication_failure_outcomes".into(),
                        "the lost-mutation fixture runs separately".into(),
                    ),
                ]
                .into(),
                ..ConformanceOptions::default()
            },
        )
        .unwrap();
    assert!(
        report.passed,
        "filtered={}: {report:?}",
        config.contains_key("assignee")
    );
    let publication = report
        .checks
        .iter()
        .find(|check| check.name == "publication")
        .unwrap();
    assert!(if publish.is_some() {
        matches!(publication.outcome, ConformanceOutcome::Passed)
    } else {
        matches!(publication.outcome, ConformanceOutcome::Skipped)
    });
    for check in [
        "version_refusal",
        "options",
        "cancellation",
        "empty_continuation",
        "stable_identity",
        "conversation",
    ] {
        assert!(
            report.checks.iter().any(
                |item| item.name == check && matches!(item.outcome, ConformanceOutcome::Passed)
            ),
            "{report:?}"
        );
    }
}

fn page(nodes: Vec<Value>, cursor: Option<&str>) -> Value {
    json!({"nodes": nodes, "pageInfo": {"hasNextPage": cursor.is_some(), "endCursor": cursor}})
}

fn issue(id: &str, team: &str, identifier: &str) -> Value {
    json!({
        "id": id, "identifier": identifier, "url": format!("https://linear.app/fixture/issue/{identifier}"),
        "title": "Fixture issue", "description": "Synthetic description",
        "createdAt": TIME, "updatedAt": TIME, "trashed": false,
        "team": {"id": team}, "state": {"name": "Done label in open state", "type": "started"},
        "creator": {"id": USER, "displayName": "Fixture User"}, "assignee": null, "labels": page(vec![], None),
    })
}

fn teams() -> Vec<Value> {
    vec![
        json!({"id": TEAM, "key": "TST", "name": "Fixture Team"}),
        json!({"id": TEAM_TWO, "key": "SECOND", "name": "Second Team"}),
    ]
}

fn serve(stream: TcpStream, created: &mut Option<Value>, lost: &mut Option<Value>) -> bool {
    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap() == 0 {
        return false;
    }
    assert_eq!(line.trim(), "POST /graphql HTTP/1.1");
    let mut length = 0;
    let mut authorized = false;
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        let (field, value) = line.split_once(':').unwrap();
        if field.eq_ignore_ascii_case("Content-Length") {
            length = value.trim().parse().unwrap();
        } else if field.eq_ignore_ascii_case("Authorization") {
            authorized = value.trim() == KEY;
        }
    }
    assert!(authorized);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let request: Value = serde_json::from_slice(&body).unwrap();
    let variables = &request["variables"];
    let after = variables["after"].as_str();
    let fields = match request["operationName"].as_str().unwrap() {
        "LinearConnection" => {
            let fields = json!({"viewer": {"id": USER, "displayName": "Fixture User"},
                   "organization": {"id": SITE}});
            if lost.is_some() {
                return respond_with_clock(stream, fields, None);
            }
            fields
        }
        "LinearConfiguredTeams" => {
            assert_eq!(variables["teams"], json!([TEAM, TEAM_TWO]));
            json!({"teams": page(teams(), None)})
        }
        "LinearMe" => json!({"viewer": {"id": USER}}),
        "LinearTeams" => json!({"teams": page(teams(), None)}),
        "LinearAssignees" => {
            let mut people = vec![json!({"id": USER, "displayName": "Fixture User"})];
            if variables["team"] == TEAM_TWO {
                people.push(json!({"id": USER_TWO, "displayName": "Second User"}));
            } else {
                assert_eq!(variables["team"], TEAM);
            }
            json!({"team": {"members": page(people, None)}})
        }
        "LinearLabels" => {
            assert_eq!(variables["teams"], json!([TEAM, TEAM_TWO]));
            json!({"issueLabels": page(vec![json!({"id": "60000000-0000-4000-8000-000000000001", "name": "Across teams"})], None)})
        }
        "LinearDiscover" => {
            let mut filter = json!({"team": {"id": {"in": [TEAM, TEAM_TWO]}}});
            if !variables["filter"]["assignee"].is_null() {
                filter["assignee"] = json!({"id": {"eq": USER}});
            }
            if after.is_none() {
                // Keep fixture work in flight while the host cancels after progress.
                thread::sleep(Duration::from_millis(150));
            }
            assert_eq!(variables["filter"], filter);
            json!({"issues": match after {
                None => page(vec![], Some("issues")),
                Some("issues") if variables["first"] == 1 => page(vec![issue(ISSUE, TEAM, "TST-1")], Some("more-issues")),
                Some("issues") => page(
                    [issue(ISSUE, TEAM, "TST-1"), issue(ISSUE_TWO, TEAM_TWO, "SECOND-1")]
                        .into_iter().chain(lost.iter().cloned()).collect(),
                    None,
                ),
                Some("fixture-end") => page(vec![], None),
                Some("more-issues") => page(vec![issue(ISSUE_TWO, TEAM_TWO, "SECOND-1")], None),
                _ => unreachable!(),
            }})
        }
        "LinearPublish" if variables["input"]["title"] == LOST_TITLE => {
            assert!(
                lost.is_none(),
                "ticketd must never repeat an uncertain mutation"
            );
            assert_eq!(variables["input"]["teamId"], TEAM_TWO);
            let mut result = issue(LOST, TEAM_TWO, "SECOND-3");
            result["title"] = json!(LOST_TITLE);
            result["description"] = variables["input"]["description"].clone();
            *lost = Some(result);
            // The issue is durable, while the connection closes without a response.
            return true;
        }
        "LinearPublish" => {
            assert!(
                created.is_none(),
                "only explicit publication may create one issue"
            );
            let input = variables["input"].as_object().unwrap();
            assert_eq!(input.len(), 3);
            assert_eq!(input["teamId"], TEAM_TWO);
            assert!(
                input["title"]
                    .as_str()
                    .unwrap()
                    .starts_with("ticketd conformance ")
            );
            assert_eq!(
                input["description"],
                "Created by an explicit ticketd source conformance publication check."
            );
            let mut result = issue(CREATED, TEAM_TWO, "SECOND-2");
            let now = chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339();
            result["createdAt"] = json!(now);
            result["updatedAt"] = json!(now);
            result["title"] = input["title"].clone();
            result["description"] = input["description"].clone();
            *created = Some(result.clone());
            json!({"issueCreate": {"success": true, "issue": result}})
        }
        "LinearLocate" => {
            let found = match variables["id"].as_str() {
                Some("SECOND-1") => {
                    let mut old = issue(ISSUE_TWO, TEAM_TWO, "SECOND-1");
                    old["createdAt"] = json!("2025-01-03T08:20:00Z");
                    old
                }
                Some("SECOND-2") => created.clone().unwrap(),
                Some("SECOND-3") => lost.clone().unwrap(),
                _ => unreachable!(),
            };
            json!({"issue": found})
        }
        "LinearDestinationTeam" => {
            assert_eq!(variables["team"], TEAM_TWO);
            json!({"team": &teams()[1]})
        }
        "LinearPublicationSearch" => {
            let filter = &variables["filter"];
            assert_eq!(filter["team"]["id"]["eq"], TEAM_TWO);
            let since = filter["createdAt"]["gte"]
                .as_str()
                .map(|since| chrono::DateTime::parse_from_rfc3339(since).unwrap());
            if let Some(lost) = lost.as_ref() {
                let after_cutoff = since.is_none_or(|since| {
                    chrono::DateTime::parse_from_rfc3339(TIME).unwrap() >= since
                });
                return respond(
                    stream,
                    json!({
                        "issues": page(if after_cutoff { vec![lost.clone()] } else { vec![] }, None)
                    }),
                );
            }
            if since == Some(chrono::DateTime::parse_from_rfc3339("2025-01-03T09:19:00Z").unwrap())
            {
                return respond(
                    stream,
                    json!({"issues": match after {
                        None => page(vec![issue(ISSUE_TWO, TEAM_TWO, "SECOND-1")], Some("repeated")),
                        Some("repeated") => page(vec![], Some("repeated")),
                        _ => unreachable!(),
                    }}),
                );
            }
            json!({"issues": match after {
                None => page(vec![], Some("published")),
                Some("published") => page(vec![created.as_ref().unwrap().clone()], None),
                _ => unreachable!(),
            }})
        }
        "LinearFetch" => {
            let issue = match variables["id"].as_str() {
                Some(ISSUE) => issue(ISSUE, TEAM, "TST-1"),
                Some(ISSUE_TWO) => issue(ISSUE_TWO, TEAM_TWO, "SECOND-1"),
                _ => unreachable!(),
            };
            json!({"issue": issue})
        }
        "LinearComments" => {
            if variables["id"] != ISSUE {
                return respond(stream, json!({"issue": {"comments": page(vec![], None)}}));
            }
            let row = |id| json!({"id": id, "body": "A comment", "createdAt": TIME, "updatedAt": TIME, "url": "https://linear.app/fixture/issue/TST-1"});
            json!({"issue": {"comments": match after {
                None => page(vec![row("50000000-0000-4000-8000-000000000001")], Some("more-comments")),
                Some("more-comments") => page(vec![row("50000000-0000-4000-8000-000000000002")], None),
                _ => unreachable!(),
            }}})
        }
        "LinearHistory" => {
            assert_eq!(after, None);
            json!({"issue": {"history": page(vec![], None)}})
        }
        _ => unreachable!("{request:?}"),
    };
    respond(stream, fields)
}

fn respond(stream: TcpStream, fields: Value) -> bool {
    respond_with_clock(stream, fields, Some("Fri, 03 Jan 2025 09:20:00 GMT"))
}

fn respond_with_clock(mut stream: TcpStream, fields: Value, clock: Option<&str>) -> bool {
    let data = json!({"data": fields}).to_string();
    let date = clock.map_or_else(String::new, |date| format!("Date: {date}\r\n"));
    write!(stream, "HTTP/1.1 200 OK\r\n{date}Content-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{data}", data.len()).unwrap();
    true
}
