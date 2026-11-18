//! The desktop's log folder, seen from outside: ordinary `tracing` events go in, files come
//! out. Each test points the handle at its own temporary folder and emits events inside
//! that handle's subscriber, so tests do not share a global one.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use ticketd_diagnostics::{Config, DesktopLogs};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

fn open(dir: &Path) -> DesktopLogs {
    DesktopLogs::open(dir, Config::default())
}

/// The folder's `ticketd.*.log` files, oldest name first.
// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
fn log_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("ticketd.") && name.ends_with(".log"))
        })
        .collect();
    files.sort();
    files
}

#[allow(clippy::unwrap_used)]
fn lines(path: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// A stand-in for an old log file: `size` bytes, last modified `age` ago.
#[allow(clippy::unwrap_used)]
fn old_file(dir: &Path, name: &str, size: usize, age: Duration) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, vec![b'x'; size]).unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(SystemTime::now() - age)
        .unwrap();
    path
}

#[test]
fn an_event_becomes_one_json_line_in_todays_file() {
    let dir = tempfile::tempdir().unwrap();
    let logs = open(dir.path());
    logs.with_default(|| {
        tracing::info!(target: "ticketd_core::sync", ticket_ref = "T-1", count = 3, "sync pass finished");
    });

    let files = log_files(dir.path());
    assert_eq!(files.len(), 1);
    let name = files[0].file_name().unwrap().to_str().unwrap().to_string();
    let lines = lines(&files[0]);
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!(line["level"], "INFO");
    assert_eq!(line["target"], "ticketd_core::sync");
    assert_eq!(line["message"], "sync pass finished");
    assert_eq!(line["ticket_ref"], "T-1");
    assert_eq!(line["count"], 3);

    // RFC 3339 in UTC, and the file is named for the same UTC day.
    let timestamp = line["timestamp"].as_str().unwrap();
    assert!(timestamp.ends_with('Z'), "{timestamp}");
    assert!(
        chrono::DateTime::parse_from_rfc3339(timestamp).is_ok(),
        "{timestamp}"
    );
    assert_eq!(name, format!("ticketd.{}.log", &timestamp[..10]));
}

#[test]
fn a_span_chain_is_recorded_and_closing_it_records_its_duration() {
    let dir = tempfile::tempdir().unwrap();
    let logs = open(dir.path());
    logs.with_default(|| {
        let pass = tracing::info_span!(target: "ticketd_core::sync", "sync_pass", source_id = "s-1");
        pass.in_scope(|| tracing::warn!(target: "ticketd_core::sync", error_kind = "offline", "sync pass failed"));
    });

    let lines = lines(&log_files(dir.path())[0]);
    let failed = lines
        .iter()
        .find(|line| line["message"] == "sync pass failed")
        .unwrap();
    assert_eq!(failed["error_kind"], "offline");
    assert_eq!(failed["spans"][0]["name"], "sync_pass");
    assert_eq!(failed["spans"][0]["source_id"], "s-1");

    let closed = lines
        .iter()
        .find(|line| line["message"] == "close")
        .unwrap();
    assert!(closed["time.busy"].is_string());
}

#[test]
fn our_crates_log_at_info_and_dependencies_at_warn_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let logs = open(dir.path());
    logs.with_default(|| {
        tracing::info!(target: "ticketd_chat_host::claude", "ours");
        tracing::debug!(target: "ticketd_chat_host::claude", "ours but debug");
        tracing::info!(target: "hyper::client", "theirs");
        tracing::warn!(target: "hyper::client", "theirs but warn");
    });

    let messages: Vec<_> = lines(&log_files(dir.path())[0])
        .iter()
        .map(|line| line["message"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(messages, ["ours", "theirs but warn"]);
}

#[test]
fn debug_logging_takes_effect_immediately_and_switches_back() {
    let dir = tempfile::tempdir().unwrap();
    let logs = open(dir.path());
    logs.with_default(|| {
        tracing::debug!(target: "ticketd_core::sync", "before");
        logs.set_debug(true);
        tracing::debug!(target: "ticketd_core::sync", "during");
        logs.set_debug(false);
        tracing::debug!(target: "ticketd_core::sync", "after");
    });

    let messages: Vec<_> = lines(&log_files(dir.path())[0])
        .iter()
        .map(|line| line["message"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(messages, ["during"]);
}

#[test]
fn a_filter_override_wins_over_the_debug_switch() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(
        dir.path(),
        Config {
            filter_override: Some("ticketd=trace".into()),
            ..Config::default()
        },
    );
    logs.with_default(|| {
        logs.set_debug(false);
        tracing::trace!(target: "ticketd_core::sync", "still traced");
    });

    assert_eq!(lines(&log_files(dir.path())[0]).len(), 1);
}

#[test]
fn the_level_reports_the_default_debug_and_the_environment_override() {
    let dir = tempfile::tempdir().unwrap();
    let logs = open(dir.path());
    let level = logs.log_level();
    assert_eq!(
        (level.level.as_str(), level.debug, level.env_override),
        ("info", false, None)
    );
    logs.set_debug(true);
    let level = logs.log_level();
    assert_eq!((level.level.as_str(), level.debug), ("debug", true));
    logs.set_debug(false);
    assert_eq!(logs.log_level().level, "info");

    let pinned = DesktopLogs::open(
        tempfile::tempdir().unwrap().path(),
        Config {
            filter_override: Some("ticketd=trace".into()),
            ..Config::default()
        },
    );
    pinned.set_debug(true);
    let level = pinned.log_level();
    // The override decides, and the switch has nothing to turn on.
    assert_eq!(level.level, "ticketd=trace");
    assert!(!level.debug);
    assert_eq!(level.env_override.as_deref(), Some("ticketd=trace"));
}

#[test]
fn a_filter_that_does_not_parse_is_not_an_override_and_is_reported_once_without_its_text() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(
        dir.path(),
        Config {
            filter_override: Some("ticketd=loudly".into()),
            ..Config::default()
        },
    );

    // The normal switch: no override, and Debug logging does something.
    assert_eq!(logs.log_level().env_override, None);
    logs.with_default(|| {
        logs.set_debug(true);
        tracing::debug!(target: "ticketd_core::sync", "now visible");
    });
    let level = logs.log_level();
    assert_eq!((level.level.as_str(), level.debug), ("debug", true));

    let lines = lines(&log_files(dir.path())[0]);
    let notices: Vec<_> = lines
        .iter()
        .filter(|line| line["message"] == "TICKETD_LOG ignored")
        .collect();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["level"], "WARN");
    assert_eq!(notices[0]["length"], 14);
    assert!(
        !fs::read_to_string(&log_files(dir.path())[0])
            .unwrap()
            .contains("loudly")
    );
    assert!(lines.iter().any(|line| line["message"] == "now visible"));
}

#[test]
fn the_logs_folder_is_the_one_the_files_are_written_to() {
    let dir = tempfile::tempdir().unwrap();
    let logs = open(dir.path());
    assert_eq!(logs.dir(), dir.path());
}

#[test]
fn opening_removes_files_older_than_seven_days_by_modified_time() {
    let dir = tempfile::tempdir().unwrap();
    // A name from last week with a fresh mtime stays: age is the modified time.
    old_file(dir.path(), "ticketd.2020-01-01.log", 10, DAY * 8);
    let kept = old_file(dir.path(), "ticketd.2020-01-02.log", 10, DAY * 6);
    let unrelated = old_file(dir.path(), "notes.txt", 10, DAY * 30);

    let _logs = open(dir.path());

    assert!(!dir.path().join("ticketd.2020-01-01.log").exists());
    assert!(kept.exists());
    assert!(
        unrelated.exists(),
        "only ticketd's own log files are pruned"
    );
}

#[test]
fn opening_removes_the_oldest_files_until_the_folder_fits() {
    let dir = tempfile::tempdir().unwrap();
    old_file(dir.path(), "ticketd.a.log", 400, DAY * 3);
    old_file(dir.path(), "ticketd.b.log", 400, DAY * 2);
    let newest = old_file(dir.path(), "ticketd.c.log", 400, DAY);

    let _logs = DesktopLogs::open(
        dir.path(),
        Config {
            max_total_bytes: 900,
            ..Config::default()
        },
    );

    assert!(!dir.path().join("ticketd.a.log").exists());
    assert!(dir.path().join("ticketd.b.log").exists());
    assert!(newest.exists());
}

#[test]
fn past_the_file_cap_only_warnings_and_errors_are_written_after_one_notice() {
    let dir = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(
        dir.path(),
        Config {
            max_file_bytes: 600,
            ..Config::default()
        },
    );
    logs.with_default(|| {
        for _ in 0..10 {
            tracing::info!(target: "ticketd_core::sync", "filling the day's file with routine lines");
        }
        tracing::info!(target: "ticketd_core::sync", "dropped info");
        tracing::info!(target: "ticketd_core::sync", "dropped info again");
        tracing::warn!(target: "ticketd_core::sync", "kept warning");
        tracing::error!(target: "ticketd_core::sync", "kept error");
    });

    let lines = lines(&log_files(dir.path())[0]);
    let messages: Vec<_> = lines
        .iter()
        .map(|line| line["message"].as_str().unwrap())
        .collect();
    assert!(!messages.contains(&"dropped info"));
    assert!(messages.ends_with(&["kept warning", "kept error"]));
    let notices: Vec<_> = lines
        .iter()
        .filter(|line| line["target"] == "ticketd_diagnostics")
        .collect();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["level"], "WARN");
    // The notice sits right before the first line that was held back.
    let notice_at = lines
        .iter()
        .position(|line| line["target"] == "ticketd_diagnostics")
        .unwrap();
    assert_eq!(messages[notice_at + 1], "kept warning");
}

#[test]
fn an_unwritable_folder_never_breaks_the_caller() {
    let dir = tempfile::tempdir().unwrap();
    // A file where the folder should be: it can be neither created nor written.
    let blocked = dir.path().join("logs");
    fs::write(&blocked, "not a folder").unwrap();

    let logs = open(&blocked.join("inside"));
    logs.with_default(|| {
        tracing::error!(target: "ticketd_core::sync", "falls back to stderr");
        logs.set_debug(true);
    });

    assert_eq!(fs::read_to_string(&blocked).unwrap(), "not a folder");
}

#[test]
fn a_folder_that_disappears_while_running_is_swallowed() {
    let dir = tempfile::tempdir().unwrap();
    let logs_dir = dir.path().join("logs");
    let logs = open(&logs_dir);
    logs.with_default(|| tracing::info!(target: "ticketd_core::sync", "first"));
    fs::remove_dir_all(&logs_dir).unwrap();

    // The open file is gone with the folder; lines have nowhere to go, and that is all.
    logs.with_default(|| tracing::error!(target: "ticketd_core::sync", "nowhere to go"));
}

#[test]
fn a_path_under_the_home_folder_is_logged_with_a_tilde() {
    let home = std::env::home_dir().unwrap();
    assert_eq!(
        ticketd_diagnostics::display_path(&home.join("Library/Application Support/ticketd")),
        "~/Library/Application Support/ticketd"
    );
    assert_eq!(
        ticketd_diagnostics::display_path(Path::new("/var/elsewhere/ticketd")),
        "/var/elsewhere/ticketd"
    );
}
