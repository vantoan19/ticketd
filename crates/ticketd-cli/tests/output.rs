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
            r#"{"operation":"add_note","reference":"T-1","content":"CLI finding","agent":"runner"}"#,
        ),
    );
    let inbox: serde_json::Value = serde_json::from_str(&run(&["inbox"], None)).unwrap();
    assert_eq!(inbox[0]["kind"], "note");
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
    assert_eq!(marked["status"], "Canceled");
    assert_eq!(marked["duplicate_of"], "T-2");
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
    let request = serde_json::json!({ "operation": "mark_duplicate_reviewed", "source": "T-1", "canonical": "T-2", "expected_canonical": preview["canonical"], "decisions": [{"edge": preview["edges"][0], "choice": "replace"}], "agent": null });
    run(
        &["write", "-", "--request-id", "review"],
        Some(&request.to_string()),
    );
    let saved = run(&["show", "T-3"], None);
    assert_eq!(saved["prerequisites"][0]["reference"], "T-2");
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
