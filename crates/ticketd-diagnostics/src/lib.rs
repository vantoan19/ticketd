//! Where ticketd's logging is set up.
//!
//! Library crates emit `tracing` events and spans and never install a subscriber. The two
//! binaries do, through this crate: the CLI logs to stderr ([`init_cli`]), the desktop to a
//! daily file in the platform log folder ([`init_desktop`]). The event standard is in
//! `docs/agents/quality.md`; the decisions are in ADR 0017.
//!
//! Nothing here depends on Tauri, so everything can be tested with a temporary folder.

mod desktop;
mod errors;
mod export;
mod sink;

use std::path::Path;

use chrono::{SecondsFormat, Utc};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{EnvFilter, Registry, fmt};

pub use desktop::{Config, DesktopLogs};
pub use errors::ErrorGroup;
pub use export::{Export, Facts, HarnessVersion, KnownValues, WorkspaceHealth, export_file_name};

/// The environment variable that sets the filter, for the CLI and the desktop alike.
pub const FILTER_VARIABLE: &str = "TICKETD_LOG";

/// Installs the CLI's subscriber: readable lines on stderr, `warn` unless `TICKETD_LOG`
/// says otherwise. Never writes a file, and never touches stdout.
pub fn init_cli() {
    let filter = filter(std::env::var(FILTER_VARIABLE).ok().as_deref(), "warn");
    let subscriber = Registry::default().with(filter).with(
        fmt::layer()
            .compact()
            .without_time()
            .with_ansi(false)
            .with_writer(std::io::stderr),
    );
    let _ = tracing_log::LogTracer::init();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

/// Installs the desktop's subscriber and returns the handle that controls it. If `log_dir`
/// cannot be used, logging falls back to stderr and the app runs on.
pub fn init_desktop(log_dir: impl AsRef<Path>) -> DesktopLogs {
    let logs = DesktopLogs::open(
        log_dir,
        Config {
            stderr: cfg!(debug_assertions),
            filter_override: std::env::var(FILTER_VARIABLE)
                .ok()
                .filter(|spec| !spec.trim().is_empty()),
            ..Config::default()
        },
    );
    logs.install();
    logs
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

/// `spec` as a filter, or `default` when it is missing, blank or not a valid filter.
fn filter(spec: Option<&str>, default: &str) -> EnvFilter {
    spec.filter(|spec| !spec.trim().is_empty())
        .and_then(|spec| EnvFilter::try_new(spec).ok())
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
