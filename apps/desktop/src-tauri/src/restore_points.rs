//! Restore points on the desktop: the daily one, saved in the background, and the list the
//! Backups section shows. The rules (what a day is, how many are kept, the check after
//! writing) are the core's; this file only decides when to ask.
use std::time::Duration;

use ticketd_core::{RestorePoint, RestorePointList, WorkspaceGuard};

use crate::BridgeFailure;

/// How long the window and the first screens get before the first copy starts.
const START_AFTER: Duration = Duration::from_secs(20);
/// How often an app left open overnight looks for a new day.
const LOOK_EVERY: Duration = Duration::from_secs(30 * 60);

/// Saves each day's restore point while the desktop runs: once shortly after it opens, then
/// whenever a new day has started. It runs on a thread of its own with a connection of its
/// own, so a large Workspace never holds up the window, and a failure is logged and tried
/// again at the next look.
pub(crate) fn start(
    open: impl Fn() -> Result<WorkspaceGuard, ticketd_core::Error> + Send + 'static,
) {
    let spawned = std::thread::Builder::new()
        .name("restore-points".into())
        .spawn(move || {
            std::thread::sleep(START_AFTER);
            let mut reported: Option<String> = None;
            loop {
                match open().and_then(|workspace| workspace.save_daily_restore_point()) {
                    Ok(saved) => {
                        reported = None;
                        if let Some(point) = saved {
                            tracing::info!(
                                size_bytes = point.size_bytes,
                                restorable = point.problem.is_none(),
                                "daily restore point saved"
                            );
                        }
                    }
                    Err(error) => {
                        let message = error.to_string();
                        if reported.as_deref() != Some(message.as_str()) {
                            tracing::warn!(
                                error_kind = error.kind().code(),
                                %error,
                                "daily restore point could not be saved"
                            );
                            reported = Some(message);
                        }
                    }
                }
                std::thread::sleep(LOOK_EVERY);
            }
        });
    if let Err(error) = spawned {
        tracing::error!(%error, "could not start the daily restore point");
    }
}

/// The restore points, with the safety copies saved before restores and updates.
#[tauri::command(async)]
pub(crate) fn restore_points() -> Result<RestorePointList, BridgeFailure> {
    crate::open_workspace()
        .and_then(|workspace| workspace.restore_points())
        .map_err(BridgeFailure::from)
}

/// Back up now: one more restore point, with no file to choose.
#[tauri::command(async)]
pub(crate) fn save_restore_point() -> Result<RestorePoint, BridgeFailure> {
    crate::open_workspace()
        .and_then(|workspace| workspace.save_manual_restore_point())
        .map_err(BridgeFailure::from)
}
