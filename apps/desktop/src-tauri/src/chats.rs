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
    HostError, Inspection, InteractionAnswer, InteractionKind, LoginState, QuestionAnswer,
    ResumeMode, SendMode, Subscription, UnconfirmedCleanup, WorkspaceOpener, harness_key,
};
use ticketd_core::{
    Chat, ChatDelivery, ChatItem, ChatLink, ChatLinkKind, ChatListFilter, ChatMessage,
    ChatObservation, ChatRecord, ChatRole, NewChat, Workspace,
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
            },
            id: link.id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewChatInput {
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
    let (status, message, command) = match &inspection {
        Inspection::Installed {
            executable,
            version,
            login,
            ..
        } => match login {
            LoginState::SignedIn => ("ready", found(executable, version), None),
            LoginState::NonSubscription => (
                "ready",
                format!(
                    "{}. It is signed in with an API key or cloud provider, not a subscription; {name} bills usage there.",
                    found(executable, version)
                ),
                None,
            ),
            LoginState::SignedOut => (
                "not_signed_in",
                found(executable, version),
                Some(format!("{id} login")),
            ),
            // Not every harness can be asked; it says so itself when a Chat starts.
            LoginState::Unknown => (
                "ready",
                format!(
                    "{}. ticketd cannot check whether it is signed in; {name} reports that when a Chat starts.",
                    found(executable, version)
                ),
                None,
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
        help_url: None,
    }
}

fn ticket_status(workspace: &Workspace, reference: &str) -> String {
    workspace
        .show_ticket(reference)
        .ok()
        .and_then(|ticket| {
            Some(
                serde_json::to_value(ticket.status)
                    .ok()?
                    .as_str()?
                    .to_owned(),
            )
        })
        .unwrap_or_default()
}

fn links(workspace: &Workspace, chat_id: &str) -> Result<Vec<LinkedRecord>, ticketd_core::Error> {
    let records = workspace.chat_linked_records(chat_id)?;
    Ok(records
        .into_iter()
        .filter_map(|record| match (record.kind, record.reference) {
            (ChatLinkKind::Ticket, Some(reference)) => Some(LinkedRecord::Ticket {
                status: ticket_status(workspace, &reference),
                id: record.id,
                reference,
                title: record.title,
            }),
            (ChatLinkKind::Document, _) => Some(LinkedRecord::Document {
                id: record.id,
                title: record.title,
            }),
            // The Chat screens link tickets and Documents only.
            (ChatLinkKind::Ticket | ChatLinkKind::Project, _) => None,
        })
        .collect())
}

fn surroundings(workspace: &Workspace, chat: &Chat) -> Result<Surroundings, ticketd_core::Error> {
    let mut shared_with = Vec::new();
    for filter in [ChatListFilter::Active, ChatListFilter::Archived] {
        for other in workspace.list_chats(filter)? {
            if other.id != chat.id && other.execution_folder == chat.execution_folder {
                shared_with.push(other.title.unwrap_or("Untitled Chat".to_owned()));
            }
        }
    }
    Ok(Surroundings {
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
    notices: u64,
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
    host: Mutex<Option<ChatHost>>,
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
            host: Mutex::new(None),
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

    /// Differs whenever a list row or the counts could differ.
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
            Some(host) if !enabled => host.stop_all().await,
            _ => Vec::new(),
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
                &surroundings(&workspace, &chat)?,
            ));
        }
        Ok(summaries)
    }

    pub fn list(&self, scope: ChatListFilter) -> Outcome<Vec<Summary>> {
        self.host()?;
        self.summaries(scope)
    }

    pub fn overview(&self) -> Outcome<Overview> {
        let mut overview = Overview {
            needs_you: 0,
            working: 0,
        };
        if !self.enabled() {
            return Ok(overview);
        }
        for filter in [ChatListFilter::Active, ChatListFilter::Archived] {
            for summary in self.summaries(filter)? {
                overview.needs_you += usize::from(summary.needs_you);
                overview.working += usize::from(matches!(summary.activity, "working" | "waiting"));
            }
        }
        Ok(overview)
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

    pub async fn create(&self, input: NewChatInput) -> Outcome<String> {
        let host = self.host()?;
        text_argument(&input.message, "The message")?;
        let served = |adapter: &Arc<dyn HarnessAdapter>| harness_key(adapter.harness());
        if !self.adapters.iter().any(|a| served(a) == input.harness_id) {
            return Err(failed(self.unavailable(&input.harness_id)));
        }
        let mut workspace = self.workspace()?;
        let (execution_folder, folder_managed) = match &input.folder {
            Some(path) => (folder_argument(path)?, false),
            None => {
                // Beside the workspace file, one per Chat, and never removed by ticketd.
                let folder = PathBuf::from(format!("{}.chats", workspace.workspace_info()?.path))
                    .join(uuid::Uuid::new_v4().to_string());
                std::fs::create_dir_all(&folder).map_err(|error| {
                    failed(format!(
                        "could not create the Chat's folder {}: {error}",
                        folder.display()
                    ))
                })?;
                (folder.to_string_lossy().into_owned(), true)
            }
        };
        let first_line = input.message.trim().lines().next().unwrap_or_default();
        let chat = workspace.create_chat(
            None,
            NewChat {
                title: Some(first_line.chars().take(80).collect()),
                harness: input.harness_id,
                execution_folder,
                folder_managed,
                links: input.links.into_iter().map(ChatLink::from).collect(),
            },
        )?;
        drop(workspace);
        host.send(&chat.id, None, &input.message, SendMode::Auto)
            .await?;
        Ok(chat.id)
    }

    fn fresh(&self, chat_id: &str) -> Option<FreshHistory> {
        lock(&self.fresh).get(chat_id).copied()
    }

    fn state(&self, view: &View) -> Outcome<ChatState> {
        let around = surroundings(&self.workspace()?, &view.chat)?;
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
            &surroundings(&workspace, &chat)?,
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
            notices: 0,
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
                Some(ChatUpdate::Notice(text)) => {
                    view.notices += 1;
                    let item = Item::Marker {
                        id: format!("notice:{}", view.notices),
                        at: String::new(),
                        reason: "note",
                        message: Some(text),
                    };
                    if !send(&mut view, json!({ "kind": "item", "item": item })) {
                        return;
                    }
                    continue;
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
        let attempt = messages(&workspace, chat_id)?
            .into_iter()
            .find(|message| message.id == message_id)
            .and_then(|message| message.attempts.into_iter().next_back())
            .filter(|attempt| attempt.delivery == ChatDelivery::Uncertain)
            .ok_or_else(|| stale("this message is no longer waiting for your decision"))?;
        // The core keeps one open attempt per input, so the uncertain one is closed as
        // the person decided; its detail keeps that the first delivery is unknown.
        let detail = match decision {
            UncertainDecision::Resend => {
                "you chose to send it again; whether the first attempt arrived is unknown"
            }
            UncertainDecision::Discard => {
                "you discarded it; whether the first attempt arrived is unknown"
            }
        };
        workspace.record_chat_observations(
            chat_id,
            vec![ChatObservation::SubmissionNotDelivered {
                attempt_id: attempt.id,
                detail: Some(detail.to_owned()),
            }],
        )?;
        match decision {
            UncertainDecision::Discard => {
                workspace.withdraw_chat_input(chat_id, message_id)?;
                host.notify_changed(chat_id).await?;
                self.resync(chat_id);
            }
            UncertainDecision::Resend => {
                host.notify_changed(chat_id).await?;
                host.resume_queue(chat_id).await?;
                if !self.live(chat_id).running {
                    host.resume(chat_id, ResumeMode::Native).await?;
                }
            }
        }
        Ok(())
    }

    /// Probes the Chat's harness again and, when it is usable and the Chat was stopped
    /// by a failed start, tries that start again. No input is sent by this.
    pub async fn check_again(&self, chat_id: &str) -> Outcome<()> {
        let host = self.host()?;
        let chat = self.workspace()?.chat(chat_id)?;
        let (id, name) = HARNESSES
            .into_iter()
            .find(|(id, _)| *id == chat.harness)
            .ok_or_else(|| failed(format!("unknown harness '{}'", chat.harness)))?;
        let status = harness_status(id, name, host.inspect(id).await?);
        if status.status != "ready" {
            return Err(failed(status.message.unwrap_or_default()));
        }
        if matches!(
            self.live(chat_id).problem,
            Some(ChatProblem::OpenFailed { .. })
        ) {
            host.resume(chat_id, ResumeMode::Native).await?;
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
        let tickets = tickets.into_iter().map(|ticket| LinkedRecord::Ticket {
            status: serde_json::to_value(ticket.status)
                .ok()
                .and_then(|status| Some(status.as_str()?.to_owned()))
                .unwrap_or_default(),
            id: ticket.id,
            reference: ticket.reference,
            title: ticket.title,
        });
        let documents = documents
            .into_iter()
            .map(|document| LinkedRecord::Document {
                id: document.id,
                title: document.heading,
            });
        Ok(tickets.chain(documents).collect())
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
        let sent: Vec<_> = messages(&workspace, chat_id)?
            .into_iter()
            .filter(|message| !message.queued)
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
                    ChatRole::User => "User",
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
