//! What an uncaught WebView error becomes in the log folder.

use std::fs;
use std::path::Path;

use ticketd_diagnostics::{Config, DesktopLogs, WebviewError, record_webview_error};

#[allow(clippy::unwrap_used)]
fn written(dir: &Path) -> Vec<serde_json::Value> {
    let mut lines = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let text = fs::read_to_string(entry.unwrap().path()).unwrap();
        lines.extend(text.lines().map(|line| serde_json::from_str(line).unwrap()));
    }
    lines
}

fn error() -> WebviewError {
    WebviewError {
        name: "TypeError".into(),
        message: "x is undefined".into(),
        frames: vec![
            "at render (tauri://localhost/assets/index.js:10:5)".into(),
            "at commit (tauri://localhost/assets/index.js:20:7)".into(),
        ],
        route: "chats".into(),
        count: 3,
    }
}

#[test]
#[allow(clippy::unwrap_used)]
fn an_uncaught_error_is_an_error_event_on_the_webview_target_even_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());
    logs.with_default(|| record_webview_error(&error()));

    let lines = written(dir.path());
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!(line["target"], "webview");
    assert_eq!(line["level"], "ERROR");
    assert_eq!(line["message"], "uncaught WebView error");
    assert_eq!(line["error_kind"], "TypeError");
    assert_eq!(line["error"], "x is undefined");
    assert_eq!(line["route"], "chats");
    assert_eq!(line["repeat_count"], 3);
    assert_eq!(
        line["frames"],
        "at render (tauri://localhost/assets/index.js:10:5)\nat commit (tauri://localhost/assets/index.js:20:7)"
    );
}

#[test]
#[allow(clippy::unwrap_used)]
fn what_the_page_sends_is_bounded_and_the_kind_stays_a_plain_name() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());
    logs.with_default(|| {
        record_webview_error(&WebviewError {
            name: "my secret ticket title".into(),
            message: "m".repeat(5_000),
            frames: (0..50).map(|i| format!("at f{i}")).collect(),
            route: "r".repeat(1_000),
            count: 0,
        });
    });

    let line = &written(dir.path())[0];
    assert_eq!(line["error_kind"], "Error");
    assert!(line["error"].as_str().unwrap().len() <= 500);
    assert_eq!(line["frames"].as_str().unwrap().lines().count(), 10);
    assert!(line["route"].as_str().unwrap().len() <= 64);
    assert_eq!(line["repeat_count"], 1);
}
