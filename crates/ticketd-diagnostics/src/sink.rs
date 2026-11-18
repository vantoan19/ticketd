//! The desktop's log folder: one file per UTC day, written a whole line at a time.
//!
//! Every line goes straight to the file under a mutex. There is no background worker and no
//! buffer to lose: the desktop ends with `std::process::exit`, and a panic must not take the
//! last lines with it. Nothing here may fail the caller: a write that cannot happen is
//! dropped, and a folder that cannot be used makes [`Sink::open`] say so once at startup.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use chrono::{NaiveDate, SecondsFormat, Utc};
use tracing::{Level, Metadata};
use tracing_subscriber::fmt::MakeWriter;

/// How long and how much the folder keeps, and when one day's file stops taking routine lines.
#[derive(Debug, Clone)]
pub(crate) struct Limits {
    pub(crate) max_age: Duration,
    pub(crate) max_total_bytes: u64,
    pub(crate) max_file_bytes: u64,
}

pub(crate) struct Sink {
    dir: PathBuf,
    max_file_bytes: u64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    day: Option<NaiveDate>,
    file: Option<File>,
    bytes: u64,
    capped: bool,
}

impl Sink {
    /// Prunes the folder, then checks that today's file can be opened. `None` means the
    /// folder cannot hold logs and the caller should log somewhere else.
    pub(crate) fn open(dir: &Path, limits: &Limits) -> Option<Arc<Self>> {
        fs::create_dir_all(dir).ok()?;
        prune(dir, limits);
        let sink = Arc::new(Self {
            dir: dir.to_path_buf(),
            max_file_bytes: limits.max_file_bytes,
            state: Mutex::default(),
        });
        {
            let mut state = sink.state.lock().unwrap_or_else(PoisonError::into_inner);
            sink.ensure_open(&mut state, Utc::now().date_naive()).ok()?;
        }
        Some(sink)
    }

    fn ensure_open(&self, state: &mut State, today: NaiveDate) -> io::Result<()> {
        if state.day == Some(today) && state.file.is_some() {
            return Ok(());
        }
        // The folder is made again if it went away; a day change starts a new file.
        fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(format!("ticketd.{today}.log"));
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        state.bytes = file.metadata().map_or(0, |meta| meta.len());
        state.capped = false;
        state.file = Some(file);
        state.day = Some(today);
        Ok(())
    }

    fn write_line(&self, level: Level, line: &[u8]) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if self
            .ensure_open(&mut state, Utc::now().date_naive())
            .is_err()
        {
            state.file = None;
            return;
        }
        if state.bytes >= self.max_file_bytes && !state.capped {
            state.capped = true;
            let notice = serde_json::json!({
                "timestamp": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                "level": "WARN",
                "message": "log file cap reached; only warnings and errors are written",
                "target": "ticketd_diagnostics",
                "max_file_bytes": self.max_file_bytes,
            });
            Self::append(&mut state, format!("{notice}\n").as_bytes());
        }
        // `Level` orders by verbosity: ERROR is the smallest.
        if state.capped && level > Level::WARN {
            return;
        }
        Self::append(&mut state, line);
    }

    fn append(state: &mut State, bytes: &[u8]) {
        let Some(file) = state.file.as_mut() else {
            return;
        };
        match file.write_all(bytes) {
            Ok(()) => state.bytes += bytes.len() as u64,
            // A failed write is dropped; the next line opens the file again.
            Err(_) => state.file = None,
        }
    }
}

/// What the subscriber asks for a writer per event.
#[derive(Clone)]
pub(crate) struct SinkWriter(pub(crate) Arc<Sink>);

impl<'a> MakeWriter<'a> for SinkWriter {
    type Writer = Line<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        // Without the event's level, treat the line as one that must be kept.
        self.line(Level::ERROR)
    }

    fn make_writer_for(&'a self, meta: &Metadata<'_>) -> Self::Writer {
        self.line(*meta.level())
    }
}

impl SinkWriter {
    fn line(&self, level: Level) -> Line<'_> {
        Line {
            sink: &self.0,
            level,
            bytes: Vec::new(),
        }
    }
}

/// One formatted event, collected and written to the file in a single call on drop.
pub(crate) struct Line<'a> {
    sink: &'a Sink,
    level: Level,
    bytes: Vec<u8>,
}

impl Write for Line<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Line<'_> {
    fn drop(&mut self) {
        if !self.bytes.is_empty() {
            self.sink.write_line(self.level, &self.bytes);
        }
    }
}

/// Deletes ticketd's own log files older than the age limit by modified time, then the
/// oldest ones until the rest fit the size limit. Our code does this at startup, because
/// `tracing-appender` prunes only when the day changes inside a running process, and a
/// desktop that is quit every evening would never get there.
fn prune(dir: &Path, limits: &Limits) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut kept = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("ticketd.") && name.ends_with(".log"));
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !is_log || !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(now);
        let age = now.duration_since(modified).unwrap_or_default();
        if age > limits.max_age {
            let _ = fs::remove_file(&path);
        } else {
            kept.push((modified, meta.len(), path));
        }
    }
    kept.sort();
    let mut total: u64 = kept.iter().map(|(_, size, _)| size).sum();
    for (_, size, path) in kept {
        if total <= limits.max_total_bytes {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total -= size;
        }
    }
}
