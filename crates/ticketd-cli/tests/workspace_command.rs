use std::path::Path;
use std::process::Command;
use ticketd_core::FORMAT_VERSION;

// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
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
fn workspace_prints_its_path_and_both_format_versions_as_json() {
    let dir = tempfile::tempdir().unwrap();
    // Create the workspace at the CLI's own format, the way any other command would.
    run(dir.path(), &["create", "First"]);
    let printed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["workspace"])).unwrap();
    assert_eq!(
        printed["path"],
        // SQLite reports the resolved path (/private/var on macOS).
        std::fs::canonicalize(dir.path().join("workspace.sqlite3"))
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(printed["format_version"], FORMAT_VERSION);
    assert_eq!(printed["supported_format_version"], FORMAT_VERSION);
    assert_eq!(printed.as_object().unwrap().len(), 3);
}

#[test]
fn workspace_does_not_create_a_missing_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let printed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["workspace"])).unwrap();
    assert_eq!(printed["format_version"], serde_json::Value::Null);
    assert_eq!(printed["supported_format_version"], FORMAT_VERSION);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn workspace_does_not_migrate_an_older_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("workspace.sqlite3");
    run(dir.path(), &["create", "First"]);
    // Rewrite the "user version" field of the SQLite header (bytes 60..64) to 19.
    let mut bytes = std::fs::read(&file).unwrap();
    bytes[60..64].copy_from_slice(&19_u32.to_be_bytes());
    std::fs::write(&file, &bytes).unwrap();
    let printed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["workspace"])).unwrap();
    assert_eq!(printed["format_version"], 19);
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    // No pre-migration copy was made either.
    let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
    assert!(files.iter().all(|entry| {
        !entry
            .as_ref()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("pre-migration")
    }));
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
        &[
            "context",
            "T-1",
            "--relationships",
            "--activities",
            "--evidence",
        ],
    );
    run(
        dir.path(),
        &[
            "activity",
            "add",
            "T-1",
            "--file",
            note.to_str().unwrap(),
            "--agent",
            "codex",
        ],
    );
}

#[test]
fn documents_can_be_created_edited_and_reopened_via_cli() {
    let dir = tempfile::tempdir().unwrap();
    let created: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "create", "--body", "First thought"],
    ))
    .unwrap();
    let id = created["id"].as_str().unwrap();
    run(
        dir.path(),
        &["document", "change", id, "--title", "A title"],
    );
    let opened: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "open", id])).unwrap();
    assert_eq!(opened["title"], "A title");
    assert_eq!(opened["body"], "First thought");
    let recent: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "recent"])).unwrap();
    assert_eq!(recent[0]["id"], id);
}
