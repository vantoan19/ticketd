//! One live bridge process bound to a runtime generation.
//!
//! A single reader task applies every bridge event in arrival order: events that
//! settle a command wake its caller, the rest become contract events. Commands only
//! write; they never read the protocol stream themselves.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::time::timeout;

use crate::stdio::{
    ChildProcess, Io, Line, Reader, StderrTail, Writer, close_process, read_line, write_bounded,
};
use crate::{ADAPTER_CLOSE_TIMEOUT, WRITE_TIMEOUT};
use crate::{
    Capabilities, CloseOutcome, DeliveryEvidence, DispatchOutcome, EVENT_BUFFER, EventKind,
    EventStream, HarnessOptions, HarnessRuntime, Inspection, InteractionResponse, InterruptOutcome,
    InterruptRequest, NativeRequestId, NoticeKind, OpenRequest, OpenedRuntime, Problem,
    ProblemKind, ProviderDetail, Refusal, RespondOutcome, RuntimeEvent, RuntimeGeneration,
    SessionStart, SettingChange, SettingKey, SettingOutcome, Submission, SubmissionId,
    SubmissionKind,
};

use super::session::{Session, unknown};

/// The bridge protocol version this adapter speaks.
const PROTOCOL: u64 = 1;
/// Largest bridge event kept. Provisional; a tool result carries up to 1,048,576
/// characters of output in one event.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// How long a loss waits to learn the exit code before reporting without one.
const EXIT_OBSERVATION: Duration = Duration::from_secs(2);
const MAX_REASON_CHARS: usize = 500;

#[derive(Debug, Clone)]
pub(super) struct Options {
    /// How long a command waits for the event that settles it.
    pub reply_timeout: Duration,
    /// How long `close` waits for the bridge to exit after its input closes.
    pub close_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            reply_timeout: Duration::from_secs(30),
            close_timeout: ADAPTER_CLOSE_TIMEOUT,
        }
    }
}

/// What a written command was for, kept until the bridge settles it.
#[derive(Debug)]
enum Kind {
    /// `hello`, `inspect` and refusals ticketd sends on its own.
    Plain,
    Open,
    Submit(SubmissionId),
    Respond(NativeRequestId),
    Interrupt,
    Setting,
}

/// How the bridge settled a command. A dropped sender means the runtime was lost.
#[derive(Debug)]
enum Reply {
    Event(Value),
    /// `command_rejected`: the command had no effect.
    Rejected(String),
    /// The session ended while the bridge still held the input.
    NotDelivered,
}

struct Command {
    kind: Kind,
    /// `None` when nobody waits: an answer, or a submission whose caller timed out.
    waiter: Option<oneshot::Sender<Reply>>,
}

struct State {
    /// Closed or lost. Set before the input pipe is dropped.
    closed: bool,
    /// The session ended on its own and the loss was reported; later traffic is void.
    lost: bool,
    next_id: u64,
    commands: HashMap<String, Command>,
    session: Session,
}

impl State {
    /// Drops commands nobody waits for once the bridge shows they went through, so the
    /// map holds only what can still be settled or refused.
    fn forget_settled(&mut self, name: &str, event: &Value) {
        match name {
            "request_resolved" | "request_cancelled" => {
                let request = event["request_id"].as_str().unwrap_or_default();
                self.commands.retain(
                    |_, command| !matches!(&command.kind, Kind::Respond(id) if id.0 == request),
                );
            }
            // A submission the turn took can no longer be refused.
            "input_processing" | "turn_result" => {
                let taken = event["submission_ids"].as_array();
                let taken =
                    |id: &SubmissionId| taken.into_iter().flatten().any(|taken| *taken == id.0);
                self.commands.retain(|_, command| {
                    command.waiter.is_some()
                        || !matches!(&command.kind, Kind::Submit(id) if taken(id))
                });
            }
            _ => {}
        }
    }

    /// Hands `reply` to the caller of the first command matching `wanted`.
    fn settle(&mut self, wanted: impl Fn(&str, &Kind) -> bool, reply: Reply) -> bool {
        let found = self
            .commands
            .iter()
            .find(|(id, command)| wanted(id, &command.kind))
            .map(|(id, _)| id.clone());
        let waiter = found
            .and_then(|id| self.commands.remove(&id))
            .and_then(|command| command.waiter);
        waiter.is_some_and(|waiter| waiter.send(reply).is_ok())
    }
}

struct Connection {
    generation: RuntimeGeneration,
    state: Mutex<State>,
    stdin: AsyncMutex<Option<Writer>>,
    child: AsyncMutex<Box<dyn ChildProcess>>,
    stderr: StderrTail,
    options: Options,
}

enum WriteFailure {
    /// A check failed; nothing was written.
    Refused(Refusal),
    /// The write failed part-way or the pipe is broken; delivery is unknown.
    Lost,
}

enum CallOutcome {
    Refused(Refusal),
    Event(Value),
    Rejected(String),
    NotDelivered,
    /// Written, not settled in time.
    TimedOut,
    /// Written or possibly written, then the runtime went away.
    Lost,
}

/// What one line from the bridge led to.
#[derive(Default)]
struct Applied {
    events: Vec<EventKind>,
    /// A refusal ticketd sends on its own, as a `respond` command without its id.
    decline: Option<Value>,
    /// The session ended on its own; the bridge is no longer needed.
    lost: bool,
}

impl Connection {
    fn start(io: Io, generation: RuntimeGeneration, options: Options) -> (Arc<Self>, EventStream) {
        let connection = Arc::new(Self {
            generation,
            state: Mutex::new(State {
                closed: false,
                lost: false,
                next_id: 1,
                commands: HashMap::new(),
                session: Session::default(),
            }),
            stdin: AsyncMutex::new(Some(io.stdin)),
            child: AsyncMutex::new(io.child),
            stderr: StderrTail::default(),
            options,
        });
        if let Some(stderr) = io.stderr {
            tokio::spawn(connection.stderr.clone().drain(stderr));
        }
        let (sender, events) = mpsc::channel(EVENT_BUFFER);
        tokio::spawn(Arc::clone(&connection).read(io.stdout, sender));
        (connection, events)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `prepare` and writes the command it returns with no await between the
    /// checks and the write: the input pipe is held first, so nothing can close or
    /// write in between.
    async fn write(
        &self,
        waits: bool,
        prepare: impl FnOnce(&mut Session) -> Result<(Value, Kind), Refusal>,
    ) -> Result<(String, Option<oneshot::Receiver<Reply>>), WriteFailure> {
        let mut stdin = self.stdin.lock().await;
        let (line, id, receiver) = {
            let mut state = self.state();
            if state.closed {
                return Err(WriteFailure::Refused(Refusal::RuntimeClosed));
            }
            let (mut command, kind) = prepare(&mut state.session).map_err(WriteFailure::Refused)?;
            let id = format!("c{}", state.next_id);
            state.next_id += 1;
            command["id"] = json!(id);
            let (waiter, receiver) = if waits {
                let (sender, receiver) = oneshot::channel();
                (Some(sender), Some(receiver))
            } else {
                (None, None)
            };
            // A refusal ticketd sends on its own has nothing to settle and nobody waiting.
            if waits || !matches!(kind, Kind::Plain) {
                state.commands.insert(id.clone(), Command { kind, waiter });
            }
            (format!("{command}\n"), id, receiver)
        };
        match write_bounded(&mut stdin, &self.child, line.as_bytes(), WRITE_TIMEOUT).await {
            Ok(()) => Ok((id, receiver)),
            Err(_) => Err(WriteFailure::Lost),
        }
    }

    /// Writes one command and waits a bounded time for the event that settles it.
    async fn call(
        &self,
        prepare: impl FnOnce(&mut Session) -> Result<(Value, Kind), Refusal>,
    ) -> CallOutcome {
        let (id, mut receiver) = match self.write(true, prepare).await {
            Ok((id, Some(receiver))) => (id, receiver),
            Ok((_, None)) | Err(WriteFailure::Lost) => return CallOutcome::Lost,
            Err(WriteFailure::Refused(refusal)) => return CallOutcome::Refused(refusal),
        };
        let settled = |reply: Option<Reply>| match reply {
            Some(Reply::Event(event)) => CallOutcome::Event(event),
            Some(Reply::Rejected(reason)) => CallOutcome::Rejected(reason),
            Some(Reply::NotDelivered) => CallOutcome::NotDelivered,
            None => CallOutcome::Lost,
        };
        match timeout(self.options.reply_timeout, &mut receiver).await {
            Ok(reply) => settled(reply.ok()),
            Err(_) => {
                let mut state = self.state();
                match state.commands.get_mut(&id) {
                    // A late refusal of a submission is still evidence about it.
                    Some(command) if matches!(command.kind, Kind::Submit(_)) => {
                        command.waiter = None;
                    }
                    Some(_) => {
                        state.commands.remove(&id);
                    }
                    // The reply raced the timeout; the receiver holds it.
                    None => return settled(receiver.try_recv().ok()),
                }
                CallOutcome::TimedOut
            }
        }
    }

    fn startup_problem(&self, step: &str, outcome: CallOutcome) -> Problem {
        let message = match outcome {
            CallOutcome::Rejected(reason) => format!("The Claude bridge refused {step}: {reason}"),
            CallOutcome::TimedOut => format!(
                "The Claude bridge did not answer {step} within {} seconds",
                self.options.reply_timeout.as_secs()
            ),
            _ => format!("The Claude bridge stopped during {step}"),
        };
        Problem {
            kind: ProblemKind::Other,
            message,
            detail: Some(ProviderDetail::new("stderr", &self.stderr.snapshot())),
            resets_at: None,
        }
    }

    /// Confirms the bridge speaks this protocol, then has it report the installed
    /// Claude Code against the version its SDK was built for. Starts no session.
    async fn handshake(&self, claude: &Path) -> Result<Value, Problem> {
        let hello = json!({"cmd": "hello", "protocol": PROTOCOL});
        match self.call(|_| Ok((hello, Kind::Plain))).await {
            CallOutcome::Event(hello) if hello["protocol"] == PROTOCOL => {}
            failure => return Err(self.startup_problem("hello", failure)),
        }
        let inspect = json!({"cmd": "inspect", "claude_executable": claude.to_string_lossy()});
        match self.call(|_| Ok((inspect, Kind::Plain))).await {
            CallOutcome::Event(inspection) => Ok(inspection),
            failure => Err(self.startup_problem("inspect", failure)),
        }
    }

    async fn open_session(
        &self,
        request: &OpenRequest,
        claude: &Path,
    ) -> Result<Capabilities, Problem> {
        let inspection = self.handshake(claude).await?;
        let capabilities = match super::verdict(claude, &inspection) {
            Inspection::Installed { capabilities, .. } => capabilities,
            Inspection::Incompatible { requirement, .. } => {
                return Err(Problem {
                    kind: ProblemKind::IncompatibleVersion,
                    message: format!("ticketd needs {requirement}."),
                    detail: None,
                    resets_at: None,
                });
            }
            Inspection::ProbeFailed { reason } => {
                return Err(Problem {
                    kind: ProblemKind::Other,
                    message: format!("Could not run {}: {reason}", claude.display()),
                    detail: None,
                    resets_at: None,
                });
            }
            Inspection::NotInstalled => return Err(super::not_installed()),
        };
        // Only the folder, the executable, the session to resume and the person's
        // picks are passed. Tools, instructions and anything not picked stay Claude
        // Code's own.
        let mut open = json!({
            "cmd": "open",
            "generation": self.generation.0,
            "cwd": request.working_directory.to_string_lossy(),
            "claude_executable": claude.to_string_lossy(),
        });
        // New Chat's picks, when the person made them. The bridge accepts no mode
        // that skips permissions.
        let picks = &request.settings;
        for (field, value) in [
            ("model", &picks.model),
            ("effort", &picks.effort),
            ("permission_mode", &picks.permission),
        ] {
            if let Some(value) = value {
                open[field] = json!(value);
            }
        }
        let resuming = match &request.session {
            SessionStart::New => false,
            SessionStart::Resume(session) => {
                open["resume_session_id"] = json!(session.0);
                true
            }
        };
        match self.call(|_| Ok((open, Kind::Open))).await {
            CallOutcome::Event(event) if event["event"] == "session_initialized" => {
                Ok(capabilities)
            }
            CallOutcome::Event(event) => Err(open_problem(&event, resuming)),
            failure => Err(self.startup_problem("open", failure)),
        }
    }

    async fn close(&self) -> CloseOutcome {
        {
            let mut state = self.state();
            state.closed = true;
            state.commands.clear();
            state.session.clear_live();
        }
        // Closing its input makes the bridge end the session, which terminates
        // Claude Code, and exit.
        match close_process(&self.stdin, &self.child, self.options.close_timeout).await {
            Some(exit_code) => CloseOutcome::Confirmed { exit_code },
            None => {
                // ponytail: only the bridge process is killed. Owning its whole
                // process tree (Windows job object, POSIX process group) is #257/#267.
                CloseOutcome::Unconfirmed {
                    reason: format!(
                        "The Claude bridge did not exit within {} seconds of its input \
                         closing and was killed; Claude Code and tools it started may \
                         still be running",
                        self.options.close_timeout.as_secs()
                    ),
                }
            }
        }
    }

    /// The protocol reader. Waiting to hand an event to the supervisor is the only
    /// place it blocks other than reading.
    async fn read(self: Arc<Self>, stdout: Reader, events: mpsc::Sender<RuntimeEvent>) {
        let mut stdout = BufReader::new(stdout);
        while let Ok(Some(line)) = read_line(&mut stdout, MAX_FRAME_BYTES).await {
            let applied = self.apply(line);
            if let Some(decline) = applied.decline {
                // Written from its own task so a full input pipe cannot stall reading.
                let connection = Arc::clone(&self);
                tokio::spawn(async move {
                    let _ = connection
                        .write(false, |_| Ok((decline, Kind::Plain)))
                        .await;
                });
            }
            for kind in applied.events {
                // A supervisor that dropped the stream still needs the pipe drained.
                let _ = events.send(self.event(kind)).await;
            }
            if applied.lost {
                // The bridge exits once its input closes; its output is drained
                // until then.
                *self.stdin.lock().await = None;
            }
        }

        let closing = {
            let mut state = self.state();
            let closing = state.closed;
            state.closed = true;
            state.commands.clear();
            state.session.clear_live();
            closing
        };
        if closing {
            return;
        }
        *self.stdin.lock().await = None;
        let exit_code = timeout(EXIT_OBSERVATION, async {
            self.child.lock().await.wait().await
        })
        .await
        .unwrap_or(None);
        let lost = EventKind::RuntimeLost {
            exit_code,
            diagnostics: self.stderr.readable(),
        };
        let _ = events.send(self.event(lost)).await;
    }

    fn event(&self, kind: EventKind) -> RuntimeEvent {
        RuntimeEvent {
            generation: self.generation,
            kind,
        }
    }

    fn apply(&self, line: Line) -> Applied {
        let mut state = self.state();
        if state.lost {
            return Applied::default();
        }
        let events = |events| Applied {
            events,
            ..Applied::default()
        };
        let line = match line {
            Line::Complete(line) => line,
            Line::Oversized { bytes } => {
                let payload = json!({"bytes": bytes, "limit": MAX_FRAME_BYTES});
                return events(vec![unknown(
                    "a bridge event over the size limit",
                    "oversized",
                    &payload,
                )]);
            }
        };
        let event = serde_json::from_slice::<Value>(&line).unwrap_or(Value::Null);
        let Some(name) = event["event"].as_str().filter(|_| event["v"] == PROTOCOL) else {
            let payload = json!({"bytes": line.len()});
            return events(vec![unknown(
                "a line that is not a bridge event",
                "malformed",
                &payload,
            )]);
        };
        if !event["generation"].is_null() && event["generation"] != self.generation.0 {
            let payload = json!({"event": name, "generation": event["generation"]});
            return events(vec![unknown(
                "a bridge event for another session",
                name,
                &payload,
            )]);
        }
        let id = event["id"].as_str().unwrap_or_default();
        let by_id = |command: &str, _: &Kind| command == id;
        match name {
            "hello" | "inspection" | "options" | "interrupt_result" | "setting_result" => {
                state.settle(by_id, Reply::Event(event.clone()));
            }
            // The SDK object exists; Claude Code has not answered yet.
            "session_opened" => {}
            "session_initialized" => {
                state.settle(
                    |_, kind| matches!(kind, Kind::Open),
                    Reply::Event(event.clone()),
                );
                return events(state.session.initialized(&event));
            }
            "input_handed_to_sdk" => {
                let submission = event["submission_id"].as_str().unwrap_or_default();
                let wanted =
                    |_: &str, kind: &Kind| matches!(kind, Kind::Submit(id) if id.0 == submission);
                state.settle(wanted, Reply::Event(event.clone()));
            }
            "sdk_error" => {
                let message = reason(&event["error"]["message"]);
                let settled = match event["source"].as_str() {
                    Some("initialize") => state.settle(
                        |_, kind| matches!(kind, Kind::Open),
                        Reply::Event(event.clone()),
                    ),
                    Some("interrupt") => state.settle(
                        |_, kind| matches!(kind, Kind::Interrupt),
                        Reply::Rejected(message.clone()),
                    ),
                    _ => false,
                };
                if !settled {
                    return events(vec![EventKind::Notice {
                        turn: state.session.active_turn().cloned(),
                        kind: NoticeKind::Warning,
                        message: format!("Claude Code reported a failure: {message}"),
                        detail: None,
                    }]);
                }
            }
            "command_rejected" => return events(rejected(&mut state, id, &event)),
            "session_ended" => return self.session_ended(&mut state, &event),
            name => {
                state.forget_settled(name, &event);
                return match state.session.event(name, &event) {
                    Some((events, decline)) => Applied {
                        events,
                        decline: decline.map(|mut decline| {
                            decline["cmd"] = json!("respond");
                            decline["generation"] = json!(self.generation.0);
                            decline
                        }),
                        lost: false,
                    },
                    None => events(vec![unknown(
                        "a bridge event ticketd does not know",
                        name,
                        &event,
                    )]),
                };
            }
        }
        Applied::default()
    }

    /// The session is over. Unless ticketd closed it, that is a loss: Claude Code
    /// exited or the SDK failed, and the bridge has already cancelled live requests.
    fn session_ended(&self, state: &mut State, event: &Value) -> Applied {
        let unresolved = event["unresolved_inputs"].as_array();
        for (_, command) in state.commands.drain() {
            let reply = match &command.kind {
                Kind::Open => Reply::Event(event.clone()),
                // Input the SDK never took was not delivered. Anything further
                // along is unknown: the waiter observes a dropped sender.
                Kind::Submit(submission) => {
                    let held = unresolved.into_iter().flatten().any(|input| {
                        input["submission_id"] == submission.0 && input["evidence"] == "none"
                    });
                    if !held {
                        continue;
                    }
                    Reply::NotDelivered
                }
                _ => continue,
            };
            if let Some(waiter) = command.waiter {
                let _ = waiter.send(reply);
            }
        }
        state.session.clear_live();
        if state.closed {
            return Applied::default();
        }
        state.closed = true;
        state.lost = true;
        let cause = match event["error"]["message"].as_str() {
            Some(message) => format!(": {message}"),
            None => String::new(),
        };
        let diagnostics = format!(
            "The Claude Code session ended ({}){cause}\n{}",
            event["reason"].as_str().unwrap_or("unknown"),
            self.stderr.readable()
        );
        Applied {
            // The bridge's own exit code says nothing about Claude Code.
            events: vec![EventKind::RuntimeLost {
                exit_code: None,
                diagnostics: diagnostics.trim().to_owned(),
            }],
            decline: None,
            lost: true,
        }
    }
}

fn reason(message: &Value) -> String {
    let message = message.as_str().unwrap_or("no reason given");
    message.chars().take(MAX_REASON_CHARS).collect()
}

/// `command_rejected`: the command had no effect.
fn rejected(state: &mut State, id: &str, event: &Value) -> Vec<EventKind> {
    let code = event["code"].as_str().unwrap_or("rejected");
    let reason = format!("{code}: {}", reason(&event["message"]));
    let unexpected = || {
        let payload = json!({"code": code});
        vec![unknown(
            "the bridge rejected a command",
            "command_rejected",
            &payload,
        )]
    };
    // What the refusal was about is already gone: a request resolved or cancelled
    // while its answer was on the way is forgotten before the answer is refused.
    let gone = matches!(code, "stale_request" | "stale_generation" | "no_session");
    let Some(command) = state.commands.remove(id) else {
        return if gone { Vec::new() } else { unexpected() };
    };
    let waiter_gone = |waiter: Option<oneshot::Sender<Reply>>, reason: String| {
        waiter.is_none_or(|waiter| waiter.send(Reply::Rejected(reason)).is_err())
    };
    match command.kind {
        Kind::Respond(request) => match state.session.answer_refused(&request, gone) {
            Some(withdrawn) => vec![withdrawn],
            None if gone => Vec::new(),
            None => unexpected(),
        },
        Kind::Submit(submission) => {
            if waiter_gone(command.waiter, reason.clone()) {
                return vec![EventKind::SubmissionEvidence {
                    submission,
                    evidence: DeliveryEvidence::Rejected { reason },
                }];
            }
            Vec::new()
        }
        Kind::Plain | Kind::Open | Kind::Interrupt | Kind::Setting => {
            waiter_gone(command.waiter, reason);
            Vec::new()
        }
    }
}

fn open_problem(event: &Value, resuming: bool) -> Problem {
    let message = reason(&event["error"]["message"]);
    // ponytail: recognized by wording because the SDK documents no error code for a
    // missing session; confirm against a live Claude Code in #264's live checks.
    let lowered = message.to_lowercase();
    let missing = resuming
        && ["no conversation found", "not found", "does not exist"]
            .iter()
            .any(|wording| lowered.contains(wording));
    Problem {
        kind: if missing {
            ProblemKind::NativeHistoryUnavailable
        } else {
            ProblemKind::Other
        },
        message: format!("Claude Code could not start the session: {message}"),
        detail: Some(ProviderDetail::new(
            event["event"].as_str().unwrap_or("open"),
            &event["error"].to_string(),
        )),
        resets_at: None,
    }
}

/// Opens a new or resumed session over an already spawned bridge.
pub(super) async fn open_over(
    io: Io,
    request: &OpenRequest,
    claude: &Path,
    options: Options,
) -> Result<OpenedRuntime, Problem> {
    let (connection, events) = Connection::start(io, request.generation, options);
    match connection.open_session(request, claude).await {
        Ok(capabilities) => Ok(OpenedRuntime {
            runtime: Arc::new(ClaudeRuntime { connection }),
            events,
            capabilities,
        }),
        Err(problem) => {
            connection.close().await;
            Err(problem)
        }
    }
}

/// Has the bridge report on the installed Claude Code. Starts no session and reads
/// no credential; the bridge is closed afterwards.
pub(super) async fn probe(io: Io, claude: &Path, options: Options) -> Inspection {
    let (connection, _events) = Connection::start(io, RuntimeGeneration(0), options);
    let inspection = match connection.handshake(claude).await {
        Ok(inspection) => super::verdict(claude, &inspection),
        Err(problem) => Inspection::ProbeFailed {
            reason: problem.message,
        },
    };
    connection.close().await;
    inspection
}

/// Has the bridge ask the installed Claude Code which models it offers, through an
/// SDK session that is given no prompt and is closed once it has initialized: nothing
/// reaches a model. The bridge is closed afterwards.
pub(super) async fn probe_options(
    io: Io,
    claude: &Path,
    options: Options,
) -> Result<HarnessOptions, String> {
    let (connection, _events) = Connection::start(io, RuntimeGeneration(0), options);
    let listed = async {
        connection
            .handshake(claude)
            .await
            .map_err(|problem| problem.message)?;
        let ask = json!({"cmd": "options", "claude_executable": claude.to_string_lossy()});
        match connection.call(|_| Ok((ask, Kind::Plain))).await {
            CallOutcome::Event(event) => match event["error"].as_str() {
                Some(error) => Err(format!("Claude Code did not list its models: {error}")),
                None => Ok(super::report::listed_options(
                    event["models"].as_array().map_or(&[][..], Vec::as_slice),
                )),
            },
            CallOutcome::Rejected(reason) => Err(reason),
            _ => Err("the Claude bridge did not answer".to_owned()),
        }
    }
    .await;
    connection.close().await;
    listed
}

struct ClaudeRuntime {
    connection: Arc<Connection>,
}

impl std::fmt::Debug for ClaudeRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClaudeRuntime")
            .field("generation", &self.connection.generation)
            .finish_non_exhaustive()
    }
}

impl ClaudeRuntime {
    fn stale(&self, command: RuntimeGeneration) -> Option<Refusal> {
        let current = self.connection.generation;
        (command != current).then_some(Refusal::StaleGeneration { current })
    }
}

impl Drop for ClaudeRuntime {
    /// A runtime dropped without `close` still lets go of the process: closing its
    /// input ends the bridge, which ends the reader.
    fn drop(&mut self) {
        self.connection.state().closed = true;
        if let Ok(mut stdin) = self.connection.stdin.try_lock() {
            *stdin = None;
        }
    }
}

#[async_trait]
impl HarnessRuntime for ClaudeRuntime {
    async fn submit(&self, submission: Submission) -> DispatchOutcome {
        if let Some(refusal) = self.stale(submission.generation) {
            return DispatchOutcome::NotSent(refusal);
        }
        // The bridge can add input to a running turn, but that path has never run
        // against a live Claude Code, so it is not offered.
        if matches!(submission.kind, SubmissionKind::Steer { .. }) {
            return DispatchOutcome::NotSent(Refusal::Unsupported);
        }
        let generation = self.connection.generation.0;
        let outcome = self
            .connection
            .call(|session| {
                if let Some(active) = session.active_turn() {
                    return Err(Refusal::TurnMismatch {
                        active: Some(active.clone()),
                    });
                }
                let command = json!({
                    "cmd": "submit",
                    "generation": generation,
                    "submission_id": submission.submission.0,
                    "text": submission.text,
                });
                Ok((command, Kind::Submit(submission.submission)))
            })
            .await;
        match outcome {
            CallOutcome::Refused(refusal) => DispatchOutcome::NotSent(refusal),
            // The SDK took the input, or nothing was heard in time. Neither is an
            // acknowledgment; processing and the result arrive as events.
            CallOutcome::Event(_) | CallOutcome::TimedOut => DispatchOutcome::Written,
            CallOutcome::Rejected(reason) => DispatchOutcome::Rejected { reason },
            CallOutcome::NotDelivered => DispatchOutcome::NotSent(Refusal::RuntimeClosed),
            CallOutcome::Lost => DispatchOutcome::UnknownAfterLoss,
        }
    }

    async fn respond(&self, response: InteractionResponse) -> RespondOutcome {
        if let Some(refusal) = self.stale(response.generation) {
            return RespondOutcome::NotSent(refusal);
        }
        let generation = self.connection.generation.0;
        let written = self
            .connection
            .write(false, |session| {
                let decision = session.answer(&response.request, &response.answer)?;
                let command = json!({
                    "cmd": "respond",
                    "generation": generation,
                    "request_id": response.request.0,
                    "decision": decision,
                });
                Ok((command, Kind::Respond(response.request.clone())))
            })
            .await;
        match written {
            Ok(_) => RespondOutcome::Sent,
            Err(WriteFailure::Refused(refusal)) => RespondOutcome::NotSent(refusal),
            Err(WriteFailure::Lost) => RespondOutcome::UnknownAfterLoss,
        }
    }

    async fn interrupt(&self, request: InterruptRequest) -> InterruptOutcome {
        if let Some(refusal) = self.stale(request.generation) {
            return InterruptOutcome::NotSent(refusal);
        }
        let generation = self.connection.generation.0;
        let outcome = self
            .connection
            .call(|session| {
                if session.active_turn() != Some(&request.expected_turn) {
                    return Err(Refusal::TurnMismatch {
                        active: session.active_turn().cloned(),
                    });
                }
                session.interrupt_written();
                let command = json!({"cmd": "interrupt", "generation": generation});
                Ok((command, Kind::Interrupt))
            })
            .await;
        match outcome {
            CallOutcome::Refused(refusal) => InterruptOutcome::NotSent(refusal),
            CallOutcome::Event(_) => InterruptOutcome::Acknowledged,
            CallOutcome::Rejected(_)
            | CallOutcome::NotDelivered
            | CallOutcome::TimedOut
            | CallOutcome::Lost => InterruptOutcome::Unconfirmed,
        }
    }

    /// Claude Code applies a change from its next request; the supervisor sends it
    /// only between turns, so a turn never changes model part-way.
    async fn change_setting(&self, change: SettingChange) -> SettingOutcome {
        if self.stale(change.generation).is_some() {
            return SettingOutcome::Refused {
                reason: "the session it was meant for has ended".to_owned(),
            };
        }
        let kind = match change.setting {
            SettingKey::Model => "model",
            SettingKey::Effort => "effort",
            SettingKey::Permission => "permission",
        };
        let command = json!({
            "cmd": "set_setting",
            "generation": self.connection.generation.0,
            "setting": {"kind": kind, "value": change.value},
        });
        match self.connection.call(|_| Ok((command, Kind::Setting))).await {
            CallOutcome::Event(event) if event["outcome"] == "applied" => SettingOutcome::Applied,
            CallOutcome::Event(event) => SettingOutcome::Refused {
                reason: reason(&event["message"]),
            },
            CallOutcome::Rejected(reason) => SettingOutcome::Refused { reason },
            CallOutcome::Refused(_) | CallOutcome::NotDelivered => SettingOutcome::Refused {
                reason: "the session has ended".to_owned(),
            },
            CallOutcome::TimedOut | CallOutcome::Lost => SettingOutcome::Unconfirmed,
        }
    }

    async fn close(&self) -> CloseOutcome {
        self.connection.close().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripted::pipes;

    #[tokio::test(start_paused = true)]
    async fn commands_nobody_waits_for_are_forgotten_once_the_bridge_shows_they_went_through() {
        let (_peer, io) = pipes();
        let (connection, _events) = Connection::start(io, RuntimeGeneration(7), Options::default());
        let event = |event: Value| Line::Complete(event.to_string().into_bytes());

        for round in 0..3 {
            let request = NativeRequestId::new(format!("request-{round}"));
            let answer = json!({"cmd": "respond", "request_id": request.0});
            let written = connection.write(false, |_| Ok((answer, Kind::Respond(request.clone()))));
            assert!(written.await.is_ok());
            let decline = json!({"cmd": "respond", "request_id": "undisplayable"});
            assert!(
                connection
                    .write(false, |_| Ok((decline, Kind::Plain)))
                    .await
                    .is_ok()
            );
            let submission = SubmissionId::new(format!("submission-{round}"));
            let submit = json!({"cmd": "submit", "submission_id": submission.0});
            let written =
                connection.write(false, |_| Ok((submit, Kind::Submit(submission.clone()))));
            assert!(written.await.is_ok());
            assert_eq!(connection.state().commands.len(), 2);

            connection.apply(event(json!({
                "v": PROTOCOL, "event": "request_resolved", "generation": 7, "request_id": request.0,
            })));
            connection.apply(event(json!({
                "v": PROTOCOL, "event": "input_processing", "generation": 7,
                "submission_ids": [submission.0],
            })));

            assert!(connection.state().commands.is_empty());
        }
    }
}
