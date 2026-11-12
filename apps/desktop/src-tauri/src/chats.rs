//! The desktop's Chat service: one `ChatHost` for the life of the app, the requests the
//! Chat screens make of it, and the feed each open Chat view follows.
//!
//! Requests are validated here and carried out by the core and the host; this module
//! decides nothing about dispatch. It has no Tauri dependency so it can be tested with
//! the fake adapter; `chat_commands` exposes it over the bridge.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ticketd_chat_host::{
    Activity, ChatHost, ChatLive, ChatProblem, ChatUpdate, ContextSource, HarnessAdapter,
    HostError, Inspection, InteractionAnswer, InteractionKind, LoginState, ProblemKind,
    QuestionAnswer, ResumeMode, SendMode, Subscription, UnconfirmedCleanup, WorkspaceOpener,
    harness_key, problem_kind,
};
use ticketd_core::{
    Chat, ChatItem, ChatLink, ChatLinkKind, ChatListFilter, ChatMessage, ChatRecord, ChatRole,
    ChatTurnState, NewChat, Workspace,
};
use tokio::sync::oneshot;

use crate::chat_view::{
    self, ChatState, FreshHistory, HARNESSES, Item, LinkedRecord, Queued, Summary, Surroundings,
    Tracker, harness_name,
};

/// History read to build a list row. A Chat's latest outcome is near its end.
const SUMMARY_ITEMS: usize = 50;
// ponytail: "the whole conversation" and lookups by message id read at most this many
// items; page through `chat_history` when a Chat outgrows it.
const HISTORY_ITEMS: usize = 10_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_LAST_MESSAGES: usize = 200;
/// The detail recorded on work that was in progress in a backup when it was restored.
const RESTORED_FROM_BACKUP: &str = "the workspace was restored from a backup";

/// A refused request. `stale` means the request, turn or runtime it named is no longer
/// current; the message is shown to the person as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatFailure {
    pub code: &'static str,
    pub message: String,
}

fn failed(message: impl Into<String>) -> ChatFailure {
    ChatFailure {
        code: "failed",
        message: message.into(),
    }
}

fn stale(message: impl Into<String>) -> ChatFailure {
    ChatFailure {
        code: "stale",
        message: message.into(),
    }
}

impl From<ticketd_core::Error> for ChatFailure {
    fn from(error: ticketd_core::Error) -> Self {
        failed(error.to_string())
    }
}

impl From<HostError> for ChatFailure {
    fn from(error: HostError) -> Self {
        match error {
            HostError::InteractionExpired => stale(error.to_string()),
            other => failed(other.to_string()),
        }
    }
}

type Outcome<T> = Result<T, ChatFailure>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Ticket,
    Document,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkRef {
    pub kind: LinkKind,
    pub id: String,
}

impl From<LinkRef> for ChatLink {
    fn from(link: LinkRef) -> Self {
        Self {
            kind: match link.kind {
                LinkKind::Ticket => ChatLinkKind::Ticket,
                LinkKind::Document => ChatLinkKind::Document,
                LinkKind::Project => ChatLinkKind::Project,
            },
            id: link.id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewChatInput {
    /// A UUID the interface makes once per New Chat attempt and repeats on a retry, so
    /// a retry finds the Chat and the message the first try saved.
    pub command_id: String,
    pub harness_id: String,
    /// `None` asks for a managed folder.
    pub folder: Option<String>,
    pub links: Vec<LinkRef>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Answer {
    Choice { option_id: String },
    Text { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UncertainDecision {
    Resend,
    Discard,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HistorySelection {
    LastResponse,
    LastMessages { count: usize },
    All,
    Picked { ids: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retention {
    Archive,
    Unarchive,
    Trash,
    Restore,
}

/// A Chat that was created. `send_error` says why its first message was not saved. The
/// Chat exists either way: the interface opens it with the unsent text in its composer
/// and makes a new `command_id` for whatever New Chat is asked for next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Created {
    pub chat_id: String,
    pub send_error: Option<String>,
}

/// A restore that replaced the workspace. `warning` says what could not be confirmed
/// around it; the data is the backup's either way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Restored {
    /// The safety copy of the workspace as it was before.
    pub safety_path: String,
    pub warning: Option<String>,
}

/// What a restore reports. `restored` is the safety copy, or why nothing was replaced:
/// only that is a failure. An unconfirmed stop or a failed check of the restored Chats
/// happened around a restore that did take place, so they are warnings on a success.
pub fn restore_outcome(
    restored: Result<PathBuf, String>,
    reconciled: Outcome<()>,
    unconfirmed: usize,
) -> Result<Restored, String> {
    let safety = restored?;
    let unchecked = reconciled.err().map(|failure| {
        format!(
            "Its Chats could not be checked ({}); restart ticketd before using Chat.",
            failure.message
        )
    });
    let unstopped = (unconfirmed > 0).then(|| {
        format!(
            "Stopping {unconfirmed} Chat(s) could not be confirmed; a harness process may still be running."
        )
    });
    let warnings: Vec<String> = unchecked.into_iter().chain(unstopped).collect();
    Ok(Restored {
        safety_path: safety.display().to_string(),
        warning: Some(warnings.join(" ")).filter(|warning| !warning.is_empty()),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Overview {
    pub needs_you: usize,
    pub working: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub status: &'static str,
    pub message: Option<String>,
    pub command: Option<String>,
    pub help_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub chat: ChatState,
    pub items: Vec<Item>,
    /// Changes on the view's feed are numbered from here, one apart.
    pub cursor: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Opened {
    /// Names the feed, to close it.
    pub subscription: u64,
    pub snapshot: Snapshot,
}

/// Takes one change for the view; false once the view is gone.
pub type Sink = Arc<dyn Fn(Value) -> bool + Send + Sync>;

fn text_argument(text: &str, what: &str) -> Outcome<()> {
    if text.trim().is_empty() {
        return Err(failed(format!("{what} must not be empty")));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(failed(format!("{what} is too long")));
    }
    Ok(())
}

/// An absolute path to a folder that exists.
fn folder_argument(path: &str) -> Outcome<String> {
    let folder = Path::new(path);
    if !folder.is_absolute() {
        return Err(failed("the folder must be a full path"));
    }
    if !folder.is_dir() {
        return Err(failed(format!("'{path}' is not a folder that exists")));
    }
    Ok(path.to_owned())
}

fn harness_status(id: &'static str, name: &'static str, inspection: Inspection) -> HarnessStatus {
    let found = |executable: &PathBuf, version: &Option<String>| {
        format!(
            "{name} {} at {}",
            version.as_deref().unwrap_or("(unknown version)"),
            executable.display()
        )
    };
    let sign_in = chat_view::login_command(id).map(str::to_owned);
    let (status, message, command) = match &inspection {
        Inspection::Installed {
            executable,
            version,
            login,
            ..
        } => match login {
            LoginState::SignedIn => ("ready", found(executable, version), None),
            // Usable, but never shown as plain ready: the person sees how it bills
            // before the first message goes out.
            LoginState::NonSubscription => (
                "not_subscription",
                format!(
                    "{}. It is signed in with an API key or cloud provider, not a subscription; {name} bills usage there.",
                    found(executable, version)
                ),
                sign_in,
            ),
            LoginState::SignedOut => ("not_signed_in", found(executable, version), sign_in),
            // Not every harness can be asked; it says so itself when a Chat starts.
            LoginState::Unknown => (
                "sign_in_unknown",
                format!(
                    "{}. ticketd cannot check whether it is signed in; {name} reports that when a Chat starts.",
                    found(executable, version)
                ),
                sign_in,
            ),
        },
        Inspection::Incompatible {
            executable,
            version,
            requirement,
        } => (
            "incompatible",
            format!("{} lacks {requirement}", found(executable, version)),
            None,
        ),
        Inspection::NotInstalled => ("not_installed", format!("{name} was not found"), None),
        Inspection::ProbeFailed { reason } => ("unknown", reason.clone(), None),
    };
    HarnessStatus {
        id,
        name,
        status,
        message: Some(message),
        command,
        // Shown where the person has something to install or update.
        help_url: matches!(status, "not_installed" | "incompatible")
            .then(|| chat_view::help_url(id).map(str::to_owned))
            .flatten(),
    }
}

/// Whether Chats can be started on a harness with this status. A sign-in ticketd could
/// not confirm as a subscription does not block; it is shown.
fn usable(status: &str) -> bool {
    matches!(status, "ready" | "not_subscription" | "sign_in_unknown")
}

/// A ticket status as the interface names it.
fn status_name(status: impl Serialize) -> Result<String, ticketd_core::Error> {
    Ok(match serde_json::to_value(status)? {
        Value::String(name) => name,
        other => other.to_string(),
    })
}

fn links(workspace: &Workspace, chat_id: &str) -> Result<Vec<LinkedRecord>, ticketd_core::Error> {
    let mut links = Vec::new();
    for record in workspace.chat_linked_records(chat_id)? {
        links.push(match (record.kind, record.reference) {
            (ChatLinkKind::Ticket, Some(reference)) => LinkedRecord::Ticket {
                status: status_name(workspace.show_ticket(&reference)?.status)?,
                id: record.id,
                reference,
                title: record.title,
            },
            // A ticket always has a reference; without one there is nothing to open.
            (ChatLinkKind::Ticket, None) => continue,
            (ChatLinkKind::Document, _) => LinkedRecord::Document {
                id: record.id,
                title: record.title,
            },
            (ChatLinkKind::Project, _) => LinkedRecord::Project {
                id: record.id,
                title: record.title,
            },
        });
    }
    Ok(links)
}

/// Every Chat outside the trash, read once per request for what Chats share.
fn folder_users(workspace: &Workspace) -> Result<Vec<Chat>, ticketd_core::Error> {
    let mut chats = workspace.list_chats(ChatListFilter::Active)?;
    chats.extend(workspace.list_chats(ChatListFilter::Archived)?);
    Ok(chats)
}

fn surroundings(
    workspace: &Workspace,
    chat: &Chat,
    folder_users: &[Chat],
    checked_turn: Option<String>,
) -> Result<Surroundings, ticketd_core::Error> {
    let shared_with = folder_users
        .iter()
        .filter(|other| other.id != chat.id && other.execution_folder == chat.execution_folder)
        .map(|other| other.title.clone().unwrap_or("Untitled Chat".to_owned()))
        .collect();
    Ok(Surroundings {
        checked_turn,
        folder_missing: !Path::new(&chat.execution_folder).is_dir(),
        shared_with,
        links: links(workspace, &chat.id)?,
        queue: workspace
            .chat_queue(&chat.id)?
            .into_iter()
            .map(|message| Queued {
                id: message.id,
                text: message.text,
            })
            .collect(),
    })
}

fn messages(workspace: &Workspace, chat_id: &str) -> Result<Vec<ChatMessage>, ticketd_core::Error> {
    let snapshot = workspace.chat_snapshot(chat_id, HISTORY_ITEMS)?;
    Ok(snapshot
        .items
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Message(message) => Some(message),
            _ => None,
        })
        .collect())
}

/// One open view's feed, so it can be closed or told to read a new snapshot.
struct Feed {
    chat_id: String,
    /// Dropped to end the feed.
    _end: oneshot::Sender<()>,
}

/// What a view's feed remembers between updates.
struct View {
    chat: Chat,
    live: ChatLive,
    tracker: Tracker,
    state: ChatState,
    sequence: u64,
}

pub struct Chats {
    open_workspace: WorkspaceOpener,
    adapters: Vec<Arc<dyn HarnessAdapter>>,
    /// Why a harness has no adapter in this run, by harness id.
    unavailable: Vec<(&'static str, String)>,
    context: Option<ContextSource>,
    /// The Experimental switch. The interface keeps the person's choice and tells the
    /// backend at startup; until then Chat is off and nothing can run.
    enabled: AtomicBool,
    /// Set while the workspace is being replaced by a backup, so that no host is
    /// started meanwhile. A host that already runs refuses work by itself.
    restoring: AtomicBool,
    host: Mutex<Option<ChatHost>>,
    /// Per Chat, the failed turn after which "Check again" found the harness usable.
    // ponytail: kept for this run of ticketd only; after a restart the last turn's
    // failure is told again, as past. Store it if that proves annoying.
    checked: Mutex<HashMap<String, String>>,
    feeds: Mutex<HashMap<u64, Feed>>,
    next_feed: AtomicU64,
    fresh: Mutex<HashMap<String, FreshHistory>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Chats {
    pub fn new(
        open_workspace: WorkspaceOpener,
        adapters: Vec<Arc<dyn HarnessAdapter>>,
        unavailable: Vec<(&'static str, String)>,
        context: Option<ContextSource>,
    ) -> Arc<Self> {
        Arc::new(Self {
            open_workspace,
            adapters,
            unavailable,
            context,
            enabled: AtomicBool::new(false),
            restoring: AtomicBool::new(false),
            host: Mutex::new(None),
            checked: Mutex::new(HashMap::new()),
            feeds: Mutex::new(HashMap::new()),
            next_feed: AtomicU64::new(1),
            fresh: Mutex::new(HashMap::new()),
        })
    }

    /// Why Chats cannot run on this harness here. One harness being unavailable never
    /// stops the others.
    fn unavailable(&self, harness: &str) -> String {
        let reason = self.unavailable.iter().find(|(id, _)| *id == harness);
        reason.map_or_else(
            || {
                format!(
                    "{} is not available in this build of ticketd.",
                    harness_name(harness)
                )
            },
            |(_, reason)| reason.clone(),
        )
    }

    fn workspace(&self) -> Outcome<Workspace> {
        Ok((self.open_workspace)()?)
    }

    /// The one host of this process, started the first time Chat is used while it is on.
    /// Must be called inside the async runtime: the host starts its tasks on it.
    fn host(&self) -> Outcome<ChatHost> {
        if !self.enabled() {
            return Err(failed("Chat is turned off in Settings > Experimental."));
        }
        if self.restoring.load(Ordering::SeqCst) {
            return Err(failed(
                "The workspace is being restored from a backup. Try again when it has finished.",
            ));
        }
        let mut host = lock(&self.host);
        if let Some(host) = host.as_ref() {
            return Ok(host.clone());
        }
        let started = ChatHost::with_context(
            self.open_workspace.clone(),
            self.adapters.clone(),
            self.context.clone(),
        )?;
        *host = Some(started.clone());
        Ok(started)
    }

    /// Starts the host if Chat is on, so its change signal can be watched.
    pub fn start(&self) -> Outcome<()> {
        self.host().map(|_| ())
    }

    /// Moves whenever any Chat record was written or live state changed; cheap to read.
    pub fn digest(&self) -> Option<String> {
        let host = self.started_host()?;
        let sequence = self.workspace().ok()?.chat_change_sequence().ok()?;
        let mut live: Vec<_> = host.live().into_iter().collect();
        live.sort_by(|a, b| a.0.cmp(&b.0));
        Some(format!("{sequence} {live:?}"))
    }

    fn started_host(&self) -> Option<ChatHost> {
        lock(&self.host).clone()
    }

    fn live(&self, chat_id: &str) -> ChatLive {
        self.started_host()
            .and_then(|host| host.live().remove(chat_id))
            .unwrap_or_else(chat_view::idle)
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Turning Chat off stops every running Chat first; the interface has already asked.
    /// Returns the Chats whose harness could not be confirmed stopped.
    pub async fn set_enabled(&self, enabled: bool) -> Vec<UnconfirmedCleanup> {
        self.enabled.store(enabled, Ordering::SeqCst);
        match self.started_host() {
            // The host refuses on every clone of it, including one a command took
            // while Chat was still on.
            Some(host) if !enabled => host.turn_off().await,
            Some(host) => {
                host.turn_on();
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    /// Chats with work in progress or a request waiting, which Quit or closing would affect.
    pub fn working(&self) -> usize {
        let live = self.started_host().map(|host| host.live());
        live.into_iter()
            .flat_map(HashMap::into_values)
            .filter(|live| live.activity != Activity::Idle)
            .count()
    }

    /// Before the workspace is replaced by a backup: stops every running Chat, so no
    /// harness keeps working against records that are about to change, and refuses new
    /// work until `finish_restore`. Returns the Chats whose harness could not be
    /// confirmed stopped.
    pub async fn begin_restore(&self) -> Vec<UnconfirmedCleanup> {
        self.restoring.store(true, Ordering::SeqCst);
        match self.started_host() {
            // The host refuses on every clone of it, including one a command took
            // before this point.
            Some(host) => host.begin_restore().await,
            None => Vec::new(),
        }
    }

    /// After the restore, whether or not it replaced anything. The records now in the
    /// workspace have no runtime behind them: they are reconciled as lost contact, and
    /// every queue with input in it is paused, so restored input waits for the person.
    pub fn finish_restore(&self) -> Outcome<()> {
        let reconciled = self.workspace().and_then(|mut workspace| {
            workspace.mark_chat_contact_lost(None, RESTORED_FROM_BACKUP)?;
            let filters = [
                ChatListFilter::Active,
                ChatListFilter::Archived,
                ChatListFilter::Trashed,
            ];
            for filter in filters {
                for chat in workspace.list_chats(filter)? {
                    if !chat.queue_paused && !workspace.chat_queue(&chat.id)?.is_empty() {
                        workspace.set_chat_queue_paused(&chat.id, true)?;
                    }
                }
            }
            Ok(())
        });
        // Views read a new snapshot: their cursors belong to the replaced records.
        lock(&self.feeds).clear();
        lock(&self.checked).clear();
        if let Some(host) = self.started_host() {
            host.finish_restore();
        }
        self.restoring.store(false, Ordering::SeqCst);
        reconciled
    }

    /// Stops app-owned execution with bounded cleanup. The host accepts nothing afterwards.
    pub async fn quit(&self) -> Vec<UnconfirmedCleanup> {
        match self.started_host() {
            Some(host) => host.quit().await,
            None => Vec::new(),
        }
    }

    /// Moves when any Chat may have changed; `None` until the host has started.
    pub fn changed(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        self.started_host().map(|host| host.changed())
    }

    fn summaries(&self, filter: ChatListFilter) -> Outcome<Vec<Summary>> {
        let workspace = self.workspace()?;
        let live = self.started_host().map(|host| host.live());
        // ponytail: one bounded history read per Chat; add a core summary query when a
        // workspace holds enough Chats for the list to feel slow.
        let folder_users = folder_users(&workspace)?;
        let mut summaries = Vec::new();
        for chat in workspace.list_chats(filter)? {
            let items = workspace.chat_snapshot(&chat.id, SUMMARY_ITEMS)?.items;
            let live = live
                .as_ref()
                .and_then(|live| live.get(&chat.id).cloned())
                .unwrap_or_else(chat_view::idle);
            summaries.push(chat_view::summary(
                &chat,
                &live,
                &Tracker::from_items(&items),
                &surroundings(&workspace, &chat, &folder_users, self.checked(&chat.id))?,
            ));
        }
        Ok(summaries)
    }

    /// The counts, and a text that differs exactly when a list row or the counts would
    /// read differently. Streamed text being checkpointed changes neither, so lists are
    /// not fetched again for it.
    pub fn overview_digest(&self) -> Outcome<(Overview, String)> {
        let mut overview = Overview {
            needs_you: 0,
            working: 0,
        };
        let mut rows = Vec::new();
        for filter in [ChatListFilter::Active, ChatListFilter::Archived] {
            for summary in self.summaries(filter)? {
                overview.needs_you += usize::from(summary.needs_you);
                overview.working += usize::from(matches!(summary.activity, "working" | "waiting"));
                rows.push(summary);
            }
        }
        rows.extend(self.summaries(ChatListFilter::Trashed)?);
        let digest = format!("{rows:?}");
        Ok((overview, digest))
    }

    pub fn list(&self, scope: ChatListFilter) -> Outcome<Vec<Summary>> {
        self.host()?;
        self.summaries(scope)
    }

    pub fn overview(&self) -> Outcome<Overview> {
        if !self.enabled() {
            return Ok(Overview {
                needs_you: 0,
                working: 0,
            });
        }
        Ok(self.overview_digest()?.0)
    }

    /// Probes installation and sign-in again on every call.
    pub async fn harnesses(&self) -> Outcome<Vec<HarnessStatus>> {
        let host = self.host()?;
        let mut statuses = Vec::new();
        for (id, name) in HARNESSES {
            statuses.push(match host.inspect(id).await {
                Ok(inspection) => harness_status(id, name, inspection),
                Err(_) => HarnessStatus {
                    id,
                    name,
                    status: "incompatible",
                    message: Some(self.unavailable(id)),
                    command: None,
                    help_url: None,
                },
            });
        }
        Ok(statuses)
    }

    /// How many Chats outside the trash already use the folder.
    pub fn folder_use(&self, path: &str) -> Outcome<usize> {
        let workspace = self.workspace()?;
        let mut count = 0;
        for filter in [ChatListFilter::Active, ChatListFilter::Archived] {
            let chats = workspace.list_chats(filter)?;
            count += chats
                .iter()
                .filter(|chat| chat.execution_folder == path)
                .count();
        }
        Ok(count)
    }

    /// Creates a Chat and sends its first message. Repeating `command_id` finds the Chat
    /// and the message an earlier try saved instead of making them again.
    pub async fn create(&self, input: NewChatInput) -> Outcome<Created> {
        let host = self.host()?;
        text_argument(&input.message, "The message")?;
        let command_id = uuid::Uuid::parse_str(&input.command_id)
            .map_err(|_| failed("the request id must be a UUID"))?
            .to_string();
        let served = |adapter: &Arc<dyn HarnessAdapter>| harness_key(adapter.harness());
        if !self.adapters.iter().any(|a| served(a) == input.harness_id) {
            return Err(failed(self.unavailable(&input.harness_id)));
        }
        let mut workspace = self.workspace()?;
        // Beside the workspace file, one per Chat, named by the request so that a
        // retry asks for the same Chat.
        let managed =
            PathBuf::from(format!("{}.chats", workspace.workspace_info()?.path)).join(&command_id);
        let (execution_folder, folder_managed) = match &input.folder {
            Some(path) => (folder_argument(path)?, false),
            None => (managed.to_string_lossy().into_owned(), true),
        };
        let first_line = input.message.trim().lines().next().unwrap_or_default();
        // The Chat is stored first: a request the core refuses leaves no folder behind.
        let chat = workspace.create_chat(
            Some(&format!("{command_id}:chat")),
            NewChat {
                title: Some(first_line.chars().take(80).collect()),
                harness: input.harness_id,
                execution_folder,
                folder_managed,
                links: input.links.into_iter().map(ChatLink::from).collect(),
            },
        )?;
        drop(workspace);
        let created = |send_error| Created {
            chat_id: chat.id.clone(),
            send_error,
        };
        if chat.folder_managed
            && let Err(error) = std::fs::create_dir_all(&chat.execution_folder)
        {
            // The Chat stays readable and offers "pick another folder".
            return Ok(created(Some(format!(
                "could not create the Chat's folder {}: {error}",
                chat.execution_folder
            ))));
        }
        let first = format!("{command_id}:first");
        let sent = host.send(&chat.id, Some(&first), &input.message, SendMode::Auto);
        Ok(created(
            sent.await
                .err()
                .map(|error| ChatFailure::from(error).message),
        ))
    }

    fn fresh(&self, chat_id: &str) -> Option<FreshHistory> {
        lock(&self.fresh).get(chat_id).copied()
    }

    fn checked(&self, chat_id: &str) -> Option<String> {
        lock(&self.checked).get(chat_id).cloned()
    }

    fn state(&self, view: &View) -> Outcome<ChatState> {
        let workspace = self.workspace()?;
        let users = folder_users(&workspace)?;
        let checked = self.checked(&view.chat.id);
        let around = surroundings(&workspace, &view.chat, &users, checked)?;
        Ok(chat_view::chat_state(
            &view.chat,
            &view.live,
            &view.tracker,
            &around,
        ))
    }

    /// Attaches a view: a snapshot now, then every change after it through `sink`,
    /// numbered one apart from the snapshot's cursor. Attaching starts no harness.
    pub async fn open(self: &Arc<Self>, chat_id: &str, sink: Sink) -> Outcome<Opened> {
        let (attached, subscription) = self.host()?.attach(chat_id).await?;
        let workspace = self.workspace()?;
        let tracker = Tracker::from_items(&attached.snapshot.items);
        let chat = attached.snapshot.chat;
        let state = chat_view::chat_state(
            &chat,
            &attached.live,
            &tracker,
            &surroundings(
                &workspace,
                &chat,
                &folder_users(&workspace)?,
                self.checked(chat_id),
            )?,
        );
        let fresh = self.fresh(chat_id);
        let items = attached
            .snapshot
            .items
            .iter()
            .filter_map(|item| chat_view::item(item, &chat, &attached.live, fresh))
            .collect();
        let view = View {
            chat,
            live: attached.live,
            tracker,
            state: state.clone(),
            sequence: 0,
        };
        let id = self.next_feed.fetch_add(1, Ordering::SeqCst);
        let (resync, resynced) = oneshot::channel();
        lock(&self.feeds).insert(
            id,
            Feed {
                chat_id: chat_id.to_owned(),
                _end: resync,
            },
        );
        let chats = self.clone();
        tokio::spawn(async move {
            chats.feed(view, subscription, resynced, sink).await;
            lock(&chats.feeds).remove(&id);
        });
        Ok(Opened {
            subscription: id,
            snapshot: Snapshot {
                chat: state,
                items,
                cursor: 0,
            },
        })
    }

    /// Detaches a view. The Chat's work continues.
    pub fn close(&self, subscription: u64) {
        // Dropping the sender ends the feed, which drops the host subscription.
        lock(&self.feeds).remove(&subscription);
    }

    /// Tells every view of the Chat to read a new snapshot, after a change the feed
    /// cannot express, such as a row that no longer exists.
    fn resync(&self, chat_id: &str) {
        lock(&self.feeds).retain(|_, feed| feed.chat_id != chat_id);
    }

    async fn feed(
        &self,
        mut view: View,
        mut subscription: Subscription,
        mut resynced: oneshot::Receiver<()>,
        sink: Sink,
    ) {
        let send = |view: &mut View, mut change: Value| {
            view.sequence += 1;
            change["seq"] = json!(view.sequence);
            sink(change)
        };
        loop {
            let update = tokio::select! {
                update = subscription.next() => update,
                // Closed by the view (nobody is listening) or asked to resync.
                _ = &mut resynced => None,
            };
            let records = match update {
                Some(ChatUpdate::Changes(changes)) => {
                    let active = view.chat.active_turn.as_ref().map(|turn| turn.id.clone());
                    let mut records = Vec::new();
                    for change in changes {
                        match change.record {
                            ChatRecord::Chat(chat) => view.chat = chat,
                            ChatRecord::Item(item) => {
                                // A turn starting or ending changes no Chat record, so the
                                // Chat's active turn is followed from the turn itself.
                                if let ChatItem::Turn(turn) = &item {
                                    let ends_active = view.chat.active_turn.as_ref().map(|t| &t.id)
                                        == Some(&turn.id);
                                    if turn.state == ChatTurnState::Active {
                                        view.chat.active_turn = Some(turn.clone());
                                    } else if ends_active {
                                        view.chat.active_turn = None;
                                    }
                                }
                                view.tracker.note(&item);
                                records.push(item);
                            }
                        }
                    }
                    // A turn that ended changes how its unfinished responses read.
                    if active != view.chat.active_turn.as_ref().map(|turn| turn.id.clone()) {
                        records.extend(view.tracker.dependents());
                    }
                    records
                }
                Some(ChatUpdate::Text {
                    message_id,
                    turn_id,
                    delta,
                }) => {
                    let change = if view.tracker.streaming(&message_id, &turn_id) {
                        let item = Item::Response {
                            id: message_id,
                            at: String::new(),
                            text: delta,
                            state: "streaming",
                        };
                        json!({ "kind": "item", "item": item })
                    } else {
                        json!({ "kind": "text", "item_id": message_id, "text": delta })
                    };
                    if !send(&mut view, change) {
                        return;
                    }
                    continue;
                }
                Some(ChatUpdate::Live(live)) => {
                    view.live = live;
                    // Whether a stored request can still be answered is live state.
                    view.tracker.dependents()
                }
                Some(ChatUpdate::Resync) | None => break,
            };
            let fresh = self.fresh(&view.chat.id);
            for record in records {
                if let Some(item) = chat_view::item(&record, &view.chat, &view.live, fresh)
                    && !send(&mut view, json!({ "kind": "item", "item": item }))
                {
                    return;
                }
            }
            // If the workspace cannot be read the view keeps what it shows; the next
            // change tries again.
            if let Ok(state) = self.state(&view)
                && state != view.state
            {
                view.state = state;
                let change = json!({ "kind": "chat", "chat": view.state });
                if !send(&mut view, change) {
                    return;
                }
            }
        }
        send(&mut view, json!({ "kind": "resync" }));
    }

    pub async fn send(&self, chat_id: &str, text: &str, mode: SendMode) -> Outcome<()> {
        text_argument(text, "The message")?;
        self.host()?.send(chat_id, None, text, mode).await?;
        Ok(())
    }

    pub async fn remove_queued(&self, chat_id: &str, message_id: &str) -> Outcome<()> {
        let host = self.host()?;
        self.workspace()?.withdraw_chat_input(chat_id, message_id)?;
        host.notify_changed(chat_id).await?;
        // A withdrawn message that was tried before has a transcript row to remove.
        self.resync(chat_id);
        Ok(())
    }

    pub async fn resume_queue(&self, chat_id: &str) -> Outcome<()> {
        Ok(self.host()?.resume_queue(chat_id).await?)
    }

    pub async fn stop(&self, chat_id: &str) -> Outcome<()> {
        Ok(self.host()?.stop(chat_id).await?)
    }

    /// Answers a request only while the host holds it as live.
    pub async fn answer(&self, chat_id: &str, request_id: &str, answer: Answer) -> Outcome<()> {
        let host = self.host()?;
        let live = self.live(chat_id);
        let Some(request) = live
            .interactions
            .iter()
            .find(|request| request.interaction_id == request_id)
        else {
            return Err(stale(HostError::InteractionExpired.to_string()));
        };
        let answer = match (&request.kind, answer) {
            (InteractionKind::Approval { decisions, .. }, Answer::Choice { option_id }) => {
                let decision = chat_view::approval_decision(&option_id)
                    .filter(|decision| decisions.contains(decision))
                    .ok_or_else(|| failed("that choice was not offered for this request"))?;
                InteractionAnswer::Approval(decision)
            }
            (InteractionKind::Approval { .. }, Answer::Text { .. }) => {
                return Err(failed("an approval request takes one of its choices"));
            }
            (InteractionKind::Question { questions }, Answer::Choice { option_id }) => {
                let [question] = questions.as_slice() else {
                    return Err(failed("that choice was not offered for this request"));
                };
                if !question.options.contains(&option_id) {
                    return Err(failed("that choice was not offered for this request"));
                }
                InteractionAnswer::Answers(vec![QuestionAnswer {
                    question_id: question.id.clone(),
                    values: vec![option_id],
                }])
            }
            (InteractionKind::Question { questions }, Answer::Text { text }) => {
                text_argument(&text, "The answer")?;
                InteractionAnswer::Answers(
                    questions
                        .iter()
                        .map(|question| QuestionAnswer {
                            question_id: question.id.clone(),
                            values: vec![text.clone()],
                        })
                        .collect(),
                )
            }
        };
        Ok(host.respond(chat_id, request_id, answer).await?)
    }

    /// The person's decision about a submission that may or may not have arrived.
    /// Nothing is resent unless they ask for it here.
    pub async fn resolve_uncertain(
        &self,
        chat_id: &str,
        message_id: &str,
        decision: UncertainDecision,
    ) -> Outcome<()> {
        let host = self.host()?;
        let mut workspace = self.workspace()?;
        messages(&workspace, chat_id)?
            .into_iter()
            .find(|message| message.id == message_id && message.awaits_decision())
            .ok_or_else(|| stale("this message is no longer waiting for your decision"))?;
        // Either way the message and its uncertain attempt stay as they were observed;
        // the decision is recorded beside them.
        match decision {
            UncertainDecision::Discard => {
                workspace.discard_uncertain_chat_submission(chat_id, message_id)?;
                Ok(host.notify_changed(chat_id).await?)
            }
            // A new submission of this message alone; the rest of the queue waits.
            UncertainDecision::Resend => Ok(host.resend(chat_id, message_id).await?),
        }
    }

    /// Probes the Chat's harness again. When it is not usable, says why. When it is:
    /// a Chat stopped by a failed start tries that start again, and a failure of the
    /// last turn stops being told as a problem, since what the probe can see is in
    /// order. No input is sent by this.
    pub async fn check_again(&self, chat_id: &str) -> Outcome<()> {
        let host = self.host()?;
        let workspace = self.workspace()?;
        let chat = workspace.chat(chat_id)?;
        let items = workspace.chat_snapshot(chat_id, SUMMARY_ITEMS)?.items;
        drop(workspace);
        let (id, name) = HARNESSES
            .into_iter()
            .find(|(id, _)| *id == chat.harness)
            .ok_or_else(|| failed(format!("unknown harness '{}'", chat.harness)))?;
        let status = harness_status(id, name, host.inspect(id).await?);
        if !usable(status.status) {
            return Err(failed(status.message.unwrap_or_default()));
        }
        if matches!(
            self.live(chat_id).problem,
            Some(ChatProblem::OpenFailed { .. })
        ) {
            host.resume(chat_id, ResumeMode::Native).await?;
        }
        if let Some(turn) = Tracker::from_items(&items).failed_turn() {
            // A sign-in the probe cannot see is not shown to be in order by it.
            let signed_out =
                turn.problem.as_deref().map(problem_kind) == Some(ProblemKind::LoginRequired);
            if signed_out && status.status == "sign_in_unknown" {
                return Err(failed(status.message.unwrap_or_default()));
            }
            lock(&self.checked).insert(chat_id.to_owned(), turn.id.clone());
            // No record changed, so the views are told to read the Chat again.
            self.resync(chat_id);
        }
        Ok(host.notify_changed(chat_id).await?)
    }

    /// "Pick another folder": the Chat keeps its history and runs there from now on.
    pub async fn set_folder(&self, chat_id: &str, path: &str) -> Outcome<()> {
        let host = self.host()?;
        let folder = folder_argument(path)?;
        self.workspace()?
            .set_chat_execution_folder(chat_id, &folder, false)?;
        Ok(host.notify_changed(chat_id).await?)
    }

    pub async fn set_retention(&self, chat_id: &str, retention: Retention) -> Outcome<()> {
        let host = self.host()?;
        match retention {
            Retention::Archive | Retention::Unarchive => {
                self.workspace()?
                    .set_chat_archived(chat_id, retention == Retention::Archive)?;
            }
            Retention::Restore => {
                self.workspace()?.set_chat_trashed(chat_id, false)?;
            }
            Retention::Trash => {
                return match host.trash(chat_id).await? {
                    None => Ok(()),
                    Some(reason) => Err(failed(format!(
                        "The Chat is in the trash, but stopping its harness was not confirmed: {reason}"
                    ))),
                };
            }
        }
        Ok(host.notify_changed(chat_id).await?)
    }

    pub fn search_records(&self, query: &str) -> Outcome<Vec<LinkedRecord>> {
        let query = query.trim();
        if query.is_empty() || query.len() > 200 {
            return Ok(Vec::new());
        }
        let workspace = self.workspace()?;
        let tickets = workspace.search_tickets(query, None, false, 8, 0)?;
        let documents = workspace.search_documents(query, None, 8, 0)?;
        let mut found = Vec::new();
        for ticket in tickets {
            found.push(LinkedRecord::Ticket {
                status: status_name(ticket.status)?,
                id: ticket.id,
                reference: ticket.reference,
                title: ticket.title,
            });
        }
        found.extend(
            documents
                .into_iter()
                .map(|document| LinkedRecord::Document {
                    id: document.id,
                    title: document.heading,
                }),
        );
        // Projects are few and have no search index: match their names here.
        let needle = query.to_lowercase();
        let projects = workspace.list_projects()?.into_iter();
        found.extend(
            projects
                .filter(|project| project.name.to_lowercase().contains(&needle))
                .take(8)
                .map(|project| LinkedRecord::Project {
                    id: project.id,
                    title: project.name,
                }),
        );
        Ok(found)
    }

    pub async fn set_link(&self, chat_id: &str, link: LinkRef, present: bool) -> Outcome<()> {
        let host = self.host()?;
        self.workspace()?
            .set_chat_link(chat_id, link.into(), present)?;
        Ok(host.notify_changed(chat_id).await?)
    }

    /// Continues the same Chat in a fresh harness session started with the history the
    /// person selected. Nothing is replayed, and uncertain submissions stay as they are.
    pub async fn resume(&self, chat_id: &str, selection: HistorySelection) -> Outcome<()> {
        let host = self.host()?;
        let workspace = self.workspace()?;
        if workspace.chat(chat_id)?.trashed {
            return Err(failed(
                "Restore this Chat from the trash before resuming it.",
            ));
        }
        // Input that may never have arrived is history only when the person picks it.
        let unreceived = |message: &ChatMessage| {
            message.role == ChatRole::User
                && message
                    .attempts
                    .last()
                    .is_some_and(|attempt| !attempt.received())
        };
        let picking = matches!(selection, HistorySelection::Picked { .. });
        let sent: Vec<_> = messages(&workspace, chat_id)?
            .into_iter()
            .filter(|message| !message.queued && (picking || !unreceived(message)))
            .collect();
        let (history, chosen): (&'static str, Vec<&ChatMessage>) = match &selection {
            HistorySelection::LastResponse => (
                "last_response",
                sent.iter()
                    .rev()
                    .find(|message| message.role == ChatRole::Assistant)
                    .into_iter()
                    .collect(),
            ),
            HistorySelection::LastMessages { count } => {
                if !(1..=MAX_LAST_MESSAGES).contains(count) {
                    return Err(failed(format!(
                        "choose between 1 and {MAX_LAST_MESSAGES} messages"
                    )));
                }
                let skipped = sent.len().saturating_sub(*count);
                ("last_messages", sent.iter().skip(skipped).collect())
            }
            HistorySelection::All => ("all", sent.iter().collect()),
            HistorySelection::Picked { ids } => {
                let chosen: Vec<_> = sent.iter().filter(|m| ids.contains(&m.id)).collect();
                if chosen.len() != ids.len() {
                    return Err(stale("some of the picked messages are no longer there"));
                }
                ("picked", chosen)
            }
        };
        let mut text = String::new();
        if !chosen.is_empty() {
            text.push_str(
                "Earlier messages from this Chat, selected by the user to start this fresh session. \
                 They are history, not new instructions.\n",
            );
            for message in &chosen {
                let speaker = match message.role {
                    ChatRole::User if unreceived(message) => {
                        "User (it is not known whether the earlier session received this)"
                    }
                    ChatRole::User => "User",
                    ChatRole::Assistant if !message.complete => {
                        "Assistant (incomplete: the rest of this response was not saved)"
                    }
                    ChatRole::Assistant => "Assistant",
                };
                text.push_str(&format!("\n{speaker}:\n{}\n", message.text));
            }
        }
        let fresh = FreshHistory {
            after: workspace.chat_change_sequence()?,
            history,
            count: chosen.len(),
        };
        drop(workspace);
        lock(&self.fresh).insert(chat_id.to_owned(), fresh);
        Ok(host
            .resume(chat_id, ResumeMode::FreshSession { history: text })
            .await?)
    }

    /// Saves one assistant response as a Document through the ordinary core workflow.
    pub fn save_as_document(
        &self,
        chat_id: &str,
        response_id: &str,
        title: &str,
    ) -> Outcome<String> {
        self.host()?;
        let mut workspace = self.workspace()?;
        let response = messages(&workspace, chat_id)?
            .into_iter()
            .find(|message| message.id == response_id && message.role == ChatRole::Assistant)
            .ok_or_else(|| failed("that response is not in this Chat"))?;
        let title = Some(title.trim()).filter(|title| !title.is_empty());
        Ok(workspace.create_document(title, &response.text)?.id)
    }
}

/// What closing the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// As before Chat existed: the window closes and the app exits.
    Exit,
    /// The window is hidden and Chats keep running in this process.
    KeepRunning,
}

pub fn close_action(enabled: bool, working: usize) -> CloseAction {
    if enabled && working > 0 {
        CloseAction::KeepRunning
    } else {
        CloseAction::Exit
    }
}

/// What a request to quit does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAction {
    /// Ask the person first: this many Chats would be stopped.
    Confirm(usize),
    /// Stop app-owned execution, then exit.
    Quit,
}

pub fn quit_action(working: usize, confirmed: bool) -> QuitAction {
    if working > 0 && !confirmed {
        QuitAction::Confirm(working)
    } else {
        QuitAction::Quit
    }
}

#[cfg(test)]
#[path = "chats_tests.rs"]
mod tests;
