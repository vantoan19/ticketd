//! What an uncaught WebView error becomes in the log folder.

use std::fs;
use std::path::Path;

use ticketd_diagnostics::{Config, DesktopLogs, WebviewError, record_webview_error};

#[allow(clippy::unwrap_used)]
fn written(dir: &Path) -> Vec<serde_json::Value> {
    let mut lines = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        // The folder also holds the session marker.
        if path.extension().is_none_or(|extension| extension != "log") {
            continue;
        }
        let text = fs::read_to_string(path).unwrap();
        lines.extend(text.lines().map(|line| serde_json::from_str(line).unwrap()));
    }
    lines
}

fn error() -> WebviewError {
    WebviewError {
        name: "TypeError".into(),
        frames: vec!["index.js:10:5".into(), "vendor.js:20:7".into()],
        route: "chats".into(),
        count: 3,
    }
}

#[test]
#[allow(clippy::unwrap_used)]
fn an_uncaught_error_is_an_error_event_on_the_ticketd_webview_target_even_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());
    logs.with_default(|| record_webview_error(&error()));

    let lines = written(dir.path());
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!(line["target"], "ticketd::webview");
    assert_eq!(line["level"], "ERROR");
    assert_eq!(line["message"], "uncaught WebView error");
    assert_eq!(line["error_kind"], "TypeError");
    // The message can quote a Ticket or a Harness, so it is never logged.
    assert!(line.get("error").is_none());
    assert_eq!(line["route"], "chats");
    assert_eq!(line["repeat_count"], 3);
    assert_eq!(line["frames"], "index.js:10:5\nvendor.js:20:7");
}

#[test]
#[allow(clippy::unwrap_used)]
fn what_the_page_sends_is_bounded_and_the_kind_stays_a_plain_name() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());
    logs.with_default(|| {
        record_webview_error(&WebviewError {
            name: "my secret ticket title".into(),
            frames: (0..50).map(|i| format!("f{i}.js:1:1")).collect(),
            route: "r".repeat(1_000),
            count: 0,
        });
    });

    let line = &written(dir.path())[0];
    assert_eq!(line["error_kind"], "Error");
    assert_eq!(line["frames"].as_str().unwrap().lines().count(), 10);
    assert!(line["route"].as_str().unwrap().len() <= 64);
    assert_eq!(line["repeat_count"], 1);
}

#[test]
#[allow(clippy::unwrap_used)]
fn only_frames_shaped_as_file_line_column_are_logged() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());
    logs.with_default(|| {
        record_webview_error(&WebviewError {
            name: "Error".into(),
            frames: vec![
                "app.js:1:2".into(),
                "tauri://localhost/assets/app.js?token=abc:3:4".into(),
                "at render (app.js:5:6)".into(),
                "my secret ticket title".into(),
                "chunk-AB12.min.js:7:8".into(),
            ],
            route: "chats".into(),
            count: 1,
        });
    });

    let line = &written(dir.path())[0];
    assert_eq!(line["frames"], "app.js:1:2\nchunk-AB12.min.js:7:8");
}
