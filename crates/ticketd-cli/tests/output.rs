#[test]
fn cli_restores_to_an_explicit_recovery_target_without_replacing_the_current_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("current.sqlite3");
    let source = dir.path().join("source.sqlite3");
    let target = dir.path().join("recovered.sqlite3");
    let backup = dir.path().join("complete.sqlite3");
    ticketd_core::Workspace::open(&current)
        .unwrap()
        .create_ticket("Keep original")
        .unwrap();
    let mut source_workspace = ticketd_core::Workspace::open(&source).unwrap();
    source_workspace
        .create_ticket("Recover separately")
        .unwrap();
    source_workspace.backup(&backup).unwrap();
    drop(source_workspace);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args([
            "restore-workspace",
            backup.to_str().unwrap(),
            "--target",
            target.to_str().unwrap(),
        ])
        .env("TICKETD_TEST_WORKSPACE", &current)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(printed["safety_backup"].is_string(), "{printed}");
    assert!(
        printed["restored"]
            .as_str()
            .unwrap()
            .ends_with("recovered.sqlite3")
    );
    assert_eq!(
        ticketd_core::Workspace::open(current)
            .unwrap()
            .show_ticket("T-KQ1")
            .unwrap()
            .title,
        "Keep original"
    );
    assert_eq!(
        ticketd_core::Workspace::open(target)
            .unwrap()
            .show_ticket("T-KQ1")
            .unwrap()
            .title,
        "Recover separately"
    );
}

#[test]
fn cli_inspects_attachment_completeness_before_restore() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("fixture.txt");
    std::fs::write(&source, b"retained").unwrap();
    let run = |args: &[&str]| {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("GITHUB_TOKEN", "ticketd-backup-credential-canary")
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let file: serde_json::Value = serde_json::from_str(&run(&[
        "attachment",
        "add",
        source.to_str().unwrap(),
        "--request-id",
        "backup",
    ]))
    .unwrap();
    let backup = dir.path().join("complete.sqlite3");
    let saved: serde_json::Value =
        serde_json::from_str(&run(&["backup", backup.to_str().unwrap()])).unwrap();
    assert_eq!(saved["path"], backup.to_str().unwrap());
    assert!(
        !std::fs::read(&backup)
            .unwrap()
            .windows(b"ticketd-backup-credential-canary".len())
            .any(|bytes| bytes == b"ticketd-backup-credential-canary")
    );
    let review: serde_json::Value =
        serde_json::from_str(&run(&["inspect-backup", backup.to_str().unwrap()])).unwrap();
    assert_eq!(review["check"]["status"], "valid");
    assert_eq!(review["attachment_content"]["local_snapshots"], 1);
    assert_eq!(review["attachment_content"]["retained_bytes"], 8);
    assert_eq!(review["attachment_content"]["remote_references"], 0);
    run(&["restore-workspace", backup.to_str().unwrap()]);
    let exported = dir.path().join("restored.txt");
    run(&[
        "attachment",
        "export",
        file["id"].as_str().unwrap(),
        exported.to_str().unwrap(),
    ]);
    assert_eq!(std::fs::read(exported).unwrap(), b"retained");
}

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
        Some(r#"{"operation":"set_following","reference":"T-KQ1","following":true}"#),
    );
    run(&["change", "T-KQ1", "--status", "Done"], None);
    let inbox: serde_json::Value = serde_json::from_str(&run(&["inbox"], None)).unwrap();
    assert_eq!(inbox[0]["reference"], "T-KQ1");
    assert_eq!(inbox[0]["to_value"], "Done");
    assert_eq!(inbox[0]["read"], false);
    run(
        &["write", "-", "--request-id", "note"],
        Some(
            r#"{"operation":"add_activity","reference":"T-KQ1","brief":"CLI finding","agent":"runner"}"#,
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
        "T-KQ1",
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
        run(&["context", "T-KQ1", "--evidence"])["evidence"]["items"][0]["value"]["text"],
        "Unit tests passed"
    );
    let id = added["id"].as_str().unwrap();
    run(&[
        "evidence",
        "edit",
        "T-KQ1",
        id,
        "--kind",
        "branch",
        "--name",
        "Branch",
        "--value",
        "feature/full",
    ]);
    assert_eq!(
        run(&["evidence", "list", "T-KQ1"])[0]["value"],
        "feature/full"
    );
    run(&["evidence", "delete", "T-KQ1", id]);
    assert_eq!(
        run(&["evidence", "list", "T-KQ1"])
            .as_array()
            .unwrap()
            .len(),
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
    run(&["change", "T-KQ2", "--body", "See T-KQ1 for context"]);
    let result = run(&["backlinks", "T-KQ1"]);
    assert_eq!(result[0]["source_reference"], "T-KQ2");
    assert_eq!(result[0]["passage"], "See T-KQ1 for context");
    assert_eq!(result[0]["mention_start"], 4);
    assert_eq!(result[0]["mention_end"], 9);
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
    let marked = run(&["mark-duplicate", "T-KQ1", "T-KQ2"]);
    assert_eq!(marked["status"], "Duplicate");
    assert_eq!(marked["duplicate_of"], "T-KQ2");
    let found = run(&["search", "", "--status", "Duplicate"]);
    assert_eq!(found[0]["reference"], "T-KQ1");
    let removed = run(&["remove-duplicate", "T-KQ1"]);
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
    run(&["add-dependency", "T-KQ1", "T-KQ3"], None);
    let preview = run(&["preview-duplicate", "T-KQ1", "T-KQ2"], None);
    assert_eq!(preview["edges"][0]["replacement_blocker"], "T-KQ2");
    assert_eq!(preview["source"], "T-KQ1");
    assert_eq!(preview["mode"], "duplicate");
    let separate = run(&["preview-duplicate", "--separate", "T-KQ1", "T-KQ2"], None);
    assert_eq!(separate["mode"], "separate");
    assert_eq!(separate["edges"][0]["mode"], "separate");
    let request = serde_json::json!({ "operation": "mark_duplicate_reviewed", "source": "T-KQ1", "canonical": "T-KQ2", "expected_canonical": preview["canonical"], "decisions": [{"edge": preview["edges"][0], "choice": "replace"}], "agent": null });
    run(
        &["write", "-", "--request-id", "review"],
        Some(&request.to_string()),
    );
    let saved = run(&["show", "T-KQ3"], None);
    assert_eq!(saved["prerequisites"][0]["reference"], "T-KQ2");
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
    let json = |args: &[&str]| serde_json::from_str::<serde_json::Value>(&run(args)).unwrap();
    let set = json(&["reminder", "set", "T-KQ1", "2020-01-01T00:00:00Z"]);
    assert_eq!(set["reference"], "T-KQ1");
    assert!(set["due_at"].as_str().unwrap().contains("2020"));
    assert_eq!(json(&["reminder", "show", "T-KQ1"]), set);
    let snoozed = json(&["reminder", "snooze", "T-KQ1", "2021-01-01T00:00:00Z"]);
    assert!(snoozed["due_at"].as_str().unwrap().contains("2021"));
    let inbox = json(&["inbox"]);
    assert_eq!(inbox[0]["kind"], "reminder");
    assert_eq!(
        run(&["reminder", "dismiss", "T-KQ1"]).trim(),
        r#"{"dismissed":true}"#
    );
    assert_eq!(
        run(&["reminder", "dismiss", "T-KQ1"]).trim(),
        r#"{"dismissed":false}"#
    );
    assert_eq!(
        run(&["reminder", "show", "T-KQ1"]).trim(),
        r#"{"reference":"T-KQ1","due_at":null}"#
    );
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
    run(&["add-relationship", "T-KQ1", "T-KQ2", "discovered"]);
    let result = run(&["context", "T-KQ2", "--relationships"]);
    assert_eq!(
        result["relationships"]["discovered_while"]["items"][0]["reference"],
        "T-KQ1"
    );
    run(&["remove-relationship", "T-KQ1", "T-KQ2", "discovered"]);
    let result = run(&["context", "T-KQ2", "--relationships"]);
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
            r#"{"operation":"batch","operations":[{"operation":"change","ticket":"T-KQ1","change":{"add_tags":["keep"]}},{"operation":"change","ticket":"T-KQ2","change":{"add_tags":["remove"]}}]}"#,
        ),
    );
    let result = run(
        &["write", "-", "--request-id", "organize"],
        Some(
            r#"{"operation":"batch","operations":[{"operation":"change","ticket":"T-KQ1","change":{"add_tags":["new"],"remove_tags":["remove"]}},{"operation":"change","ticket":"T-KQ2","change":{"add_tags":["new"],"remove_tags":["remove"]}}]}"#,
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
    let result: serde_json::Value = serde_json::from_str(&result).unwrap();
    let safety = result["safety_backup"].as_str().unwrap();
    assert!(std::path::Path::new(safety).starts_with(dir.path()));
    assert!(
        result["restored"]
            .as_str()
            .unwrap()
            .ends_with("workspace.sqlite3")
    );
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
    let rejected = run(&["change", "T-KQ1", "--status", "Duplicate"]);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("canonical ticket"));
    let shown = run(&["show", "T-KQ1"]);
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
fn plan_graph_cli_displays_boundary_blockers() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let plan_id;
    {
        let mut workspace = ticketd_core::Workspace::open(&path).unwrap();
        plan_id = workspace.create_plan("Launch").unwrap().id;
        let blocker = workspace.create_ticket("Outside").unwrap();
        let member = workspace.create_ticket("Member").unwrap();
        workspace
            .set_plan(&member.reference, Some(&plan_id), None)
            .unwrap();
        workspace
            .add_dependency(&blocker.reference, &member.reference, None)
            .unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(["graph", "--plan", &plan_id])
        .env("TICKETD_TEST_WORKSPACE", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let graph: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(graph["nodes"][0]["reference"], "T-KQ2");
    assert_eq!(graph["nodes"][1]["boundary"], true);
    assert_eq!(graph["edges"][0]["blocker"], "T-KQ1");
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
        .args(["graph", "T-KQ1"])
        .env("TICKETD_TEST_WORKSPACE", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let graph: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(graph["edges"][0]["blocker"], "T-KQ1");
    assert_eq!(graph["edges"][0]["dependent"], "T-KQ2");
    assert_eq!(graph["omitted_neighbors"], false);
    assert_eq!(graph["omitted_edges"], false);
    assert_eq!(graph["max_edges"], 300);
}

#[test]
fn activity_cli_posts_stdin_and_reads_a_bounded_feed_and_exact_update() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str], input: Option<&str>| -> serde_json::Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
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
        serde_json::from_slice(&output.stdout).unwrap()
    };
    run(&["create", "Outcome"], None);
    assert!(run(&["context", "T-KQ1", "--latest-update"], None)["latest_update"].is_null());
    run(&["change", "T-KQ1", "--status", "In progress"], None);
    let posted = run(
        &[
            "activity", "add", "T-KQ1", "--file", "-", "--agent", "runner",
        ],
        Some("A **brief**"),
    );
    assert_eq!(posted["brief"], "A **brief**");
    let request = r#"{"operation":"ticket_change","reference":"T-KQ1","change":{"status":"In review","activities":["Ready for review"],"editing_agent":"runner"}}"#;
    let first = run(&["write", "-", "--request-id", "progress-1"], Some(request));
    assert_eq!(
        run(&["write", "-", "--request-id", "progress-1"], Some(request)),
        first
    );
    let latest = run(&["context", "T-KQ1", "--latest-update"], None);
    assert_eq!(latest["latest_update"]["brief"]["text"], "Ready for review");
    let feed = run(&["activity", "list", "T-KQ1"], None);
    assert_eq!(
        feed.as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["activity"]["brief"] == "Ready for review")
            .count(),
        1
    );
    let id = posted["id"].as_str().unwrap();
    let omitted = run(&["context", "T-KQ1"], None);
    assert!(omitted.get("latest_update").is_none());
    let context = run(&["context", "T-KQ1", "--latest-update"], None);
    assert_eq!(
        context["latest_update"]["brief"]["text"],
        "Ready for review"
    );
    let list = run(&["list", "--latest-update"], None);
    assert_eq!(
        list[0]["latest_update"]["brief"]["text"],
        "Ready for review"
    );
    assert_eq!(run(&["activity", "show", "T-KQ1", id], None), posted);
    let feed = run(&["activity", "list", "T-KQ1", "--limit", "1"], None);
    assert_eq!(feed.as_array().unwrap().len(), 1);
    assert_eq!(feed[0]["activity"]["brief"], "Ready for review");
}

#[test]
fn cli_plan_context_shows_associated_document_and_opt_in_body() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
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
    let plan = run(&["plan", "create", "Release"]);
    let document = run(&[
        "document",
        "create",
        "--title",
        "Spec",
        "--body",
        "# Details",
    ]);
    let plan_id = plan["id"].as_str().unwrap();
    let doc_id = document["id"].as_str().unwrap();
    run(&["plan", "document", plan_id, doc_id]);
    run(&["plan", "spec", plan_id, doc_id]);
    let context = run(&["plan", "context", plan_id]);
    assert_eq!(context["plan"]["spec_document_id"], doc_id);
    assert!(context["documents"][0]["body"].is_null());
    let with_bodies = run(&["plan", "context", plan_id, "--bodies"]);
    assert_eq!(with_bodies["documents"][0]["body"], "# Details");
}

#[test]
fn context_graph_cli_reads_new_connections() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
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
    run(&["create", "First"]);
    run(&["create", "Second"]);
    run(&["create", "Third"]);
    run(&["change", "T-KQ2", "--body", "See T-KQ3"]);
    run(&["change", "T-KQ1", "--body", "See T-KQ2"]);
    let graph = run(&["graph", "T-KQ2", "--context"]);
    assert!(
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["label"].as_str().unwrap().contains("First"))
    );
    assert!(
        graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "mention")
    );
    let center = run(&["graph", "T-KQ1", "--context"]);
    let second = center["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["label"].as_str().unwrap().contains("Second"))
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let expanded = run(&["graph", "T-KQ1", "--context", "--expand", second]);
    assert!(
        expanded["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["label"].as_str().unwrap().contains("Third"))
    );
}

#[test]
fn workspace_context_graph_cli_filters_indexed_search() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
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
    run(&["create", "Unique search word"]);
    run(&["create", "Another ticket"]);
    let graph = run(&["graph", "--context", "--workspace", "--search", "Unique"]);
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 1);
}

#[test]
fn activity_and_document_commands_replay_by_request_id() {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| -> serde_json::Value {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
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
        serde_json::from_slice(&output.stdout).unwrap()
    };
    run(&["create", "Outcome"]);
    let add = [
        "activity",
        "add",
        "T-KQ1",
        "--brief",
        "Once",
        "--request-id",
        "a-1",
    ];
    let first = run(&add);
    assert_eq!(run(&add), first);
    assert_eq!(first["brief"], "Once");
    let feed = run(&["activity", "list", "T-KQ1"]);
    assert_eq!(
        feed.as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["type"] == "authored")
            .count(),
        1
    );
    let id = first["id"].as_str().unwrap();
    let edit = [
        "activity",
        "edit",
        "T-KQ1",
        id,
        "--brief",
        "Twice",
        "--request-id",
        "e-1",
    ];
    assert_eq!(run(&edit), run(&edit));
    let create = [
        "document",
        "create",
        "--body",
        "Body",
        "--request-id",
        "d-1",
    ];
    let document = run(&create);
    assert_eq!(run(&create), document);
    assert_eq!(document["body"], "Body");
}

#[test]
fn cli_document_keep_trash_restore_print_the_bare_document() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
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
    let document = run(&["document", "create", "--body", "Hello"]);
    let id = document["id"].as_str().unwrap();
    for command in ["keep", "trash", "restore"] {
        let printed = run(&["document", command, id]);
        assert_eq!(printed["id"], id, "{command}");
        assert!(printed.get("value").is_none(), "{command}");
    }
    run(&["create", "Task"]);
    let references = run(&["document", "references", "T-KQ1"]);
    assert!(references.as_array().unwrap().is_empty());
}

#[test]
fn cli_rejects_empty_patches_and_titles_and_takes_back_what_it_printed() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let try_run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap()
    };
    let run = |args: &[&str]| {
        let output = try_run(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let fails_with = |args: &[&str], message: &str| {
        let output = try_run(args);
        assert!(!output.status.success(), "{args:?} succeeded");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(message), "{stderr}");
    };
    run(&["create", "Ticket"]);
    let document = run(&["document", "create", "--body", "x"]);
    let id = document["id"].as_str().unwrap();
    fails_with(&["document", "change", id], "provide --title");
    fails_with(
        &["document", "change", id, "--title", " "],
        "must not be empty",
    );
    let activity = run(&["activity", "add", "T-KQ1", "--brief", "Hi"]);
    let activity_id = activity["id"].as_str().unwrap();
    fails_with(
        &["activity", "edit", "T-KQ1", activity_id],
        "provide --brief or --file",
    );
    let evidence = run(&[
        "evidence",
        "add",
        "T-KQ1",
        "--kind",
        "pull-request",
        "--name",
        "PR",
        "--value",
        "https://example.com/p/1",
    ]);
    assert_eq!(evidence["kind"], "pull_request");
    run(&[
        "evidence",
        "edit",
        "T-KQ1",
        evidence["id"].as_str().unwrap(),
        "--kind",
        "pull_request",
        "--name",
        "PR",
        "--value",
        "https://example.com/p/1",
    ]);
    let plan = run(&["plan", "create", "Hub"]);
    let plan_id = plan["id"].as_str().unwrap();
    for n in 0..55 {
        let reference = run(&["create", &format!("Member {n}")])["reference"]
            .as_str()
            .unwrap()
            .to_owned();
        run(&["plan", "add", plan_id, &reference]);
    }
    let first = run(&["graph", plan_id, "--context"]);
    let continuation = first["continuations"][0].to_string();
    let more = run(&["graph", plan_id, "--context", "--page", &continuation]);
    assert!(more["nodes"].as_array().unwrap().len() > first["nodes"].as_array().unwrap().len());
    fails_with(
        &["graph", "--context", "--workspace", "--kind", "bogus"],
        "unknown kind",
    );
}
