//! Owns the process tree, and all three pipes, on the host runtime.

use std::{
    collections::VecDeque,
    io,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    sync::watch,
    task::JoinHandle,
    time::{Instant, Interval, interval, sleep, sleep_until, timeout},
};

use super::super::{RefreshControl, RefreshProgress, SourceError};
use super::{
    logs::ExtensionLog,
    redaction::Redactions,
    wire::{
        CancelMethod, CancelNotification, CancelParams, JsonRpc, ProgressNotification,
        REQUEST_CANCELED, Response, RpcErrorExt,
    },
};

pub(super) use super::wire::LINE_LIMIT;
const STDERR_LIMIT: usize = 16 * 1024;
const EOF_GRACE: Duration = Duration::from_millis(150);
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_millis(150);
const PASSWORD_COMMAND_LIMIT: Duration = Duration::from_secs(5);
const REAP_LIMIT: Duration = Duration::from_secs(1);
pub(super) const EXIT_POLL: Duration = Duration::from_millis(100);

pub(super) enum Fault {
    Crash,
    Protocol(String),
    Timeout,
    Canceled,
}

impl From<Fault> for SourceError {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Crash => Self::Unavailable("the source extension process exited".into()),
            Fault::Protocol(message) => Self::Protocol(message),
            Fault::Timeout => Self::Unavailable("the source extension request timed out".into()),
            Fault::Canceled => Self::RefreshCanceled,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct CallBudget {
    pub soft: Duration,
    pub hard: Duration,
    pub grace: Duration,
}

pub(super) struct CallControl<'a> {
    pub refresh: Option<&'a RefreshControl>,
    pub closing: &'a mut watch::Receiver<bool>,
}

impl CallControl<'_> {
    async fn canceled(&mut self) {
        tokio::select! {
            _ = self.closing.wait_for(|closed| *closed) => (),
            _ = async {
                if let Some(refresh) = self.refresh {
                    refresh.canceled().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => (),
        }
    }
}

enum Inbound {
    Progress(RefreshProgress),
    Reply(Response<Value>),
}

pub(super) struct Process {
    pub child: ManagedChild,
    stdin: Option<ChildStdin>,
    pub stdout: Lines,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    drain: JoinHandle<()>,
}

impl Process {
    pub(super) fn spawn(
        mut command: Command,
        redactions: Redactions,
        log: Option<Arc<ExtensionLog>>,
    ) -> Result<Self, SourceError> {
        let mut child = ManagedChild::spawn(
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .map_err(|error| {
            SourceError::NotSent(format!("could not start the source extension: {error}"))
        })?;
        let missing_pipe = || SourceError::NotSent("could not open the extension pipes".into());
        let stdin = child.stdin().ok_or_else(missing_pipe)?;
        let stdout = child.stdout().ok_or_else(missing_pipe)?;
        let mut reader = child.stderr().ok_or_else(missing_pipe)?;
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let tail = stderr.clone();
        let stderr_redactions = redactions.clone();
        let drain = tokio::spawn(async move {
            let mut stream = stderr_redactions.stream();
            let mut buffer = [0; 4096];
            let mut log = log;
            loop {
                let (bytes, finished) = match reader.read(&mut buffer).await {
                    Ok(length @ 1..) => (stream.push(&buffer[..length]), false),
                    _ => (stream.finish(), true),
                };
                {
                    let mut tail = tail.lock().unwrap_or_else(|error| error.into_inner());
                    tail.extend(bytes.iter().rev().take(STDERR_LIMIT).rev());
                    let discard = tail.len().saturating_sub(STDERR_LIMIT);
                    tail.drain(..discard);
                }
                if let Some(sink) = log.clone()
                    && !bytes.is_empty()
                    && !tokio::task::spawn_blocking(move || sink.append(&bytes))
                        .await
                        .is_ok_and(|result| result.is_ok())
                {
                    tracing::warn!("could not write source extension stderr");
                    log = None;
                }
                if finished {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: Lines {
                reader: BufReader::new(stdout),
                frame: Vec::new(),
                redactions,
            },
            stderr,
            drain,
        })
    }

    /// Both deadlines cover writing the request and reading its response.
    pub(super) async fn exchange(
        &mut self,
        id: u64,
        frame: &[u8],
        limits: CallBudget,
        control: &mut CallControl<'_>,
    ) -> Result<Result<Value, SourceError>, Fault> {
        let started = Instant::now();
        let hard = started + limits.hard;
        let mut deadline = hard.min(started + limits.soft);
        let mut polls = interval(EXIT_POLL);
        let stdin = self.stdin.as_mut().ok_or(Fault::Crash)?;
        tokio::select! {
            biased;
            // A canceled write may have left a partial JSON frame. In that
            // case the host closes the process rather than appending another.
            _ = control.canceled() => return Err(Fault::Canceled),
            _ = sleep_until(deadline) => return Err(Fault::Timeout),
            written = stdin.write_all(frame) => written.map_err(|_| Fault::Crash)?,
            _ = watch_for_exit(&mut self.child, &mut polls) => return Err(Fault::Crash),
        };
        loop {
            let inbound = tokio::select! {
                biased;
                _ = control.canceled() => Err(Fault::Canceled),
                _ = sleep_until(deadline) => Err(Fault::Timeout),
                received = self.receive(id, &mut polls) => received,
            };
            match inbound {
                Ok(Inbound::Progress(progress)) => {
                    deadline = hard.min(Instant::now() + limits.soft);
                    if let Some(refresh) = control.refresh {
                        refresh.report(progress);
                    }
                }
                Ok(Inbound::Reply(Response::Success(response))) => {
                    if self.stdout.redactions.contains_secret(&response.result) {
                        return Err(Fault::Protocol(
                            "source extension returned a credential in its result".into(),
                        ));
                    }
                    return Ok(Ok(response.result));
                }
                Ok(Inbound::Reply(Response::Failure(response))) => {
                    return Ok(Err(response
                        .error
                        .into_source_error(&self.stdout.redactions)));
                }
                Err(reason @ (Fault::Canceled | Fault::Timeout)) => {
                    if self.cancel_request(id, limits.grace, control.refresh).await {
                        return Ok(Err(reason.into()));
                    }
                    return Err(reason);
                }
                Err(fault) => return Err(fault),
            }
        }
    }

    async fn receive(&mut self, id: u64, polls: &mut Interval) -> Result<Inbound, Fault> {
        let line = tokio::select! {
            biased;
            line = self.stdout.read() => line?,
            _ = watch_for_exit(&mut self.child, polls) => return Err(Fault::Crash),
        };
        if let Ok(progress) = serde_json::from_slice::<ProgressNotification>(&line)
            && progress.params.id == id
            && progress
                .params
                .total
                .is_none_or(|total| progress.params.completed <= total)
        {
            let _ = (progress.jsonrpc, progress.method);
            return Ok(Inbound::Progress(RefreshProgress {
                completed: progress.params.completed,
                total: progress.params.total,
            }));
        }
        match serde_json::from_slice::<Response<Value>>(&line) {
            Ok(Response::Success(reply)) if reply.id == id => {
                let _ = reply.jsonrpc;
                Ok(Inbound::Reply(Response::Success(reply)))
            }
            Ok(Response::Failure(reply)) if reply.id == id => {
                let _ = reply.jsonrpc;
                Ok(Inbound::Reply(Response::Failure(reply)))
            }
            _ => Err(self.stdout.unexpected(&line)),
        }
    }

    /// A terminal response means the process is ready for its next call. A
    /// matching success can cross the cancel on the pipe but is still discarded.
    async fn cancel_request(
        &mut self,
        id: u64,
        grace: Duration,
        control: Option<&RefreshControl>,
    ) -> bool {
        let Some(stdin) = self.stdin.as_mut() else {
            return false;
        };
        let Ok(mut frame) = serde_json::to_vec(&CancelNotification {
            jsonrpc: JsonRpc::V2,
            method: CancelMethod::Cancel,
            params: CancelParams { id },
        }) else {
            return false;
        };
        frame.push(b'\n');
        let deadline = Instant::now() + grace;
        let mut polls = interval(EXIT_POLL);
        let written = tokio::select! {
            biased;
            _ = sleep_until(deadline) => return false,
            written = stdin.write_all(&frame) => written,
        };
        if written.is_err() {
            return false;
        }
        loop {
            let received = tokio::select! {
                biased;
                _ = sleep_until(deadline) => return false,
                received = self.receive(id, &mut polls) => received,
            };
            match received {
                Ok(Inbound::Progress(_)) => continue,
                Ok(Inbound::Reply(response)) => {
                    if let Response::Failure(response) = response
                        && response.error.code == REQUEST_CANCELED
                        && let Some(control) = control
                    {
                        control.acknowledge();
                    }
                    return true;
                }
                Err(_) => return false,
            }
        }
    }

    pub(super) async fn shutdown(mut self) {
        self.stdin.take();
        // Continue draining both pipes while EOF and termination take effect.
        // Output produced during shutdown is never reused by another session.
        let drain_stdout = async {
            let _ = tokio::io::copy(&mut self.stdout.reader, &mut tokio::io::sink()).await;
        };
        let (_, ()) = tokio::join!(
            timeout(EOF_GRACE + REAP_LIMIT, drain_stdout),
            self.child.shutdown(),
        );
        if timeout(REAP_LIMIT, &mut self.drain).await.is_err() {
            self.drain.abort();
            let _ = self.drain.await;
        }
        let captured = self
            .stderr
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len();
        tracing::debug!(captured_stderr_bytes = captured, "source extension stopped");
    }
}

async fn watch_for_exit(child: &mut ManagedChild, polls: &mut Interval) {
    loop {
        polls.tick().await;
        if child.exited() {
            return;
        }
    }
}

/// A partial frame survives cancellation of an idle read. Never allocate for
/// the rest of an oversized line, even if it has no newline.
pub(super) struct Lines {
    reader: BufReader<ChildStdout>,
    frame: Vec<u8>,
    redactions: Redactions,
}

impl Lines {
    pub(super) async fn read(&mut self) -> Result<Vec<u8>, Fault> {
        loop {
            let bytes = self.reader.fill_buf().await.map_err(|_| Fault::Crash)?;
            if bytes.is_empty() {
                return Err(if self.frame.is_empty() {
                    Fault::Crash
                } else {
                    self.unexpected(&self.frame)
                });
            }
            let newline = bytes.iter().position(|byte| *byte == b'\n');
            let length = newline.unwrap_or(bytes.len());
            if self.frame.len() + length > LINE_LIMIT {
                return Err(Fault::Protocol(format!(
                    "stdout line exceeds the {LINE_LIMIT}-byte limit"
                )));
            }
            self.frame.extend_from_slice(&bytes[..length]);
            self.reader.consume(length + usize::from(newline.is_some()));
            if newline.is_some() {
                return Ok(std::mem::take(&mut self.frame));
            }
        }
    }

    pub(super) fn unexpected(&self, line: &[u8]) -> Fault {
        // Match the full line before taking a short preview, including a value
        // that starts within the preview and ends after it.
        let redacted = self.redactions.text(&String::from_utf8_lossy(line));
        let limit = redacted.floor_char_boundary(240.min(redacted.len()));
        let suffix = if limit < redacted.len() { "…" } else { "" };
        Fault::Protocol(format!(
            "unexpected stdout line {:?}{suffix}",
            &redacted[..limit]
        ))
    }
}

pub(in crate::source) fn password_output(args: Vec<String>) -> Result<String, ()> {
    // Keep the blocking connector interface callable regardless of whether its
    // caller already runs on a Tokio runtime.
    std::thread::Builder::new()
        .name("source-password-command".into())
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| ())?
                .block_on(run_password_command(&args))
        })
        .map_err(|_| ())?
        .join()
        .map_err(|_| ())?
}

async fn run_password_command(args: &[String]) -> Result<String, ()> {
    let (program, arguments) = args.split_first().ok_or(())?;
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("TICKETD_")
        {
            command.env_remove(key);
        }
    }
    let mut child = ManagedChild::spawn(&mut command).map_err(|_| ())?;
    let stdout = child.stdout().ok_or(())?;
    let mut bytes = Vec::new();
    let result = timeout(PASSWORD_COMMAND_LIMIT, async {
        let mut stdout = stdout.take((super::super::credentials::VALUE_LIMIT + 3) as u64);
        stdout.read_to_end(&mut bytes).await.map_err(|_| ())?;
        if bytes.len() > super::super::credentials::VALUE_LIMIT + 2 {
            return Err(());
        }
        let mut polls = interval(Duration::from_millis(10));
        loop {
            polls.tick().await;
            if let Some(success) = child.exit_success() {
                return success.then_some(()).ok_or(());
            }
        }
    })
    .await;
    child.shutdown().await;
    result.map_err(|_| ())??;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    String::from_utf8(bytes).map_err(|_| ())
}

#[cfg(unix)]
pub(super) struct ManagedChild {
    child: tokio::process::Child,
    group: Option<rustix::process::Pid>,
}

#[cfg(unix)]
impl ManagedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        let child = command.process_group(0).kill_on_drop(true).spawn()?;
        let group = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .filter(|id| *id > 1)
            .and_then(rustix::process::Pid::from_raw)
            .ok_or_else(|| io::Error::other("missing source extension process group"))?;
        Ok(Self {
            child,
            group: Some(group),
        })
    }

    fn stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }
    fn stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }
    fn stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    pub(super) fn exited(&mut self) -> bool {
        self.exit_success().is_some()
    }

    fn exit_success(&mut self) -> Option<bool> {
        use rustix::process::{WaitId, WaitIdOptions, waitid};
        self.group.and_then(|group| {
            // Keep the child's PID reserved until the final signal to its group.
            waitid(
                WaitId::Pid(group),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            )
            .ok()
            .flatten()
            .map(|status| status.exit_status() == Some(0))
        })
    }

    async fn shutdown(&mut self) {
        use rustix::process::Signal;
        sleep(EOF_GRACE).await;
        if let Some(group) = self.group.take()
            && signal(group, Signal::TERM)
        {
            sleep(TERMINATE_GRACE).await;
            signal(group, Signal::KILL);
        }
        let _ = timeout(REAP_LIMIT, self.child.wait()).await;
    }
}

#[cfg(unix)]
impl Drop for ManagedChild {
    fn drop(&mut self) {
        if let Some(group) = self.group.take() {
            signal(group, rustix::process::Signal::KILL);
        }
    }
}

#[cfg(unix)]
fn signal(group: rustix::process::Pid, signal: rustix::process::Signal) -> bool {
    match rustix::process::kill_process_group(group, signal) {
        Ok(()) => true,
        Err(rustix::io::Errno::SRCH) => false,
        Err(error) => {
            tracing::warn!(%error, "could not terminate source extension process group");
            true
        }
    }
}

#[cfg(windows)]
pub(super) struct ManagedChild(Box<dyn process_wrap::tokio::ChildWrapper>);

#[cfg(windows)]
impl ManagedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        use process_wrap::tokio::{CommandWrap, CreationFlags, JobObject, KillOnDrop};
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        let mut wrapped = CommandWrap::from(std::mem::replace(command, Command::new("")));
        wrapped
            .wrap(KillOnDrop)
            .wrap(CreationFlags(CREATE_NO_WINDOW))
            .wrap(JobObject)
            .spawn()
            .map(Self)
    }

    fn stdin(&mut self) -> Option<ChildStdin> {
        self.0.stdin().take()
    }
    fn stdout(&mut self) -> Option<ChildStdout> {
        self.0.stdout().take()
    }
    fn stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.0.stderr().take()
    }

    pub(super) fn exited(&mut self) -> bool {
        self.exit_success().is_some()
    }

    fn exit_success(&mut self) -> Option<bool> {
        self.0
            .inner_mut()
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.success())
    }

    async fn shutdown(&mut self) {
        sleep(EOF_GRACE).await;
        if let Err(error) = self.0.start_kill() {
            tracing::warn!(%error, "could not terminate source extension job");
        }
        let _ = timeout(REAP_LIMIT, self.0.inner_mut().wait()).await;
    }
}
