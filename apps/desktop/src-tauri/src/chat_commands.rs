//! The Chat service over the bridge: commands for the Chat screens, the events they
//! listen to, and what closing the window and quitting do while Chats are working.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use ticketd_chat_host::{
    BRIDGE_SIDECAR_NAME, ClaudeAdapter, CodexAdapter, ContextSource, HarnessAdapter, SendMode,
    SettingKey, cli, context,
};
use ticketd_core::ChatListFilter;

use tauri_plugin_opener::OpenerExt;

use crate::chat_reports::SettingChangeView;
use crate::chat_view::{LinkedRecord, Summary};
use crate::chats::{
    Answer, ChatFailure, Chats, CloseAction, Created, FolderFile, HarnessStatus, HistorySelection,
    LinkRef, NewChatInput, Opened, Overview, QuitAction, Restored, Retention, Stopping,
    UncertainDecision, close_action, quit_action, tray_tooltip,
};
use ticketd_chat_host::attention::{Alert, Notifier, Row, badge_text};

/// Fired when any Chat's list row or the counts may have changed. Payload: `Overview`.
const OVERVIEW_EVENT: &str = "chat-overview";
/// Fired when Quit was asked for. Payload: `Stopping`.
const QUIT_EVENT: &str = "chat-quit-requested";
/// Fired when the person clicked a Chat's system notification. Payload: `OpenRequest`.
const OPEN_EVENT: &str = "chat-open-requested";
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
    /// The notification id each Chat's notifications use, so a newer one replaces the
    /// older and a click finds its Chat.
    notifications: Mutex<HashMap<String, i32>>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct OpenRequest {
    chat_id: String,
    retention: &'static str,
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
            notifications: Mutex::new(HashMap::new()),
        }
    }

    /// For the Automation runner, which runs its agents on the same host.
    pub fn chats(&self) -> Arc<Chats> {
        self.chats.clone()
    }
}

fn notification_id(bridge: &ChatBridge, chat_id: &str) -> i32 {
    let mut ids = bridge
        .notifications
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let next = i32::try_from(ids.len()).unwrap_or(i32::MAX - 1) + 1;
    *ids.entry(chat_id.to_owned()).or_insert(next)
}

/// Shows or withdraws system notifications as the notifier decided. Withdrawing works
/// where the platform allows it (Linux); elsewhere the system keeps what it showed.
fn alert(app: &AppHandle, alerts: Vec<Alert>) {
    let bridge = app.state::<ChatBridge>();
    for alert in alerts {
        match alert {
            Alert::Show {
                chat_id,
                title,
                body,
            } => {
                let id = notification_id(&bridge, &chat_id);
                let _ = app.notification().remove_active(vec![id]);
                let _ = app
                    .notification()
                    .builder()
                    .id(id)
                    .group(chat_id)
                    .title(title)
                    .body(body)
                    .show();
            }
            Alert::Withdraw { chat_id } => {
                let id = notification_id(&bridge, &chat_id);
                let _ = app.notification().remove_active(vec![id]);
            }
        }
    }
}

/// The app-icon count: Chats waiting for the person, minus muted ones. The window
/// title stays "ticketd".
fn set_badge(app: &AppHandle, count: usize) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let text = badge_text(count);
    #[cfg(target_os = "macos")]
    let _ = window.set_badge_label(text);
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = window.set_badge_count(text.map(|_| i64::try_from(count).unwrap_or(i64::MAX)));
    // Windows has no count; its taskbar button carries a disc while any Chat waits.
    #[cfg(windows)]
    let _ = window.set_overlay_icon(text.map(|_| waiting_disc()));
}

/// A 16px disc for the Windows taskbar overlay, in the light theme's `primary`.
#[cfg(windows)]
fn waiting_disc() -> tauri::image::Image<'static> {
    const SIZE: u32 = 16;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (dx, dy) = (x as f32 - 7.5, y as f32 - 7.5);
            let inside = dx * dx + dy * dy <= 56.0;
            rgba.extend_from_slice(&[0x17, 0x17, 0x17, if inside { 0xff } else { 0 }]);
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

/// A click on a Chat's notification brings the window back, reopening it if it was
/// closed, and opens that Chat; the Chat is marked seen when its view opens.
pub fn on_notification_click(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        let Some(id) = performed.notification().map(|shown| shown.id()) else {
            return;
        };
        let bridge = handle.state::<ChatBridge>();
        let chat_id = bridge
            .notifications
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|(_, shown)| **shown == id)
            .map(|(chat_id, _)| chat_id.clone());
        let Some(chat_id) = chat_id else {
            return;
        };
        let archived = bridge.chats.chat_retention(&chat_id).unwrap_or("active");
        show_window(&handle);
        let _ = handle.emit(
            OPEN_EVENT,
            OpenRequest {
                chat_id,
                retention: archived,
            },
        );
    });
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
        let mut notifier = Notifier::default();
        // The first reading sets what is already there; nothing in it is announced.
        if let Ok((overview, rows, trashed)) = chats.overview_digest() {
            notify(&app, &chats, &mut notifier, &rows);
            shown = Some((rows, trashed));
            set_badge(&app, overview.app_icon);
        }
        loop {
            // A quiet window that ends is a reason to read again, like a change.
            let quiet = notifier.deadline();
            let woke = tokio::select! {
                changed = changed.changed() => changed.is_ok(),
                () = sleep_until(quiet) => true,
            };
            if !woke {
                break;
            }
            if quiet.is_none_or(|at| at > Instant::now()) {
                tokio::time::sleep(OVERVIEW_INTERVAL).await;
            }
            changed.borrow_and_update();
            // Nothing was written and no live state moved: nothing to read, unless a
            // quiet window has ended.
            let written = chats.digest();
            let due = notifier.deadline().is_some_and(|at| at <= Instant::now());
            if written.is_none() || (written == seen && !due) {
                continue;
            }
            seen = written;
            let Ok((overview, rows, trashed)) = chats.overview_digest() else {
                continue;
            };
            notify(&app, &chats, &mut notifier, &rows);
            let digest = (rows, trashed);
            // Lists are fetched again on this event, so it fires only when a row or the
            // counts would read differently; a text checkpoint alone changes neither.
            if shown.as_ref() != Some(&digest) {
                shown = Some(digest);
                update_tray(&app, &overview);
                set_badge(&app, overview.app_icon);
                let _ = app.emit(OVERVIEW_EVENT, overview);
            }
        }
    });
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at.into()).await,
        None => std::future::pending().await,
    }
}

fn notify(app: &AppHandle, chats: &Chats, notifier: &mut Notifier, rows: &[Summary]) {
    let rows: Vec<Row<'_>> = rows
        .iter()
        .map(|row| Row {
            id: &row.id,
            title: &row.title,
            status: &row.status,
            muted: row.muted,
        })
        .collect();
    let alerts = notifier.update(&rows, &chats.in_view(), chats.notifies(), Instant::now());
    alert(app, alerts);
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
        // The Automation runner waits for a host.
        crate::wake::CHANGED.notify();
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

/// The interface keeps "Notify me about Chats" and reports it at startup and on change.
#[tauri::command]
pub fn chat_set_notify(bridge: State<'_, ChatBridge>, enabled: bool) {
    bridge.chats.set_notify(enabled);
}

#[tauri::command]
pub async fn chat_mark_read(bridge: State<'_, ChatBridge>, chat_id: String) -> Outcome<()> {
    bridge.chats.mark_read(&chat_id).await
}

/// The person read the transcript through `item_id`; the New marker goes after it.
#[tauri::command(async)]
pub fn chat_read_through(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    item_id: String,
) -> Outcome<()> {
    bridge.chats.read_through(&chat_id, &item_id)
}

#[tauri::command]
pub async fn chat_mark_unread(bridge: State<'_, ChatBridge>, chat_id: String) -> Outcome<()> {
    bridge.chats.mark_unread(&chat_id).await
}

#[tauri::command]
pub async fn chat_set_muted(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    muted: bool,
) -> Outcome<()> {
    bridge.chats.set_muted(&chat_id, muted).await
}

#[tauri::command]
pub async fn chat_overview(bridge: State<'_, ChatBridge>) -> Outcome<Overview> {
    bridge.chats.overview()
}

/// What turning Chat off would stop, for its confirmation.
#[tauri::command]
pub async fn chat_stopping(bridge: State<'_, ChatBridge>) -> Outcome<Stopping> {
    let chats = bridge.chats.clone();
    // Reads the Workspace: off the async threads.
    tauri::async_runtime::spawn_blocking(move || chats.stopping())
        .await
        .map_err(|error| ChatFailure {
            code: "failed",
            message: error.to_string(),
        })
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

/// What one harness offers before a session: models, efforts and permission modes.
#[tauri::command]
pub async fn chat_harness_options(
    bridge: State<'_, ChatBridge>,
    harness_id: String,
) -> Outcome<crate::chat_reports::HarnessOptionsView> {
    bridge.chats.options(&harness_id).await
}

#[tauri::command]
pub async fn chat_folder_use(bridge: State<'_, ChatBridge>, path: String) -> Outcome<usize> {
    bridge.chats.folder_use(&path)
}

/// The Project whose checkout holds a folder New Chat may use.
#[tauri::command(async)]
pub fn chat_folder_project(
    bridge: State<'_, ChatBridge>,
    path: String,
) -> Outcome<Option<crate::chat_view::ProjectRef>> {
    bridge.chats.folder_project(&path)
}

#[tauri::command]
pub async fn chat_create(bridge: State<'_, ChatBridge>, input: NewChatInput) -> Outcome<Created> {
    bridge.chats.create(input).await
}

/// Attaches a view. Changes after the snapshot arrive on `changes` in order, numbered
/// one apart from the snapshot's cursor, each update's as one array; a `resync` entry is
/// the last one.
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
    links: Option<Vec<LinkRef>>,
) -> Outcome<()> {
    let mode = if queue {
        SendMode::Queue
    } else {
        SendMode::Auto
    };
    let links = links.unwrap_or_default();
    bridge
        .chats
        .send_linking(&chat_id, &text, mode, &links)
        .await
}

/// Files and folders for the composer's `@` menu.
#[tauri::command]
pub async fn chat_files(
    bridge: State<'_, ChatBridge>,
    path: String,
    query: String,
) -> Outcome<Vec<FolderFile>> {
    bridge.chats.files(&path, &query)
}

/// The Chats linked to one record, for its page; refetched when the overview changes.
#[tauri::command]
pub async fn chat_linked_to(bridge: State<'_, ChatBridge>, link: LinkRef) -> Outcome<Vec<Summary>> {
    bridge.chats.linked_to(&link)
}

/// The whole output of one step, which views carry only the last lines of until its
/// row opens.
#[tauri::command(async)]
pub fn chat_step_output(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    tool_id: String,
) -> Outcome<Option<String>> {
    bridge.chats.step_output(&chat_id, &tool_id)
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
pub async fn chat_send_queued_now(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    queued_id: String,
) -> Outcome<()> {
    bridge.chats.send_queued_now(&chat_id, &queued_id).await
}

/// Changes the live session's model, effort or permission from its next turn.
#[tauri::command]
pub async fn chat_change_setting(
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    setting: SettingKey,
    value: String,
) -> Outcome<SettingChangeView> {
    bridge.chats.change_setting(&chat_id, setting, &value).await
}

/// Opens a file in the Chat's folder (a step's file, or one a turn changed) in the
/// system's default app for its type, as attachments open. A program or script is
/// shown in the file manager instead of being run. Fails as `gone` when the
/// file is no longer there.
#[tauri::command(async)]
pub fn chat_open_file(
    app: AppHandle,
    bridge: State<'_, ChatBridge>,
    chat_id: String,
    path: String,
) -> Outcome<()> {
    let path = bridge.chats.file_in_folder(&chat_id, &path)?;
    if crate::chats::runs_when_opened(&path) {
        return app
            .opener()
            .reveal_item_in_dir(&path)
            .map_err(|error| open_failure(&path, &error.to_string()));
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| open_failure(&path, &error.to_string()))
}

/// Opens the Chat's own folder in the file manager (Finder, File Explorer, Files).
#[tauri::command(async)]
pub fn chat_open_folder(
    app: AppHandle,
    bridge: State<'_, ChatBridge>,
    chat_id: String,
) -> Outcome<()> {
    let path = bridge.chats.folder(&chat_id)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| ChatFailure {
            code: "failed",
            message: format!("Couldn't open the folder: {error}"),
        })
}

/// "Couldn't open limiter.ts. No app on this computer opens .ts files."
fn open_failure(path: &std::path::Path, error: &str) -> ChatFailure {
    let name = path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let lower = error.to_lowercase();
    let reason = match path.extension() {
        Some(extension) if lower.contains("no application") || lower.contains("no app") => {
            format!(
                "No app on this computer opens .{} files.",
                extension.to_string_lossy()
            )
        }
        _ => format!("{error}."),
    };
    ChatFailure {
        code: "failed",
        message: format!("Couldn't open {name}. {reason}"),
    }
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

#[tauri::command]
pub async fn chat_suggestions(
    bridge: State<'_, ChatBridge>,
    folder: Option<String>,
    linked: Vec<String>,
) -> Outcome<Vec<crate::chat_view::Suggestion>> {
    bridge.chats.suggestions(folder.as_deref(), &linked)
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
            // Sync is held off while the Workspace file is replaced, and the desktop's
            // session lets go of it.
            let _no_run = scheduler.hold();
            crate::workspace_session()
                .and_then(|session| {
                    session.exclusive(|path| ticketd_core::Workspace::restore(path, backup))
                })
                .map_err(|error| error.to_string())
        })
        .await;
    // Everything the background loops follow was replaced.
    crate::wake::CHANGED.notify();
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

/// Whether closing the window now hides it and keeps Chats and Automations going,
/// instead of quitting.
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
        && close_action(
            bridge.chats.enabled(),
            bridge.chats.stopping(),
            bridge.chats.automations_on(),
        ) == CloseAction::KeepRunning
}

/// Quit was asked for while Chats are working or runs going and the person has not
/// confirmed: shows the window and asks there. `false` when the quit may go ahead.
pub fn confirms_quit(app: &AppHandle) -> bool {
    let bridge = app.state::<ChatBridge>();
    let confirmed = bridge.quit_confirmed.load(Ordering::SeqCst);
    match quit_action(bridge.chats.stopping(), confirmed) {
        QuitAction::Confirm(stopping) => {
            show_window(app);
            let _ = app.emit(QUIT_EVENT, stopping);
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
                    working: bridge.chats.working(),
                    ..Overview::default()
                });
                let _ = show_tray(app, &overview);
            }
        }
        // Coming back to ticketd, perhaps after moving a Chat's folder back into place.
        // The open Chat is in view again, so it is seen.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Focused(focused),
            ..
        } if label == "main" && bridge.chats.enabled() => {
            let (chats, focused) = (bridge.chats.clone(), *focused);
            tauri::async_runtime::spawn(async move {
                chats.set_focused(focused).await;
                if focused {
                    crate::chats::log_failure(
                        "check the Chats' folders",
                        chats.recheck_folders().await,
                    );
                }
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
            notifications: Mutex::new(HashMap::new()),
        };

        // The confirmed quit's own close goes on to the page's way out.
        assert!(!page_close_keeps_running(&bridge));

        // The page kept the window open (sync's "Keep open"): the next Quit asks again
        // and the next close hides the window while Chats work.
        let confirmed = bridge.quit_confirmed.load(Ordering::SeqCst);
        let working = Stopping { chats: 2, runs: 0 };
        assert_eq!(
            quit_action(working, confirmed),
            QuitAction::Confirm(working)
        );
    }
}
