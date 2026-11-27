//! The desktop's subscriber and the handle that controls it.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use tracing::Dispatch;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{EnvFilter, Registry, fmt, reload};

use crate::crash::{SessionMarker, UncleanExit};
use crate::errors::{self, ErrorGroup};
use crate::export::{self, Export, Facts};
use crate::report::ReportMarker;
use crate::sink::{Limits, Sink, SinkWriter};
use crate::{Requested, Timestamp, filter};

/// The level while Debug logging is off: our crates at `info`, everything else at `warn`.
/// A target is matched by prefix, so `ticketd` covers `ticketd_core`, `ticketd_desktop_lib`
/// and the rest.
const DEFAULT_FILTER: &str = "warn,ticketd=info";
const DEBUG_FILTER: &str = "warn,ticketd=debug";

/// How a [`DesktopLogs`] is set up. [`init_desktop`](crate::init_desktop) uses the defaults,
/// with the environment's override and stderr output in dev builds.
#[derive(Debug, Clone)]
pub struct Config {
    /// Log files last modified longer ago than this are deleted at startup.
    pub max_age: Duration,
    /// The oldest files are deleted at startup until the folder is under this size.
    pub max_total_bytes: u64,
    /// After this size a day's file takes only warnings and errors.
    pub max_file_bytes: u64,
    /// Also write readable lines to stderr, as dev builds do.
    pub stderr: bool,
    /// A filter that replaces the default and cannot be changed by [`DesktopLogs::set_debug`]:
    /// the value of `TICKETD_LOG`.
    pub filter_override: Option<String>,
    /// The diagnostics export is cut to stay under this size.
    pub max_export_bytes: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
            max_total_bytes: 50 * 1024 * 1024,
            max_file_bytes: 20 * 1024 * 1024,
            stderr: false,
            filter_override: None,
            max_export_bytes: 5 * 1024 * 1024,
        }
    }
}

/// The level the Diagnostics page shows, and whether a report can turn detailed logging on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogLevel {
    /// `info`, `debug` while Debug logging is on, or the `TICKETD_LOG` filter itself.
    pub level: String,
    /// Debug logging is on. Always false while `TICKETD_LOG` decides the level.
    pub debug: bool,
    /// The `TICKETD_LOG` filter that overrides the switch, if one was set at launch.
    pub env_override: Option<String>,
    /// When the open report started, as an RFC 3339 time, while a report is open: detailed
    /// logging has been on since then and stays on, across a restart, until the report is
    /// saved or cancelled.
    pub report_started_at: Option<String>,
}

/// The desktop's logs: JSON lines in a daily file, with the level changeable at runtime.
///
/// Keep it alive for the whole run; the desktop holds it in managed state and drops it on
/// `RunEvent::Exit`.
pub struct DesktopLogs {
    dispatch: Dispatch,
    filter: reload::Handle<EnvFilter, Registry>,
    pinned: bool,
    unclean_exit: Option<UncleanExit>,
    /// When this handle was opened, in the lines' timestamp format.
    opened_at: String,
    /// Removes the session marker when the handle is dropped.
    _session: Option<SessionMarker>,
    debug: AtomicBool,
    report: Mutex<Option<ReportMarker>>,
    filter_override: Option<String>,
    max_export_bytes: u64,
    dir: PathBuf,
}

impl DesktopLogs {
    /// Prunes `dir`, opens today's file and builds the subscriber, without installing it.
    ///
    /// A folder that cannot hold logs falls back to readable lines on stderr. Nothing here
    /// returns an error: logging must never be the reason the app does not start.
    pub fn open(dir: impl AsRef<Path>, config: Config) -> Self {
        let opened_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let limits = Limits {
            max_age: config.max_age,
            max_total_bytes: config.max_total_bytes,
            max_file_bytes: config.max_file_bytes,
        };
        let sink = Sink::open(dir.as_ref(), &limits);
        let (session, unclean_exit) = match &sink {
            Some(_) => {
                let (marker, left_behind) = SessionMarker::start(dir.as_ref());
                (Some(marker), left_behind)
            }
            None => (None, None),
        };
        // A value that is not a filter is no override: the default applies and the switch
        // works, and one notice says so.
        let requested = Requested::of(config.filter_override.as_deref());
        let override_spec = requested.filter().map(str::to_string);
        let pinned = override_spec.is_some();
        let (filter_layer, filter) =
            reload::Layer::new(filter(override_spec.as_deref(), DEFAULT_FILTER));
        let file = sink.map(|sink| {
            fmt::layer()
                .json()
                .flatten_event(true)
                .with_span_list(true)
                // A close line is outside its own span, so only `span` says which one closed.
                .with_current_span(true)
                .with_span_events(FmtSpan::CLOSE)
                .with_timer(Timestamp)
                .with_ansi(false)
                .with_writer(SinkWriter(sink))
        });
        let readable = (config.stderr || file.is_none()).then(|| {
            fmt::layer()
                .compact()
                .with_timer(Timestamp)
                .with_ansi(false)
                .with_writer(io::stderr)
        });
        let subscriber = Registry::default()
            .with(filter_layer)
            .with(file)
            .with(readable);
        let logs = Self {
            dispatch: Dispatch::new(subscriber),
            filter,
            pinned,
            unclean_exit,
            opened_at,
            _session: session,
            debug: AtomicBool::new(false),
            report: Mutex::new(None),
            filter_override: override_spec,
            max_export_bytes: config.max_export_bytes,
            dir: dir.as_ref().to_path_buf(),
        };
        // A report left open by the last run goes on: detailed logging resumes before the
        // first event of this run, so a problem at startup is caught. A `TICKETD_LOG` filter
        // still decides the level (`set_debug` leaves it alone), but the report stays open,
        // so it can be saved or cancelled and does not come back at a later launch.
        if let Some(marker) = ReportMarker::read(dir.as_ref()) {
            logs.set_debug(true);
            logs.set_report(Some(marker));
        }
        logs.with_default(|| requested.report_if_invalid());
        if let Some(exit) = &logs.unclean_exit {
            let started_at = exit
                .started_at
                .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true));
            logs.with_default(|| {
                tracing::warn!(
                    previous_started_at = started_at.as_deref(),
                    "previous session ended unexpectedly"
                );
            });
        }
        logs
    }

    /// Whether the session before this one ended without a clean shutdown, and when it
    /// started. The Diagnostics page shows it among the recent errors.
    pub fn previous_session_ended_unexpectedly(&self) -> Option<&UncleanExit> {
        self.unclean_exit.as_ref()
    }

    /// Makes this the process's subscriber, and routes `log` records from dependencies
    /// through it. Returns false when a subscriber is already installed.
    pub fn install(&self) -> bool {
        let _ = tracing_log::LogTracer::init();
        tracing::dispatcher::set_global_default(self.dispatch.clone()).is_ok()
    }

    /// Runs `f` with this handle's subscriber as the current one on this thread. For tests,
    /// which cannot share the process-wide subscriber.
    pub fn with_default<T>(&self, f: impl FnOnce() -> T) -> T {
        tracing::dispatcher::with_default(&self.dispatch, f)
    }

    /// The warnings and errors in the log folder, grouped by target and error kind, most
    /// recently seen first. This includes earlier runs that are still on disk.
    pub fn recent_errors(&self) -> Vec<ErrorGroup> {
        errors::recent_errors(
            &self.dir,
            self.unclean_exit.as_ref().map(|_| self.opened_at.as_str()),
        )
    }

    /// The folder the log files are written to.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The current level, for the Diagnostics page.
    pub fn log_level(&self) -> LogLevel {
        let debug = self.debug.load(Ordering::Relaxed);
        LogLevel {
            level: self
                .filter_override
                .clone()
                .unwrap_or_else(|| if debug { "debug" } else { "info" }.to_string()),
            debug,
            env_override: self.filter_override.clone(),
            report_started_at: self.report_started_at(),
        }
    }

    fn report_started_at(&self) -> Option<String> {
        self.report
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|marker| marker.started_at().to_string())
    }

    fn set_report(&self, marker: Option<ReportMarker>) {
        *self.report.lock().unwrap_or_else(PoisonError::into_inner) = marker;
    }

    /// Opens a report: detailed logging goes on and stays on, across a restart, until
    /// [`end_report`](Self::end_report). A report that is already open keeps its start.
    /// Does nothing while `TICKETD_LOG` overrides the level.
    pub fn start_report(&self) {
        if self.pinned || self.report_started_at().is_some() {
            return;
        }
        self.set_debug(true);
        self.set_report(Some(ReportMarker::write(&self.dir)));
    }

    /// Closes the open report, once it is saved or cancelled: detailed logging goes off and
    /// the next launch starts at the default level.
    pub fn end_report(&self) {
        if let Some(marker) = self
            .report
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            marker.remove();
        }
        self.set_debug(false);
    }

    /// The level as the summary states it: `info`, `debug` while Debug logging is on, or the
    /// `TICKETD_LOG` filter that overrides both.
    fn level(&self) -> String {
        match &self.filter_override {
            Some(spec) => format!("{spec} (from TICKETD_LOG)"),
            None if self.debug.load(Ordering::Relaxed) => "debug".to_string(),
            None => "info".to_string(),
        }
    }

    /// A short, redacted description of the app and its environment: `summary.txt` of the
    /// export, for pasting into an issue.
    pub fn summary(&self, facts: &Facts) -> String {
        export::summary_text(facts, &self.level())
    }

    /// Writes the diagnostics bundle to `destination`, a folder (the bundle gets the name
    /// [`export_file_name`](crate::export_file_name) there) or the path of the file itself.
    /// The bundle stays under the size limit and holds nothing but allowlisted fields; see
    /// ADR 0017.
    pub fn export(&self, destination: impl AsRef<Path>, facts: &Facts) -> io::Result<Export> {
        export::write(
            &self.dir,
            destination.as_ref(),
            facts,
            &self.level(),
            &self.recent_errors(),
            self.max_export_bytes,
        )
    }

    /// Turns Debug logging on or off, taking effect for the next event. Does nothing while
    /// `TICKETD_LOG` overrides the level.
    pub fn set_debug(&self, enabled: bool) {
        if self.pinned {
            return;
        }
        self.debug.store(enabled, Ordering::Relaxed);
        let spec = if enabled {
            DEBUG_FILTER
        } else {
            DEFAULT_FILTER
        };
        // The reload only fails if the subscriber is gone, and then nothing is logged.
        let _ = self.filter.reload(EnvFilter::new(spec));
    }
}
