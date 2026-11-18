//! Where ticketd's logging is set up.
//!
//! Library crates emit `tracing` events and spans and never install a subscriber. The two
//! binaries do, through this crate: the CLI logs to stderr ([`init_cli`]), the desktop to a
//! daily file in the platform log folder ([`init_desktop`]). The event standard is in
//! `docs/agents/quality.md`; the decisions are in ADR 0017.
//!
//! Nothing here depends on Tauri, so everything can be tested with a temporary folder.

mod crash;
mod desktop;
mod errors;
mod export;
mod sink;
mod webview;

use std::path::Path;

use chrono::{SecondsFormat, Utc};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{EnvFilter, Registry, fmt};

pub use crash::{UncleanExit, install_panic_hook};
pub use desktop::{Config, DesktopLogs, LogLevel};
pub use errors::ErrorGroup;
pub use export::{Export, Facts, HarnessVersion, KnownValues, WorkspaceHealth, export_file_name};
pub use webview::{WebviewError, record_webview_error};

/// The environment variable that sets the filter, for the CLI and the desktop alike.
pub const FILTER_VARIABLE: &str = "TICKETD_LOG";

/// Installs the CLI's subscriber: readable lines on stderr, `warn` unless `TICKETD_LOG`
/// says otherwise. Never writes a file, and never touches stdout.
pub fn init_cli() {
    install_panic_hook();
    let requested = Requested::of(std::env::var(FILTER_VARIABLE).ok().as_deref());
    let subscriber = Registry::default()
        .with(filter(requested.filter(), "warn"))
        .with(
            fmt::layer()
                .compact()
                .without_time()
                .with_ansi(false)
                .with_writer(std::io::stderr),
        );
    let _ = tracing_log::LogTracer::init();
    let _ = tracing::subscriber::set_global_default(subscriber);
    requested.report_if_invalid();
}

/// Installs the desktop's subscriber and returns the handle that controls it. If `log_dir`
/// cannot be used, logging falls back to stderr and the app runs on.
pub fn init_desktop(log_dir: impl AsRef<Path>) -> DesktopLogs {
    let logs = DesktopLogs::open(
        log_dir,
        Config {
            stderr: cfg!(debug_assertions),
            filter_override: std::env::var(FILTER_VARIABLE).ok(),
            ..Config::default()
        },
    );
    logs.install();
    install_panic_hook();
    logs
}

/// The CLI's root span. When an agent runs the CLI inside a Chat or an Automation run, the
/// harness sets the ID in the environment; carrying it here links every line the command
/// logs back to that Chat or run. Missing or blank values are left off, and with neither
/// the span is disabled so a plain invocation's lines are unchanged.
///
/// The span is at `error` level so that it is still present under the default `warn` filter.
pub fn cli_span(chat_id: Option<&str>, automation_run_id: Option<&str>) -> tracing::Span {
    fn present(id: Option<&str>) -> Option<&str> {
        id.map(str::trim).filter(|id| !id.is_empty())
    }
    let (chat_id, automation_run_id) = (present(chat_id), present(automation_run_id));
    if chat_id.is_none() && automation_run_id.is_none() {
        return tracing::Span::none();
    }
    tracing::error_span!("cli", chat_id, automation_run_id)
}

/// A path as it may be logged: the home folder becomes `~`, so a log line never carries the
/// OS username.
pub fn display_path(path: &Path) -> String {
    if let Some(home) = std::env::home_dir()
        && let Ok(rest) = path.strip_prefix(&home)
    {
        return if rest.as_os_str().is_empty() {
            "~".into()
        } else {
            format!("~/{}", rest.display())
        };
    }
    path.display().to_string()
}

/// What `TICKETD_LOG` asked for.
enum Requested {
    /// Not set, or blank.
    Nothing,
    /// A filter that parses; it replaces the default.
    Filter(String),
    /// A value that is not a filter. It is ignored and reported, by its length only: the
    /// text is whatever the person typed.
    Invalid { length: usize },
}

impl Requested {
    fn of(spec: Option<&str>) -> Self {
        match spec.map(str::trim).filter(|spec| !spec.is_empty()) {
            None => Self::Nothing,
            Some(spec) if EnvFilter::try_new(spec).is_ok() => Self::Filter(spec.to_string()),
            Some(spec) => Self::Invalid {
                length: spec.chars().count(),
            },
        }
    }

    /// The filter to override the default with, if there is one.
    fn filter(&self) -> Option<&str> {
        match self {
            Self::Filter(spec) => Some(spec),
            _ => None,
        }
    }

    /// Says once that the value was ignored.
    fn report_if_invalid(&self) {
        if let Self::Invalid { length } = self {
            tracing::warn!(length, reason = "not a valid filter", "TICKETD_LOG ignored");
        }
    }
}

/// `spec` as a filter, or `default` when there is none.
fn filter(spec: Option<&str>, default: &str) -> EnvFilter {
    spec.and_then(|spec| EnvFilter::try_new(spec).ok())
        .unwrap_or_else(|| EnvFilter::new(default))
}

/// RFC 3339 in UTC with millisecond precision: `2026-11-18T09:30:00.123Z`.
struct Timestamp;

impl FormatTime for Timestamp {
    fn format_time(&self, w: &mut Writer<'_>) -> std::fmt::Result {
        write!(
            w,
            "{}",
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        )
    }
}
