use std::{path::Path, process::Command};

use serde_json::Value;

#[test]
fn links_and_syncs_the_typescript_tracker() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let sample =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/ticket-source-example-ts");
    let example = directory.path().join("example");
    std::fs::create_dir(&example).unwrap();
    for name in ["ticketd-source.json", "tracker.ts"] {
        std::fs::copy(sample.join(name), example.join(name)).unwrap();
    }
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
    let linked_list = run(&["source", "extension", "list"]);
    assert_eq!(linked_list, serde_json::json!([link]));
    std::fs::write(
        example.join("changed-after-link"),
        "still a development folder",
    )
    .unwrap();
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
fn installs_only_after_consent_and_refuses_a_changed_install() {
    use std::{
        fs,
        io::{Read, Write},
        process::Stdio,
    };

    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let package = directory.path().join("package");
    fs::create_dir(&package).unwrap();
    let example =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/ticket-source-example-ts");
    let tracker = fs::read_to_string(example.join("tracker.ts")).unwrap();
    fs::write(
        package.join("tracker.ts"),
        format!(
            "if (!process.env.PATH || !(process.env.HOME || process.env.USERPROFILE) ||
                process.env.EXTRA_TRACKER_SETTING !== 'declared' ||
                process.env.UNRELATED_TRACKER_SETTING ||
                process.env.TICKETD_EXTENSION_TEST) {{
                throw new Error('unexpected environment');
            }}
            for (let i = 0; i < 512; i++) {{
                process.stderr.write('x'.repeat(1024) + '\\n');
            }}
            process.stderr.write('tracker ran with ' + process.env.EXTRA_TRACKER_SETTING + '\\n');
            \n{tracker}"
        ),
    )
    .unwrap();
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(example.join("ticketd-source.json")).unwrap()).unwrap();
    manifest["hosts"] = serde_json::json!(["tracker.example"]);
    manifest["env"] = serde_json::json!(["EXTRA_TRACKER_SETTING", "TICKETD_EXTENSION_TEST"]);
    fs::write(
        package.join("ticketd-source.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();

    let cli = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
        command
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .env("EXTRA_TRACKER_SETTING", "declared")
            .env("UNRELATED_TRACKER_SETTING", "filtered")
            .env("TICKETD_EXTENSION_TEST", "filtered");
        command
    };
    let command = || {
        let mut command = cli();
        command.args(["source", "extension"]);
        command
    };
    let add = |consent: &[u8]| {
        let mut child = command()
            .arg("add")
            .arg(&package)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut prompt = Vec::new();
        while !prompt.ends_with(b"[y/N] ") {
            let mut byte = [0];
            if stderr.read(&mut byte).unwrap() == 0 {
                break;
            }
            prompt.push(byte[0]);
        }
        let prompt = String::from_utf8(prompt).unwrap();
        assert!(prompt.contains("example-tracker"), "{prompt}");
        assert!(prompt.contains("0.1.0"), "{prompt}");
        assert!(prompt.contains("tracker.example"), "{prompt}");
        assert!(prompt.contains("tracker.ts"), "{prompt}");
        assert!(!registry.join("example-tracker").exists());
        child.stdin.take().unwrap().write_all(consent).unwrap();
        child.wait_with_output().unwrap()
    };

    assert!(!add(b"no\n").status.success());
    assert!(!registry.join("example-tracker").exists());
    let accepted = add(b"yes\n");
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let extension: Value = serde_json::from_slice(&accepted.stdout).unwrap();
    assert_eq!(extension["development"], false);
    assert_eq!(extension["hosts"], serde_json::json!(["tracker.example"]));
    assert!(!workspace.exists());

    let listed = command().arg("list").output().unwrap();
    assert!(listed.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&listed.stdout).unwrap(),
        serde_json::json!([extension])
    );

    let conformance = || {
        cli()
            .args([
                "source",
                "conformance",
                "example-tracker",
                "--set",
                "board=Demo",
                "--strict",
            ])
            .output()
            .unwrap()
    };
    let report = conformance();
    assert!(
        report.status.success(),
        "{}",
        String::from_utf8_lossy(&report.stderr)
    );

    let added = cli()
        .args(["source", "add", "example-tracker", "--set", "board=Demo"])
        .output()
        .unwrap();
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    let logs = directory.path().join("logs/sources");
    let current = logs.join("example-tracker.log");
    let previous = logs.join("example-tracker.1.log");
    for path in [&current, &previous] {
        let bytes = fs::read(path).unwrap();
        assert!(!bytes.is_empty() && bytes.len() <= 256 * 1024);
        assert!(!String::from_utf8_lossy(&bytes).contains("declared"));
    }
    assert!(
        fs::read_to_string(current)
            .unwrap()
            .contains("tracker ran with [redacted]")
    );

    fs::write(registry.join("example-tracker/extra.txt"), "a new file").unwrap();
    let blocked = conformance();
    assert!(!blocked.status.success());
    assert!(
        String::from_utf8_lossy(&blocked.stderr).contains("add it again"),
        "{}",
        String::from_utf8_lossy(&blocked.stderr)
    );

    let removed = command()
        .args(["remove", "example-tracker"])
        .output()
        .unwrap();
    assert!(removed.status.success());
    assert!(!registry.join("example-tracker").exists());
    let listed = command().arg("list").output().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&listed.stdout).unwrap(),
        serde_json::json!([])
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
    let logs = directory.path().join("logs/sources");
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
