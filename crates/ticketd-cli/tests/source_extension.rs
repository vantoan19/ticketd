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
    let command = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .args(args)
            .output()
            .unwrap()
    };
    let run = |args: &[&str]| {
        let output = command(args);
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
    let no_reason = command(&[
        "source",
        "conformance",
        "example-tracker",
        "--set",
        "board=Demo",
        "--strict",
        "--past-end-cursor",
        "fixture-end",
    ]);
    assert!(!no_reason.status.success());
    let no_reason: Value = serde_json::from_slice(&no_reason.stdout).unwrap();
    assert!(
        no_reason["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["name"] == "typed_closure" && check["outcome"] == "failed")
    );
    let report = run(&[
        "source",
        "conformance",
        "example-tracker",
        "--set",
        "board=Demo",
        "--strict",
        "--past-end-cursor",
        "fixture-end",
        "--skip-check",
        "typed_closure=the example fixture has no typed closure cases",
    ]);
    assert_eq!(report["passed"], true, "{report}");
    let checks = report["checks"].as_array().unwrap();
    for name in [
        "cancellation",
        "empty_continuation",
        "past_end_cursor",
        "stable_identity",
        "conversation",
    ] {
        assert!(
            checks
                .iter()
                .any(|check| check["name"] == name && check["outcome"] == "passed"),
            "{name}: {report}"
        );
    }

    assert!(checks.iter().any(|check| check["name"] == "typed_closure"
        && check["outcome"] == "skipped"
        && check["reason"] == "the example fixture has no typed closure cases"));

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
    let reference = tickets[0]["reference"].as_str().unwrap();
    run(&["source", "extension", "remove", "example-tracker"]);
    let sources = run(&["source", "list"]);
    let missing = sources
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["saved"]["id"] == "example-tracker")
        .unwrap();
    assert_eq!(missing["unavailable"], true);
    assert_eq!(missing["connector"]["name"], "Example Tracker");
    assert_eq!(missing["connector"]["capabilities"], serde_json::json!([]));
    let failed = command(&["source", "example-tracker", "refresh"]);
    assert!(!failed.status.success());
    let report: Value = serde_json::from_slice(&failed.stdout).unwrap();
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["code"] == "unknown_provider")
    );
    let ticket = run(&["show", reference]);
    assert_eq!(ticket["source"]["unavailable"]["code"], "unknown_provider");
    let taken = run(&["source", "take-ownership", reference]);
    assert_eq!(taken["source"]["ownership"], "local");

    // Workspaces with missing presentation metadata keep their connection controls.
    rusqlite::Connection::open(&workspace)
        .unwrap()
        .execute(
            "DELETE FROM source_presentations WHERE provider = 'example-tracker'",
            [],
        )
        .unwrap();
    let sources = run(&["source", "list"]);
    let missing = sources
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["saved"]["id"] == "example-tracker")
        .unwrap();
    assert_eq!(missing["connector"]["name"], "example-tracker");
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
    // An optional capability from a newer extension must not prevent this
    // host from installing it and using the capabilities it already knows.
    let tracker = tracker.replace("capabilities: [", "capabilities: [\"future_optional\", ");
    fs::write(
        package.join("tracker.ts"),
        format!(
            "if (!process.env.PATH || !(process.env.HOME || process.env.USERPROFILE) ||
                process.env.EXTRA_TRACKER_SETTING !== 'docs' ||
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
            .env("EXTRA_TRACKER_SETTING", "docs")
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
                "--past-end-cursor",
                "fixture-end",
                "--skip-check",
                "typed_closure=the example fixture has no typed closure cases",
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
        assert!(!String::from_utf8_lossy(&bytes).contains("docs"));
    }
    assert!(
        fs::read_to_string(current)
            .unwrap()
            .contains("tracker ran with [redacted]")
    );

    let installed = Path::new(extension["path"].as_str().unwrap());
    fs::write(installed.join("extra.txt"), "a new file").unwrap();
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
    assert!(!installed.exists());
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
    let succeeded = |output: &std::process::Output| {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    succeeded(&run(
        &["source", "extension", "link", example.to_str().unwrap()],
        &[],
    ));
    let synthetic = "qz85-not-a-live-api-key";
    let from_env = [("TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY", synthetic)];
    let added = run(
        &["source", "add", "example-tracker", "--set", "board=Sign-in"],
        &from_env,
    );
    succeeded(&added);
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
    succeeded(&refreshed);
    assert!(!String::from_utf8_lossy(&refreshed.stdout).contains(synthetic));
    assert!(!String::from_utf8_lossy(&std::fs::read(&workspace).unwrap()).contains(synthetic));
    let backup = directory.path().join("backup.sqlite3");
    succeeded(&run(&["backup", backup.to_str().unwrap()], &[]));
    assert!(!String::from_utf8_lossy(&std::fs::read(&backup).unwrap()).contains(synthetic));
    let export = run(&["export"], &[]);
    succeeded(&export);
    assert!(!String::from_utf8_lossy(&export.stdout).contains(synthetic));
}

#[test]
fn a_publication_uses_the_same_credential_as_its_account_check() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let extension = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ticketd-core/tests/fixtures/source-extension");
    let count = directory.path().join("credential-calls");
    let alternating = serde_json::to_string(&[
        "node",
        "-e",
        "const fs = require('node:fs'); const f = process.argv[1];
         const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
         fs.writeFileSync(f, String(n + 1));
         console.log(n % 2 === 0 ? 'private-first' : 'private-second');",
        count.to_str().unwrap(),
    ])
    .unwrap();
    let run = |args: &[&str], password_command: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
        command
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .env_remove("TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY")
            .env_remove("TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY_COMMAND");
        if password_command {
            command.env("TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY_COMMAND", &alternating);
        } else {
            command.env("TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY", "private-first");
        }
        let output = command.args(args).output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    run(
        &["source", "extension", "link", extension.to_str().unwrap()],
        false,
    );
    run(
        &[
            "source",
            "add",
            "scripted",
            "--set",
            "mode=credential_account",
        ],
        false,
    );
    let local = run(&["create", "Send this ticket"], false);
    let outcome = run(
        &["source", "publish", local["reference"].as_str().unwrap()],
        true,
    );
    assert_eq!(outcome["ticket"]["source"]["origin"], "published");
    assert_eq!(std::fs::read_to_string(count).unwrap(), "1");
}

#[test]
fn a_retired_connection_cannot_leak_its_override_to_a_new_provider() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ticketd-core/tests/fixtures/source-extension");
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .env("TICKETD_SOURCE_DEV_TRACKER_FIXTURE_KEY", "private-retired")
            .env_remove("TICKETD_SOURCE_DEV_TRACKER_2_FIXTURE_KEY")
            .env_remove("TICKETD_SOURCE_DEV_TRACKER_2_FIXTURE_KEY_COMMAND")
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
    let link = |provider: &str| {
        let folder = directory.path().join(provider);
        std::fs::create_dir(&folder).unwrap();
        for file in ["driver.mjs", "ticketd-source.json"] {
            let text = std::fs::read_to_string(fixture.join(file)).unwrap();
            std::fs::write(
                folder.join(file),
                text.replace("\"scripted\"", &format!("\"{provider}\"")),
            )
            .unwrap();
        }
        run(&["source", "extension", "link", folder.to_str().unwrap()]);
    };
    link("dev--tracker");
    let first = run(&["source", "add", "dev--tracker", "--set", "mode=valid"]);
    assert_eq!(first["source"]["id"], "dev-tracker");
    run(&["source", "dev-tracker", "remove"]);

    let backup = directory.path().join("portable.sqlite3");
    run(&["backup", backup.to_str().unwrap()]);
    ticketd_core::Workspace::restore(&workspace, &backup).unwrap();

    link("dev-tracker");
    // This fixture rejects the request if a credential reaches a result.
    let next = run(&[
        "source",
        "add",
        "dev-tracker",
        "--set",
        "mode=secret_result",
    ]);
    assert_eq!(next["source"]["id"], "dev-tracker-2");
}

#[test]
fn known_credentials_are_redacted_in_diagnostics_and_rejected_in_results() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let extension = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ticketd-core/tests/fixtures/source-extension");
    let secret = "private-qz85/to%ken";
    let command = |credential: &str, args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .env("TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY", credential)
            .env("TICKETD_LOG", "ticketd_core::source::extension::wire=debug")
            // The direct override takes precedence over a failed password command.
            .env(
                "TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY_COMMAND",
                "[\"invalid-executable\"]",
            )
            .args(args)
            .output()
            .unwrap()
    };
    let linked = command(
        secret,
        &["source", "extension", "link", extension.to_str().unwrap()],
    );
    assert!(linked.status.success(), "{:?}", linked.stderr);
    for (mode, value, expected) in [
        (
            "secret_stdout",
            secret,
            "unexpected source extension stdout",
        ),
        ("secret_error", secret, "tracker refused [redacted]"),
        (
            "secret_result",
            secret,
            "source extension returned a credential in its result",
        ),
        (
            "embedded_secret_result",
            "mv3k2",
            "source extension returned a credential in its result",
        ),
    ] {
        let result = command(
            value,
            &[
                "source",
                "add",
                "scripted",
                "--set",
                &format!("mode={mode}"),
            ],
        );
        assert!(!result.status.success(), "{mode}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains(expected), "{mode}: {stderr}");
        assert!(!stderr.contains(value));
        assert!(!stderr.contains("private-qz85%2Fto%25ken"));
    }
    for mode in ["safe_detail", "private_detail", "credential_detail"] {
        let output = command(
            secret,
            &[
                "source",
                "add",
                "scripted",
                "--set",
                &format!("mode={mode}"),
            ],
        );
        assert!(!output.status.success());
        let logs = String::from_utf8_lossy(&output.stderr);
        assert!(logs.contains("error_kind=\"protocol\""), "{mode}: {logs}");
        assert!(!logs.contains("fixture_response_missing"));
        assert!(!logs.contains("error_detail="));
        assert!(!logs.contains(secret));
        assert!(!logs.contains("someone@example.invalid"));
        assert!(
            logs.lines()
                .any(|line| line.starts_with("error:")
                    && line.contains("could not read the tracker"))
        );
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

#[cfg(target_os = "linux")]
#[test]
fn an_unavailable_linux_keyring_reports_session_only_and_does_not_persist_a_key() {
    use std::{io::Write, process::Stdio};

    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace.sqlite3");
    let registry = directory.path().join("extensions");
    let example =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/ticket-source-example-ts");
    let env_key = "TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY";
    let secret = "synthetic-ephemeral-credential";
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
        command
            .env("TICKETD_TEST_WORKSPACE", &workspace)
            .env("TICKETD_SOURCE_EXTENSIONS_DIR", &registry)
            .env_remove(env_key)
            .env_remove("TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY_COMMAND")
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!(
                    "unix:path={}",
                    directory.path().join("no-session.sock").display()
                ),
            );
        command
    };
    assert!(
        command()
            .args(["source", "extension", "link", example.to_str().unwrap()])
            .status()
            .unwrap()
            .success()
    );
    assert!(
        command()
            .env(env_key, "synthetic-initial")
            .args(["source", "add", "example-tracker", "--set", "board=Sign-in"])
            .status()
            .unwrap()
            .success()
    );
    let refresh = ["source", "example-tracker", "refresh"];
    let denied = command().args(refresh).output().unwrap();
    assert!(!denied.status.success());
    let denied_message = String::from_utf8_lossy(&denied.stderr);
    assert!(denied_message.contains("sign-in --config-file -"));
    assert!(denied_message.contains("Settings › Ticket sources"), "{denied_message}");
    let mut sign_in = command()
        .args(["source", "example-tracker", "sign-in", "--config-file", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let credentials = serde_json::json!({"api_key": secret}).to_string();
    sign_in
        .stdin
        .take()
        .unwrap()
        .write_all(credentials.as_bytes())
        .unwrap();
    let updated = sign_in.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&updated.stderr);
    assert!(updated.status.success(), "{stderr}");
    assert!(stderr.contains("credentials last until this invocation exits"));
    let saved: Value = serde_json::from_slice(&updated.stdout).unwrap();
    assert_eq!(
        saved["session_secret_fields"],
        serde_json::json!(["api_key"])
    );
    assert_eq!(saved["config"], serde_json::json!({"board": "Sign-in"}));
    assert!(!String::from_utf8_lossy(&updated.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&std::fs::read(&workspace).unwrap()).contains(secret));
    let expired = command().args(refresh).output().unwrap();
    assert!(!expired.status.success());
    assert!(String::from_utf8_lossy(&expired.stdout).contains("unauthenticated"));
}
