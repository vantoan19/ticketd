//! Hosts the Automation runner in the desktop: one pass at start and one every few
//! seconds. Everything a pass does lives in `ticketd-automation-runner`; this only
//! decides when one may happen.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ticketd_automation_runner::{Runner, TicketdCli};
use ticketd_chat_host::{ChatHost, cli};

use crate::chats::Chats;

/// How long after a ticket changes its Automation may start. Passes are cheap: with
/// nothing new in the event log, one reads each cursor and writes nothing.
const TICK: Duration = Duration::from_secs(5);

/// Where the ticketd CLI is and which folder it writes to, so an agent can always
/// run it. Blocking: it runs the CLI with a deadline.
fn ticketd_cli(app_version: &str) -> TicketdCli {
    let workspace = crate::open_workspace()
        .and_then(|workspace| workspace.workspace_info())
        .map(|info| PathBuf::from(info.path))
        .ok();
    let status = cli::locate(app_version, workspace.as_deref());
    TicketdCli {
        executable: status.path.map(PathBuf::from),
        folders: workspace
            .as_deref()
            .and_then(|path| path.parent())
            .map(|folder| vec![folder.to_owned()])
            .unwrap_or_default(),
    }
}

/// One pass, creating the runner the first time there is a host to run agents on.
/// Blocking.
fn pass(runner: Option<Runner>, host: ChatHost, app_version: &str) -> Option<Runner> {
    let runner = match runner {
        Some(runner) => runner,
        None => Runner::new(
            Arc::new(crate::open_workspace),
            host,
            ticketd_cli(app_version),
        )
        .ok()?,
    };
    // ponytail: a pass that fails (the Workspace is busy or unreadable) is tried
    // again at the next tick; nothing shows the failure.
    let _ = runner.tick();
    Some(runner)
}

/// Starts the loop. While Chat is off, or a backup is being restored, there is no
/// host and nothing is matched; each Automation's cursor holds, so changes made
/// meanwhile start their runs at the first pass afterwards.
pub fn start(chats: Arc<Chats>, app_version: String) {
    tauri::async_runtime::spawn(async move {
        let mut runner = None;
        loop {
            if let Some(host) = chats.automation_host() {
                let (current, version) = (runner.take(), app_version.clone());
                // The pass reads SQLite and may run the CLI: off the async threads.
                // It starts its runs on this runtime, which a blocking thread is in.
                runner =
                    tauri::async_runtime::spawn_blocking(move || pass(current, host, &version))
                        .await
                        .ok()
                        .flatten();
            }
            tokio::time::sleep(TICK).await;
        }
    });
}
