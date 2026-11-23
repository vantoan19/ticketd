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
    task::JoinHandle,
    time::{interval, sleep, timeout},
};

use super::super::SourceError;
use super::redaction::Redactions;
use super::wire::Response;

pub(super) const LINE_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_LIMIT: usize = 16 * 1024;
const EOF_GRACE: Duration = Duration::from_millis(150);
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_millis(150);
const REAP_LIMIT: Duration = Duration::from_secs(1);
const PASSWORD_COMMAND_LIMIT: Duration = Duration::from_secs(5);
pub(super) const EXIT_POLL: Duration = Duration::from_millis(100);

pub(super) enum Fault {
    Crash,
    Protocol(String),
    Timeout,
}

impl From<Fault> for SourceError {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Crash => Self::Unavailable("the source extension process exited".into()),
            Fault::Protocol(message) => Self::Protocol(message),
            Fault::Timeout => Self::Unavailable("the source extension request timed out".into()),
        }
    }
}

pub(super) struct Process {
    pub child: ManagedChild,
    stdin: Option<ChildStdin>,
    pub stdout: Lines,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    drain: JoinHandle<()>,
    redactions: Redactions,
}

impl Process {
    pub(super) fn spawn(mut command: Command, redactions: Redactions) -> Result<Self, SourceError> {
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
        let mut stream = redactions.stream();
        let drain = tokio::spawn(async move {
            let mut buffer = [0; 4096];
            while let Ok(length @ 1..) = reader.read(&mut buffer).await {
                keep_stderr(&tail, &stream.push(&buffer[..length]));
            }
            keep_stderr(&tail, &stream.finish());
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: Lines {
                reader: BufReader::new(stdout),
                frame: Vec::new(),
                redactions: redactions.clone(),
            },
            stderr,
            drain,
            redactions,
        })
    }

    /// One deadline covers a blocked write and the complete response. Observe a
    /// dead leader even if its descendants inherited stdin or stdout.
    pub(super) async fn exchange(
        &mut self,
        id: u64,
        frame: &[u8],
        limit: Duration,
    ) -> Result<Result<Value, SourceError>, Fault> {
        let stdin = self.stdin.as_mut().ok_or(Fault::Crash)?;
        let stdout = &mut self.stdout;
        let child = &mut self.child;
        let mut polls = interval(EXIT_POLL);
        let result = timeout(limit, async {
            tokio::select! {
                biased;
                received = async {
                    stdin.write_all(frame).await.map_err(|_| Fault::Crash)?;
                    stdout.read().await
                } => received,
                () = async {
                    loop {
                        polls.tick().await;
                        if child.exited() { return; }
                    }
                } => Err(Fault::Crash),
            }
        })
        .await
        .map_err(|_| Fault::Timeout)??;

        match serde_json::from_slice::<Response<Value>>(&result) {
            Ok(Response::Success(response)) if response.id == id => {
                let _ = response.jsonrpc;
                if self.redactions.contains_secret(&response.result) {
                    return Err(Fault::Protocol(
                        "source extension returned a credential in its result".into(),
                    ));
                }
                Ok(Ok(response.result))
            }
            Ok(Response::Failure(response)) if response.id == id => {
                let _ = response.jsonrpc;
                Ok(Err(response.error.into_source_error(&self.redactions)))
            }
            _ => Err(self.unexpected(&result)),
        }
    }

    pub(super) fn unexpected(&self, line: &[u8]) -> Fault {
        unexpected(line, &self.redactions)
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
        self.drain.abort();
        let _ = self.drain.await;
        let captured = self
            .stderr
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len();
        tracing::debug!(captured_stderr_bytes = captured, "source extension stopped");
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
                    unexpected(&self.frame, &self.redactions)
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
}

fn unexpected(line: &[u8], redactions: &Redactions) -> Fault {
    let redacted = redactions.bytes(line);
    let preview = String::from_utf8_lossy(&redacted[..redacted.len().min(240)]);
    let suffix = if redacted.len() > 240 { "…" } else { "" };
    Fault::Protocol(format!("unexpected stdout line {preview:?}{suffix}"))
}

fn keep_stderr(tail: &Mutex<VecDeque<u8>>, bytes: &[u8]) {
    let mut tail = tail.lock().unwrap_or_else(|error| error.into_inner());
    let bytes = &bytes[bytes.len().saturating_sub(STDERR_LIMIT)..];
    let discard = (tail.len() + bytes.len()).saturating_sub(STDERR_LIMIT);
    tail.drain(..discard);
    tail.extend(bytes);
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
        if let Some(group) = self.group.take() {
            if signal(group, Signal::TERM) {
                sleep(TERMINATE_GRACE).await;
                signal(group, Signal::KILL);
            }
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
