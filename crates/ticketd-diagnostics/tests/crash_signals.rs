//! Crash signals, seen from outside: a panic leaves a line in the log, and a session that
//! never shut down is reported by the next one.

use std::fs;
use std::path::Path;

use ticketd_diagnostics::{Config, DesktopLogs, install_panic_hook};

/// The text of the folder's one log file.
#[allow(clippy::unwrap_used)]
fn log_text(dir: &Path) -> String {
    let file = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "log"))
        .unwrap();
    fs::read_to_string(file).unwrap()
}

#[allow(clippy::unwrap_used)]
fn lines(dir: &Path) -> Vec<serde_json::Value> {
    log_text(dir)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn a_panic_logs_its_location_and_thread_and_keeps_only_a_literal_message() {
    install_panic_hook();
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(dir.path(), Config::default());

    logs.with_default(|| {
        let _ = std::panic::catch_unwind(|| panic!("static literal"));
        let secret = "Ticket body text";
        let _ = std::panic::catch_unwind(|| panic!("formatted with {secret}"));
    });

    let lines = lines(dir.path());
    let panics: Vec<_> = lines.iter().filter(|l| l["message"] == "panic").collect();
    assert_eq!(panics.len(), 2);
    assert_eq!(panics[0]["level"], "ERROR");
    assert!(
        panics[0]["thread"]
            .as_str()
            .unwrap()
            .contains("a_panic_logs_its_location"),
        "{}",
        panics[0]
    );
    assert!(
        panics[0]["location"]
            .as_str()
            .unwrap()
            .contains("crash_signals.rs:")
    );
    assert_eq!(panics[0]["panic_message"], "static literal");
    // A formatted message can carry the user's text, so it is dropped.
    assert!(panics[1].get("panic_message").is_none());
    assert!(!log_text(dir.path()).contains("Ticket body text"));
}

#[test]
fn a_clean_shutdown_leaves_no_marker_and_the_next_start_reports_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let first = DesktopLogs::open(dir.path(), Config::default());
    assert!(first.previous_session_ended_unexpectedly().is_none());
    assert!(dir.path().join("session.lock").exists());
    drop(first);
    assert!(!dir.path().join("session.lock").exists());

    let second = DesktopLogs::open(dir.path(), Config::default());
    assert!(second.previous_session_ended_unexpectedly().is_none());
}

#[test]
fn an_unclean_shutdown_is_reported_by_the_next_start_with_its_start_time() {
    let dir = tempfile::tempdir().unwrap();
    let before = chrono::Utc::now() - chrono::Duration::seconds(1);
    // A crash or a kill never runs the handle's drop.
    std::mem::forget(DesktopLogs::open(dir.path(), Config::default()));

    let next = DesktopLogs::open(dir.path(), Config::default());

    let exit = next.previous_session_ended_unexpectedly().unwrap();
    let started = exit.started_at.unwrap();
    assert!(started > before && started <= chrono::Utc::now());
    let warning = lines(dir.path())
        .into_iter()
        .find(|line| line["message"] == "previous session ended unexpectedly")
        .unwrap();
    assert_eq!(warning["level"], "WARN");
    assert_eq!(
        warning["previous_started_at"].as_str().unwrap(),
        started.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    // The new session has its own marker, so a crash of this one is reported in turn.
    assert!(dir.path().join("session.lock").exists());
}

#[test]
fn a_marker_that_cannot_be_read_still_counts_as_an_unclean_exit() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("session.lock"), "garbage").unwrap();

    let logs = DesktopLogs::open(dir.path(), Config::default());

    let exit = logs.previous_session_ended_unexpectedly().unwrap();
    assert!(exit.started_at.is_none());
}
