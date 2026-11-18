//! Crash signals: the panic hook, and the session marker that survives what the hook cannot
//! see (a WebView or native crash, a kill, a power loss).

use std::fs;
use std::panic::{self, PanicHookInfo};
use std::path::{Path, PathBuf};
use std::sync::Once;

use chrono::{DateTime, SecondsFormat, Utc};

const MARKER_FILE: &str = "session.lock";

/// A previous desktop session that never shut down cleanly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UncleanExit {
    /// When that session started, if its marker could still be read.
    pub started_at: Option<DateTime<Utc>>,
}

/// Logs every panic at `error` with its location and thread, then calls the hook that was
/// installed before. The message is logged only when the payload is a `&'static str`: a
/// formatted message can carry a Ticket's text. Installing twice does nothing.
pub fn install_panic_hook() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            log_panic(info);
            previous(info);
        }));
    });
}

fn log_panic(info: &PanicHookInfo<'_>) {
    let location = info
        .location()
        .map(|at| format!("{}:{}:{}", at.file(), at.line(), at.column()));
    let location = location.as_deref().unwrap_or("<unknown>");
    let thread = std::thread::current();
    let thread = thread.name().unwrap_or("<unnamed>");
    match info.payload().downcast_ref::<&'static str>() {
        Some(message) => {
            tracing::error!(location, thread, panic_message = *message, "panic");
        }
        None => tracing::error!(location, thread, "panic"),
    }
}

/// The `session.lock` file in the log folder: written when a desktop session starts and
/// removed when it ends cleanly.
pub(crate) struct SessionMarker {
    path: PathBuf,
}

impl SessionMarker {
    /// Reads any marker left by an earlier session, then writes this session's. A folder
    /// that cannot be written just means no marker.
    pub(crate) fn start(dir: &Path) -> (Self, Option<UncleanExit>) {
        let path = dir.join(MARKER_FILE);
        let left_behind = fs::read(&path).ok().map(|bytes| UncleanExit {
            started_at: std::str::from_utf8(&bytes)
                .ok()
                .and_then(|text| DateTime::parse_from_rfc3339(text.trim()).ok())
                .map(|time| time.with_timezone(&Utc)),
        });
        let _ = fs::write(
            &path,
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        );
        (Self { path }, left_behind)
    }
}

impl Drop for SessionMarker {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
