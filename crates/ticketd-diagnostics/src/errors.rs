//! Recent errors: the warnings and errors in the log folder, grouped by kind.
//!
//! Built from the files rather than kept in memory, so it covers earlier runs too, and a
//! line another part of the app writes later (such as the notice that the previous session
//! ended unexpectedly) shows up without being registered anywhere.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use serde::Serialize;

/// One kind of warning or error: everything the log holds for one target and error kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ErrorGroup {
    /// The module that logged it, such as `ticketd_desktop_lib::sync_scheduler`.
    pub target: String,
    /// The line's `error_kind`, or its message when it has none.
    pub kind: String,
    /// `ERROR` if any line in the group is an error, otherwise `WARN`.
    pub level: String,
    pub count: u64,
    /// RFC 3339 timestamps, UTC, as the lines carry them.
    pub first_seen: String,
    pub last_seen: String,
}

/// A daily log file in the folder.
pub(crate) struct DayFile {
    pub(crate) day: NaiveDate,
    pub(crate) path: PathBuf,
}

/// The folder's `ticketd.YYYY-MM-DD.log` files, oldest day first. Anything else in the
/// folder is not ours to read.
pub(crate) fn day_files(dir: &Path) -> Vec<DayFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let day = name.strip_prefix("ticketd.")?.strip_suffix(".log")?;
            let day = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
            Some(DayFile {
                day,
                path: entry.path(),
            })
        })
        .collect();
    files.sort_by_key(|file| file.day);
    files
}

/// The lines of a file that parse as JSON objects. A line cut short by a crash or a failed
/// write is skipped.
pub(crate) fn json_lines(path: &Path) -> Vec<serde_json::Map<String, serde_json::Value>> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| match serde_json::from_str(line) {
            Ok(serde_json::Value::Object(object)) => Some(object),
            _ => None,
        })
        .collect()
}

pub(crate) fn recent_errors(dir: &Path) -> Vec<ErrorGroup> {
    let mut groups: HashMap<(String, String), ErrorGroup> = HashMap::new();
    for file in day_files(dir) {
        for line in json_lines(&file.path) {
            let text = |key: &str| line.get(key).and_then(serde_json::Value::as_str);
            let level = match text("level") {
                Some(level @ ("WARN" | "ERROR")) => level,
                _ => continue,
            };
            let (Some(target), Some(timestamp)) = (text("target"), text("timestamp")) else {
                continue;
            };
            let Some(kind) = text("error_kind").or_else(|| text("message")) else {
                continue;
            };
            let group = groups
                .entry((target.to_string(), kind.to_string()))
                .or_insert_with(|| ErrorGroup {
                    target: target.to_string(),
                    kind: kind.to_string(),
                    level: level.to_string(),
                    count: 0,
                    first_seen: timestamp.to_string(),
                    last_seen: timestamp.to_string(),
                });
            group.count += 1;
            if level == "ERROR" {
                group.level = "ERROR".to_string();
            }
            // Timestamps are fixed-width RFC 3339 in UTC, so text order is time order.
            if timestamp < group.first_seen.as_str() {
                group.first_seen = timestamp.to_string();
            }
            if timestamp > group.last_seen.as_str() {
                group.last_seen = timestamp.to_string();
            }
        }
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by(|a, b| {
        b.last_seen
            .cmp(&a.last_seen)
            .then_with(|| a.target.cmp(&b.target))
            .then_with(|| a.kind.cmp(&b.kind))
    });
    groups
}
