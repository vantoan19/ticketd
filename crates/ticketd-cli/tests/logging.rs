//! The CLI's logging, seen from outside the process: what goes to which stream.

use std::path::Path;
use std::process::{Command, Output};

// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
fn run(dir: &Path, args: &[&str], log: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
    command
        .args(args)
        .env("HOME", dir)
        .env("XDG_DATA_HOME", dir)
        .env("TICKETD_TEST_WORKSPACE", dir.join("workspace.sqlite3"))
        .env_remove("TICKETD_LOG")
        .env_remove("TICKETD_CHAT_ID")
        .env_remove("TICKETD_AUTOMATION_RUN_ID");
    if let Some(log) = log {
        command.env("TICKETD_LOG", log);
    }
    command.output().unwrap()
}

#[test]
fn ticketd_log_adds_detail_on_stderr_and_leaves_stdout_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let created = run(dir.path(), &["create", "First"], None);
    assert!(created.status.success());

    let quiet = run(dir.path(), &["list"], None);
    let verbose = run(dir.path(), &["list"], Some("debug"));

    assert!(quiet.status.success() && verbose.status.success());
    assert_eq!(quiet.stdout, verbose.stdout);
    assert!(!quiet.stdout.is_empty());
    // The default is `warn`: a successful command says nothing on stderr.
    assert_eq!(String::from_utf8_lossy(&quiet.stderr), "");
    let detail = String::from_utf8_lossy(&verbose.stderr);
    assert!(detail.contains("DEBUG"), "{detail}");
}

#[test]
fn a_ticketd_log_that_does_not_parse_is_ignored_with_one_notice_that_does_not_echo_it() {
    let dir = tempfile::tempdir().unwrap();
    assert!(run(dir.path(), &["create", "First"], None).status.success());

    let quiet = run(dir.path(), &["list"], None);
    let ignored = run(dir.path(), &["list"], Some("ticketd=loudly"));

    assert!(ignored.status.success());
    assert_eq!(quiet.stdout, ignored.stdout);
    let stderr = String::from_utf8_lossy(&ignored.stderr);
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
    assert!(stderr.contains("TICKETD_LOG ignored"), "{stderr}");
    assert!(!stderr.contains("loudly"), "{stderr}");
}

#[test]
fn a_failing_command_keeps_its_error_line_and_adds_no_log_line_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let output = run(dir.path(), &["show", "NOPE-1"], None);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.starts_with("error: "), "{stderr}");
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
}

#[allow(clippy::unwrap_used)]
fn run_with_env(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
    command
        .args(args)
        .env("HOME", dir)
        .env("XDG_DATA_HOME", dir)
        .env("TICKETD_TEST_WORKSPACE", dir.join("workspace.sqlite3"))
        .env("TICKETD_LOG", "debug")
        .env_remove("TICKETD_CHAT_ID")
        .env_remove("TICKETD_AUTOMATION_RUN_ID");
    for (name, value) in env {
        command.env(name, value);
    }
    command.output().unwrap()
}

#[test]
fn log_lines_carry_the_chat_and_automation_run_that_started_the_command() {
    let dir = tempfile::tempdir().unwrap();
    let output = run_with_env(
        dir.path(),
        &["list"],
        &[
            ("TICKETD_CHAT_ID", "chat-7"),
            ("TICKETD_AUTOMATION_RUN_ID", "run-9"),
        ],
    );

    assert!(output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("workspace opened"), "{stderr}");
    for line in stderr.lines() {
        assert!(line.contains(r#"chat_id="chat-7""#), "{line}");
        assert!(line.contains(r#"automation_run_id="run-9""#), "{line}");
    }
}

#[test]
fn blank_correlation_variables_are_not_attached() {
    let dir = tempfile::tempdir().unwrap();
    let output = run_with_env(
        dir.path(),
        &["list"],
        &[("TICKETD_CHAT_ID", "  "), ("TICKETD_AUTOMATION_RUN_ID", "")],
    );

    assert!(output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("workspace opened"), "{stderr}");
    assert!(!stderr.contains("chat_id"), "{stderr}");
    assert!(!stderr.contains("automation_run_id"), "{stderr}");
}
