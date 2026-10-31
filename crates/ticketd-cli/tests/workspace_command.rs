use std::path::Path;
use std::process::Command;

fn run(dir: &Path, args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(args)
        .env("HOME", dir)
        .env("XDG_DATA_HOME", dir)
        .env("TICKETD_TEST_WORKSPACE", dir.join("workspace.sqlite3"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn workspace_prints_its_path_and_format_version_as_json() {
    let dir = tempfile::tempdir().unwrap();
    let printed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["workspace"])).unwrap();
    assert_eq!(
        printed["path"],
        dir.path().join("workspace.sqlite3").to_str().unwrap()
    );
    assert!(printed["format_version"].as_i64().unwrap() >= 19);
    assert_eq!(printed.as_object().unwrap().len(), 2);
}

/// The Settings quick reference shows these forms with placeholders filled in.
#[test]
fn settings_quick_reference_commands_run() {
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().join("checkout");
    std::fs::create_dir(&checkout).unwrap();
    let project: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["project", "create", "Reference", checkout.to_str().unwrap()],
    ))
    .unwrap();
    let project = project["id"].as_str().unwrap();
    run(
        dir.path(),
        &["create", "Quick reference", "--project", project],
    );
    let note = dir.path().join("note.md");
    std::fs::write(&note, "Finding").unwrap();

    run(
        dir.path(),
        &["list", "--project", project, "--availability", "ready"],
    );
    run(
        dir.path(),
        &["context", "T-1", "--relationships", "--notes", "--evidence"],
    );
    run(
        dir.path(),
        &[
            "note",
            "add",
            "T-1",
            "--file",
            note.to_str().unwrap(),
            "--agent",
            "codex",
        ],
    );
}
