//! `ticketd source` against a loopback server standing in for GitHub's API.
//! The desktop is never involved, and nothing here reaches the real network.
// Clippy exempts #[test] functions but not the fake connector and fixture helpers they
// share; those unwrap so a broken setup fails the test loudly.
#![allow(clippy::unwrap_used)]

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Command, Output},
};

use serde_json::{Value, json};

const TOKEN: &str = "ghp_cli_test_secret";

/// Serves canned GitHub responses until the test process exits.
fn serve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut input = BufReader::new(&mut stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if input.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            let length = request
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            // Closing a Windows socket with unread POST bytes can reset the
            // connection before the client receives even a successful response.
            let mut body = vec![0; length];
            input.read_exact(&mut body).unwrap();
            let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
            let authorized = request
                .to_lowercase()
                .contains(&format!("authorization: bearer {TOKEN}").to_lowercase());
            let (status, body) = if !authorized {
                ("401 Unauthorized", json!({"message": "Bad credentials"}))
            } else if request.starts_with("POST ") && path == "/repos/o/r/issues" {
                (
                    "201 Created",
                    json!({"id": 50, "number": 7, "title": "Escalate me", "body": "Why it matters", "state": "open",
                           "html_url": "https://github.example/o/r/issues/7", "assignees": [], "labels": [],
                           "created_at": "", "updated_at": ""}),
                )
            } else if request.starts_with("POST ") && path == "/repos/o/flaky/issues" {
                ("502 Bad Gateway", json!({"message": "upstream"}))
            } else if request.starts_with("POST ") {
                (
                    "403 Forbidden",
                    json!({"message": "Resource not accessible"}),
                )
            } else if path == "/repos/o/flaky/issues/7" {
                // The issue the lost create may have made.
                (
                    "200 OK",
                    json!({"id": 60, "number": 7, "title": "Escalate me", "body": "Why it matters", "state": "open",
                           "html_url": "https://github.example/o/flaky/issues/7", "assignees": [], "labels": [],
                           "created_at": "2999-01-01T00:00:00Z", "updated_at": "2999-01-01T00:00:00Z"}),
                )
            } else if path.starts_with("/repos/o/flaky/issues?") {
                // Nothing in the window matches.
                ("200 OK", json!([]))
            } else if path == "/user" {
                ("200 OK", json!({"login": "octo"}))
            } else if path.starts_with("/user/repos") {
                (
                    "200 OK",
                    json!([{"full_name": "o/alpha", "private": false}, {"full_name": "o/beta", "private": true}]),
                )
            } else if path == "/repos/o/r/issues/1" {
                // The single-issue read used to refresh a tracked ticket: closed since import.
                (
                    "200 OK",
                    json!({"id": 1, "number": 1, "title": "Real issue, renamed", "body": "secret description", "state": "closed",
                           "state_reason": "completed", "html_url": "https://github.example/o/r/issues/1",
                           "assignees": [], "labels": [], "created_at": "", "updated_at": ""}),
                )
            } else if path.starts_with("/repos/o/r/issues/1/comments") {
                (
                    "200 OK",
                    json!([{"id": 501, "user": {"login": "alice"}, "body": "Please take a look",
                            "html_url": "https://github.example/o/r/issues/1#issuecomment-501",
                            "created_at": "2026-01-02T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z"}]),
                )
            } else if path.starts_with("/repos/o/r/issues/1/events") {
                (
                    "200 OK",
                    json!([{"id": 601, "event": "closed", "actor": {"login": "bob"}, "state_reason": "completed",
                            "created_at": "2026-01-03T00:00:00Z"}]),
                )
            } else if path.starts_with("/repos/o/r/issues") {
                (
                    "200 OK",
                    json!([
                        {"id": 1, "number": 1, "title": "Real issue", "body": "secret description", "state": "open",
                         "html_url": "https://github.example/o/r/issues/1", "assignees": [], "labels": [],
                         "created_at": "", "updated_at": ""},
                        {"id": 2, "number": 2, "title": "A pull request", "state": "open", "pull_request": {}}
                    ]),
                )
            } else {
                ("404 Not Found", json!({"message": "Not Found"}))
            };
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    base
}

struct Cli {
    dir: tempfile::TempDir,
    api: String,
}

impl Cli {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            api: serve(),
        }
    }

    fn command(&self, args: &[&str], token: Option<&str>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
        command
            .args(args)
            .env("HOME", self.dir.path())
            .env("XDG_DATA_HOME", self.dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                self.dir.path().join("workspace.sqlite3"),
            )
            .env("TICKETD_GITHUB_API_URL", &self.api)
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .env_remove("TICKETD_GITHUB_TOKEN");
        if let Some(token) = token {
            command.env("TICKETD_GITHUB_TOKEN", token);
        }
        command.output().unwrap()
    }

    fn run(&self, args: &[&str]) -> Value {
        let output = self.command(args, Some(TOKEN));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn fail(&self, args: &[&str], token: Option<&str>) -> String {
        let output = self.command(args, token);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        String::from_utf8(output.stderr).unwrap()
    }
}

#[test]
fn list_describes_the_github_connector_and_its_schema() {
    let cli = Cli::new();
    let listed = cli.run(&["source", "list"]);
    let github = &listed[0];
    assert_eq!(github["connector"]["provider"], "github");
    assert_eq!(github["connector"]["contract_version"], 1);
    assert_eq!(github["saved"], Value::Null);
    let fields: Vec<_> = github["connector"]["schema"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].as_str().unwrap())
        .collect();
    assert_eq!(fields, ["repositories", "assignee", "labels"]);
}

#[test]
fn test_names_the_account_and_a_bad_credential_is_explained_without_echoing_it() {
    let cli = Cli::new();
    assert_eq!(cli.run(&["source", "test", "github"])["account"], "octo");
    let stderr = cli.fail(&["source", "test", "github"], Some("wrong-token"));
    assert!(stderr.contains("rejected the credential"), "{stderr}");
    assert!(!stderr.contains("wrong-token"));
    let stderr = cli.fail(&["source", "test", "github"], None);
    assert!(stderr.contains("gh auth login"), "{stderr}");
    assert!(stderr.contains("TICKETD_GITHUB_TOKEN"), "{stderr}");
}

#[test]
fn preview_lists_issues_without_pull_requests_and_without_descriptions() {
    let cli = Cli::new();
    let output = cli.command(
        &["source", "preview", "github", "--set", "repositories=o/r"],
        Some(TOKEN),
    );
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains(TOKEN) && !text.contains("secret description"));
    let preview: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(preview["account"], "octo");
    assert_eq!(preview["matched"], 1);
    assert_eq!(preview["complete"], true);
    assert_eq!(preview["issues"][0]["display"], "o/r#1");
    // Previewing neither saves a source nor imports a ticket.
    assert_eq!(cli.run(&["source", "show", "github"]), Value::Null);
    assert_eq!(cli.run(&["list"]), json!([]));
}

#[test]
fn save_validates_previews_persists_and_imports_nothing() {
    let cli = Cli::new();
    let saved = cli.run(&[
        "source",
        "save",
        "github",
        "--set",
        "repositories=o/r",
        "--set",
        "assignee=octo",
    ]);
    assert_eq!(saved["source"]["account"], "octo");
    assert_eq!(saved["preview"]["matched"], 1);
    let shown = cli.run(&["source", "show", "github"]);
    assert_eq!(
        shown["config"],
        json!({"repositories": ["o/r"], "assignee": "octo"})
    );
    assert_eq!(cli.run(&["list"]), json!([]));
    // Without settings, preview reuses the saved configuration.
    assert_eq!(cli.run(&["source", "preview", "github"])["matched"], 1);
    let listed = cli.run(&["source", "list"]);
    assert_eq!(listed[0]["saved"]["config"]["repositories"], json!(["o/r"]));
}

#[test]
fn invalid_settings_and_provider_failures_do_not_save() {
    let cli = Cli::new();
    let stderr = cli.fail(
        &["source", "save", "github", "--set", "repositories=nonsense"],
        Some(TOKEN),
    );
    assert!(stderr.contains("repositories"), "{stderr}");
    assert!(stderr.contains("owner/name"), "{stderr}");
    let stderr = cli.fail(
        &["source", "save", "github", "--set", "bogus=1"],
        Some(TOKEN),
    );
    assert!(stderr.contains("bogus"), "{stderr}");
    let stderr = cli.fail(&["source", "save", "github"], Some(TOKEN));
    assert!(stderr.contains("are required"), "{stderr}");
    let stderr = cli.fail(
        &[
            "source",
            "save",
            "github",
            "--set",
            "repositories=o/missing",
        ],
        Some(TOKEN),
    );
    assert!(stderr.contains("was not found"), "{stderr}");
    let stderr = cli.fail(
        &["source", "save", "github", "--set", "repositories=o/r"],
        Some("wrong"),
    );
    assert!(stderr.contains("rejected the credential"), "{stderr}");
    assert_eq!(cli.run(&["source", "show", "github"]), Value::Null);
    let stderr = cli.fail(&["source", "show", "nowhere"], Some(TOKEN));
    assert!(stderr.contains("no source named 'nowhere'"), "{stderr}");
}

#[test]
fn a_json_settings_file_and_option_suggestions_work_from_the_command_line() {
    let cli = Cli::new();
    let file = cli.dir.path().join("settings.json");
    std::fs::write(&file, r#"{"repositories": ["o/r"]}"#).unwrap();
    let preview = cli.run(&[
        "source",
        "preview",
        "github",
        "--config-file",
        file.to_str().unwrap(),
    ]);
    assert_eq!(preview["matched"], 1);
    let options = cli.run(&[
        "source",
        "options",
        "github",
        "repositories",
        "--query",
        "BET",
    ]);
    assert_eq!(options[0]["value"], "o/beta");
}

#[test]
fn refresh_imports_then_tracks_and_protects_external_tickets_without_the_desktop() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    let report = cli.run(&["source", "refresh"]);
    assert_eq!(report["imported"], json!(["T-KQ1"]));
    assert_eq!(report["failures"], json!([]));
    let shown = cli.run(&["show", "T-KQ1"]);
    assert_eq!(shown["title"], "Real issue");
    assert_eq!(shown["source"]["display"], "o/r#1");
    assert_eq!(shown["source"]["ownership"], "external");
    assert_eq!(shown["source"]["content_locked"], true);
    // The source conversation is available to agents, apart from local notes.
    cli.run(&["activity", "add", "T-KQ1", "--brief", "my own observation"]);
    let context = cli.run(&["context", "T-KQ1", "--conversation", "--activities"]);
    let first = &context["source_conversation"]["items"][0];
    assert_eq!(
        (first["type"].as_str(), first["author"].as_str()),
        (Some("comment"), Some("alice"))
    );
    assert_eq!(first["body"]["text"], "Please take a look");
    assert_eq!(
        context["source_conversation"]["items"][1]["event"],
        "closed_completed"
    );
    assert_eq!(context["activities"]["items"].as_array().unwrap().len(), 1);
    assert!(
        cli.run(&["context", "T-KQ1"])
            .get("source_conversation")
            .is_none()
    );
    // External content is read-only; local progress is allowed.
    let stderr = cli.fail(&["change", "T-KQ1", "--title", "Mine"], None);
    assert!(stderr.contains("owned by GitHub"), "{stderr}");
    cli.run(&["change", "T-KQ1", "--status", "In progress"]);
    assert_eq!(
        cli.run(&["list", "--source", "github"])
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(cli.run(&["list", "--source", "local"]), json!([]));
    // A source that does not exist is refused rather than listing nothing.
    let stderr = cli.fail(&["list", "--source", "githb"], None);
    assert!(stderr.contains("unknown source 'githb'"), "{stderr}");
    // Refreshing the single ticket observes that the issue closed.
    let report = cli.run(&["source", "refresh", "--ticket", "T-KQ1"]);
    assert_eq!(report["updated"], json!(["T-KQ1"]));
    let shown = cli.run(&["show", "T-KQ1"]);
    assert_eq!(shown["status"], "Done");
    assert_eq!(shown["title"], "Real issue, renamed");
    // A failed refresh reports and fails, and leaves the saved content alone.
    let output = cli.command(&["source", "refresh", "--ticket", "T-KQ1"], Some("wrong"));
    assert_eq!(output.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["failures"][0]["code"], "unauthenticated");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("wrong"));
    assert_eq!(cli.run(&["show", "T-KQ1"])["title"], "Real issue, renamed");
    assert!(cli.run(&["show", "T-KQ1"])["source"]["last_error"]["code"] == "unauthenticated");
}

/// Naming an agent changes attribution only: a hosted agent meets the same source
/// authority as anyone, and keeps the local progress writes everyone has.
#[test]
fn an_attributed_agent_records_progress_on_an_external_ticket_but_cannot_edit_its_content() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    cli.run(&["source", "refresh"]);
    let agent = ["--agent", "codex"];

    let stderr = cli.fail(
        &[&["change", "T-KQ1", "--title", "Mine"], &agent[..]].concat(),
        None,
    );
    assert!(stderr.contains("owned by GitHub"), "{stderr}");
    let request = cli.dir.path().join("rewrite.json");
    std::fs::write(
        &request,
        json!({"operation": "change_ticket", "reference": "T-KQ1",
               "patch": {"body": "Mine", "editing_agent": "codex"}})
        .to_string(),
    )
    .unwrap();
    let stderr = cli.fail(
        &[
            "write",
            request.to_str().unwrap(),
            "--request-id",
            "rewrite-1",
        ],
        None,
    );
    assert!(stderr.contains("owned by GitHub"), "{stderr}");
    let stderr = cli.fail(
        &[&["change", "T-KQ1", "--status", "Done"], &agent[..]].concat(),
        None,
    );
    assert!(stderr.contains("GitHub"), "{stderr}");

    let changed = cli.run(&[&["change", "T-KQ1", "--status", "In progress"], &agent[..]].concat());
    assert_eq!(changed["status"], "In progress");
    let activity = cli.run(
        &[
            &["activity", "add", "T-KQ1", "--brief", "Started"],
            &agent[..],
        ]
        .concat(),
    );
    assert_eq!(activity["editing_agent"], "codex");
    let document = cli.run(&[
        "document", "create", "--title", "Findings", "--body", "Notes",
    ]);
    cli.command(
        &[
            "document",
            "link-ticket",
            document["id"].as_str().unwrap(),
            "T-KQ1",
        ],
        None,
    );
    let evidence = cli.run(
        &[
            &[
                "evidence", "add", "T-KQ1", "--kind", "commit", "--name", "fix", "--value",
                "abc123",
            ],
            &agent[..],
        ]
        .concat(),
    );
    assert_eq!(evidence["editing_agent"], "codex");

    let shown = cli.run(&["show", "T-KQ1"]);
    assert_eq!(shown["title"], "Real issue");
    assert_eq!(shown["body"], "secret description");
    assert_eq!(shown["source"]["ownership"], "external");
    let linked = cli.run(&["context", "T-KQ1", "--documents"]);
    assert_eq!(linked["documents"]["items"][0]["id"], document["id"]);
}

fn local_ticket(cli: &Cli) -> String {
    let created = cli.run(&["create", "Escalate me"]);
    let reference = created["reference"].as_str().unwrap().to_owned();
    cli.run(&["change", &reference, "--body", "Why it matters"]);
    reference
}

#[test]
fn publish_reports_the_core_attachment_preflight_without_creating_an_issue() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    let reference = local_ticket(&cli);
    let uri = "ticketd://attachment/foreign-workspace/trace-file";
    cli.run(&["change", &reference, "--body", &format!("[trace]({uri})")]);
    let preview = cli.run(&["source", "publish", &reference, "--preview"]);
    assert_eq!(preview["eligibility"]["reason"], "internal_attachments");
    assert_eq!(preview["internal_attachments"][0]["uri"], uri);
    assert_eq!(preview["local"]["attachments"], 0);
    let message = preview["eligibility"]["message"].as_str().unwrap();
    assert!(message.contains("Remove these links"), "{message}");
    let error = cli.fail(&["source", "publish", &reference], Some(TOKEN));
    assert!(error.contains(message), "{error}");
    assert!(cli.run(&["show", &reference])["publication"].is_null());
    assert!(cli.run(&["show", &reference])["source"].is_null());
}

#[test]
fn publish_previews_then_creates_one_issue_and_replays_without_another() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    let reference = local_ticket(&cli);

    let preview = cli.run(&["source", "publish", &reference, "--preview"]);
    assert_eq!(preview["title"], "Escalate me");
    assert_eq!(preview["body"], "Why it matters");
    assert_eq!(preview["destination"], "o/r");
    assert_eq!(preview["eligibility"]["kind"], "eligible");
    assert_eq!(cli.run(&["show", &reference])["source"], Value::Null);

    let outcome = cli.run(&["source", "publish", &reference]);
    assert_eq!(outcome["replayed"], false);
    assert_eq!(outcome["attempt"]["state"], "succeeded");
    assert_eq!(outcome["ticket"]["source"]["display"], "o/r#7");
    assert_eq!(outcome["ticket"]["source"]["origin"], "published");
    assert_eq!(outcome["ticket"]["source"]["ownership"], "external");

    let again = cli.run(&["source", "publish", &reference]);
    assert_eq!(again["replayed"], true);
    assert_eq!(again["attempt"]["id"], outcome["attempt"]["id"]);
    let shown = cli.run(&["show", &reference]);
    assert_eq!(shown["reference"], reference);
    assert!(shown["publication"].is_null());
}

#[test]
fn a_refused_publication_fails_with_the_reason_and_leaves_the_ticket_local() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    let reference = local_ticket(&cli);
    let output = cli.command(
        &["source", "publish", &reference, "--destination", "o/denied"],
        Some(TOKEN),
    );
    assert_eq!(output.status.code(), Some(1));
    let attempt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(attempt["state"], "failed");
    assert_eq!(attempt["failure"]["code"], "forbidden");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("remains a local ticket"), "{stderr}");
    assert_eq!(cli.run(&["show", &reference])["source"], Value::Null);
}

#[test]
fn an_unclear_answer_is_unresolved_visible_and_blocks_publishing_again() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    let reference = local_ticket(&cli);
    let args = ["source", "publish", &reference, "--destination", "o/flaky"];
    let output = cli.command(&args, Some(TOKEN));
    assert_eq!(output.status.code(), Some(1));
    let attempt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(attempt["state"], "unresolved");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("may already exist"), "{stderr}");

    // A new process sees the same open attempt, and a second create is refused.
    let shown = cli.run(&["show", &reference]);
    assert_eq!(shown["publication"]["state"], "unresolved");
    assert_eq!(shown["source"], Value::Null);
    let stderr = cli.fail(&args, Some(TOKEN));
    assert!(
        stderr.contains("resolve it before creating another"),
        "{stderr}"
    );
    let preview = cli.run(&["source", "publish", &reference, "--preview"]);
    assert_eq!(preview["eligibility"]["reason"], "attempt_open");
    assert_eq!(preview["attempt"]["state"], "unresolved");
}

fn unresolved_ticket(cli: &Cli) -> String {
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    let reference = local_ticket(cli);
    let args = ["source", "publish", &reference, "--destination", "o/flaky"];
    assert_eq!(cli.command(&args, Some(TOKEN)).status.code(), Some(1));
    age_attempts(cli);
    reference
}

/// Makes every attempt an hour old, so a search counts for a "not created"
/// verdict (GitHub lists a just-created issue only after a moment).
fn age_attempts(cli: &Cli) {
    let db = rusqlite::Connection::open(cli.dir.path().join("workspace.sqlite3")).unwrap();
    db.execute_batch(
        "UPDATE publication_attempts SET \
         started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '-1 hour'), \
         lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at, '-1 hour')",
    )
    .unwrap();
}

#[test]
fn resolve_reviews_then_attaches_a_verified_issue_without_creating_another() {
    let cli = Cli::new();
    let reference = unresolved_ticket(&cli);

    // The review changes nothing and states what is known and unknown.
    let review = cli.run(&["source", "resolve", &reference]);
    assert_eq!(review["attempt"]["state"], "unresolved");
    assert!(review["unknown"].as_str().unwrap().contains("whether"));
    assert_eq!(review["candidates_complete"], true);
    assert_eq!(review["actions"][0]["kind"], "attach");
    assert_eq!(review["actions"][1]["available"], true);
    assert_eq!(cli.run(&["show", &reference])["source"], Value::Null);

    // An issue that cannot be verified is refused and the attempt stays unresolved.
    let wrong = cli.command(
        &["source", "resolve", &reference, "--issue", "other/repo#7"],
        Some(TOKEN),
    );
    assert_eq!(wrong.status.code(), Some(1));
    let stderr = String::from_utf8(wrong.stderr).unwrap();
    assert!(stderr.contains("the issue is not in o/flaky"), "{stderr}");
    let no_credential = cli.command(&["source", "resolve", &reference, "--issue", "7"], None);
    assert_eq!(no_credential.status.code(), Some(1));
    assert_eq!(
        cli.run(&["show", &reference])["publication"]["state"],
        "unresolved"
    );

    let outcome = cli.run(&["source", "resolve", &reference, "--issue", "7"]);
    assert_eq!(outcome["replayed"], false);
    assert_eq!(outcome["attempt"]["state"], "succeeded");
    assert_eq!(outcome["ticket"]["source"]["display"], "o/flaky#7");
    assert_eq!(outcome["ticket"]["source"]["origin"], "published");

    let again = cli.run(&["source", "resolve", &reference, "--issue", "7"]);
    assert_eq!(again["replayed"], true);
}

#[test]
fn resolve_not_created_needs_evidence_and_then_allows_publishing_again() {
    let cli = Cli::new();
    let reference = unresolved_ticket(&cli);

    // Without a credential nothing can be proven: still unresolved, still blocked.
    let output = cli.command(&["source", "resolve", &reference, "--not-created"], None);
    assert_eq!(output.status.code(), Some(1));
    let attempt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(attempt["state"], "unresolved");
    assert_eq!(
        cli.run(&["show", &reference])["publication"]["state"],
        "unresolved"
    );

    let outcome = cli.run(&["source", "resolve", &reference, "--not-created"]);
    assert_eq!(outcome["attempt"]["state"], "failed");
    assert_eq!(outcome["attempt"]["failure"]["code"], "ruled_out");
    assert_eq!(outcome["ticket"]["publication"], Value::Null);
    let preview = cli.run(&["source", "publish", &reference, "--preview"]);
    assert_eq!(preview["eligibility"]["kind"], "eligible");
}

#[test]
fn status_reports_freshness_and_what_is_unavailable_after_a_failed_refresh() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    cli.run(&["source", "refresh"]);
    let status = cli.run(&["source", "status"]);
    assert_eq!(status[0]["provider"], "github");
    assert_eq!(status[0]["error"], Value::Null);
    assert!(status[0]["last_refreshed_at"].is_string());
    assert_eq!(status[0]["unavailable_tickets"], 0);

    // A refresh that cannot read the source fails, keeps the ticket, and says so.
    let output = cli.command(&["source", "refresh"], Some("wrong"));
    assert_eq!(output.status.code(), Some(1));
    let status = cli.run(&["source", "status"]);
    assert_eq!(status[0]["error"]["code"], "unauthenticated");
    assert!(status[0]["failing_since"].is_string());
    assert_eq!(status[0]["unavailable_tickets"], 1);
    let shown = cli.run(&["show", "T-KQ1"]);
    assert_eq!(shown["title"], "Real issue");
    assert_eq!(shown["source"]["unavailable"]["code"], "unauthenticated");
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("wrong"),
        "no credential in output"
    );
}

#[test]
fn take_ownership_makes_an_unavailable_ticket_local_and_stops_synchronizing_it() {
    let cli = Cli::new();
    cli.run(&["source", "save", "github", "--set", "repositories=o/r"]);
    cli.run(&["source", "refresh"]);
    // Reachable tickets are not taken over.
    let stderr = cli.fail(&["source", "take-ownership", "T-KQ1"], None);
    assert!(stderr.contains("can still be read"), "{stderr}");
    cli.command(&["source", "refresh"], Some("wrong"));
    let taken = cli.run(&["source", "take-ownership", "T-KQ1", "--agent", "tester"]);
    assert_eq!(taken["reference"], "T-KQ1");
    assert_eq!(taken["title"], "Real issue");
    assert_eq!(taken["source"]["ownership"], "local");
    assert_eq!(taken["source"]["display"], "o/r#1");
    assert_eq!(taken["source"]["unavailable"], Value::Null);
    assert_eq!(cli.run(&["list", "--source", "github"]), json!([]));
    assert_eq!(
        cli.run(&["list", "--source", "local"])
            .as_array()
            .unwrap()
            .len(),
        1
    );
    cli.run(&["change", "T-KQ1", "--title", "Mine"]);
    // A later refresh with working access neither resumes nor re-imports it.
    let report = cli.run(&["source", "refresh"]);
    assert_eq!(report["imported"], json!([]));
    assert_eq!(cli.run(&["show", "T-KQ1"])["title"], "Mine");
    let stderr = cli.fail(&["source", "refresh", "--ticket", "T-KQ1"], None);
    assert!(
        stderr.contains("not owned by an external source"),
        "{stderr}"
    );
    assert!(
        cli.run(&["history", "T-KQ1"])
            .to_string()
            .contains("ownership")
    );
}
