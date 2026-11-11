//! Lets Settings say whether agents can reach the `ticketd` command-line tool.
use std::path::PathBuf;
use ticketd_chat_host::cli::{self, CliStatus};

/// Checks whether this user's `ticketd` is installed and belongs with this app.
#[tauri::command]
pub async fn check_cli(app: tauri::AppHandle) -> Result<CliStatus, String> {
    let app_version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = ticketd_core::Workspace::open_default()
            .and_then(|workspace| workspace.workspace_info())
            .ok()
            .map(|info| PathBuf::from(info.path));
        cli::locate(&app_version, workspace.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
}
