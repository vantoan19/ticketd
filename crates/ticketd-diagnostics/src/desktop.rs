//! The desktop's subscriber and the handle that controls it.

use std::io;
use std::path::Path;
use std::time::Duration;

use chrono::SecondsFormat;
use tracing::Dispatch;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{EnvFilter, Registry, fmt, reload};

use crate::crash::{SessionMarker, UncleanExit};
use crate::sink::{Limits, Sink, SinkWriter};
use crate::{Timestamp, filter};

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
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
            max_total_bytes: 50 * 1024 * 1024,
            max_file_bytes: 20 * 1024 * 1024,
            stderr: false,
            filter_override: None,
        }
    }
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
    /// Removes the session marker when the handle is dropped.
    _session: Option<SessionMarker>,
}

impl DesktopLogs {
    /// Prunes `dir`, opens today's file and builds the subscriber, without installing it.
    ///
    /// A folder that cannot hold logs falls back to readable lines on stderr. Nothing here
    /// returns an error: logging must never be the reason the app does not start.
    pub fn open(dir: impl AsRef<Path>, config: Config) -> Self {
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
        let pinned = config.filter_override.is_some();
        let (filter_layer, filter) =
            reload::Layer::new(filter(config.filter_override.as_deref(), DEFAULT_FILTER));
        let file = sink.map(|sink| {
            fmt::layer()
                .json()
                .flatten_event(true)
                .with_span_list(true)
                .with_current_span(false)
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
            _session: session,
        };
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

    /// Turns Debug logging on or off, taking effect for the next event. Does nothing while
    /// `TICKETD_LOG` overrides the level.
    pub fn set_debug(&self, enabled: bool) {
        if self.pinned {
            return;
        }
        let spec = if enabled {
            DEBUG_FILTER
        } else {
            DEFAULT_FILTER
        };
        // The reload only fails if the subscriber is gone, and then nothing is logged.
        let _ = self.filter.reload(EnvFilter::new(spec));
    }
}
