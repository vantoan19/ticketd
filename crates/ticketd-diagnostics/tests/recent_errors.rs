//! Recent errors, seen from outside: log files in a folder go in, groups come out.

use std::fs;
use std::path::Path;

use serde_json::json;
use ticketd_diagnostics::{Config, DesktopLogs};

/// Writes `lines` as a past day's log file, one JSON object per line.
#[allow(clippy::unwrap_used)]
fn day_file(dir: &Path, day: &str, lines: &[serde_json::Value]) {
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(dir.join(format!("ticketd.{day}.log")), text).unwrap();
}

fn line(timestamp: &str, level: &str, target: &str, kind: Option<&str>) -> serde_json::Value {
    let mut line = json!({
        "timestamp": timestamp, "level": level, "target": target, "message": "something failed",
    });
    if let Some(kind) = kind {
        line["error_kind"] = kind.into();
    }
    line
}

#[test]
fn warnings_and_errors_are_grouped_by_target_and_kind_with_first_and_last_seen() {
    let dir = tempfile::tempdir().unwrap();
    day_file(
        dir.path(),
        "2026-11-17",
        &[
            line(
                "2026-11-17T08:00:00.000Z",
                "WARN",
                "ticketd_desktop_lib::sync",
                Some("offline"),
            ),
            line(
                "2026-11-17T09:00:00.000Z",
                "INFO",
                "ticketd_desktop_lib::sync",
                Some("offline"),
            ),
            line(
                "2026-11-17T10:00:00.000Z",
                "WARN",
                "ticketd_core::source",
                Some("offline"),
            ),
        ],
    );
    day_file(
        dir.path(),
        "2026-11-18",
        &[
            line(
                "2026-11-18T07:30:00.000Z",
                "ERROR",
                "ticketd_desktop_lib::sync",
                Some("offline"),
            ),
            line(
                "2026-11-18T07:45:00.000Z",
                "WARN",
                "ticketd_desktop_lib::sync",
                Some("offline"),
            ),
            // Without an error kind, the message stands in for it.
            line(
                "2026-11-18T08:00:00.000Z",
                "ERROR",
                "ticketd_desktop_lib",
                None,
            ),
            // A half-written line is skipped, not fatal.
            json!("{\"timestamp\": \"2026-11-18T09:0"),
        ],
    );
    let logs = DesktopLogs::open(dir.path(), Config::default());

    let groups = logs.recent_errors();

    // Most recently seen first.
    let summary: Vec<_> = groups
        .iter()
        .map(|group| (group.target.as_str(), group.kind.as_str(), group.count))
        .collect();
    assert_eq!(
        summary,
        [
            ("ticketd_desktop_lib", "something failed", 1),
            ("ticketd_desktop_lib::sync", "offline", 3),
            ("ticketd_core::source", "offline", 1),
        ]
    );
    assert_eq!(groups[1].first_seen, "2026-11-17T08:00:00.000Z");
    assert_eq!(groups[1].last_seen, "2026-11-18T07:45:00.000Z");
}

#[test]
fn events_logged_by_this_run_are_included() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());
    logs.with_default(|| {
        tracing::warn!(target: "ticketd_core::sync", error_kind = "offline", "sync pass failed");
        tracing::warn!(target: "ticketd_core::sync", error_kind = "offline", "sync pass failed");
        tracing::info!(target: "ticketd_core::sync", "sync pass finished");
    });

    let groups = logs.recent_errors();

    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].count, 2);
    assert_eq!(groups[0].kind, "offline");
}

#[test]
fn a_folder_with_no_problems_has_no_recent_errors() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());

    assert!(logs.recent_errors().is_empty());
}

#[test]
fn a_previous_session_that_ended_unexpectedly_is_among_the_recent_errors() {
    let dir = tempfile::tempdir().unwrap();
    // The marker an earlier session left behind because it never shut down.
    fs::write(dir.path().join("session.lock"), "2026-11-18T07:45:00.000Z").unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());

    let groups = logs.recent_errors();

    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].kind, "previous session ended unexpectedly");
    assert_eq!(groups[0].level, "WARN");
    assert_eq!(groups[0].count, 1);
}
