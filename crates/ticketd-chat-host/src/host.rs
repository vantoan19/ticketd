//! The host-facing Chat interface: one supervisor per Chat behind a small set of
//! commands and a subscription. A later step maps it onto Tauri commands and events.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use ticketd_core::{
    AutomationRun, AutomationRunStatus, ChatAttachmentContent, ChatInputChange, ChatInputReceipt,
    ChatLink, ChatMessage, ChatQueueEdit, ChatSnapshot, Error, PreparedChatInput, WorkspaceGuard,
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, mpsc, oneshot, watch};
use tokio::time::timeout;

use crate::supervisor::{Command, Reply, Supervisor, bounded_close};
use crate::unattended::{UnattendedChat, set_aside_first_message};
use crate::{
    ContextUsage, HarnessAdapter, HarnessCommand, HarnessOptions, HarnessRuntime, HarnessSettings,
    Inspection, InteractionAnswer, InteractionKind, Problem, ProblemKind, SettingKey,
    SettingOutcome, StartSettings, SteeringBehavior, Subscription,
};
use crate::{StopReason, TurnEnding};

/// Provisional bounds, to be measured in #267.
pub const TEXT_UPDATE_INTERVAL: Duration = Duration::from_millis(100);
pub const TEXT_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(1);
/// How long Stop waits for the turn to end before reporting it unconfirmed.
pub const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound for each cleanup step (interrupt, final event, exit) when a runtime is stopped.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an adapter waits for its process to exit before killing it. It stays below
/// `CLOSE_TIMEOUT`, so the kill has happened by the time the supervisor stops waiting.
pub const ADAPTER_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const _: () = assert!(ADAPTER_CLOSE_TIMEOUT.as_millis() < CLOSE_TIMEOUT.as_millis());
/// How long one write to a harness may take before the harness counts as not reading.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a harness check waits for sign-in and its options before it reports
/// what it found without them.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a written new turn may go without any confirmation before its delivery is
/// recorded as uncertain and the Chat stops showing as working. Provisional (#267).
pub const DELIVERY_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(120);
/// History items in the snapshot a view receives on attach.
pub const SNAPSHOT_ITEMS: usize = 200;

/// Lends the workspace for one short operation, as every other desktop command has it:
/// from the desktop's warm session (ADR 0016), which lets go of the file for a restore.
pub type WorkspaceOpener = Arc<dyn Fn() -> Result<WorkspaceGuard, Error> + Send + Sync>;

/// The ticketd context for a Chat (see `context::for_chat`), read when a harness
/// session starts. `Ok(None)` sends nothing; an error is told to the person and the
/// session starts without context. It may block, so it runs off the async threads.
pub type ContextSource = Arc<dyn Fn(&str) -> Result<Option<String>, String> + Send + Sync>;

/// The name of the tool record that keeps the context text a session was started with,
/// so the transcript shows what the agent was given apart from the person's words.
pub const CONTEXT_RECORD_NAME: &str = "ticketd context";

pub use ticketd_core::AGENT_CHANGES_RECORD_NAME;

/// The detail recorded on a turn ticketd itself stopped on Quit (see [`crate::StopReason`]).
pub const STOPPED_BY_TICKETD: &str = "ticketd stopped this Chat";

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// The core refused the request; nothing is wrong with storage.
    #[error(transparent)]
    Core(Error),
    #[error(
        "Chat storage failed: {0}. No new work is accepted; work already sent may have continued"
    )]
    StorageFailed(String),
    #[error("this request is no longer waiting for an answer")]
    InteractionExpired,
    #[error("contact with the harness was lost; whether the answer arrived is unknown")]
    ContactLost,
    #[error(
        "The Chat is waiting for the previous harness to exit. Tools it started may still be running."
    )]
    PermissionRestartCleanupUnconfirmed,
    #[error("{}", .0.message)]
    Harness(Problem),
    #[error("no adapter is available for harness '{0}'")]
    HarnessUnavailable(String),
    #[error("that sub-agent is not running")]
    SubAgentGone,
    #[error("the harness did not stop the sub-agent: {0}")]
    SubAgentNotStopped(String),
    #[error("the Chat is already starting its harness")]
    Busy,
    #[error("the Chat is working; try again when it has finished")]
    Working,
    #[error("ticketd is quitting")]
    Quitting,
    #[error("the workspace is being restored from a backup; try again when it has finished")]
    Restoring,
    #[error("Chat is turned off")]
    TurnedOff,
}

impl From<Error> for HostError {
    fn from(error: Error) -> Self {
        if is_refusal(&error) {
            Self::Core(error)
        } else {
            Self::StorageFailed(error.to_string())
        }
    }
}

/// Errors that mean the core rejected one request, as opposed to storage failing.
pub(crate) fn is_refusal(error: &Error) -> bool {
    matches!(
        error,
        Error::Chat(_)
            | Error::ChatNotFound(_)
            | Error::ChatTrashed(_)
            | Error::ChatSubmissionUnresolved(_)
            | Error::RequestConflict(_)
            | Error::UploadLimit { .. }
            | Error::NotFound(_)
            | Error::DocumentNotFound(_)
            | Error::ProjectNotFound(_)
            | Error::ProjectArchived(_)
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendMode {
    /// Start a turn when idle; steer the active turn when the harness supports
    /// steering; otherwise queue.
    Auto,
    /// Save to the visible queue without steering.
    Queue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeMode {
    /// Reopen the Chat's native session in a replacement process.
    Native,
    /// Start a new native session for the same Chat. `history` is the text the person
    /// selected; it is prepended to the next input and nothing is replayed.
    FreshSession { history: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Idle,
    Working,
    WaitingForYou,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopState {
    Requested,
    /// The harness accepted the interruption; the turn has not ended yet.
    Acknowledged,
    /// No confirmation arrived in time. Tools may still be running.
    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatProblem {
    RuntimeLost {
        detail: String,
    },
    /// The harness did not start. After a failed native resume, offer a fresh session.
    OpenFailed {
        problem: Problem,
        native_resume: bool,
    },
    /// The harness did not accept a new turn; the input is back in the queue.
    DispatchRefused {
        detail: String,
    },
    StorageFailed {
        detail: String,
    },
    /// Stopping the harness could not be confirmed; processes may remain.
    CleanupUnconfirmed {
        reason: String,
    },
}

/// A request that can be answered right now. Stored interactions are history only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveInteraction {
    pub interaction_id: String,
    pub kind: InteractionKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatLive {
    pub activity: Activity,
    /// A provider process is running for this Chat.
    pub running: bool,
    /// How many sub-agents run now (nested ones too). With no turn they hold the Chat
    /// working: `activity` is `Working` and the person's Stop stops them.
    pub sub_agents: usize,
    /// The last sub-agent just finished with no turn running, and the main agent is about to
    /// resume, by itself or because ticketd tells it so: still working, with no turn yet.
    pub waking: bool,
    /// Work waits on a harness session that has not started a turn yet, and how that
    /// session opens. A process alone is not a working session: the harness can take
    /// seconds after it starts before the first turn runs.
    pub opening: Option<ticketd_core::ChatSessionOrigin>,
    /// What steering does when a send would steer; `None` means a send queues.
    pub steering: Option<SteeringBehavior>,
    /// Whether a known model restriction rules an image out of the running turn.
    pub steering_images_refused: bool,
    /// A new turn was handed to the harness and nothing confirmed it yet.
    pub delivery_unconfirmed: bool,
    /// Input the person sent that is held to go out as soon as the session can take it,
    /// in order. It waits for no queue; see `ChatMessage::standing_while`.
    pub sending: Vec<String>,
    /// Queued input IDs held from automatic dispatch until their edits are adopted.
    pub prepared_queue_edits: HashSet<String>,
    pub interactions: Vec<LiveInteraction>,
    pub stop: Option<StopState>,
    pub problem: Option<ChatProblem>,
    /// The live session's last context report; a new session starts without one.
    pub context: Option<ContextReport>,
    /// The live session's settings, when its harness reported them. Boxed: it is
    /// large and most updates do not carry it changed.
    pub settings: Option<Box<LiveSettings>>,
    /// The slash commands the live session's harness lists; empty when it lists none.
    pub commands: Vec<HarnessCommand>,
}

impl ChatLive {
    /// A Chat with nothing running and nothing asked.
    pub fn idle() -> Self {
        Self {
            activity: Activity::Idle,
            running: false,
            sub_agents: 0,
            waking: false,
            opening: None,
            steering: None,
            steering_images_refused: false,
            delivery_unconfirmed: false,
            sending: Vec::new(),
            prepared_queue_edits: HashSet::new(),
            interactions: Vec::new(),
            stop: None,
            problem: None,
            context: None,
            settings: None,
            commands: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextReport {
    pub usage: ContextUsage,
    /// When it was reported, in milliseconds since the Unix epoch.
    pub at: i64,
    /// When the session last compacted its context, if it did since it started.
    pub compacted_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSettings {
    pub reported: HarnessSettings,
    /// The latest change the person asked for, per setting.
    pub changes: Vec<LiveSettingChange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSettingChange {
    pub setting: SettingKey,
    pub value: String,
    pub state: SettingChangeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingChangeState {
    /// Held while a turn runs; it is sent when the turn ends.
    Held,
    /// Sent to the harness; no answer yet.
    Sent,
    Done(SettingOutcome),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatView {
    pub snapshot: ChatSnapshot,
    pub live: ChatLive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnconfirmedCleanup {
    pub chat_id: String,
    pub reason: String,
}

/// A Chat's unattended harness that `end_unattended` closed.
#[derive(Clone)]
pub(crate) struct Closed {
    /// Why its shutdown could not be confirmed, if it could not.
    unconfirmed: Option<String>,
}

#[derive(Clone)]
pub struct ChatHost {
    inner: Arc<Inner>,
}

/// What every Chat's supervisor last reported, for readers that have no view attached:
/// the Chats list, the counts, and the checks before Quit or turning Chat off.
pub(crate) struct Board {
    /// Each entry with the supervisor that reported it (see `report`).
    live: Mutex<HashMap<String, (u64, ChatLive)>>,
    changed: watch::Sender<u64>,
    /// One signal per Chat that something is waiting on (an Automation run's agent), so
    /// the wait wakes for its own Chat and not for every Chat's every step.
    signals: Mutex<HashMap<String, watch::Sender<u64>>>,
}

impl Board {
    pub(crate) fn new() -> Self {
        Self {
            live: Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
            signals: Mutex::new(HashMap::new()),
        }
    }

    fn live(&self) -> MutexGuard<'_, HashMap<String, (u64, ChatLive)>> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn snapshot(&self) -> HashMap<String, ChatLive> {
        self.live()
            .iter()
            .map(|(chat_id, (_, live))| (chat_id.clone(), live.clone()))
            .collect()
    }

    /// Called by a supervisor after each step; `None` once it has stopped.
    /// `supervisor` increases with each supervisor started, so a late report from
    /// one that was still stopping can't replace or clear its replacement's entry.
    pub(crate) fn report(&self, chat_id: &str, supervisor: u64, live: Option<ChatLive>) {
        {
            let mut board = self.live();
            let current = board.get(chat_id).map(|(owner, _)| *owner);
            match live {
                Some(live) if current.is_none_or(|owner| owner <= supervisor) => {
                    board.insert(chat_id.to_owned(), (supervisor, live));
                }
                None if current == Some(supervisor) => {
                    board.remove(chat_id);
                }
                _ => return,
            }
        }
        self.changed
            .send_modify(|count| *count = count.wrapping_add(1));
        self.notify(chat_id);
    }

    fn signals(&self) -> MutexGuard<'_, HashMap<String, watch::Sender<u64>>> {
        self.signals.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Wakes whoever waits on this Chat. Called when its supervisor reports and when
    /// its unattended running ends.
    pub(crate) fn notify(&self, chat_id: &str) {
        if let Some(signal) = self.signals().get(chat_id) {
            signal.send_modify(|count| *count = count.wrapping_add(1));
        }
    }

    /// Starts listening for this Chat; a change from now on wakes the receiver.
    pub(crate) fn listen(&self, chat_id: &str) -> watch::Receiver<u64> {
        self.signals()
            .entry(chat_id.to_owned())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }

    /// Stops keeping a signal for this Chat once nothing waits on it.
    pub(crate) fn stop_listening(&self, chat_id: &str) {
        self.signals().remove(chat_id);
    }
}

struct Inner {
    open_workspace: WorkspaceOpener,
    context: Option<ContextSource>,
    board: Arc<Board>,
    adapters: HashMap<&'static str, Arc<dyn HarnessAdapter>>,
    chats: Mutex<HashMap<String, mpsc::Sender<Command>>>,
    /// The settings of each Chat that is running unattended, read when its
    /// supervisor starts.
    unattended: Mutex<HashMap<String, Arc<UnattendedChat>>>,
    prompt_fences: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    taking_over: Mutex<HashMap<String, Vec<watch::Receiver<bool>>>>,
    closing_agents: Mutex<HashMap<String, watch::Receiver<Option<Closed>>>>,
    lifecycle: Arc<HostLifecycle>,
}

struct TakeOver {
    host: ChatHost,
    chat_id: String,
    siblings: Vec<String>,
    finished: watch::Sender<bool>,
}

impl TakeOver {
    /// The caller holds the route lock from commit through installing these gates.
    fn cover_steps(&mut self, run: &AutomationRun) {
        let mut taking_over = self.host.taking_over();
        for chat_id in run.steps.iter().filter_map(|step| step.chat_id.as_ref()) {
            if *chat_id != self.chat_id && !self.siblings.contains(chat_id) {
                taking_over
                    .entry(chat_id.clone())
                    .or_default()
                    .push(self.finished.subscribe());
                self.siblings.push(chat_id.clone());
            }
        }
    }
}

impl Drop for TakeOver {
    fn drop(&mut self) {
        let mut taking_over = self.host.taking_over();
        let done = self.finished.subscribe();
        for chat_id in std::iter::once(&self.chat_id).chain(&self.siblings) {
            if let Some(gates) = taking_over.get_mut(chat_id) {
                gates.retain(|gate| !gate.same_channel(&done));
                if gates.is_empty() {
                    taking_over.remove(chat_id);
                }
            }
        }
        self.finished.send_replace(true);
    }
}

struct RetiredRuntime {
    handle: Arc<dyn HarnessRuntime>,
    blocks_restore: bool,
}

/// Eligibility and process cleanup outlive any one supervisor.
#[derive(Default)]
pub(crate) struct HostLifecycle {
    quitting: AtomicBool,
    /// Set while the workspace is being replaced by a backup. Checked where `quitting`
    /// is, so every clone of the host refuses to start or reach a supervisor.
    restoring: AtomicBool,
    /// Detached Prompt work must never cross a restore into a replacement file.
    workspace_generation: AtomicU64,
    /// Set while Chat is switched off in Settings, for the same reason.
    off: AtomicBool,
    // Only the old process handle survives Restore. The next supervisor reads
    // the Chat, its settings and its queue from the current Workspace.
    retired_permission_runtimes: Mutex<HashMap<String, RetiredRuntime>>,
    pending_open_cleanup: Mutex<HashSet<String>>,
}

impl HostLifecycle {
    pub(crate) fn workspace_generation(&self) -> u64 {
        self.workspace_generation.load(Ordering::SeqCst)
    }

    pub(crate) fn serves_workspace_generation(&self, generation: u64) -> bool {
        self.serving().is_ok() && self.workspace_generation() == generation
    }

    pub(crate) fn is_off(&self) -> bool {
        self.off.load(Ordering::SeqCst)
    }

    pub(crate) fn serving(&self) -> Result<(), HostError> {
        if self.quitting.load(Ordering::SeqCst) {
            return Err(HostError::Quitting);
        }
        if self.restoring.load(Ordering::SeqCst) {
            return Err(HostError::Restoring);
        }
        if self.is_off() {
            return Err(HostError::TurnedOff);
        }
        Ok(())
    }

    fn pending_open_cleanup(&self) -> MutexGuard<'_, HashSet<String>> {
        self.pending_open_cleanup
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn has_pending_open_cleanup(&self, chat_id: &str) -> bool {
        self.pending_open_cleanup().contains(chat_id)
    }

    pub(crate) fn hold_pending_open_cleanup(&self, chat_id: &str) {
        self.pending_open_cleanup().insert(chat_id.to_owned());
    }

    pub(crate) fn release_pending_open_cleanup(&self, chat_id: &str) {
        self.pending_open_cleanup().remove(chat_id);
    }

    fn retired_permission_runtimes(&self) -> MutexGuard<'_, HashMap<String, RetiredRuntime>> {
        self.retired_permission_runtimes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn has_retired_permission_runtime(&self, chat_id: &str) -> bool {
        self.retired_permission_runtimes().contains_key(chat_id)
    }

    pub(crate) fn has_runtime_cleanup(&self, chat_id: &str) -> bool {
        // A late open retires its handle before releasing the pending-open hold.
        self.has_pending_open_cleanup(chat_id) || self.has_retired_permission_runtime(chat_id)
    }

    pub(crate) fn retire_runtime(
        &self,
        chat_id: &str,
        handle: Arc<dyn HarnessRuntime>,
        blocks_restore: bool,
    ) {
        self.retired_permission_runtimes().insert(
            chat_id.to_owned(),
            RetiredRuntime {
                handle,
                blocks_restore,
            },
        );
    }

    async fn confirm_restore_cleanup(&self) -> Result<Vec<String>, UnconfirmedCleanup> {
        let mut retired = {
            // A late startup retires a live handle before clearing its open
            // marker. This snapshot sees unfinished cleanup in either place.
            let opens = self.pending_open_cleanup();
            if let Some(chat_id) = opens.iter().min() {
                return Err(UnconfirmedCleanup {
                    chat_id: chat_id.clone(),
                    reason: "a harness is still opening or stopping".to_owned(),
                });
            }
            self.retired_permission_runtimes()
                .iter()
                .filter(|(_, runtime)| runtime.blocks_restore)
                .map(|(chat_id, _)| chat_id.clone())
                .collect::<Vec<_>>()
        };
        retired.sort_unstable();
        for chat_id in &retired {
            if let Some(reason) = self.close_retired_permission_runtime(chat_id).await {
                return Err(UnconfirmedCleanup {
                    chat_id: chat_id.clone(),
                    reason,
                });
            }
        }
        Ok(retired)
    }

    fn stopping_for_workspace(&self) -> bool {
        self.restoring.load(Ordering::SeqCst) || self.quitting.load(Ordering::SeqCst)
    }

    pub(crate) async fn close_retired_permission_runtime(&self, chat_id: &str) -> Option<String> {
        let handle = self
            .retired_permission_runtimes()
            .get(chat_id)?
            .handle
            .clone();
        let unconfirmed = bounded_close(handle.as_ref()).await;
        if unconfirmed.is_none() {
            let mut retired = self.retired_permission_runtimes();
            if retired
                .get(chat_id)
                .is_some_and(|current| Arc::ptr_eq(&current.handle, &handle))
            {
                retired.remove(chat_id);
            }
        }
        unconfirmed
    }
}

impl ChatHost {
    /// Starts the host. Stored state from an earlier process has no runtime behind it,
    /// so it is reconciled as lost contact before anything runs.
    pub fn new(
        open_workspace: WorkspaceOpener,
        adapters: Vec<Arc<dyn HarnessAdapter>>,
    ) -> Result<Self, HostError> {
        Self::with_context(open_workspace, adapters, None)
    }

    /// As `new`, giving each new harness session the ticketd context from `context`.
    pub fn with_context(
        open_workspace: WorkspaceOpener,
        adapters: Vec<Arc<dyn HarnessAdapter>>,
        context: Option<ContextSource>,
    ) -> Result<Self, HostError> {
        let restarted = TurnEnding::ContactLost(Some("ticketd was restarted".to_owned()));
        open_workspace()?.mark_chat_contact_lost(
            None,
            &restarted.detail().unwrap_or_default(),
            &restarted.key(),
        )?;
        Ok(Self {
            inner: Arc::new(Inner {
                open_workspace,
                context,
                board: Arc::new(Board::new()),
                adapters: adapters
                    .into_iter()
                    .map(|adapter| (adapter.harness().key.as_str(), adapter))
                    .collect(),
                chats: Mutex::new(HashMap::new()),
                unattended: Mutex::new(HashMap::new()),
                prompt_fences: Mutex::new(HashMap::new()),
                taking_over: Mutex::new(HashMap::new()),
                closing_agents: Mutex::new(HashMap::new()),
                lifecycle: Arc::new(HostLifecycle::default()),
            }),
        })
    }

    /// Live state of every Chat that has a supervisor. A Chat that is absent is idle
    /// with no harness process.
    pub fn live(&self) -> HashMap<String, ChatLive> {
        self.inner.board.snapshot()
    }

    /// Moves whenever any Chat's records or live state may have changed. It can move
    /// without a visible difference, so readers compare what they show.
    pub fn changed(&self) -> watch::Receiver<u64> {
        self.inner.board.changed.subscribe()
    }

    /// Starts listening for changes to one Chat only; see `Board::listen`.
    pub(crate) fn listen(&self, chat_id: &str) -> watch::Receiver<u64> {
        self.inner.board.listen(chat_id)
    }

    pub(crate) fn stop_listening(&self, chat_id: &str) {
        self.inner.board.stop_listening(chat_id);
    }

    pub async fn inspect(&self, harness: &str) -> Result<Inspection, HostError> {
        let adapter = self
            .inner
            .adapters
            .get(harness)
            .ok_or_else(|| HostError::HarnessUnavailable(harness.to_owned()))?;
        Ok(adapter.inspect().await)
    }

    /// A snapshot and the updates that follow it. Attaching never starts a harness.
    pub async fn attach(&self, chat_id: &str) -> Result<(ChatView, Subscription), HostError> {
        self.attach_with_history(chat_id, None, false).await
    }

    /// Reconnect from the same first history item, optionally extending the window.
    pub async fn attach_with_history(
        &self,
        chat_id: &str,
        start: Option<i64>,
        load_earlier: bool,
    ) -> Result<(ChatView, Subscription), HostError> {
        self.ask(chat_id, |reply| Command::Attach {
            start,
            load_earlier,
            reply,
        })
        .await
    }

    /// Checks static attachment constraints without opening a harness.
    pub fn check_attachment_input(
        &self,
        harness: &str,
        attachments: &[ChatAttachmentContent],
    ) -> Result<(), HostError> {
        if attachments.is_empty() {
            return Ok(());
        }
        let adapter = self
            .inner
            .adapters
            .get(harness)
            .ok_or_else(|| HostError::HarnessUnavailable(harness.to_owned()))?;
        match adapter.attachment_refusal(attachments) {
            Some(refusal) => Err(refusal.attachment_error().into()),
            None => Ok(()),
        }
    }

    /// The person's message. Saves the input, then dispatches, steers or queues it.
    /// Returns once it is saved; delivery is reported through the Chat's records.
    /// A reply and the takeover of its Automation run are saved together.
    pub async fn send(
        &self,
        chat_id: &str,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
    ) -> Result<ChatMessage, HostError> {
        self.send_with_attachments(chat_id, command_id, text, mode, Vec::new())
            .await
    }

    pub async fn send_with_attachments(
        &self,
        chat_id: &str,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
        attachments: Vec<ChatAttachmentContent>,
    ) -> Result<ChatMessage, HostError> {
        self.send_replacing(chat_id, command_id, text, mode, attachments, Vec::new())
            .await?
            .into_message()
            .map_err(HostError::from)
    }

    pub async fn send_replacing(
        &self,
        chat_id: &str,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
        attachments: Vec<ChatAttachmentContent>,
        replaces: Vec<String>,
    ) -> Result<ChatInputReceipt, HostError> {
        let edit = (!replaces.is_empty()).then_some(ChatQueueEdit {
            replaces,
            links: Vec::new(),
        });
        self.send_with_edit(chat_id, command_id, text, mode, attachments, edit)
            .await
    }

    pub async fn send_with_edit(
        &self,
        chat_id: &str,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
        attachments: Vec<ChatAttachmentContent>,
        edit: Option<ChatQueueEdit>,
    ) -> Result<ChatInputReceipt, HostError> {
        self.send_with_change(
            chat_id,
            command_id,
            text,
            mode,
            attachments,
            edit.map(ChatInputChange::Edit),
        )
        .await
    }

    /// Saves a person's links with their input before updating the harness context.
    pub async fn send_linking(
        &self,
        chat_id: &str,
        text: &str,
        mode: SendMode,
        attachments: Vec<ChatAttachmentContent>,
        links: Vec<ChatLink>,
    ) -> Result<ChatMessage, HostError> {
        self.send_with_change(
            chat_id,
            None,
            text,
            mode,
            attachments,
            Some(ChatInputChange::Link(links)),
        )
        .await?
        .into_message()
        .map_err(HostError::from)
    }

    async fn send_with_change(
        &self,
        chat_id: &str,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
        attachments: Vec<ChatAttachmentContent>,
        change: Option<ChatInputChange>,
    ) -> Result<ChatInputReceipt, HostError> {
        self.serving()?;
        if self.check_agent_cleanup(chat_id).is_err()
            && let Some(command_id) = command_id
        {
            let workspace = self.workspace()?;
            let receipt = workspace.read(|workspace| {
                let replay = if workspace.automation_chat_run_id(chat_id)?.is_some() {
                    ticketd_core::Workspace::replay_automation_chat_reply_with_change
                } else {
                    ticketd_core::Workspace::replay_chat_input_with_change
                };
                replay(
                    workspace,
                    command_id,
                    chat_id,
                    text,
                    &attachments,
                    change.as_ref(),
                )
            })?;
            if let Some(receipt) = receipt {
                return Ok(receipt);
            }
        }
        let run_id = self.workspace()?.automation_chat_run_id(chat_id)?;
        if let Some(run_id) = run_id {
            let mut gate = self.begin_take_over(chat_id)?;
            let saved = {
                let _prompt = self.wait_for_prompt_write(&run_id).await?;
                self.serving()?;
                let mut workspace = self.workspace()?;
                if let Some(harness) = workspace.automation_chat_harness(chat_id)? {
                    if let Err(refusal) = self.check_attachment_input(&harness, &attachments) {
                        if let Some(command_id) = command_id
                            && let Some(receipt) = workspace
                                .replay_automation_chat_reply_with_change(
                                    command_id,
                                    chat_id,
                                    text,
                                    &attachments,
                                    change.as_ref(),
                                )?
                        {
                            return Ok(receipt);
                        }
                        return Err(refusal);
                    }
                    let reply = PreparedChatInput::new(
                        command_id,
                        chat_id,
                        text,
                        &attachments,
                        change.as_ref(),
                    )?;
                    let _chats = self.chats();
                    self.serving()?;
                    let saved = workspace.save_prepared_automation_chat_reply(reply)?;
                    if let (_, Some(run)) = &saved {
                        gate.cover_steps(run);
                    }
                    Some(saved)
                } else {
                    None
                }
            };
            if let Some((receipt, run)) = saved {
                if let Some(run) = run {
                    let host = self.clone();
                    let chat_id = chat_id.to_owned();
                    let message_id = receipt.id.clone();
                    // The takeover still completes if the caller loses its reply.
                    tokio::spawn(async move {
                        let (_, unconfirmed) = host.finish_take_over(&chat_id, run).await;
                        if mode == SendMode::Auto
                            && !unconfirmed
                            && let Ok(commands) = host.sender_after_take_over(&gate)
                        {
                            // Keep later sends behind the saved reply while waiting for mailbox space.
                            let (reply, scheduled) = oneshot::channel();
                            let sent = commands
                                .send(Command::ScheduleSaved { message_id, reply })
                                .await;
                            drop(gate);
                            if sent.is_ok() {
                                let _ = scheduled.await;
                            }
                        }
                    })
                    .await
                    .map_err(|_| HostError::Quitting)?;
                }
                return Ok(receipt);
            }
        }
        let (command_id, text) = (command_id.map(str::to_owned), text.to_owned());
        self.ask(chat_id, |reply| Command::Send {
            command_id,
            text,
            mode,
            attachments,
            change,
            reply,
        })
        .await
    }

    /// Stops all agents of the run before allowing a new ordinary session.
    async fn finish_take_over(&self, chat_id: &str, run: AutomationRun) -> (bool, bool) {
        let mut closed = false;
        let mut unconfirmed = false;
        for step in run.steps.iter().filter_map(|step| step.chat_id.as_deref()) {
            let (_, result) = self.close_agent(step, StopReason::TakenOver).await;
            if let Some(result) = result {
                closed |= step == chat_id;
                unconfirmed |= result.unconfirmed.is_some();
            }
        }
        (closed, unconfirmed)
    }

    fn begin_take_over(&self, chat_id: &str) -> Result<TakeOver, HostError> {
        // Admission and supervisor routing use the same lock.
        let _chats = self.chats();
        self.serving()?;
        let mut taking_over = self.taking_over();
        if taking_over.contains_key(chat_id) {
            return Err(HostError::Working);
        }
        let (finished, done) = watch::channel(false);
        taking_over.insert(chat_id.to_owned(), vec![done]);
        Ok(TakeOver {
            host: self.clone(),
            chat_id: chat_id.to_owned(),
            siblings: Vec::new(),
            finished,
        })
    }

    pub(crate) fn prompt_fence(&self, run_id: &str) -> Arc<AsyncMutex<()>> {
        let mut fences = self
            .inner
            .prompt_fences
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        fences.retain(|_, fence| fence.strong_count() > 0);
        if let Some(fence) = fences.get(run_id).and_then(Weak::upgrade) {
            return fence;
        }
        let fence = Arc::new(AsyncMutex::new(()));
        fences.insert(run_id.to_owned(), Arc::downgrade(&fence));
        fence
    }

    async fn wait_for_prompt_write(&self, run_id: &str) -> Result<OwnedMutexGuard<()>, HostError> {
        timeout(CLOSE_TIMEOUT, self.prompt_fence(run_id).lock_owned())
            .await
            .map_err(|_| HostError::Working)
    }

    /// The person's Stop: pauses queue dispatch and asks the harness to interrupt the
    /// active turn. In the Chat of an Automation run that is going, it takes the run
    /// over, which stops the agent by closing its unattended harness. It means the
    /// person's Stop and nothing else: when ticketd closes an agent because its run
    /// ended, it uses `end_run_agents`.
    pub async fn stop(&self, chat_id: &str) -> Result<(), HostError> {
        let mut sibling_cleanup_unconfirmed = false;
        let run_id = self.workspace()?.automation_chat_run_id(chat_id)?;
        if let Some(run_id) = run_id {
            let mut gate = self.begin_take_over(chat_id)?;
            let run = {
                let _prompt = self.wait_for_prompt_write(&run_id).await?;
                self.serving()?;
                let mut workspace = self.workspace()?;
                let _chats = self.chats();
                self.serving()?;
                let run = workspace.take_over_automation_run(chat_id, false)?;
                if let Some(run) = &run {
                    gate.cover_steps(run);
                }
                run
            };
            if let Some(run) = run {
                let host = self.clone();
                let chat_id = chat_id.to_owned();
                // The committed takeover must close all run agents even if Stop's caller leaves.
                let (closed, unconfirmed) = tokio::spawn(async move {
                    let _gate = gate;
                    host.finish_take_over(&chat_id, run).await
                })
                .await
                .map_err(|_| HostError::Quitting)?;
                if closed {
                    return if unconfirmed {
                        Err(HostError::PermissionRestartCleanupUnconfirmed)
                    } else {
                        Ok(())
                    };
                }
                sibling_cleanup_unconfirmed = unconfirmed;
            }
        }
        self.ask(chat_id, Command::Stop).await?;
        if sibling_cleanup_unconfirmed
            || (self.closing_agents().contains_key(chat_id)
                && self.inner.lifecycle.has_runtime_cleanup(chat_id))
        {
            return Err(HostError::PermissionRestartCleanupUnconfirmed);
        }
        Ok(())
    }

    /// The person's Stop for one sub-agent, by its native ID: it and what it started stop,
    /// and the main agent and every other sub-agent run on. Refused as
    /// [`HostError::SubAgentGone`] when it does not run now (or runs in the foreground,
    /// where it ends with its turn).
    pub async fn stop_sub_agent(&self, chat_id: &str, native_id: &str) -> Result<(), HostError> {
        let native_id = native_id.to_owned();
        self.ask(chat_id, |reply| Command::StopSubAgent { native_id, reply })
            .await
    }

    /// Closes the agents an Automation run had working in `chat_ids`, because ticketd
    /// ended the run (the person stopped it, turned its Automation off or deleted
    /// it): each unattended harness is closed, after an open in progress, which also
    /// ends the wait in `run_unattended`, and the turn it ends is recorded as
    /// `StopReason::RunEnded`. An interrupt alone would miss a turn not begun
    /// (#387 M4). A Chat that is no longer unattended, because the person took it
    /// over meanwhile, is left alone. Returns the harnesses whose shutdown could not
    /// be confirmed.
    pub async fn end_run_agents(&self, chat_ids: &[String]) -> Vec<UnconfirmedCleanup> {
        let mut unconfirmed = Vec::new();
        for chat_id in chat_ids {
            if let Some(Closed {
                unconfirmed: Some(reason),
            }) = self.end_unattended(chat_id, StopReason::RunEnded).await
            {
                unconfirmed.push(UnconfirmedCleanup {
                    chat_id: chat_id.clone(),
                    reason,
                });
            }
        }
        unconfirmed
    }

    /// Lets queued input dispatch again after Stop or a problem.
    pub async fn resume_queue(&self, chat_id: &str) -> Result<(), HostError> {
        self.ask(chat_id, Command::ResumeQueue).await
    }

    /// Sends one queued input now, alone: it steers the turn in progress or starts one,
    /// and a paused queue stays paused. Refused with `Working` while a turn that cannot
    /// be steered runs. Returns once it is held to send; delivery is reported as usual.
    pub async fn send_queued_now(&self, chat_id: &str, message_id: &str) -> Result<(), HostError> {
        let message_id = message_id.to_owned();
        self.ask(chat_id, |reply| Command::SendQueuedNow {
            message_id,
            reply,
        })
        .await
    }

    /// Reads a queued message and its snapshots, holding it from automatic dispatch.
    /// A delivered preparation is released by confirmation, Resume, Send now, or removal.
    pub async fn prepare_queue_edit(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> Result<(String, Vec<ChatAttachmentContent>), HostError> {
        let message_id = message_id.to_owned();
        self.ask(chat_id, |reply| Command::PrepareQueueEdit {
            message_id,
            reply,
        })
        .await
    }

    /// Holds the original message and snapshots after the composer accepts them.
    /// The original is excluded from dispatch and remains until a replacement saves
    /// or the person removes it.
    pub async fn confirm_queue_edit(
        &self,
        chat_id: &str,
        message_id: &str,
        transfer_id: &str,
    ) -> Result<bool, HostError> {
        self.ask(chat_id, |reply| Command::ConfirmQueueEdit {
            message_id: message_id.to_owned(),
            transfer_id: transfer_id.to_owned(),
            reply,
        })
        .await
    }

    pub async fn respond(
        &self,
        chat_id: &str,
        interaction_id: &str,
        answer: InteractionAnswer,
    ) -> Result<(), HostError> {
        let interaction_id = interaction_id.to_owned();
        self.ask(chat_id, |reply| Command::Respond {
            interaction_id,
            answer,
            reply,
        })
        .await
    }

    /// Asks the live session to use `value` for `setting` from the next turn. While a
    /// turn runs the change is held and sent when it ends, so every turn runs on one
    /// set of settings. Returns where the change stands; later states are in
    /// `ChatLive::settings`. A value the harness did not offer, or does not allow, is
    /// refused without being sent.
    pub async fn change_setting(
        &self,
        chat_id: &str,
        setting: SettingKey,
        value: &str,
    ) -> Result<SettingChangeState, HostError> {
        // An unattended session runs on its agent's settings and is never widened:
        // the person takes the run over (a reply or Stop) before changing anything.
        if self.is_unattended(chat_id) {
            return Ok(SettingChangeState::Done(SettingOutcome::Refused {
                reason:
                    "An Automation is running this Chat. Reply or stop it to take it over first."
                        .to_owned(),
            }));
        }
        let value = value.to_owned();
        self.ask(chat_id, |reply| Command::ChangeSetting {
            setting,
            value,
            reply,
        })
        .await
    }

    /// Opens the Chat's next new session with the person's New Chat picks. Sent before
    /// the first message, so its first turn already uses them.
    pub async fn start_with(
        &self,
        chat_id: &str,
        settings: StartSettings,
    ) -> Result<(), HostError> {
        self.sender(chat_id)?
            .send(Command::StartWith(settings))
            .await
            .map_err(|_| HostError::Quitting)
    }

    /// What the harness offers before any session: models, efforts, permissions.
    pub async fn options(
        &self,
        harness: &str,
    ) -> Result<Result<HarnessOptions, String>, HostError> {
        let adapter = self
            .inner
            .adapters
            .get(harness)
            .ok_or_else(|| HostError::HarnessUnavailable(harness.to_owned()))?;
        Ok(adapter.options().await)
    }

    pub async fn skills(
        &self,
        harness: &str,
        folder: &std::path::Path,
    ) -> Result<Result<Vec<crate::HarnessSkill>, String>, HostError> {
        let adapter = self
            .inner
            .adapters
            .get(harness)
            .ok_or_else(|| HostError::HarnessUnavailable(harness.to_owned()))?;
        Ok(adapter.skills(folder).await)
    }

    /// Sends input again although its first delivery is uncertain, because the person
    /// asked for exactly that. Only that input is dispatched, as a new submission, and
    /// the queue is left paused. Refused while the Chat is working.
    pub async fn resend(&self, chat_id: &str, message_id: &str) -> Result<(), HostError> {
        let message_id = message_id.to_owned();
        self.ask(chat_id, |reply| Command::Resend { message_id, reply })
            .await
    }

    /// Starts a replacement process. Never called automatically after a failure.
    pub async fn resume(&self, chat_id: &str, mode: ResumeMode) -> Result<(), HostError> {
        self.ask(chat_id, |reply| Command::Resume { mode, reply })
            .await
    }

    /// Moves the Chat to the trash and stops its work. Returns why cleanup could not be
    /// confirmed, if it could not.
    pub async fn trash(&self, chat_id: &str) -> Result<Option<String>, HostError> {
        self.ask(chat_id, Command::Trash).await
    }

    /// Publishes Chat changes written directly through the core (title, links, folder,
    /// archive, restore) to attached views.
    pub async fn notify_changed(&self, chat_id: &str) -> Result<(), HostError> {
        self.sender(chat_id)?
            .send(Command::Changed)
            .await
            .map_err(|_| HostError::Quitting)
    }

    /// After the Chat's links were changed through the core: a live session is given the
    /// new context with its next new turn, and a resumed one when it differs from what it
    /// was given. Views are told as for `notify_changed`.
    pub async fn links_changed(&self, chat_id: &str) -> Result<(), HostError> {
        self.sender(chat_id)?
            .send(Command::LinksChanged)
            .await
            .map_err(|_| HostError::Quitting)
    }

    /// Chat was switched off: refuses every request that would reach or start a
    /// supervisor, on every clone of this host, then stops every running Chat.
    pub async fn turn_off(&self) -> Vec<UnconfirmedCleanup> {
        self.inner.lifecycle.off.store(true, Ordering::SeqCst);
        self.stop_all(StopReason::TurnedOff).await
    }

    /// Chat was switched on again. A pending permission restart still requires
    /// confirmed exit of the previous harness before it can open a replacement.
    pub fn turn_on(&self) {
        self.inner.lifecycle.off.store(false, Ordering::SeqCst);
    }

    /// Stops every running Chat with bounded cleanup and keeps the host usable.
    pub async fn stop_all(&self, why: StopReason) -> Vec<UnconfirmedCleanup> {
        let turning_off = why == StopReason::TurnedOff;
        let (chats, closing, taking_over) = {
            // Detachment and takeover admission also take this lock. A worker
            // is either still routed here or has a receipt in this snapshot.
            let mut chats = self.chats();
            let closing = self.closing_agents().clone();
            let taking_over = self.taking_over().clone();
            let active = if turning_off {
                // Keep actors with pending recovery through a concurrent turn_on.
                chats.clone()
            } else {
                std::mem::take(&mut *chats)
            };
            (active, closing, taking_over)
        };
        let mut waiting = Vec::new();
        for (chat_id, commands) in chats {
            let (reply, done) = oneshot::channel();
            if commands.send(Command::Shutdown(why, reply)).await.is_ok() {
                waiting.push((chat_id, done));
            }
        }
        let mut unconfirmed = Vec::new();
        for (chat_id, done) in waiting {
            if let Ok(Some(reason)) = done.await {
                unconfirmed.push(UnconfirmedCleanup { chat_id, reason });
            }
        }
        for (chat_id, mut done) in closing {
            let reported = match done.wait_for(Option::is_some).await {
                Ok(closed) => closed
                    .as_ref()
                    .and_then(|closed| closed.unconfirmed.clone()),
                Err(_) => {
                    unconfirmed.push(UnconfirmedCleanup {
                        chat_id,
                        reason: "the Automation cleanup did not report completion".to_owned(),
                    });
                    continue;
                }
            };
            if let Some(reason) = reported {
                if self.inner.lifecycle.has_runtime_cleanup(&chat_id) {
                    if !unconfirmed.iter().any(|warning| warning.chat_id == chat_id) {
                        unconfirmed.push(UnconfirmedCleanup { chat_id, reason });
                    }
                } else {
                    let mut closing = self.closing_agents();
                    if closing
                        .get(&chat_id)
                        .is_some_and(|receipt| receipt.same_channel(&done))
                    {
                        closing.remove(&chat_id);
                    }
                }
            }
        }
        for mut done in taking_over.into_values().flatten() {
            let _ = done.wait_for(|finished| *finished).await;
        }
        if turning_off {
            self.chats().retain(|_, commands| !commands.is_closed());
        }
        unconfirmed
    }

    /// Refuses new work, then stops every running Chat. Close storage after this returns.
    pub async fn quit(&self) -> Vec<UnconfirmedCleanup> {
        self.inner.lifecycle.quitting.store(true, Ordering::SeqCst);
        self.stop_all(StopReason::Quit).await
    }

    /// Accept new work again when an installer handoff fails to close the app.
    #[cfg(windows)]
    pub fn cancel_quit(&self) {
        self.inner.lifecycle.quitting.store(false, Ordering::SeqCst);
    }

    /// Before the workspace is replaced by a backup: refuses every request that would
    /// reach or start a supervisor, on every clone of this host, then stops every
    /// running Chat. Nothing runs until `finish_restore`.
    pub async fn begin_restore(&self) -> Result<Vec<UnconfirmedCleanup>, UnconfirmedCleanup> {
        self.inner.lifecycle.restoring.store(true, Ordering::SeqCst);
        self.inner
            .lifecycle
            .workspace_generation
            .fetch_add(1, Ordering::SeqCst);
        let mut warnings = self.stop_all(StopReason::Restore).await;
        let confirmed = self.inner.lifecycle.confirm_restore_cleanup().await?;
        let mut closing = self.closing_agents();
        for chat_id in &confirmed {
            closing.remove(chat_id);
        }
        warnings.retain(|warning| !confirmed.contains(&warning.chat_id));
        Ok(warnings)
    }

    /// The restore is over, whether or not it replaced anything; requests are served again.
    pub fn finish_restore(&self) {
        self.inner
            .lifecycle
            .restoring
            .store(false, Ordering::SeqCst);
    }

    /// Whether Chats are served: `Err` says why not (quitting, restoring, turned off).
    pub fn serving(&self) -> Result<(), HostError> {
        self.inner.lifecycle.serving()
    }

    async fn ask<T>(
        &self,
        chat_id: &str,
        command: impl FnOnce(Reply<T>) -> Command,
    ) -> Result<T, HostError> {
        let (reply, answer) = oneshot::channel();
        self.sender(chat_id)?
            .send(command(reply))
            .await
            .map_err(|_| HostError::Quitting)?;
        answer.await.map_err(|_| HostError::Quitting)?
    }

    /// The Chat's supervisor, started on first use.
    // ponytail: supervisors and idle runtimes live until quit or trash; add an idle
    // timeout when the number of open harness processes becomes a cost.
    fn sender(&self, chat_id: &str) -> Result<mpsc::Sender<Command>, HostError> {
        self.sender_for(chat_id, false)
    }

    fn sender_after_take_over(&self, gate: &TakeOver) -> Result<mpsc::Sender<Command>, HostError> {
        self.sender_for(&gate.chat_id, true)
    }

    /// Checked with the route lock, so a restore cannot finish before this route
    /// is either installed or refused.
    fn check_route_workspace(&self, generation: u64) -> Result<(), HostError> {
        self.serving()?;
        if self.inner.lifecycle.workspace_generation() != generation {
            return Err(HostError::Restoring);
        }
        Ok(())
    }

    fn sender_for(
        &self,
        chat_id: &str,
        after_take_over: bool,
    ) -> Result<mpsc::Sender<Command>, HostError> {
        self.serving()?;
        {
            let chats = self.chats();
            self.serving()?;
            if !after_take_over {
                self.check_agent_cleanup(chat_id)?;
            }
            if let Some(commands) = chats.get(chat_id).filter(|c| !c.is_closed()) {
                return Ok(commands.clone());
            }
        }
        let workspace_generation = self.inner.lifecycle.workspace_generation();
        let chat = (self.inner.open_workspace)()?.chat(chat_id)?;
        let adapter = self.inner.adapters.get(chat.harness.as_str()).cloned();
        let mut chats = self.chats();
        // Checked again under the lock `stop_all` uses, so a request racing shutdown
        // cannot add a supervisor after the running ones were stopped.
        self.check_route_workspace(workspace_generation)?;
        if !after_take_over {
            self.check_agent_cleanup(chat_id)?;
        }
        let unattended = if after_take_over {
            None
        } else {
            self.settings(chat_id)
        };
        let commands = chats
            .entry(chat_id.to_owned())
            .and_modify(|commands| {
                if commands.is_closed() {
                    *commands = self.spawn(&chat, adapter.clone(), unattended.clone());
                }
            })
            .or_insert_with(|| self.spawn(&chat, adapter, unattended));
        Ok(commands.clone())
    }

    /// The supervisor for an Automation run's agent that is about to work in the
    /// Chat, started with the agent's settings, or `None` when the Chat is no
    /// longer registered as unattended: the run was taken over or stopped first.
    /// The registration is read under the lock `close` takes a supervisor out
    /// with. So whoever ends the Chat's unattended running either did it before,
    /// and no agent starts, or does it after and finds this supervisor to stop.
    /// An agent's first message never starts an ordinary harness.
    pub(crate) fn unattended_sender(
        &self,
        chat_id: &str,
    ) -> Result<Option<mpsc::Sender<Command>>, HostError> {
        self.serving()?;
        let workspace_generation = self.inner.lifecycle.workspace_generation();
        let chat = (self.inner.open_workspace)()?.chat(chat_id)?;
        let adapter = self.inner.adapters.get(chat.harness.as_str()).cloned();
        let descriptor = adapter
            .as_ref()
            .map(|adapter| adapter.harness())
            .or_else(|| ticketd_core::harnesses::descriptor(&chat.harness));
        if let Some(descriptor) = descriptor
            && let ticketd_core::harnesses::UnattendedSupport::Unsupported { reason } =
                descriptor.unattended
        {
            return Err(Error::InvalidAutomationAgent(format!(
                "{} does not support Automations. {reason}",
                descriptor.name
            ))
            .into());
        }
        let mut chats = self.chats();
        self.check_route_workspace(workspace_generation)?;
        let Some(unattended) = self.settings(chat_id) else {
            return Ok(None);
        };
        if let Some(commands) = chats.get(chat_id).filter(|c| !c.is_closed()) {
            return Ok(Some(commands.clone()));
        }
        let commands = self.spawn(&chat, adapter, Some(unattended));
        chats.insert(chat_id.to_owned(), commands.clone());
        Ok(Some(commands))
    }

    fn spawn(
        &self,
        chat: &ticketd_core::Chat,
        adapter: Option<Arc<dyn HarnessAdapter>>,
        unattended: Option<Arc<UnattendedChat>>,
    ) -> mpsc::Sender<Command> {
        Supervisor::spawn(
            chat,
            self.inner.open_workspace.clone(),
            adapter,
            self.inner.context.clone(),
            self.inner.board.clone(),
            unattended,
            self.inner.lifecycle.clone(),
        )
    }

    /// The registration for a run that can still work in this Chat.
    fn settings(&self, chat_id: &str) -> Option<Arc<UnattendedChat>> {
        self.unattended()
            .get(chat_id)
            .filter(|unattended| !*unattended.turned_off.borrow())
            .cloned()
    }

    fn unattended(&self) -> MutexGuard<'_, HashMap<String, Arc<UnattendedChat>>> {
        self.inner
            .unattended
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn register_unattended(
        &self,
        chat_id: &str,
        unattended: Arc<UnattendedChat>,
    ) -> Result<bool, HostError> {
        // A cleanup beginning after this check sees the registration. A run
        // already ended cannot register later and remove an ordinary supervisor.
        let _chats = self.chats();
        if self.inner.lifecycle.stopping_for_workspace() {
            self.serving()?;
        }
        if self
            .workspace()?
            .automation_run(&unattended.settings.run_id)?
            .status
            != AutomationRunStatus::Running
        {
            return Ok(false);
        }
        self.unattended().insert(chat_id.to_owned(), unattended);
        Ok(true)
    }

    /// Whether an Automation run's agent can still work in this Chat.
    pub(crate) fn is_unattended(&self, chat_id: &str) -> bool {
        self.settings(chat_id).is_some()
    }

    /// Ends the Chat's unattended running, if it is running so: forgets the agent's
    /// settings, so the next supervisor is an ordinary one, and closes the harness.
    /// Whoever gets here first does the closing, so a run that ends and a person who
    /// takes it over at the same moment never close the person's new session.
    /// Returns `None` when it was not running unattended.
    pub(crate) async fn end_unattended(&self, chat_id: &str, why: StopReason) -> Option<Closed> {
        let (started, result) = self.close_agent(chat_id, why).await;
        started.then_some(result).flatten()
    }

    async fn close_agent(&self, chat_id: &str, why: StopReason) -> (bool, Option<Closed>) {
        let (started, mut done) = {
            let mut chats = self.chats();
            let mut closing = self.closing_agents();
            if let Some(done) = closing.get(chat_id) {
                (false, done.clone())
            } else {
                let Some(unattended) = self.unattended().remove(chat_id) else {
                    return (false, None);
                };
                // Chat Off already shut down this run's supervisor. The entry now
                // may hold a person-driven supervisor or pending storage recovery.
                if *unattended.turned_off.borrow() || self.inner.lifecycle.stopping_for_workspace()
                {
                    return (true, Some(Closed { unconfirmed: None }));
                }
                let commands = chats.remove(chat_id);
                let (finished, done) = watch::channel(None);
                closing.insert(chat_id.to_owned(), done.clone());
                let host = self.clone();
                let chat_id = chat_id.to_owned();
                tokio::spawn(async move {
                    let cleanup = match commands {
                        Some(commands) => Self::close_unattended(commands, why).await,
                        None => None,
                    };
                    if let Some(message_id) = unattended.first_message.get()
                        && let Ok(mut workspace) = host.workspace()
                    {
                        set_aside_first_message(&mut workspace, &chat_id, message_id, why);
                    }
                    host.inner.board.notify(&chat_id);
                    let mut closing = host.closing_agents();
                    let confirmed = cleanup.is_none();
                    finished.send_replace(Some(Closed {
                        unconfirmed: cleanup,
                    }));
                    // A later takeover also has to see an unconfirmed close.
                    if confirmed {
                        closing.remove(&chat_id);
                    }
                });
                (true, done)
            }
        };
        let result = done.wait_for(Option::is_some).await;
        (started, result.ok().and_then(|closed| closed.clone()))
    }

    fn taking_over(&self) -> MutexGuard<'_, HashMap<String, Vec<watch::Receiver<bool>>>> {
        self.inner
            .taking_over
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn closing_agents(&self) -> MutexGuard<'_, HashMap<String, watch::Receiver<Option<Closed>>>> {
        self.inner
            .closing_agents
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn check_agent_cleanup(&self, chat_id: &str) -> Result<(), HostError> {
        if self.taking_over().contains_key(chat_id)
            || self
                .closing_agents()
                .get(chat_id)
                .is_some_and(|closed| closed.borrow().is_none())
        {
            return Err(HostError::Working);
        }
        if self.inner.lifecycle.has_pending_open_cleanup(chat_id) {
            return Err(HostError::PermissionRestartCleanupUnconfirmed);
        }
        Ok(())
    }

    pub(crate) fn workspace(&self) -> Result<WorkspaceGuard, HostError> {
        Ok((self.inner.open_workspace)()?)
    }

    fn chats(&self) -> MutexGuard<'_, HashMap<String, mpsc::Sender<Command>>> {
        self.inner
            .chats
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// The name a failed turn's problem kind is stored under.
pub fn problem_key(kind: ProblemKind) -> &'static str {
    match kind {
        ProblemKind::NotInstalled => "not_installed",
        ProblemKind::IncompatibleVersion => "incompatible_version",
        ProblemKind::LoginRequired => "login_required",
        ProblemKind::QuotaExhausted => "quota_exhausted",
        ProblemKind::NativeHistoryUnavailable => "native_history_unavailable",
        ProblemKind::SessionInUse => "session_in_use",
        ProblemKind::PermissionUnavailable => "permission_unavailable",
        ProblemKind::TurnLimitReached => "turn_limit_reached",
        ProblemKind::ToolDenied => "tool_denied",
        ProblemKind::Other => "other",
    }
}

/// The problem kind stored under `key`; an unknown name reads as `Other`.
pub fn problem_kind(key: &str) -> ProblemKind {
    [
        ProblemKind::NotInstalled,
        ProblemKind::IncompatibleVersion,
        ProblemKind::LoginRequired,
        ProblemKind::QuotaExhausted,
        ProblemKind::NativeHistoryUnavailable,
        ProblemKind::SessionInUse,
        ProblemKind::PermissionUnavailable,
        ProblemKind::TurnLimitReached,
        ProblemKind::ToolDenied,
    ]
    .into_iter()
    .find(|kind| problem_key(*kind) == key)
    .unwrap_or(ProblemKind::Other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Unattended;
    use ticketd_core::{
        AutomationAgentSettings, AutomationDefinition, RunAction, Step, StepAction, StepOutcome,
        Trigger, Workspace, WorkspaceSession,
    };

    fn board() -> Board {
        Board {
            live: Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
            signals: Mutex::new(HashMap::new()),
        }
    }

    #[tokio::test]
    async fn a_route_read_started_in_an_earlier_workspace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let chat = Workspace::open(&path)
            .unwrap()
            .create_chat(
                None,
                ticketd_core::NewChat {
                    title: None,
                    harness: "codex".into(),
                    execution_folder: dir.path().to_string_lossy().into_owned(),
                    folder_managed: false,
                    links: Vec::new(),
                },
            )
            .unwrap();
        let lifecycle = Arc::new(std::sync::OnceLock::<Arc<HostLifecycle>>::new());
        let host = ChatHost::new(
            Arc::new({
                let lifecycle = lifecycle.clone();
                move || {
                    let workspace = WorkspaceSession::for_file(&path)?.workspace()?;
                    if let Some(lifecycle) = lifecycle.get() {
                        lifecycle
                            .workspace_generation
                            .fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(workspace)
                }
            }),
            Vec::new(),
        )
        .unwrap();
        assert!(lifecycle.set(host.inner.lifecycle.clone()).is_ok());

        assert!(matches!(host.sender(&chat.id), Err(HostError::Restoring)));
        assert!(matches!(
            host.unattended_sender(&chat.id),
            Err(HostError::Restoring)
        ));
        assert!(host.chats().is_empty());
    }

    /// An Automation run's agent waits on its own Chat: what other Chats do wakes the
    /// host-wide watch (the Chats list) and not this wait.
    #[test]
    fn a_wait_on_one_chat_wakes_for_that_chat_only() {
        let board = board();
        let waiting = board.listen("agent");

        board.report("other", 1, Some(ChatLive::idle()));
        assert!(!waiting.has_changed().unwrap_or(true));

        board.report("agent", 1, Some(ChatLive::idle()));
        assert!(waiting.has_changed().unwrap_or(false));
    }

    /// A supervisor still stopping after a quit timed out can report after its
    /// replacement started; that late report leaves the replacement's state alone.
    #[test]
    fn a_late_report_from_an_older_supervisor_keeps_the_replacements_state() {
        let board = board();
        board.report("chat", 1, Some(ChatLive::idle()));
        board.report("chat", 2, Some(ChatLive::idle()));
        board.report("chat", 1, Some(ChatLive::idle()));
        board.report("chat", 1, None);
        assert_eq!(board.live().get("chat").map(|(owner, _)| *owner), Some(2));

        board.report("chat", 2, None);
        assert!(board.live().is_empty());
    }

    #[test]
    fn a_chat_nobody_waits_on_keeps_no_signal() {
        let board = board();
        board.report("agent", 1, None);
        assert!(board.signals().is_empty());

        let _waiting = board.listen("agent");
        board.stop_listening("agent");
        assert!(board.signals().is_empty());
    }

    fn running_automation(steps: usize) -> (tempfile::TempDir, ChatHost, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut workspace = Workspace::open(&path).unwrap();
        let agent = workspace
            .create_automation_agent(AutomationAgentSettings::default())
            .unwrap();
        let automation = workspace
            .create_automation(AutomationDefinition {
                name: "Triage".into(),
                trigger: Some(Trigger::TagAdded {
                    tag: "triage".into(),
                }),
                conditions: Vec::new(),
                steps: (0..steps)
                    .map(|index| Step {
                        id: format!("agent-{index}"),
                        action: StepAction::RunAgent {
                            agent_id: Some(agent.id.clone()),
                            execution_folder: Some(dir.path().to_string_lossy().into_owned()),
                            on_failure: None,
                        },
                    })
                    .collect(),
            })
            .unwrap();
        workspace
            .set_automation_enabled(&automation.id, true)
            .unwrap();
        let ticket = workspace.create_ticket("To triage").unwrap();
        workspace.add_tag(&ticket.reference, "triage").unwrap();
        workspace.queue_automation_runs().unwrap();
        let run = workspace.start_automation_runs(1).unwrap().remove(0);
        let RunAction::RunAgent(start) = workspace.advance_automation_run(&run.id, None).unwrap()
        else {
            panic!("the run did not start its agent");
        };
        drop(workspace);

        let host = ChatHost::new(
            Arc::new(move || WorkspaceSession::for_file(&path)?.workspace()),
            Vec::new(),
        )
        .unwrap();
        (dir, host, run.id, start.chat_id)
    }

    fn register_agent(host: &ChatHost, run_id: &str, chat_id: &str) {
        let unattended = UnattendedChat::new(
            Unattended {
                run_id: run_id.to_owned(),
                model: None,
                tools: AutomationAgentSettings::default().tools,
                turn_limit: 2,
            },
            host.prompt_fence(run_id),
        );
        assert!(host.register_unattended(chat_id, unattended).unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn stop_pauses_an_automation_chat_registered_without_a_route() {
        let (_dir, host, run_id, chat) = running_automation(1);
        register_agent(&host, &run_id, &chat);
        let mut core = host.workspace().unwrap();
        let first = core.save_chat_input(None, &chat, "First").unwrap();
        core.save_automation_chat_prompt(&chat, &run_id, "Agent Prompt")
            .unwrap();
        let second = core.save_chat_input(None, &chat, "Second").unwrap();
        assert!(!core.chat(&chat).unwrap().queue_paused);
        assert!(!host.chats().contains_key(&chat));

        host.stop(&chat).await.unwrap();

        assert!(core.chat(&chat).unwrap().queue_paused);
        assert_eq!(core.chat_queue(&chat).unwrap(), [first, second]);
        assert_eq!(
            core.automation_run(&run_id).unwrap().status,
            AutomationRunStatus::TakenOver
        );
        assert!(!host.is_unattended(&chat));
        assert!(!host.chats().contains_key(&chat));
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_a_takeover_keeps_already_closed_siblings_behind_the_gate() {
        for reply in [false, true] {
            takeover_keeps_closed_siblings_behind_the_gate(reply).await;
        }
    }

    async fn takeover_keeps_closed_siblings_behind_the_gate(reply: bool) {
        let (_dir, host, run_id, first) = running_automation(2);
        register_agent(&host, &run_id, &first);
        let RunAction::RunAgent(next) = host
            .workspace()
            .unwrap()
            .advance_automation_run(&run_id, Some(StepOutcome::Completed))
            .unwrap()
        else {
            panic!("the run did not start its second agent");
        };
        register_agent(&host, &run_id, &next.chat_id);
        let (first_route, mut first_mailbox) = mpsc::channel(1);
        let (second_route, mut second_mailbox) = mpsc::channel(1);
        host.chats().insert(first.clone(), first_route);
        host.chats().insert(next.chat_id.clone(), second_route);

        let takeover = tokio::spawn({
            let host = host.clone();
            let chat = next.chat_id.clone();
            async move {
                if reply {
                    host.send(&chat, None, "Take over", SendMode::Queue)
                        .await
                        .map(drop)
                } else {
                    host.stop(&chat).await
                }
            }
        });
        let Some(Command::Shutdown(StopReason::TakenOver, first_reply)) =
            tokio::time::timeout(Duration::from_secs(1), first_mailbox.recv())
                .await
                .unwrap()
        else {
            panic!("the first agent was not asked to close");
        };
        takeover.abort();
        assert!(takeover.await.unwrap_err().is_cancelled());
        first_reply.send(None).unwrap();

        let Some(Command::Shutdown(StopReason::TakenOver, second_reply)) =
            tokio::time::timeout(Duration::from_secs(1), second_mailbox.recv())
                .await
                .unwrap()
        else {
            panic!("the sibling agent was not asked to close");
        };
        assert!(matches!(
            host.resume_queue(&first).await,
            Err(HostError::Working)
        ));
        assert!(matches!(
            host.sender(&next.chat_id),
            Err(HostError::Working)
        ));
        let mut gate = host.taking_over()[&next.chat_id][0].clone();
        second_reply.send(None).unwrap();
        tokio::time::timeout(Duration::from_secs(1), gate.wait_for(|done| *done))
            .await
            .unwrap()
            .unwrap();
        host.resume_queue(&first).await.unwrap();
        assert!(!host.is_unattended(&next.chat_id));
    }

    #[tokio::test]
    async fn releasing_one_takeover_does_not_release_an_overlapping_gate() {
        let (_dir, host, run_id, first) = running_automation(2);
        let mut workspace = host.workspace().unwrap();
        let RunAction::RunAgent(next) = workspace
            .advance_automation_run(&run_id, Some(StepOutcome::Completed))
            .unwrap()
        else {
            panic!("the run did not start its second agent");
        };
        let first_gate = host.begin_take_over(&first).unwrap();
        let mut second_gate = host.begin_take_over(&next.chat_id).unwrap();
        {
            let _chats = host.chats();
            second_gate.cover_steps(&workspace.automation_run(&run_id).unwrap());
        }

        drop(first_gate);
        assert!(matches!(host.sender(&first), Err(HostError::Working)));
        drop(second_gate);
        assert!(host.sender(&first).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_saved_takeover_reply_waits_for_mailbox_space_before_admitting_later_sends() {
        let (_dir, host, _run, chat) = running_automation(1);
        // An ordinary supervisor already has the route, before the run registers.
        let (sender, mut mailbox) = mpsc::channel(1);
        assert!(sender.try_send(Command::Changed).is_ok());
        host.chats().insert(chat.clone(), sender);
        let sending = tokio::spawn({
            let host = host.clone();
            let chat = chat.clone();
            async move {
                host.send(&chat, Some("reply"), "Take over", SendMode::Auto)
                    .await
            }
        });
        // The paused clock moves when the takeover and its detached task are both waiting.
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert!(matches!(host.sender(&chat), Err(HostError::Working)));
        let queue = host.workspace().unwrap().chat_queue(&chat).unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].text, "Take over");

        assert!(matches!(mailbox.recv().await, Some(Command::Changed)));
        let scheduled = tokio::time::timeout(Duration::from_secs(1), mailbox.recv())
            .await
            .unwrap();
        let Some(Command::ScheduleSaved { message_id, reply }) = scheduled else {
            panic!("the saved reply was not scheduled");
        };
        assert_eq!(message_id, queue[0].id);
        assert!(host.sender(&chat).is_ok());
        assert!(!sending.is_finished());
        // Shutdown can cancel the scheduling acknowledgement after the input was saved.
        drop(reply);
        assert_eq!(sending.await.unwrap().unwrap(), queue[0]);
    }
}
