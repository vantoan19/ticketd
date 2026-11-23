//! One Chat's supervisor: a task that handles one message at a time and owns the
//! Chat's dispatch, queue policy, active turn, live requests and runtime lifetime.
//!
//! Adapter calls that can wait on the harness (open, submit, interrupt, respond) run in
//! their own tasks and report back as messages, so runtime events and commands keep
//! being handled while they are pending. Every durable write goes through the core.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::future::{Future, pending};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ticketd_core::{
    Chat, ChatInteractionKind, ChatInteractionState, ChatMessage, ChatObservation,
    ChatSessionOrigin, ChatSubmissionIntent, ChatToolState, ChatTurnState, Error, Workspace,
};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until, timeout, timeout_at};
use tracing::Instrument;
use uuid::Uuid;

use crate::host::{
    AGENT_CHANGES_RECORD_NAME, Activity, Board, CLOSE_TIMEOUT, CONTEXT_RECORD_NAME, ChatLive,
    ChatProblem, ChatView, ContextReport, ContextSource, DELIVERY_CONFIRMATION_TIMEOUT, HostError,
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
use crate::{
    ApprovalDecision, Capabilities, CloseOutcome, DeliveryEvidence, DispatchOutcome, EventKind,
    HarnessAdapter, HarnessRuntime, InteractionAnswer, InteractionKind, InteractionRequest,
    InteractionResolution, InteractionResponse, InterruptOutcome, InterruptRequest,
    NativeRequestId, NativeSessionId, NativeTurnId, NoticeKind, OpenRequest, OpenedRuntime,
    Problem, RespondOutcome, RuntimeEvent, RuntimeGeneration, SessionStart, Submission,
    SubmissionId, SubmissionKind, Subscription, TurnEvidence, TurnOutcome, Unattended,
};

pub(crate) type Reply<T> = oneshot::Sender<Result<T, HostError>>;

pub(crate) enum Command {
    Attach(Reply<(ChatView, Subscription)>),
    Send {
        command_id: Option<String>,
        text: String,
        mode: SendMode,
        reply: Reply<ChatMessage>,
    },
    Stop(Reply<()>),
    ResumeQueue(Reply<()>),
    /// The person asked for one queued input to go out now, ahead of the queue.
    SendQueuedNow {
        message_id: String,
        reply: Reply<()>,
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
    /// Stop the runtime and end the supervisor; replies with unconfirmed cleanup.
    Shutdown(StopReason, oneshot::Sender<Option<String>>),
}

/// The result of an adapter call that ran in its own task.
enum Done {
    Opened {
        generation: RuntimeGeneration,
        result: Result<OpenedRuntime, Problem>,
        /// The ticketd context read for the new session, or why it could not be.
        context: Result<Option<String>, String>,
    },
    Dispatched {
        outcome: DispatchOutcome,
    },
    /// The ticketd context read again for the live session after its links changed.
    Context {
        generation: RuntimeGeneration,
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
}

struct Dispatch {
    attempt: String,
    generation: RuntimeGeneration,
    starts_turn: bool,
    preamble: Option<String>,
    context: Option<String>,
}

struct ActiveTurn {
    turn_id: String,
    native: NativeTurnId,
    /// The workspace change token when the turn started; unchanged means nothing in
    /// the workspace changed, so the agent changed no record.
    token: Option<i64>,
    /// Open for as long as the Turn is, so every line about it is correlated and its close
    /// records how long it took.
    span: tracing::Span,
}

struct LiveRequest {
    generation: RuntimeGeneration,
    request: NativeRequestId,
    turn_id: String,
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
    adapter: Option<Arc<dyn HarnessAdapter>>,
    context: Option<ContextSource>,
    /// Set for the Chat of an Automation run: every session opens with these settings.
    unattended: Option<Unattended>,
    board: Arc<Board>,
    commands: mpsc::Receiver<Command>,
    done: mpsc::UnboundedSender<Done>,
    finished: mpsc::UnboundedReceiver<Done>,
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
    /// Input the person sent for immediate dispatch, ahead of the queue.
    direct: VecDeque<String>,
    /// The inputs in `direct` that the person took out of the queue with Send now.
    /// They had no row on screen, so their history moves to where they are sent.
    direct_from_queue: HashSet<String>,
    /// Input the person asked to send again although its delivery is uncertain.
    resend: Option<String>,
    /// Selected history for a fresh session, sent with the next new turn.
    preamble: Option<String>,
    /// The ticketd context of a new session, sent with its first new turn.
    session_context: Option<String>,
    /// Context handed over with a submission whose turn has not been recorded yet.
    context_sent: Option<String>,
    text: Vec<TextBuffer>,
    pending_tools: Vec<(String, ChatObservation)>,
    interactions: BTreeMap<String, LiveRequest>,
    stop: Option<StopState>,
    stop_when_turn_known: bool,
    problem: Option<ChatProblem>,
    storage_failed: Option<String>,
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
    /// The runtime is being closed on purpose; its connection ending is not a loss.
    closing: bool,
    /// Something may have been written since views were last brought up to date.
    unpublished: bool,
    /// The context of the live session is being read again; nothing is dispatched until
    /// it is, so the next message carries it.
    refreshing: Option<RuntimeGeneration>,
    /// The person's picks for the next session, new or resumed: New Chat's, or a change
    /// made while no session ran. Kept until one opens.
    start_settings: StartSettings,
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

impl Supervisor {
    pub(crate) fn spawn(
        chat: &Chat,
        open_workspace: WorkspaceOpener,
        adapter: Option<Arc<dyn HarnessAdapter>>,
        context: Option<ContextSource>,
        board: Arc<Board>,
        unattended: Option<Unattended>,
    ) -> mpsc::Sender<Command> {
        let (sender, commands) = mpsc::channel(64);
        let (done, finished) = mpsc::unbounded_channel();
        // A root span, so a Chat opened from inside a command or a pass is not held open by it.
        let span = tracing::info_span!(
            parent: None,
            "chat",
            chat_id = chat.id.as_str(),
            automation_run_id = unattended
                .as_ref()
                .map(|unattended| unattended.run_id.as_str()),
        );
        let supervisor = Self {
            span: span.clone(),
            chat_id: chat.id.clone(),
            number: NEXT_SUPERVISOR.fetch_add(1, Ordering::Relaxed),
            open_workspace,
            adapter,
            context,
            unattended,
            board,
            commands,
            done,
            finished,
            generations: 0,
            runtime: None,
            opening: None,
            dispatching: None,
            unconfirmed_start: None,
            turn_evidence: None,
            unconfirmed_deadline: None,
            active: None,
            direct: VecDeque::new(),
            direct_from_queue: HashSet::new(),
            resend: None,
            preamble: None,
            session_context: None,
            context_sent: None,
            text: Vec::new(),
            pending_tools: Vec::new(),
            interactions: BTreeMap::new(),
            stop: None,
            stop_when_turn_known: false,
            problem: None,
            storage_failed: None,
            subscribers: Vec::new(),
            cursor: 0,
            last_live: None,
            show_text_at: None,
            checkpoint_at: None,
            stop_deadline: None,
            shutting_down: false,
            shut_down_for: None,
            queue_started: false,
            closing: false,
            unpublished: true,
            refreshing: None,
            start_settings: StartSettings::default(),
            recorded_settings: chat.effective_settings.clone(),
        };
        tokio::spawn(supervisor.run().instrument(span));
        sender
    }

    async fn run(mut self) {
        loop {
            let timer = [
                self.show_text_at,
                self.checkpoint_at,
                self.stop_deadline,
                self.unconfirmed_deadline,
            ]
            .into_iter()
            .flatten()
            .min();
            tokio::select! {
                command = self.commands.recv() => match command {
                    Some(Command::Shutdown(why, reply)) => {
                        self.shutting_down = true;
                        let unconfirmed = self.stop_runtime(why).await;
                        self.publish();
                        self.board.report(&self.chat_id, self.number, None);
                        let _ = reply.send(unconfirmed);
                        return;
                    }
                    Some(command) => {
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
                Some(done) = self.finished.recv() => {
                    self.turn_span().in_scope(|| self.on_done(done));
                }
                event = next_event(&mut self.runtime) => {
                    self.turn_span().in_scope(|| self.on_event(event));
                }
                () = sleep_until_some(timer) => self.turn_span().in_scope(|| self.on_timer()),
            }
            if self.storage_failed.is_some() && (self.runtime.is_some() || self.opening.is_some()) {
                // Controlled shutdown: nothing more can be recorded, so nothing more runs.
                if let Some(reason) = self.stop_runtime(StopReason::StorageFailed).await {
                    self.notice(format!("Stopping the harness was not confirmed: {reason}"));
                }
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
    fn record(&mut self, mut observations: Vec<ChatObservation>) {
        self.show_text();
        let mut batch = Vec::new();
        for buffer in &mut self.text {
            if buffer.saved < buffer.text.len() {
                buffer.saved = buffer.text.len();
                batch.push(ChatObservation::AssistantText {
                    message_id: buffer.message_id.clone(),
                    turn_id: buffer.turn_id.clone(),
                    text: buffer.text.clone(),
                    complete: false,
                });
            }
        }
        batch.extend(self.pending_tools.drain(..).map(|(_, tool)| tool));
        batch.append(&mut observations);
        self.checkpoint_at = None;
        if batch.is_empty() {
            return;
        }
        let chat = self.chat_id.clone();
        let together = batch.clone();
        if let Err(Error::Chat(_)) =
            self.write(|core| core.record_chat_observations(&chat, together))
        {
            // One observation was refused; keep the others.
            for observation in batch {
                if let Err(Error::Chat(reason)) =
                    self.write(|core| core.record_chat_observations(&chat, vec![observation]))
                {
                    self.notice(format!("An observation was not recorded: {reason}"));
                }
            }
        }
    }

    fn pause(&mut self, problem: ChatProblem) {
        let chat = self.chat_id.clone();
        let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
        self.direct.clear();
        self.direct_from_queue.clear();
        self.resend = None;
        self.problem = Some(problem);
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
            Command::Send {
                command_id,
                text,
                mode,
                reply,
            } => {
                let _ = reply.send(self.send(command_id.as_deref(), &text, mode));
            }
            Command::Stop(reply) => {
                let _ = reply.send(self.request_stop());
            }
            Command::ResumeQueue(reply) => {
                let chat = self.chat_id.clone();
                let result = self.write(|core| core.set_chat_queue_paused(&chat, false));
                if result.is_ok() {
                    // The person asked for the queue to run: it opens a session when
                    // none is live.
                    self.queue_started = true;
                    if matches!(self.problem, Some(ChatProblem::DispatchRefused { .. })) {
                        self.problem = None;
                    }
                }
                let _ = reply.send(result.map(|_| ()).map_err(HostError::from));
            }
            Command::SendQueuedNow { message_id, reply } => {
                let _ = reply.send(self.send_queued_now(message_id));
            }
            Command::Respond {
                interaction_id,
                answer,
                reply,
            } => self.respond(interaction_id, answer, reply),
            Command::Resume { mode, reply } => self.resume(mode, reply).await,
            Command::Resend { message_id, reply } => {
                let _ = reply.send(self.request_resend(message_id));
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
            Command::LinksChanged => self.refresh_context(),
            // Views read the Chat again even when no record changed: what they show
            // can depend on the folder too, such as its branch.
            Command::Changed => self.last_live = None,
            Command::Shutdown(..) => {}
        }
    }

    /// Refuses a value the harness did not offer, holds a change while a turn runs and
    /// otherwise sends it now.
    fn change_setting(&mut self, setting: SettingKey, value: String) -> SettingChangeState {
        let busy = self.active.is_some() || self.dispatching.is_some();
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
        runtime
            .setting_changes
            .retain(|change| change.setting != setting);
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
            SettingKey::Permission => {
                self.record_permission(&value);
                self.start_settings.permission = Some(value);
            }
            // Only the permission is shown before a session.
            SettingKey::Model | SettingKey::Effort => return refused("no session is running"),
        }
        SettingChangeState::Held
    }

    /// Saves `value` with the Chat as the permission its next session opens with, as
    /// soon as the change is accepted, so a restart before the next message cannot bring
    /// back a mode the person left. The record views read changes only once it is saved.
    fn record_permission(&mut self, value: &str) {
        let Some(updated) = self.adapter.as_ref().and_then(|adapter| {
            adapter.record_permission(self.recorded_settings.as_deref(), value)
        }) else {
            return;
        };
        let chat = self.chat_id.clone();
        if self
            .write(|core| core.set_chat_effective_settings(&chat, &updated))
            .is_ok()
        {
            self.recorded_settings = Some(updated);
        }
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
        if self.active.is_some() || self.dispatching.is_some() {
            return;
        }
        let Some(runtime) = &mut self.runtime else {
            return;
        };
        let mut held = Vec::new();
        for change in &mut runtime.setting_changes {
            if change.state == SettingChangeState::Held {
                change.state = SettingChangeState::Sent;
                held.push((change.setting, change.value.clone()));
            }
        }
        for (setting, value) in held {
            self.send_setting(setting, value);
        }
    }

    /// Reads the ticketd context again for the live session. Without one there is nothing
    /// to tell: the next session reads the context when it opens.
    fn refresh_context(&mut self) {
        let (Some(runtime), Some(source)) = (&self.runtime, self.context.clone()) else {
            return;
        };
        let (done, chat_id, generation) =
            (self.done.clone(), self.chat_id.clone(), runtime.generation);
        self.refreshing = Some(generation);
        tokio::spawn(async move {
            // It runs the CLI and can take seconds: off the async threads.
            let context = tokio::task::spawn_blocking(move || source(&chat_id))
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
            let _ = done.send(Done::Context {
                generation,
                context,
            });
        });
    }

    /// The context this Chat's sessions were last given or are about to be given.
    fn context_given(&self) -> Option<String> {
        if let Some(context) = self.session_context.as_ref().or(self.context_sent.as_ref()) {
            return Some(context.clone());
        }
        let chat = self.chat_id.clone();
        // Unreadable: treated as never given, so the context is sent rather than lost.
        self.core(|core| core.chat_latest_tool_input(&chat, CONTEXT_RECORD_NAME))
            .ok()
            .flatten()
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
    ) -> Result<ChatMessage, HostError> {
        let chat = self.chat_id.clone();
        if self.storage_failed.is_some() {
            // Accept work again only once storage can record what was lost meanwhile.
            let ending = TurnEnding::StoppedByTicketd(StopReason::StorageFailed);
            self.core(|core| {
                core.mark_chat_contact_lost(
                    Some(&chat),
                    &ending.detail().unwrap_or_default(),
                    &ending.key(),
                )
            })
            .map_err(|error| HostError::StorageFailed(error.to_string()))?;
            self.storage_failed = None;
            self.problem = None;
        }
        let message = self.write(|core| core.save_chat_input(command_id, &chat, text))?;
        let immediate = self.active.is_none() || self.steering().is_some();
        if mode == SendMode::Auto
            && immediate
            && message.queued
            && !self.direct.contains(&message.id)
        {
            if self.active.is_none() && self.older_input_waits(&message.id) {
                // Older input waits in a queue that is not paused: this goes after
                // it, and the queue runs.
                self.queue_started = true;
            } else {
                self.direct.push_back(message.id.clone());
            }
        }
        Ok(message)
    }

    /// Sends one queued input now: it steers the turn in progress or starts one. Only
    /// that input goes; a paused queue stays paused. Refused while a turn runs that
    /// cannot be steered, since the input could only wait in the queue where it is.
    fn send_queued_now(&mut self, message_id: String) -> Result<(), HostError> {
        if let Some(detail) = &self.storage_failed {
            return Err(HostError::StorageFailed(detail.clone()));
        }
        if self.active.is_some() && self.steering().is_none() {
            return Err(HostError::Working);
        }
        let chat = self.chat_id.clone();
        let queued = self.core(|core| core.chat_queue(&chat))?;
        if !queued.iter().any(|message| message.id == message_id) {
            return Err(Error::Chat("this input is not in the queue".to_owned()).into());
        }
        if !self.direct.contains(&message_id) {
            self.direct_from_queue.insert(message_id.clone());
            self.direct.push_back(message_id);
        }
        Ok(())
    }

    /// Whether the queue, not paused, holds input saved before `message_id`.
    fn older_input_waits(&self, message_id: &str) -> bool {
        let chat = self.chat_id.clone();
        self.core(|core| {
            Ok(!core.chat(&chat)?.queue_paused
                && core
                    .chat_queue(&chat)?
                    .first()
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
        self.direct.clear();
        self.direct_from_queue.clear();
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
        Ok(())
    }

    /// The person decided to send input again although its first delivery is uncertain.
    /// Only that input is dispatched, as a new submission: the queue is paused first, so
    /// nothing else follows it until the person resumes the queue.
    fn request_resend(&mut self, message_id: String) -> Result<(), HostError> {
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
        self.write(|core| core.set_chat_queue_paused(&chat, true))?;
        self.direct.clear();
        self.direct_from_queue.clear();
        self.problem = None;
        self.resend = Some(message_id);
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
        self.direct.clear();
        self.direct_from_queue.clear();
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
        let response = match &answer {
            InteractionAnswer::Approval(ApprovalDecision::Allow) => "allow".to_owned(),
            InteractionAnswer::Approval(ApprovalDecision::AllowForSession) => {
                "allow for session".to_owned()
            }
            InteractionAnswer::Approval(ApprovalDecision::Deny) => "deny".to_owned(),
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
        let chat_id = self.chat_id.clone();
        let chat = match self.core(|core| core.chat(&chat_id)) {
            // A trashed Chat runs nothing until it is restored.
            Ok(chat) if chat.trashed => {
                let _ = reply.send(Err(Error::ChatTrashed(chat_id).into()));
                return;
            }
            Ok(chat) => chat,
            Err(error) => {
                let _ = reply.send(Err(error.into()));
                return;
            }
        };
        if self.runtime.is_some() {
            self.stop_runtime(StopReason::ExplicitResume).await;
        }
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
            unattended: self.unattended.clone(),
            ticketd_cli: None,
            taken_over,
        };
        self.opening = Some(Opening {
            generation,
            origin,
            preamble,
            reply,
        });
        let (done, chat_id) = (self.done.clone(), chat.id.clone());
        let chat_span = self.span.clone();
        tokio::spawn(
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
                let result = adapter.open(request).await;
                let _ = done.send(Done::Opened {
                    generation,
                    result,
                    context,
                });
            }
            .instrument(chat_span),
        );
    }

    /// Stops the owned runtime with bounded cleanup and records that contact ended.
    /// Returns why cleanup could not be confirmed, if it could not.
    async fn stop_runtime(&mut self, why: StopReason) -> Option<String> {
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

    async fn close_runtime(&mut self, why: StopReason) -> Option<String> {
        self.record(Vec::new());
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        while self.opening.is_some() {
            match timeout_at(deadline, self.finished.recv()).await {
                Ok(Some(done)) => self.on_done(done),
                _ => break,
            }
        }
        if let Some(opening) = self.opening.take() {
            if let Some(reply) = opening.reply {
                let _ = reply.send(Err(HostError::Quitting));
            }
            self.runtime_gone(&TurnEnding::StoppedByTicketd(why));
            return Some("the harness was still starting".to_owned());
        }
        let Some(runtime) = &self.runtime else {
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
        let unconfirmed = if self.runtime.is_some() {
            let closing = self
                .drive(timeout(CLOSE_TIMEOUT, async move { handle.close().await }))
                .await;
            match closing {
                Ok(CloseOutcome::Confirmed { .. }) => None,
                Ok(CloseOutcome::Unconfirmed { reason }) => Some(reason),
                Err(_) => Some("the harness did not confirm that it exited in time".to_owned()),
            }
        } else {
            None
        };
        self.runtime = None;
        self.runtime_gone(&TurnEnding::StoppedByTicketd(why));
        if let Some(reason) = &unconfirmed {
            self.problem = Some(ChatProblem::CleanupUnconfirmed {
                reason: reason.clone(),
            });
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
    fn runtime_gone(&mut self, ending: &TurnEnding) {
        let chat = self.chat_id.clone();
        if let Some(changes) = self.agent_changes() {
            let _ = self.write(|core| core.record_chat_observations(&chat, vec![changes]));
        }
        let _ = self.write(|core| {
            core.mark_chat_contact_lost(
                Some(&chat),
                &ending.detail().unwrap_or_default(),
                &ending.key(),
            )
        });
        self.active = None;
        self.unconfirmed_start = None;
        self.turn_evidence = None;
        self.unconfirmed_deadline = None;
        self.interactions.clear();
        self.text.clear();
        self.pending_tools.clear();
        self.direct.clear();
        self.direct_from_queue.clear();
        self.resend = None;
        self.stop = None;
        self.stop_deadline = None;
        self.stop_when_turn_known = false;
    }

    fn on_loss(&mut self, detail: String) {
        // With nothing in flight, or while ticketd itself closes the runtime, the
        // session simply ended: no turn failed, and the next message opens it again.
        let quiet = self.closing
            || (self.active.is_none()
                && self.dispatching.is_none()
                && self.unconfirmed_start.is_none()
                && self.interactions.is_empty());
        self.record(Vec::new());
        self.runtime = None;
        if self.closing {
            // `stop_runtime` settles what was open, with its own reason.
            return;
        }
        self.runtime_gone(&TurnEnding::ContactLost(Some(detail.clone())));
        if !quiet {
            self.pause(ChatProblem::RuntimeLost { detail });
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
        if self.shutting_down
            || self.storage_failed.is_some()
            || self.dispatching.is_some()
            || self.opening.is_some()
            || self.refreshing.is_some()
            || self.unconfirmed_start.is_some()
        {
            return;
        }
        let idle = self.active.is_none();
        if !idle && self.direct.is_empty() {
            // During a turn only steering input can go out, so the workspace is not
            // read for every event of a streaming turn.
            return;
        }
        let chat_id = self.chat_id.clone();
        let Ok(chat) = self.core(|core| core.chat(&chat_id)) else {
            return;
        };
        if chat.trashed {
            self.direct.clear();
            self.direct_from_queue.clear();
            self.resend = None;
            return;
        }
        // What the person asked to send again goes alone, as a new turn.
        let resend = self.resend.clone().filter(|_| idle);
        let message_id = loop {
            if let Some(id) = &resend {
                break id.clone();
            }
            match self.direct.front() {
                Some(id) if idle || self.steering().is_some() => break id.clone(),
                // Steering is not available: it stays in the visible queue.
                Some(_) => {
                    if let Some(id) = self.direct.pop_front() {
                        self.direct_from_queue.remove(&id);
                    }
                }
                None if idle
                    && !chat.queue_paused
                    && (self.runtime.is_some() || self.queue_started) =>
                {
                    match self.core(|core| core.chat_queue(&chat_id)) {
                        Ok(queue) => match queue.into_iter().next() {
                            Some(message) => break message.id,
                            None => {
                                self.queue_started = false;
                                return;
                            }
                        },
                        Err(_) => return,
                    }
                }
                None => {
                    if chat.queue_paused {
                        self.queue_started = false;
                    }
                    return;
                }
            }
        };
        if self.runtime.is_none() {
            let (session, origin, preamble) = native_session(&chat);
            self.open(&chat, session, origin, preamble, None);
            return;
        }
        let mut from_queue = false;
        if resend.is_some() {
            self.resend = None;
        } else if self.direct.front() == Some(&message_id) {
            self.direct.pop_front();
            from_queue = self.direct_from_queue.remove(&message_id);
        } else {
            from_queue = true;
        }
        self.dispatch(&message_id, resend.is_some(), from_queue);
    }

    /// Records the possible submission, then hands the input to the adapter. Nothing
    /// awaits between the checks, the record and the hand-off; the adapter rechecks
    /// generation and expected turn at its write.
    ///
    /// `resend` is set only for input the person asked to send again; it alone may
    /// follow an uncertain attempt. `from_queue` input had no row on screen until now.
    fn dispatch(&mut self, message_id: &str, resend: bool, from_queue: bool) {
        let Some(runtime) = &self.runtime else {
            return;
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
        let recorded = self.write(|core| {
            if resend {
                core.record_chat_resubmission(&chat, message_id, &attempt)
            } else if from_queue {
                core.record_chat_queue_submission(&chat, message_id, &attempt, intent)
            } else {
                core.record_chat_submission(&chat, message_id, &attempt, intent)
            }
        });
        let message = match recorded {
            Ok(message) => message,
            Err(error) => {
                // Storage failure is reported by `write`; a refusal is said here.
                // The queue is paused so the same refusal is not met again unasked.
                if is_refusal(&error) {
                    self.notice(format!("A message was not sent: {error}"));
                    let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
                }
                return;
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
        let context = if starts_turn {
            self.session_context.take()
        } else {
            None
        };
        if starts_turn {
            self.context_sent = context.clone();
        }
        // Context and selected history go to the harness with the input; the stored
        // message stays the person's own words.
        let text = [
            context.as_deref(),
            preamble.as_deref(),
            Some(&*message.text),
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
        };
        self.dispatching = Some(Dispatch {
            attempt,
            generation,
            starts_turn,
            preamble,
            context,
        });
        let done = self.done.clone();
        tokio::spawn(async move {
            let outcome = handle.submit(submission).await;
            let _ = done.send(Done::Dispatched { outcome });
        });
    }

    // ------------------------------------------------------------------
    // Completed adapter calls
    // ------------------------------------------------------------------

    fn on_done(&mut self, done: Done) {
        match done {
            Done::Opened {
                generation,
                result,
                context,
            } => self.on_opened(generation, result, context),
            Done::Dispatched { outcome } => self.on_dispatched(outcome),
            Done::Context {
                generation,
                context,
            } => {
                if self.refreshing != Some(generation) {
                    return;
                }
                self.refreshing = None;
                let current = self.runtime.as_ref().map(|runtime| runtime.generation);
                match context {
                    // Told with the next new turn, and only when it is news to the session.
                    Ok(Some(context))
                        if current == Some(generation)
                            && self.context_given().as_ref() != Some(&context) =>
                    {
                        self.session_context = Some(context);
                    }
                    Ok(_) => {}
                    Err(error) => self.notice(format!(
                        "ticketd could not read this Chat's changed links, so the session was not told about them: {error}"
                    )),
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
                if let Some(change) = runtime.setting_changes.iter_mut().find(|change| {
                    change.setting == setting
                        && change.value == value
                        && change.state == SettingChangeState::Sent
                }) {
                    change.state = SettingChangeState::Done(outcome.clone());
                }
                if outcome == SettingOutcome::Applied && setting == SettingKey::Permission {
                    self.record_permission(&value);
                }
            }
        }
    }

    fn on_opened(
        &mut self,
        generation: RuntimeGeneration,
        result: Result<OpenedRuntime, Problem>,
        context: Result<Option<String>, String>,
    ) {
        let Some(opening) = self
            .opening
            .take_if(|opening| opening.generation == generation)
        else {
            return;
        };
        let result = match result {
            Ok(opened) => {
                self.start_settings = StartSettings::default();
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
                            && self.context_given().as_ref() == Some(&context) => {}
                    Ok(Some(context)) => self.session_context = Some(context),
                    Ok(None) => {}
                    Err(error) => self.notice(format!(
                        "ticketd could not prepare this Chat's context, so the session started without it: {error}"
                    )),
                }
                self.problem = None;
                Ok(())
            }
            Err(problem) => {
                // A take-over: Codex records a thread id when it starts one but keeps nothing until
                // the first turn runs, so a Chat whose session never completed a turn (a run
                // taken over early) has nothing to resume: open a fresh session, with
                // the same reply, rather than a dead Chat (#387 6A1).
                if problem.kind == crate::ProblemKind::NativeHistoryUnavailable
                    && opening.origin == ChatSessionOrigin::NativeResume
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
        let Some(dispatch) = self.dispatching.take() else {
            return;
        };
        let attempt_id = dispatch.attempt.clone();
        let current = self
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.generation == dispatch.generation);
        match outcome {
            DispatchOutcome::NotSent(refusal) => {
                let detail = refusal.reason().to_owned();
                self.record(vec![ChatObservation::SubmissionNotDelivered {
                    attempt_id,
                    detail: Some(detail.clone()),
                }]);
                self.not_accepted(dispatch, current, detail);
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
                    observations.push(ChatObservation::SubmissionProcessing {
                        attempt_id,
                        turn_id,
                    });
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
        if dispatch.context.is_some() {
            self.session_context = dispatch.context;
            self.context_sent = None;
        }
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
        });
        if let Some(context) = self.context_sent.take() {
            observations.push(ChatObservation::Tool {
                tool_id: format!("{turn_id}:ticketd-context"),
                turn_id: turn_id.clone(),
                name: CONTEXT_RECORD_NAME.to_owned(),
                input: context,
                state: ChatToolState::Completed,
                output: None,
            });
        }
        let token = self.core(|core| core.change_token()).ok();
        self.active = Some(ActiveTurn {
            turn_id: turn_id.clone(),
            native: native.clone(),
            token,
            span: tracing::info_span!("chat_turn"),
        });
        self.unconfirmed_start = None;
        if self.stop_when_turn_known {
            self.stop_when_turn_known = false;
            self.interrupt();
        }
        Some(turn_id)
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
                            observations.push(ChatObservation::SubmissionProcessing {
                                attempt_id,
                                turn_id,
                            });
                        }
                    }
                    DeliveryEvidence::Processing { turn } => {
                        if let Some(turn_id) = self.turn(&turn, &mut observations) {
                            observations.push(ChatObservation::SubmissionProcessing {
                                attempt_id,
                                turn_id,
                            });
                        }
                    }
                    DeliveryEvidence::Rejected { reason } => {
                        observations.push(ChatObservation::SubmissionRejected {
                            attempt_id,
                            detail: Some(reason.clone()),
                        });
                        if unconfirmed {
                            self.stop_when_turn_known = false;
                            self.pause(ChatProblem::DispatchRefused { detail: reason });
                        }
                    }
                }
                self.record(observations);
            }
            EventKind::TurnStarted { turn } => {
                self.turn(&turn, &mut observations);
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
                    turn_id,
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
                let tool_id = format!("{run}:{}", item.0);
                let state = tool_state(status);
                let tool = ChatObservation::Tool {
                    tool_id: tool_id.clone(),
                    turn_id,
                    name: title,
                    input: detail.map(|d| d.payload().to_owned()).unwrap_or_default(),
                    state,
                    output,
                };
                self.pending_tools.retain(|(id, _)| *id != tool_id);
                let first = self
                    .runtime
                    .as_mut()
                    .is_some_and(|runtime| runtime.tools.insert(tool_id.clone()));
                if first || state != ChatToolState::Running {
                    observations.push(tool);
                    self.record(observations);
                } else {
                    // Progress of a running tool is saved with the next checkpoint.
                    self.record_if_any(observations);
                    self.pending_tools.push((tool_id, tool));
                    self.checkpoint_at
                        .get_or_insert(Instant::now() + TEXT_CHECKPOINT_INTERVAL);
                }
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
                    observations.push(ChatObservation::SubmissionProcessing {
                        attempt_id: submission.0,
                        turn_id: turn_id.clone(),
                    });
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
                        turn_id: buffer.turn_id,
                        text: buffer.text,
                        complete: true,
                    }
                }));
                if self.active.as_ref().is_some_and(|a| a.turn_id == turn_id) {
                    observations.extend(self.agent_changes());
                }
                // A turn the person stopped is theirs to have stopped, even when the
                // harness ends it as completed (Codex can, once interrupted).
                let stopped = self.stop.is_some()
                    && self.active.as_ref().is_some_and(|a| a.turn_id == turn_id);
                let ending = match outcome {
                    TurnOutcome::Completed if stopped => TurnEnding::StoppedByPerson,
                    TurnOutcome::Completed => TurnEnding::Completed,
                    TurnOutcome::Interrupted => self
                        .shut_down_for
                        .map_or(TurnEnding::StoppedByPerson, TurnEnding::StoppedByTicketd),
                    TurnOutcome::Failed(problem) => TurnEnding::failed(&problem),
                };
                observations.push(ending.observation(turn_id.clone()));
                self.record(observations);
                self.text.retain(|buffer| buffer.turn_id != turn_id);
                self.interactions.retain(|_, live| live.turn_id != turn_id);
                if self.active.as_ref().is_some_and(|a| a.turn_id == turn_id) {
                    self.active = None;
                    self.stop = None;
                    self.stop_deadline = None;
                    // Queued input does not follow a turn that did not complete. A
                    // take-over ends the agent's turn for the person, who is about to
                    // send (#387 M2): their Chat's queue is not paused for it.
                    if ending != TurnEnding::Completed
                        && self.shut_down_for != Some(StopReason::TakenOver)
                    {
                        let chat = self.chat_id.clone();
                        let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
                        self.direct.clear();
                        self.direct_from_queue.clear();
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
            turn_id,
            name: name.to_owned(),
            input,
            state,
            output: None,
        });
        self.record(observations);
    }

    /// What the agent changed in ticketd during the active turn, as the record that keeps
    /// it for the transcript; `None` when nothing in the workspace moved or none of it
    /// was the agent's.
    fn agent_changes(&mut self) -> Option<ChatObservation> {
        let active = self.active.as_ref()?;
        let (turn_id, started) = (active.turn_id.clone(), active.token);
        let now = self.core(|core| core.change_token()).ok();
        if now.is_some() && now == started {
            return None;
        }
        let chat = self.chat_id.clone();
        let changes = match self.core(|core| core.chat_turn_agent_changes(&chat, &turn_id)) {
            Ok(changes) if changes.is_empty() => return None,
            Ok(changes) => changes,
            Err(error) => {
                // The changes are in the workspace either way; only their row is missing.
                self.notice(format!(
                    "ticketd could not list what the agent changed in this turn: {error}"
                ));
                return None;
            }
        };
        Some(ChatObservation::Tool {
            tool_id: format!("{turn_id}:ticketd-changes"),
            turn_id,
            name: AGENT_CHANGES_RECORD_NAME.to_owned(),
            input: serde_json::to_string(&changes).ok()?,
            state: ChatToolState::Completed,
            output: None,
        })
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
        let native_turn = request
            .turn
            .or_else(|| self.active.as_ref().map(|active| active.native.clone()));
        let Some(turn_id) = native_turn.and_then(|turn| self.turn(&turn, &mut observations)) else {
            // It cannot be recorded, so it cannot be offered; it stays unanswered.
            self.notice(
                "The harness asked something outside a turn; it was not answered.".to_owned(),
            );
            return;
        };
        let interaction_id = format!("{run}:request:{}", request.request.0);
        let (kind, prompt, reason) = match &request.kind {
            InteractionKind::Approval {
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
        if self.show_text_at.is_some_and(|at| at <= now) {
            self.show_text();
        }
        if self.checkpoint_at.is_some_and(|at| at <= now) {
            self.record(Vec::new());
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
            // Until the session's first turn starts, whatever the process is doing.
            opening: match (&self.opening, &self.runtime) {
                _ if !working => None,
                (Some(opening), _) => Some(opening.origin),
                (None, Some(runtime)) if runtime.turns.is_empty() => Some(runtime.origin),
                _ => None,
            },
            steering: self.active.as_ref().and_then(|_| self.steering()),
            delivery_unconfirmed: self.unconfirmed_start.is_some(),
            sending: self.direct.iter().cloned().collect(),
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
