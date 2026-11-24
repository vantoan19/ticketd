//! The host-facing Chat interface: one supervisor per Chat behind a small set of
//! commands and a subscription. A later step maps it onto Tauri commands and events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ticketd_core::{ChatItem, ChatMessage, ChatObservation, ChatSnapshot, Error, WorkspaceGuard};
use tokio::sync::{mpsc, oneshot, watch};

use crate::supervisor::{Command, Reply, Supervisor};
use crate::{
    ContextUsage, HarnessAdapter, HarnessCommand, HarnessOptions, HarnessSettings, Inspection,
    InteractionAnswer, InteractionKind, Problem, ProblemKind, SettingKey, SettingOutcome,
    StartSettings, SteeringBehavior, Subscription, Unattended,
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
    /// Work waits on a harness session that has not started a turn yet, and how that
    /// session opens. A process alone is not a working session: the harness can take
    /// seconds after it starts before the first turn runs.
    pub opening: Option<ticketd_core::ChatSessionOrigin>,
    /// What steering does when a send would steer; `None` means a send queues.
    pub steering: Option<SteeringBehavior>,
    /// A new turn was handed to the harness and nothing confirmed it yet.
    pub delivery_unconfirmed: bool,
    /// Input the person sent that is held to go out as soon as the session can take it,
    /// in order. It waits for no queue; see `ChatMessage::standing_while`.
    pub sending: Vec<String>,
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
            opening: None,
            steering: None,
            delivery_unconfirmed: false,
            sending: Vec::new(),
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
    unattended: Mutex<HashMap<String, Unattended>>,
    quitting: AtomicBool,
    /// Set while the workspace is being replaced by a backup. Checked where `quitting`
    /// is, so every clone of the host refuses to start or reach a supervisor.
    restoring: AtomicBool,
    /// Set while Chat is switched off in Settings, for the same reason.
    off: AtomicBool,
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
                board: Arc::new(Board {
                    live: Mutex::new(HashMap::new()),
                    changed: watch::channel(0).0,
                    signals: Mutex::new(HashMap::new()),
                }),
                adapters: adapters
                    .into_iter()
                    .map(|adapter| (adapter.harness().key.as_str(), adapter))
                    .collect(),
                chats: Mutex::new(HashMap::new()),
                unattended: Mutex::new(HashMap::new()),
                quitting: AtomicBool::new(false),
                restoring: AtomicBool::new(false),
                off: AtomicBool::new(false),
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
        self.ask(chat_id, Command::Attach).await
    }

    /// The person's message. Saves the input, then dispatches, steers or queues it.
    /// Returns once it is saved; delivery is reported through the Chat's records. In
    /// the Chat of an Automation run it takes the run over first, so the Chat is the
    /// person's from this message on: see `take_over`.
    pub async fn send(
        &self,
        chat_id: &str,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
    ) -> Result<ChatMessage, HostError> {
        // A reply sent to wait behind the agent's turn (a harness that cannot steer)
        // waits for nothing once the take-over ended that turn: it is the resumed
        // Chat's first turn (#387 M2).
        let mode = match self.take_over(chat_id, true).await? {
            Some(_) => SendMode::Auto,
            None => mode,
        };
        self.submit(chat_id, command_id, text, mode).await
    }

    /// The person replied in (`replied`) or stopped a Chat. When that takes an
    /// Automation run over, every agent the run had working stops being unattended
    /// at once: its turn is interrupted, its harness process is closed and the wait
    /// in `run_unattended` ends. A harness cannot change how it runs in place, so
    /// the Chat's next supervisor opens a new process that resumes the same
    /// conversation as an ordinary Chat: the person's own settings and approvals, no
    /// run marker on what it writes, and no time limit. Returns `None` when there was
    /// no run to take over, else whether this Chat's harness was closed.
    async fn take_over(&self, chat_id: &str, replied: bool) -> Result<Option<bool>, HostError> {
        let Some(run) = self
            .workspace()?
            .take_over_automation_run(chat_id, replied)?
        else {
            return Ok(None);
        };
        let mut closed = false;
        // The Chat acted on, and the Chat of a later step whose agent was working.
        for step in run.steps.iter().filter_map(|step| step.chat_id.as_deref()) {
            closed |= self
                .end_unattended(step, StopReason::TakenOver)
                .await
                .is_some()
                && step == chat_id;
        }
        Ok(Some(closed))
    }

    /// Sends input to the Chat's supervisor, starting one when it has none.
    async fn submit(
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

    /// The person's Stop: pauses queue dispatch and asks the harness to interrupt the
    /// active turn. In the Chat of an Automation run that is going, it takes the run
    /// over, which stops the agent by closing its unattended harness. It means the
    /// person's Stop and nothing else: when ticketd closes an agent because its run
    /// ended, it uses `end_run_agents`.
    pub async fn stop(&self, chat_id: &str) -> Result<(), HostError> {
        if self.take_over(chat_id, false).await? == Some(true) {
            return Ok(());
        }
        self.ask(chat_id, Command::Stop).await
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
        self.inner.off.store(true, Ordering::SeqCst);
        self.stop_all(StopReason::TurnedOff).await
    }

    /// Chat was switched on again; requests are served.
    pub fn turn_on(&self) {
        self.inner.off.store(false, Ordering::SeqCst);
    }

    /// Stops every running Chat with bounded cleanup and keeps the host usable.
    pub async fn stop_all(&self, why: StopReason) -> Vec<UnconfirmedCleanup> {
        let chats: Vec<_> = self.chats().drain().collect();
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
        unconfirmed
    }

    /// Refuses new work, then stops every running Chat. Close storage after this returns.
    pub async fn quit(&self) -> Vec<UnconfirmedCleanup> {
        self.inner.quitting.store(true, Ordering::SeqCst);
        self.stop_all(StopReason::Quit).await
    }

    /// Accept new work again when an installer handoff fails to close the app.
    #[cfg(windows)]
    pub fn cancel_quit(&self) {
        self.inner.quitting.store(false, Ordering::SeqCst);
    }

    /// Before the workspace is replaced by a backup: refuses every request that would
    /// reach or start a supervisor, on every clone of this host, then stops every
    /// running Chat. Nothing runs until `finish_restore`.
    pub async fn begin_restore(&self) -> Vec<UnconfirmedCleanup> {
        self.inner.restoring.store(true, Ordering::SeqCst);
        self.stop_all(StopReason::Restore).await
    }

    /// The restore is over, whether or not it replaced anything; requests are served again.
    pub fn finish_restore(&self) {
        self.inner.restoring.store(false, Ordering::SeqCst);
    }

    /// Whether Chats are served: `Err` says why not (quitting, restoring, turned off).
    pub fn serving(&self) -> Result<(), HostError> {
        self.closed()
    }

    /// Why no supervisor may be reached or started right now, if any reason.
    fn closed(&self) -> Result<(), HostError> {
        if self.inner.quitting.load(Ordering::SeqCst) {
            return Err(HostError::Quitting);
        }
        if self.inner.restoring.load(Ordering::SeqCst) {
            return Err(HostError::Restoring);
        }
        if self.inner.off.load(Ordering::SeqCst) {
            return Err(HostError::TurnedOff);
        }
        Ok(())
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
        self.closed()?;
        if let Some(commands) = self.chats().get(chat_id).filter(|c| !c.is_closed()) {
            return Ok(commands.clone());
        }
        let chat = (self.inner.open_workspace)()?.chat(chat_id)?;
        let adapter = self.inner.adapters.get(chat.harness.as_str()).cloned();
        let mut chats = self.chats();
        // Checked again under the lock `stop_all` drains with, so a request racing
        // Quit or a restore cannot add a supervisor after the running ones were stopped.
        self.closed()?;
        let commands = chats
            .entry(chat_id.to_owned())
            .and_modify(|commands| {
                if commands.is_closed() {
                    *commands = self.spawn(&chat, adapter.clone(), self.settings(&chat.id));
                }
            })
            .or_insert_with(|| self.spawn(&chat, adapter.clone(), self.settings(&chat.id)));
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
        self.closed()?;
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
        self.closed()?;
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
        unattended: Option<Unattended>,
    ) -> mpsc::Sender<Command> {
        Supervisor::spawn(
            chat,
            self.inner.open_workspace.clone(),
            adapter,
            self.inner.context.clone(),
            self.inner.board.clone(),
            unattended,
        )
    }

    /// The agent's settings while the Chat is registered as unattended.
    fn settings(&self, chat_id: &str) -> Option<Unattended> {
        self.unattended().get(chat_id).cloned()
    }

    fn unattended(&self) -> MutexGuard<'_, HashMap<String, Unattended>> {
        self.inner
            .unattended
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Sets or clears how the Chat's next supervisor opens its harness.
    pub(crate) fn set_unattended(&self, chat_id: &str, unattended: Option<Unattended>) {
        match unattended {
            Some(unattended) => self.unattended().insert(chat_id.to_owned(), unattended),
            None => self.unattended().remove(chat_id),
        };
    }

    /// Whether the Chat is running unattended: an Automation run's agent is working
    /// in it and nobody has taken it over.
    pub(crate) fn is_unattended(&self, chat_id: &str) -> bool {
        self.unattended().contains_key(chat_id)
    }

    /// Whether the Chat has a supervisor in this host. Quit, a restore and turning
    /// Chat off take every supervisor out.
    pub(crate) fn supervised(&self, chat_id: &str) -> bool {
        self.chats().contains_key(chat_id)
    }

    /// Ends the Chat's unattended running, if it is running so: forgets the agent's
    /// settings, so the next supervisor is an ordinary one, and closes the harness.
    /// Whoever gets here first does the closing, so a run that ends and a person who
    /// takes it over at the same moment never close the person's new session.
    /// Returns `None` when it was not running unattended.
    pub(crate) async fn end_unattended(&self, chat_id: &str, why: StopReason) -> Option<Closed> {
        self.unattended().remove(chat_id)?;
        let cleanup = self.close(chat_id, why).await;
        // While a Chat is unattended, whatever is still queued in it is the agent's first
        // message, which the agent never took: the person did not write it, and it must
        // not wait to be sent for them (a reply starts the queue). What the agent did
        // take is history, not queue, and stays. Neither is withdrawn: the run's
        // instructions stay in the Chat as set aside (#406), and with no turn to carry
        // the reason, a note says why the agent stopped.
        let queued = self.set_aside_queued_first_message(chat_id);
        let unconfirmed = self.set_aside_unconfirmed_first_message(chat_id);
        if queued || unconfirmed {
            self.note_stopped(chat_id, why);
        }
        // Wakes the wait in `run_unattended`, also when no supervisor had started.
        self.inner.board.notify(chat_id);
        Some(Closed {
            unconfirmed: cleanup,
        })
    }

    /// Sets the Chat's queued input aside, never to be sent. Best effort: when the
    /// Workspace cannot be read the run's own failure handling reports the problem.
    /// Returns whether it set anything aside.
    fn set_aside_queued_first_message(&self, chat_id: &str) -> bool {
        let Ok(mut workspace) = self.workspace() else {
            return false;
        };
        let mut any = false;
        for message in workspace.chat_queue(chat_id).unwrap_or_default() {
            any |= workspace
                .set_aside_queued_chat_input(chat_id, &message.id)
                .is_ok();
        }
        any
    }

    /// Says in the Chat why its agent stopped, when it stopped before any turn could.
    fn note_stopped(&self, chat_id: &str, why: StopReason) {
        let Ok(mut workspace) = self.workspace() else {
            return;
        };
        let notice = ChatObservation::Notice {
            notice_id: uuid::Uuid::new_v4().to_string(),
            text: format!("{}.", why.words()),
            from_harness: false,
        };
        let _ = workspace.record_chat_observations(chat_id, vec![notice]);
    }

    /// The same message when it was already handed to the harness but never confirmed
    /// (#387 5A2): closing the harness recorded its delivery as uncertain, which would
    /// ask the person whether to send the agent's instructions as their own. The run
    /// stays in history as it is; the person is not asked, and it is never sent again.
    fn set_aside_unconfirmed_first_message(&self, chat_id: &str) -> bool {
        let Ok(mut workspace) = self.workspace() else {
            return false;
        };
        let Ok(snapshot) = workspace.chat_snapshot(chat_id, UNCONFIRMED_SCAN) else {
            return false;
        };
        let mut any = false;
        for item in snapshot.items {
            if let ChatItem::Message(message) = item
                && message.awaits_decision()
            {
                any |= workspace
                    .discard_uncertain_chat_submission(chat_id, &message.id)
                    .is_ok();
            }
        }
        any
    }

    /// Takes the Chat's supervisor out of the host, for the caller to shut down.
    pub(crate) fn forget(&self, chat_id: &str) -> Option<mpsc::Sender<Command>> {
        self.chats().remove(chat_id)
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

/// How many of a Chat's latest history items are looked through for the run's first
/// message when its run ends: an unattended Chat has hardly any.
const UNCONFIRMED_SCAN: usize = 50;

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

    fn board() -> Board {
        Board {
            live: Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
            signals: Mutex::new(HashMap::new()),
        }
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
}
