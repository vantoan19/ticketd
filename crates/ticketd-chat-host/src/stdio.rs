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

    /// The raw tail, kept exactly for the diagnostic detail.
    pub fn snapshot(&self) -> String {
        let tail = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let bytes: Vec<u8> = tail.iter().copied().collect();
        String::from_utf8_lossy(&bytes).trim().to_owned()
    }

    /// What a person can read of the tail: terminal colour and control codes removed,
    /// timestamped log lines (a tool's own chatter, rarely the reason) left out, and
    /// only the last lines, since earlier ones are rarely about the loss.
    pub fn readable(&self) -> String {
        readable_lines(&self.snapshot())
    }
}

const READABLE_STDERR_LINES: usize = 2;

fn readable_lines(text: &str) -> String {
    let clean = strip_terminal_codes(text);
    let lines: Vec<&str> = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_log_line(line))
        .collect();
    let keep = lines.len().saturating_sub(READABLE_STDERR_LINES);
    lines[keep..].join("\n")
}

/// A line a logger wrote: a leading date, then a level word ("2026-11-12T16:56:48Z ERROR ...").
fn is_log_line(line: &str) -> bool {
    let bytes = line.as_bytes();
    let dated = bytes.len() >= 10
        && bytes[..10].iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    dated
        && line
            .split_whitespace()
            .skip(1)
            .take(2)
            .any(|word| matches!(word, "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE"))
}

/// Removes ANSI escape sequences (colours, cursor moves, titles) and other control
/// characters except line breaks and tabs.
fn strip_terminal_codes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // Control sequence: parameters, then one final byte in @..~.
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&next) {
                            break;
                        }
                    }
                }
                // Operating system command: ends at BEL or ESC \.
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' {
                            chars.next_if_eq(&'\\');
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Whom a harness process serves, which is all ticketd adds to its environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Serving<'a> {
    /// A probe: no Chat and no run.
    Nothing,
    Chat(&'a str),
    /// The Chat of an Automation run.
    Run {
        chat_id: &'a str,
        run_id: &'a str,
    },
}

impl<'a> Serving<'a> {
    pub(crate) fn of(request: &'a crate::OpenRequest) -> Self {
        match &request.unattended {
            Some(unattended) => Self::Run {
                chat_id: &request.chat_id,
                run_id: &unattended.run_id,
            },
            None => Self::Chat(&request.chat_id),
        }
    }
}

/// Starts `executable` on piped stdio with the launch environment unchanged, so the
/// harness finds its own configuration and sign-in. A runtime for a Chat also gets
/// that Chat's ID in `CHAT_ID_VARIABLE`, and one for an Automation run the run's ID
/// in `AUTOMATION_RUN_ID_VARIABLE`, and nothing else; the commands the harness runs
/// inherit them.
pub(crate) fn spawn(executable: &Path, arguments: &[&str], serving: Serving) -> io::Result<Io> {
    let mut child = command(executable, arguments, serving).spawn()?;
    let missing = || io::Error::other("the process has no standard streams");
    Ok(Io {
        stdin: Box::new(child.stdin.take().ok_or_else(missing)?),
        stdout: Box::new(child.stdout.take().ok_or_else(missing)?),
        stderr: child.stderr.take().map(|stderr| Box::new(stderr) as Reader),
        child: Box::new(Process(child)),
    })
}

fn command(executable: &Path, arguments: &[&str], serving: Serving) -> Command {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let (chat_id, run_id) = match serving {
        Serving::Nothing => (None, None),
        Serving::Chat(chat_id) => (Some(chat_id), None),
        Serving::Run { chat_id, run_id } => (Some(chat_id), Some(run_id)),
    };
    // What is not served is removed: an ID ticketd itself inherited must not pass on.
    for (variable, value) in [
        (ticketd_core::CHAT_ID_VARIABLE, chat_id),
        (ticketd_core::AUTOMATION_RUN_ID_VARIABLE, run_id),
    ] {
        match value {
            Some(value) => command.env(variable, value),
            None => command.env_remove(variable),
        };
    }
    hide_console(&mut command);
    command
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    /// N2: a Chat's harness process carries the Chat's ID, so the ticketd CLI it runs
    /// credits that Chat; a probe carries none.
    #[test]
    fn a_chat_runtime_is_started_with_its_chat_id_and_a_probe_without() {
        let variable = |serving| {
            command(Path::new("harness"), &[], serving)
                .as_std()
                .get_envs()
                .find(|(name, _)| *name == OsStr::new(ticketd_core::CHAT_ID_VARIABLE))
                .map(|(_, value)| value.map(OsStr::to_owned))
        };
        assert_eq!(
            variable(Serving::Chat("chat-1")),
            Some(Some("chat-1".into()))
        );
        assert_eq!(variable(Serving::Nothing), Some(None));
    }

    /// The agent of an Automation run carries the run's ID, so the ticketd CLI it runs
    /// logs its writes as an Automation's; a person's Chat carries none.
    #[test]
    fn only_the_chat_of_an_automation_run_is_started_with_the_run_id() {
        let variable = |serving| {
            command(Path::new("harness"), &[], serving)
                .as_std()
                .get_envs()
                .find(|(name, _)| *name == OsStr::new(ticketd_core::AUTOMATION_RUN_ID_VARIABLE))
                .map(|(_, value)| value.map(OsStr::to_owned))
        };
        let run = Serving::Run {
            chat_id: "chat-1",
            run_id: "run-1",
        };
        assert_eq!(variable(run), Some(Some("run-1".into())));
        assert_eq!(variable(Serving::Chat("chat-1")), Some(None));
    }

    #[test]
    fn readable_stderr_has_no_terminal_codes_skips_log_lines_and_keeps_the_last_lines() {
        let raw = "old\nolder\n\u{1b}[2m2026-11-12T16:56:48Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m worker quit\n\u{1b}]0;title\u{7}done\n";
        assert_eq!(readable_lines(raw), "older\ndone");
        let only_logs = "2026-11-12T16:56:48.1Z  WARN a\n2026-11-12T16:56:49Z ERROR rmcp::transport::worker: worker quit\n";
        assert_eq!(readable_lines(only_logs), "");
    }
}
