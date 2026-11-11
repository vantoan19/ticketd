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

use ticketd_core::{
    Chat, ChatInteractionKind, ChatInteractionState, ChatMessage, ChatObservation,
    ChatSessionOrigin, ChatSubmissionIntent, ChatToolState, ChatTurnState, Error, Workspace,
};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until, timeout, timeout_at};
use uuid::Uuid;

use crate::host::{
    Activity, Board, CLOSE_TIMEOUT, CONTEXT_RECORD_NAME, ChatLive, ChatProblem, ChatView,
    ContextSource, HostError, INTERRUPT_TIMEOUT, LiveInteraction, ResumeMode, SNAPSHOT_ITEMS,
    SendMode, StopState, TEXT_CHECKPOINT_INTERVAL, TEXT_UPDATE_INTERVAL, WorkspaceOpener,
    is_refusal,
};
use crate::subscription::{self, ChatUpdate, Publisher};
use crate::{
    ApprovalDecision, Capabilities, CloseOutcome, DeliveryEvidence, DispatchOutcome, EventKind,
    HarnessAdapter, HarnessRuntime, InteractionAnswer, InteractionKind, InteractionRequest,
    InteractionResolution, InteractionResponse, InterruptOutcome, InterruptRequest,
    NativeRequestId, NativeSessionId, NativeTurnId, NoticeKind, OpenRequest, OpenedRuntime,
    Problem, RespondOutcome, RuntimeEvent, RuntimeGeneration, SessionStart, Submission,
    SubmissionId, SubmissionKind, Subscription, ToolStatus, TurnOutcome,
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
    Respond {
        interaction_id: String,
        answer: InteractionAnswer,
        reply: Reply<()>,
    },
    Resume {
        mode: ResumeMode,
        reply: Reply<()>,
    },
    Trash(Reply<Option<String>>),
    Changed,
    /// Stop the runtime and end the supervisor; replies with unconfirmed cleanup.
    Shutdown(oneshot::Sender<Option<String>>),
}

/// The result of an adapter call that ran in its own task.
enum Done {
    Opened {
        generation: RuntimeGeneration,
        result: Result<OpenedRuntime, Problem>,
    },
    Dispatched {
        outcome: DispatchOutcome,
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
}

struct Opening {
    generation: RuntimeGeneration,
    origin: ChatSessionOrigin,
    preamble: Option<String>,
    context: Option<String>,
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
}

struct LiveRequest {
    generation: RuntimeGeneration,
    request: NativeRequestId,
    turn_id: String,
    kind: InteractionKind,
    answering: bool,
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

pub(crate) struct Supervisor {
    chat_id: String,
    open_workspace: WorkspaceOpener,
    adapter: Option<Arc<dyn HarnessAdapter>>,
    context: Option<ContextSource>,
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
    active: Option<ActiveTurn>,
    /// Input the person sent for immediate dispatch, ahead of the queue.
    direct: VecDeque<String>,
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
    ) -> mpsc::Sender<Command> {
        let (sender, commands) = mpsc::channel(64);
        let (done, finished) = mpsc::unbounded_channel();
        let supervisor = Self {
            chat_id: chat.id.clone(),
            open_workspace,
            adapter,
            context,
            board,
            commands,
            done,
            finished,
            generations: 0,
            runtime: None,
            opening: None,
            dispatching: None,
            unconfirmed_start: None,
            active: None,
            direct: VecDeque::new(),
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
        };
        tokio::spawn(supervisor.run());
        sender
    }

    async fn run(mut self) {
        loop {
            let timer = [self.show_text_at, self.checkpoint_at, self.stop_deadline]
                .into_iter()
                .flatten()
                .min();
            tokio::select! {
                command = self.commands.recv() => match command {
                    Some(Command::Shutdown(reply)) => {
                        self.shutting_down = true;
                        let unconfirmed = self.stop_runtime("ticketd stopped this Chat").await;
                        self.publish();
                        self.board.report(&self.chat_id, None);
                        let _ = reply.send(unconfirmed);
                        return;
                    }
                    Some(command) => self.on_command(command).await,
                    None => {
                        self.shutting_down = true;
                        self.stop_runtime("ticketd stopped this Chat").await;
                        self.board.report(&self.chat_id, None);
                        return;
                    }
                },
                Some(done) = self.finished.recv() => self.on_done(done),
                event = next_event(&mut self.runtime) => self.on_event(event),
                () = sleep_until_some(timer) => self.on_timer(),
            }
            if self.storage_failed.is_some() && (self.runtime.is_some() || self.opening.is_some()) {
                // Controlled shutdown: nothing more can be recorded, so nothing more runs.
                if let Some(reason) = self.stop_runtime("Chat storage failed").await {
                    self.notice(format!("Stopping the harness was not confirmed: {reason}"));
                }
            }
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
        call(&mut (self.open_workspace)()?)
    }

    /// A core write. A failure that is not a refusal of this one request means history
    /// can no longer be kept, so the Chat stops admitting and dispatching work.
    fn write<T>(
        &mut self,
        call: impl FnOnce(&mut Workspace) -> Result<T, Error>,
    ) -> Result<T, Error> {
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
        self.problem = Some(problem);
    }

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    async fn on_command(&mut self, command: Command) {
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
                if result.is_ok()
                    && matches!(self.problem, Some(ChatProblem::DispatchRefused { .. }))
                {
                    self.problem = None;
                }
                let _ = reply.send(result.map(|_| ()).map_err(HostError::from));
            }
            Command::Respond {
                interaction_id,
                answer,
                reply,
            } => self.respond(interaction_id, answer, reply),
            Command::Resume { mode, reply } => self.resume(mode, reply).await,
            Command::Trash(reply) => {
                let chat = self.chat_id.clone();
                let result = match self.write(|core| core.set_chat_trashed(&chat, true)) {
                    Ok(_) => Ok(self.stop_runtime("the Chat was moved to the trash").await),
                    Err(error) => Err(error.into()),
                };
                let _ = reply.send(result);
            }
            Command::Changed | Command::Shutdown(_) => {}
        }
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
            self.core(|core| core.mark_chat_contact_lost(Some(&chat), "Chat storage failed"))
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
            self.direct.push_back(message.id.clone());
        }
        Ok(message)
    }

    /// Stop pauses the queue first, so nothing unsent is dispatched whatever the
    /// harness then does, and keeps all unsent input.
    fn request_stop(&mut self) -> Result<(), HostError> {
        let chat = self.chat_id.clone();
        self.write(|core| core.set_chat_queue_paused(&chat, true))?;
        self.direct.clear();
        if self.active.is_some() {
            self.interrupt();
        } else if self.unconfirmed_start.is_some()
            || self.dispatching.as_ref().is_some_and(|d| d.starts_turn)
        {
            // The input may already be with the harness: interrupt its turn once known.
            self.stop_when_turn_known = true;
            self.stop = Some(StopState::Requested);
        }
        Ok(())
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
            .filter(|live| Some(live.generation) == current && !live.answering);
        let (Some(live), Some(runtime)) = (live, &self.runtime) else {
            let _ = reply.send(Err(HostError::InteractionExpired));
            return;
        };
        live.answering = true;
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
        if self.runtime.is_some() {
            self.stop_runtime("replaced by an explicit resume").await;
        }
        let chat_id = self.chat_id.clone();
        let chat = match self.core(|core| core.chat(&chat_id)) {
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
                },
                native_resume: false,
            });
            if let Some(reply) = reply {
                let _ = reply.send(Err(HostError::HarnessUnavailable(chat.harness.clone())));
            }
            return;
        };
        // A resumed native session already has it; a new one starts without it.
        let context = (origin != ChatSessionOrigin::NativeResume)
            .then(|| self.context.as_ref().and_then(|source| source(&chat.id)))
            .flatten();
        self.generations += 1;
        let generation = RuntimeGeneration(self.generations);
        let request = OpenRequest {
            generation,
            working_directory: PathBuf::from(&chat.execution_folder),
            session,
        };
        self.opening = Some(Opening {
            generation,
            origin,
            preamble,
            context,
            reply,
        });
        let done = self.done.clone();
        tokio::spawn(async move {
            let result = adapter.open(request).await;
            let _ = done.send(Done::Opened { generation, result });
        });
    }

    /// Stops the owned runtime with bounded cleanup and records that contact ended.
    /// Returns why cleanup could not be confirmed, if it could not.
    async fn stop_runtime(&mut self, detail: &str) -> Option<String> {
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
            self.runtime_gone(detail);
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
        self.runtime_gone(detail);
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
    fn runtime_gone(&mut self, detail: &str) {
        let chat = self.chat_id.clone();
        let _ = self.write(|core| core.mark_chat_contact_lost(Some(&chat), detail));
        self.active = None;
        self.unconfirmed_start = None;
        self.interactions.clear();
        self.text.clear();
        self.pending_tools.clear();
        self.direct.clear();
        self.stop = None;
        self.stop_deadline = None;
        self.stop_when_turn_known = false;
    }

    fn on_loss(&mut self, detail: String) {
        self.record(Vec::new());
        self.runtime = None;
        self.runtime_gone(&detail);
        self.pause(ChatProblem::RuntimeLost { detail });
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
            || self.unconfirmed_start.is_some()
        {
            return;
        }
        let chat_id = self.chat_id.clone();
        let Ok(chat) = self.core(|core| core.chat(&chat_id)) else {
            return;
        };
        if chat.trashed {
            self.direct.clear();
            return;
        }
        let idle = self.active.is_none();
        let message_id = loop {
            match self.direct.front() {
                Some(id) if idle || self.steering().is_some() => break id.clone(),
                // Steering is not available: it stays in the visible queue.
                Some(_) => {
                    self.direct.pop_front();
                }
                None if idle && !chat.queue_paused && self.runtime.is_some() => {
                    match self.core(|core| core.chat_queue(&chat_id)) {
                        Ok(queue) => match queue.into_iter().next() {
                            Some(message) => break message.id,
                            None => return,
                        },
                        Err(_) => return,
                    }
                }
                None => return,
            }
        };
        if self.runtime.is_none() {
            let (session, origin, preamble) = native_session(&chat);
            self.open(&chat, session, origin, preamble, None);
            return;
        }
        if self.direct.front() == Some(&message_id) {
            self.direct.pop_front();
        }
        self.dispatch(&message_id);
    }

    /// Records the possible submission, then hands the input to the adapter. Nothing
    /// awaits between the checks, the record and the hand-off; the adapter rechecks
    /// generation and expected turn at its write.
    fn dispatch(&mut self, message_id: &str) {
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
        let Ok(message) =
            self.write(|core| core.record_chat_submission(&chat, message_id, &attempt, intent))
        else {
            return;
        };
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
            Done::Opened { generation, result } => self.on_opened(generation, result),
            Done::Dispatched { outcome } => self.on_dispatched(outcome),
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
        }
    }

    fn on_opened(&mut self, generation: RuntimeGeneration, result: Result<OpenedRuntime, Problem>) {
        let Some(opening) = self
            .opening
            .take_if(|opening| opening.generation == generation)
        else {
            return;
        };
        let result = match result {
            Ok(opened) => {
                self.runtime = Some(Runtime {
                    generation,
                    run: Uuid::new_v4().to_string(),
                    handle: opened.runtime,
                    events: opened.events,
                    capabilities: opened.capabilities,
                    origin: opening.origin,
                    turns: HashSet::new(),
                    tools: HashSet::new(),
                });
                if opening.preamble.is_some() {
                    self.preamble = opening.preamble;
                }
                if opening.context.is_some() {
                    self.session_context = opening.context;
                }
                self.problem = None;
                Ok(())
            }
            Err(problem) => {
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
                let detail = format!("{refusal:?}");
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
                self.record(vec![ChatObservation::SubmissionUncertain {
                    attempt_id,
                    detail: Some("contact was lost before the harness replied".to_owned()),
                }]);
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
        self.active = Some(ActiveTurn {
            turn_id: turn_id.clone(),
            native: native.clone(),
        });
        self.unconfirmed_start = None;
        if self.stop_when_turn_known {
            self.stop_when_turn_known = false;
            self.interrupt();
        }
        Some(turn_id)
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
                let tool = ChatObservation::Tool {
                    tool_id: tool_id.clone(),
                    turn_id,
                    name: title,
                    input: detail.map(|d| d.payload().to_owned()).unwrap_or_default(),
                    state: match status {
                        ToolStatus::Running => ChatToolState::Running,
                        ToolStatus::Succeeded => ChatToolState::Completed,
                        ToolStatus::Failed => ChatToolState::Failed,
                    },
                    output,
                };
                self.pending_tools.retain(|(id, _)| *id != tool_id);
                let first = self
                    .runtime
                    .as_mut()
                    .is_some_and(|runtime| runtime.tools.insert(tool_id.clone()));
                if first || status != ToolStatus::Running {
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
                self.interactions.remove(&interaction_id);
                self.record(vec![ChatObservation::InteractionResolved {
                    interaction_id,
                    state: match resolution {
                        InteractionResolution::Answered => ChatInteractionState::Answered,
                        InteractionResolution::Withdrawn => ChatInteractionState::Expired,
                    },
                    response: None,
                }]);
            }
            EventKind::TurnEnded {
                turn,
                outcome,
                submissions,
            } => {
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
                let (state, detail) = match outcome {
                    TurnOutcome::Completed => (ChatTurnState::Completed, None),
                    TurnOutcome::Interrupted => (ChatTurnState::Interrupted, None),
                    TurnOutcome::Failed(problem) => (ChatTurnState::Failed, Some(problem.message)),
                };
                observations.push(ChatObservation::TurnEnded {
                    turn_id: turn_id.clone(),
                    state,
                    detail,
                });
                self.record(observations);
                self.text.retain(|buffer| buffer.turn_id != turn_id);
                self.interactions.retain(|_, live| live.turn_id != turn_id);
                if self.active.as_ref().is_some_and(|a| a.turn_id == turn_id) {
                    self.active = None;
                    self.stop = None;
                    self.stop_deadline = None;
                    if state != ChatTurnState::Completed {
                        // Queued input does not follow a turn that did not complete.
                        let chat = self.chat_id.clone();
                        let _ = self.write(|core| core.set_chat_queue_paused(&chat, true));
                        self.direct.clear();
                    }
                }
            }
            EventKind::RuntimeLost {
                exit_code,
                diagnostics,
            } => {
                let exit =
                    exit_code.map_or_else(String::new, |code| format!(" (exit code {code})"));
                self.on_loss(format!("the harness process ended{exit}: {diagnostics}"));
            }
            // The harness keeps the turn; nothing is retried or ended here.
            EventKind::Notice { kind, message, .. } => match kind {
                NoticeKind::Retrying | NoticeKind::Warning => self.notice(message),
                // ponytail: effective settings are not stored or shown yet.
                NoticeKind::EffectiveSettings => {}
            },
            EventKind::Unknown { summary, .. } => self.notice(summary),
        }
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
        let (kind, prompt) = match &request.kind {
            InteractionKind::Approval { description, .. } => {
                (ChatInteractionKind::Approval, description.clone())
            }
            InteractionKind::Question { questions } => (
                ChatInteractionKind::Question,
                questions
                    .iter()
                    .map(|question| question.prompt.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        };
        observations.push(ChatObservation::InteractionRequested {
            interaction_id: interaction_id.clone(),
            turn_id: turn_id.clone(),
            kind,
            native_request_id: Some(request.request.0.clone()),
            prompt,
        });
        self.record(observations);
        self.interactions.insert(
            interaction_id,
            LiveRequest {
                generation,
                request: request.request,
                turn_id,
                kind: request.kind,
                answering: false,
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
            if self.active.is_some() && self.stop.is_some() {
                self.stop = Some(StopState::Unconfirmed);
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

    fn notice(&mut self, text: String) {
        for subscriber in &self.subscribers {
            subscriber.push(ChatUpdate::Notice(text.clone()));
        }
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
            steering: self.active.as_ref().and_then(|_| self.steering()),
            delivery_unconfirmed: self.unconfirmed_start.is_some(),
            interactions: self
                .interactions
                .iter()
                .filter(|(_, live)| !live.answering)
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
        }
    }

    /// Publishes committed changes since the last call, then live state if it changed.
    fn publish(&mut self) {
        self.board.report(&self.chat_id, Some(self.live()));
        self.subscribers.retain(Publisher::open);
        if self.subscribers.is_empty() {
            return;
        }
        let chat = self.chat_id.clone();
        loop {
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
                    if !more {
                        break;
                    }
                }
                Ok(ticketd_core::ChatCatchUp::Resync) => {
                    for subscriber in self.subscribers.drain(..) {
                        subscriber.resync();
                    }
                    return;
                }
                // Storage trouble is reported by the write that hits it.
                Err(_) => break,
            }
        }
        let live = self.live();
        if self.last_live.as_ref() != Some(&live) {
            for subscriber in &self.subscribers {
                subscriber.push(ChatUpdate::Live(live.clone()));
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
