//! The diagnostics export, seen from outside: a log folder and some facts go in, a zip comes
//! out. The tests read the zip back the way a person attaching it to an issue would.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use chrono::{Duration, Utc};
use serde_json::{Value, json};
use ticketd_diagnostics::{
    Config, DesktopLogs, Facts, HarnessVersion, KnownValues, WorkspaceHealth,
};

/// `n` days before today (UTC), as the log files name them.
fn days_ago(n: i64) -> String {
    (Utc::now() - Duration::days(n))
        .format("%Y-%m-%d")
        .to_string()
}

#[allow(clippy::unwrap_used)]
fn day_file(dir: &Path, day: &str, lines: &[Value]) {
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(dir.join(format!("ticketd.{day}.log")), text).unwrap();
}

fn event(day: &str, level: &str, message: &str) -> Value {
    json!({
        "timestamp": format!("{day}T10:00:00.000Z"),
        "level": level, "target": "ticketd_core::sync", "message": message,
    })
}

fn facts() -> Facts {
    Facts {
        app_version: "0.1.0".into(),
        commit: "abc1234".into(),
        build: "release".into(),
        os: "macOS 15.1".into(),
        arch: "aarch64".into(),
        webview: "WebKit 619.1".into(),
        sync_enabled: true,
        harnesses: vec![
            HarnessVersion {
                name: "claude".into(),
                version: Some("2.1.0".into()),
            },
            HarnessVersion {
                name: "codex".into(),
                version: None,
            },
        ],
        workspace: WorkspaceHealth {
            format_version: Some(83),
            quick_check: "ok".into(),
            file_bytes: 4096,
            wal_bytes: 512,
            row_counts: BTreeMap::from([("tickets".into(), 12), ("documents".into(), 3)]),
        },
        known: KnownValues::default(),
    }
}

/// Every file in the zip, by path.
#[allow(clippy::unwrap_used)]
fn read_zip(path: &Path) -> Vec<(String, String)> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    (0..archive.len())
        .map(|index| {
            let mut file = archive.by_index(index).unwrap();
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            (file.name().unwrap().to_string(), text)
        })
        .collect()
}

// Clippy exempts #[test] functions from the panic lint, not their helpers.
#[allow(clippy::panic)]
fn file<'a>(files: &'a [(String, String)], name: &str) -> &'a str {
    files
        .iter()
        .find(|(path, _)| path == name)
        .map(|(_, text)| text.as_str())
        .unwrap_or_else(|| panic!("{name} is not in the bundle: {:?}", names(files)))
}

fn names(files: &[(String, String)]) -> Vec<&str> {
    files.iter().map(|(name, _)| name.as_str()).collect()
}

#[test]
fn the_bundle_holds_a_summary_the_workspace_health_the_errors_and_the_last_three_days() {
    let logs_dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    // The day 9 days ago is older than the errors look back, whatever its modified time.
    for age in [9, 5, 3, 2, 1, 0] {
        day_file(
            logs_dir.path(),
            &days_ago(age),
            &[event(&days_ago(age), "WARN", "sync pass failed")],
        );
    }
    let logs = DesktopLogs::open(logs_dir.path(), Config::default());

    let exported = logs.export(out.path(), &facts()).unwrap();

    // A folder as destination gets the dated name; the bundle is a `.zip`.
    let expected = format!("ticketd-diagnostics-{}.zip", Utc::now().format("%Y-%m-%d"));
    assert_eq!(exported.path, out.path().join(expected));
    assert_eq!(exported.bytes, fs::metadata(&exported.path).unwrap().len());
    let files = read_zip(&exported.path);

    // Today's file and the two days before it, newest first; every log is `.log`.
    let logs_in_bundle: Vec<_> = names(&files)
        .into_iter()
        .filter(|name| name.starts_with("logs/"))
        .collect();
    assert_eq!(
        logs_in_bundle,
        [
            format!("logs/ticketd.{}.log", days_ago(0)),
            format!("logs/ticketd.{}.log", days_ago(1)),
            format!("logs/ticketd.{}.log", days_ago(2)),
        ]
    );
    let mut top: Vec<_> = names(&files)
        .into_iter()
        .filter(|name| !name.starts_with("logs/"))
        .collect();
    top.sort_unstable();
    assert_eq!(top, ["errors.json", "summary.txt", "workspace.json"]);

    let summary = file(&files, "summary.txt");
    for expected in [
        "ticketd 0.1.0",
        "abc1234",
        "macOS 15.1",
        "aarch64",
        "WebKit 619.1",
        "Sync: on",
        "claude 2.1.0",
        "codex",
        "Log level: info",
    ] {
        assert!(summary.contains(expected), "{expected} in\n{summary}");
    }
    assert_eq!(summary, logs.summary(&facts()));

    let workspace: Value = serde_json::from_str(file(&files, "workspace.json")).unwrap();
    assert_eq!(workspace["format_version"], 83);
    assert_eq!(workspace["quick_check"], "ok");
    assert_eq!(workspace["file_bytes"], 4096);
    assert_eq!(workspace["wal_bytes"], 512);
    assert_eq!(workspace["row_counts"]["tickets"], 12);

    // The errors are the groups the Diagnostics page shows, from all of the folder.
    let errors: Value = serde_json::from_str(file(&files, "errors.json")).unwrap();
    assert_eq!(errors[0]["kind"], "sync pass failed");
    assert_eq!(errors[0]["count"], 5);
}

#[test]
fn a_file_path_as_destination_is_used_as_it_is() {
    let logs_dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(logs_dir.path(), Config::default());
    let chosen = out.path().join("for-the-issue.zip");

    let exported = logs.export(&chosen, &facts()).unwrap();

    assert_eq!(exported.path, chosen);
    assert!(
        read_zip(&chosen)
            .iter()
            .any(|(name, _)| name == "summary.txt")
    );
}

#[test]
fn a_bundle_over_the_limit_keeps_the_newest_lines_of_the_newest_days() {
    let logs_dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    // Distinct text per line, so that compression cannot make the pile fit.
    let pile = |day: &str, tag: &str| -> Vec<Value> {
        (0..3000)
            .map(|n| {
                event(
                    day,
                    "INFO",
                    &format!("{tag} {n} {:x}", n * 2_654_435_761_u64),
                )
            })
            .collect()
    };
    day_file(
        logs_dir.path(),
        &days_ago(1),
        &pile(&days_ago(1), "yesterday"),
    );
    day_file(logs_dir.path(), &days_ago(0), &pile(&days_ago(0), "today"));
    let limit = 20 * 1024;
    let logs = DesktopLogs::open(
        logs_dir.path(),
        Config {
            max_export_bytes: limit,
            ..Config::default()
        },
    );

    let exported = logs.export(out.path(), &facts()).unwrap();

    assert!(exported.bytes <= limit, "{} bytes", exported.bytes);
    let files = read_zip(&exported.path);
    let today = file(&files, &format!("logs/ticketd.{}.log", days_ago(0)));
    // The file keeps its newest lines and loses its oldest.
    assert!(today.contains("today 2999 "), "newest line kept");
    assert!(!today.contains("today 0 "), "oldest line cut");
    // Whatever is kept is whole lines.
    assert!(
        today
            .lines()
            .all(|line| serde_json::from_str::<Value>(line).is_ok())
    );
}

#[test]
fn a_line_is_rebuilt_from_allowed_fields_and_ids_are_kept() {
    let logs_dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let day = days_ago(0);
    day_file(
        logs_dir.path(),
        &day,
        &[json!({
            "timestamp": format!("{day}T10:00:00.000Z"), "level": "WARN",
            "target": "ticketd_core::sync", "message": "sync pass failed",
            "ticket_ref": "TK-7", "chat_id": "chat-9f2", "automation_run_id": "run-1",
            "source_id": "src-3", "request_id": "req-5", "error_kind": "offline", "repeat_count": 3, "count": 3, "state": "x", "attempt": 2, "duration_ms": 5,
            "title": "Quarterly plan", "error": "could not reach the drive",
            "nested": {"title": "Quarterly plan"}, "list": ["Quarterly plan"],
            "spans": [{"name": "sync_pass", "source_id": "src-3", "title": "Quarterly plan"}],
            "span": {"name": "sync_pass", "source_id": "src-3", "title": "Quarterly plan"},
        })],
    );
    let logs = DesktopLogs::open(logs_dir.path(), Config::default());

    let exported = logs.export(out.path(), &facts()).unwrap();

    let files = read_zip(&exported.path);
    let log = file(&files, &format!("logs/ticketd.{day}.log"));
    let line: Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
    assert_eq!(
        line,
        json!({
            "timestamp": format!("{day}T10:00:00.000Z"), "level": "WARN",
            "target": "ticketd_core::sync", "message": "sync pass failed",
            "ticket_ref": "TK-7", "chat_id": "chat-9f2", "automation_run_id": "run-1",
            "source_id": "src-3", "request_id": "req-5", "error_kind": "offline", "repeat_count": 3,
            "spans": [{"name": "sync_pass", "source_id": "src-3"}],
            "span": {"name": "sync_pass", "source_id": "src-3"},
        })
    );
}

#[test]
fn known_values_are_replaced_wherever_they_appear_and_ids_are_not() {
    let logs_dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let day = days_ago(0);
    let mut line = event(
        &day,
        "WARN",
        "could not open /Users/jdoe/Drive/Work for jdoe@example.com; User: arn:aws:sts::123456789012:assumed-role/Admin/jdoe is not authorized on arn:aws:iam::123456789012:role/Sync",
    );
    line["target"] = "ticketd_core::sync".into();
    line["chat_id"] = "chat-jdoe-1".into();
    day_file(logs_dir.path(), &day, &[line]);
    let logs = DesktopLogs::open(logs_dir.path(), Config::default());
    let mut facts = facts();
    facts.known = KnownValues {
        home: Some("/Users/jdoe".into()),
        os_username: Some("jdoe".into()),
        workspace_path: Some("/Users/jdoe/Drive/Work".into()),
        drive_email: Some("jdoe@example.com".into()),
        aws_identity: Some("arn:aws:sts::123456789012:assumed-role/Admin/jdoe".into()),
    };
    facts.workspace.quick_check = "failed at /Users/jdoe/Drive/Work/ticketd.db".into();

    let exported = logs.export(out.path(), &facts).unwrap();

    let files = read_zip(&exported.path);
    let log = file(&files, &format!("logs/ticketd.{day}.log"));
    assert!(
        log.contains("could not open <workspace> for <drive-account>; User: <aws-identity> is not authorized on arn:aws:iam::<aws-account>:role/Sync"),
        "{log}"
    );
    // An ID is kept as it is, even where it contains the username.
    assert!(log.contains("chat-jdoe-1"), "{log}");
    assert!(file(&files, "workspace.json").contains("<workspace>/ticketd.db"));
    for (name, text) in &files {
        for secret in [
            "/Users/jdoe",
            "jdoe@example.com",
            "123456789012",
            "assumed-role/Admin",
        ] {
            assert!(!text.contains(secret), "{secret} in {name}");
        }
    }
}
