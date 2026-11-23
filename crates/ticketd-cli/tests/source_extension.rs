use std::{path::Path, process::Command};

use serde_json::Value;

#[test]
fn links_and_syncs_the_typescript_tracker() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let example =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/ticket-source-example-ts");
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };

    let link = run(&["source", "extension", "link", example.to_str().unwrap()]);
    assert_eq!(link["development"], true);
    assert!(!workspace.exists());
    let report = run(&[
        "source",
        "conformance",
        "example-tracker",
        "--set",
        "board=Demo",
        "--strict",
    ]);
    assert_eq!(report["passed"], true);

    let added = run(&["source", "add", "example-tracker", "--set", "board=Demo"]);
    assert_eq!(added["preview"]["matched"], 2);
    let report = run(&["source", "example-tracker", "refresh"]);
    assert_eq!(report["failures"], serde_json::json!([]));
    let tickets = run(&["list", "--source", "example-tracker"]);
    assert_eq!(tickets.as_array().unwrap().len(), 2);
    assert_eq!(tickets[0]["source"]["provider_name"], "Example Tracker");
    assert!(
        tickets[0]["source"]["provider_icon_svg"]
            .as_str()
            .unwrap()
            .starts_with("<svg")
    );
}
