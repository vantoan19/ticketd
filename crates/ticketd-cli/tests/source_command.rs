//! `ticketd source` through `gh` against a loopback GitHub API fixture.
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

#[test]
fn migration_keeps_the_saved_enterprise_repository_host() {
    let cli = Cli::new();
    let path = cli.dir.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 105).unwrap();
    rusqlite::Connection::open(path).unwrap().execute_batch(
        r#"INSERT INTO source_connections
         (id, name, provider, site, configuration, account, account_key, contract_version, saved_at, revision)
         VALUES ('github', 'Work', 'github', 'git.example.test:8443', '{"repositories":["Work/Fixtures"]}',
                 'first-account', 'first-account', 2, '2026-01-01T00:00:00Z', 'test');"#,
    ).unwrap();
    let integration = cli.run(&["source", "github", "status"]);
    assert_eq!(
        integration["repositories"][0]["repository"],
        "git.example.test:8443/work/fixtures"
    );
    assert_eq!(cli.run(&["source", "list"])[0]["saved"], Value::Null);
}

const TOKEN: &str = "ghp_cli_test_secret";
const SECOND_TOKEN: &str = "ghp_second_cli_test_secret";
const ISSUE_CREATED_AT: &str = "2026-01-01T00:00:00Z";
const ISSUE_CLOSED_AT: &str = "2026-01-03T00:00:00Z";

/// Serves canned GitHub responses until the test process exits.
fn serve() -> String {
    serve_site("https://github.example", 50)
}

fn serve_site(issue_origin: &'static str, published_id: i64) -> String {
    serve_site_with_login(issue_origin, published_id, || "octo")
}

fn serve_site_with_login(
    issue_origin: &'static str,
    published_id: i64,
    login: impl Fn() -> &'static str + Send + 'static,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let issue_origin = if issue_origin == "https://github.example" {
        base.clone()
    } else {
        issue_origin.into()
    };
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
            let request_headers = request.to_lowercase();
            let second = request_headers
                .contains(&format!("authorization: token {SECOND_TOKEN}").to_lowercase());
            let authorized = second
                || request_headers
                    .contains(&format!("authorization: token {TOKEN}").to_lowercase());
            let (status, body) = if !authorized {
                ("401 Unauthorized", json!({"message": "Bad credentials"}))
            } else if request.starts_with("POST ") && path == "/repos/o/r/issues" {
                (
                    "201 Created",
                    json!({"id": published_id, "number": 7, "title": "Escalate me", "body": "Why it matters", "state": "open",
                           "html_url": "https://github.example/o/r/issues/7", "assignees": [], "labels": [],
                           "created_at": ISSUE_CREATED_AT, "updated_at": ISSUE_CREATED_AT}),
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
                           "user": {"id": 1, "login": "octo"},
                           "created_at": "2999-01-01T00:00:00Z", "updated_at": "2999-01-01T00:00:00Z"}),
                )
            } else if path.starts_with("/repos/o/flaky/issues?") {
                // Nothing in the window matches.
                ("200 OK", json!([]))
            } else if path.starts_with("/repos/o/denied/issues") {
                // A repository the account can read but not create issues in.
                ("200 OK", json!([]))
            } else if path == "/user" {
                (
                    "200 OK",
                    json!({"id": if second { 2 } else { 1 }, "login": if second { "other" } else { login() }}),
                )
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
                           "assignees": [], "labels": [], "created_at": ISSUE_CREATED_AT, "updated_at": ISSUE_CLOSED_AT}),
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
            } else if path.starts_with("/repos/o/beta/issues") {
                (
                    "200 OK",
                    if path.contains("/comments") || path.contains("/events") {
                        json!([])
                    } else {
                        json!([{"id": 8, "number": 1, "title": "Other account issue", "state": "open",
                        "html_url": "https://github.example/o/beta/issues/1", "created_at": ISSUE_CREATED_AT, "updated_at": ISSUE_CREATED_AT}])
                    },
                )
            } else if path.starts_with("/repos/o/r/issues") {
                (
                    "200 OK",
                    json!([
                        {"id": 1, "number": 1, "title": "Real issue", "body": "secret description", "state": "open",
                         "html_url": "https://github.example/o/r/issues/1", "assignees": [], "labels": [],
                         "created_at": ISSUE_CREATED_AT, "updated_at": ISSUE_CREATED_AT},
                        {"id": 2, "number": 2, "title": "A pull request", "state": "open", "pull_request": {}}
                    ]),
                )
            } else {
                ("404 Not Found", json!({"message": "Not Found"}))
            };
            let body = body
                .to_string()
                .replace("https://github.example", &issue_origin);
            let response = format!(
                "HTTP/1.1 {status}\r\nDate: Thu, 01 Jan 2026 00:00:00 GMT\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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

    fn remote(&self, repository: &str) -> String {
        format!("{}/{repository}", self.api.strip_prefix("http://").unwrap())
    }

    fn add(&self, repository: &str) -> Value {
        self.run(&["source", "github", "repository", &self.remote(repository)])
    }

    fn command(&self, args: &[&str], token: Option<&str>) -> Output {
        self.command_with_second(args, token, None)
    }

    fn command_with_second(
        &self,
        args: &[&str],
        token: Option<&str>,
        second: Option<&str>,
    ) -> Output {
        let mut command = self.process(args);
        if let Some(token) = second.or(token) {
            command.env("GH_ENTERPRISE_TOKEN", token);
        }
        command.output().unwrap()
    }

    fn process(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
        command
            .args(args)
            .env("HOME", self.dir.path())
            .env("XDG_DATA_HOME", self.dir.path())
            .env("GH_CONFIG_DIR", self.dir.path().join("gh-config"))
            .env(
                "TICKETD_TEST_WORKSPACE",
                self.dir.path().join("workspace.sqlite3"),
            )
            .env(
                "TICKETD_SOURCE_EXTENSIONS_DIR",
                self.dir.path().join("extensions"),
            )
            .env("TICKETD_GITHUB_API_URL", &self.api)
            .env("TICKETD_LOG", "ticketd_core::source=debug")
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .env_remove("GH_ENTERPRISE_TOKEN")
            .env_remove("GITHUB_ENTERPRISE_TOKEN")
            .env_remove("GH_HOST");
        command
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
    assert_eq!(github["connector"]["contract_version"], 2);
    let presentation = &github["connector"]["presentation"];
    assert!(
        presentation["icon_svg"]
            .as_str()
            .unwrap()
            .starts_with("<svg")
    );
    assert_eq!(presentation["target"]["field"], "repositories");
    assert_eq!(presentation["target"]["example"], "owner/name");
    assert!(
        presentation["sign_in"]["terminal_hint"]
            .as_str()
            .unwrap()
            .contains("GH_ENTERPRISE_TOKEN")
    );
    assert_eq!(github["saved"], Value::Null);
    let fields: Vec<_> = github["connector"]["schema"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].as_str().unwrap())
        .collect();
    assert_eq!(fields, ["repositories", "assignee", "labels", "account"]);
    let schema = &github["connector"]["schema"]["fields"];
    assert_eq!(schema[0]["required"], true);
    assert!(schema[0]["help"].is_string());
    assert!(schema[1]["pattern"]["regex"].is_string());
}

#[test]
fn github_repository_preview_validates_assignee_and_labels() {
    let cli = Cli::new();
    let repository = cli.remote("o/r");
    let pattern = cli.fail(
        &[
            "source",
            "github",
            "repository",
            &repository,
            "--assignee=-octo",
            "--preview",
        ],
        Some(TOKEN),
    );
    assert!(pattern.contains("assignee"), "{pattern}");
    let connector = cli.fail(
        &[
            "source",
            "github",
            "repository",
            &repository,
            "--label",
            "first
second",
        ],
        Some(TOKEN),
    );
    assert!(connector.contains("labels"), "{connector}");
    assert_eq!(
        cli.run(&["source", "github", "status"])["repositories"],
        json!([])
    );
}

#[test]
fn project_connect_source_translates_the_offline_preview_and_confirmation() {
    let cli = Cli::new();
    cli.add("o/r");
    let refresh = cli.run(&["source", "github", "refresh"]);
    let ticket = refresh["imported"][0].as_str().unwrap();
    let created = cli.command(
        &[
            "project",
            "create",
            "Tracked repository",
            cli.dir.path().to_str().unwrap(),
            "--remote",
            "127.0.0.1/o/r",
        ],
        None,
    );
    assert!(created.status.success());
    let project: Value = serde_json::from_slice(&created.stdout).unwrap();
    let id = project["id"].as_str().unwrap();
    let hint = String::from_utf8(created.stderr).unwrap();
    assert!(hint.contains(&format!("ticketd project connect-source {id} --preview")));

    let preview = cli.command(&["project", "connect-source", id, "--preview"], None);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let preview: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(preview["project_id"], id);
    assert_eq!(preview["project_remote"], "127.0.0.1/o/r");
    assert_eq!(preview["provider"], "github");
    assert_eq!(preview["connection_id"], Value::Null);
    assert_eq!(preview["repository"], "o/r");
    assert_eq!(preview["source"], "already_listed");
    assert_eq!(preview["tickets"], json!([ticket]));
    assert_eq!(cli.run(&["show", ticket])["project_id"], Value::Null);
    let invalid = cli.fail(
        &["project", "connect-source", id, "--expect", "wrong"],
        None,
    );
    assert!(invalid.contains("Preview again"), "{invalid}");

    let fingerprint = preview["fingerprint"].as_str().unwrap();
    let confirmed = cli.command(
        &["project", "connect-source", id, "--expect", fingerprint],
        None,
    );
    assert!(
        confirmed.status.success(),
        "{}",
        String::from_utf8_lossy(&confirmed.stderr)
    );
    let confirmed: Value = serde_json::from_slice(&confirmed.stdout).unwrap();
    assert_eq!(
        confirmed,
        json!({"repository_added": false, "linked_tickets": [ticket]})
    );
    assert_eq!(cli.run(&["show", ticket])["project_id"], id);
}

#[test]
fn github_test_reports_host_readiness_without_printing_the_credential() {
    let cli = Cli::new();
    let host = cli.api.strip_prefix("http://").unwrap();
    let arguments = ["source", "github", "test", "--host", host];
    let signed_in = cli.run(&arguments);
    assert_eq!(signed_in["state"], "connected");
    assert_eq!(signed_in["login"], "octo");
    let wrong = cli.command(&arguments, Some("wrong-token"));
    assert!(wrong.status.success());
    let text = String::from_utf8(wrong.stdout).unwrap();
    assert!(!text.contains("wrong-token"));
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["state"],
        "not_signed_in"
    );
    let absent = cli.command(&arguments, None);
    let status: Value = serde_json::from_slice(&absent.stdout).unwrap();
    assert_eq!(status["state"], "not_signed_in");
}

fn gh_accounts(directory: &std::path::Path, accounts: &[(&str, &str)]) {
    let config = directory.join("gh-config");
    std::fs::create_dir_all(&config).unwrap();
    let mut hosts = String::from("127.0.0.1:\n    users:\n");
    for (account, token) in accounts {
        hosts.push_str(&format!(
            "        {account}:\n            oauth_token: {token}\n"
        ));
    }
    std::fs::write(config.join("hosts.yml"), hosts).unwrap();
}

#[test]
fn project_pins_a_named_login_for_the_github_host() {
    let cli = Cli::new();
    gh_accounts(cli.dir.path(), &[("octo", TOKEN), ("other", SECOND_TOKEN)]);
    let site = cli.api.strip_prefix("http://").unwrap();
    let project = cli.run(&[
        "project",
        "create",
        "GitHub",
        cli.dir.path().to_str().unwrap(),
        "--remote",
        "127.0.0.1/o/r",
    ]);
    let project_id = project["id"].as_str().unwrap();
    let set = |login| {
        cli.run(&[
            "source",
            "github",
            "project-login",
            project_id,
            "--host",
            site,
            "--login",
            login,
        ])
    };
    assert_eq!(set("other")["ok"], true);
    let row = cli.add("o/r");
    assert_eq!(row["project_login"], "other");
    let failure = cli.fail(
        &[
            "source",
            "github",
            "project-login",
            project_id,
            "--host",
            site,
            "--login",
            "unknown",
        ],
        Some(TOKEN),
    );
    assert!(failure.contains("unavailable"), "{failure}");
    assert_eq!(
        cli.run(&["source", "github", "status"])["repositories"][0]["project_login"],
        "other"
    );
}

#[test]
fn taking_over_a_local_ticket_says_it_is_already_local() {
    let cli = Cli::new();
    let created = cli.run(&["create", "Mine"]);
    let reference = created["reference"].as_str().unwrap();
    let stderr = cli.fail(&["source", "take-ownership", reference], Some(TOKEN));
    assert!(stderr.contains("already a local ticket"), "{stderr}");
    assert!(!stderr.contains("refresh"), "{stderr}");
}

#[test]
fn preview_lists_issues_without_pull_requests_and_without_descriptions() {
    let cli = Cli::new();
    let output = cli.command(
        &[
            "source",
            "github",
            "repository",
            &cli.remote("o/r"),
            "--preview",
        ],
        Some(TOKEN),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains(TOKEN) && !text.contains("secret description"));
    let preview: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(preview["account"], "octo");
    assert_eq!(preview["matched"], 1);
    assert_eq!(preview["complete"], true);
    assert_eq!(preview["issues"][0]["display"], "o/r#1");
    assert_eq!(
        cli.run(&["source", "github", "status"])["repositories"],
        json!([])
    );
    assert_eq!(cli.run(&["list"]), json!([]));
}

#[test]
fn adding_a_repository_saves_its_filters_and_imports_nothing() {
    let cli = Cli::new();
    let repository = cli.remote("o/r");
    let saved = cli.run(&[
        "source",
        "github",
        "repository",
        &repository,
        "--assignee",
        "octo",
    ]);
    assert_eq!(saved["assignee"], "octo");
    assert_eq!(saved["repository"], repository);
    assert_eq!(
        cli.run(&["source", "github", "status"])["repositories"],
        json!([saved])
    );
    assert_eq!(cli.run(&["list"]), json!([]));
}

#[test]
fn invalid_credentials_and_missing_repositories_do_not_save() {
    let cli = Cli::new();
    let stderr = cli.fail(
        &["source", "github", "repository", &cli.remote("o/missing")],
        Some(TOKEN),
    );
    assert!(stderr.contains("was not found"), "{stderr}");
    let stderr = cli.fail(
        &["source", "github", "repository", &cli.remote("o/r")],
        Some("wrong"),
    );
    assert!(stderr.contains("rejected the credential"), "{stderr}");
    assert_eq!(
        cli.run(&["source", "github", "status"])["repositories"],
        json!([])
    );
    let stderr = cli.fail(&["source", "nowhere", "show"], Some(TOKEN));
    assert!(
        stderr.contains("no saved source connection named nowhere"),
        "{stderr}"
    );
}

#[test]
fn refresh_imports_then_tracks_and_protects_external_tickets_without_the_desktop() {
    let cli = Cli::new();
    cli.add("o/r");
    let report = cli.run(&["source", "github", "refresh"]);
    assert_eq!(report["imported"], json!(["T-KQ1"]));
    assert_eq!(report["failures"], json!([]));
    let shown = cli.run(&["show", "T-KQ1"]);
    assert_eq!(shown["title"], "Real issue");
    assert_eq!(shown["source"]["display"], "o/r#1");
    assert_eq!(
        shown["source"]["state"],
        json!({"category": "open", "name": "Open"})
    );
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
        "closed"
    );
    assert_eq!(
        context["source_conversation"]["items"][1]["state_category"],
        "completed"
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
    let report = cli.run(&["source", "github", "refresh", "--ticket", "T-KQ1"]);
    assert_eq!(report["updated"], json!(["T-KQ1"]));
    let shown = cli.run(&["show", "T-KQ1"]);
    assert_eq!(shown["status"], "Done");
    assert_eq!(shown["title"], "Real issue, renamed");
    // A failed refresh reports and fails, and leaves the saved content alone.
    let output = cli.command(
        &["source", "github", "refresh", "--ticket", "T-KQ1"],
        Some("wrong"),
    );
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
    cli.add("o/r");
    cli.run(&["source", "github", "refresh"]);
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
    cli.add("o/r");
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
    cli.add("o/r");
    let reference = local_ticket(&cli);

    let preview = cli.run(&["source", "publish", &reference, "--preview"]);
    assert_eq!(preview["title"], "Escalate me");
    assert_eq!(preview["body"], "Why it matters");
    assert_eq!(preview["destination"], cli.remote("o/r"));
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
fn publication_replays_after_removing_the_repository() {
    let cli = Cli::new();
    cli.add("o/r");
    let reference = local_ticket(&cli);
    let args = ["source", "publish", &reference, "--provider", "github"];
    let first = cli.run(&args);
    assert_eq!(first["replayed"], false);
    cli.run(&["source", "github", "remove", &cli.remote("o/r")]);
    let replay = cli.run(&args);
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["attempt"]["id"], first["attempt"]["id"]);
}

#[test]
fn a_refused_publication_fails_with_the_reason_and_leaves_the_ticket_local() {
    let cli = Cli::new();
    cli.add("o/r");
    cli.add("o/denied");
    let reference = local_ticket(&cli);
    let output = cli.command(
        &[
            "source",
            "publish",
            &reference,
            "--destination",
            &cli.remote("o/denied"),
        ],
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
    cli.add("o/r");
    cli.add("o/flaky");
    let reference = local_ticket(&cli);
    let args = [
        "source",
        "publish",
        &reference,
        "--destination",
        &cli.remote("o/flaky"),
    ];
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
    cli.add("o/r");
    cli.add("o/flaky");
    let reference = local_ticket(cli);
    let args = [
        "source",
        "publish",
        &reference,
        "--destination",
        &cli.remote("o/flaky"),
    ];
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
    gh_accounts(cli.dir.path(), &[("octo", TOKEN)]);

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
    let no_credential = cli
        .process(&["source", "resolve", &reference, "--issue", "7"])
        .env("GH_CONFIG_DIR", cli.dir.path().join("empty-gh-config"))
        .output()
        .unwrap();
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

    gh_accounts(cli.dir.path(), &[("octo", TOKEN)]);
    let outcome = cli.run(&["source", "resolve", &reference, "--not-created"]);
    assert_eq!(outcome["attempt"]["state"], "failed");
    assert_eq!(outcome["attempt"]["failure"]["code"], "ruled_out");
    assert_eq!(outcome["ticket"]["publication"], Value::Null);
    let preview = cli.run(&[
        "source",
        "publish",
        &reference,
        "--destination",
        &cli.remote("o/flaky"),
        "--preview",
    ]);
    assert_eq!(preview["eligibility"]["kind"], "eligible");
}

#[test]
fn status_reports_freshness_and_what_is_unavailable_after_a_failed_refresh() {
    let cli = Cli::new();
    cli.add("o/r");
    cli.run(&["source", "github", "refresh"]);
    let status = cli.run(&["source", "github", "status"]);
    assert_eq!(status["id"], "github");
    assert_eq!(status["repositories"][0]["error"], Value::Null);
    assert!(status["repositories"][0]["last_refreshed_at"].is_string());

    // A refresh that cannot read the source fails, keeps the ticket, and says so.
    let output = cli.command(&["source", "github", "refresh"], Some("wrong"));
    assert_eq!(output.status.code(), Some(1));
    let status = cli.run(&["source", "github", "status"]);
    assert_eq!(
        status["repositories"][0]["error"]["code"],
        "unauthenticated"
    );
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
    cli.add("o/r");
    cli.run(&["source", "github", "refresh"]);
    // Reachable tickets are not taken over.
    let stderr = cli.fail(&["source", "take-ownership", "T-KQ1"], None);
    assert!(stderr.contains("can still be read"), "{stderr}");
    cli.command(&["source", "github", "refresh"], Some("wrong"));
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
    let report = cli.run(&["source", "github", "refresh"]);
    assert_eq!(report["imported"], json!([]));
    assert_eq!(cli.run(&["show", "T-KQ1"])["title"], "Mine");
    let stderr = cli.fail(&["source", "github", "refresh", "--ticket", "T-KQ1"], None);
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

#[test]
fn local_source_commands_work_when_the_extension_registry_cannot_be_opened() {
    let cli = Cli::new();
    cli.add("o/r");
    let imported = cli.run(&["source", "github", "refresh"]);
    let reference = imported["imported"][0].as_str().unwrap();
    let registry = cli.dir.path().join("broken-registry");
    std::fs::write(&registry, "not a folder").unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env(
                "TICKETD_TEST_WORKSPACE",
                cli.dir.path().join("workspace.sqlite3"),
            )
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };

    assert_eq!(run(&["source", "github", "status"])["id"], "github");
    assert_eq!(
        run(&["source", "github", "remove", &cli.remote("o/r")])["ok"],
        true
    );
    assert_eq!(
        run(&["source", "take-ownership", reference])["source"]["ownership"],
        "local"
    );
}

#[test]
fn repository_rules_share_the_integration_and_publish_uses_the_selected_destination() {
    let cli = Cli::new();
    cli.add("o/r");
    cli.add("o/beta");
    let listed = cli.run(&["source", "github", "status"]);
    assert_eq!(listed["repositories"].as_array().unwrap().len(), 2);
    let report = cli.run(&["source", "github", "refresh"]);
    assert_eq!(report["imported"].as_array().unwrap().len(), 2);
    let local = local_ticket(&cli);
    let preview = cli.run(&[
        "source",
        "publish",
        &local,
        "--destination",
        &cli.remote("o/beta"),
        "--preview",
    ]);
    assert_eq!(preview["destination"], cli.remote("o/beta"));
    assert_eq!(preview["eligibility"]["kind"], "eligible");
}

#[test]
fn github_help_lists_repository_operations_without_opening_a_workspace() {
    let cli = Cli::new();
    let help = cli.command(&["source", "github", "--help"], None);
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(
        text.contains("ticketd source github") && text.contains("repository"),
        "{text}"
    );
    assert!(!cli.dir.path().join("workspace.sqlite3").exists());
}

#[test]
fn removing_a_repository_keeps_the_open_publication_attempt() {
    let cli = Cli::new();
    let reference = unresolved_ticket(&cli);
    let before = cli.run(&["show", &reference]);
    cli.run(&["source", "github", "remove", &cli.remote("o/flaky")]);
    assert_eq!(
        cli.run(&["show", &reference])["publication"],
        before["publication"]
    );
    let review = cli.run(&["source", "resolve", &reference, "--no-search"]);
    assert_eq!(review["attempt"]["state"], "unresolved");
}
