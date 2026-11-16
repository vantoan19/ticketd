//! Hosts the Automation runner in the desktop: one pass at start and one every few
//! seconds. Everything a pass does lives in `ticketd-automation-runner`; this only
//! decides when one may happen.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use ticketd_automation_runner::{Notifier, Runner};
use ticketd_core::Error;

use crate::chats::Chats;

/// The key a Notify me step's notification carries what it opens under. The page
/// reads it from the click (`features/automations/useAutomationNotifications.ts`).
const NOTIFICATION_TARGET: &str = "automation";

/// Shows a Notify me step's notification from here, not from the page: a run goes
/// on while the window is hidden to the tray, and must not depend on the page.
fn notifier(app: AppHandle) -> Notifier {
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

/// How long after a ticket changes its Automation may start. Passes are cheap: with
/// nothing new in the event log, one reads each cursor and writes nothing.
const TICK: Duration = Duration::from_secs(5);

/// The one Automation runner of this process, created the first time anything needs
/// it, so that the loop and the commands that end runs reach the same one. It asks
/// the Chats for the host each time, so it follows Chat being switched off and on.
#[derive(Clone)]
pub struct AutomationRunner {
    chats: Arc<Chats>,
    app: AppHandle,
    runner: Arc<Mutex<Option<Runner>>>,
}

impl AutomationRunner {
    pub fn new(chats: Arc<Chats>, app: AppHandle) -> Self {
        Self {
            chats,
            app,
            runner: Arc::default(),
        }
    }

    /// The runner. Creating it ends the runs a process that is gone left Running.
    pub fn get(&self) -> Result<Runner, Error> {
        let mut slot = self.runner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(runner) = slot.as_ref() {
            return Ok(runner.clone());
        }
        let chats = Arc::clone(&self.chats);
        let runner = Runner::new(
            Arc::new(crate::open_workspace),
            Arc::new(move || chats.automation_host()),
            notifier(self.app.clone()),
        )?;
        *slot = Some(runner.clone());
        Ok(runner)
    }

    /// Whether a pass may run: false while Chat is off, a backup is being restored or
    /// the host could not start, when nothing is matched.
    fn host_available(&self) -> bool {
        self.chats.automation_host().is_some()
    }

    /// One pass. A pass that fails (the Workspace is busy or unreadable) is tried
    /// again at the next tick, which also ends any run the failure left Running.
    /// Blocking.
    fn pass(&self) {
        match self.get() {
            Ok(runner) => {
                if let Err(error) = runner.tick() {
                    eprintln!("ticketd: an Automation pass failed: {error}");
                }
            }
            Err(error) => eprintln!("ticketd: the Automation runner could not start: {error}"),
        }
    }
}

/// Starts the loop. While Chat is off, or a backup is being restored, there is no
/// host and nothing is matched; each Automation's cursor holds, so changes made
/// meanwhile start their runs at the first pass afterwards.
pub fn start(runner: AutomationRunner, app: AppHandle) {
    open_on_click(&app);
    tauri::async_runtime::spawn(async move {
        loop {
            if runner.host_available() {
                let runner = runner.clone();
                // The pass reads SQLite and may run the CLI: off the async threads.
                // It starts its runs on this runtime, which a blocking thread is in.
                let _ = tauri::async_runtime::spawn_blocking(move || runner.pass()).await;
            }
            tokio::time::sleep(TICK).await;
        }
    });
}
