//! One Chat's supervisor: a task that handles one message at a time and owns the
//! Chat's dispatch, queue policy, active turn, live requests and runtime lifetime.
//!
//! Adapter calls that can wait on the harness (open, submit, interrupt, respond) run in
//! their own tasks and report back as messages, so runtime events and commands keep
//! being handled while they are pending. Every durable write goes through the core.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::future::{Future, pending};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use ticketd_core::{
    Chat, ChatAttachmentContent, ChatInputChange, ChatInputReceipt, ChatInteractionKind,
    ChatInteractionState, ChatMessage, ChatMessageNote, ChatMessageNoteKind, ChatObservation,
    ChatOwner, ChatRole, ChatSessionOrigin, ChatSubAgent, ChatSubAgentState, ChatSubAgentStopper,
    ChatSubmissionIntent, ChatToolState, ChatTurnOrigin, ChatTurnReceipt, ChatTurnStarter,
    ChatTurnState, Error, Workspace,
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until, timeout};
use tracing::Instrument;
use uuid::Uuid;

use crate::host::{
    Activity, Board, CLOSE_TIMEOUT, CONTEXT_RECORD_NAME, ChatLive, ChatProblem, ChatView,
    ContextReport, ContextSource, DELIVERY_CONFIRMATION_TIMEOUT, HostError, HostLifecycle,
    INTERRUPT_TIMEOUT, LiveInteraction, LiveSettingChange, LiveSettings, ResumeMode,
    SNAPSHOT_ITEMS, SendMode, SettingChangeState, StopState, TEXT_CHECKPOINT_INTERVAL,
    TEXT_UPDATE_INTERVAL, WorkspaceOpener, is_refusal,
};
use crate::records::{
    FILES_RECORD_NAME, FilesRecord, PLAN_RECORD_NAME, PlanRecord, REASONING_RECORD_NAME,
    ReasoningRecord,
};
use crate::{
    HarnessCommand, HarnessSettings, SettingChange, SettingKey, SettingOutcome, StartSettings,
    StopReason, TurnEnding,
};

/// Now, in milliseconds since the Unix epoch.
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}
use crate::outcome::{settle, tool_state};
use crate::subscription::{self, ChatUpdate, Publisher};
use crate::unattended::{UnattendedChat, set_aside_first_message};
use crate::{
    ApprovalDecision, AutomationPromptAdmission, Capabilities, CloseOutcome, DeliveryEvidence,
    DispatchOutcome, EventKind, HarnessAdapter, HarnessRuntime, InteractionAnswer, InteractionKind,
    InteractionRequest, InteractionResolution, InteractionResponse, InterruptOutcome,
    InterruptRequest, NativeItemId, NativeRequestId, NativeSessionId, NativeSubAgentId,
    NativeTurnId, NoticeKind, OpenRequest, OpenedRuntime, Problem, ProviderDetail, Refusal,
    RespondOutcome, RuntimeEvent, RuntimeGeneration, SessionStart, SubAgentOutcome,
    SubAgentStopper, Submission, SubmissionId, SubmissionKind, Subscription, ToolStatus,
    TurnEvidence, TurnOrigin, TurnOutcome, TurnStarter,
};

/// How long a Chat whose last sub-agent just finished with no turn running stays working,
/// for the harness to resume the main agent by itself (Claude Code does, a second or
/// several after the task ends). It keeps the Chat from going quiet and notifying Done
/// before the turn that follows, which would notify a second time.
const WAKE_GRACE: Duration = Duration::from_secs(10);

const QUEUE_READ_RETRY: Duration = Duration::from_millis(250);
const LINK_CONTEXT_RETRY: Duration = Duration::from_secs(1);
const MAX_PENDING_CONTEXTS: usize = 64;

pub(crate) type Reply<T> = oneshot::Sender<Result<T, HostError>>;

pub(crate) enum Command {
    Attach(Reply<(ChatView, Subscription)>),
    Send {
        command_id: Option<String>,
        text: String,
        mode: SendMode,
        attachments: Vec<ChatAttachmentContent>,
        change: Option<ChatInputChange>,
        reply: Reply<ChatInputReceipt>,
    },
    ScheduleSaved {
        message_id: String,
        reply: Reply<()>,
    },
    SendUnattended {
        text: String,
        reply: Reply<ChatMessage>,
    },
    Stop(Reply<()>),
    ResumeQueue(Reply<()>),
    /// The person asked for one queued input to go out now, ahead of the queue.
    SendQueuedNow {
        message_id: String,
        reply: Reply<()>,
    },
    PrepareQueueEdit {
        message_id: String,
        reply: Reply<(String, Vec<ChatAttachmentContent>)>,
    },
    ConfirmQueueEdit {
        message_id: String,
        transfer_id: String,
        reply: Reply<bool>,
    },
    Respond {
        interaction_id: String,
        answer: InteractionAnswer,
        reply: Reply<()>,
    },
    Resume {
        mode: ResumeMode,
        reply: Reply<()>,
    },
    /// The person asked for input whose delivery is uncertain to be sent again.
    Resend {
        message_id: String,
        reply: Reply<()>,
    },
    Trash(Reply<Option<String>>),
    ChangeSetting {
        setting: SettingKey,
        value: String,
        reply: Reply<SettingChangeState>,
    },
    /// The person's New Chat picks, for the next new session this Chat opens.
    StartWith(StartSettings),
    Changed,
    /// The Chat's links were changed; the session is given the new context.
    LinksChanged,
    /// Stop the runtime and report unconfirmed cleanup. An unresolved permission
    /// restart keeps its supervisor when Chat is switched off.
    Shutdown(StopReason, oneshot::Sender<Option<String>>),
}

/// The result of an adapter call that ran in its own task.
enum Done {
    OpenCleanupComplete,
    Dispatched {
        outcome: DispatchOutcome,
    },
    /// The ticketd context read again for the live session after its links changed.
    Context {
        generation: RuntimeGeneration,
        request: Uuid,
        context: Result<Option<String>, String>,
    },
    Interrupted {
        generation: RuntimeGeneration,
        outcome: InterruptOutcome,
    },
    Responded {
        interaction_id: String,
        response: String,
        outcome: RespondOutcome,
        reply: Reply<()>,
    },
    SettingChanged {
        generation: RuntimeGeneration,
        setting: SettingKey,
        value: String,
        outcome: SettingOutcome,
    },
}

/// A late open needs an answer even while other completions wait for Chat On.
struct FinishedOpen {
    generation: RuntimeGeneration,
    result: Result<OpenedRuntime, Problem>,
    accepted: oneshot::Sender<()>,
    context: Result<Option<String>, String>,
}

struct Runtime {
    generation: RuntimeGeneration,
    /// Unique per process, so record IDs derived from native IDs never collide with
    /// those of an earlier runtime or an earlier run of ticketd.
    run: String,
    handle: Arc<dyn HarnessRuntime>,
    events: mpsc::Receiver<RuntimeEvent>,
    capabilities: Capabilities,
    origin: ChatSessionOrigin,
    turns: HashSet<String>,
    tools: HashSet<String>,
    /// Harness notices already kept for this session.
    said: HashSet<String>,
    context: Option<ContextReport>,
    /// Last ticketd link context delivered in this runtime.
    link_context: Option<Arc<str>>,
    /// When the session compacted, kept for a context report that comes later.
    compacted_at: Option<i64>,
    settings: Option<HarnessSettings>,
    setting_changes: Vec<LiveSettingChange>,
    commands: Vec<HarnessCommand>,
}

struct Opening {
    generation: RuntimeGeneration,
    origin: ChatSessionOrigin,
    preamble: Option<String>,
    reply: Option<Reply<()>>,
    context_changed: Option<ContextRefreshScope>,
    start_claimed: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

struct Dispatch {
    attempt: String,
    generation: RuntimeGeneration,
    starts_turn: bool,
    early_rejection: Option<String>,
    preamble: Option<String>,
}

struct ContextTransfer {
    attempt_id: String,
    text: Arc<str>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DirectSend {
    Auto,
    SendNow,
    /// Send now was accepted before the current turn was known to be incompatible.
    AfterTurn,
}

#[derive(Clone)]
struct PendingInput {
    id: String,
    requires_link_context: bool,
}

enum DispatchProgress {
    Finished,
    Skipped,
    ImageNeedsNewTurn,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ContextRefreshScope {
    LinkedInput,
    NextTurn,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ContextRefresh {
    Reading {
        request: Uuid,
        retrying: bool,
        scope: ContextRefreshScope,
    },
    RetryAt {
        at: Instant,
        armed: bool,
        scope: ContextRefreshScope,
    },
}

struct ActiveTurn {
    turn_id: String,
    native: NativeTurnId,
    /// Started by the harness or by ticketd, not by the person's message.
    by_itself: bool,
    /// Open for as long as the Turn is, so every line about it is correlated and its close
    /// records how long it took.
    span: tracing::Span,
}

struct PendingRuntimeLoss {
    ending: TurnEnding,
    turn: Option<PendingTurn>,
    pause_queue: bool,
}

enum PendingTurn {
    Lost(ChatTurnReceipt),
    Observed(ObservedTurnEnd),
}

struct ObservedTurnEnd {
    receipt: ChatTurnReceipt,
    preceding: Vec<ChatObservation>,
    ending: TurnEnding,
}

struct LiveRequest {
    generation: RuntimeGeneration,
    request: NativeRequestId,
    /// The turn it arrived in; `None` for a sub-agent's, which no turn ends.
    turn_id: Option<String>,
    /// The sub-agent that asked, as the Chat stores it.
    owner: ChatOwner,
    kind: InteractionKind,
    /// The response being written, kept so a harness that confirms the answer before
    /// the write returns does not lose what the person chose.
    answering: Option<String>,
}

struct TextBuffer {
    message_id: String,
    turn_id: String,
    text: String,
    /// Bytes already sent to views.
    shown: usize,
    /// Bytes already checkpointed.
    saved: usize,
}

/// What ticketd tells the harness along with the person's next message when sub-agents lost
/// contact (a restart): which ones, and for a harness that can, that they can be resumed.
pub(crate) fn lost_sub_agents_text(titles: &[String], can_resume: bool) -> String {
    let (these, were, are, them) = if titles.len() == 1 {
        ("this sub-agent", "was", "is", "it")
    } else {
        ("these sub-agents", "were", "are", "them")
    };
    let resume = if can_resume {
        format!(" You can resume {them}.")
    } else {
        String::new()
    };
    format!(
        "From ticketd: {these} {were} running when ticketd quit and {are} not running now: {}.{resume}",
        titles.join(", ")
    )
}

/// Numbers supervisors in the order they start; see `Board::report`.
static NEXT_SUPERVISOR: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Supervisor {
    chat_id: String,
    /// This supervisor's number on the board.
    number: u64,
    /// The Chat's span, for work spawned on its behalf (opening the Harness), so the Harness's
    /// stderr lines are correlated with the Chat and do not hold a Turn's span open.
    span: tracing::Span,
    open_workspace: WorkspaceOpener,
    workspace_generation: u64,
    adapter: Option<Arc<dyn HarnessAdapter>>,
    context: Option<ContextSource>,
    /// Set for the Chat of an Automation run: every session opens with these settings.
    unattended: Option<Arc<UnattendedChat>>,
    board: Arc<Board>,
    commands: mpsc::Receiver<Command>,
    done: mpsc::UnboundedSender<Done>,
    finished: mpsc::UnboundedReceiver<Done>,
    open_done: mpsc::UnboundedSender<FinishedOpen>,
    finished_open: mpsc::UnboundedReceiver<FinishedOpen>,
    generations: u64,
    runtime: Option<Runtime>,
    opening: Option<Opening>,
    dispatching: Option<Dispatch>,
    /// A new turn that was written with no acknowledgment or turn seen yet.
    unconfirmed_start: Option<String>,
    /// What the adapter reported about how the turn it names is ending, until its
    /// `TurnEnded` arrives.
    turn_evidence: Option<(NativeTurnId, TurnEvidence)>,
    /// When an unconfirmed start stops counting as work in progress.
    unconfirmed_deadline: Option<Instant>,
    active: Option<ActiveTurn>,
    /// The sub-agents running in this runtime, by native ID, and whether each runs in the
    /// background. One in the foreground ends with its turn.
    sub_agents: HashMap<String, bool>,
    /// The run each of them is in, by native ID, for the harness that names runs: a frame of
    /// an earlier run that arrives after a resume is late.
    sub_agent_runs: HashMap<String, String>,
    /// While a sub-agent has just finished with no turn running: until when the main agent
    /// is still expected to resume by itself, and the Chat stays working.
    wake_until: Option<Instant>,
    /// Input the person sent for immediate dispatch, ahead of the queue.
    direct: VecDeque<(PendingInput, DirectSend)>,
    /// Prepared edits keep their saved rows. The automatic queue waits for the
    /// composer, while an explicit Send now or Resume may still release them.
    prepared_queue_edits: HashSet<String>,
    /// Input the person asked to send again although its delivery is uncertain.
    resend: Option<PendingInput>,
    /// Selected history for a fresh session, sent with the next new turn.
    preamble: Option<String>,
    /// The ticketd context of a new session, sent with its first new turn.
    session_context: Option<Arc<str>>,
    /// Unconfirmed context transfers, in dispatch order.
    pending_contexts: VecDeque<ContextTransfer>,
    text: Vec<TextBuffer>,
    pending_tools: Vec<(String, ChatObservation)>,
    interactions: BTreeMap<String, LiveRequest>,
    stop: Option<StopState>,
    stop_when_turn_known: bool,
    problem: Option<ChatProblem>,
    storage_failed: Option<String>,
    pending_runtime_loss: Option<PendingRuntimeLoss>,
    subscribers: Vec<Publisher>,
    cursor: i64,
    last_live: Option<ChatLive>,
    show_text_at: Option<Instant>,
    checkpoint_at: Option<Instant>,
    stop_deadline: Option<Instant>,
    shutting_down: bool,
    /// Why ticketd is shutting the Chat down, kept on a turn the harness reports
    /// interrupted meanwhile, so it does not read as the person's stop.
    shut_down_for: Option<StopReason>,
    /// The person resumed the queue or sent into it, so it may open a session. Without
    /// that, queued input waits for a live runtime: viewing a Chat starts nothing.
    queue_started: bool,
    /// A saved takeover reply which still needs its place in the queue decided.
    saved_reply: Option<String>,
    /// Wake to retry reading the queue without saving an input or recording an attempt again.
    queue_read_retry_at: Option<Instant>,
    /// The runtime is being closed on purpose; its connection ending is not a loss.
    closing: bool,
    /// Something may have been written since views were last brought up to date.
    unpublished: bool,
    /// A context read or its paced retry. Unrelated steering can continue.
    refreshing: Option<ContextRefresh>,
    /// The person's picks for the next session, new or resumed: New Chat's, or a change
    /// made while no session ran. Kept until one opens.
    start_settings: StartSettings,
    reopen_for_permission: Option<String>,
    /// A permission restart may only resume native history, unless the person
    /// explicitly chooses a fresh session. The restriction survives failed opens.
    permission_restart_pending: bool,
    lifecycle: Arc<HostLifecycle>,
    /// What the Chat's sessions last reported in effect, as recorded with the Chat
    /// (`Chat::effective_settings`): what a session opened for it again starts with.
    recorded_settings: Option<String>,
}

async fn next_event(runtime: &mut Option<Runtime>) -> Option<RuntimeEvent> {
    match runtime {
        Some(runtime) => runtime.events.recv().await,
        None => pending().await,
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => pending().await,
    }
}

pub(crate) async fn bounded_close(handle: &dyn HarnessRuntime) -> Option<String> {
    match timeout(CLOSE_TIMEOUT, handle.close()).await {
        Ok(CloseOutcome::Confirmed { .. }) => None,
        Ok(CloseOutcome::Unconfirmed { reason }) => Some(reason),
        Err(_) => Some("the harness did not confirm that it exited in time".to_owned()),
    }
}

fn prompt_admission_refused(refusal: &Refusal) -> bool {
    matches!(
        refusal,
        Refusal::AutomationPromptNotAllowed | Refusal::AutomationPromptOwnershipUnavailable
    )
}

impl Supervisor {
    pub(crate) fn spawn(
        chat: &Chat,
        open_workspace: WorkspaceOpener,
        adapter: Option<Arc<dyn HarnessAdapter>>,
        context: Option<ContextSource>,
        board: Arc<Board>,
        unattended: Option<Arc<UnattendedChat>>,
        lifecycle: Arc<HostLifecycle>,
    ) -> mpsc::Sender<Command> {
        let (supervisor, sender) = Self::new(
            chat,
            open_workspace,
            adapter,
            context,
            board,
            unattended,
            lifecycle,
        );
        let span = supervisor.span.clone();
        tokio::spawn(supervisor.run().instrument(span));
        sender
    }

    fn new(
        chat: &Chat,
        open_workspace: WorkspaceOpener,
        adapter: Option<Arc<dyn HarnessAdapter>>,
        context: Option<ContextSource>,
        board: Arc<Board>,
        unattended: Option<Arc<UnattendedChat>>,
        lifecycle: Arc<HostLifecycle>,
    ) -> (Self, mpsc::Sender<Command>) {
        let (sender, commands) = mpsc::channel(64);
        let (done, finished) = mpsc::unbounded_channel();
        let (open_done, finished_open) = mpsc::unbounded_channel();
        // A root span, so a Chat opened from inside a command or a pass is not held open by it.
        let span = tracing::info_span!(
            parent: None,
            "chat",
            chat_id = chat.id.as_str(),
            automation_run_id = unattended
                .as_ref()
                .map(|unattended| unattended.settings.run_id.as_str()),
        );
        let supervisor = Self {
            span,
            chat_id: chat.id.clone(),
            number: NEXT_SUPERVISOR.fetch_add(1, Ordering::Relaxed),
            open_workspace,
            workspace_generation: lifecycle.workspace_generation(),
            adapter,
            context,
            unattended,
            board,
            commands,
            done,
            finished,
            open_done,
            finished_open,
            generations: 0,
            runtime: None,
            opening: None,
            dispatching: None,
            unconfirmed_start: None,
            turn_evidence: None,
            unconfirmed_deadline: None,
            active: None,
            direct: VecDeque::new(),
            prepared_queue_edits: HashSet::new(),
            resend: None,
            preamble: None,
            session_context: None,
            pending_contexts: VecDeque::new(),
            text: Vec::new(),
            pending_tools: Vec::new(),
            interactions: BTreeMap::new(),
            stop: None,
            stop_when_turn_known: false,
            problem: None,
            storage_failed: None,
            pending_runtime_loss: None,
            subscribers: Vec::new(),
            cursor: 0,
            last_live: None,
            show_text_at: None,
            checkpoint_at: None,
            stop_deadline: None,
            sub_agents: HashMap::new(),
            sub_agent_runs: HashMap::new(),
            wake_until: None,
            shutting_down: false,
            shut_down_for: None,
            queue_started: false,
            saved_reply: None,
            queue_read_retry_at: None,
            closing: false,
            unpublished: true,
            refreshing: None,
            start_settings: StartSettings::default(),
            reopen_for_permission: None,
            permission_restart_pending: false,
            lifecycle,
            recorded_settings: chat.effective_settings.clone(),
        };
        (supervisor, sender)
    }

    async fn run(mut self) {
        loop {
            let timer = [
                self.show_text_at,
                self.checkpoint_at,
                self.stop_deadline,
                self.unconfirmed_deadline,
                self.queue_read_retry_at,
                self.wake_until,
                self.context_retry_at(),
            ]
            .into_iter()
            .flatten()
            .min();
            tokio::select! {
                command = self.commands.recv() => match command {
                    Some(Command::Shutdown(why, reply)) => {
                        self.shutting_down = true;
                        let keep_permission_recovery = self.permission_restart_pending
                            && self.runtime.is_none()
                            && self.opening.is_none();
                        let unconfirmed = self.stop_runtime(why).await;
                        if why == StopReason::TurnedOff && self.unattended.is_some() {
                            self.finish_unattended_shutdown(why);
                        }
                        self.publish();
                        if why == StopReason::TurnedOff
                            && (keep_permission_recovery || self.pending_runtime_loss.is_some())
                        {
                            // Keep recovery state for when Chat is enabled again.
                            self.subscribers.clear();
                            self.queue_started = false;
                            let _ = reply.send(unconfirmed);
                            continue;
                        }
                        self.board.report(&self.chat_id, self.number, None);
                        self.commands.close();
                        let _ = reply.send(unconfirmed);
                        return;
                    }
                    Some(command) => {
                        if self.shutting_down {
                            if self.lifecycle.is_off() {
                                // A command may have taken a sender before Chat was switched off.
                                continue;
                            }
                            self.shutting_down = false;
                            self.shut_down_for = None;
                        }
                        let turn = self.turn_span();
                        self.on_command(command).instrument(turn).await;
                    }
                    None => {
                        self.shutting_down = true;
                        self.stop_runtime(StopReason::Quit).await;
                        self.board.report(&self.chat_id, self.number, None);
                        return;
                    }
                },
                Some(opened) = self.finished_open.recv() => {
                    // Dropping the handoff while Off lets the opening worker close
                    // the late runtime. Other completions wait for storage recovery.
                    if !self.shutting_down {
                        self.turn_span().in_scope(|| self.on_opened(opened));
                    }
                }
                Some(done) = self.finished.recv(), if !self.shutting_down => {
                    self.turn_span().in_scope(|| self.on_done(done));
                }
                event = next_event(&mut self.runtime), if !self.shutting_down => {
                    self.turn_span().in_scope(|| self.on_event(event));
                }
                () = sleep_until_some(timer), if !self.shutting_down => {
                    self.turn_span().in_scope(|| self.on_timer());
                }
            }
            if self.storage_failed.is_some() && (self.runtime.is_some() || self.opening.is_some()) {
                // Controlled shutdown: nothing more can be recorded, so nothing more runs.
                if let Some(reason) = self.stop_runtime(StopReason::StorageFailed).await {
                    self.notice(format!("Stopping the harness was not confirmed: {reason}"));
                }
            }
            if let Some(value) = self.reopen_for_permission.take() {
                self.reopen_for_permission(value).await;
            }
            // Before the queue can start another turn, so held changes apply to it.
            self.send_held_settings();
            self.pump();
            self.publish();
        }
    }

    // ------------------------------------------------------------------
    // Core access
    // ------------------------------------------------------------------

    // ponytail: SQLite runs on the supervisor task; move to spawn_blocking if a slow
    // disk shows up as stalled Chats.
    fn core<T>(&self, call: impl FnOnce(&mut Workspace) -> Result<T, Error>) -> Result<T, Error> {
        let mut workspace = (self.open_workspace)()?;
        call(&mut workspace)
    }

    /// A core write. A failure that is not a refusal of this one request means history
    /// can no longer be kept, so the Chat stops admitting and dispatching work.
    fn write<T>(
        &mut self,
        call: impl FnOnce(&mut Workspace) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.unpublished = true;
        let result = self.core(call);
        if let Err(error) = &result
            && !is_refusal(error)
        {
            self.storage_failed = Some(error.to_string());
        }
        result
    }

    /// Records observations after any streamed text that precedes them.
    fn record(&mut self, observations: Vec<ChatObservation>) {
        let batch = self.observation_batch(observations);
        self.record_batch(batch, None);
    }

    fn observation_batch(
        &mut self,
        mut observations: Vec<ChatObservation>,
    ) -> Vec<ChatObservation> {
        self.show_text();
        let mut batch = Vec::new();
        for buffer in &mut self.text {
            if buffer.saved < buffer.text.len() {
                buffer.saved = buffer.text.len();
                batch.push(ChatObservation::AssistantText {
                    message_id: buffer.message_id.clone(),
                    turn_id: Some(buffer.turn_id.clone()),
                    owner: ChatOwner::Main,
                    text: buffer.text.clone(),
                    complete: false,
                });
            }
        }
        batch.extend(self.pending_tools.drain(..).map(|(_, tool)| tool));
        batch.append(&mut observations);
        self.checkpoint_at = None;
        batch
    }

    fn write_observations(
        &mut self,
        batch: Vec<ChatObservation>,
        receipt: Option<&mut ChatTurnReceipt>,
    ) -> Result<(), Error> {
        let chat = self.chat_id.clone();
        self.write(|core| match receipt {
            Some(receipt) => core.record_chat_turn_observations(&chat, batch, receipt),
            None => core.record_chat_observations(&chat, batch),
        })
        .map(|_| ())
    }

    fn record_batch(
        &mut self,
        batch: Vec<ChatObservation>,
        mut receipt: Option<&mut ChatTurnReceipt>,
    ) {
        if batch.is_empty() {
            return;
        }
        if let Err(Error::Chat(_)) = self.write_observations(batch.clone(), receipt.as_deref_mut())
        {
            // One observation was refused; keep the others.
            for observation in batch {
                if let Err(Error::Chat(reason)) =
                    self.write_observations(vec![observation], receipt.as_deref_mut())
                {
                    self.notice(format!("An observation was not recorded: {reason}"));
                }
            }
        }
    }

    fn record_turn_end(&mut self, end: &mut ObservedTurnEnd) -> Result<(), Error> {
        let record = |host: &mut Self, end: &mut ObservedTurnEnd| {
            let mut batch = end.preceding.clone();
            let turn_id = end.receipt.turn_id();
            batch.push(end.ending.observation(turn_id.to_owned()));
            batch.push(ChatObservation::CaptureAgentChanges {
                turn_id: turn_id.to_owned(),
            });
            host.write_observations(batch, Some(&mut end.receipt))
        };
        let mut result = record(self, end);
        if matches!(result, Err(Error::Chat(_))) && !end.preceding.is_empty() {
            // Keep the valid observations when one was refused. The end and
            // receipt are still written together, at the boundary already read.
            self.record_batch(std::mem::take(&mut end.preceding), Some(&mut end.receipt));
            result = record(self, end);
        }
        if let Err(Error::Chat(reason)) = &result {
            self.notice(format!("An observation was not recorded: {reason}"));
        }
        result
    }

    fn pause(&mut self, problem: ChatProblem) {
        self.hold_queue();
        self.problem = Some(problem);
    }

    /// Pauses the queue and drops what was to go ahead of it: input stays queued
    /// until the person resumes or sends it.
    fn hold_queue(&mut self) {
        let chat = self.chat_id.clone();
        let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
        self.clear_direct();
        self.resend = None;
    }

    fn clear_direct(&mut self) {
        self.saved_reply = None;
        self.queue_read_retry_at = None;
        self.direct.clear();
    }

    /// Keeps the person's latest permission change the runtime has not answered (held
    /// for the turn's end, or on its way) for the next session, saved with the Chat: the
    /// runtime it was meant for is going away, and the next one must not open with the
    /// mode they left.
    fn keep_unanswered_permission(&mut self) {
        let unanswered = self.runtime.as_ref().and_then(|runtime| {
            runtime
                .setting_changes
                .iter()
                .rfind(|change| {
                    change.setting == SettingKey::Permission
                        && matches!(
                            change.state,
                            SettingChangeState::Held | SettingChangeState::Sent
                        )
                })
                .map(|change| change.value.clone())
        });
        if let Some(value) = unanswered {
            // Kept for the next session whether or not it could be saved.
            let _ = self.record_permission(&value);
            self.start_settings.permission = Some(value);
        }
    }

    /// A setting change is on its way to the harness. Nothing is dispatched until it
    /// is answered, so the next turn runs on the settings the person last chose.
    fn setting_on_its_way(&self) -> bool {
        self.runtime.as_ref().is_some_and(|runtime| {
            runtime
                .setting_changes
                .iter()
                .any(|change| change.state == SettingChangeState::Sent)
        })
    }

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    async fn on_command(&mut self, command: Command) {
        // A command may follow a write made outside this task (links, folder, retention).
        self.unpublished = true;
        match command {
            Command::Attach(reply) => {
                let _ = reply.send(self.attach());
            }
            Command::SendUnattended { text, reply } => {
                let Some(unattended) = self.unattended.clone() else {
                    let _ = reply.send(Err(HostError::Quitting));
                    return;
                };
                let result = self.recover_storage().and_then(|()| {
                    let chat_id = self.chat_id.clone();
                    self.write(|core| {
                        core.save_automation_chat_prompt(
                            &chat_id,
                            &unattended.settings.run_id,
                            &text,
                        )
                    })
                    .map_err(HostError::from)
                });
                if let Ok(message) = &result {
                    let _ = unattended.first_message.set(message.id.clone());
                    // The run cannot drain the ordinary queue, even when older input waits.
                    if self.active.is_none() && self.can_schedule_saved(message) {
                        let input = self.pending_input(message);
                        self.direct.push_back((input, DirectSend::Auto));
                    }
                }
                let _ = reply.send(result);
            }
            Command::Send {
                command_id,
                text,
                mode,
                attachments,
                change,
                reply,
            } => {
                let _ = reply.send(self.send(
                    command_id.as_deref(),
                    &text,
                    mode,
                    &attachments,
                    change.as_ref(),
                ));
            }
            Command::ScheduleSaved { message_id, reply } => {
                self.saved_reply = Some(message_id);
                let _ = reply.send(Ok(()));
            }
            Command::Stop(reply) => {
                let stopped = self.request_stop();
                if stopped.is_ok() {
                    self.stop_sub_agents_at_rest().await;
                }
                let _ = reply.send(stopped);
            }
            Command::ResumeQueue(reply) => {
                let _ = reply.send(self.resume_queue().await);
            }
            Command::SendQueuedNow { message_id, reply } => {
                let _ = reply.send(self.send_queued_now(message_id).await);
            }
            Command::PrepareQueueEdit { message_id, reply } => {
                let draft = self.prepare_queue_edit(&message_id);
                let prepared = draft.is_ok();
                if reply.send(draft).is_ok() && prepared {
                    self.prepared_queue_edits.insert(message_id);
                }
            }
            Command::ConfirmQueueEdit {
                message_id,
                transfer_id,
                reply,
            } => {
                let _ = reply.send(self.confirm_queue_edit(&message_id, &transfer_id));
            }
            Command::Respond {
                interaction_id,
                answer,
                reply,
            } => self.respond(interaction_id, answer, reply),
            Command::Resume { mode, reply } => self.resume(mode, reply).await,
            Command::Resend { message_id, reply } => {
                let _ = reply.send(self.request_resend(message_id).await);
            }
            Command::Trash(reply) => {
                let chat = self.chat_id.clone();
                let result = match self.write(|core| core.set_chat_trashed(&chat, true)) {
                    Ok(_) => Ok(self.stop_runtime(StopReason::Trashed).await),
                    Err(error) => Err(error.into()),
                };
                let _ = reply.send(result);
            }
            Command::ChangeSetting {
                setting,
                value,
                reply,
            } => {
                let _ = reply.send(Ok(self.change_setting(setting, value)));
            }
            Command::StartWith(settings) => self.start_settings = settings,
            Command::LinksChanged => self.refresh_context(ContextRefreshScope::NextTurn),
            // Views read the Chat again even when no record changed: what they show
            // can depend on the folder too, such as its branch.
            Command::Changed => self.last_live = None,
            Command::Shutdown(..) => {}
        }
    }

    /// Refuses a value the harness did not offer, holds a change while a turn runs and
    /// otherwise sends it now.
    fn change_setting(&mut self, setting: SettingKey, value: String) -> SettingChangeState {
        let busy = self.active.is_some()
            || self.dispatching.is_some()
            || self.unconfirmed_start.is_some()
            || self.setting_on_its_way();
        let Some(runtime) = &mut self.runtime else {
            return self.pick_for_next_session(setting, value);
        };
        let state = match runtime.settings.as_ref().and_then(|s| s.get(setting)) {
            None => SettingChangeState::Done(SettingOutcome::Unsupported),
            Some(reported) => match reported.refusal(&value) {
                Some(reason) => SettingChangeState::Done(SettingOutcome::Refused { reason }),
                None if busy => SettingChangeState::Held,
                None => SettingChangeState::Sent,
            },
        };
        // A change still on its way stays tracked until the harness answers it, whatever
        // is asked meanwhile: nothing is dispatched before then (`setting_on_its_way`).
        runtime
            .setting_changes
            .retain(|change| change.setting != setting || change.state == SettingChangeState::Sent);
        runtime.setting_changes.push(LiveSettingChange {
            setting,
            value: value.clone(),
            state: state.clone(),
        });
        if state == SettingChangeState::Sent {
            self.send_setting(setting, value);
        }
        state
    }

    /// With no session running, the permission can still be chosen: the next session,
    /// new or resumed, opens with it. Held until then, so the trigger shows it as the
    /// mode the next message runs in.
    fn pick_for_next_session(&mut self, setting: SettingKey, value: String) -> SettingChangeState {
        let refused = |reason: &str| {
            SettingChangeState::Done(SettingOutcome::Refused {
                reason: reason.to_owned(),
            })
        };
        let shown = self.settings_before_session();
        let Some(offered) = shown.as_ref().and_then(|shown| shown.get(setting)) else {
            return refused(if self.opening.is_some() {
                "the session is starting"
            } else {
                "no session is running"
            });
        };
        if let Some(reason) = offered.refusal(&value) {
            return SettingChangeState::Done(SettingOutcome::Refused { reason });
        }
        match setting {
            // Taken only once saved: the shown mode must be the one the Chat reopens in.
            SettingKey::Permission if self.record_permission(&value).is_err() => {
                return refused("the change could not be saved");
            }
            SettingKey::Permission => self.start_settings.permission = Some(value),
            // Only the permission is shown before a session.
            SettingKey::Model | SettingKey::Effort => return refused("no session is running"),
        }
        SettingChangeState::Held
    }

    /// Saves `value` with the Chat as the permission its next session opens with, as
    /// soon as the change is accepted, so a restart before the next message cannot bring
    /// back a mode the person left. The record views read changes only once it is saved.
    fn record_permission(&mut self, value: &str) -> Result<(), Error> {
        let Some(updated) = self.adapter.as_ref().and_then(|adapter| {
            adapter.record_permission(self.recorded_settings.as_deref(), value)
        }) else {
            return Ok(());
        };
        let chat = self.chat_id.clone();
        self.write(|core| core.set_chat_effective_settings(&chat, &updated))?;
        self.recorded_settings = Some(updated);
        Ok(())
    }

    /// The settings shown while no session runs or opens: the permission its next
    /// session starts with, as the adapter reads the pick and the Chat's record. An
    /// Automation's agent shows none: its settings are the agent's.
    fn settings_before_session(&self) -> Option<HarnessSettings> {
        if self.unattended.is_some() || self.opening.is_some() || self.runtime.is_some() {
            return None;
        }
        let permission = self.adapter.as_ref()?.permission_before_session(
            self.recorded_settings.as_deref(),
            self.start_settings.permission.as_deref(),
        )?;
        Some(HarnessSettings {
            model: None,
            effort: None,
            permission: Some(permission),
        })
    }

    fn send_setting(&self, setting: SettingKey, value: String) {
        let Some(runtime) = &self.runtime else {
            return;
        };
        let (handle, done, generation) = (
            runtime.handle.clone(),
            self.done.clone(),
            runtime.generation,
        );
        tokio::spawn(async move {
            let change = SettingChange {
                generation,
                setting,
                value: value.clone(),
            };
            let outcome = handle.change_setting(change).await;
            let _ = done.send(Done::SettingChanged {
                generation,
                setting,
                value,
                outcome,
            });
        });
    }

    /// Sends the changes held during a turn once no turn runs or is starting.
    fn send_held_settings(&mut self) {
        if self.active.is_some()
            || self.dispatching.is_some()
            || self.unconfirmed_start.is_some()
            || self.setting_on_its_way()
        {
            return;
        }
        let change = self.runtime.as_mut().and_then(|runtime| {
            runtime
                .setting_changes
                .iter_mut()
                .find(|change| change.state == SettingChangeState::Held)
        });
        if let Some(change) = change {
            change.state = SettingChangeState::Sent;
            let (setting, value) = (change.setting, change.value.clone());
            self.send_setting(setting, value);
        }
    }

    /// Reads the ticketd context again for the live session. Without one there is nothing
    /// to tell: the next session reads the context when it opens.
    fn refresh_context(&mut self, mut scope: ContextRefreshScope) {
        let Some(source) = self.context.clone() else {
            return;
        };
        if let Some(opening) = &mut self.opening {
            if opening.context_changed != Some(ContextRefreshScope::NextTurn) {
                opening.context_changed = Some(scope);
            }
            return;
        }
        let Some(runtime) = &self.runtime else {
            return;
        };
        let retrying = match self.refreshing {
            Some(ContextRefresh::RetryAt {
                at,
                armed,
                scope: previous,
            }) => {
                if previous == ContextRefreshScope::NextTurn {
                    scope = previous;
                }
                if at > Instant::now() {
                    self.refreshing = Some(ContextRefresh::RetryAt { at, armed, scope });
                    return;
                }
                true
            }
            Some(ContextRefresh::Reading {
                retrying,
                scope: previous,
                ..
            }) => {
                if previous == ContextRefreshScope::NextTurn {
                    scope = previous;
                }
                retrying
            }
            None => false,
        };
        let (done, chat_id, generation) =
            (self.done.clone(), self.chat_id.clone(), runtime.generation);
        let request = Uuid::new_v4();
        self.refreshing = Some(ContextRefresh::Reading {
            request,
            retrying,
            scope,
        });
        tokio::spawn(async move {
            // It runs the CLI and can take seconds: off the async threads.
            let context = tokio::task::spawn_blocking(move || source(&chat_id))
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
            let _ = done.send(Done::Context {
                generation,
                request,
                context,
            });
        });
    }

    fn context_retry_at(&self) -> Option<Instant> {
        match self.refreshing {
            Some(ContextRefresh::RetryAt { at, armed, scope })
                if armed || scope == ContextRefreshScope::NextTurn =>
            {
                Some(at)
            }
            _ => None,
        }
    }

    fn context_read_failed(&mut self, error: String, retrying: bool, scope: ContextRefreshScope) {
        if !retrying {
            self.notice(format!(
                "ticketd could not read this Chat's changed links, so the session was not told about them: {error}"
            ));
        }
        self.schedule_context_retry(scope);
    }

    fn schedule_context_retry(&mut self, scope: ContextRefreshScope) {
        self.refreshing = Some(ContextRefresh::RetryAt {
            at: Instant::now() + LINK_CONTEXT_RETRY,
            armed: false,
            scope,
        });
    }

    fn arm_context_retry(&mut self) {
        if let Some(ContextRefresh::RetryAt { armed, .. }) = &mut self.refreshing {
            *armed = true;
        }
    }

    fn retry_link_context(&mut self) {
        if self
            .direct
            .iter()
            .any(|(input, _)| input.requires_link_context)
            && let Ok(queue) = self.core(|core| core.chat_queue(&self.chat_id))
        {
            // A pending input may have been withdrawn while the context was unavailable.
            self.direct.retain(|(input, _)| {
                !input.requires_link_context || queue.iter().any(|message| message.id == input.id)
            });
        }
        self.refresh_context(ContextRefreshScope::LinkedInput);
    }

    /// The context this Chat's sessions were last given or are about to be given.
    fn context_given(&self) -> Option<Arc<str>> {
        if let Some(context) = self.session_context.as_ref() {
            return Some(context.clone());
        }
        if let Some(transfer) = self.pending_contexts.back() {
            return Some(transfer.text.clone());
        }
        if let Some(runtime) = &self.runtime
            && (runtime.link_context.is_some() || runtime.origin != ChatSessionOrigin::NativeResume)
        {
            return runtime.link_context.clone();
        }
        let chat = self.chat_id.clone();
        // Unreadable: treated as never given, so the context is sent rather than lost.
        self.core(|core| core.chat_latest_tool_input(&chat, CONTEXT_RECORD_NAME))
            .ok()
            .flatten()
            .map(Arc::from)
    }

    fn set_session_context(&mut self, context: String) {
        let retained = self
            .pending_contexts
            .iter()
            .find(|transfer| *transfer.text == context)
            .map(|transfer| transfer.text.clone());
        self.session_context = Some(retained.unwrap_or_else(|| Arc::from(context)));
    }

    fn attach(&mut self) -> Result<(ChatView, Subscription), HostError> {
        // Views already attached get everything up to here, so the cursor can move to
        // the snapshot; the new view's snapshot then includes all streamed text.
        self.record(Vec::new());
        self.publish();
        let chat = self.chat_id.clone();
        let snapshot = self.core(|core| core.chat_snapshot(&chat, SNAPSHOT_ITEMS))?;
        self.cursor = snapshot.sequence;
        let (publisher, subscription) = subscription::channel();
        self.subscribers.push(publisher);
        let live = self.live();
        self.last_live = Some(live.clone());
        Ok((ChatView { snapshot, live }, subscription))
    }

    fn send(
        &mut self,
        command_id: Option<&str>,
        text: &str,
        mode: SendMode,
        attachments: &[ChatAttachmentContent],
        change: Option<&ChatInputChange>,
    ) -> Result<ChatInputReceipt, HostError> {
        let chat = self.chat_id.clone();
        // A lost reply can arrive after queue eligibility changed. Repeating an
        // already saved edit returns its receipt without dispatching it again.
        if change.is_some()
            && let Some(command_id) = command_id
            && let Some(saved) = self.core(|core| {
                core.replay_chat_input_with_change(command_id, &chat, text, attachments, change)
            })?
        {
            return Ok(saved);
        }
        self.recover_storage()?;
        let has_images = attachments.iter().any(ChatAttachmentContent::is_image);
        let can_steer = self.active.is_some()
            && self.steering().is_some()
            && !(has_images && self.images_refused(true));
        if !attachments.is_empty() {
            let model_changing = self.runtime.as_ref().is_some_and(|runtime| {
                runtime.setting_changes.iter().any(|change| {
                    change.setting == SettingKey::Model
                        && matches!(
                            change.state,
                            SettingChangeState::Held | SettingChangeState::Sent
                        )
                })
            });
            let mut refusal = self.attachment_refusal(attachments);
            if refusal.is_none()
                && has_images
                && self.images_refused(false)
                && !model_changing
                && (mode != SendMode::Auto
                    || !can_steer
                    || self.linked_input_waits_for_new_turn(change)?)
            {
                refusal = Some(Refusal::ImageInputUnsupported);
            }
            if let Some(refusal) = refusal {
                if change.is_none()
                    && let Some(command_id) = command_id
                    && let Some(saved) = self.core(|core| {
                        core.replay_chat_input_replacing(command_id, &chat, text, attachments, &[])
                    })?
                {
                    return Ok(saved);
                }
                return Err(refusal.attachment_error().into());
            }
        }
        let (receipt, linked) = self.write(|core| {
            core.save_chat_input_with_change(command_id, &chat, text, attachments, change)
        })?;
        if linked {
            self.refresh_context(ContextRefreshScope::LinkedInput);
        }
        if mode == SendMode::Auto
            && let Some(message) = &receipt.message
        {
            self.schedule_saved(message, self.active.is_none() || can_steer);
        }
        Ok(receipt)
    }

    fn can_schedule_saved(&self, message: &ChatMessage) -> bool {
        !self.lifecycle.has_retired_permission_runtime(&self.chat_id)
            && message.queued
            && !message.editing
            && !self.prepared_queue_edits.contains(&message.id)
            && !self.is_sending(&message.id)
    }

    fn pending_input(&self, message: &ChatMessage) -> PendingInput {
        PendingInput {
            id: message.id.clone(),
            requires_link_context: message.requires_link_context && self.context.is_some(),
        }
    }

    fn is_sending(&self, message_id: &str) -> bool {
        self.direct.iter().any(|(input, _)| input.id == message_id)
    }

    fn waits_for_new_turn(&self, input: &PendingInput, intent: DirectSend) -> bool {
        intent == DirectSend::AfterTurn || (input.requires_link_context && self.context_pending())
    }

    fn context_pending(&self) -> bool {
        self.refreshing.is_some()
            || self.session_context.is_some()
            || !self.pending_contexts.is_empty()
    }

    /// A new link schedules a refresh. An existing link or the held input's
    /// context requirement only prevents a steer while that context is pending.
    fn linked_input_waits_for_new_turn(
        &self,
        change: Option<&ChatInputChange>,
    ) -> Result<bool, Error> {
        let Some(change) = change.filter(|_| self.context.is_some()) else {
            return Ok(false);
        };
        let (links, replaces) = match change {
            ChatInputChange::Link(links) => (links.as_slice(), &[][..]),
            ChatInputChange::Edit(edit) => (edit.links.as_slice(), edit.replaces.as_slice()),
        };
        let pending = self.context_pending();
        self.core(|core| {
            if !links.is_empty() {
                let chat = core.chat(&self.chat_id)?;
                if pending || links.iter().any(|link| !chat.links.contains(link)) {
                    return Ok(true);
                }
            }
            if pending {
                for original in replaces {
                    if core.chat_input_requires_link_context(&self.chat_id, original)? {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        })
    }

    fn schedule_saved(&mut self, message: &ChatMessage, immediate: bool) {
        if immediate && self.can_schedule_saved(message) {
            if self.active.is_none() && self.older_input_waits(&message.id) {
                // Older input waits in a queue that is not paused: this goes after
                // it, and the queue runs.
                self.queue_started = true;
            } else {
                let input = self.pending_input(message);
                self.direct.push_back((input, DirectSend::Auto));
            }
        }
    }

    /// Returns false while a saved takeover reply still needs its queue order read.
    fn schedule_takeover_reply(&mut self) -> bool {
        let Some(saved) = &self.saved_reply else {
            return true;
        };
        let chat_id = &self.chat_id;
        match self.core(|core| {
            let chat = core.chat(chat_id)?;
            Ok((chat.trashed, chat.queue_paused, core.chat_queue(chat_id)?))
        }) {
            Ok((trashed, paused, queue)) => {
                if !trashed
                    && self.active.is_none()
                    && let Some(message) = queue.iter().find(|message| message.id == *saved)
                    && self.can_schedule_saved(message)
                {
                    let input = self.pending_input(message);
                    if input.requires_link_context {
                        self.refresh_context(ContextRefreshScope::LinkedInput);
                    }
                    if !paused
                        && queue
                            .iter()
                            .find(|row| !row.editing)
                            .is_some_and(|first| first.id != message.id)
                    {
                        self.queue_started = true;
                    } else {
                        self.direct.push_front((input, DirectSend::Auto));
                    }
                }
                self.saved_reply = None;
                true
            }
            Err(error) if is_refusal(&error) => {
                self.saved_reply = None;
                true
            }
            Err(_) => {
                self.queue_read_retry_at = Some(Instant::now() + QUEUE_READ_RETRY);
                false
            }
        }
    }

    fn attachment_refusal(&self, attachments: &[ChatAttachmentContent]) -> Option<Refusal> {
        if attachments.is_empty() {
            return None;
        }
        self.adapter
            .as_ref()
            .map_or(Some(Refusal::Unsupported), |adapter| {
                adapter.attachment_refusal(attachments)
            })
    }

    fn images_refused(&self, steering: bool) -> bool {
        self.runtime.as_ref().and_then(|runtime| {
            if steering {
                runtime.handle.supports_steer_image_input()
            } else {
                runtime.handle.supports_image_input()
            }
        }) == Some(false)
    }

    /// Accept work again only once storage can record what was lost meanwhile.
    fn recover_storage(&mut self) -> Result<(), HostError> {
        if self.storage_failed.is_none() {
            return Ok(());
        }
        let settled = if self.pending_runtime_loss.is_some() {
            self.settle_runtime_loss()
        } else {
            let ending = TurnEnding::StoppedByTicketd(StopReason::StorageFailed);
            self.core(|core| {
                core.mark_chat_contact_lost(
                    Some(&self.chat_id),
                    &ending.detail().unwrap_or_default(),
                    &ending.key(),
                )?;
                Ok(())
            })
        };
        settled.map_err(|error| HostError::StorageFailed(error.to_string()))?;
        self.storage_failed = None;
        self.problem = None;
        Ok(())
    }

    async fn resume_queue(&mut self) -> Result<(), HostError> {
        self.recover_storage()?;
        self.confirm_permission_restart_cleanup().await?;
        let chat = self.chat_id.clone();
        self.write(|core| core.set_chat_queue_paused(&chat, false))?;
        self.prepared_queue_edits.clear();
        // The person asked for the queue to run: it opens a session when none is live.
        self.queue_started = true;
        if matches!(self.problem, Some(ChatProblem::DispatchRefused { .. })) {
            self.problem = None;
        }
        Ok(())
    }

    /// Sends one queued input now: it steers the turn in progress or starts one. Only
    /// that input goes; a paused queue stays paused. Refused while a turn runs that
    /// cannot be steered, since the input could only wait in the queue where it is.
    async fn send_queued_now(&mut self, message_id: String) -> Result<(), HostError> {
        if let Some(detail) = &self.storage_failed {
            return Err(HostError::StorageFailed(detail.clone()));
        }
        if self.active.is_some() && self.steering().is_none() {
            return Err(HostError::Working);
        }
        let chat = self.chat_id.clone();
        let queued = self
            .core(|core| core.chat_queue(&chat))?
            .into_iter()
            .find(|message| message.id == message_id && !message.editing)
            .ok_or_else(|| Error::Chat("this input is not in the queue".to_owned()))?;
        if self.active.is_some()
            && self.images_refused(true)
            && queued
                .attachments
                .iter()
                .any(|file| file.media_type.starts_with("image/"))
        {
            return Err(Refusal::ImageInputUnsupported.attachment_error().into());
        }
        self.confirm_permission_restart_cleanup().await?;
        self.prepared_queue_edits.remove(&message_id);
        let input = self.pending_input(&queued);
        match self
            .direct
            .iter_mut()
            .find(|(pending, _)| pending.id == message_id)
        {
            Some((_, intent @ DirectSend::Auto)) => *intent = DirectSend::SendNow,
            Some(_) => {}
            None => self.direct.push_back((input, DirectSend::SendNow)),
        }
        Ok(())
    }

    fn prepare_queue_edit(
        &self,
        message_id: &str,
    ) -> Result<(String, Vec<ChatAttachmentContent>), HostError> {
        if self.is_sending(message_id) {
            return Err(HostError::Working);
        }
        let chat = self.chat_id.clone();
        self.core(|core| {
            core.read(|core| {
                let message = core
                    .chat_queue(&chat)?
                    .into_iter()
                    .find(|message| message.id == message_id)
                    .ok_or_else(|| Error::Chat("this input is not in the queue".to_owned()))?;
                let attachments = core.chat_message_attachment_contents(&chat, message_id)?;
                Ok((message.text, attachments))
            })
        })
        .map_err(Into::into)
    }

    fn confirm_queue_edit(
        &mut self,
        message_id: &str,
        transfer_id: &str,
    ) -> Result<bool, HostError> {
        if self.is_sending(message_id) {
            return Ok(false);
        }
        let chat = self.chat_id.clone();
        let held =
            self.write(|core| core.confirm_chat_queue_edit(&chat, message_id, transfer_id))?;
        self.prepared_queue_edits.remove(message_id);
        Ok(held)
    }

    /// Whether the queue, not paused, holds input saved before `message_id`.
    fn older_input_waits(&self, message_id: &str) -> bool {
        let chat = self.chat_id.clone();
        self.core(|core| {
            Ok(!core.chat(&chat)?.queue_paused
                && core
                    .chat_queue(&chat)?
                    .iter()
                    .find(|message| !message.editing)
                    .is_some_and(|first| first.id != message_id))
        })
        // Unreadable now: sent directly, as before; the dispatch reads storage again.
        .unwrap_or(false)
    }

    /// Stop pauses the queue first, so nothing unsent is dispatched whatever the
    /// harness then does, and keeps all unsent input.
    fn request_stop(&mut self) -> Result<(), HostError> {
        let chat = self.chat_id.clone();
        self.write(|core| core.set_chat_queue_paused(&chat, true))?;
        self.clear_direct();
        self.resend = None;
        if self.active.is_some() {
            self.interrupt();
        } else if self.unconfirmed_start.is_some()
            || self.dispatching.as_ref().is_some_and(|d| d.starts_turn)
        {
            // The input may already be with the harness: interrupt its turn once known.
            self.stop_when_turn_known = true;
            self.stop = Some(StopState::Requested);
            self.stop_deadline = Some(Instant::now() + INTERRUPT_TIMEOUT);
        }
        // With no turn running, `stop_sub_agents_at_rest` stops what runs on its own.
        Ok(())
    }

    /// Whether a frame of a sub-agent names a run that sorts before the one it is in: the
    /// harness orders a task's run IDs by when they opened, and the Chat's history already
    /// drops such a frame.
    fn late_sub_agent_run(&self, native: &str, run: &Option<String>) -> bool {
        matches!(
            (self.sub_agent_runs.get(native), run),
            (Some(current), Some(run)) if run < current
        )
    }

    /// A sub-agent run ended. When it was the last, and no turn runs, the main agent is
    /// expected to resume by itself, and the Chat stays working until it does.
    fn sub_agent_ended(&mut self, native: &str, outcome: &SubAgentOutcome) {
        self.sub_agents.remove(native);
        if self.active.is_none()
            && self.sub_agents.is_empty()
            && matches!(
                outcome,
                SubAgentOutcome::Completed | SubAgentOutcome::Failed
            )
        {
            self.wake_until = Some(Instant::now() + WAKE_GRACE);
        }
    }

    /// The requests a sub-agent asked that nobody answered end with it: the harness says
    /// so when it can, and this covers the one that does not. `None` is every sub-agent's.
    /// Returns what to record.
    fn withdraw_asked_by(&mut self, native: Option<&str>) -> Vec<ChatObservation> {
        let gone: Vec<String> = self
            .interactions
            .iter()
            .filter(|(_, live)| match (&live.owner, native) {
                (ChatOwner::Main, _) => false,
                (ChatOwner::SubAgent { .. }, None) => true,
                (ChatOwner::SubAgent { native_id }, Some(native)) => native_id == native,
            })
            .map(|(id, _)| id.clone())
            .collect();
        gone.into_iter()
            .map(|interaction_id| {
                self.interactions.remove(&interaction_id);
                ChatObservation::InteractionResolved {
                    interaction_id,
                    state: ChatInteractionState::Expired,
                    response: None,
                }
            })
            .collect()
    }

    /// Every sub-agent still running was stopped by the person. With `note`, the Chat says
    /// how many were stopped (when no turn is there to say it was stopped).
    fn end_sub_agents_stopped(
        &mut self,
        observations: &mut Vec<ChatObservation>,
        note: Option<usize>,
    ) {
        let mut running: Vec<String> = self.sub_agents.keys().cloned().collect();
        running.sort();
        self.sub_agents.clear();
        observations.extend(self.withdraw_asked_by(None));
        observations.extend(
            running
                .into_iter()
                .map(|native_id| ChatObservation::SubAgentEnded {
                    native_id,
                    native_run_id: None,
                    state: ChatSubAgentState::Stopped,
                    stopped_by: Some(ChatSubAgentStopper::Person),
                    stop_reason: None,
                    detail: None,
                }),
        );
        if let Some(count) = note.filter(|count| *count > 0) {
            observations.push(ChatObservation::SubAgentsStopped {
                notice_id: Uuid::new_v4().to_string(),
                count: count as i64,
            });
        }
        let batch = std::mem::take(observations);
        self.record(batch);
    }

    /// Stop with no turn running but sub-agents running: they are stopped, the Chat says
    /// how many, and the harness process ends, which ends every one of them for certain.
    async fn stop_sub_agents_at_rest(&mut self) {
        if self.active.is_some()
            || self.unconfirmed_start.is_some()
            || self.dispatching.is_some()
            || self.opening.is_some()
        {
            return;
        }
        self.wake_until = None;
        if self.sub_agents.is_empty() {
            return;
        }
        // A harness that keeps sub-agents running by itself (Codex's child threads) is told
        // to stop each, then every one still running is stopped by the person and the Chat
        // says how many, and the process ends: nothing runs in it any more.
        let running = self.sub_agents.len();
        if let Some(runtime) = &self.runtime {
            let (handle, generation) = (runtime.handle.clone(), runtime.generation);
            self.drive(handle.interrupt_sub_agents(generation)).await;
        }
        self.end_sub_agents_stopped(&mut Vec::new(), Some(running));
        // The next message opens the session again.
        if let Some(reason) = self.stop_runtime(StopReason::Quit).await {
            self.notice(format!("Stopping the harness was not confirmed: {reason}"));
        }
    }

    /// The person decided to send input again although its first delivery is uncertain.
    /// Only that input is dispatched, as a new submission: the queue is paused first, so
    /// nothing else follows it until the person resumes the queue.
    async fn request_resend(&mut self, message_id: String) -> Result<(), HostError> {
        if let Some(detail) = &self.storage_failed {
            return Err(HostError::StorageFailed(detail.clone()));
        }
        if self.active.is_some()
            || self.dispatching.is_some()
            || self.opening.is_some()
            || self.unconfirmed_start.is_some()
            || self.resend.is_some()
        {
            return Err(HostError::Working);
        }
        let chat = self.chat_id.clone();
        if self.core(|core| core.chat(&chat))?.trashed {
            return Err(Error::ChatTrashed(chat).into());
        }
        let requires_link_context = self.context.is_some()
            && self.core(|core| core.chat_input_requires_link_context(&chat, &message_id))?;
        self.confirm_permission_restart_cleanup().await?;
        self.write(|core| core.set_chat_queue_paused(&chat, true))?;
        self.clear_direct();
        self.problem = None;
        self.resend = Some(PendingInput {
            id: message_id,
            requires_link_context,
        });
        if requires_link_context && !self.context_pending() {
            self.refresh_context(ContextRefreshScope::LinkedInput);
        }
        Ok(())
    }

    /// A new turn was written and nothing confirmed it within the bound. Whether the
    /// harness has it stays unknown, so it is recorded as uncertain for the person to
    /// decide about; later evidence from this runtime can still settle it.
    fn delivery_unconfirmed(&mut self, attempt_id: String) {
        self.record(vec![ChatObservation::SubmissionUncertain {
            attempt_id,
            detail: Some("the harness did not confirm receiving it in time".to_owned()),
        }]);
        let chat = self.chat_id.clone();
        let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
        self.clear_direct();
        self.stop = None;
        self.stop_deadline = None;
    }

    fn interrupt(&mut self) {
        let (Some(runtime), Some(active)) = (&self.runtime, &self.active) else {
            return;
        };
        let (handle, done, generation) = (
            runtime.handle.clone(),
            self.done.clone(),
            runtime.generation,
        );
        let request = InterruptRequest {
            generation,
            expected_turn: active.native.clone(),
        };
        self.stop = Some(StopState::Requested);
        self.stop_deadline = Some(Instant::now() + INTERRUPT_TIMEOUT);
        tokio::spawn(async move {
            let outcome = handle.interrupt(request).await;
            let _ = done.send(Done::Interrupted {
                generation,
                outcome,
            });
            // The sub-agents run on when their parent's turn is interrupted (Codex): ask
            // each to stop too, after the turn, in one order.
            handle.interrupt_sub_agents(generation).await;
        });
    }

    /// Only a request in the live registry, issued by the current runtime and not yet
    /// answered, can receive an answer.
    fn respond(&mut self, interaction_id: String, answer: InteractionAnswer, reply: Reply<()>) {
        let current = self.runtime.as_ref().map(|runtime| runtime.generation);
        let live = self
            .interactions
            .get_mut(&interaction_id)
            .filter(|live| Some(live.generation) == current && live.answering.is_none());
        let (Some(live), Some(runtime)) = (live, &self.runtime) else {
            let _ = reply.send(Err(HostError::InteractionExpired));
            return;
        };
        // The harness still holds the native request if it refuses a mismatched answer.
        if matches!(live.kind, InteractionKind::NativeApproval { .. })
            && !matches!(answer, InteractionAnswer::NativeApproval(_))
        {
            let _ = reply.send(Err(HostError::InteractionExpired));
            return;
        }
        let response = match &answer {
            InteractionAnswer::Approval(ApprovalDecision::Allow) => "allow".to_owned(),
            InteractionAnswer::Approval(ApprovalDecision::AllowForSession) => {
                "allow for session".to_owned()
            }
            InteractionAnswer::Approval(ApprovalDecision::Deny) => "deny".to_owned(),
            InteractionAnswer::NativeApproval(id) => {
                let InteractionKind::NativeApproval { options, .. } = &live.kind else {
                    let _ = reply.send(Err(HostError::InteractionExpired));
                    return;
                };
                let Some(option) = options.iter().find(|option| option.id == *id) else {
                    let _ = reply.send(Err(HostError::InteractionExpired));
                    return;
                };
                format!("choice:{}", option.label)
            }
            InteractionAnswer::Answers(answers) => answers
                .iter()
                .map(|answer| answer.values.join(", "))
                .collect::<Vec<_>>()
                .join("\n"),
        };
        live.answering = Some(response.clone());
        let request = InteractionResponse {
            generation: live.generation,
            request: live.request.clone(),
            answer,
        };
        let (handle, done) = (runtime.handle.clone(), self.done.clone());
        tokio::spawn(async move {
            let outcome = handle.respond(request).await;
            let _ = done.send(Done::Responded {
                interaction_id,
                response,
                outcome,
                reply,
            });
        });
    }

    async fn resume(&mut self, mode: ResumeMode, reply: Reply<()>) {
        if self.opening.is_some() {
            let _ = reply.send(Err(HostError::Busy));
            return;
        }
        if let Err(error) = self.chat_for_resume() {
            let _ = reply.send(Err(error.into()));
            return;
        }
        if self.native_history_only()
            && matches!(&mode, ResumeMode::FreshSession { history } if !history.trim().is_empty())
        {
            let _ = reply.send(Err(HostError::Core(Error::Chat(
                "This harness can only resume its own history".to_owned(),
            ))));
            return;
        }
        if let Err(error) = self.recover_storage() {
            let _ = reply.send(Err(error));
            return;
        }
        if let Err(error) = self.confirm_permission_restart_cleanup().await {
            let _ = reply.send(Err(error));
            return;
        }
        if self.runtime.is_some() {
            self.stop_runtime(StopReason::ExplicitResume).await;
        }
        // Another Workspace connection can change or trash the Chat during cleanup.
        let chat = match self.chat_for_resume() {
            Ok(chat) => chat,
            Err(error) => {
                let _ = reply.send(Err(error.into()));
                return;
            }
        };
        let (session, origin, preamble) = match mode {
            ResumeMode::FreshSession { history } => (
                SessionStart::New,
                ChatSessionOrigin::FreshSession,
                Some(history).filter(|history| !history.trim().is_empty()),
            ),
            ResumeMode::Native => native_session(&chat),
        };
        self.open(&chat, session, origin, preamble, Some(reply));
    }

    fn chat_for_resume(&self) -> Result<Chat, Error> {
        let chat = self.core(|core| core.chat(&self.chat_id))?;
        if chat.trashed {
            return Err(Error::ChatTrashed(chat.id));
        }
        Ok(chat)
    }

    fn native_history_only(&self) -> bool {
        self.adapter.as_ref().is_some_and(|adapter| {
            adapter.harness().resume == ticketd_core::harnesses::ResumePolicy::NativeOnly
        })
    }

    async fn reopen_for_permission(&mut self, value: String) {
        if let Some(runtime) = &self.runtime {
            // Resuming restores native history. The replacement must open with the
            // settings the harness last confirmed, overlaid with any later picks.
            if let Some(settings) = &runtime.settings {
                self.start_settings.model = settings
                    .model
                    .as_ref()
                    .and_then(|model| model.current.clone());
                self.start_settings.effort = settings
                    .effort
                    .as_ref()
                    .and_then(|effort| effort.current.clone());
            }
            let mut model_changed = false;
            let mut effort_picked = false;
            for change in &runtime.setting_changes {
                if change.state == SettingChangeState::Held {
                    let target = match change.setting {
                        SettingKey::Model => {
                            model_changed =
                                self.start_settings.model.as_ref() != Some(&change.value);
                            &mut self.start_settings.model
                        }
                        SettingKey::Effort => {
                            effort_picked = true;
                            &mut self.start_settings.effort
                        }
                        SettingKey::Permission => &mut self.start_settings.permission,
                    };
                    *target = Some(change.value.clone());
                }
            }
            self.start_settings.retain_effort_if_supported = model_changed && !effort_picked;
        }
        self.start_settings.permission.get_or_insert(value);
        self.permission_restart_pending = true;
        let direct = std::mem::take(&mut self.direct);
        let resend = self.resend.take();
        // End ownership before checking storage. A paused queue can still be
        // sent to directly.
        let unconfirmed = self.stop_runtime(StopReason::ExplicitResume).await;
        // Chat Off or Restore may be waiting on the old process too.
        if unconfirmed.is_some() || self.lifecycle.serving().is_err() {
            self.hold_queue();
            if let Some(value) = self.start_settings.permission.clone() {
                let _ = self.record_permission(&value);
            }
            if unconfirmed.is_none() {
                self.direct = direct;
                self.resend = resend;
            }
            return;
        }
        let chat = match self.core(|core| core.chat(&self.chat_id)) {
            Ok(chat) if !chat.trashed => chat,
            result => {
                self.hold_queue();
                if let Err(error) = result
                    && !is_refusal(&error)
                {
                    self.storage_failed = Some(error.to_string());
                }
                return;
            }
        };
        self.direct = direct;
        self.resend = resend;
        let (session, origin, preamble) = native_session(&chat);
        self.open(&chat, session, origin, preamble, None);
    }

    fn prepare_permission_restart(&mut self, origin: ChatSessionOrigin) -> Result<(), HostError> {
        if self.lifecycle.has_retired_permission_runtime(&self.chat_id) {
            return Err(HostError::PermissionRestartCleanupUnconfirmed);
        }
        if let Some(detail) = &self.storage_failed {
            return Err(HostError::StorageFailed(detail.clone()));
        }
        // Save the requested mode before the open, including when only a later
        // recovery can open the session.
        if let Some(value) = self.start_settings.permission.clone() {
            self.record_permission(&value)?;
        }
        if origin == ChatSessionOrigin::New {
            return Err(HostError::Harness(Problem {
                kind: crate::ProblemKind::NativeHistoryUnavailable,
                message: "The native session is unavailable for the permission restart".to_owned(),
                detail: None,
                resets_at: None,
            }));
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Runtime lifetime
    // ------------------------------------------------------------------

    fn open(
        &mut self,
        chat: &Chat,
        session: SessionStart,
        origin: ChatSessionOrigin,
        preamble: Option<String>,
        reply: Option<Reply<()>>,
    ) {
        let readiness = self.lifecycle.serving().and_then(|()| {
            if self.lifecycle.has_runtime_cleanup(&self.chat_id) {
                return Err(HostError::PermissionRestartCleanupUnconfirmed);
            }
            Ok(())
        });
        if let Err(error) = readiness {
            if let Some(reply) = reply {
                let _ = reply.send(Err(error));
            }
            return;
        }
        if self.permission_restart_pending
            && let Err(error) = self.prepare_permission_restart(origin)
        {
            if let HostError::Harness(problem) = &error {
                self.pause(ChatProblem::OpenFailed {
                    problem: problem.clone(),
                    native_resume: origin != ChatSessionOrigin::FreshSession,
                });
            } else {
                self.hold_queue();
            }
            if let Some(reply) = reply {
                let _ = reply.send(Err(error));
            }
            return;
        }
        let Some(adapter) = self.adapter.clone() else {
            self.pause(ChatProblem::OpenFailed {
                problem: Problem {
                    kind: crate::ProblemKind::NotInstalled,
                    message: format!("no adapter is available for harness '{}'", chat.harness),
                    detail: None,
                    resets_at: None,
                },
                native_resume: false,
            });
            if let Some(reply) = reply {
                let _ = reply.send(Err(HostError::HarnessUnavailable(chat.harness.clone())));
            }
            return;
        };
        // Read for every session. A resumed native session is given it only when it
        // differs from what the Chat's sessions were last given (see `on_opened`).
        let source = self.context.clone();
        self.generations += 1;
        let generation = RuntimeGeneration(self.generations);
        // A Chat the person took over from a run is ordinary from here on, whether it
        // resumes the agent's session or, because the run never got one, opens a fresh
        // one: neither keeps the agent's settings. Unreadable is taken as taken over:
        // the person's own settings are the safe ones to send.
        let taken_over = self.unattended.is_none()
            && self
                .core(|core| core.chat_ran_an_automation_agent(&chat.id))
                .unwrap_or(true);
        let mut request = OpenRequest {
            generation,
            chat_id: chat.id.clone(),
            working_directory: PathBuf::from(&chat.execution_folder),
            // The person's picks for this session, new or resumed; what the Chat ran
            // with before is in `recorded_settings`.
            settings: self.start_settings.clone(),
            session,
            recorded_settings: chat.effective_settings.clone(),
            unattended: self.unattended.as_ref().map(|run| run.settings.clone()),
            ticketd_cli: None,
            taken_over,
        };
        let start_claimed = Arc::new(AtomicBool::new(false));
        let worker_start = start_claimed.clone();
        let (done, chat_id) = (self.done.clone(), chat.id.clone());
        let open_done = self.open_done.clone();
        let chat_span = self.span.clone();
        let lifecycle = self.lifecycle.clone();
        let worker = tokio::spawn(
            async move {
                // Reading the context runs the CLI and can take seconds: off the async threads.
                let context = match source {
                    Some(source) => tokio::task::spawn_blocking(move || source(&chat_id))
                        .await
                        .unwrap_or_else(|error| Err(error.to_string())),
                    None => Ok(None),
                };
                request.ticketd_cli = tokio::task::spawn_blocking(crate::cli::executable)
                    .await
                    .ok()
                    .flatten();
                if worker_start.swap(true, Ordering::SeqCst) {
                    return;
                }
                let chat_id = request.chat_id.clone();
                let result = adapter.open(request).await;
                let (accepted, received) = oneshot::channel();
                let runtime = result.as_ref().ok().map(|opened| opened.runtime.clone());
                let _ = open_done.send(FinishedOpen {
                    generation,
                    result,
                    accepted,
                    context,
                });
                // The old worker may have timed out waiting for this open. Close a
                // late process before allowing a replacement worker to start.
                if received.await.is_err() {
                    if let Some(runtime) = runtime
                        && bounded_close(runtime.as_ref()).await.is_some()
                    {
                        lifecycle.retire_runtime(&chat_id, runtime, true);
                    }
                    lifecycle.release_pending_open_cleanup(&chat_id);
                    let _ = done.send(Done::OpenCleanupComplete);
                }
            }
            .instrument(chat_span),
        );
        self.opening = Some(Opening {
            generation,
            origin,
            preamble,
            reply,
            context_changed: None,
            start_claimed,
            worker,
        });
    }

    fn finish_unattended_shutdown(&mut self, why: StopReason) {
        let Some(unattended) = self.unattended.take() else {
            return;
        };
        // On can open a replacement as soon as Off returns. Set the run's input
        // aside before handing the Chat back, and tell the waiter why it stopped.
        if let Some(message_id) = unattended.first_message.get() {
            let chat_id = self.chat_id.clone();
            let _ = self.write(|workspace| {
                set_aside_first_message(workspace, &chat_id, message_id, why);
                Ok(())
            });
        }
        unattended.turned_off.send_replace(true);
    }

    /// Stops the owned runtime with bounded cleanup and records that contact ended.
    /// Returns why cleanup could not be confirmed, if it could not.
    async fn stop_runtime(&mut self, why: StopReason) -> Option<String> {
        if self.lifecycle.has_retired_permission_runtime(&self.chat_id) {
            return self
                .lifecycle
                .close_retired_permission_runtime(&self.chat_id)
                .await;
        }
        // Kept while the runtime closes, so a turn the harness reports interrupted
        // meanwhile is recorded as ticketd's stop and not as the person's.
        let before = self.shut_down_for.replace(why);
        self.closing = true;
        let unconfirmed = self.close_runtime(why).await;
        self.closing = false;
        if !self.shutting_down {
            self.shut_down_for = before;
        }
        unconfirmed
    }

    /// Checks the previous generation on an explicit retry before opening a replacement.
    async fn confirm_permission_restart_cleanup(&self) -> Result<(), HostError> {
        if self
            .lifecycle
            .close_retired_permission_runtime(&self.chat_id)
            .await
            .is_some()
        {
            return Err(HostError::PermissionRestartCleanupUnconfirmed);
        }
        self.lifecycle.serving()
    }

    async fn close_runtime(&mut self, why: StopReason) -> Option<String> {
        self.record(Vec::new());
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        while self.opening.is_some() {
            // Claim the start before the worker does, or let an already-started
            // adapter use the bounded handoff and late cleanup below.
            if let Some(opening) = self
                .opening
                .take_if(|opening| !opening.start_claimed.swap(true, Ordering::SeqCst))
            {
                opening.worker.abort();
                let _ = opening.worker.await;
                if let Some(reply) = opening.reply {
                    let _ = reply.send(Err(HostError::Quitting));
                }
                self.runtime_gone(TurnEnding::StoppedByTicketd(why), false);
                return None;
            }
            tokio::select! {
                Some(opened) = self.finished_open.recv() => self.on_opened(opened),
                Some(done) = self.finished.recv() => self.on_done(done),
                () = sleep_until(deadline) => break,
            }
        }
        if let Some(opening) = self.opening.take() {
            self.lifecycle.hold_pending_open_cleanup(&self.chat_id);
            if let Some(reply) = opening.reply {
                let _ = reply.send(Err(HostError::Quitting));
            }
            self.runtime_gone(TurnEnding::StoppedByTicketd(why), false);
            return Some("the harness was still starting".to_owned());
        }
        let Some(runtime) = &self.runtime else {
            let _ = self.settle_runtime_loss();
            return None;
        };
        let (handle, generation) = (runtime.handle.clone(), runtime.generation);
        if let Some(active) = &self.active {
            let request = InterruptRequest {
                generation,
                expected_turn: active.native.clone(),
            };
            let interrupting = handle.clone();
            let outcome = self
                .drive(timeout(CLOSE_TIMEOUT, async move {
                    interrupting.interrupt(request).await
                }))
                .await;
            if outcome == Ok(InterruptOutcome::Acknowledged) {
                // Give the harness a moment to report the interrupted turn.
                let deadline = Instant::now() + CLOSE_TIMEOUT;
                while self.active.is_some() && self.runtime.is_some() {
                    tokio::select! {
                        event = next_event(&mut self.runtime) => self.on_event(event),
                        () = sleep_until(deadline) => break,
                    }
                }
            }
        }
        let permission_restart =
            why == StopReason::ExplicitResume && self.permission_restart_pending;
        // Losing the event stream does not prove that the previous process exited.
        let unconfirmed =
            if permission_restart || self.unattended.is_some() || self.runtime.is_some() {
                self.drive(bounded_close(handle.as_ref())).await
            } else {
                None
            };
        self.keep_unanswered_permission();
        self.runtime = None;
        self.runtime_gone(TurnEnding::StoppedByTicketd(why), false);
        if let Some(reason) = &unconfirmed {
            if permission_restart || self.unattended.is_some() {
                self.lifecycle
                    .retire_runtime(&self.chat_id, handle, self.unattended.is_some());
            }
            if permission_restart {
                self.notice(
                    "ticketd could not confirm that the previous harness exited during the permission restart. Tools it started may still be running."
                        .to_owned(),
                );
            } else {
                self.problem = Some(ChatProblem::CleanupUnconfirmed {
                    reason: reason.clone(),
                });
            }
        }
        unconfirmed
    }

    /// Awaits an adapter call while still handling the runtime's events.
    async fn drive<T>(&mut self, call: impl Future<Output = T>) -> T {
        tokio::pin!(call);
        loop {
            tokio::select! {
                biased;
                output = &mut call => return output,
                event = next_event(&mut self.runtime) => self.on_event(event),
            }
        }
    }

    /// Nothing more will be observed from the runtime: settle what it left open.
    fn runtime_gone(&mut self, ending: TurnEnding, pause_queue: bool) {
        let active = self.active.take();
        self.pending_runtime_loss
            .get_or_insert_with(|| PendingRuntimeLoss {
                ending,
                turn: active.map(|turn| PendingTurn::Lost(ChatTurnReceipt::new(turn.turn_id))),
                pause_queue,
            });
        let _ = self.settle_runtime_loss();
        self.unconfirmed_start = None;
        self.turn_evidence = None;
        self.unconfirmed_deadline = None;
        self.refreshing = None;
        self.pending_contexts.clear();
        self.interactions.clear();
        self.sub_agents.clear();
        self.sub_agent_runs.clear();
        self.wake_until = None;
        self.text.clear();
        self.pending_tools.clear();
        self.clear_direct();
        self.resend = None;
        self.stop = None;
        self.stop_deadline = None;
        self.stop_when_turn_known = false;
    }

    fn settle_runtime_loss(&mut self) -> Result<(), Error> {
        let Some(mut loss) = self.pending_runtime_loss.take() else {
            return Ok(());
        };
        // Settle a reported end before reconciling what the runtime left open.
        // Otherwise contact loss would close this Turn with a different ending.
        let observed = if let Some(PendingTurn::Observed(end)) = &mut loss.turn {
            let result = self.record_turn_end(end);
            if result.is_ok() {
                loss.turn = None;
            }
            result
        } else {
            Ok(())
        };
        let chat = self.chat_id.clone();
        let settled = self.write(|core| {
            let settled = observed.and_then(|()| {
                let receipt = match &mut loss.turn {
                    Some(PendingTurn::Lost(receipt)) => Some(receipt),
                    Some(PendingTurn::Observed(_)) | None => None,
                };
                core.mark_chat_runtime_lost(
                    &chat,
                    receipt,
                    &loss.ending.detail().unwrap_or_default(),
                    &loss.ending.key(),
                )
            });
            // The queue can still be paused if only Turn settlement was refused by
            // storage. Keep that pause on the retry if its own write failed too.
            let paused = if loss.pause_queue {
                core.set_chat_queue_paused(&chat, true)
                    .map(|_| loss.pause_queue = false)
            } else {
                Ok(())
            };
            settled.and(paused)
        });
        if settled.as_ref().is_err_and(|error| !is_refusal(error)) {
            self.pending_runtime_loss = Some(loss);
        }
        settled
    }

    fn on_loss(&mut self, detail: String) {
        // With nothing in flight, or while ticketd itself closes the runtime, the
        // session simply ended: no turn failed, and the next message opens it again.
        // A setting change on its way is in flight too.
        let quiet = self.closing
            || (self.active.is_none()
                && self.dispatching.is_none()
                && self.unconfirmed_start.is_none()
                && self.interactions.is_empty()
                && !self.setting_on_its_way());
        self.keep_unanswered_permission();
        self.record(Vec::new());
        if let Some(runtime) = self.runtime.take()
            && self.unattended.is_some()
            && !self.closing
        {
            // Shutdown still needs to confirm the agent exited after event loss.
            self.lifecycle
                .retire_runtime(&self.chat_id, runtime.handle, true);
        }
        if self.closing {
            // `stop_runtime` settles what was open, with its own reason.
            return;
        }
        self.runtime_gone(TurnEnding::ContactLost(Some(detail.clone())), !quiet);
        if !quiet {
            self.problem = Some(ChatProblem::RuntimeLost { detail });
        }
    }

    // ------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------

    fn steering(&self) -> Option<crate::SteeringBehavior> {
        self.runtime
            .as_ref()
            .and_then(|runtime| runtime.capabilities.steering.behavior().copied())
    }

    /// Dispatches the next input when nothing else is in flight. Input the person just
    /// sent goes first; queued input follows only while a runtime is live and the queue
    /// is not paused, so viewing or restoring a Chat never starts work.
    fn pump(&mut self) {
        if let Some(ContextRefresh::RetryAt { armed, .. }) = &mut self.refreshing {
            *armed = false;
        }
        if self
            .queue_read_retry_at
            .is_some_and(|at| at > Instant::now())
        {
            return;
        }
        self.queue_read_retry_at = None;
        if self.shutting_down
            || self.lifecycle.serving().is_err()
            || self.lifecycle.has_runtime_cleanup(&self.chat_id)
            || self.storage_failed.is_some()
            || self.dispatching.is_some()
            || self.opening.is_some()
            || self.unconfirmed_start.is_some()
            || self.setting_on_its_way()
            || !self.schedule_takeover_reply()
        {
            return;
        }
        let idle = self.active.is_none();
        if idle
            && matches!(
                self.refreshing,
                Some(
                    ContextRefresh::Reading {
                        scope: ContextRefreshScope::NextTurn,
                        ..
                    } | ContextRefresh::RetryAt {
                        scope: ContextRefreshScope::NextTurn,
                        ..
                    }
                )
            )
        {
            return;
        }
        if !idle
            && self
                .direct
                .iter()
                .all(|(input, intent)| self.waits_for_new_turn(input, *intent))
        {
            // During a turn only steering input can go out, so the workspace is not
            // read for every event of a streaming turn.
            return;
        }
        let chat_id = self.chat_id.clone();
        let chat = match self.core(|core| core.chat(&chat_id)) {
            Ok(chat) => chat,
            Err(error) => {
                if !is_refusal(&error)
                    && (!self.direct.is_empty()
                        || self.queue_started
                        || self.resend.is_some()
                        || (idle && self.runtime.is_some() && self.unattended.is_none()))
                {
                    self.queue_read_retry_at = Some(Instant::now() + QUEUE_READ_RETRY);
                }
                return;
            }
        };
        if chat.trashed {
            self.direct.clear();
            self.prepared_queue_edits.clear();
            self.resend = None;
            return;
        }
        if !idle && self.steering().is_none() {
            self.direct.retain_mut(|(input, intent)| match intent {
                DirectSend::Auto => input.requires_link_context,
                DirectSend::SendNow | DirectSend::AfterTurn => {
                    *intent = DirectSend::AfterTurn;
                    true
                }
            });
            return;
        }
        // What the person asked to send again goes alone, as a new turn.
        loop {
            let resend = self.resend.clone().filter(|_| idle);
            if idle
                && self
                    .direct
                    .iter()
                    .any(|(input, _)| input.requires_link_context)
            {
                self.arm_context_retry();
            }
            let direct_index = self.direct.iter().position(|(input, intent)| {
                if idle {
                    self.refreshing.is_none() || !input.requires_link_context
                } else {
                    !self.waits_for_new_turn(input, *intent)
                }
            });
            let input = if let Some(input) = &resend {
                input.clone()
            } else if let Some(index) = direct_index {
                self.direct[index].0.clone()
            } else if idle
                && self.unattended.is_none()
                && !chat.queue_paused
                && (self.runtime.is_some() || self.queue_started)
            {
                match self.core(|core| core.chat_queue(&chat_id)) {
                    Ok(queue) => {
                        self.prepared_queue_edits
                            .retain(|id| queue.iter().any(|message| &message.id == id));
                        let Some(message) = queue.into_iter().find(|message| !message.editing)
                        else {
                            self.queue_started = false;
                            return;
                        };
                        if self.prepared_queue_edits.contains(&message.id) {
                            return;
                        }
                        self.pending_input(&message)
                    }
                    Err(error) => {
                        if !is_refusal(&error) {
                            self.queue_read_retry_at = Some(Instant::now() + QUEUE_READ_RETRY);
                        }
                        return;
                    }
                }
            } else {
                if chat.queue_paused {
                    self.queue_started = false;
                }
                return;
            };
            // A run's supervisor may only send its own Prompt. This also holds
            // if a person's saved reply became visible while this pump was running.
            if self
                .unattended
                .as_ref()
                .is_some_and(|agent| agent.first_message.get() != Some(&input.id))
            {
                if resend.is_some() {
                    self.resend = None;
                } else if let Some(index) = direct_index {
                    self.direct.remove(index);
                }
                continue;
            }
            if self.runtime.is_none() {
                if self.unattended.is_some() {
                    match self.core(|core| core.automation_chat_harness(&chat_id)) {
                        Ok(Some(_)) => {}
                        Ok(None) => return,
                        Err(error) => {
                            if !is_refusal(&error) {
                                self.queue_read_retry_at = Some(Instant::now() + QUEUE_READ_RETRY);
                            }
                            return;
                        }
                    }
                }
                let (session, origin, preamble) = native_session(&chat);
                self.open(&chat, session, origin, preamble, None);
                return;
            }
            if self.refreshing.is_some() && input.requires_link_context {
                self.arm_context_retry();
                return;
            }
            let direct = if resend.is_some() {
                self.resend = None;
                None
            } else {
                direct_index.and_then(|index| self.direct.remove(index).map(|input| (index, input)))
            };
            let from_queue = resend.is_none()
                && direct
                    .as_ref()
                    .is_none_or(|(_, (_, intent))| *intent != DirectSend::Auto);
            match self.defer_image_steer_or_dispatch(&input.id, resend.is_some(), from_queue) {
                DispatchProgress::Finished => return,
                DispatchProgress::Skipped => {}
                DispatchProgress::ImageNeedsNewTurn => {
                    if let Some((index, (input, DirectSend::SendNow))) = direct {
                        self.direct.insert(index, (input, DirectSend::AfterTurn));
                    }
                }
            }
        }
    }

    /// Records the possible submission, then hands the input to the adapter. Nothing
    /// awaits between the checks, the record and the hand-off; the adapter rechecks
    /// generation and expected turn at its write.
    ///
    /// `resend` is set only for input the person asked to send again; it alone may
    /// follow an uncertain attempt. `from_queue` input had no row on screen until now.
    fn defer_image_steer_or_dispatch(
        &mut self,
        message_id: &str,
        resend: bool,
        from_queue: bool,
    ) -> DispatchProgress {
        let Some(runtime) = &self.runtime else {
            return DispatchProgress::Finished;
        };
        let (handle, generation) = (runtime.handle.clone(), runtime.generation);
        let (kind, intent) = match &self.active {
            Some(active) => (
                SubmissionKind::Steer {
                    expected_turn: active.native.clone(),
                },
                ChatSubmissionIntent::Steer,
            ),
            None => (SubmissionKind::StartTurn, ChatSubmissionIntent::NewTurn),
        };
        let starts_turn = kind == SubmissionKind::StartTurn;
        let attempt = Uuid::new_v4().to_string();
        let chat = self.chat_id.clone();
        let unattended = self.unattended.clone();
        let mut image_needs_new_turn = false;
        let recorded = self.write(|core| {
            let attachments = core.chat_message_attachment_contents(&chat, message_id)?;
            if !starts_turn
                && handle.supports_steer_image_input() == Some(false)
                && attachments.iter().any(ChatAttachmentContent::is_image)
            {
                image_needs_new_turn = true;
                return Ok(None);
            }
            if let Some(agent) = unattended {
                return Ok(core
                    .record_automation_chat_submission(
                        &chat,
                        &agent.settings.run_id,
                        message_id,
                        &attempt,
                    )?
                    .map(|message| (message, attachments)));
            }
            let message = if resend {
                core.record_chat_resubmission(&chat, message_id, &attempt)
            } else if from_queue {
                core.record_chat_queue_submission(&chat, message_id, &attempt, intent)
            } else {
                core.record_chat_submission(&chat, message_id, &attempt, intent)
            }?;
            Ok(Some((message, attachments)))
        });
        let (message, attachments) = match recorded {
            Ok(Some(recorded)) => recorded,
            Ok(None) if image_needs_new_turn => return DispatchProgress::ImageNeedsNewTurn,
            Ok(None) => return DispatchProgress::Skipped,
            Err(error) => {
                // Storage failure is reported by `write`; a refusal is said here.
                // The queue is paused so the same refusal is not met again unasked.
                if is_refusal(&error) {
                    self.notice(format!("A message was not sent: {error}"));
                    let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
                }
                return DispatchProgress::Finished;
            }
        };
        if starts_turn {
            // An earlier Stop was about an earlier submission.
            self.stop_when_turn_known = false;
        }
        let preamble = if starts_turn {
            self.preamble.take()
        } else {
            None
        };
        let context = if starts_turn && self.refreshing.is_none() {
            // A written turn can time out without having received its context.
            self.session_context.take().or_else(|| {
                self.pending_contexts
                    .back()
                    .map(|transfer| transfer.text.clone())
            })
        } else {
            None
        };
        let note = self.lost_sub_agents_note(&message);
        // Context, selected history and ticketd's note go to the harness with the input;
        // the stored message stays the person's own words.
        let text = [
            context.as_deref(),
            preamble.as_deref(),
            note.as_ref().map(|note| note.text.as_str()),
            (!message.text.is_empty()).then_some(message.text.as_str()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n");
        let submission = Submission {
            submission: SubmissionId(attempt.clone()),
            generation,
            kind,
            text,
            attachments,
        };
        if let Some(text) = context {
            // An older attempt can still settle delivery without a context record.
            if self.pending_contexts.len() == MAX_PENDING_CONTEXTS {
                self.pending_contexts.pop_front();
            }
            self.pending_contexts.push_back(ContextTransfer {
                attempt_id: attempt.clone(),
                text,
            });
        }
        self.dispatching = Some(Dispatch {
            attempt,
            generation,
            starts_turn,
            early_rejection: None,
            preamble,
        });
        if let Some(refusal) = self.attachment_refusal(&submission.attachments) {
            self.on_dispatched(DispatchOutcome::NotSent(refusal));
            return DispatchProgress::Finished;
        }
        let done = self.done.clone();
        let open_workspace = self.open_workspace.clone();
        let lifecycle = self.lifecycle.clone();
        let workspace_generation = self.workspace_generation;
        let admission = self
            .unattended
            .as_ref()
            .map(|agent| AutomationPromptAdmission {
                fence: agent.prompt_fence.clone(),
                open_workspace: open_workspace.clone(),
                lifecycle: lifecycle.clone(),
                workspace_generation,
                chat_id: chat.clone(),
                run_id: agent.settings.run_id.clone(),
            });
        tokio::spawn(async move {
            let attempt_id = submission.submission.0.clone();
            let outcome = handle.submit_with_admission(submission, admission).await;
            if let DispatchOutcome::NotSent(refusal) = &outcome
                && prompt_admission_refused(refusal)
                && lifecycle.serving().is_ok()
                && let Ok(mut workspace) = open_workspace()
                && lifecycle.serves_workspace_generation(workspace_generation)
            {
                // The actor may already be closing after the run ended. Settle
                // known non-delivery even if it can no longer receive Done.
                let _ = workspace.record_chat_observations(
                    &chat,
                    vec![ChatObservation::SubmissionNotDelivered {
                        attempt_id,
                        detail: Some(refusal.reason().to_owned()),
                    }],
                );
            }
            let _ = done.send(Done::Dispatched { outcome });
        });
        DispatchProgress::Finished
    }

    /// The note the person's message carries after sub-agents lost contact: what ticketd
    /// says to the harness about them, kept on the message so the person sees exactly it,
    /// and told once. A message that was sent before keeps the note it carried.
    fn lost_sub_agents_note(&mut self, message: &ChatMessage) -> Option<ChatMessageNote> {
        if let Some(note) = &message.note {
            return Some(note.clone());
        }
        if self.unattended.is_some() || message.role != ChatRole::User {
            return None;
        }
        let chat = self.chat_id.clone();
        let lost = self.core(|core| core.chat_restart_notice(&chat)).ok()?;
        if lost.is_empty() {
            return None;
        }
        let resume = self
            .adapter
            .as_ref()
            .is_some_and(|adapter| adapter.harness().sub_agents.resume);
        let titles: Vec<String> = lost.iter().map(ChatSubAgent::title).collect();
        let note = ChatMessageNote {
            kind: ChatMessageNoteKind::LostSubAgents,
            sub_agents: lost.into_iter().map(|record| record.native_id).collect(),
            text: lost_sub_agents_text(&titles, resume),
        };
        // Told with this message, whether or not it gets through: a resend carries the
        // stored note again.
        self.write(|core| core.record_chat_message_note(&chat, &message.id, &note))
            .ok()?;
        Some(note)
    }

    // ------------------------------------------------------------------
    // Completed adapter calls
    // ------------------------------------------------------------------

    fn on_done(&mut self, done: Done) {
        match done {
            Done::OpenCleanupComplete => {}
            Done::Dispatched { outcome } => self.on_dispatched(outcome),
            Done::Context {
                generation,
                request,
                context,
            } => {
                let Some(ContextRefresh::Reading {
                    request: latest,
                    retrying,
                    scope,
                }) = self.refreshing
                else {
                    return;
                };
                let current = self.runtime.as_ref().map(|runtime| runtime.generation);
                if latest != request || current != Some(generation) {
                    return;
                }
                self.refreshing = None;
                match context {
                    // Told with the next new turn, and only when it is news to the session.
                    Ok(Some(context))
                        if self.context_given().as_deref() != Some(context.as_str()) =>
                    {
                        self.set_session_context(context);
                    }
                    Ok(_) => {}
                    Err(error) => self.context_read_failed(error, retrying, scope),
                }
            }
            Done::Interrupted {
                generation,
                outcome,
            } => {
                let current = self.runtime.as_ref().map(|runtime| runtime.generation);
                if current != Some(generation) || self.active.is_none() || self.stop.is_none() {
                    return;
                }
                self.stop = Some(match outcome {
                    InterruptOutcome::Acknowledged => StopState::Acknowledged,
                    InterruptOutcome::NotSent(_) | InterruptOutcome::Unconfirmed => {
                        StopState::Unconfirmed
                    }
                });
            }
            Done::Responded {
                interaction_id,
                response,
                outcome,
                reply,
            } => {
                let (state, result) = match outcome {
                    RespondOutcome::Sent => (ChatInteractionState::Answered, Ok(())),
                    RespondOutcome::NotSent(_) => (
                        ChatInteractionState::Expired,
                        Err(HostError::InteractionExpired),
                    ),
                    // The loss itself expires the request; the answer may have arrived.
                    RespondOutcome::UnknownAfterLoss => {
                        let _ = reply.send(Err(HostError::ContactLost));
                        return;
                    }
                };
                if self.interactions.remove(&interaction_id).is_some() {
                    self.record(vec![ChatObservation::InteractionResolved {
                        interaction_id,
                        state,
                        response: (state == ChatInteractionState::Answered).then_some(response),
                    }]);
                }
                let _ = reply.send(result);
            }
            Done::SettingChanged {
                generation,
                setting,
                value,
                outcome,
            } => {
                let Some(runtime) = self
                    .runtime
                    .as_mut()
                    .filter(|runtime| runtime.generation == generation)
                else {
                    return;
                };
                if outcome == SettingOutcome::Applied
                    && let Some(reported) = runtime
                        .settings
                        .as_mut()
                        .and_then(|settings| settings.get_mut(setting))
                {
                    reported.current = Some(value.clone());
                }
                // A later change of the same setting replaced this one.
                let Some(change) = runtime.setting_changes.iter_mut().find(|change| {
                    change.setting == setting
                        && change.value == value
                        && change.state == SettingChangeState::Sent
                }) else {
                    return;
                };
                change.state = SettingChangeState::Done(outcome.clone());
                if setting == SettingKey::Permission {
                    if outcome == SettingOutcome::ReopenSession {
                        self.reopen_for_permission = Some(value);
                    } else if outcome == SettingOutcome::Applied {
                        // The harness already runs it: unsaved, this process still opens
                        // the next session with it.
                        if self.record_permission(&value).is_err() {
                            self.start_settings.permission = Some(value);
                        }
                    } else {
                        // Nothing runs on a mode the person left: the queue waits for
                        // them, and the dock says why the change did not take.
                        self.hold_queue();
                    }
                }
            }
        }
    }

    fn on_opened(&mut self, opened: FinishedOpen) {
        let FinishedOpen {
            generation,
            result,
            accepted,
            context,
        } = opened;
        let Some(opening) = self
            .opening
            .take_if(|opening| opening.generation == generation)
        else {
            return;
        };
        let _ = accepted.send(());
        let result = match result {
            Ok(opened) => {
                self.start_settings = StartSettings::default();
                self.permission_restart_pending = false;
                self.runtime = Some(Runtime {
                    generation,
                    run: Uuid::new_v4().to_string(),
                    handle: opened.runtime,
                    events: opened.events,
                    capabilities: opened.capabilities,
                    origin: opening.origin,
                    turns: HashSet::new(),
                    tools: HashSet::new(),
                    said: HashSet::new(),
                    context: None,
                    link_context: None,
                    compacted_at: None,
                    settings: None,
                    setting_changes: Vec::new(),
                    commands: Vec::new(),
                });
                if opening.preamble.is_some() {
                    self.preamble = opening.preamble;
                }
                match context {
                    // A resumed native session remembers what it was given.
                    Ok(Some(context))
                        if opening.origin == ChatSessionOrigin::NativeResume
                            && self.context_given().as_deref() == Some(context.as_str()) => {}
                    Ok(Some(context)) => self.set_session_context(context),
                    Ok(None) => {}
                    Err(error) => {
                        self.notice(format!(
                            "ticketd could not prepare this Chat's context: {error}"
                        ));
                        self.schedule_context_retry(ContextRefreshScope::LinkedInput);
                    }
                }
                if let Some(scope) = opening.context_changed
                    && !self.closing
                {
                    self.refresh_context(scope);
                }
                self.problem = None;
                Ok(())
            }
            Err(problem) => {
                let can_open_fresh = problem.kind == crate::ProblemKind::NativeHistoryUnavailable
                    && opening.origin == ChatSessionOrigin::NativeResume
                    && !self.permission_restart_pending;
                if can_open_fresh
                    && self.native_history_only()
                    && let Ok(chat) = self.core(|core| core.chat(&self.chat_id))
                {
                    self.notice(
                        "The harness could not resume its history. The Chat will continue in a new session.".to_owned(),
                    );
                    self.open(
                        &chat,
                        SessionStart::New,
                        ChatSessionOrigin::New,
                        None,
                        opening.reply,
                    );
                    return;
                }
                // A take-over: Codex records a thread id when it starts one but keeps nothing until
                // the first turn runs, so a Chat whose session never completed a turn (a run
                // taken over early) has nothing to resume: open a fresh session, with
                // the same reply, rather than a dead Chat (#387 6A1).
                if can_open_fresh
                    && self.unattended.is_none()
                    && self
                        .core(|core| core.chat_ran_an_automation_agent(&self.chat_id))
                        .unwrap_or(false)
                    && self.never_completed_a_turn()
                    && let Ok(chat) = self.core(|core| core.chat(&self.chat_id))
                {
                    self.open(
                        &chat,
                        SessionStart::New,
                        ChatSessionOrigin::New,
                        opening.preamble,
                        opening.reply,
                    );
                    return;
                }
                self.pause(ChatProblem::OpenFailed {
                    problem: problem.clone(),
                    native_resume: opening.origin == ChatSessionOrigin::NativeResume,
                });
                Err(HostError::Harness(problem))
            }
        };
        if let Some(reply) = opening.reply {
            let _ = reply.send(result);
        }
    }

    /// Whether no turn of this Chat ever completed, so the harness may have kept nothing.
    /// Unreadable counts as having completed one.
    fn never_completed_a_turn(&self) -> bool {
        const SCAN: usize = 200;
        self.core(|core| core.chat_snapshot(&self.chat_id, SCAN))
            .is_ok_and(|snapshot| {
                !snapshot.earlier
                    && !snapshot.items.iter().any(|item| {
                        matches!(item, ticketd_core::ChatItem::Turn(turn) if turn.state == ChatTurnState::Completed)
                    })
            })
    }

    /// Maps what the adapter observed about one submission to core observations. An
    /// outcome that arrives after its runtime was lost still settles the same attempt,
    /// but can no longer start a turn.
    fn on_dispatched(&mut self, outcome: DispatchOutcome) {
        let Some(mut dispatch) = self.dispatching.take() else {
            return;
        };
        let attempt_id = dispatch.attempt.clone();
        let current = self
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.generation == dispatch.generation);
        // A rejection can reach the event stream before the write task reports back.
        let outcome = match (outcome, dispatch.early_rejection.take()) {
            (DispatchOutcome::Written | DispatchOutcome::UnknownAfterLoss, Some(reason)) => {
                DispatchOutcome::Rejected { reason }
            }
            (outcome, _) => outcome,
        };
        match outcome {
            DispatchOutcome::NotSent(refusal) => {
                let detail = refusal.reason().to_owned();
                self.record(vec![ChatObservation::SubmissionNotDelivered {
                    attempt_id,
                    detail: Some(detail.clone()),
                }]);
                let admission_refused = prompt_admission_refused(&refusal);
                if current && admission_refused {
                    self.problem = Some(match refusal {
                        Refusal::AutomationPromptOwnershipUnavailable => {
                            ChatProblem::StorageFailed {
                                detail: detail.clone(),
                            }
                        }
                        _ => ChatProblem::DispatchRefused {
                            detail: detail.clone(),
                        },
                    });
                }
                self.not_accepted(dispatch, current && !admission_refused, detail);
            }
            DispatchOutcome::Rejected { reason } => {
                self.record(vec![ChatObservation::SubmissionRejected {
                    attempt_id,
                    detail: Some(reason.clone()),
                }]);
                self.not_accepted(dispatch, current, reason);
            }
            DispatchOutcome::Written => {
                if current && dispatch.starts_turn && self.active.is_none() {
                    self.unconfirmed_start = Some(attempt_id);
                    self.unconfirmed_deadline =
                        Some(Instant::now() + DELIVERY_CONFIRMATION_TIMEOUT);
                }
            }
            DispatchOutcome::Acknowledged { turn } => {
                let mut observations = vec![ChatObservation::SubmissionAcknowledged {
                    attempt_id: attempt_id.clone(),
                }];
                if current && let Some(turn_id) = self.turn(&turn, &mut observations) {
                    self.submission_processing(attempt_id, turn_id, &mut observations);
                }
                self.record(observations);
            }
            DispatchOutcome::UnknownAfterLoss => {
                let detail = "contact was lost before the harness replied".to_owned();
                self.record(vec![ChatObservation::SubmissionUncertain {
                    attempt_id,
                    detail: Some(detail.clone()),
                }]);
                // The loss may have been seen first, with nothing else in flight: it
                // was not a quiet end, since this input may have reached the harness.
                if self.problem.is_none() {
                    self.pause(ChatProblem::RuntimeLost { detail });
                }
            }
        }
    }

    /// Non-acceptance is established, so the input is back in the queue. Steering then
    /// simply waits its turn; a refused new turn pauses the queue instead of retrying.
    fn not_accepted(&mut self, dispatch: Dispatch, current: bool, detail: String) {
        if dispatch.preamble.is_some() {
            self.preamble = dispatch.preamble;
        }
        self.restore_rejected_context(&dispatch.attempt);
        if dispatch.starts_turn {
            self.stop_when_turn_known = false;
            if self.active.is_none() {
                self.stop = None;
            }
            if current {
                self.pause(ChatProblem::DispatchRefused { detail });
            }
        }
    }

    fn restore_rejected_context(&mut self, attempt_id: &str) {
        if let Some(index) = self
            .pending_contexts
            .iter()
            .position(|transfer| transfer.attempt_id == attempt_id)
            && let Some(transfer) = self.pending_contexts.remove(index)
            && index == self.pending_contexts.len()
            && self.session_context.is_none()
        {
            self.session_context = Some(transfer.text);
        }
    }

    // ------------------------------------------------------------------
    // Runtime events
    // ------------------------------------------------------------------

    /// The record ID of a native turn, starting the turn if this is its first sighting.
    /// `None` when the event names a turn that cannot be the active one.
    fn turn(
        &mut self,
        native: &NativeTurnId,
        observations: &mut Vec<ChatObservation>,
    ) -> Option<String> {
        self.turn_by(native, None, observations)
    }

    /// As [`Self::turn`], and a turn seen for the first time says who started it when the
    /// person did not.
    fn turn_by(
        &mut self,
        native: &NativeTurnId,
        origin: Option<TurnOrigin>,
        observations: &mut Vec<ChatObservation>,
    ) -> Option<String> {
        if self.pending_runtime_loss.is_some() {
            // Storage recovery owns the last observed end while the runtime closes.
            return None;
        }
        let runtime = self.runtime.as_mut()?;
        let turn_id = format!("{}:{}", runtime.run, native.0);
        if runtime.turns.contains(&native.0) {
            return Some(turn_id);
        }
        if self.active.is_some() {
            return None;
        }
        runtime.turns.insert(native.0.clone());
        observations.push(ChatObservation::TurnStarted {
            turn_id: turn_id.clone(),
            native_turn_id: Some(native.0.clone()),
            origin: origin.as_ref().map(|origin| ChatTurnOrigin {
                by: match origin.by {
                    TurnStarter::Harness => ChatTurnStarter::Harness,
                    TurnStarter::Ticketd => ChatTurnStarter::Ticketd,
                },
                sub_agent: origin.sub_agent.as_ref().map(|agent| agent.0.clone()),
            }),
        });
        // The main agent resumed: the grace for it to do so is over.
        self.wake_until = None;
        self.active = Some(ActiveTurn {
            turn_id: turn_id.clone(),
            native: native.clone(),
            by_itself: origin.is_some(),
            span: tracing::info_span!("chat_turn"),
        });
        self.unconfirmed_start = None;
        if self.stop_when_turn_known {
            self.stop_when_turn_known = false;
            self.interrupt();
        }
        Some(turn_id)
    }

    fn submission_processing(
        &mut self,
        attempt_id: String,
        turn_id: String,
        observations: &mut Vec<ChatObservation>,
    ) {
        if let Some(index) = self
            .pending_contexts
            .iter()
            .position(|transfer| transfer.attempt_id == attempt_id)
            && let Some(runtime) = &mut self.runtime
            && let Some(transfer) = self.pending_contexts.drain(..=index).next_back()
        {
            // The durable record also supplies the next session's baseline, so
            // older transfers cannot replace a newer confirmed one.
            runtime.link_context = Some(transfer.text.clone());
            observations.push(ChatObservation::Tool {
                tool_id: format!("{turn_id}:ticketd-context"),
                turn_id: Some(turn_id.clone()),
                owner: ChatOwner::Main,
                name: CONTEXT_RECORD_NAME.to_owned(),
                input: transfer.text.to_string(),
                state: ChatToolState::Completed,
                output: None,
            });
        }
        observations.push(ChatObservation::SubmissionProcessing {
            attempt_id,
            turn_id,
        });
    }

    /// The Turn in progress, for the work done on its behalf; the Chat's own span when none is.
    fn turn_span(&self) -> tracing::Span {
        self.active
            .as_ref()
            .map_or_else(tracing::Span::current, |active| active.span.clone())
    }

    fn on_event(&mut self, event: Option<RuntimeEvent>) {
        let Some(runtime) = &self.runtime else {
            return;
        };
        let Some(event) = event else {
            return self.on_loss("the connection to the harness ended".to_owned());
        };
        if event.generation != runtime.generation {
            return;
        }
        let (run, origin, generation) = (runtime.run.clone(), runtime.origin, runtime.generation);
        let mut observations = Vec::new();
        match event.kind {
            EventKind::SessionIdentified { native_session } => {
                let chat = self.chat_id.clone();
                let _ =
                    self.write(|core| core.record_chat_session(&chat, &native_session.0, origin));
            }
            EventKind::SubmissionEvidence {
                submission,
                evidence,
            } => {
                let attempt_id = submission.0;
                let unconfirmed = self.unconfirmed_start.as_ref() == Some(&attempt_id);
                if unconfirmed {
                    self.unconfirmed_start = None;
                }
                match evidence {
                    DeliveryEvidence::Acknowledged { turn } => {
                        observations.push(ChatObservation::SubmissionAcknowledged {
                            attempt_id: attempt_id.clone(),
                        });
                        if let Some(turn_id) = self.turn(&turn, &mut observations) {
                            self.submission_processing(attempt_id, turn_id, &mut observations);
                        }
                    }
                    DeliveryEvidence::Processing { turn } => {
                        if let Some(turn_id) = self.turn(&turn, &mut observations) {
                            self.submission_processing(attempt_id, turn_id, &mut observations);
                        }
                    }
                    DeliveryEvidence::Rejected { reason } => {
                        observations.push(ChatObservation::SubmissionRejected {
                            attempt_id: attempt_id.clone(),
                            detail: Some(reason.clone()),
                        });
                        self.restore_rejected_context(&attempt_id);
                        if unconfirmed {
                            self.stop_when_turn_known = false;
                            self.pause(ChatProblem::DispatchRefused { detail: reason });
                        } else if let Some(dispatch) = &mut self.dispatching
                            && dispatch.starts_turn
                            && dispatch.attempt == attempt_id
                        {
                            dispatch.early_rejection = Some(reason);
                        }
                    }
                }
                self.record(observations);
            }
            EventKind::TurnStarted { turn, origin } => {
                self.turn_by(&turn, origin, &mut observations);
                self.record(observations);
            }
            EventKind::TextDelta { turn, item, text } => {
                let Some(turn_id) = self.turn(&turn, &mut observations) else {
                    return;
                };
                self.record_if_any(observations);
                let message_id = format!("{run}:{}", item.0);
                match self.text.iter_mut().find(|b| b.message_id == message_id) {
                    Some(buffer) => buffer.text.push_str(&text),
                    None => self.text.push(TextBuffer {
                        message_id,
                        turn_id,
                        text,
                        shown: 0,
                        saved: 0,
                    }),
                }
                let now = Instant::now();
                self.show_text_at.get_or_insert(now + TEXT_UPDATE_INTERVAL);
                self.checkpoint_at
                    .get_or_insert(now + TEXT_CHECKPOINT_INTERVAL);
            }
            EventKind::MessageCompleted { turn, item, text } => {
                let Some(turn_id) = self.turn(&turn, &mut observations) else {
                    return;
                };
                let message_id = format!("{run}:{}", item.0);
                // The final text is authoritative and replaces the streamed deltas.
                self.text.retain(|buffer| buffer.message_id != message_id);
                observations.push(ChatObservation::AssistantText {
                    message_id,
                    turn_id: Some(turn_id),
                    owner: ChatOwner::Main,
                    text,
                    complete: true,
                });
                self.record(observations);
            }
            EventKind::ToolUpdated {
                turn,
                item,
                title,
                status,
                output,
                detail,
            } => {
                let Some(turn_id) = self.turn(&turn, &mut observations) else {
                    return;
                };
                self.on_tool(
                    &run,
                    Some(turn_id),
                    ChatOwner::Main,
                    item,
                    title,
                    status,
                    output,
                    detail,
                    observations,
                );
            }
            EventKind::SubAgentToolUpdated {
                sub_agent,
                item,
                title,
                status,
                output,
                detail,
            } => {
                // A sub-agent's Step belongs to the turn that is active, if one is, and
                // opens none.
                let turn_id = self.active.as_ref().map(|active| active.turn_id.clone());
                self.on_tool(
                    &run,
                    turn_id,
                    ChatOwner::SubAgent {
                        native_id: sub_agent.0,
                    },
                    item,
                    title,
                    status,
                    output,
                    detail,
                    observations,
                );
            }
            EventKind::SubAgentMessage {
                sub_agent,
                item,
                text,
            } => {
                // Said in the turn that is active, if one is; it opens none.
                let turn_id = self.active.as_ref().map(|active| active.turn_id.clone());
                observations.push(ChatObservation::AssistantText {
                    message_id: format!("{run}:{}:{}", sub_agent.0, item.0),
                    turn_id,
                    owner: ChatOwner::SubAgent {
                        native_id: sub_agent.0,
                    },
                    text,
                    complete: true,
                });
                self.record(observations);
            }
            EventKind::SubAgentReasoningUpdated {
                sub_agent,
                run: native_run,
                item,
                running,
                started_at,
                ended_at,
                text,
            } => {
                let record = ReasoningRecord {
                    running,
                    started_at,
                    ended_at,
                    text,
                    heading: None,
                };
                let state = if running {
                    ChatToolState::Running
                } else {
                    ChatToolState::Completed
                };
                let id = format!(
                    "{run}:reasoning:{}:{}:{}",
                    sub_agent.0,
                    native_run.as_deref().unwrap_or("-"),
                    item.0
                );
                self.sub_agent_record(sub_agent, id, REASONING_RECORD_NAME, &record, state);
            }
            EventKind::SubAgentFilesChanged {
                sub_agent,
                run: native_run,
                files,
            } => {
                let id = format!(
                    "{run}:files:{}:{}",
                    sub_agent.0,
                    native_run.as_deref().unwrap_or("-")
                );
                let record = FilesRecord::from(files.as_slice());
                self.sub_agent_record(
                    sub_agent,
                    id,
                    FILES_RECORD_NAME,
                    &record,
                    ChatToolState::Completed,
                );
            }
            EventKind::SubAgentStarted(start) => {
                self.sub_agents
                    .insert(start.sub_agent.0.clone(), start.background);
                if let Some(run) = &start.run {
                    self.sub_agent_runs
                        .insert(start.sub_agent.0.clone(), run.clone());
                }
                // Something runs again: the main agent is not about to resume alone.
                self.wake_until = None;
                observations.push(ChatObservation::SubAgentStarted {
                    native_id: start.sub_agent.0,
                    parent: start.parent.map(|parent| parent.0),
                    tool_id: start.tool.map(|item| format!("{run}:{}", item.0)),
                    turn_id: self.active.as_ref().map(|active| active.turn_id.clone()),
                    native_run_id: start.run,
                    background: start.background,
                    payload: start.native.to_string(),
                });
                self.record(observations);
            }
            EventKind::SubAgentUpdated {
                sub_agent,
                run: native_run_id,
                background,
                native,
            } => {
                if let (Some(background), Some(running)) = (
                    background.filter(|_| !self.late_sub_agent_run(&sub_agent.0, &native_run_id)),
                    self.sub_agents.get_mut(&sub_agent.0),
                ) {
                    *running = background;
                }
                self.record(vec![ChatObservation::SubAgentUpdated {
                    native_id: sub_agent.0,
                    native_run_id,
                    background,
                    payload: native.map(|native| native.to_string()),
                }]);
            }
            EventKind::SubAgentEnded {
                sub_agent,
                run: native_run_id,
                outcome,
                detail,
            } => {
                if !self.late_sub_agent_run(&sub_agent.0, &native_run_id) {
                    self.sub_agent_ended(&sub_agent.0, &outcome);
                }
                let (state, stopped_by) = match outcome {
                    SubAgentOutcome::Completed => (ChatSubAgentState::Completed, None),
                    SubAgentOutcome::Failed => (ChatSubAgentState::Failed, None),
                    SubAgentOutcome::Stopped(by) => (
                        ChatSubAgentState::Stopped,
                        Some(match by {
                            SubAgentStopper::Person => ChatSubAgentStopper::Person,
                            SubAgentStopper::MainAgent => ChatSubAgentStopper::MainAgent,
                        }),
                    ),
                };
                let mut observations = self.withdraw_asked_by(Some(&sub_agent.0));
                observations.push(ChatObservation::SubAgentEnded {
                    native_id: sub_agent.0,
                    native_run_id,
                    state,
                    stopped_by,
                    stop_reason: None,
                    detail,
                });
                self.record(observations);
            }
            EventKind::InteractionRequested(request) => {
                self.on_interaction(&run, generation, request, observations);
            }
            EventKind::InteractionResolved {
                request,
                resolution,
            } => {
                let interaction_id = format!("{run}:request:{}", request.0);
                // The harness may confirm an answer before writing it returns: the
                // answer being written is what was chosen.
                let answering = self
                    .interactions
                    .remove(&interaction_id)
                    .and_then(|live| live.answering);
                let (state, response) = match resolution {
                    InteractionResolution::Answered => (ChatInteractionState::Answered, answering),
                    InteractionResolution::Withdrawn => (ChatInteractionState::Expired, None),
                };
                self.record(vec![ChatObservation::InteractionResolved {
                    interaction_id,
                    state,
                    response,
                }]);
            }
            EventKind::TurnEvidence { turn, evidence } => {
                self.turn_evidence = Some((turn, evidence));
            }
            EventKind::TurnEnded {
                turn,
                outcome,
                submissions,
            } => {
                let evidence = match self.turn_evidence.take() {
                    Some((evidenced, evidence)) if evidenced == turn => evidence,
                    _ => TurnEvidence::default(),
                };
                let outcome = settle(outcome, &evidence);
                let Some(turn_id) = self.turn(&turn, &mut observations) else {
                    return;
                };
                for submission in submissions {
                    if self.unconfirmed_start.as_ref() == Some(&submission.0) {
                        self.unconfirmed_start = None;
                    }
                    self.submission_processing(submission.0, turn_id.clone(), &mut observations);
                }
                // The harness ended the turn, so text it streamed without a final copy
                // is all there is: it is kept whole. Only lost contact leaves a response
                // cut off.
                let (ended, streaming) = std::mem::take(&mut self.text)
                    .into_iter()
                    .partition(|buffer| buffer.turn_id == turn_id);
                self.text = streaming;
                observations.extend(ended.into_iter().map(|buffer: TextBuffer| {
                    ChatObservation::AssistantText {
                        message_id: buffer.message_id,
                        turn_id: Some(buffer.turn_id),
                        owner: ChatOwner::Main,
                        text: buffer.text,
                        complete: true,
                    }
                }));
                let is_active = self.active.as_ref().is_some_and(|a| a.turn_id == turn_id);
                // A turn the person stopped is theirs to have stopped, even when the
                // harness ends it as completed (Codex can, once interrupted).
                let stopped = self.stop.is_some() && is_active;
                let ending = match outcome {
                    TurnOutcome::Completed if stopped => TurnEnding::StoppedByPerson,
                    TurnOutcome::Completed => TurnEnding::Completed,
                    TurnOutcome::Interrupted => self
                        .shut_down_for
                        .map_or(TurnEnding::StoppedByPerson, TurnEnding::StoppedByTicketd),
                    TurnOutcome::Failed(problem) => TurnEnding::failed(&problem),
                };
                // Queued input does not follow a turn that did not complete. A
                // take-over ends the agent's turn for the person, who is about to
                // send (#387 M2): their Chat's queue is not paused for it.
                // A turn the harness or ticketd started is not one the person is waiting on:
                // its failure shows, and notifies, but pauses nothing of theirs.
                let by_itself = is_active && self.active.as_ref().is_some_and(|a| a.by_itself);
                let pause_queue = ending != TurnEnding::Completed
                    && self.shut_down_for != Some(StopReason::TakenOver)
                    && !by_itself;
                if is_active {
                    let mut end = ObservedTurnEnd {
                        receipt: ChatTurnReceipt::new(turn_id.clone()),
                        preceding: self.observation_batch(observations),
                        ending,
                    };
                    if self
                        .record_turn_end(&mut end)
                        .is_err_and(|error| !is_refusal(&error))
                    {
                        self.pending_runtime_loss = Some(PendingRuntimeLoss {
                            ending: TurnEnding::StoppedByTicketd(StopReason::StorageFailed),
                            turn: Some(PendingTurn::Observed(end)),
                            pause_queue,
                        });
                    }
                } else {
                    observations.push(ending.observation(turn_id.clone()));
                    self.record(observations);
                }
                self.text.retain(|buffer| buffer.turn_id != turn_id);
                self.interactions
                    .retain(|_, live| live.turn_id.as_ref() != Some(&turn_id));
                if is_active {
                    // A sub-agent in the foreground ended with its turn. When the person
                    // stopped the turn, every sub-agent still running was stopped with it.
                    self.sub_agents.retain(|_, background| *background);
                    if stopped {
                        self.end_sub_agents_stopped(&mut Vec::new(), None);
                    }
                    self.active = None;
                    self.stop = None;
                    self.stop_deadline = None;
                    if pause_queue {
                        if self.pending_runtime_loss.is_none() {
                            let chat = self.chat_id.clone();
                            let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
                        }
                        self.direct.clear();
                    }
                }
            }
            EventKind::RuntimeLost {
                exit_code,
                diagnostics,
            } => {
                let exit = exit_code.map_or_else(String::new, |code| format!(", exit code {code}"));
                let reason = if diagnostics.is_empty() {
                    String::new()
                } else {
                    format!(": {diagnostics}")
                };
                self.on_loss(format!("the harness process ended{exit}{reason}"));
            }
            // The harness keeps the turn; nothing is retried or ended here.
            EventKind::Notice {
                kind,
                message,
                detail,
                ..
            } => match kind {
                // An unavailable capability stops nothing, so it is a stored notice like
                // the others and never the Chat's problem.
                NoticeKind::Retrying | NoticeKind::Warning | NoticeKind::CapabilityUnavailable => {
                    self.harness_notice(message);
                }
                NoticeKind::EffectiveSettings => {
                    let settings = detail.map_or(message, |detail| detail.payload().to_owned());
                    let chat = self.chat_id.clone();
                    // The record `open` reads: shown only once it is saved.
                    if self
                        .write(|core| core.set_chat_effective_settings(&chat, &settings))
                        .is_ok()
                    {
                        self.recorded_settings = Some(settings);
                    }
                }
            },
            EventKind::ReasoningUpdated {
                turn,
                item,
                running,
                started_at,
                ended_at,
                text,
                heading,
            } => {
                let record = ReasoningRecord {
                    running,
                    started_at,
                    ended_at,
                    text,
                    heading,
                };
                let state = if running {
                    ChatToolState::Running
                } else {
                    ChatToolState::Completed
                };
                let id = format!("{run}:reasoning:{}", item.0);
                self.turn_record(&turn, id, REASONING_RECORD_NAME, &record, state);
            }
            EventKind::PlanUpdated { turn, plan } => {
                let id = format!("{run}:plan:{}", turn.0);
                let record = PlanRecord::from(&plan);
                self.turn_record(
                    &turn,
                    id,
                    PLAN_RECORD_NAME,
                    &record,
                    ChatToolState::Completed,
                );
            }
            EventKind::FilesChanged { turn, files } => {
                let id = format!("{run}:files:{}", turn.0);
                let record = FilesRecord::from(files.as_slice());
                self.turn_record(
                    &turn,
                    id,
                    FILES_RECORD_NAME,
                    &record,
                    ChatToolState::Completed,
                );
            }
            EventKind::ContextUsage(usage) => {
                if let Some(runtime) = &mut self.runtime {
                    runtime.context = Some(ContextReport {
                        usage,
                        at: now_millis(),
                        compacted_at: runtime.compacted_at,
                    });
                }
            }
            EventKind::Compacted => {
                if let Some(runtime) = &mut self.runtime {
                    let at = Some(now_millis());
                    runtime.compacted_at = at;
                    if let Some(context) = &mut runtime.context {
                        context.compacted_at = at;
                    }
                }
            }
            EventKind::SettingsState(settings) => {
                if let Some(runtime) = &mut self.runtime {
                    runtime.settings = Some(settings);
                }
            }
            EventKind::CommandsListed(commands) => {
                if let Some(runtime) = &mut self.runtime {
                    runtime.commands = commands;
                }
            }
            EventKind::Unknown { summary, .. } => self.harness_notice(summary),
        }
    }

    /// A tool item's latest state: recorded at once when it is new or finished, and with
    /// the next checkpoint while it only reports progress.
    #[allow(clippy::too_many_arguments)]
    fn on_tool(
        &mut self,
        run: &str,
        turn_id: Option<String>,
        owner: ChatOwner,
        item: NativeItemId,
        title: String,
        status: ToolStatus,
        output: Option<String>,
        detail: Option<ProviderDetail>,
        mut observations: Vec<ChatObservation>,
    ) {
        let tool_id = format!("{run}:{}", item.0);
        let state = tool_state(status);
        let input = detail.map(|d| d.payload().to_owned()).unwrap_or_default();
        let first = self
            .runtime
            .as_mut()
            .is_some_and(|runtime| runtime.tools.insert(tool_id.clone()));
        // A shell Step's window opens when it is first seen, so a write made while it runs
        // can be credited to the agent that ran it.
        let window = if first {
            self.shell_window(&title, &input, state)
        } else {
            None
        };
        let tool = ChatObservation::Tool {
            tool_id: tool_id.clone(),
            turn_id,
            owner,
            name: title,
            input,
            state,
            output,
        };
        self.pending_tools.retain(|(id, _)| *id != tool_id);
        if first || state != ChatToolState::Running {
            observations.push(tool);
            if let Some(writes) = window {
                observations.push(ChatObservation::ShellStep {
                    tool_id: tool_id.clone(),
                    writes,
                });
            }
            self.record(observations);
        } else {
            // Progress of a running tool is saved with the next checkpoint.
            self.record_if_any(observations);
            self.pending_tools.push((tool_id, tool));
            self.checkpoint_at
                .get_or_insert(Instant::now() + TEXT_CHECKPOINT_INTERVAL);
        }
    }

    /// What the plain `ticketd` calls of a Step could write, when it is a shell Step.
    fn shell_window(
        &self,
        title: &str,
        input: &str,
        state: ChatToolState,
    ) -> Option<Vec<ticketd_core::ChatPlannedWrite>> {
        let adapter = self.adapter.as_ref()?;
        crate::write_credit::shell_step_writes(adapter.harness().key.as_str(), title, input, state)
    }

    /// Records a turn's reasoning, plan or files as the tool record that keeps it,
    /// replacing what the harness reported before.
    fn turn_record<T: serde::Serialize>(
        &mut self,
        turn: &NativeTurnId,
        tool_id: String,
        name: &str,
        record: &T,
        state: ChatToolState,
    ) {
        let mut observations = Vec::new();
        let Some(turn_id) = self.turn(turn, &mut observations) else {
            return;
        };
        let Ok(input) = serde_json::to_string(record) else {
            return;
        };
        observations.push(ChatObservation::Tool {
            tool_id,
            turn_id: Some(turn_id),
            owner: ChatOwner::Main,
            name: name.to_owned(),
            input,
            state,
            output: None,
        });
        self.record(observations);
    }

    /// Records a sub-agent's reasoning or files as the tool record that keeps it, owned by
    /// it. Like its Steps, it belongs to the turn that is active, if one is, and opens none.
    fn sub_agent_record<T: serde::Serialize>(
        &mut self,
        sub_agent: NativeSubAgentId,
        tool_id: String,
        name: &str,
        record: &T,
        state: ChatToolState,
    ) {
        let Ok(input) = serde_json::to_string(record) else {
            return;
        };
        self.record(vec![ChatObservation::Tool {
            tool_id,
            turn_id: self.active.as_ref().map(|active| active.turn_id.clone()),
            owner: ChatOwner::SubAgent {
                native_id: sub_agent.0,
            },
            name: name.to_owned(),
            input,
            state,
            output: None,
        }]);
    }

    fn record_if_any(&mut self, observations: Vec<ChatObservation>) {
        if !observations.is_empty() {
            self.record(observations);
        }
    }

    fn on_interaction(
        &mut self,
        run: &str,
        generation: RuntimeGeneration,
        request: InteractionRequest,
        mut observations: Vec<ChatObservation>,
    ) {
        // A sub-agent's request belongs to the sub-agent, not to the turn that happens to
        // be running: it needs no turn, and no turn's end takes it away.
        let (turn_id, owner) = match request.owner {
            Some(owner) => (None, ChatOwner::SubAgent { native_id: owner.0 }),
            None => {
                let native_turn = request
                    .turn
                    .or_else(|| self.active.as_ref().map(|active| active.native.clone()));
                let Some(turn_id) =
                    native_turn.and_then(|turn| self.turn(&turn, &mut observations))
                else {
                    // It cannot be recorded, so it cannot be offered; it stays unanswered.
                    self.notice(
                        "The harness asked something outside a turn; it was not answered."
                            .to_owned(),
                    );
                    return;
                };
                (Some(turn_id), ChatOwner::Main)
            }
        };
        let interaction_id = format!("{run}:request:{}", request.request.0);
        let (kind, prompt, reason) = match &request.kind {
            InteractionKind::Approval {
                description,
                reason,
                ..
            }
            | InteractionKind::NativeApproval {
                description,
                reason,
                ..
            } => (
                ChatInteractionKind::Approval,
                description.clone(),
                reason.clone(),
            ),
            InteractionKind::Question { questions } => (
                ChatInteractionKind::Question,
                questions
                    .iter()
                    .map(|question| question.prompt.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                None,
            ),
        };
        observations.push(ChatObservation::InteractionRequested {
            interaction_id: interaction_id.clone(),
            turn_id: turn_id.clone(),
            owner: owner.clone(),
            kind,
            native_request_id: Some(request.request.0.clone()),
            prompt,
            reason,
            tool_id: request
                .item
                .as_ref()
                .map(|item| format!("{run}:{}", item.0)),
        });
        self.record(observations);
        self.interactions.insert(
            interaction_id,
            LiveRequest {
                generation,
                request: request.request,
                turn_id,
                owner,
                kind: request.kind,
                answering: None,
            },
        );
    }

    // ------------------------------------------------------------------
    // Timers and views
    // ------------------------------------------------------------------

    fn on_timer(&mut self) {
        let now = Instant::now();
        if self.context_retry_at().is_some_and(|at| at <= now) {
            self.retry_link_context();
        }
        if self.show_text_at.is_some_and(|at| at <= now) {
            self.show_text();
        }
        if self.checkpoint_at.is_some_and(|at| at <= now) {
            self.record(Vec::new());
        }
        if self.wake_until.is_some_and(|at| at <= now) {
            // The main agent did not resume: the Chat is quiet.
            self.wake_until = None;
            self.unpublished = true;
        }
        if self.stop_deadline.is_some_and(|at| at <= now) {
            self.stop_deadline = None;
            if self.stop.is_some() {
                self.stop = Some(StopState::Unconfirmed);
            }
        }
        if self.unconfirmed_deadline.is_some_and(|at| at <= now) {
            self.unconfirmed_deadline = None;
            if let Some(attempt_id) = self.unconfirmed_start.take() {
                self.delivery_unconfirmed(attempt_id);
            }
        }
    }

    /// Sends views the streamed text they have not seen, coalesced since the last call.
    fn show_text(&mut self) {
        self.show_text_at = None;
        for buffer in &mut self.text {
            if buffer.shown < buffer.text.len() {
                let update = ChatUpdate::Text {
                    message_id: buffer.message_id.clone(),
                    turn_id: buffer.turn_id.clone(),
                    delta: buffer.text[buffer.shown..].to_owned(),
                };
                buffer.shown = buffer.text.len();
                for subscriber in &self.subscribers {
                    subscriber.push(update.clone());
                }
            }
        }
    }

    /// A notice from the harness. One it repeats word for word (the same unknown
    /// message every turn, a warning on every start) is kept once per session, so the
    /// conversation is not buried under it.
    fn harness_notice(&mut self, text: String) {
        let first = self
            .runtime
            .as_mut()
            .is_none_or(|runtime| runtime.said.insert(text.clone()));
        if first {
            self.record_notice(text, true);
        }
    }

    /// Keeps something worth telling the person that belongs to no other record. It is
    /// stored, so it is there for a view that attaches later.
    fn notice(&mut self, text: String) {
        self.record_notice(text, false);
    }

    fn record_notice(&mut self, text: String, from_harness: bool) {
        let chat = self.chat_id.clone();
        let notice = ChatObservation::Notice {
            notice_id: Uuid::new_v4().to_string(),
            text,
            from_harness,
        };
        // A storage failure is reported by `write` itself.
        let _ = self.write(|core| core.record_chat_observations(&chat, vec![notice]));
    }

    fn live(&self) -> ChatLive {
        let working = self.active.is_some()
            || !self.sub_agents.is_empty()
            || self.wake_until.is_some()
            || self.dispatching.is_some()
            || self.opening.is_some()
            || self.unconfirmed_start.is_some();
        ChatLive {
            activity: if !self.interactions.is_empty() {
                Activity::WaitingForYou
            } else if working {
                Activity::Working
            } else {
                Activity::Idle
            },
            running: self.runtime.is_some(),
            sub_agents: self.sub_agents.len(),
            waking: self.wake_until.is_some(),
            // Until the session's first turn starts, whatever the process is doing.
            opening: match (&self.opening, &self.runtime) {
                _ if !working => None,
                (Some(opening), _) => Some(opening.origin),
                (None, Some(runtime)) if runtime.turns.is_empty() => Some(runtime.origin),
                _ => None,
            },
            steering: self.active.as_ref().and_then(|_| self.steering()),
            steering_images_refused: self.active.is_some() && self.images_refused(true),
            delivery_unconfirmed: self.unconfirmed_start.is_some(),
            sending: self
                .direct
                .iter()
                .map(|(input, _)| input.id.clone())
                .collect(),
            prepared_queue_edits: self.prepared_queue_edits.clone(),
            interactions: self
                .interactions
                .iter()
                .filter(|(_, live)| live.answering.is_none())
                .map(|(id, live)| LiveInteraction {
                    interaction_id: id.clone(),
                    kind: live.kind.clone(),
                })
                .collect(),
            stop: self.stop,
            problem: match &self.storage_failed {
                Some(detail) => Some(ChatProblem::StorageFailed {
                    detail: detail.clone(),
                }),
                // The Automation still reports the reason it lost its own run.
                // A replacement supervisor reports the pending cleanup instead.
                None if self.unattended.is_none()
                    && self.lifecycle.has_retired_permission_runtime(&self.chat_id) =>
                {
                    Some(ChatProblem::CleanupUnconfirmed {
                        reason: HostError::PermissionRestartCleanupUnconfirmed.to_string(),
                    })
                }
                None => self.problem.clone(),
            },
            context: self.runtime.as_ref().and_then(|r| r.context.clone()),
            settings: match &self.runtime {
                Some(runtime) => runtime.settings.clone().map(|reported| {
                    Box::new(LiveSettings {
                        reported,
                        changes: runtime.setting_changes.clone(),
                    })
                }),
                None => self.settings_before_session().map(|reported| {
                    Box::new(LiveSettings {
                        reported,
                        changes: Vec::new(),
                    })
                }),
            },
            commands: self
                .runtime
                .as_ref()
                .map(|runtime| runtime.commands.clone())
                .unwrap_or_default(),
        }
    }

    /// Publishes committed changes since the last call, then live state if it changed.
    fn publish(&mut self) {
        // Reading the changes moves nothing live state is built from: built once.
        let live = self.live();
        self.board
            .report(&self.chat_id, self.number, Some(live.clone()));
        self.subscribers.retain(Publisher::open);
        if self.subscribers.is_empty() {
            return;
        }
        let chat = self.chat_id.clone();
        // Streamed text between checkpoints writes nothing, so there is nothing to read.
        while std::mem::take(&mut self.unpublished) {
            let cursor = self.cursor;
            match self.core(|core| core.chat_changes(&chat, cursor, 500)) {
                Ok(ticketd_core::ChatCatchUp::Changes {
                    changes,
                    sequence,
                    more,
                }) => {
                    self.cursor = sequence;
                    if !changes.is_empty() {
                        for subscriber in &self.subscribers {
                            subscriber.push(ChatUpdate::Changes(changes.clone()));
                        }
                    }
                    self.unpublished = more;
                }
                Ok(ticketd_core::ChatCatchUp::Resync) => {
                    for subscriber in self.subscribers.drain(..) {
                        subscriber.resync();
                    }
                    return;
                }
                // Storage trouble is reported by the write that hits it.
                Err(_) => {
                    self.unpublished = true;
                    break;
                }
            }
        }
        if self.last_live.as_ref() != Some(&live) {
            for subscriber in &self.subscribers {
                subscriber.push(ChatUpdate::Live(Box::new(live.clone())));
            }
            self.last_live = Some(live);
        }
    }
}

/// How to reopen a Chat's harness: its native session when it has one.
fn native_session(chat: &Chat) -> (SessionStart, ChatSessionOrigin, Option<String>) {
    match &chat.native_session_id {
        Some(session) => (
            SessionStart::Resume(NativeSessionId(session.clone())),
            ChatSessionOrigin::NativeResume,
            None,
        ),
        None => (SessionStart::New, ChatSessionOrigin::New, None),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)] // test setup and assertions

    use super::*;
    use crate::testing::FakeAdapter;
    use ticketd_core::{NewChat, WorkspaceSession};

    fn supervisor(path: PathBuf) -> (Supervisor, Chat) {
        let fake = FakeAdapter::codex();
        let chat = Workspace::open(&path)
            .unwrap()
            .create_chat(
                None,
                NewChat {
                    title: None,
                    harness: fake.harness().key.as_str().to_owned(),
                    execution_folder: "/work/app".to_owned(),
                    folder_managed: false,
                    links: Vec::new(),
                },
            )
            .unwrap();
        let (supervisor, _) = Supervisor::new(
            &chat,
            Arc::new(move || WorkspaceSession::for_file(&path)?.workspace()),
            Some(Arc::new(fake)),
            None,
            Arc::new(Board::new()),
            None,
            Arc::new(HostLifecycle::default()),
        );
        (supervisor, chat)
    }

    async fn open(supervisor: &mut Supervisor, chat: &Chat) -> RuntimeGeneration {
        supervisor.open(chat, SessionStart::New, ChatSessionOrigin::New, None, None);
        let opened = supervisor.finished_open.recv().await.unwrap();
        let generation = opened.generation;
        supervisor.on_opened(opened);
        generation
    }

    #[tokio::test]
    async fn stale_context_completion_cannot_release_pending_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let (mut supervisor, chat) = supervisor(dir.path().join("workspace.sqlite3"));
        let generation = open(&mut supervisor, &chat).await;
        supervisor
            .send(None, "queued reply", SendMode::Auto, &[], None)
            .unwrap();
        let latest = Uuid::new_v4();
        let reading = Some(ContextRefresh::Reading {
            request: latest,
            retrying: false,
            scope: ContextRefreshScope::NextTurn,
        });
        supervisor.refreshing = reading;

        supervisor.on_done(Done::Context {
            generation,
            request: Uuid::new_v4(),
            context: Ok(Some("old links".to_owned())),
        });
        supervisor.pump();
        assert!(supervisor.dispatching.is_none());
        assert_eq!(supervisor.refreshing, reading);

        supervisor.on_done(Done::Context {
            generation,
            request: latest,
            context: Ok(Some("new links".to_owned())),
        });
        supervisor.pump();
        assert_eq!(
            supervisor.pending_contexts.back().unwrap().text.as_ref(),
            "new links"
        );
    }

    #[tokio::test]
    async fn rejected_submission_keeps_newer_link_context_for_the_next_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (mut supervisor, chat) = supervisor(dir.path().join("workspace.sqlite3"));
        let generation = open(&mut supervisor, &chat).await;
        supervisor.session_context = Some("old links".into());
        supervisor
            .send(None, "reply", SendMode::Auto, &[], None)
            .unwrap();
        supervisor.pump();
        supervisor.dispatching.as_mut().unwrap().early_rejection =
            Some("harness rejected the request".to_owned());
        let latest = Uuid::new_v4();
        supervisor.refreshing = Some(ContextRefresh::Reading {
            request: latest,
            retrying: false,
            scope: ContextRefreshScope::NextTurn,
        });
        supervisor.on_done(Done::Context {
            generation,
            request: latest,
            context: Ok(Some("new links".to_owned())),
        });
        supervisor.on_done(Done::Dispatched {
            outcome: DispatchOutcome::Written,
        });

        supervisor.resume_queue().await.unwrap();
        supervisor.pump();
        assert_eq!(
            supervisor.pending_contexts.back().unwrap().text.as_ref(),
            "new links"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn closing_while_initial_context_is_blocked_cancels_the_open() {
        let dir = tempfile::tempdir().unwrap();
        let (mut supervisor, chat) = supervisor(dir.path().join("workspace.sqlite3"));
        let fake = FakeAdapter::codex();
        supervisor.adapter = Some(Arc::new(fake.clone()));
        let (entered, mut reading) = mpsc::unbounded_channel();
        let (released, mut finished) = mpsc::unbounded_channel();
        supervisor.context = Some(Arc::new(move |_| {
            let (resume, held) = std::sync::mpsc::channel();
            if entered.send(resume).is_ok() {
                let _ = held.recv();
            }
            let _ = released.send(());
            Ok(Some("initial context".to_owned()))
        }));
        let (reply, cancelled) = oneshot::channel();
        supervisor.open(
            &chat,
            SessionStart::New,
            ChatSessionOrigin::New,
            None,
            Some(reply),
        );
        let release = timeout(Duration::from_secs(10), reading.recv())
            .await
            .unwrap()
            .unwrap();
        let worker = supervisor.opening.as_ref().unwrap().worker.abort_handle();

        assert_eq!(
            timeout(
                CLOSE_TIMEOUT,
                supervisor.close_runtime(StopReason::TurnedOff)
            )
            .await
            .unwrap(),
            None
        );
        assert!(matches!(cancelled.await.unwrap(), Err(HostError::Quitting)));
        assert!(worker.is_finished());
        assert!(!supervisor.lifecycle.has_runtime_cleanup(&chat.id));
        release.send(()).unwrap();
        timeout(Duration::from_secs(10), finished.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(fake.opens().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_resends_share_a_bounded_context_and_evicted_evidence_still_settles() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let (mut supervisor, chat) = supervisor(path.clone());
        let generation = open(&mut supervisor, &chat).await;
        let original_context: Arc<str> = "original links".into();
        supervisor.session_context = Some(original_context.clone());
        let input = supervisor
            .send(None, "first", SendMode::Auto, &[], None)
            .unwrap();
        supervisor.pump();
        let first_attempt = supervisor.dispatching.as_ref().unwrap().attempt.clone();

        for _ in 0..MAX_PENDING_CONTEXTS {
            supervisor.on_dispatched(DispatchOutcome::Written);
            tokio::time::advance(DELIVERY_CONFIRMATION_TIMEOUT).await;
            supervisor.on_timer();
            supervisor.request_resend(input.id.clone()).await.unwrap();
            supervisor.pump();
            assert!(supervisor.dispatching.is_some());
        }
        assert_eq!(supervisor.pending_contexts.len(), MAX_PENDING_CONTEXTS);
        assert!(supervisor.pending_contexts.iter().all(|transfer| {
            transfer.attempt_id != first_attempt && Arc::ptr_eq(&transfer.text, &original_context)
        }));

        supervisor.on_dispatched(DispatchOutcome::Written);
        tokio::time::advance(DELIVERY_CONFIRMATION_TIMEOUT).await;
        supervisor.on_timer();
        supervisor.set_session_context("edited links".to_owned());
        supervisor
            .send(None, "second", SendMode::Auto, &[], None)
            .unwrap();
        supervisor.pump();
        let first_turn = NativeTurnId::new("first");
        supervisor.on_event(Some(RuntimeEvent {
            generation,
            kind: EventKind::SubmissionEvidence {
                submission: SubmissionId(first_attempt.clone()),
                evidence: DeliveryEvidence::Acknowledged {
                    turn: first_turn.clone(),
                },
            },
        }));

        let workspace = Workspace::open(&path).unwrap();
        let items = workspace.chat_snapshot(&chat.id, 100).unwrap().items;
        let first = items
            .iter()
            .find_map(|item| match item {
                ticketd_core::ChatItem::Message(message) if message.id == input.id => message
                    .attempts
                    .iter()
                    .find(|attempt| attempt.id == first_attempt),
                _ => None,
            })
            .unwrap();
        assert_eq!(first.delivery, ticketd_core::ChatDelivery::Acknowledged);
        assert_eq!(
            workspace
                .chat_latest_tool_input(&chat.id, CONTEXT_RECORD_NAME)
                .unwrap(),
            None
        );
        assert_eq!(
            supervisor.pending_contexts.back().unwrap().text.as_ref(),
            "edited links"
        );

        supervisor.on_event(Some(RuntimeEvent {
            generation,
            kind: EventKind::TurnEnded {
                turn: first_turn,
                outcome: TurnOutcome::Completed,
                submissions: Vec::new(),
            },
        }));
        supervisor.on_dispatched(DispatchOutcome::Acknowledged {
            turn: NativeTurnId::new("second"),
        });
        assert_eq!(
            workspace
                .chat_latest_tool_input(&chat.id, CONTEXT_RECORD_NAME)
                .unwrap()
                .as_deref(),
            Some("edited links"),
        );
        assert!(supervisor.pending_contexts.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn late_evidence_only_records_its_own_context_before_or_after_a_newer_confirmation() {
        for newer_first in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("workspace.sqlite3");
            let (mut supervisor, chat) = supervisor(path.clone());
            let generation = open(&mut supervisor, &chat).await;
            supervisor.session_context = Some("original links".into());
            let original = supervisor
                .send(None, "first", SendMode::Auto, &[], None)
                .unwrap();
            supervisor.pump();
            let first_attempt = supervisor.dispatching.as_ref().unwrap().attempt.clone();
            supervisor.on_dispatched(DispatchOutcome::Written);
            tokio::time::advance(DELIVERY_CONFIRMATION_TIMEOUT).await;
            supervisor.on_timer();
            assert!(supervisor.unconfirmed_start.is_none());

            supervisor.session_context = Some("edited links".into());
            supervisor
                .send(None, "second", SendMode::Auto, &[], None)
                .unwrap();
            supervisor.pump();
            let later_attempt = supervisor.dispatching.as_ref().unwrap().attempt.clone();
            let first = NativeTurnId::new("first");
            let later = NativeTurnId::new("second");
            let ended = |turn| {
                Some(RuntimeEvent {
                    generation,
                    kind: EventKind::TurnEnded {
                        turn,
                        outcome: TurnOutcome::Completed,
                        submissions: Vec::new(),
                    },
                })
            };
            let latest = || {
                Workspace::open(&path)
                    .unwrap()
                    .chat_latest_tool_input(&chat.id, CONTEXT_RECORD_NAME)
                    .unwrap()
                    .unwrap()
            };
            if newer_first {
                // The turn's named processing evidence can arrive before submit replies.
                supervisor.on_event(Some(RuntimeEvent {
                    generation,
                    kind: EventKind::TurnEnded {
                        turn: later.clone(),
                        outcome: TurnOutcome::Completed,
                        submissions: vec![SubmissionId(later_attempt.clone())],
                    },
                }));
                assert_eq!(latest(), "edited links");
            }
            supervisor.on_event(Some(RuntimeEvent {
                generation,
                kind: EventKind::SubmissionEvidence {
                    submission: SubmissionId(first_attempt),
                    evidence: DeliveryEvidence::Acknowledged {
                        turn: first.clone(),
                    },
                },
            }));
            supervisor.on_event(ended(first));
            if newer_first {
                assert_eq!(latest(), "edited links");
            } else {
                assert_eq!(latest(), "original links");
                assert_eq!(
                    supervisor.pending_contexts.back().unwrap().attempt_id,
                    later_attempt
                );
                supervisor.on_dispatched(DispatchOutcome::Acknowledged { turn: later });
                assert_eq!(latest(), "edited links");
            }
            let items = Workspace::open(&path)
                .unwrap()
                .chat_snapshot(&chat.id, 100)
                .unwrap()
                .items;
            let attempt = items
                .iter()
                .find_map(|item| match item {
                    ticketd_core::ChatItem::Message(message) if message.id == original.id => {
                        message.attempts.first()
                    }
                    _ => None,
                })
                .unwrap();
            assert_eq!(attempt.delivery, ticketd_core::ChatDelivery::Acknowledged);
            let tools = items
                .iter()
                .filter(|item| {
                    matches!(item,
                        ticketd_core::ChatItem::Tool(tool) if tool.name == CONTEXT_RECORD_NAME
                    )
                })
                .count();
            assert_eq!(tools, if newer_first { 1 } else { 2 });
        }
    }

    #[tokio::test]
    async fn replacement_open_refuses_a_retired_late_runtime_after_its_hold_releases() {
        let dir = tempfile::tempdir().unwrap();
        let (mut supervisor, chat) = supervisor(dir.path().join("workspace.sqlite3"));
        open(&mut supervisor, &chat).await;
        let runtime = supervisor.runtime.take().unwrap();
        let lifecycle = supervisor.lifecycle.clone();
        lifecycle.hold_pending_open_cleanup(&chat.id);
        lifecycle.retire_runtime(&chat.id, runtime.handle, true);
        lifecycle.release_pending_open_cleanup(&chat.id);

        let (send, mut reply) = oneshot::channel();
        supervisor.open(
            &chat,
            SessionStart::New,
            ChatSessionOrigin::New,
            None,
            Some(send),
        );
        assert!(matches!(
            reply.try_recv(),
            Ok(Err(HostError::PermissionRestartCleanupUnconfirmed))
        ));
        assert!(supervisor.opening.is_none());
    }
}
