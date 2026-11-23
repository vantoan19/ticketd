//! Synchronous connector calls backed by asynchronous, connection-scoped pipes.
//! A single runtime thread serves the whole registry and owns no Workspace.

use std::{
    collections::{HashMap, VecDeque},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc as blocking,
    },
    thread,
    time::Duration,
};

use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::{
    runtime::{Builder, Handle},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, interval, sleep_until},
};

use super::{
    CONTRACT_VERSION, Launch, SourceError,
    logs::ExtensionLog,
    process::{EXIT_POLL, Fault, LINE_LIMIT, Process},
    redaction::Redactions,
    wire::{Call, Description, JsonRpc, Request},
};

const CONTRACT_VERSIONS: &[u32] = &[CONTRACT_VERSION];
const CRASH_LIMIT: usize = 5;
const CRASH_WINDOW: Duration = Duration::from_secs(3 * 60);

#[derive(Clone, Copy)]
pub(super) struct Limits {
    pub handshake: Duration,
    pub request: Duration,
    pub idle: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            handshake: Duration::from_secs(5),
            request: Duration::from_secs(30),
            idle: Duration::from_secs(5 * 60),
        }
    }
}

#[derive(Default)]
pub(super) struct Host {
    state: Mutex<State>,
    next: AtomicU64,
    limits: Limits,
    log_dir: Mutex<Option<PathBuf>>,
}

#[derive(Default)]
struct State {
    runtime: Option<Runtime>,
    stopped: bool,
    connections: HashMap<ConnectionKey, (Arc<Endpoint>, JoinHandle<()>)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ConnectionKey {
    provider: String,
    id: Option<String>,
}

struct Runtime {
    handle: Handle,
    closing: watch::Sender<()>,
    sessions: oneshot::Sender<Vec<JoinHandle<()>>>,
    thread: thread::JoinHandle<()>,
}

impl Runtime {
    fn start() -> io::Result<Self> {
        let (closing, _) = watch::channel(());
        let (sessions, finished) = oneshot::channel::<Vec<JoinHandle<()>>>();
        let (ready, started) = blocking::sync_channel(1);
        let thread = thread::Builder::new()
            .name("source-extensions".into())
            .spawn(move || {
                let runtime = match Builder::new_current_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                if ready.send(Ok(runtime.handle().clone())).is_ok() {
                    runtime.block_on(async {
                        if let Ok(sessions) = finished.await {
                            for task in sessions {
                                let _ = task.await;
                            }
                        }
                    });
                }
            })?;
        let handle = started
            .recv()
            .map_err(|_| io::Error::other("source extension runtime did not start"))??;
        Ok(Self {
            handle,
            closing,
            sessions,
            thread,
        })
    }
}

#[derive(Clone)]
pub(super) struct Definition {
    pub launch: Arc<Launch>,
    pub cached: Option<Arc<Description>>,
}

enum Message {
    Call {
        definition: Definition,
        request: EncodedRequest,
        reply: blocking::SyncSender<Result<Value, SourceError>>,
    },
    Retry(blocking::SyncSender<()>),
}

struct Endpoint {
    serial: Mutex<()>,
    sender: mpsc::Sender<Message>,
}

impl Host {
    #[cfg(test)]
    pub(super) fn with_limits(limits: Limits) -> Self {
        Self {
            limits,
            state: Mutex::default(),
            next: AtomicU64::new(0),
            log_dir: Mutex::default(),
        }
    }

    pub(super) fn set_log_dir(&self, path: &Path) {
        let mut log_dir = self
            .log_dir
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *log_dir = (!path.as_os_str().is_empty()).then(|| path.to_path_buf());
    }

    fn endpoint(
        &self,
        definition: &Definition,
        id: Option<&str>,
    ) -> Result<Arc<Endpoint>, SourceError> {
        let key = ConnectionKey {
            provider: definition.launch.manifest.id.clone(),
            id: id.map(str::to_owned),
        };
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return Err(SourceError::NotSent(
                "the source extension host is shutting down".into(),
            ));
        }
        if let Some((endpoint, _)) = state.connections.get(&key) {
            return Ok(endpoint.clone());
        }
        let runtime = match &state.runtime {
            Some(runtime) => runtime,
            None => state.runtime.insert(Runtime::start().map_err(|error| {
                SourceError::NotSent(format!(
                    "could not start the source extension host: {error}"
                ))
            })?),
        };
        let closing = runtime.closing.subscribe();
        let (sender, messages) = mpsc::channel(1);
        let log = self
            .log_dir
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .zip(key.id.as_deref())
            .and_then(|(dir, id)| ExtensionLog::new(dir, id))
            .map(Arc::new);
        let task = runtime
            .handle
            .spawn(session(key.clone(), self.limits, closing, messages, log));
        let endpoint = Arc::new(Endpoint {
            serial: Mutex::new(()),
            sender,
        });
        state.connections.insert(key, (endpoint.clone(), task));
        Ok(endpoint)
    }

    pub(super) fn probe(
        &self,
        launch: Arc<Launch>,
        versions: &[u32],
    ) -> Result<Description, SourceError> {
        self.call(
            &Definition {
                launch,
                cached: None,
            },
            None,
            describe(versions),
        )
    }

    pub(super) fn call<T: DeserializeOwned>(
        &self,
        definition: &Definition,
        id: Option<&str>,
        call: Call<'_>,
    ) -> Result<T, SourceError> {
        let request = self.encode(call)?;
        let endpoint = self.endpoint(definition, id)?;
        let _serial = endpoint
            .serial
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (reply, result) = blocking::sync_channel(1);
        endpoint
            .sender
            .try_send(Message::Call {
                definition: definition.clone(),
                request,
                reply,
            })
            .map_err(|_| SourceError::NotSent("the source extension session has stopped".into()))?;
        let value = result.recv().map_err(|_| disconnected())??;
        serde_json::from_value(value)
            .map_err(|error| SourceError::Protocol(format!("invalid result: {error}")))
    }

    fn encode(&self, call: Call<'_>) -> Result<EncodedRequest, SourceError> {
        let id = (self.next.fetch_add(1, Ordering::Relaxed) % ((1 << 53) - 1)) + 1;
        let request = Request {
            jsonrpc: JsonRpc::V2,
            id,
            call,
        };
        let mut frame = CappedFrame(Vec::new());
        serde_json::to_writer(&mut frame, &request).map_err(|error| {
            SourceError::NotSent(format!("could not encode source request: {error}"))
        })?;
        frame.0.push(b'\n');
        Ok(EncodedRequest { id, frame: frame.0 })
    }

    pub(super) fn retry(&self, connection_id: &str) {
        let endpoints: Vec<_> = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .connections
            .iter()
            .filter(|(key, _)| key.id.as_deref() == Some(connection_id))
            .map(|(_, (endpoint, _))| endpoint.clone())
            .collect();
        for endpoint in endpoints {
            let _serial = endpoint
                .serial
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let (reply, received) = blocking::sync_channel(1);
            if endpoint.sender.try_send(Message::Retry(reply)).is_ok() {
                let _ = received.recv();
            }
        }
    }

    pub(super) fn shutdown(&self) {
        let (runtime, sessions) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.stopped = true;
            let sessions = state
                .connections
                .drain()
                .map(|(_, (_, task))| task)
                .collect();
            (state.runtime.take(), sessions)
        };
        if let Some(runtime) = runtime {
            runtime.closing.send_replace(());
            let _ = runtime.sessions.send(sessions);
            let _ = runtime.thread.join();
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct EncodedRequest {
    id: u64,
    frame: Vec<u8>,
}

struct CappedFrame(Vec<u8>);

impl Write for CappedFrame {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len() + bytes.len() > LINE_LIMIT {
            return Err(io::Error::other("request exceeds the message size limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

async fn session(
    key: ConnectionKey,
    limits: Limits,
    mut closing: watch::Receiver<()>,
    mut messages: mpsc::Receiver<Message>,
    log: Option<Arc<ExtensionLog>>,
) {
    let redactions = Redactions::default();
    let mut active: Option<(Arc<Launch>, Process)> = None;
    let mut idle_at = Instant::now() + limits.idle;
    let mut poll = interval(EXIT_POLL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut crashes = VecDeque::new();
    let mut pending_stdout: Option<Fault> = None;
    loop {
        tokio::select! {
            biased;
            _ = closing.changed() => break,
            message = messages.recv() => match message {
                Some(Message::Retry(reply)) => {
                    crashes.clear();
                    let _ = reply.send(());
                }
                Some(Message::Call { definition, request, reply }) => {
                    if active.as_ref().is_some_and(|(launch, _)| launch != &definition.launch) {
                        stop(&mut active).await;
                    }
                    if let Err(error) = verify_launch(&definition.launch).await {
                        stop(&mut active).await;
                        pending_stdout = None;
                        let _ = reply.send(Err(error));
                        continue;
                    }
                    if crashes.len() >= CRASH_LIMIT {
                        let _ = reply.send(Err(SourceError::ExtensionCrashLimit));
                        continue;
                    }
                    if let Some(fault) = pending_stdout.take() {
                        let _ = reply.send(Err(fault.into()));
                        continue;
                    }
                    let operation = serve(&mut active, &definition, key.id.is_some(), &request, limits, &redactions, log.clone());
                    let result = tokio::select! {
                        biased;
                        _ = closing.changed() => break,
                        result = operation => result,
                    };
                    let result = match result {
                        Ok(result) => result,
                        Err(fault) => {
                            if matches!(fault, Fault::Crash) {
                                record_crash(&mut crashes);
                            }
                            stop(&mut active).await;
                            Err(fault.into())
                        }
                    };
                    idle_at = Instant::now() + limits.idle;
                    let _ = reply.send(result);
                }
                None => break,
            },
            _ = sleep_until(idle_at), if active.is_some() => stop(&mut active).await,
            fault = idle_stdout(&mut active), if active.is_some() => {
                if matches!(fault, Fault::Crash) {
                    record_crash(&mut crashes);
                } else {
                    pending_stdout = Some(fault);
                }
                stop(&mut active).await;
            }
            _ = poll.tick(), if active.is_some() => {
                if active.as_mut().is_some_and(|(_, process)| process.child.exited()) {
                    record_crash(&mut crashes);
                    stop(&mut active).await;
                }
            }
        }
    }
    stop(&mut active).await;
}

async fn verify_launch(launch: &Arc<Launch>) -> Result<(), SourceError> {
    if !launch.is_installed() {
        return Ok(());
    }
    let launch = launch.clone();
    tokio::task::spawn_blocking(move || launch.verify_trust())
        .await
        .map_err(|_| {
            SourceError::NotSent("could not verify the installed source extension".into())
        })?
}

async fn idle_stdout(active: &mut Option<(Arc<Launch>, Process)>) -> Fault {
    let Some((_, process)) = active.as_mut() else {
        return std::future::pending().await;
    };
    match process.stdout.read().await {
        Ok(line) => process.stdout.unexpected(&line),
        Err(fault) => fault,
    }
}

fn record_crash(crashes: &mut VecDeque<Instant>) {
    let now = Instant::now();
    while crashes
        .front()
        .is_some_and(|first| now.duration_since(*first) > CRASH_WINDOW)
    {
        crashes.pop_front();
    }
    crashes.push_back(now);
}

async fn stop(active: &mut Option<(Arc<Launch>, Process)>) {
    if let Some((_, process)) = active.take() {
        process.shutdown().await;
    }
}

async fn serve(
    active: &mut Option<(Arc<Launch>, Process)>,
    definition: &Definition,
    connection: bool,
    request: &EncodedRequest,
    limits: Limits,
    redactions: &Redactions,
    log: Option<Arc<ExtensionLog>>,
) -> Result<Result<Value, SourceError>, Fault> {
    if active.is_none() {
        let process = match definition.launch.command().and_then(|command| {
            definition.launch.redact_environment(&command, redactions);
            Process::spawn(command, redactions.clone(), log)
        }) {
            Ok(process) => process,
            Err(error) => return Ok(Err(error)),
        };
        *active = Some((definition.launch.clone(), process));
        if connection {
            // Request IDs are unique within a subprocess, including this handshake.
            let hello = Request {
                jsonrpc: JsonRpc::V2,
                id: 0,
                call: describe(CONTRACT_VERSIONS),
            };
            let mut frame =
                serde_json::to_vec(&hello).map_err(|error| Fault::Protocol(error.to_string()))?;
            frame.push(b'\n');
            if let Some((_, process)) = active.as_mut() {
                let response = process.exchange(hello.id, &frame, limits.handshake).await?;
                let checked = response.and_then(|value| {
                    let description = parse_handshake(&definition.launch, value)?;
                    if definition.cached.as_deref() != Some(&description) {
                        return Err(SourceError::Protocol(
                            "the extension description changed; link its folder again".into(),
                        ));
                    }
                    Ok(())
                });
                if let Err(error) = checked {
                    stop(active).await;
                    return Ok(Err(error));
                }
            }
        }
    }
    match active.as_mut() {
        Some((_, process)) => {
            let deadline = if connection {
                limits.request
            } else {
                limits.handshake
            };
            process.exchange(request.id, &request.frame, deadline).await
        }
        None => Err(Fault::Crash),
    }
}

fn describe(versions: &[u32]) -> Call<'_> {
    Call::Describe {
        contract_versions: versions,
        pid: std::process::id(),
    }
}

pub(super) fn parse_handshake(
    launch: &Launch,
    response: Value,
) -> Result<Description, SourceError> {
    let hello: Description = serde_json::from_value(response)
        .map_err(|error| SourceError::Protocol(format!("invalid description: {error}")))?;
    validate_handshake(launch, &hello)?;
    Ok(hello)
}

pub(super) fn validate_handshake(launch: &Launch, hello: &Description) -> Result<(), SourceError> {
    if hello.contract_version != Some(CONTRACT_VERSION)
        || !hello.contract_versions.contains(&CONTRACT_VERSION)
    {
        return Err(SourceError::Protocol(format!(
            "extension '{}' supports {:?} and selected {:?}; ticketd supports {:?}",
            launch.manifest.id, hello.contract_versions, hello.contract_version, CONTRACT_VERSIONS
        )));
    }
    let descriptor = &hello
        .description
        .as_ref()
        .ok_or_else(|| {
            SourceError::Protocol("the extension did not provide its description".into())
        })?
        .descriptor;
    if descriptor.provider != launch.manifest.id
        || descriptor.contract_version != CONTRACT_VERSION
        || hello.version != launch.manifest.version
        || descriptor.name.trim().is_empty()
    {
        return Err(SourceError::Protocol(
            "the extension description does not match its manifest and negotiated contract".into(),
        ));
    }
    Ok(())
}

fn disconnected() -> SourceError {
    SourceError::Unavailable("the source extension host stopped during the request".into())
}
