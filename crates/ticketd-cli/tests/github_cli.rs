use std::process::Command;

use serde_json::Value;

#[test]
fn github_preview_and_backfill_use_the_project_without_choosing_a_connection() {
    let directory = tempfile::tempdir().unwrap();
    let cli = |arguments: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env(
                "TICKETD_TEST_WORKSPACE",
                directory.path().join("workspace.sqlite3"),
            )
            .env(
                "TICKETD_SOURCE_EXTENSIONS_DIR",
                directory.path().join("extensions"),
            )
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let project = cli(&[
        "project",
        "create",
        "Repository",
        directory.path().to_str().unwrap(),
        "--remote",
        "github.com/example/project",
    ]);
    let project_id = project["id"].as_str().unwrap();
    let backfill = cli(&["project", "connect-source", project_id, "--preview"]);
    assert_eq!(backfill["provider"], "github");
    assert_eq!(backfill["connection_id"], Value::Null);
    assert_eq!(backfill["source"], "add_repository");

    let ticket = cli(&["create", "Publish this", "--project", project_id]);
    let preview = cli(&[
        "source",
        "publish",
        ticket["reference"].as_str().unwrap(),
        "--preview",
    ]);
    assert_eq!(preview["provider"], "github");
    assert_eq!(preview["destination"], "github.com/example/project");
    assert_eq!(preview["eligibility"]["kind"], "eligible");

    let status = cli(&["source", "github", "status"]);
    assert_eq!(status["id"], "github");
    assert_eq!(status["repositories"], serde_json::json!([]));
}
