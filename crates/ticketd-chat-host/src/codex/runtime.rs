//! One live `codex app-server` process bound to a runtime generation.
//!
//! A single reader task applies every incoming frame in arrival order: replies wake
//! their callers, notifications and harness requests become events. Commands only
//! write; they never read the protocol stream themselves.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::sync::{Mutex as AsyncMutex, mpsc};
use tokio::time::timeout;

use crate::{
    Capabilities, CloseOutcome, DispatchOutcome, EVENT_BUFFER, EventKind, EventStream,
    HarnessOptions, HarnessRuntime, InteractionResponse, InterruptOutcome, InterruptRequest,
    LoginState, NativeTurnId, OpenRequest, OpenedRuntime, Problem, ProblemKind, ProviderDetail,
    Refusal, RespondOutcome, RuntimeEvent, RuntimeGeneration, SessionStart, SettingChange,
    SettingOutcome, Submission, SubmissionKind,
};

pub(super) use crate::stdio::{ChildProcess, Io, Reader, Writer};
use crate::stdio::{close_process, write_bounded};
use crate::{ADAPTER_CLOSE_TIMEOUT, WRITE_TIMEOUT};

use super::discovery;
use super::mapping::{Call, Session, rejection_reason, unknown};
use super::report::{self, Overrides};
use super::rpc::{self, Frame, MAX_FRAME_BYTES, Pending, Reply, Resolved, RpcError, StderrTail};

/// How long a loss waits to learn the exit code before reporting without one.
const EXIT_OBSERVATION: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub(super) struct Options {
    pub client_version: String,
    /// How long a command waits for its RPC reply before reporting it as written.
    pub rpc_timeout: Duration,
    /// How long `close` waits for the process to exit after its input closes.
    pub close_timeout: Duration,
    /// Ask for the models and permission profiles once the thread is open.
    pub list_settings: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
            rpc_timeout: Duration::from_secs(30),
            close_timeout: ADAPTER_CLOSE_TIMEOUT,
            list_settings: true,
        }
    }
}

struct State {
    /// Closed or lost. Set before the input pipe is dropped.
    closed: bool,
    next_id: u64,
    pending: Pending<Call>,
    session: Session,
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
    Reply(Value),
    /// The harness answered with a JSON-RPC error: an explicit refusal.
    Error(RpcError),
    /// Written, no reply in time. A tombstone remains for a late reply.
    TimedOut,
    /// Written or possibly written, then the runtime went away.
    Lost,
}

impl Connection {
    fn start(io: Io, generation: RuntimeGeneration, options: Options) -> (Arc<Self>, EventStream) {
        let connection = Arc::new(Self {
            generation,
            state: Mutex::new(State {
                closed: false,
                next_id: 1,
                pending: Pending::new(),
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

    /// Runs `prepare` and writes the frame it returns with no await between the
    /// checks and the write: the input pipe is held first, so nothing can close or
    /// write in between.
    async fn write_checked<T>(
        &self,
        prepare: impl FnOnce(&mut State) -> Result<(Value, T), Refusal>,
    ) -> Result<T, WriteFailure> {
        let mut stdin = self.stdin.lock().await;
        let (frame, prepared) = {
            let mut state = self.state();
            if state.closed {
                return Err(WriteFailure::Refused(Refusal::RuntimeClosed));
            }
            prepare(&mut state).map_err(WriteFailure::Refused)?
        };
        let bytes = rpc::encode(&frame);
        match write_bounded(&mut stdin, &self.child, &bytes, WRITE_TIMEOUT).await {
            Ok(()) => Ok(prepared),
            Err(_) => Err(WriteFailure::Lost),
        }
    }

    /// Sends one request and waits a bounded time for its reply. `prepare` makes the
    /// command's final checks and returns the request parameters.
    async fn call(
        &self,
        method: &str,
        prepare: impl FnOnce(&mut Session) -> Result<(Value, Call), Refusal>,
    ) -> CallOutcome {
        let written = self
            .write_checked(|state| {
                let (params, call) = prepare(&mut state.session)?;
                let id = state.next_id;
                state.next_id += 1;
                let receiver = state.pending.register(id, call);
                let frame = json!({"id": id, "method": method, "params": params});
                Ok((frame, (id, receiver)))
            })
            .await;
        let (id, mut receiver) = match written {
            Ok(registered) => registered,
            Err(WriteFailure::Refused(refusal)) => return CallOutcome::Refused(refusal),
            Err(WriteFailure::Lost) => return CallOutcome::Lost,
        };
        match timeout(self.options.rpc_timeout, &mut receiver).await {
            Ok(reply) => reply_outcome(reply.ok()),
            // The reply may have raced the timeout; then the receiver holds it.
            Err(_) if self.state().pending.abandon(id) => CallOutcome::TimedOut,
            Err(_) => reply_outcome(receiver.try_recv().ok()),
        }
    }

    async fn request(&self, method: &str, params: Value) -> CallOutcome {
        self.call(method, |_| Ok((params, Call::Plain))).await
    }

    /// `initialize`, then the `initialized` notification the protocol requires.
    /// Returns the platform Codex reports it runs on.
    async fn initialize(&self) -> Result<Option<String>, Problem> {
        let client = json!({
            "name": "ticketd",
            "title": "ticketd",
            "version": self.options.client_version,
        });
        match self
            .request("initialize", json!({"clientInfo": client}))
            .await
        {
            CallOutcome::Reply(reply) => {
                let platform = reply["platformOs"].as_str().map(str::to_owned);
                self.write_checked(|_| Ok((json!({"method": "initialized"}), ())))
                    .await
                    .map_err(|_| self.startup_problem("initialized", CallOutcome::Lost))?;
                Ok(platform)
            }
            failure => Err(self.startup_problem("initialize", failure)),
        }
    }

    /// Whether Codex's Windows sandbox can start, asked before an unattended run's
    /// first turn so the run fails at once instead of on its first command. A Codex
    /// that does not know the question, or cannot answer it, is not blocked: the
    /// run goes on as it would have.
    async fn windows_sandbox_problem(&self) -> Option<Problem> {
        let CallOutcome::Reply(reply) = self.request("windowsSandbox/readiness", json!(null)).await
        else {
            return None;
        };
        let status = reply["status"]
            .as_str()
            .filter(|status| *status != "ready")?;
        Some(Problem {
            kind: ProblemKind::Other,
            message: "Codex could not start its sandbox on this computer. Update Codex \
                      (`codex update`) and try again."
                .to_owned(),
            detail: Some(ProviderDetail::new("windowsSandbox/readiness", status)),
            resets_at: None,
        })
    }

    async fn open_thread(&self, request: &OpenRequest) -> Result<Capabilities, Problem> {
        let platform = self.initialize().await?;
        if request.unattended.is_some()
            && platform.as_deref() == Some("windows")
            && let Some(problem) = self.windows_sandbox_problem().await
        {
            return Err(problem);
        }
        // For a person's Chat only the working directory is passed: model, approval
        // policy, sandbox and instructions stay whatever their Codex configuration
        // says. An unattended session is told what it may do, again with every turn.
        let cwd = request.working_directory.to_string_lossy();
        let (method, mut params) = match &request.session {
            SessionStart::New => ("thread/start", json!({"cwd": cwd})),
            SessionStart::Resume(thread) => (
                "thread/resume",
                json!({"threadId": thread.0, "cwd": cwd, "excludeTurns": true}),
            ),
        };
        if let Some(unattended) = &request.unattended {
            let (thread, turn) = super::unattended_params(unattended, &request.working_directory);
            merge(&mut params, thread);
            let config = self.effective_config(&cwd).await;
            params["config"] = super::personal_tools_off(config.as_ref());
            self.state().session.turn_overrides = Some(turn);
        } else if request.taken_over {
            let config = self.effective_config(&cwd).await;
            merge(&mut params, super::own_approvals(config.as_ref()));
        }
        let result = match self.call(method, |_| Ok((params, Call::OpenThread))).await {
            CallOutcome::Reply(result) => result,
            CallOutcome::Error(error) if method == "thread/resume" => {
                return Err(resume_problem(&error));
            }
            failure => return Err(self.startup_problem(method, failure)),
        };
        let opened = result.pointer("/thread/id").and_then(Value::as_str);
        match (&request.session, opened) {
            (SessionStart::New, Some(_)) => {}
            (SessionStart::Resume(wanted), Some(opened)) if wanted.0 == opened => {}
            _ => {
                return Err(Problem {
                    kind: ProblemKind::Other,
                    message: format!("Codex answered {method} without the expected thread"),
                    detail: None,
                    resets_at: None,
                });
            }
        }
        let version = result.pointer("/thread/cliVersion").and_then(Value::as_str);
        Ok(discovery::capabilities(version))
    }

    /// The person's Codex configuration as it applies in `cwd`, or `None` when Codex
    /// would not say.
    async fn effective_config(&self, cwd: &str) -> Option<Value> {
        match self.request("config/read", json!({"cwd": cwd})).await {
            CallOutcome::Reply(mut result) => Some(result["config"].take()),
            _ => None,
        }
    }

    fn startup_problem(&self, step: &str, outcome: CallOutcome) -> Problem {
        let (message, detail) = match outcome {
            CallOutcome::Error(error) => (
                format!("Codex refused {step}: {}", rejection_reason(&error)),
                Some(ProviderDetail::new(step, &error.data.to_string())),
            ),
            CallOutcome::TimedOut => (
                format!(
                    "Codex app-server did not answer {step} within {} seconds",
                    self.options.rpc_timeout.as_secs()
                ),
                Some(ProviderDetail::new("stderr", &self.stderr.snapshot())),
            ),
            CallOutcome::Lost | CallOutcome::Refused(_) | CallOutcome::Reply(_) => (
                format!("Codex app-server stopped during {step}"),
                Some(ProviderDetail::new("stderr", &self.stderr.snapshot())),
            ),
        };
        Problem {
            kind: ProblemKind::Other,
            message,
            detail,
            resets_at: None,
        }
    }

    async fn close(&self) -> CloseOutcome {
        {
            let mut state = self.state();
            state.closed = true;
            state.pending.fail_all();
            state.session.clear_live();
        }
        // Closing its input asks app-server to shut down and stop what it started.
        match close_process(&self.stdin, &self.child, self.options.close_timeout).await {
            Some(exit_code) => CloseOutcome::Confirmed { exit_code },
            None => {
                // ponytail: only the app-server process is killed. Owning its whole
                // process tree (Windows job object, POSIX process group) is #257/#267.
                CloseOutcome::Unconfirmed {
                    reason: format!(
                        "Codex app-server did not exit within {} seconds of its input \
                         closing and was killed; tools it started may still be running",
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
        while let Ok(Some(frame)) = rpc::read_frame(&mut stdout, MAX_FRAME_BYTES).await {
            let (kinds, reply) = self.apply(frame);
            if let Some(reply) = reply {
                // Written from its own task so a full input pipe cannot stall reading.
                let connection = Arc::clone(&self);
                tokio::spawn(async move {
                    let _ = connection.write_checked(|_| Ok((reply, ()))).await;
                });
            }
            for kind in kinds {
                // A supervisor that dropped the stream still needs the pipe drained.
                let _ = events.send(self.event(kind)).await;
            }
        }

        let closing = {
            let mut state = self.state();
            let closing = state.closed;
            state.closed = true;
            state.pending.fail_all();
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

    /// Applies one frame to the session. Returns the events it produced and, for a
    /// harness request ticketd refuses, the reply to write.
    fn apply(&self, frame: Frame) -> (Vec<EventKind>, Option<Value>) {
        let mut state = self.state();
        match frame {
            Frame::Reply { id, reply } => {
                let events = match state.pending.resolve(&id) {
                    // A caller that was cancelled is no longer waiting either.
                    Resolved::Waiting(call, sender) if !sender.is_closed() => {
                        let events = state.session.reply(&call, &reply, false);
                        let _ = sender.send(reply);
                        events
                    }
                    Resolved::Waiting(call, _) | Resolved::Late(call) => {
                        state.session.reply(&call, &reply, true)
                    }
                    Resolved::Unknown => {
                        vec![unknown("reply to an unknown request", &json!({"id": id}))]
                    }
                };
                (events, None)
            }
            Frame::Request { id, method, params } => {
                state.session.server_request(&id, &method, &params)
            }
            Frame::Notification { method, params } => {
                (state.session.notification(&method, &params), None)
            }
            Frame::Malformed { bytes } => {
                let payload = json!({"bytes": bytes});
                (vec![unknown("a line that is not JSON-RPC", &payload)], None)
            }
            Frame::Oversized { bytes } => {
                let payload = json!({"bytes": bytes, "limit": MAX_FRAME_BYTES});
                (vec![unknown("a frame over the size limit", &payload)], None)
            }
        }
    }
}

fn reply_outcome(reply: Option<Reply>) -> CallOutcome {
    match reply {
        Some(Ok(result)) => CallOutcome::Reply(result),
        Some(Err(error)) => CallOutcome::Error(error),
        None => CallOutcome::Lost,
    }
}

fn resume_problem(error: &RpcError) -> Problem {
    // ponytail: recognized by wording because the protocol documents no error code
    // for a missing thread; confirm against a live app-server in #263's live checks.
    let message = error.message.to_lowercase();
    let missing = ["not found", "no rollout", "does not exist", "no such"]
        .iter()
        .any(|wording| message.contains(wording));
    Problem {
        kind: if missing {
            ProblemKind::NativeHistoryUnavailable
        } else {
            ProblemKind::Other
        },
        message: format!(
            "Codex could not resume the session: {}",
            rejection_reason(error)
        ),
        detail: Some(ProviderDetail::new(
            "thread/resume",
            &error.data.to_string(),
        )),
        resets_at: None,
    }
}

/// Adds the fields of `extra` to `params`; both are JSON objects.
fn merge(params: &mut Value, extra: Value) {
    if let (Some(params), Value::Object(extra)) = (params.as_object_mut(), extra) {
        params.extend(extra);
    }
}

/// Starts the handshake and a new or resumed thread over an already spawned process.
pub(super) async fn open_over(
    io: Io,
    request: &OpenRequest,
    options: Options,
) -> Result<OpenedRuntime, Problem> {
    let (connection, events) = Connection::start(io, request.generation, options);
    // New Chat's picks go out with the first turn, as a later change would.
    connection.state().session.reports.overrides = Overrides {
        model: request.settings.model.clone(),
        effort: request.settings.effort.clone(),
    };
    match connection.open_thread(request).await {
        Ok(capabilities) => {
            if connection.options.list_settings {
                // The lists may take Codex a network round trip: the session opens
                // without waiting, and their replies become settings as they arrive.
                let cwd = request.working_directory.to_string_lossy().into_owned();
                let lists = Arc::clone(&connection);
                tokio::spawn(async move {
                    let models = lists.call("model/list", |_| Ok((json!({}), Call::ListModels)));
                    let _ = models.await;
                    let params = json!({"cwd": cwd});
                    let profiles = lists.call("permissionProfile/list", |_| {
                        Ok((params, Call::ListPermissionProfiles))
                    });
                    let _ = profiles.await;
                });
            }
            Ok(OpenedRuntime {
                runtime: Arc::new(CodexRuntime {
                    steering: capabilities.steering.behavior().is_some(),
                    connection,
                }),
                events,
                capabilities,
            })
        }
        Err(problem) => {
            connection.close().await;
            Err(problem)
        }
    }
}

/// Asks app-server which account it would use. Reads no credential and starts no
/// thread; the process is closed afterwards.
pub(super) async fn probe_login(io: Io, options: Options) -> LoginState {
    let (connection, _events) = Connection::start(io, RuntimeGeneration(0), options);
    let read = async {
        match connection.initialize().await {
            Ok(_) => match connection
                .request("account/read", json!({"refreshToken": false}))
                .await
            {
                CallOutcome::Reply(account) => login_state(&account),
                _ => LoginState::Unknown,
            },
            Err(_) => LoginState::Unknown,
        }
    };
    // A Codex that is slow to start (its MCP servers, say) is "not checked", not a
    // check that never ends.
    let login = timeout(crate::CHECK_TIMEOUT, read)
        .await
        .unwrap_or(LoginState::Unknown);
    connection.close().await;
    login
}

/// Asks app-server for its models, each with its efforts, and its permission
/// profiles. Starts no thread and sends nothing to a model; the process is closed
/// afterwards. `Err` says why Codex did not list its models.
pub(super) async fn probe_options(io: Io, options: Options) -> Result<HarnessOptions, String> {
    let (connection, _events) = Connection::start(io, RuntimeGeneration(0), options);
    let listed = list_options(&connection).await;
    connection.close().await;
    listed
}

async fn list_options(connection: &Connection) -> Result<HarnessOptions, String> {
    connection
        .initialize()
        .await
        .map_err(|problem| problem.message)?;
    let models = list_all(connection, "model/list").await?;
    // Profiles are optional: an older Codex has no such list.
    let profiles = list_all(connection, "permissionProfile/list").await.ok();
    Ok(report::listed_options(&models, profiles.as_deref()))
}

/// Every page of a `*/list` request, following `nextCursor`.
async fn list_all(connection: &Connection, method: &str) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(cursor) => json!({"cursor": cursor}),
            None => json!({}),
        };
        let reply = match connection.request(method, params).await {
            CallOutcome::Reply(reply) => reply,
            CallOutcome::Error(error) => return Err(rejection_reason(&error)),
            CallOutcome::TimedOut => return Err(format!("Codex did not answer {method}")),
            CallOutcome::Lost | CallOutcome::Refused(_) => {
                return Err(format!("Codex app-server stopped during {method}"));
            }
        };
        let page = reply
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Codex answered {method} without a list"))?;
        all.extend(page.iter().cloned());
        match reply.get("nextCursor").and_then(Value::as_str) {
            Some(next) if cursor.as_deref() != Some(next) => cursor = Some(next.to_owned()),
            _ => return Ok(all),
        }
    }
}

pub(super) fn login_state(account: &Value) -> LoginState {
    let kind = account.pointer("/account/type").and_then(Value::as_str);
    let requires_openai_auth = account.get("requiresOpenaiAuth").and_then(Value::as_bool);
    match (kind, requires_openai_auth) {
        (Some("chatgpt"), _) => LoginState::SignedIn,
        (Some(_), _) => LoginState::NonSubscription,
        (None, Some(true)) => LoginState::SignedOut,
        (None, _) => LoginState::Unknown,
    }
}

struct CodexRuntime {
    connection: Arc<Connection>,
    /// Whether the effective capabilities include steering.
    steering: bool,
}

impl std::fmt::Debug for CodexRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexRuntime")
            .field("generation", &self.connection.generation)
            .finish_non_exhaustive()
    }
}

impl CodexRuntime {
    fn stale(&self, command: RuntimeGeneration) -> Option<Refusal> {
        let current = self.connection.generation;
        (command != current).then_some(Refusal::StaleGeneration { current })
    }
}

impl Drop for CodexRuntime {
    /// A runtime dropped without `close` still lets go of the process: closing its
    /// input ends app-server, which ends the reader.
    fn drop(&mut self) {
        self.connection.state().closed = true;
        if let Ok(mut stdin) = self.connection.stdin.try_lock() {
            *stdin = None;
        }
    }
}

#[async_trait]
impl HarnessRuntime for CodexRuntime {
    async fn submit(&self, submission: Submission) -> DispatchOutcome {
        if let Some(refusal) = self.stale(submission.generation) {
            return DispatchOutcome::NotSent(refusal);
        }
        let Submission {
            submission: id,
            kind,
            text,
            ..
        } = submission;
        let method = match kind {
            SubmissionKind::StartTurn => "turn/start",
            SubmissionKind::Steer { .. } => "turn/steer",
        };
        let outcome = self
            .connection
            .call(method, |session| {
                let thread = session.thread().ok_or(Refusal::RuntimeClosed)?.to_owned();
                let active = session.active_turn().cloned();
                let mismatch = Err(Refusal::TurnMismatch {
                    active: active.clone(),
                });
                let input = json!([{"type": "text", "text": text, "text_elements": []}]);
                let prepared = match kind {
                    SubmissionKind::StartTurn if active.is_some() => return mismatch,
                    SubmissionKind::StartTurn => {
                        let mut params =
                            json!({"threadId": thread, "clientUserMessageId": id.0, "input": input});
                        // The person's choices, for this turn and the ones after it.
                        let overrides = &session.reports.overrides;
                        if let Some(model) = &overrides.model {
                            params["model"] = json!(model);
                        }
                        if let Some(effort) = &overrides.effort {
                            params["effort"] = json!(effort);
                        }
                        // An unattended session's approvals and sandbox, again every turn.
                        if let Some(unattended) = session.turn_overrides.clone() {
                            merge(&mut params, unattended);
                        }
                        (params, Call::StartTurn(id.clone()))
                    }
                    SubmissionKind::Steer { .. } if !self.steering => {
                        return Err(Refusal::Unsupported);
                    }
                    SubmissionKind::Steer { expected_turn }
                        if active != Some(expected_turn.clone()) =>
                    {
                        return mismatch;
                    }
                    SubmissionKind::Steer { expected_turn } => (
                        json!({
                            "threadId": thread,
                            "expectedTurnId": expected_turn.0,
                            "clientUserMessageId": id.0,
                            "input": input,
                        }),
                        Call::Steer(id.clone()),
                    ),
                };
                session.submission_written(&id);
                Ok(prepared)
            })
            .await;
        match outcome {
            CallOutcome::Refused(refusal) => DispatchOutcome::NotSent(refusal),
            CallOutcome::Reply(result) => {
                let turn = result
                    .pointer("/turn/id")
                    .or_else(|| result.get("turnId"))
                    .and_then(Value::as_str);
                match turn {
                    Some(turn) => DispatchOutcome::Acknowledged {
                        turn: NativeTurnId::new(turn),
                    },
                    // Answered without naming a turn: delivered, nothing more known.
                    None => DispatchOutcome::Written,
                }
            }
            CallOutcome::Error(error) => DispatchOutcome::Rejected {
                reason: rejection_reason(&error),
            },
            CallOutcome::TimedOut => DispatchOutcome::Written,
            CallOutcome::Lost => DispatchOutcome::UnknownAfterLoss,
        }
    }

    async fn respond(&self, response: InteractionResponse) -> RespondOutcome {
        if let Some(refusal) = self.stale(response.generation) {
            return RespondOutcome::NotSent(refusal);
        }
        let written = self
            .connection
            .write_checked(|state| {
                let frame = state.session.answer(&response.request, &response.answer)?;
                Ok((frame, ()))
            })
            .await;
        match written {
            Ok(()) => RespondOutcome::Sent,
            Err(WriteFailure::Refused(refusal)) => RespondOutcome::NotSent(refusal),
            Err(WriteFailure::Lost) => RespondOutcome::UnknownAfterLoss,
        }
    }

    async fn interrupt(&self, request: InterruptRequest) -> InterruptOutcome {
        if let Some(refusal) = self.stale(request.generation) {
            return InterruptOutcome::NotSent(refusal);
        }
        let outcome = self
            .connection
            .call("turn/interrupt", |session| {
                let thread = session.thread().ok_or(Refusal::RuntimeClosed)?;
                if session.active_turn() != Some(&request.expected_turn) {
                    return Err(Refusal::TurnMismatch {
                        active: session.active_turn().cloned(),
                    });
                }
                let params = json!({"threadId": thread, "turnId": request.expected_turn.0});
                session.interrupt_asked(&request.expected_turn);
                Ok((params, Call::Plain))
            })
            .await;
        match outcome {
            CallOutcome::Refused(refusal) => InterruptOutcome::NotSent(refusal),
            CallOutcome::Reply(_) => InterruptOutcome::Acknowledged,
            CallOutcome::Error(_) | CallOutcome::TimedOut | CallOutcome::Lost => {
                InterruptOutcome::Unconfirmed
            }
        }
    }

    /// Codex takes model and effort as overrides on `turn/start`, so a change is kept
    /// and goes out with the next turn; the thread keeps it for the turns after.
    async fn change_setting(&self, change: SettingChange) -> SettingOutcome {
        if self.stale(change.generation).is_some() {
            return SettingOutcome::Refused {
                reason: "the session it was meant for has ended".to_owned(),
            };
        }
        let mut state = self.connection.state();
        if state.closed {
            return SettingOutcome::Refused {
                reason: "the session has ended".to_owned(),
            };
        }
        if state
            .session
            .reports
            .override_setting(change.setting, &change.value)
        {
            SettingOutcome::Applied
        } else {
            SettingOutcome::Unsupported
        }
    }

    async fn close(&self) -> CloseOutcome {
        self.connection.close().await
    }
}
