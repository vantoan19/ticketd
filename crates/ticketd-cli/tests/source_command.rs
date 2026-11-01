//! `ticketd source` against a loopback server standing in for GitHub's API.
//! The desktop is never involved, and nothing here reaches the real network.
#![allow(clippy::unwrap_used)]

use std::{
    io::{Read, Write},
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
            let mut buffer = [0u8; 8192];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
            let authorized = request
                .to_lowercase()
                .contains(&format!("authorization: bearer {TOKEN}").to_lowercase());
            let (status, body) = if !authorized {
                ("401 Unauthorized", json!({"message": "Bad credentials"}))
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
    assert!(stderr.contains("is required"), "{stderr}");
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
    assert_eq!(report["imported"], json!(["T-1"]));
    assert_eq!(report["failures"], json!([]));
    let shown = cli.run(&["show", "T-1"]);
    assert_eq!(shown["title"], "Real issue");
    assert_eq!(shown["source"]["display"], "o/r#1");
    assert_eq!(shown["source"]["ownership"], "external");
    assert_eq!(shown["source"]["content_locked"], true);
    // The source conversation is available to agents, apart from local notes.
    cli.run(&["note", "add", "T-1", "--content", "my own observation"]);
    let context = cli.run(&["context", "T-1", "--conversation", "--notes"]);
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
    assert_eq!(context["notes"]["items"].as_array().unwrap().len(), 1);
    assert!(
        cli.run(&["context", "T-1"])
            .get("source_conversation")
            .is_none()
    );
    // External content is read-only; local progress is allowed.
    let stderr = cli.fail(&["change", "T-1", "--title", "Mine"], None);
    assert!(stderr.contains("owned by github"), "{stderr}");
    cli.run(&["change", "T-1", "--status", "In progress"]);
    assert_eq!(
        cli.run(&["list", "--source", "github"])
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(cli.run(&["list", "--source", "local"]), json!([]));
    // Refreshing the single ticket observes that the issue closed.
    let report = cli.run(&["source", "refresh", "--ticket", "T-1"]);
    assert_eq!(report["updated"], json!(["T-1"]));
    let shown = cli.run(&["show", "T-1"]);
    assert_eq!(shown["status"], "Done");
    assert_eq!(shown["title"], "Real issue, renamed");
    // A failed refresh reports and fails, and leaves the saved content alone.
    let output = cli.command(&["source", "refresh", "--ticket", "T-1"], Some("wrong"));
    assert_eq!(output.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["failures"][0]["code"], "unauthenticated");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("wrong"));
    assert_eq!(cli.run(&["show", "T-1"])["title"], "Real issue, renamed");
    assert!(cli.run(&["show", "T-1"])["source"]["last_error"]["code"] == "unauthenticated");
}
