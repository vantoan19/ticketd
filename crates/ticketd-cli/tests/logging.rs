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
        .env_remove("TICKETD_LOG");
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
fn a_failing_command_keeps_its_error_line_and_adds_no_log_line_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let output = run(dir.path(), &["show", "NOPE-1"], None);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.starts_with("error: "), "{stderr}");
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
}
