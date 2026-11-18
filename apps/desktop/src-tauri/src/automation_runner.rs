//! Hosts the Automation runner in the desktop: one pass at start, one every few
//! seconds while anything needs the runner, and otherwise one when the Workspace
//! changes or at the idle fallback. Everything a pass does lives in `ticketd-automation-runner`; this only
//! decides when one may happen.

use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use ticketd_automation_runner::{Notifier, Runner};
use ticketd_chat_host::WorkspaceOpener;
use ticketd_core::Error;

use crate::chats::Chats;

/// The key a Notify me step's notification carries what it opens under. The page
/// reads it from the click (`features/automations/useAutomationNotifications.ts`).
const NOTIFICATION_TARGET: &str = "automation";

/// Shows a Notify me step's notification from here, not from the page: a run goes
/// on while the window is hidden to the tray, and must not depend on the page.
pub fn notifier(app: AppHandle) -> Notifier {
    Arc::new(move |notification| {
        app.notification()
            .builder()
            .title(&notification.title)
            .body(&notification.body)
            .extra(NOTIFICATION_TARGET, &notification)
            .show()
            .map_err(|error| error.to_string())
    })
}

/// A click on a Notify me notification brings the window back, from the tray too;
/// the page then opens the ticket or the run. Clicks are reported only for
/// notifications shown after this is called.
pub fn open_on_click(app: &AppHandle) {
    let window = app.clone();
    // Registering cannot fail on desktop; the signature is the mobile one.
    let _ = app.notification().on_action(move |performed| {
        let ours = performed
            .notification()
            .is_some_and(|shown| shown.extra().contains_key(NOTIFICATION_TARGET));
        if ours && performed.action_id() == "tap" {
            crate::chat_commands::show_window(&window);
        }
    });
}

/// Set once the start-up pass has ended, however it ended.
static STARTED: OnceLock<()> = OnceLock::new();

/// Waits for the start-up pass, which runs off the main thread: until it has
/// ended, the runs the previous process left Running still read as Running.
pub fn started() {
    STARTED.wait();
}

/// How long after a ticket changes its Automation may start. Passes are cheap: with
/// nothing new in the event log, one reads each cursor and writes nothing.
const TICK: Duration = Duration::from_secs(5);

/// The one Automation runner of this process, so that the loop and the commands that
/// end runs reach the same one. It is created when the desktop starts, before any command
/// is served and whether or not Chat is on: creating it ends the runs a process that is
/// gone left Running, and a Stop that came first would find them already ended. It
/// asks the Chats for the host each time, so it follows Chat being switched off and on.
#[derive(Clone)]
pub struct AutomationRunner {
    chats: Arc<Chats>,
    open_workspace: WorkspaceOpener,
    notifier: Notifier,
    runner: Arc<Mutex<Option<Runner>>>,
}

impl AutomationRunner {
    pub fn new(chats: Arc<Chats>, open_workspace: WorkspaceOpener, notifier: Notifier) -> Self {
        Self {
            chats,
            open_workspace,
            notifier,
            runner: Arc::default(),
        }
    }

    /// Creates the runner now, ending the runs a process that is gone left Running.
    /// Called once while the desktop starts. A failure (the Workspace is unreadable) is
    /// logged and tried again by whatever needs the runner next.
    pub fn start_up(&self) {
        if let Err(error) = self.get() {
            tracing::error!(
                error_kind = error.kind().code(),
                %error,
                "the Automation runner could not start"
            );
        }
    }

    /// The runner, created if `start_up` could not.
    pub fn get(&self) -> Result<Runner, Error> {
        let mut slot = self.runner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(runner) = slot.as_ref() {
            return Ok(runner.clone());
        }
        let chats = Arc::clone(&self.chats);
        let runner = Runner::new(
            Arc::clone(&self.open_workspace),
            Arc::new(move || chats.automation_host()),
            Arc::clone(&self.notifier),
        )?;
        *slot = Some(runner.clone());
        Ok(runner)
    }

    /// Whether a pass may run: false while Chat is off, a backup is being restored or
    /// the host could not start, when nothing is matched.
    fn host_available(&self) -> bool {
        self.chats.automation_host().is_ok()
    }

    /// One pass; returns whether anything needs the runner. A pass that fails (the
    /// Workspace is busy or unreadable) is tried again at the next tick, which also
    /// ends any run the failure left Running. Blocking.
    fn pass(&self) -> bool {
        match self.get().and_then(|runner| runner.tick()) {
            Ok(busy) => busy,
            Err(error) => {
                tracing::warn!(
                    error_kind = error.kind().code(),
                    %error,
                    "an Automation pass failed"
                );
                true
            }
        }
    }
}

/// Starts the loop, after the start-up pass. While Chat is off, or a backup is being
/// restored, there is no host and nothing is matched; each Automation's cursor holds,
/// so changes made meanwhile start their runs at the first pass afterwards.
pub fn start(runner: AutomationRunner, app: AppHandle) {
    open_on_click(&app);
    tauri::async_runtime::spawn(run(runner));
}

/// The loop: the start-up pass, then a pass every few seconds while anything needs
/// the runner, otherwise when the Workspace changes or at the idle fallback.
pub(crate) async fn run(runner: AutomationRunner) {
    // SQLite work, off the async threads and the main thread; the passes and the
    // Automation commands wait for it.
    let first = runner.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || first.start_up()).await;
    let _ = STARTED.set(());
    let mut seen = 0;
    loop {
        let busy = runner.host_available() && {
            let runner = runner.clone();
            // The pass reads SQLite and may run the CLI: off the async threads.
            // It starts its runs on this runtime, which a blocking thread is in.
            tauri::async_runtime::spawn_blocking(move || runner.pass())
                .await
                .unwrap_or(true)
        };
        let wait = if busy { TICK } else { crate::wake::IDLE };
        seen = tauri::async_runtime::spawn_blocking(move || {
            crate::wake::CHANGED.wait(&mut seen, wait);
            seen
        })
        .await
        .unwrap_or(seen);
    }
}

#[cfg(test)]
#[path = "automation_runner_tests.rs"]
mod tests;
