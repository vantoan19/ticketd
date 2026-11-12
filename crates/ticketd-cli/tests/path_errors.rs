use std::process::Command;

#[test]
#[allow(clippy::unwrap_used)]
fn missing_source_files_and_destination_folders_are_named_in_errors() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace.sqlite3");
    let command = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .current_dir(dir.path())
            .args(args)
            .output()
            .unwrap()
    };
    let fail = |args: &[&str]| -> String {
        let output = command(args);
        assert!(!output.status.success());
        String::from_utf8(output.stderr).unwrap()
    };
    std::fs::write(dir.path().join("note.txt"), "hello").unwrap();
    let added = command(&["attachment", "add", "note.txt"]);
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    let added: serde_json::Value = serde_json::from_slice(&added.stdout).unwrap();
    let id = added["id"].as_str().unwrap().to_owned();

    let error = fail(&["attachment", "add", "missing.txt"]);
    assert!(error.contains("file not found: missing.txt"), "{error}");
    let error = fail(&["attachment", "export", &id, "nodir/out.txt"]);
    assert!(
        error.contains("destination folder not found: nodir"),
        "{error}"
    );
    let error = fail(&["export", "--file", "nodir/e.json"]);
    assert!(
        error.contains("destination folder not found: nodir"),
        "{error}"
    );
    let error = fail(&["backup", "nodir/b.sqlite3"]);
    assert!(
        error.contains("destination folder not found: nodir"),
        "{error}"
    );
    let error = fail(&[
        "export-markdown",
        "--markdown-file",
        "gone.md",
        "--output",
        ".",
    ]);
    assert!(error.contains("file not found: gone.md"), "{error}");
}
