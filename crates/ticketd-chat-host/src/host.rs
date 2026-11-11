//! The host-facing Chat interface: one supervisor per Chat behind a small set of
//! commands and a subscription. A later step maps it onto Tauri commands and events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ticketd_core::{ChatMessage, ChatSnapshot, Error, Workspace};
use tokio::sync::{mpsc, oneshot, watch};

use crate::supervisor::{Command, Reply, Supervisor};
use crate::{
    Harness, HarnessAdapter, Inspection, InteractionAnswer, InteractionKind, Problem, ProblemKind,
    SteeringBehavior, Subscription,
};

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
/// How long a written new turn may go without any confirmation before its delivery is
/// recorded as uncertain and the Chat stops showing as working. Provisional (#267).
pub const DELIVERY_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(120);
/// History items in the snapshot a view receives on attach.
pub const SNAPSHOT_ITEMS: usize = 200;

/// Opens the workspace for one short operation, as every other desktop command does.
/// The host holds no connection between operations, so backup and restore are not blocked.
pub type WorkspaceOpener = Arc<dyn Fn() -> Result<Workspace, Error> + Send + Sync>;

/// The ticketd context for a Chat (see `context::for_chat`), read when a harness
/// session starts. `Ok(None)` sends nothing; an error is told to the person and the
/// session starts without context. It may block, so it runs off the async threads.
pub type ContextSource = Arc<dyn Fn(&str) -> Result<Option<String>, String> + Send + Sync>;

/// The name of the tool record that keeps the context text a session was started with,
/// so the transcript shows what the agent was given apart from the person's words.
pub const CONTEXT_RECORD_NAME: &str = "ticketd context";

/// The detail recorded on a turn ticketd itself stopped, on Quit or when Chat is turned off.
pub const STOPPED_BY_TICKETD: &str = "ticketd stopped this Chat";

/// The `Chat.harness` value an adapter serves.
pub fn harness_key(harness: Harness) -> &'static str {
    match harness {
        Harness::ClaudeCode => "claude-code",
        Harness::Codex => "codex",
    }
}

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
    #[error("{}", .0.message)]
    Harness(Problem),
    #[error("no adapter is available for harness '{0}'")]
    HarnessUnavailable(String),
    #[error("the Chat is already starting its harness")]
    Busy,
    #[error("the Chat is working; try again when it has finished")]
    Working,
    #[error("ticketd is quitting")]
    Quitting,
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
    /// What steering does when a send would steer; `None` means a send queues.
    pub steering: Option<SteeringBehavior>,
    /// A new turn was handed to the harness and nothing confirmed it yet.
    pub delivery_unconfirmed: bool,
    pub interactions: Vec<LiveInteraction>,
    pub stop: Option<StopState>,
    pub problem: Option<ChatProblem>,
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

#[derive(Clone)]
pub struct ChatHost {
    inner: Arc<Inner>,
}

/// What every Chat's supervisor last reported, for readers that have no view attached:
/// the Chats list, the counts, and the checks before Quit or turning Chat off.
pub(crate) struct Board {
    live: Mutex<HashMap<String, ChatLive>>,
    changed: watch::Sender<u64>,
}

impl Board {
    fn live(&self) -> MutexGuard<'_, HashMap<String, ChatLive>> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Called by a supervisor after each step; `None` once it has stopped.
    pub(crate) fn report(&self, chat_id: &str, live: Option<ChatLive>) {
        match live {
            Some(live) => self.live().insert(chat_id.to_owned(), live),
            None => self.live().remove(chat_id),
        };
        self.changed
            .send_modify(|count| *count = count.wrapping_add(1));
    }
}

struct Inner {
    open_workspace: WorkspaceOpener,
    context: Option<ContextSource>,
    board: Arc<Board>,
    adapters: HashMap<&'static str, Arc<dyn HarnessAdapter>>,
    chats: Mutex<HashMap<String, mpsc::Sender<Command>>>,
    quitting: AtomicBool,
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
        open_workspace()?.mark_chat_contact_lost(None, "ticketd was restarted")?;
        Ok(Self {
            inner: Arc::new(Inner {
                open_workspace,
                context,
                board: Arc::new(Board {
                    live: Mutex::new(HashMap::new()),
                    changed: watch::channel(0).0,
                }),
                adapters: adapters
                    .into_iter()
                    .map(|adapter| (harness_key(adapter.harness()), adapter))
                    .collect(),
                chats: Mutex::new(HashMap::new()),
                quitting: AtomicBool::new(false),
            }),
        })
    }

    /// Live state of every Chat that has a supervisor. A Chat that is absent is idle
    /// with no harness process.
    pub fn live(&self) -> HashMap<String, ChatLive> {
        self.inner.board.live().clone()
    }

    /// Moves whenever any Chat's records or live state may have changed. It can move
    /// without a visible difference, so readers compare what they show.
    pub fn changed(&self) -> watch::Receiver<u64> {
        self.inner.board.changed.subscribe()
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
        self.ask(chat_id, Command::Attach).await
    }

    /// Saves the input, then dispatches, steers or queues it. Returns once it is saved;
    /// delivery is reported through the Chat's records.
    pub async fn send(
        &self,
        chat_id: &str,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
    ) -> Result<ChatMessage, HostError> {
        let (command_id, text) = (command_id.map(str::to_owned), text.to_owned());
        self.ask(chat_id, |reply| Command::Send {
            command_id,
            text,
            mode,
            reply,
        })
        .await
    }

    /// Pauses queue dispatch and asks the harness to interrupt the active turn.
    pub async fn stop(&self, chat_id: &str) -> Result<(), HostError> {
        self.ask(chat_id, Command::Stop).await
    }

    /// Lets queued input dispatch again after Stop or a problem.
    pub async fn resume_queue(&self, chat_id: &str) -> Result<(), HostError> {
        self.ask(chat_id, Command::ResumeQueue).await
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

    /// Stops every running Chat with bounded cleanup and keeps the host usable, for
    /// turning Chat off in Settings.
    pub async fn stop_all(&self) -> Vec<UnconfirmedCleanup> {
        let chats: Vec<_> = self.chats().drain().collect();
        let mut waiting = Vec::new();
        for (chat_id, commands) in chats {
            let (reply, done) = oneshot::channel();
            if commands.send(Command::Shutdown(reply)).await.is_ok() {
                waiting.push((chat_id, done));
            }
        }
        let mut unconfirmed = Vec::new();
        for (chat_id, done) in waiting {
            if let Ok(Some(reason)) = done.await {
                unconfirmed.push(UnconfirmedCleanup { chat_id, reason });
            }
        }
        unconfirmed
    }

    /// Refuses new work, then stops every running Chat. Close storage after this returns.
    pub async fn quit(&self) -> Vec<UnconfirmedCleanup> {
        self.inner.quitting.store(true, Ordering::SeqCst);
        self.stop_all().await
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
        if self.inner.quitting.load(Ordering::SeqCst) {
            return Err(HostError::Quitting);
        }
        if let Some(commands) = self.chats().get(chat_id).filter(|c| !c.is_closed()) {
            return Ok(commands.clone());
        }
        let chat = (self.inner.open_workspace)()?.chat(chat_id)?;
        let adapter = self.inner.adapters.get(chat.harness.as_str()).cloned();
        let mut chats = self.chats();
        let commands = chats
            .entry(chat_id.to_owned())
            .and_modify(|commands| {
                if commands.is_closed() {
                    *commands = self.spawn(&chat, adapter.clone());
                }
            })
            .or_insert_with(|| self.spawn(&chat, adapter.clone()));
        Ok(commands.clone())
    }

    fn spawn(
        &self,
        chat: &ticketd_core::Chat,
        adapter: Option<Arc<dyn HarnessAdapter>>,
    ) -> mpsc::Sender<Command> {
        Supervisor::spawn(
            chat,
            self.inner.open_workspace.clone(),
            adapter,
            self.inner.context.clone(),
            self.inner.board.clone(),
        )
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
    ]
    .into_iter()
    .find(|kind| problem_key(*kind) == key)
    .unwrap_or(ProblemKind::Other)
}
