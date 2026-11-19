//! What Settings → Diagnostics asks of the desktop: the log level and Debug logging switch,
//! the logs folder, the recent kinds of error, a summary to paste into an issue, and the
//! redacted export.
//!
//! The logging crate knows the logs; this module knows the app. It gathers the facts the
//! logs cannot give (versions, sync state, Harnesses, the Workspace's health) and hands
//! them over.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use ticketd_core::sync::SyncConnection;
use ticketd_diagnostics::{
    ErrorGroup, Export, Facts, HarnessVersion, KnownValues, LogLevel, WorkspaceHealth,
};

use crate::Logs;
use crate::chat_commands::{ChatBridge, chat_harnesses};

/// The log level, whether Debug logging is on, and the `TICKETD_LOG` filter that overrides it.
#[tauri::command]
pub fn diagnostics_log_level(logs: State<'_, Logs>) -> Result<LogLevel, String> {
    with_logs(&logs, |logs| logs.log_level())
}

/// Turns Debug logging on or off for the rest of this run and returns the resulting level.
/// It is off again at the next launch. Does nothing while `TICKETD_LOG` decides the level.
#[tauri::command]
pub fn diagnostics_set_debug(logs: State<'_, Logs>, enabled: bool) -> Result<LogLevel, String> {
    with_logs(&logs, |logs| {
        logs.set_debug(enabled);
        let level = logs.log_level();
        tracing::info!(debug = level.debug, "debug logging changed");
        level
    })
}

/// Shows the folder the log files are written to in the file manager.
#[tauri::command]
pub fn diagnostics_open_logs_folder(app: AppHandle, logs: State<'_, Logs>) -> Result<(), String> {
    let folder = with_logs(&logs, |logs| logs.dir().to_path_buf())?;
    if !folder.is_dir() {
        // Logging fell back to stderr: there is no folder to show.
        return Err("There is no logs folder on this computer".to_string());
    }
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("Could not open the logs folder: {error}"))
}

/// The warnings and errors in the log folder grouped by kind, most recent first. The page
/// shows the first few.
#[tauri::command]
pub fn diagnostics_recent_errors(logs: State<'_, Logs>) -> Vec<ErrorGroup> {
    with_logs(&logs, |logs| logs.recent_errors()).unwrap_or_default()
}

/// The file name a new export gets, for the save dialog to suggest.
#[tauri::command]
pub fn diagnostics_export_file_name() -> String {
    ticketd_diagnostics::export_file_name()
}

/// The short description of this app and machine that goes at the top of a bug report.
#[tauri::command]
pub async fn diagnostics_summary(
    bridge: State<'_, ChatBridge>,
    logs: State<'_, Logs>,
) -> Result<String, String> {
    let facts = gather(&bridge).await;
    with_logs(&logs, |logs| logs.summary(&facts))
}

/// Writes the redacted bundle to `destination`, the file the person chose in the save
/// dialog, and shows it in the file manager.
#[tauri::command]
pub async fn diagnostics_export(
    app: AppHandle,
    bridge: State<'_, ChatBridge>,
    logs: State<'_, Logs>,
    destination: String,
) -> Result<Export, String> {
    let facts = gather(&bridge).await;
    let exported = with_logs(&logs, |logs| logs.export(&destination, &facts))?
        .map_err(|error| format!("Could not write the diagnostics: {error}"))?;
    tracing::info!(bytes = exported.bytes, "diagnostics exported");
    // The file is written; failing to show it is not a failed export.
    if let Err(error) = app.opener().reveal_item_in_dir(&exported.path) {
        tracing::warn!(%error, "could not show the diagnostics export");
    }
    Ok(exported)
}

fn with_logs<T>(
    logs: &State<'_, Logs>,
    f: impl FnOnce(&ticketd_diagnostics::DesktopLogs) -> T,
) -> Result<T, String> {
    let guard = logs
        .0
        .lock()
        .map_err(|_| "The logs are not available".to_string())?;
    guard
        .as_ref()
        .map(f)
        .ok_or_else(|| "The logs are closed".to_string())
}

/// What the logs cannot say. Anything that cannot be found is left out or marked unknown:
/// a diagnostics export is most wanted when something is already wrong.
async fn gather(bridge: &State<'_, ChatBridge>) -> Facts {
    // Asking a Harness for its version starts it, so it runs beside the Workspace checks.
    let harnesses = harness_versions(bridge);
    let workspace = tauri::async_runtime::spawn_blocking(workspace_facts);
    let harnesses = harnesses.await;
    let (health, sync_enabled, account, path) = workspace.await.unwrap_or_default();
    Facts {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        commit: option_env!("TICKETD_COMMIT")
            .unwrap_or("unknown")
            .to_string(),
        build: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
        .to_string(),
        os: os_name(),
        arch: std::env::consts::ARCH.to_string(),
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".to_string()),
        sync_enabled,
        harnesses,
        workspace: health,
        known: KnownValues::from_environment(path.as_deref(), account.as_deref()),
    }
}

async fn harness_versions(bridge: &State<'_, ChatBridge>) -> Vec<HarnessVersion> {
    // Chat may be off, or a Harness missing; each is reported as it is found.
    chat_harnesses(bridge.clone())
        .await
        .map(|statuses| {
            statuses
                .into_iter()
                .map(|status| HarnessVersion {
                    name: status.id.to_string(),
                    version: status.version,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The Workspace's health, whether sync is connected, the Drive account and the file's path.
fn workspace_facts() -> (WorkspaceHealth, bool, Option<String>, Option<PathBuf>) {
    let Ok(file) = ticketd_core::default_workspace_file() else {
        let health = WorkspaceHealth {
            quick_check: "the Workspace location is not known".to_string(),
            ..WorkspaceHealth::default()
        };
        return (health, false, None, None);
    };
    let health = ticketd_core::workspace_health(&file.path);
    let status = crate::open_workspace()
        .and_then(|workspace| workspace.sync_status())
        .ok();
    let sync_enabled = status
        .as_ref()
        .is_some_and(|status| status.connection != SyncConnection::NotConnected);
    let account = status.and_then(|status| status.account);
    (
        WorkspaceHealth {
            format_version: health.format_version.and_then(|v| u32::try_from(v).ok()),
            quick_check: health.quick_check,
            file_bytes: health.file_bytes,
            wal_bytes: health.wal_bytes,
            row_counts: health.row_counts,
        },
        sync_enabled,
        account,
        Some(file.path),
    )
}

/// The operating system and its version, as far as it can be learned cheaply.
fn os_name() -> String {
    let version = match std::env::consts::OS {
        "macos" => command_output("sw_vers", &["-productVersion"]),
        "linux" => os_release_name(Path::new("/etc/os-release")),
        _ => None,
    };
    match version {
        Some(version) => format!("{} {version}", std::env::consts::OS),
        None => std::env::consts::OS.to_string(),
    }
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim();
    (output.status.success() && !text.is_empty()).then(|| text.to_string())
}

fn os_release_name(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|name| name.trim_matches('"').to_string())
}
