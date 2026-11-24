//! Codex commands and observations for one `codex app-server` process.
//!
//! The shared runtime coordinates the active turn and live requests. Codex handles
//! the app-server handshake, thread settings, and command and observation mapping.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::timeout;

use crate::{
    ADAPTER_CLOSE_TIMEOUT, Capabilities, CloseOutcome, DispatchOutcome, EventKind, EventStream,
    HarnessOptions, HarnessRuntime, InteractionResponse, InterruptOutcome, InterruptRequest,
    LoginState, NativeTurnId, OpenRequest, OpenedRuntime, Problem, ProblemKind, ProviderDetail,
    Refusal, RespondOutcome, RuntimeGeneration, SessionStart, SettingChange, SettingOutcome,
    Submission, SubmissionKind,
};

use crate::json_rpc::{
    self, CallOutcome, Connection, Incoming, MAX_FRAME_BYTES, Peer, Reply, Response, RpcError,
};
use crate::stdio::Io;

use super::discovery;
use super::mapping::{Call, Session, rejection_reason, unknown};
use super::report::{self, Overrides};
use super::ticket_tool::{self, TicketTool};

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

#[derive(Default)]
struct CodexPeer {
    session: Session,
    /// Set for a thread that can call the ticketd CLI as its own tool.
    ticket_tool: Option<Arc<TicketTool>>,
}

impl Peer for CodexPeer {
    type Call = Call;

    fn replied(&mut self, call: Call, reply: &Reply, late: bool) -> Vec<EventKind> {
        self.session.reply(&call, reply, late)
    }

    fn received(&mut self, incoming: Incoming) -> (Vec<EventKind>, Option<Response>) {
        let events = match incoming {
            Incoming::Request {
                id,
                method,
                mut params,
            } => {
                if method == ticket_tool::CALL_METHOD
                    && let Some(tool) = &self.ticket_tool
                {
                    let ours = self.session.thread().is_some_and(|thread| {
                        !thread.trim().is_empty() && params["threadId"].as_str() == Some(thread)
                    });
                    let called = params["tool"].as_str() == Some(ticket_tool::NAME)
                        && params["namespace"].is_null();
                    let response = if ours && called {
                        let input = params.get_mut("arguments").map_or(Value::Null, Value::take);
                        tool.answer(id, input)
                    } else {
                        Response::Immediate(json!({"id": id, "error": {
                            "code": -32601,
                            "message": "ticketd offers only its own `ticketd` tool on this thread",
                        }}))
                    };
                    return (Vec::new(), Some(response));
                }
                let (events, response) = self.session.server_request(&id, &method, &params);
                return (events, response.map(Response::Immediate));
            }
            Incoming::Notification { method, params } => {
                self.session.notification(&method, &params)
            }
            Incoming::UnknownReply { id } => {
                vec![unknown("reply to an unknown request", &json!({"id": id}))]
            }
            Incoming::Malformed { bytes } => {
                vec![unknown(
                    "a line that is not JSON-RPC",
                    &json!({"bytes": bytes}),
                )]
            }
            Incoming::Oversized { bytes } => {
                let payload = json!({"bytes": bytes, "limit": MAX_FRAME_BYTES});
                vec![unknown("a frame over the size limit", &payload)]
            }
        };
        (events, None)
    }

    fn disconnected(&mut self) {
        if let Some(tool) = &self.ticket_tool {
            tool.close();
        }
        self.session.disconnected();
    }
}

struct AppServer {
    rpc: Arc<Connection<CodexPeer>>,
    options: Options,
}

impl AppServer {
    fn start(io: Io, generation: RuntimeGeneration, options: Options) -> (Arc<Self>, EventStream) {
        let (rpc, events, _) = Connection::start(
            io,
            CodexPeer::default(),
            generation,
            json_rpc::Options {
                harness: &ticketd_core::harnesses::CODEX,
                include_version: false,
                reply_timeout: options.rpc_timeout,
            },
        );
        (Arc::new(Self { rpc, options }), events)
    }

    async fn call(
        &self,
        method: &str,
        prepare: impl FnOnce(&mut Session) -> Result<(Value, Call), Refusal>,
    ) -> CallOutcome {
        self.rpc
            .call(method, |peer| prepare(&mut peer.session))
            .await
    }

    async fn request(&self, method: &str, params: Value) -> CallOutcome {
        self.call(method, |_| Ok((params, Call::Plain))).await
    }

    /// `initialize`, then the `initialized` notification the protocol requires.
    /// Returns the platform Codex reports it runs on. `experimental` opts into the
    /// experimental API, which declaring a tool on the thread needs; a person's Chat
    /// and the probes do not use it.
    async fn initialize(&self, experimental: bool) -> Result<Option<String>, Problem> {
        let client = json!({
            "name": "ticketd",
            "title": "ticketd",
            "version": self.options.client_version,
        });
        let mut params = json!({"clientInfo": client});
        if experimental {
            params["capabilities"] = json!({"experimentalApi": true});
        }
        match self.request("initialize", params).await {
            CallOutcome::Reply(reply) => {
                let platform = reply["platformOs"].as_str().map(str::to_owned);
                self.rpc
                    .write(|_| Ok(json!({"method": "initialized"})))
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
        let platform = self.initialize(request.unattended.is_some()).await?;
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
            let mut overrides = super::personal_tools_off(config.as_ref());
            merge(&mut overrides, super::switch_overrides(&unattended.tools));
            params["config"] = overrides;
            // A resumed thread keeps its environments: the request has no field for them.
            if matches!(request.session, SessionStart::New)
                && super::has_no_environment(&unattended.tools)
            {
                params["environments"] = json!([]);
            }
            self.rpc.state().peer.session.turn_overrides = Some(turn);
            if request.ticketd_cli.is_some() {
                // ticketd's own tool is how the agent reaches its tickets: Codex's
                // shell may be off and its sandbox read-only.
                // A resumed thread keeps the tool it was started with.
                if matches!(request.session, SessionStart::New) {
                    params["dynamicTools"] = json!([ticket_tool::spec()]);
                }
                params["developerInstructions"] = json!(ticket_tool::INSTRUCTIONS);
            }
        } else if request.taken_over {
            let config = self.effective_config(&cwd).await;
            merge(&mut params, super::own_approvals(config.as_ref()));
        }
        // A Chat taken over from a run resumes a thread that was started with the
        // tool, which Codex may still offer its model: answer it, as the person's
        // own Chat (no run).
        if let Some(cli) = &request.ticketd_cli
            && (request.unattended.is_some() || request.taken_over)
        {
            self.rpc.state().peer.ticket_tool = Some(Arc::new(TicketTool::new(
                cli.clone(),
                request.working_directory.clone(),
                request.chat_id.clone(),
                request.unattended.as_ref().map(|run| run.run_id.clone()),
            )));
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
                Some(ProviderDetail::new("stderr", &self.rpc.stderr())),
            ),
            CallOutcome::Lost | CallOutcome::Refused(_) | CallOutcome::Reply(_) => (
                format!("Codex app-server stopped during {step}"),
                Some(ProviderDetail::new("stderr", &self.rpc.stderr())),
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
        // Closing app-server's input makes it end the session and exit.
        self.rpc
            .close(
                self.options.close_timeout,
                "Codex app-server",
                "tools it started may still be running",
            )
            .await
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

/// The permission choice a person's Chat runs with when opened again, from its record:
/// the one recorded (`reopen_with`), else how its thread last opened (Full access when
/// that never asked and had no sandbox). `None` without a record.
pub(super) fn recorded_permission(recorded: Option<&str>) -> Option<String> {
    let recorded: Value = serde_json::from_str(recorded?).ok()?;
    if let Some(choice) = recorded[super::report::REOPEN_WITH]["permission"]
        .as_str()
        .filter(|choice| [super::report::OWN_SETTINGS, super::report::FULL_ACCESS].contains(choice))
    {
        return Some(choice.to_owned());
    }
    let opened = recorded.get("approvalPolicy").is_some() || recorded.get("sandbox").is_some();
    let full =
        recorded["approvalPolicy"] == "never" && recorded["sandbox"]["type"] == "dangerFullAccess";
    opened.then(|| {
        if full {
            super::report::FULL_ACCESS
        } else {
            super::report::OWN_SETTINGS
        }
        .to_owned()
    })
}

/// `recorded` with `choice` as the one a session opened for the Chat again applies;
/// the person's own approval policy and sandbox (`own`) stay as recorded.
pub(super) fn record_choice(recorded: Option<&str>, choice: &str) -> Option<String> {
    let mut recorded: Value = serde_json::from_str(recorded?).ok()?;
    let reopen = recorded
        .as_object_mut()?
        .entry(super::report::REOPEN_WITH)
        .or_insert_with(|| json!({}));
    if !reopen.is_object() {
        *reopen = json!({});
    }
    reopen["permission"] = json!(choice);
    Some(recorded.to_string())
}

/// The person's own approval policy and sandbox, as the Chat's last session recorded
/// them with its settings (`own`).
fn recorded_own(recorded: Option<&str>) -> Option<Value> {
    let recorded: Value = serde_json::from_str(recorded?).ok()?;
    let own = recorded.get("own")?;
    (own.get("approvalPolicy")
        .is_some_and(|policy| !policy.is_null())
        && own.get("sandboxPolicy").is_some_and(Value::is_object))
    .then(|| own.clone())
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
    let (connection, events) = AppServer::start(io, request.generation, options);
    {
        let reports = &mut connection.rpc.state().peer.session.reports;
        // New Chat's picks go out with the first turn, as a later change would.
        reports.overrides = Overrides {
            model: request.settings.model.clone(),
            effort: request.settings.effort.clone(),
            permission: request.settings.permission.clone(),
        };
        // A person's own settings: what the Chat's last session recorded when its
        // thread is resumed, since that thread may still have Full access, or else
        // the thread's reply. A new thread's reply is always theirs. A Chat taken
        // over from a run has its approvals set back to the person's at this resume,
        // and its record is the agent's.
        reports.persons = request.unattended.is_none();
        if reports.persons && !request.taken_over {
            if matches!(request.session, SessionStart::Resume(_)) {
                reports.own = recorded_own(request.recorded_settings.as_deref());
            }
            // The choice the Chat ran with applies again, as it was shown.
            if reports.overrides.permission.is_none() {
                reports.overrides.permission =
                    recorded_permission(request.recorded_settings.as_deref());
            }
        }
    }
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
    let (connection, _events) = AppServer::start(io, RuntimeGeneration(0), options);
    let read = async {
        match connection.initialize(false).await {
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
    let (connection, _events) = AppServer::start(io, RuntimeGeneration(0), options);
    let listed = list_options(&connection).await;
    connection.close().await;
    listed
}

async fn list_options(connection: &AppServer) -> Result<HarnessOptions, String> {
    connection
        .initialize(false)
        .await
        .map_err(|problem| problem.message)?;
    let models = list_all(connection, "model/list").await?;
    // Profiles are optional: an older Codex has no such list.
    let profiles = list_all(connection, "permissionProfile/list").await.ok();
    Ok(report::listed_options(&models, profiles.as_deref()))
}

/// Every page of a `*/list` request, following `nextCursor`.
async fn list_all(connection: &AppServer, method: &str) -> Result<Vec<Value>, String> {
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
    connection: Arc<AppServer>,
    /// Whether the effective capabilities include steering.
    steering: bool,
}

impl std::fmt::Debug for CodexRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexRuntime")
            .field("generation", &self.connection.rpc.generation())
            .finish_non_exhaustive()
    }
}

impl Drop for CodexRuntime {
    /// A runtime dropped without `close` still lets go of the process: closing its
    /// input ends app-server, which ends the reader.
    fn drop(&mut self) {
        self.connection.rpc.close_on_drop();
    }
}

#[async_trait]
impl HarnessRuntime for CodexRuntime {
    async fn submit(&self, submission: Submission) -> DispatchOutcome {
        let Submission {
            submission: id,
            generation,
            kind,
            text,
        } = submission;
        let method = match kind {
            SubmissionKind::StartTurn => "turn/start",
            SubmissionKind::Steer { .. } => "turn/steer",
        };
        let prepare = |peer: &mut CodexPeer| {
            let session = &mut peer.session;
            let thread = session.thread().ok_or(Refusal::RuntimeClosed)?.to_owned();
            session.runtime.check_submission(&kind, self.steering)?;
            let input = json!([{"type": "text", "text": text, "text_elements": []}]);
            let prepared = match kind {
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
                    if let Some(permissions) = session.reports.permission_params() {
                        merge(&mut params, permissions);
                    }
                    // An unattended session's approvals and sandbox, again every turn.
                    if let Some(unattended) = session.turn_overrides.clone() {
                        merge(&mut params, unattended);
                    }
                    (params, Call::StartTurn(id.clone()))
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
            session.runtime.submission_written(&id);
            Ok(prepared)
        };
        self.connection
            .rpc
            .submit(
                generation,
                method,
                prepare,
                |result| {
                    result
                        .pointer("/turn/id")
                        .or_else(|| result.get("turnId"))
                        .and_then(Value::as_str)
                        .map(NativeTurnId::new)
                },
                rejection_reason,
            )
            .await
    }

    async fn respond(&self, response: InteractionResponse) -> RespondOutcome {
        self.connection
            .rpc
            .respond(response.generation, |peer| {
                peer.session.answer(&response.request, &response.answer)
            })
            .await
    }

    async fn interrupt(&self, request: InterruptRequest) -> InterruptOutcome {
        self.connection
            .rpc
            .interrupt(request.generation, "turn/interrupt", |peer| {
                let session = &mut peer.session;
                let thread = session.thread().ok_or(Refusal::RuntimeClosed)?;
                let params = json!({"threadId": thread, "turnId": request.expected_turn.0});
                session.runtime.mark_interrupt(&request.expected_turn)?;
                Ok((params, Call::Plain))
            })
            .await
    }

    /// Codex takes model and effort as overrides on `turn/start`, so a change is kept
    /// and goes out with the next turn; the thread keeps it for the turns after.
    async fn change_setting(&self, change: SettingChange) -> SettingOutcome {
        if self
            .connection
            .rpc
            .check_generation(change.generation)
            .is_err()
        {
            return SettingOutcome::Refused {
                reason: "the session it was meant for has ended".to_owned(),
            };
        }
        let mut state = self.connection.rpc.state();
        if state.is_closed() {
            return SettingOutcome::Refused {
                reason: "the session has ended".to_owned(),
            };
        }
        if state
            .peer
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_admitted_ticketd_call_cannot_start_after_the_runtime_closes() {
        let directory = tempfile::tempdir().unwrap();
        for explicit_close in [true, false] {
            let (mut app_server, io) = crate::scripted::pipes();
            let (connection, _events) =
                AppServer::start(io, RuntimeGeneration(1), Options::default());
            let answer = {
                let mut state = connection.rpc.state();
                let peer = &mut state.peer;
                peer.ticket_tool = Some(Arc::new(TicketTool::new(
                    std::env::current_exe().unwrap(),
                    directory.path().to_owned(),
                    "chat-1".into(),
                    None,
                )));
                peer.replied(
                    Call::OpenThread,
                    &Ok(json!({"thread": {"id": "thr_1"}})),
                    false,
                );
                let (_, response) = peer.received(Incoming::Request {
                    id: json!("call-1"),
                    method: ticket_tool::CALL_METHOD.to_owned(),
                    params: json!({"threadId": "thr_1", "tool": "ticketd",
                        "arguments": {"arguments": ["--list"]}}),
                });
                let Some(Response::Deferred(answer)) = response else {
                    panic!("the open runtime should admit the call");
                };
                answer
            };
            let runtime = CodexRuntime {
                connection,
                steering: false,
            };
            if explicit_close {
                let (outcome, ()) = tokio::join!(runtime.close(), async {
                    assert!(app_server.stdin_closed().await);
                    app_server.exit(0);
                });
                assert_eq!(outcome, CloseOutcome::Confirmed { exit_code: Some(0) });
            } else {
                drop(runtime);
                assert!(app_server.stdin_closed().await);
            }
            // The deferred work was admitted before shutdown, but its first poll
            // happens after shutdown. Running the CLI would list this test binary's tests.
            let reply = answer.await;
            assert_eq!(reply["id"], "call-1");
            assert_eq!(reply["result"]["success"], false);
            assert!(
                reply["result"]["contentItems"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("closed")
            );
            if !explicit_close {
                app_server.exit(0);
            }
        }
    }
}
