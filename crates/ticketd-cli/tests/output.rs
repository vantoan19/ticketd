#[cfg(unix)]
#[test]
fn closed_stdout_reports_an_error_without_panicking() {
    use std::{
        os::unix::net::UnixStream,
        process::{Command, Stdio},
    };

    let directory =
        std::env::temp_dir().join(format!("ticketd-output-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let (reader, writer) = UnixStream::pair().unwrap();
    drop(reader);
    let result = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .arg("list")
        .env("HOME", &directory)
        .env("XDG_DATA_HOME", &directory)
        .env(
            "TICKETD_TEST_WORKSPACE",
            directory.join("workspace.sqlite3"),
        )
        .stdout(Stdio::from(std::os::fd::OwnedFd::from(writer)))
        .output()
        .unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    assert_eq!(result.status.code(), Some(1));
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(stderr.starts_with("error:"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}

#[test]
fn cli_status_change_appears_in_followed_inbox() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str], input: Option<&str>| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    run(&["create", "CLI status"], None);
    run(
        &["write", "-", "--request-id", "follow"],
        Some(r#"{"operation":"set_following","reference":"T-1","following":true}"#),
    );
    run(&["change", "T-1", "--status", "Done"], None);
    let inbox: serde_json::Value = serde_json::from_str(&run(&["inbox"], None)).unwrap();
    assert_eq!(inbox[0]["reference"], "T-1");
    assert_eq!(inbox[0]["to_value"], "Done");
    assert_eq!(inbox[0]["read"], false);
    run(
        &["write", "-", "--request-id", "note"],
        Some(
            r#"{"operation":"add_activity","reference":"T-1","brief":"CLI finding","agent":"runner"}"#,
        ),
    );
    let inbox: serde_json::Value = serde_json::from_str(&run(&["inbox"], None)).unwrap();
    assert_eq!(inbox[0]["kind"], "activity");
    assert_eq!(inbox[0]["to_value"], "CLI finding");
    assert_eq!(inbox[0]["editing_agent"], "runner");
}

#[test]
fn cli_manages_and_reads_named_evidence() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    run(&["create", "Ship"]);
    let added = run(&[
        "evidence",
        "add",
        "T-1",
        "--kind",
        "verification",
        "--name",
        "Tests",
        "--value",
        "Unit tests passed",
        "--agent",
        "bot",
    ]);
    assert_eq!(added["editing_agent"], "bot");
    assert_eq!(
        run(&["context", "T-1", "--evidence"])["evidence"]["items"][0]["value"]["text"],
        "Unit tests passed"
    );
    let id = added["id"].as_str().unwrap();
    run(&[
        "evidence",
        "edit",
        "T-1",
        id,
        "--kind",
        "branch",
        "--name",
        "Branch",
        "--value",
        "feature/full",
    ]);
    assert_eq!(
        run(&["evidence", "list", "T-1"])[0]["value"],
        "feature/full"
    );
    run(&["evidence", "delete", "T-1", id]);
    assert_eq!(
        run(&["evidence", "list", "T-1"]).as_array().unwrap().len(),
        0
    );
}

#[test]
fn backlinks_command_returns_source_and_passage() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let result = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()
    };
    run(&["create", "Target"]);
    run(&["create", "Source"]);
    run(&["change", "T-2", "--body", "See T-1 for context"]);
    let result = run(&["backlinks", "T-1"]);
    assert_eq!(result[0]["source_reference"], "T-2");
    assert_eq!(result[0]["passage"], "See T-1 for context");
    assert_eq!(result[0]["mention_start"], 4);
    assert_eq!(result[0]["mention_end"], 7);
}

#[test]
fn cli_marks_and_removes_duplicate_designation() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let result = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()
    };
    run(&["create", "Source"]);
    run(&["create", "Canonical"]);
    let marked = run(&["mark-duplicate", "T-1", "T-2"]);
    assert_eq!(marked["status"], "Duplicate");
    assert_eq!(marked["duplicate_of"], "T-2");
    let found = run(&["search", "", "--status", "Duplicate"]);
    assert_eq!(found[0]["reference"], "T-1");
    let removed = run(&["remove-duplicate", "T-1"]);
    assert_eq!(removed["status"], "Todo");
    assert!(removed["duplicate_of"].is_null());
}

#[test]
fn cli_previews_and_applies_reviewed_duplicate_dependencies() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str], input: Option<&str>| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    run(&["create", "Duplicate"], None);
    run(&["create", "Canonical"], None);
    run(&["create", "Dependent"], None);
    run(&["add-dependency", "T-1", "T-3"], None);
    let preview = run(&["preview-duplicate", "T-1", "T-2"], None);
    assert_eq!(preview["edges"][0]["replacement_blocker"], "T-2");
    assert_eq!(preview["source"], "T-1");
    assert_eq!(preview["mode"], "duplicate");
    let separate = run(&["preview-duplicate", "--separate", "T-1", "T-2"], None);
    assert_eq!(separate["mode"], "separate");
    assert_eq!(separate["edges"][0]["mode"], "separate");
    let request = serde_json::json!({ "operation": "mark_duplicate_reviewed", "source": "T-1", "canonical": "T-2", "expected_canonical": preview["canonical"], "decisions": [{"edge": preview["edges"][0], "choice": "replace"}], "agent": null });
    run(
        &["write", "-", "--request-id", "review"],
        Some(&request.to_string()),
    );
    let saved = run(&["show", "T-3"], None);
    assert_eq!(saved["prerequisites"][0]["reference"], "T-2");
}

#[test]
fn cli_schedules_and_dismisses_reminders() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    run(&["create", "Remember"]);
    run(&["reminder", "set", "T-1", "2020-01-01T00:00:00Z"]);
    assert!(run(&["reminder", "show", "T-1"]).contains("2020"));
    let inbox: serde_json::Value = serde_json::from_str(&run(&["inbox"])).unwrap();
    assert_eq!(inbox[0]["kind"], "reminder");
    run(&["reminder", "dismiss", "T-1"]);
    assert!(run(&["reminder", "show", "T-1"]).contains("No reminder"));
}

#[test]
fn cli_context_shows_discovery_direction() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    run(&["create", "Original"]);
    run(&["create", "Discovery"]);
    run(&["add-relationship", "T-1", "T-2", "discovered"]);
    let result = run(&["context", "T-2", "--relationships"]);
    assert_eq!(
        result["relationships"]["discovered_while"]["items"][0]["reference"],
        "T-1"
    );
    run(&["remove-relationship", "T-1", "T-2", "discovered"]);
    let result = run(&["context", "T-2", "--relationships"]);
    assert_eq!(
        result["relationships"]["discovered_while"]["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn cli_batch_organizes_mixed_tickets_without_replacing_tags() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str], input: Option<&str>| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    run(&["create", "First"], None);
    run(&["create", "Second"], None);
    run(
        &["write", "-"],
        Some(
            r#"{"operation":"batch","operations":[{"operation":"change","ticket":"T-1","change":{"add_tags":["keep"]}},{"operation":"change","ticket":"T-2","change":{"add_tags":["remove"]}}]}"#,
        ),
    );
    let result = run(
        &["write", "-", "--request-id", "organize"],
        Some(
            r#"{"operation":"batch","operations":[{"operation":"change","ticket":"T-1","change":{"add_tags":["new"],"remove_tags":["remove"]}},{"operation":"change","ticket":"T-2","change":{"add_tags":["new"],"remove_tags":["remove"]}}]}"#,
        ),
    );
    assert_eq!(
        result["value"][0]["tags"],
        serde_json::json!(["keep", "new"])
    );
    assert_eq!(result["value"][1]["tags"], serde_json::json!(["new"]));
}

#[test]
fn cli_test_storage_isolated_from_platform_workspace_and_other_tests() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("private.sqlite3");
    let invoke = |path: &std::path::Path, args: &[&str]| {
        let result = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("TICKETD_TEST_WORKSPACE", path)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()
    };
    invoke(&workspace, &["create", "Private test ticket"]);
    assert_eq!(
        invoke(&workspace, &["list"])[0]["title"],
        "Private test ticket"
    );
    assert!(
        invoke(&dir.path().join("other.sqlite3"), &["list"])
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn isolated_restore_replaces_only_the_test_workspace() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let run = |args: &[&str]| {
        let result = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap()
    };
    run(&["create", "Before backup"]);
    run(&["backup", backup.to_str().unwrap()]);
    run(&["create", "After backup"]);
    let result = run(&["restore-workspace", backup.to_str().unwrap()]);
    let safety = result
        .trim()
        .strip_prefix("Restored workspace. Safety backup: ")
        .unwrap();
    assert!(std::path::Path::new(safety).starts_with(dir.path()));
    let restored: serde_json::Value = serde_json::from_str(&run(&["list"])).unwrap();
    assert_eq!(restored.as_array().unwrap().len(), 1);
    assert_eq!(restored[0]["title"], "Before backup");
}

#[test]
fn cli_requires_a_canonical_ticket_to_choose_duplicate() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap()
    };
    assert!(run(&["create", "Lonely"]).status.success());
    let rejected = run(&["change", "T-1", "--status", "Duplicate"]);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("canonical ticket"));
    let shown = run(&["show", "T-1"]);
    let ticket: serde_json::Value = serde_json::from_slice(&shown.stdout).unwrap();
    assert_eq!(ticket["status"], "Todo");
}

#[test]
fn cli_creates_ticket_in_plan_and_edits_purpose() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let invoke = |args: &[&str]| {
        let result = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()
    };
    let plan = invoke(&["plan", "create", "Launch"]);
    let id = plan["id"].as_str().unwrap();
    invoke(&["plan", "purpose", id, "Ship safely"]);
    let ticket = invoke(&["create", "Work", "--plan", id]);
    assert_eq!(ticket["plan_id"], id);
    let view = invoke(&["plan", "show", id]);
    assert_eq!(view["plan"]["purpose"], "Ship safely");
    assert_eq!(view["counts"]["todo"], 1);
}

#[test]
fn graph_cli_reports_relationships_and_limits() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    {
        let mut workspace = ticketd_core::Workspace::open(&path).unwrap();
        let a = workspace.create_ticket("A").unwrap();
        let b = workspace.create_ticket("B").unwrap();
        workspace
            .add_dependency(&a.reference, &b.reference, None)
            .unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(["graph", "T-1"])
        .env("TICKETD_TEST_WORKSPACE", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let graph: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(graph["edges"][0]["blocker"], "T-1");
    assert_eq!(graph["edges"][0]["dependent"], "T-2");
    assert_eq!(graph["omitted_neighbors"], false);
    assert_eq!(graph["omitted_edges"], false);
    assert_eq!(graph["max_edges"], 300);
}

#[test]
fn activity_cli_posts_stdin_and_reads_a_bounded_feed_and_exact_update() {
    use std::{io::Write, process::{Command, Stdio}};
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str], input: Option<&str>| -> serde_json::Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args).env("TICKETD_TEST_WORKSPACE", dir.path().join("workspace.sqlite3"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        if let Some(input) = input { child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap(); }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    };
    run(&["create", "Outcome"], None);
    run(&["change", "T-1", "--status", "In progress"], None);
    let posted = run(&["activity", "add", "T-1", "--file", "-", "--agent", "runner"], Some("A **brief**"));
    assert_eq!(posted["brief"], "A **brief**");
    let id = posted["id"].as_str().unwrap();
    assert_eq!(run(&["activity", "show", "T-1", id], None), posted);
    let feed = run(&["activity", "list", "T-1", "--limit", "1"], None);
    assert_eq!(feed.as_array().unwrap().len(), 1);
    assert_eq!(feed[0]["activity"]["id"], id);
}
