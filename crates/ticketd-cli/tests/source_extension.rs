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

#[test]
fn an_extension_credential_is_resolved_for_each_cli_invocation() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let example =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/ticket-source-example-ts");
    let run = |args: &[&str], credentials: &[(&str, &str)]| {
        Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .env_remove("TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY")
            .env_remove("TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY_COMMAND")
            .envs(credentials.iter().copied())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(
        run(
            &["source", "extension", "link", example.to_str().unwrap()],
            &[]
        )
        .status
        .success()
    );
    let synthetic = "qz85-not-a-live-api-key";
    let from_env = [("TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY", synthetic)];
    let added = run(
        &["source", "add", "example-tracker", "--set", "board=Sign-in"],
        &from_env,
    );
    assert!(added.status.success(), "{:?}", added.stderr);
    assert!(!String::from_utf8_lossy(&added.stdout).contains(synthetic));
    let refresh = ["source", "example-tracker", "refresh"];
    let missing = run(&refresh, &[]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stdout).contains("unauthenticated"));
    let command =
        serde_json::to_string(&["node", "-e", &format!("console.log('{synthetic}')")]).unwrap();
    let from_command = [(
        "TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY_COMMAND",
        command.as_str(),
    )];
    let refreshed = run(&refresh, &from_command);
    assert!(refreshed.status.success(), "{:?}", refreshed.stderr);
    assert!(!String::from_utf8_lossy(&refreshed.stdout).contains(synthetic));
    assert!(!String::from_utf8_lossy(&std::fs::read(&workspace).unwrap()).contains(synthetic));
    let backup = directory.path().join("backup.sqlite3");
    assert!(
        run(&["backup", backup.to_str().unwrap()], &[])
            .status
            .success()
    );
    assert!(!String::from_utf8_lossy(&std::fs::read(&backup).unwrap()).contains(synthetic));
    let export = run(&["export"], &[]);
    assert!(export.status.success());
    assert!(!String::from_utf8_lossy(&export.stdout).contains(synthetic));
}

#[test]
fn known_credentials_are_redacted_in_diagnostics_and_rejected_in_results() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let extension = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ticketd-core/tests/fixtures/source-extension");
    let secret = "private-qz85/to%ken";
    let command = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .env("TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY", secret)
            // The direct override takes precedence over a failed password command.
            .env(
                "TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY_COMMAND",
                "[\"invalid-executable\"]",
            )
            .args(args)
            .output()
            .unwrap()
    };
    let linked = command(&["source", "extension", "link", extension.to_str().unwrap()]);
    assert!(linked.status.success(), "{:?}", linked.stderr);
    for (mode, expected) in [
        ("secret_stdout", "unexpected stdout line"),
        ("secret_error", "tracker refused [redacted]"),
        (
            "secret_result",
            "source extension returned a credential in its result",
        ),
    ] {
        let result = command(&[
            "source",
            "add",
            "scripted",
            "--set",
            &format!("mode={mode}"),
        ]);
        assert!(!result.status.success(), "{mode}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains(expected), "{mode}: {stderr}");
        assert!(!stderr.contains(secret));
        assert!(!stderr.contains("private-qz85%2Fto%25ken"));
    }
    let logs = registry.join("logs").join("sources");
    let captured = std::fs::read_dir(&logs)
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(captured.contains("fragment [redacted]"), "{captured}");
    assert!(captured.contains("encoded [redacted]"), "{captured}");
    assert!(!captured.contains(secret));
    assert!(!captured.contains("cHJpdmF0ZS1xejg1L3RvJWtlbg=="));
}
