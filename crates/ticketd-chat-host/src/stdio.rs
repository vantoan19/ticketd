//! A provider process on structured stdio, shared by the adapters: bounded line
//! reading, a bounded stderr tail, and the spawned child behind the pipes.

use std::collections::VecDeque;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;

pub(crate) const MAX_STDERR_TAIL_BYTES: usize = 8 * 1024;
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) type Reader = Box<dyn AsyncRead + Send + Unpin>;
pub(crate) type Writer = Box<dyn AsyncWrite + Send + Unpin>;

/// The provider process behind the pipes.
#[async_trait]
pub(crate) trait ChildProcess: Send {
    /// Waits for the process to exit. Repeated calls report the same exit code.
    async fn wait(&mut self) -> Option<i32>;
    async fn kill(&mut self);
}

pub(crate) struct Io {
    pub stdout: Reader,
    pub stdin: Writer,
    pub stderr: Option<Reader>,
    pub child: Box<dyn ChildProcess>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Line {
    Complete(Vec<u8>),
    /// A line longer than the bound, skipped without buffering it.
    Oversized {
        bytes: usize,
    },
}

/// Reads the next non-blank line, or `None` at end of stream. An unterminated final
/// line is treated as end of stream. Memory use is bounded by `max_bytes`.
pub(crate) async fn read_line<R>(reader: &mut R, max_bytes: usize) -> io::Result<Option<Line>>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let mut line = Vec::new();
        let mut total = 0usize;
        loop {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(None);
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let chunk = &available[..newline.unwrap_or(available.len())];
            total += chunk.len();
            if total <= max_bytes {
                line.extend_from_slice(chunk);
            } else {
                line = Vec::new();
            }
            let consumed = chunk.len() + usize::from(newline.is_some());
            reader.consume(consumed);
            if newline.is_some() {
                break;
            }
        }
        if total > max_bytes {
            return Ok(Some(Line::Oversized { bytes: total }));
        }
        if !line.iter().all(u8::is_ascii_whitespace) {
            return Ok(Some(Line::Complete(line)));
        }
    }
}

/// The last bytes of the provider's stderr, for diagnostics after a loss.
#[derive(Debug, Clone, Default)]
pub(crate) struct StderrTail(Arc<Mutex<VecDeque<u8>>>);

impl StderrTail {
    /// Drains `stderr` to its end, keeping only the tail.
    pub async fn drain<R: AsyncRead + Unpin>(self, mut stderr: R) {
        let mut buffer = [0u8; 4096];
        while let Ok(read) = stderr.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            let mut tail = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            tail.extend(&buffer[..read]);
            let excess = tail.len().saturating_sub(MAX_STDERR_TAIL_BYTES);
            tail.drain(..excess);
        }
    }

    pub fn snapshot(&self) -> String {
        let tail = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let bytes: Vec<u8> = tail.iter().copied().collect();
        String::from_utf8_lossy(&bytes).trim().to_owned()
    }
}

/// Starts `executable` on piped stdio with the launch environment unchanged, so the
/// harness finds its own configuration and sign-in.
pub(crate) fn spawn(executable: &Path, arguments: &[&str]) -> io::Result<Io> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let missing = || io::Error::other("the process has no standard streams");
    Ok(Io {
        stdin: Box::new(child.stdin.take().ok_or_else(missing)?),
        stdout: Box::new(child.stdout.take().ok_or_else(missing)?),
        stderr: child.stderr.take().map(|stderr| Box::new(stderr) as Reader),
        child: Box::new(Process(child)),
    })
}

/// What `<executable> --version` printed.
pub(crate) async fn version_output(executable: &Path) -> Result<String, String> {
    let mut command = Command::new(executable);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    hide_console(&mut command);
    let output = timeout(VERSION_PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("`{} --version` did not finish", executable.display()))?
        .map_err(|error| format!("Could not run {}: {error}", executable.display()))?;
    if !output.status.success() {
        return Err(format!(
            "`{} --version` exited with {}",
            executable.display(),
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A windowed application must not flash a console for each child it starts.
fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

struct Process(Child);

#[async_trait]
impl ChildProcess for Process {
    async fn wait(&mut self) -> Option<i32> {
        self.0.wait().await.ok().and_then(|status| status.code())
    }

    async fn kill(&mut self) {
        // A process that already exited needs no kill.
        let _ = self.0.kill().await;
    }
}

/// Writes one frame within `bound`. A harness that does not take its input in that time
/// is not coming back: the pipe is dropped, because a partial frame may be in it, and
/// the process is killed so that its loss is reported like any other.
pub(crate) async fn write_bounded(
    stdin: &mut Option<Writer>,
    child: &AsyncMutex<Box<dyn ChildProcess>>,
    bytes: &[u8],
    bound: Duration,
) -> io::Result<()> {
    let Some(writer) = stdin.as_mut() else {
        return Err(io::ErrorKind::BrokenPipe.into());
    };
    let written = timeout(bound, async {
        writer.write_all(bytes).await?;
        writer.flush().await
    });
    match written.await {
        Ok(result) => result,
        Err(_) => {
            *stdin = None;
            child.lock().await.kill().await;
            Err(io::ErrorKind::TimedOut.into())
        }
    }
}

/// Closes the process's input, which asks it to exit, and waits up to `bound` for the
/// exit. Returns the exit code, or `None` after killing a process that did not exit.
/// The bound covers waiting for a write in progress, so a harness that stopped reading
/// cannot hold this up.
pub(crate) async fn close_process(
    stdin: &AsyncMutex<Option<Writer>>,
    child: &AsyncMutex<Box<dyn ChildProcess>>,
    bound: Duration,
) -> Option<Option<i32>> {
    let exited = timeout(bound, async {
        *stdin.lock().await = None;
        child.lock().await.wait().await
    });
    match exited.await {
        Ok(exit_code) => Some(exit_code),
        Err(_) => {
            child.lock().await.kill().await;
            None
        }
    }
}
