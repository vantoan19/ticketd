//! The diagnostics export: a small `.zip` a person can attach to a public GitHub issue.
//!
//! The bundle is built from an allowlist, not scrubbed: every log line is rebuilt from the
//! fields we know are safe, so a field added later is left out until someone decides it
//! belongs. Literal values we know about (the home folder, the OS username, the Workspace
//! path, the Drive account's email) are then replaced wherever they still appear in text we
//! kept. Identifiers stay as they are.
//!
//! The bundle is `.zip` and its logs `.log` because GitHub accepts those and not `.jsonl`
//! or `.tar`, and it stays under 5 MB, well below GitHub's 25 MB attachment limit.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::{self, Cursor, Write};
use std::path::{Path, PathBuf};

use chrono::{Days, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use zip::CompressionMethod;
use zip::write::{SimpleFileOptions, ZipWriter};

use crate::errors::{ErrorGroup, day_files, json_lines};

/// Fields that identify something without describing it. Kept as they are.
const ID_FIELDS: [&str; 5] = [
    "ticket_ref",
    "chat_id",
    "automation_run_id",
    "source_id",
    "request_id",
];

/// The other fields a line or span may carry into the bundle: the ones our code emits that
/// hold no content (error kinds, positions, sizes, durations). Anything else is dropped,
/// and a field is added here on purpose when code starts emitting it.
const SAFE_FIELDS: [&str; 15] = [
    "error_kind",
    // A panic: where and on which thread, and the message only when the hook judged it a
    // literal. The previous session's start time on an unexpected end.
    "location",
    "thread",
    "panic_message",
    "previous_started_at",
    // An uncaught WebView error: the view, how often, and its stack frames. Its message
    // (`error`) stays out, like every other error text.
    "route",
    "repeat_count",
    "frames",
    // Which Harness wrote to stderr (the line itself is dropped) and which desktop
    // command a span is for.
    "harness",
    "command",
    // The size of an export, the Chat action that failed and the app version at start.
    "bytes",
    "action",
    "version",
    "time.busy",
    "time.idle",
];

/// What a line keeps at the top level: when, how serious, where from and what happened.
const LINE_FIELDS: [&str; 4] = ["timestamp", "level", "target", "message"];

/// How many days of logs go into the bundle.
const LOG_DAYS: u64 = 3;

/// What the desktop knows that the logs do not: the environment the app ran in and the state
/// of the Workspace. The desktop gathers it; this crate only formats and redacts it.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub app_version: String,
    pub commit: String,
    /// `debug` or `release`.
    pub build: String,
    pub os: String,
    pub arch: String,
    pub webview: String,
    pub sync_enabled: bool,
    pub harnesses: Vec<HarnessVersion>,
    pub workspace: WorkspaceHealth,
    pub known: KnownValues,
}

/// A Harness and the version it reports, if it could be asked.
#[derive(Debug, Clone, Default)]
pub struct HarnessVersion {
    pub name: String,
    pub version: Option<String>,
}

/// Whether the Workspace is sound, without any of what it holds.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkspaceHealth {
    pub format_version: Option<u32>,
    /// What SQLite's `quick_check` said, or why it could not be run.
    pub quick_check: String,
    pub file_bytes: u64,
    pub wal_bytes: u64,
    pub row_counts: BTreeMap<String, u64>,
}

/// Literal values replaced in everything the bundle carries as text.
#[derive(Debug, Clone, Default)]
pub struct KnownValues {
    pub home: Option<String>,
    pub os_username: Option<String>,
    pub workspace_path: Option<String>,
    pub drive_email: Option<String>,
}

impl KnownValues {
    /// The values for this machine and session: the home folder and OS username come from
    /// the environment, the rest from the caller.
    pub fn from_environment(workspace_path: Option<&Path>, drive_email: Option<&str>) -> Self {
        Self {
            home: std::env::home_dir().map(|home| home.display().to_string()),
            os_username: ["USER", "USERNAME", "LOGNAME"]
                .iter()
                .find_map(|name| std::env::var(name).ok()),
            workspace_path: workspace_path.map(|path| path.display().to_string()),
            drive_email: drive_email.map(str::to_string),
        }
    }
}

/// What an export wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Export {
    pub path: PathBuf,
    pub bytes: u64,
}

/// The name a bundle gets today: `ticketd-diagnostics-YYYY-MM-DD.zip`.
pub fn export_file_name() -> String {
    format!("ticketd-diagnostics-{}.zip", Utc::now().format("%Y-%m-%d"))
}

/// Replaces known values. The longest, most specific value goes first, so a Workspace path
/// under the home folder reads `<workspace>` rather than `~/…`.
struct Redactor {
    replacements: Vec<(String, &'static str)>,
    username: Option<String>,
}

impl Redactor {
    fn new(known: &KnownValues) -> Self {
        let mut replacements = Vec::new();
        for (value, with) in [
            (&known.workspace_path, "<workspace>"),
            (&known.home, "~"),
            (&known.drive_email, "<drive-account>"),
        ] {
            if let Some(value) = value.as_deref().map(str::trim_end)
                && !value.is_empty()
            {
                replacements.push((value.trim_end_matches(['/', '\\']).to_string(), with));
            }
        }
        replacements.retain(|(value, _)| !value.is_empty());
        replacements.sort_by_key(|(value, _)| std::cmp::Reverse(value.len()));
        let username = known
            .os_username
            .clone()
            .filter(|name| !name.trim().is_empty());
        Self {
            replacements,
            username,
        }
    }

    fn text(&self, text: &str) -> String {
        let mut text = text.to_string();
        for (value, with) in &self.replacements {
            text = text.replace(value.as_str(), with);
        }
        if let Some(name) = &self.username {
            text = if name.chars().count() >= 3 {
                text.replace(name.as_str(), "<os-user>")
            } else {
                // A very short name would match inside ordinary words; only a path
                // component is certainly the name.
                text.replace(&format!("/{name}/"), "/<os-user>/")
                    .replace(&format!("\\{name}\\"), "\\<os-user>\\")
            };
        }
        text
    }

    fn value(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.text(text),
            Value::Array(items) => items.iter_mut().for_each(|item| self.value(item)),
            Value::Object(fields) => fields.values_mut().for_each(|item| self.value(item)),
            _ => {}
        }
    }

    /// One log line rebuilt from the allowlist, or `None` if nothing usable is left.
    fn line(&self, line: &Map<String, Value>) -> Option<String> {
        let mut kept = Map::new();
        for key in LINE_FIELDS {
            self.keep(&mut kept, line, key);
        }
        // A line without a time or a message is not a line we wrote.
        if !kept.contains_key("timestamp") || !kept.contains_key("message") {
            return None;
        }
        for key in ID_FIELDS.iter().chain(&SAFE_FIELDS) {
            self.keep(&mut kept, line, key);
        }
        if let Some(Value::Array(spans)) = line.get("spans") {
            let spans: Vec<_> = spans
                .iter()
                .filter_map(Value::as_object)
                .map(|span| self.span(span))
                .collect();
            if !spans.is_empty() {
                kept.insert("spans".into(), Value::Array(spans));
            }
        }
        if let Some(Value::Object(span)) = line.get("span") {
            kept.insert("span".into(), self.span(span));
        }
        serde_json::to_string(&kept).ok()
    }

    /// A span rebuilt from its name and the allowlisted fields.
    fn span(&self, span: &Map<String, Value>) -> Value {
        let mut kept = Map::new();
        for key in ["name"].iter().chain(&ID_FIELDS).chain(&SAFE_FIELDS) {
            self.keep(&mut kept, span, key);
        }
        Value::Object(kept)
    }

    fn keep(&self, into: &mut Map<String, Value>, from: &Map<String, Value>, key: &str) {
        let Some(value) = from.get(key) else {
            return;
        };
        let value = match value {
            // IDs are opaque and kept whole, even where they would match a known value.
            Value::String(text) if ID_FIELDS.contains(&key) => Value::String(text.clone()),
            Value::String(text) => Value::String(self.text(text)),
            Value::Number(_) | Value::Bool(_) => value.clone(),
            // Nested values are not part of any field we allow.
            _ => return,
        };
        into.insert(key.to_string(), value);
    }
}

fn summary(facts: &Facts, level: &str, redactor: &Redactor) -> String {
    let mut text = String::new();
    // Writing to a String cannot fail.
    let _ = writeln!(
        text,
        "ticketd {} (commit {}, {} build)",
        facts.app_version, facts.commit, facts.build
    );
    let _ = writeln!(text, "OS: {} {}", facts.os, facts.arch);
    let _ = writeln!(text, "WebView: {}", facts.webview);
    let _ = writeln!(text, "Log level: {level}");
    let _ = writeln!(
        text,
        "Sync: {}",
        if facts.sync_enabled { "on" } else { "off" }
    );
    let _ = writeln!(text, "Harnesses:");
    if facts.harnesses.is_empty() {
        let _ = writeln!(text, "  none found");
    }
    for harness in &facts.harnesses {
        match &harness.version {
            Some(version) => {
                let _ = writeln!(text, "  {} {version}", harness.name);
            }
            None => {
                let _ = writeln!(text, "  {} (version unknown)", harness.name);
            }
        }
    }
    redactor.text(&text)
}

/// The summary as it goes to the clipboard and into the bundle.
pub(crate) fn summary_text(facts: &Facts, level: &str) -> String {
    summary(facts, level, &Redactor::new(&facts.known))
}

/// Builds the bundle for the log folder `dir` and writes it to `destination`: a folder, which
/// gets the dated name, or the path of the file itself.
pub(crate) fn write(
    dir: &Path,
    destination: &Path,
    facts: &Facts,
    level: &str,
    errors: &[ErrorGroup],
    max_bytes: u64,
) -> io::Result<Export> {
    let redactor = Redactor::new(&facts.known);
    let fixed = [
        ("summary.txt", summary(facts, level, &redactor)),
        ("workspace.json", json(&facts.workspace, &redactor)?),
        ("errors.json", json(&errors, &redactor)?),
    ];
    let logs = log_texts(dir, &redactor);

    // Compression decides the size, so cut by trial: build, and if it is too big, keep
    // fewer of the newest lines in proportion to the overshoot.
    let total: usize = logs
        .iter()
        .flat_map(|(_, lines)| lines)
        .map(|line| line.len() + 1)
        .sum();
    let mut budget = total;
    let bytes = loop {
        let bytes = bundle(&fixed, &trim(&logs, budget))?;
        let size = bytes.len() as u64;
        if size <= max_bytes || budget == 0 {
            break bytes;
        }
        // Aim a little under the limit; always make progress.
        let scaled = (budget as f64 * max_bytes as f64 / size as f64 * 0.9) as usize;
        budget = scaled.min(budget - budget / 10 - 1);
    };

    let path = if destination.is_dir() {
        destination.join(export_file_name())
    } else {
        destination.to_path_buf()
    };
    std::fs::write(&path, &bytes)?;
    Ok(Export {
        path,
        bytes: bytes.len() as u64,
    })
}

fn json(value: &impl Serialize, redactor: &Redactor) -> io::Result<String> {
    let mut value = serde_json::to_value(value).map_err(io::Error::other)?;
    redactor.value(&mut value);
    serde_json::to_string_pretty(&value).map_err(io::Error::other)
}

/// The last three days of redacted logs, newest day first: `(bundle name, lines)`.
fn log_texts(dir: &Path, redactor: &Redactor) -> Vec<(String, Vec<String>)> {
    let today = Utc::now().date_naive();
    let oldest: NaiveDate = today
        .checked_sub_days(Days::new(LOG_DAYS - 1))
        .unwrap_or(today);
    let mut files = day_files(dir);
    files.retain(|file| file.day >= oldest);
    files.reverse();
    files
        .into_iter()
        .map(|file| {
            let lines = json_lines(&file.path)
                .iter()
                .filter_map(|line| redactor.line(line))
                .collect();
            (format!("logs/ticketd.{}.log", file.day), lines)
        })
        .collect()
}

/// The newest lines that fit in `budget` bytes, walking from the newest day back, each file
/// keeping its lines in time order.
fn trim(logs: &[(String, Vec<String>)], budget: usize) -> Vec<(String, String)> {
    let mut remaining = budget;
    logs.iter()
        .map(|(name, lines)| {
            let mut kept = Vec::new();
            for line in lines.iter().rev() {
                // Each line also costs its newline.
                if line.len() + 1 > remaining {
                    remaining = 0;
                    break;
                }
                remaining -= line.len() + 1;
                kept.push(line.as_str());
            }
            kept.reverse();
            let mut text = kept.join("\n");
            if !text.is_empty() {
                text.push('\n');
            }
            (name.clone(), text)
        })
        .filter(|(_, text)| !text.is_empty())
        .collect()
}

fn bundle(fixed: &[(&str, String)], logs: &[(String, String)]) -> io::Result<Vec<u8>> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let files = fixed
        .iter()
        .map(|(name, text)| (*name, text))
        .chain(logs.iter().map(|(name, text)| (name.as_str(), text)));
    for (name, text) in files {
        zip.start_file(name, options).map_err(io::Error::other)?;
        zip.write_all(text.as_bytes())?;
    }
    Ok(zip.finish().map_err(io::Error::other)?.into_inner())
}
