//! The page's way to record an uncaught error in the log.

use ticketd_diagnostics::{WebviewError, record_webview_error};

/// The page reports an uncaught error. It has already dropped repeats and limited itself
/// to ten a minute; the event follows the logging standard in `ticketd-diagnostics`.
#[tauri::command]
pub fn report_webview_error(report: WebviewError) {
    record_webview_error(&report);
}
