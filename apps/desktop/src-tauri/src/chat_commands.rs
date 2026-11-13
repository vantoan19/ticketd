//! The Chat service over the bridge: commands for the Chat screens, the events they
//! listen to, and what closing the window and quitting do while Chats are working.
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use ticketd_chat_host::{
    BRIDGE_SIDECAR_NAME, ClaudeAdapter, CodexAdapter, ContextSource, HarnessAdapter, SendMode, cli,
    context,
};
use ticketd_core::ChatListFilter;

use crate::chat_view::{LinkedRecord, Summary};
use crate::chats::{
    Answer, ChatFailure, Chats, CloseAction, Created, HarnessStatus, HistorySelection, LinkRef,
    NewChatInput, Opened, Overview, QuitAction, Restored, Retention, UncertainDecision,
    close_action, quit_action, tray_tooltip,
};

/// Fired when any Chat's list row or the counts may have changed. Payload: `Overview`.
const OVERVIEW_EVENT: &str = "chat-overview";
/// Fired when Quit was asked for. Payload: how many Chats are working.
const QUIT_EVENT: &str = "chat-quit-requested";
const TRAY_ID: &str = "chats";
/// Lists refetch on every overview event, so a streaming Chat must not fire one per text update.
const OVERVIEW_INTERVAL: Duration = Duration::from_secs(1);
/// Quit waits this long for harnesses to stop; each Chat's own cleanup is bounded below it.
const QUIT_TIMEOUT: Duration = Duration::from_secs(20);

type Outcome<T> = Result<T, ChatFailure>;

pub struct ChatBridge {
    chats: Arc<Chats>,
    watching: AtomicBool,
    quit_confirmed: AtomicBool,
}

/// The Claude bridge is shipped as a sidecar beside the application executable. In
/// development, copy the built bridge there (see `apps/chat-bridge-claude`).
fn claude_bridge() -> Result<PathBuf, String> {
    let name = format!("{BRIDGE_SIDECAR_NAME}{}", std::env::consts::EXE_SUFFIX);
    let folder = std::env::current_exe()
        .ok()
        .and_then(|executable| Some(executable.parent()?.to_owned()));
    match folder.map(|folder| folder.join(&name)) {
        Some(bridge) if bridge.is_file() => Ok(bridge),
        Some(_) => Err(
            "Claude Code is unavailable: ticketd's Claude bridge is missing from this installation. Reinstall ticketd to restore it.".to_owned()),
        None => Err("Claude Code is unavailable: ticketd could not find its own folder to look for its Claude bridge.".to_owned()),
    }
}

/// The linked-record reference text a new harness session starts with (#266). It is
/// built when the session starts, so it names the CLI and the records as they are then.
fn context_source(app_version: String) -> ContextSource {
    Arc::new(move |chat_id| {
        let context = || {
            let workspace = crate::open_workspace()?;
            let path = PathBuf::from(workspace.workspace_info()?.path);
            // Blocking: runs the CLI with a deadline, once per new session. The host
            // calls this off the async threads.
            let status = cli::locate(&app_version, Some(&path));
            context::for_chat(&workspace, chat_id, &status)
        };
        context().map(Some).map_err(|error| error.to_string())
    })
}

impl ChatBridge {
    pub fn new(app_version: String) -> Self {
        // The harnesses this run can use, and why any other is unavailable. A new
        // harness is registered here.
        let mut adapters: Vec<Arc<dyn HarnessAdapter>> = vec![Arc::new(CodexAdapter::new())];
        let mut unavailable = Vec::new();
        match claude_bridge() {
            Ok(bridge) => adapters.push(Arc::new(ClaudeAdapter::new(bridge))),
            Err(reason) => unavailable.push(("claude-code", reason)),
        }
        Self {
            chats: Chats::new(
                Arc::new(crate::open_workspace),
                adapters,
                unavailable,
                Some(context_source(app_version)),
            ),
            watching: AtomicBool::new(false),
            quit_confirmed: AtomicBool::new(false),
        }
    }

    /// For the Automation runner, which runs its agents on the same host.
    pub fn chats(&self) -> Arc<Chats> {
        self.chats.clone()
    }
}

/// Tells the interface when Chat summaries change, from the host's own signal rather
/// than the workspace poll.
fn watch_overview(app: &AppHandle) {
    let bridge = app.state::<ChatBridge>();
    let Some(mut changed) = bridge.chats.changed() else {
        return;
    };
    if bridge.watching.swap(true, Ordering::SeqCst) {
        return;
    }
    let (app, chats) = (app.clone(), bridge.chats.clone());
    tauri::async_runtime::spawn(async move {
        let (mut seen, mut shown) = (None, None);
        while changed.changed().await.is_ok() {
            tokio::time::sleep(OVERVIEW_INTERVAL).await;
            changed.borrow_and_update();
            // Nothing was written and no live state moved: nothing to read.
            let written = chats.digest();
            if written.is_none() || written == seen {
                continue;
            }
            seen = written;
            // Lists are fetched again on this event, so it fires only when a row or the
            // counts would read differently; a text checkpoint alone changes neither.
            if let Ok((overview, digest)) = chats.overview_digest()
                && shown.as_ref() != Some(&digest)
            {
                shown = Some(digest);
                update_tray(&app, &overview);
                let _ = app.emit(OVERVIEW_EVENT, overview);
            }
        }
    });
}

#[tauri::command]
pub fn chat_enabled(bridge: State<'_, ChatBridge>) -> bool {
    bridge.chats.enabled()
}

/// The interface keeps the person's choice and reports it here, at startup and when it
/// changes. Turning Chat off stops running Chats; the interface has already confirmed.
#[tauri::command]
pub async fn chat_set_enabled(
    app: AppHandle,
    bridge: State<'_, ChatBridge>,
    enabled: bool,
) -> Outcome<()> {
    let unconfirmed = bridge.chats.set_enabled(enabled).await;
    if enabled {
        // Starting the host here lets its change signal be watched from now on.
        bridge.chats.start()?;
        watch_overview(&app);
    }
    let _ = app.emit(OVERVIEW_EVENT, bridge.chats.overview()?);
    if unconfirmed.is_empty() {
        return Ok(());
    }
    Err(ChatFailure {
        code: "failed",
        message: format!(
            "Chat is off, but stopping {} could not be confirmed; a harness process may still be running.",
            if unconfirmed.len() == 1 {
                "1 Chat".to_owned()
            } else {
                format!("{} Chats", unconfirmed.len())
            }
        ),
    })
}

#[tauri::command]
pub async fn chat_overview(bridge: State<'_, ChatBridge>) -> Outcome<Overview> {
    bridge.chats.overview()
}

#[tauri::command]
pub async fn chat_list(
    bridge: State<'_, ChatBridge>,
    scope: ChatListFilter,
) -> Outcome<Vec<Summary>> {
    bridge.chats.list(scope)
}

#[tauri::command]
pub async fn chat_harnesses(bridge: State<'_, ChatBridge>) -> Outcome<Vec<HarnessStatus>> {
    bridge.chats.harnesses().await
}

#[tauri::command]
pub async fn chat_folder_use(bridge: State<'_, ChatBridge>, path: String) -> Outcome<usize> {
    bridge.chats.folder_use(&path)
}

#[tauri::command]
pub async fn chat_create(bridge: State<'_, ChatBridge>, input: NewChatInput) -> Outcome<Created> {
    bridge.chats.create(input).await
}

/// Attaches a view. Changes after the snapshot arrive on `changes` in order, numbered
/// one apart from the snapshot's cursor; a `resync` entry is the last one.
#[tauri::command]
pub async fn chat_open(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    changes: Channel<Value>,
) -> Outcome<Opened> {
    let sink = Arc::new(move |change| changes.send(change).is_ok());
    bridge.chats.open(&chat_id, sink).await
}

#[tauri::command]
pub fn chat_close(bridge: State<'_, ChatBridge>, subscription: u64) {
    bridge.chats.close(subscription);
}

#[tauri::command]
pub async fn chat_send(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    text: String,
    queue: bool,
) -> Outcome<()> {
    let mode = if queue {
        SendMode::Queue
    } else {
        SendMode::Auto
    };
    bridge.chats.send(&chat_id, &text, mode).await
}

#[tauri::command]
pub async fn chat_remove_queued(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    queued_id: String,
) -> Outcome<()> {
    bridge.chats.remove_queued(&chat_id, &queued_id).await
}

#[tauri::command]
pub async fn chat_resume_queue(bridge: State<'_, ChatBridge>, chat_id: String) -> Outcome<()> {
    bridge.chats.resume_queue(&chat_id).await
}

#[tauri::command]
pub async fn chat_stop(bridge: State<'_, ChatBridge>, chat_id: String) -> Outcome<()> {
    bridge.chats.stop(&chat_id).await
}

#[tauri::command]
pub async fn chat_answer(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    request_id: String,
    answer: Answer,
) -> Outcome<()> {
    bridge.chats.answer(&chat_id, &request_id, answer).await
}

#[tauri::command]
pub async fn chat_resolve_uncertain(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    message_id: String,
    decision: UncertainDecision,
) -> Outcome<()> {
    let chats = &bridge.chats;
    chats
        .resolve_uncertain(&chat_id, &message_id, decision)
        .await
}

#[tauri::command]
pub async fn chat_check_again(bridge: State<'_, ChatBridge>, chat_id: String) -> Outcome<()> {
    bridge.chats.check_again(&chat_id).await
}

#[tauri::command]
pub async fn chat_set_folder(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    path: String,
) -> Outcome<()> {
    bridge.chats.set_folder(&chat_id, &path).await
}

#[tauri::command]
pub async fn chat_set_retention(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    retention: Retention,
) -> Outcome<()> {
    bridge.chats.set_retention(&chat_id, retention).await
}

#[tauri::command]
pub async fn chat_search_records(
    bridge: State<'_, ChatBridge>,
    query: String,
) -> Outcome<Vec<LinkedRecord>> {
    bridge.chats.search_records(&query)
}

#[tauri::command]
pub async fn chat_set_link(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    link: LinkRef,
    present: bool,
) -> Outcome<()> {
    bridge.chats.set_link(&chat_id, link, present).await
}

#[tauri::command]
pub async fn chat_resume(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    history: HistorySelection,
) -> Outcome<()> {
    bridge.chats.resume(&chat_id, history).await
}

#[tauri::command]
pub async fn chat_save_as_document(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    response_id: String,
    title: String,
) -> Outcome<String> {
    bridge
        .chats
        .save_as_document(&chat_id, &response_id, &title)
}

/// Replaces the workspace with a backup. A backup that cannot be restored stops
/// nothing; otherwise running Chats are stopped first and nothing restored is run: what
/// the backup held as in progress is recorded as lost contact and its queues stay
/// paused until the person acts.
#[tauri::command]
pub async fn restore_workspace(
    app: AppHandle,
    bridge: State<'_, ChatBridge>,
    sync: State<'_, crate::sync_commands::SyncHost>,
    path: String,
) -> Result<Restored, String> {
    let chats = bridge.chats.clone();
    let scheduler = std::sync::Arc::clone(&sync.scheduler);
    let restored = chats
        .restore(PathBuf::from(path), move |backup| {
            // Sync is held off while the Workspace file is replaced.
            let _no_run = scheduler.hold();
            ticketd_core::Workspace::restore_default(backup).map_err(|error| error.to_string())
        })
        .await;
    if let Ok(overview) = chats.overview() {
        let _ = app.emit(OVERVIEW_EVENT, overview);
    }
    restored
}

/// The person's answer to the Quit confirmation.
#[tauri::command]
pub fn chat_answer_quit(app: AppHandle, bridge: State<'_, ChatBridge>, quit: bool) {
    if quit {
        bridge.quit_confirmed.store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Window close, reopen and Quit (spec 21.3)
// ---------------------------------------------------------------------------

/// Brings the window back. The page was never unloaded, so its views are still attached
/// to the same host: nothing is started again.
pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    app.remove_tray_by_id(TRAY_ID);
}

/// Whether closing the window now hides it and keeps Chats working, instead of quitting.
/// The page asks before it starts its own way out.
#[tauri::command]
pub fn close_keeps_running(bridge: State<'_, ChatBridge>) -> bool {
    page_close_keeps_running(&bridge)
}

/// The page asks this once per close, after the shell's own close handling. A confirmed
/// Quit is spent here: from now the page's way out decides, and when it keeps the
/// window open (sync's "Keep open") later closes and Quits behave as before it.
fn page_close_keeps_running(bridge: &ChatBridge) -> bool {
    let keeps = keeps_running(bridge);
    bridge.quit_confirmed.store(false, Ordering::SeqCst);
    keeps
}

fn keeps_running(bridge: &ChatBridge) -> bool {
    !bridge.quit_confirmed.load(Ordering::SeqCst)
        && close_action(bridge.chats.enabled(), bridge.chats.working()) == CloseAction::KeepRunning
}

/// Quit was asked for while Chats are working and the person has not confirmed: shows
/// the window and asks there. `false` when the quit may go ahead.
pub fn confirms_quit(app: &AppHandle) -> bool {
    let bridge = app.state::<ChatBridge>();
    let confirmed = bridge.quit_confirmed.load(Ordering::SeqCst);
    match quit_action(bridge.chats.working(), confirmed) {
        QuitAction::Confirm(working) => {
            show_window(app);
            let _ = app.emit(QUIT_EVENT, working);
            true
        }
        QuitAction::Quit => false,
    }
}

/// Quit from the tray: the window comes back so that what the way out has to show
/// (the Chat confirmation, uploads still running) is seen.
fn request_quit(app: &AppHandle) {
    show_window(app);
    app.exit(0);
}

/// Keeps a shown tray icon saying what the hidden Chats are doing now. When they have
/// finished, ticketd stays open for their results and for sync, and the tray says so.
fn update_tray(app: &AppHandle, overview: &Overview) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tray_tooltip(overview)));
    }
}

/// Once the window was hidden with Chats working, the tray icon is the way back to the
/// window and the place to quit, until the window is shown again.
fn show_tray(app: &AppHandle, overview: &Overview) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        update_tray(app, overview);
        return Ok(());
    }
    let open = MenuItemBuilder::with_id("open", "Open ticketd").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit ticketd").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tray_tooltip(overview))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Handles the application events that decide whether Chats keep running.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    // On Linux the event loop delivers events before `setup` manages the bridge.
    // No Chat can exist yet, so there is nothing to decide.
    let Some(bridge) = app.try_state::<ChatBridge>() else {
        return;
    };
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            // Otherwise the window closes exactly as before Chat existed.
            if keeps_running(&bridge) {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                // Without a tray icon, starting ticketd again brings the window back.
                let overview = bridge.chats.overview().unwrap_or(Overview {
                    needs_you: 0,
                    working: bridge.chats.working(),
                });
                let _ = show_tray(app, &overview);
            }
        }
        // Coming back to ticketd, perhaps after moving a Chat's folder back into place.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Focused(true),
            ..
        } if label == "main" && bridge.chats.enabled() => {
            let chats = bridge.chats.clone();
            tauri::async_runtime::spawn(async move {
                let _ = chats.recheck_folders().await;
            });
        }
        // The system's own Quit (for example Cmd+Q) rather than ticketd's confirmed exit.
        // With the window already gone there is nowhere to ask, so the exit goes ahead.
        RunEvent::ExitRequested {
            code: None, api, ..
        } if app.get_webview_window("main").is_some() => {
            if confirms_quit(app) {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app),
        // Explicit Quit: stop app-owned execution before the process ends. What cannot
        // be confirmed in time is recorded as lost contact when ticketd next starts.
        RunEvent::Exit => {
            let chats = bridge.chats.clone();
            tauri::async_runtime::block_on(async move {
                let _ = tokio::time::timeout(QUIT_TIMEOUT, chats.quit()).await;
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_confirmed_quit_that_the_page_does_not_complete_is_asked_again() {
        let bridge = ChatBridge {
            chats: Chats::new(
                Arc::new(|| Err(ticketd_core::Error::Backup("not opened".to_owned()))),
                Vec::new(),
                Vec::new(),
                None,
            ),
            watching: AtomicBool::new(false),
            quit_confirmed: AtomicBool::new(true),
        };

        // The confirmed quit's own close goes on to the page's way out.
        assert!(!page_close_keeps_running(&bridge));

        // The page kept the window open (sync's "Keep open"): the next Quit asks again
        // and the next close hides the window while Chats work.
        let confirmed = bridge.quit_confirmed.load(Ordering::SeqCst);
        assert_eq!(quit_action(2, confirmed), QuitAction::Confirm(2));
    }
}
