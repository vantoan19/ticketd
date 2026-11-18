// Test helpers spawn the real executable; a failure to spawn should fail the test loudly.
#![allow(clippy::unwrap_used)]

use std::io::Write;
use std::process::{Command, Output, Stdio};

fn run(workspace: &std::path::Path, args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(args)
        .env("TICKETD_TEST_WORKSPACE", workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn limit_outside_one_to_one_hundred_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    for limit in ["0", "101"] {
        let output = run(&workspace, &["search", "", "--limit", limit], "");
        assert!(!output.status.success());
        assert!(stderr(&output).contains("1..=100"), "{}", stderr(&output));
    }
    assert!(
        run(&workspace, &["list", "--limit", "100"], "")
            .status
            .success()
    );
}

#[test]
fn invalid_status_lists_the_valid_ones_and_accepts_lowercase_and_hyphens() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    assert!(run(&workspace, &["create", "Task"], "").status.success());
    let output = run(&workspace, &["change", "T-KQ1", "--status", "nope"], "");
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("Todo, In progress, In review, Done, Canceled, Duplicate"),
        "{}",
        stderr(&output)
    );
    let output = run(
        &workspace,
        &["change", "T-KQ1", "--status", "in-progress"],
        "",
    );
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(String::from_utf8_lossy(&output.stdout).contains("In progress"));
}

#[test]
fn batch_shape_errors_name_the_operation_index() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    let plan =
        r#"[{"operation":"create","name":"a","title":"A"},{"operation":"create","title":"B"}]"#;
    let output = run(&workspace, &["batch", "-"], plan);
    assert!(!output.status.success());
    let message = stderr(&output);
    assert!(message.contains("batch operation 1:"), "{message}");
    assert!(message.contains("`name`"), "{message}");
}

#[test]
fn file_read_errors_name_the_path() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    let missing = dir.path().join("missing.json");
    let missing = missing.to_str().unwrap();
    for args in [vec!["batch", missing], vec!["write", missing]] {
        let output = run(&workspace, &args, "");
        assert!(stderr(&output).contains(missing), "{}", stderr(&output));
    }
}

#[test]
fn activity_brief_from_a_file_has_no_trailing_newline() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    assert!(run(&workspace, &["create", "Task"], "").status.success());
    let output = run(
        &workspace,
        &["activity", "add", "T-KQ1", "--file", "-"],
        "Started the work\n",
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let activity: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(activity["brief"], "Started the work");
}

#[test]
fn unknown_reference_explains_the_format() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    let output = run(&workspace, &["show", "42"], "");
    assert!(stderr(&output).contains("T-KQ12"), "{}", stderr(&output));
    let output = run(&workspace, &["show", "t-kq1"], "");
    assert!(
        stderr(&output).contains("did you mean 'T-KQ1'"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn ambiguous_checkout_names_the_matching_projects() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    let repo_arg = repo.to_str().unwrap();
    let src_arg = repo.join("src");
    for (name, path) in [("Alpha", repo_arg), ("Dup", src_arg.to_str().unwrap())] {
        let output = run(&workspace, &["project", "create", name, path], "");
        assert!(output.status.success(), "{}", stderr(&output));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(["create", "x"])
        .current_dir(repo.join("src"))
        .env("TICKETD_TEST_WORKSPACE", &workspace)
        .output()
        .unwrap();
    let message = stderr(&output);
    assert!(
        message.contains("Alpha") && message.contains("Dup"),
        "{message}"
    );
}

#[test]
fn markdown_list_bodies_starting_with_a_hyphen_are_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w.sqlite3");
    assert!(run(&workspace, &["create", "Task"], "").status.success());
    let output = run(
        &workspace,
        &["change", "T-KQ1", "--body", "- [ ] first"],
        "",
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let output = run(
        &workspace,
        &["document", "create", "--body", "- one\n- two"],
        "",
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let ticket: serde_json::Value =
        serde_json::from_slice(&run(&workspace, &["show", "T-KQ1"], "").stdout).unwrap();
    assert_eq!(ticket["body"], "- [ ] first");
}
