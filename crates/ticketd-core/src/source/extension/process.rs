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
use super::{logs::ExtensionLog, redaction::Redactions, wire::Response};

pub(super) const LINE_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_LIMIT: usize = 16 * 1024;
const EOF_GRACE: Duration = Duration::from_millis(150);
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_millis(150);
const REAP_LIMIT: Duration = Duration::from_secs(1);
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
                Ok(Ok(response.result))
            }
            Ok(Response::Failure(response)) if response.id == id => {
                let _ = response.jsonrpc;
                Ok(Err(response.error.into_source_error()))
            }
            _ => Err(stdout.unexpected(&result)),
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
        use rustix::process::{WaitId, WaitIdOptions, waitid};
        self.group.is_some_and(|group| {
            // Keep the child's PID reserved until the final signal to its group.
            waitid(
                WaitId::Pid(group),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            )
            .is_ok_and(|status| status.is_some())
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
        self.0
            .inner_mut()
            .try_wait()
            .is_ok_and(|status| status.is_some())
    }

    async fn shutdown(&mut self) {
        sleep(EOF_GRACE).await;
        if let Err(error) = self.0.start_kill() {
            tracing::warn!(%error, "could not terminate source extension job");
        }
        let _ = timeout(REAP_LIMIT, self.0.inner_mut().wait()).await;
    }
}
