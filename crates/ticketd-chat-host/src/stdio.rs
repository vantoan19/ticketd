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
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::Instrument;

use crate::{CloseOutcome, EventKind, Harness, harness_key};

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
    /// Drains `stderr` on its own task, inside the span that is current now (the Chat's),
    /// so the lines it logs are correlated with the Chat.
    pub fn spawn_drain<R>(self, stderr: R, harness: Harness) -> JoinHandle<()>
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        tokio::spawn(self.drain(stderr, harness).in_current_span())
    }

    /// Drains `stderr` to its end, keeping only the tail and logging each line at `debug`.
    pub async fn drain<R: AsyncRead + Unpin>(self, mut stderr: R, harness: Harness) {
        let mut lines = LogLines::new(harness);
        let mut buffer = [0u8; 4096];
        while let Ok(read) = stderr.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            {
                let mut tail = self.0.lock().unwrap_or_else(PoisonError::into_inner);
                tail.extend(&buffer[..read]);
                let excess = tail.len().saturating_sub(MAX_STDERR_TAIL_BYTES);
                tail.drain(..excess);
            }
            lines.push(&buffer[..read]);
        }
        lines.finish();
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

/// Splits stderr into lines for the log. A line longer than the tail is cut: the log needs
/// the gist, and the tail keeps the raw bytes.
struct LogLines {
    line: Vec<u8>,
    /// The Harness key the lines are logged under, as the Chat's `harness` value spells it.
    harness: &'static str,
}

impl LogLines {
    fn new(harness: Harness) -> Self {
        Self {
            line: Vec::new(),
            harness: harness_key(harness),
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        for piece in bytes.split_inclusive(|byte| *byte == b'\n') {
            let room = MAX_STDERR_TAIL_BYTES.saturating_sub(self.line.len());
            self.line.extend_from_slice(&piece[..piece.len().min(room)]);
            if piece.ends_with(b"\n") {
                self.finish();
            }
        }
    }

    fn finish(&mut self) {
        let line = std::mem::take(&mut self.line);
        let harness = self.harness;
        if !tracing::enabled!(target: "ticketd_chat_host::harness_stderr", tracing::Level::DEBUG) {
            return;
        }
        let text = strip_terminal_codes(&String::from_utf8_lossy(&line));
        let text = text.trim();
        if !text.is_empty() {
            tracing::debug!(
                target: "ticketd_chat_host::harness_stderr",
                harness,
                line = %text,
                "Harness stderr line"
            );
        }
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
    Chat {
        chat_id: &'a str,
        /// Set for the Chat of an Automation run.
        run_id: Option<&'a str>,
        ticketd_cli: Option<&'a Path>,
    },
}

impl<'a> Serving<'a> {
    pub(crate) fn of(request: &'a crate::OpenRequest) -> Self {
        Self::Chat {
            chat_id: &request.chat_id,
            run_id: request.unattended.as_ref().map(|run| run.run_id.as_str()),
            ticketd_cli: request.ticketd_cli.as_deref(),
        }
    }
}

/// Starts `executable` on piped stdio with the launch environment unchanged, so the
/// harness finds its own configuration and sign-in. A runtime for a Chat also gets
/// that Chat's ID in `CHAT_ID_VARIABLE`, one for an Automation run the run's ID in
/// `AUTOMATION_RUN_ID_VARIABLE`, and the ticketd CLI's folder first on `PATH`, and
/// nothing else; the commands the harness runs inherit them.
pub(crate) fn spawn(
    executable: &Path,
    arguments: &[&str],
    serving: Serving,
    harness: Harness,
    working_directory: Option<&Path>,
) -> io::Result<Io> {
    #[cfg(all(debug_assertions, unix))]
    let recording = crate::recording::before_spawn(harness, serving, working_directory)?;
    #[cfg(all(debug_assertions, unix))]
    let recorded_executable = recording
        .map(|_| std::path::absolute(executable))
        .transpose()?;
    #[cfg(all(debug_assertions, unix))]
    let executable = recorded_executable.as_deref().unwrap_or(executable);
    #[cfg(not(all(debug_assertions, unix)))]
    let _ = (harness, working_directory);
    let mut command = command(executable, arguments, serving);
    #[cfg(all(debug_assertions, unix))]
    if let Some(recording) = recording {
        command.current_dir(recording.work());
    }
    let mut child = command.spawn()?;
    let missing = || io::Error::other("the process has no standard streams");
    let io = Io {
        stdin: Box::new(child.stdin.take().ok_or_else(missing)?),
        stdout: Box::new(child.stdout.take().ok_or_else(missing)?),
        stderr: child.stderr.take().map(|stderr| Box::new(stderr) as Reader),
        child: Box::new(Process(child)),
    };
    #[cfg(all(debug_assertions, unix))]
    if let Some(recording) = recording {
        return recording.tap(io);
    }
    Ok(io)
}

/// The command `spawn` starts, for a caller that also needs its working directory.
pub(crate) fn command(executable: &Path, arguments: &[&str], serving: Serving) -> Command {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let (chat_id, run_id, cli) = match serving {
        Serving::Nothing => (None, None, None),
        Serving::Chat {
            chat_id,
            run_id,
            ticketd_cli,
        } => (Some(chat_id), run_id, ticketd_cli),
    };
    if let Some(path) = cli.and_then(|cli| path_with(cli.parent()?)) {
        command.env("PATH", path);
    }
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
    #[cfg(all(debug_assertions, unix))]
    command.env_remove(crate::recording::SWITCH);
    hide_console(&mut command);
    command
}

/// This process's `PATH` with `folder` first. `None` when `folder` cannot be on a
/// `PATH` (it holds the separator); the agent then has no `ticketd` command.
fn path_with(folder: &Path) -> Option<std::ffi::OsString> {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let rest = std::env::split_paths(&inherited).filter(|entry| entry != folder);
    std::env::join_paths(std::iter::once(folder.to_owned()).chain(rest)).ok()
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
async fn close_process(
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

/// How long a loss waits to learn the exit code before reporting without one.
const EXIT_OBSERVATION: Duration = Duration::from_secs(2);

/// Closes the process as `close_process` does and says what that proved. `who` names
/// the process; `may_run` says what could outlive a kill, since only the process
/// itself is killed. (Owning the whole process tree, with a Windows job object or a
/// POSIX process group, is #257/#267.)
pub(crate) async fn close_outcome(
    stdin: &AsyncMutex<Option<Writer>>,
    child: &AsyncMutex<Box<dyn ChildProcess>>,
    bound: Duration,
    who: &str,
    may_run: &str,
) -> CloseOutcome {
    match close_process(stdin, child, bound).await {
        Some(exit_code) => CloseOutcome::Confirmed { exit_code },
        None => CloseOutcome::Unconfirmed {
            reason: format!(
                "{who} did not exit within {} seconds of its input closing and was \
                 killed; {may_run}",
                bound.as_secs()
            ),
        },
    }
}

/// The last event of a runtime whose protocol stream ended without being closed:
/// releases the process's input, waits a moment to learn how it exited, and reports
/// the loss with the readable end of its stderr.
pub(crate) async fn runtime_lost(
    stdin: &AsyncMutex<Option<Writer>>,
    child: &AsyncMutex<Box<dyn ChildProcess>>,
    stderr: &StderrTail,
) -> EventKind {
    *stdin.lock().await = None;
    let exit_code = timeout(EXIT_OBSERVATION, async { child.lock().await.wait().await })
        .await
        .unwrap_or(None);
    EventKind::RuntimeLost {
        exit_code,
        diagnostics: stderr.readable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn variable(serving: Serving, name: &str) -> Option<Option<std::ffi::OsString>> {
        command(Path::new("harness"), &[], serving)
            .as_std()
            .get_envs()
            .find(|(variable, _)| variable.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.map(OsStr::to_owned))
    }

    fn chat(run_id: Option<&str>) -> Serving<'_> {
        Serving::Chat {
            chat_id: "chat-1",
            run_id,
            ticketd_cli: None,
        }
    }

    /// N2: a Chat's harness process carries the Chat's ID, so the ticketd CLI it runs
    /// credits that Chat; a probe carries none.
    #[test]
    fn a_chat_runtime_is_started_with_its_chat_id_and_a_probe_without() {
        let id = ticketd_core::CHAT_ID_VARIABLE;
        assert_eq!(variable(chat(None), id), Some(Some("chat-1".into())));
        assert_eq!(variable(Serving::Nothing, id), Some(None));
    }

    /// The agent of an Automation run carries the run's ID, so the ticketd CLI it runs
    /// logs its writes as an Automation's; a person's Chat carries none.
    #[test]
    fn only_the_chat_of_an_automation_run_is_started_with_the_run_id() {
        let id = ticketd_core::AUTOMATION_RUN_ID_VARIABLE;
        assert_eq!(
            variable(chat(Some("run-1")), id),
            Some(Some("run-1".into()))
        );
        assert_eq!(variable(chat(None), id), Some(None));
    }

    /// L1: the agent runs the ticketd CLI by its name, because its folder comes first
    /// on the harness's `PATH`; the rest of `PATH` is kept. A probe's is unchanged.
    #[test]
    fn a_chat_runtime_has_the_ticketd_cli_folder_first_on_its_path() {
        let folder = std::env::temp_dir().join("ticketd cli");
        let cli = folder.join("ticketd.exe");
        let serving = Serving::Chat {
            chat_id: "chat-1",
            run_id: Some("run-1"),
            ticketd_cli: Some(&cli),
        };
        let path = variable(serving, "PATH").flatten().expect("PATH is set");
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(entries.first(), Some(&folder));
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        assert_eq!(
            entries.len(),
            1 + std::env::split_paths(&inherited)
                .filter(|entry| *entry != folder)
                .count()
        );
        assert_eq!(variable(Serving::Nothing, "PATH"), None);
        assert_eq!(variable(chat(None), "PATH"), None);
    }

    #[test]
    fn harness_stderr_lines_reach_the_log_inside_the_chats_span_and_the_tail_is_unchanged() {
        let dir = tempfile::tempdir().expect("log folder");
        let logs = ticketd_diagnostics::DesktopLogs::open(
            dir.path(),
            ticketd_diagnostics::Config::default(),
        );
        logs.set_debug(true);
        let stderr =
            "warning: noisy\n\u{1b}[31mfatal: connection reset\u{1b}[0m\nno newline at the end";
        let tail = StderrTail::default();

        // A current-thread runtime polls the spawned drain on this thread, so the
        // handle's subscriber applies to it.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        logs.with_default(|| {
            runtime.block_on(async {
                let chat = tracing::info_span!("chat", chat_id = "chat-1");
                let drain = chat.in_scope(|| {
                    tail.clone()
                        .spawn_drain(stderr.as_bytes(), crate::Harness::ClaudeCode)
                });
                drain.await.expect("drain");
            });
        });

        // The tail keeps the raw bytes, as before.
        assert_eq!(tail.snapshot(), stderr);

        let lines: Vec<serde_json::Value> = std::fs::read_dir(dir.path())
            .expect("log folder")
            .map(|entry| entry.expect("entry").path())
            // The folder also holds the session marker.
            .filter(|path| path.extension().is_some_and(|extension| extension == "log"))
            .flat_map(|path| {
                let text = std::fs::read_to_string(path).expect("file");
                text.lines()
                    .map(|line| serde_json::from_str(line).expect("json line"))
                    .collect::<Vec<serde_json::Value>>()
            })
            .collect();
        let events: Vec<_> = lines
            .iter()
            .filter(|line| line["message"] == "Harness stderr line")
            .collect();
        let seen: Vec<_> = events
            .iter()
            .map(|event| event["line"].as_str().expect("line"))
            .collect();
        assert_eq!(
            seen,
            [
                "warning: noisy",
                "fatal: connection reset",
                "no newline at the end"
            ]
        );
        for event in events {
            assert_eq!(event["level"], "DEBUG");
            assert_eq!(event["harness"], "claude-code");
            assert_eq!(event["target"], "ticketd_chat_host::harness_stderr");
            assert_eq!(event["spans"][0]["name"], "chat");
            assert_eq!(event["spans"][0]["chat_id"], "chat-1");
        }
    }

    #[cfg(all(debug_assertions, unix))]
    #[test]
    fn only_opted_in_interactive_harnesses_record_in_their_prepared_run() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        use std::process::Command as TestCommand;

        const CHILD: &str = "TICKETD_SYNTHETIC_RECORDING_CHILD";
        const STIMULUS: &[u8] = b"{\"message\":\"synthetic\"}\n";
        let captures = |directory: &Path| {
            std::fs::read_dir(directory)
                .expect("capture directory")
                .map(|entry| entry.expect("entry").path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "wire"))
                .collect::<Vec<_>>()
        };
        if let Some(mode) = std::env::var_os(CHILD) {
            let workspace = std::env::var_os("TICKETD_TEST_WORKSPACE").expect("test Workspace");
            let directory = Path::new(&workspace).parent().expect("private folder");
            let work = directory.join("work");
            let prepare = || {
                crate::prepare_harness_recording(|| {
                    ticketd_core::Workspace::open_default()?
                        .workspace_info()
                        .map(|info| info.path.into())
                })
            };
            if mode == "wrong-workspace" {
                let prepared =
                    crate::prepare_harness_recording(|| Ok(directory.join("another.sqlite3")));
                assert!(prepared.is_err());
                return;
            }
            if ["inside-git", "existing-workspace", "linked-work"]
                .iter()
                .any(|value| mode == *value)
            {
                assert!(prepare().is_err());
                return;
            }
            prepare().expect("prepare test recording");

            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async {
                let selected = |cwd: &Path| {
                    spawn(
                        Path::new("/bin/cat"),
                        &[],
                        chat(None),
                        Harness::Codex,
                        Some(cwd),
                    )
                };
                if mode == "enabled" {
                    assert!(selected(directory).is_err());
                    let outside = directory.join("synthetic-outside.txt");
                    let linked = work.join("linked.txt");
                    std::fs::write(&outside, STIMULUS).expect("synthetic file");
                    symlink(&outside, &linked).expect("symlink");
                    assert!(selected(&work).is_err());
                    std::fs::remove_file(&linked).expect("remove symlink");
                    std::fs::hard_link(&outside, &linked).expect("hard link");
                    assert!(selected(&work).is_err());
                    std::fs::remove_file(&linked).expect("remove hard link");
                }
                let canonical = work.canonicalize().expect("work directory");
                for (serving, harness) in [
                    (Serving::Nothing, Harness::Codex),
                    (chat(Some("run-1")), Harness::Codex),
                    (chat(None), Harness::ClaudeCode),
                    (chat(None), Harness::Codex),
                    (chat(None), Harness::Codex),
                ] {
                    let mut io = if mode == "enabled"
                        && serving == chat(None)
                        && harness == Harness::Codex
                    {
                        spawn(
                            Path::new("/bin/sh"),
                            &[
                                "-c",
                                "test \"$(pwd -P)\" = \"$1\" && exec /bin/cat",
                                "test",
                                canonical.to_str().expect("UTF-8 path"),
                            ],
                            serving,
                            harness,
                            Some(&work),
                        )
                    } else {
                        spawn(Path::new("/bin/cat"), &[], serving, harness, None)
                    }
                    .expect("spawn");
                    io.stdin.write_all(STIMULUS).await.expect("send");
                    drop(io.stdin);
                    let mut echoed = Vec::new();
                    io.stdout.read_to_end(&mut echoed).await.expect("receive");
                    assert_eq!(echoed, STIMULUS);
                    drop(io.stdout);
                    assert_eq!(io.child.wait().await, Some(0));
                }
                if mode == "enabled" {
                    std::fs::hard_link(&workspace, directory.join("linked-workspace.sqlite3"))
                        .expect("hard link to disposable Workspace");
                    assert!(selected(&work).is_err());
                }
            });
            if mode == "enabled" {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while captures(directory).len() < 2 && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            return;
        }

        let private_run = || {
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir_in("/tmp")
                .expect("private temporary Workspace")
        };
        let invoke = |mode, directory: &Path| {
            let mut command = TestCommand::new(std::env::current_exe().expect("test executable"));
            command.args([
                "--exact",
                "stdio::tests::only_opted_in_interactive_harnesses_record_in_their_prepared_run",
            ])
            .env(CHILD, mode)
            .env("TICKETD_TEST_WORKSPACE", directory.join("workspace.sqlite3"))
            .env_remove("TICKETD_RECORD_HARNESS");
            if mode != "disabled" {
                command.env("TICKETD_RECORD_HARNESS", "codex");
            }
            let output = command.output().expect("test child");
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
        };

        for mode in [
            "inside-git",
            "existing-workspace",
            "linked-work",
            "wrong-workspace",
        ] {
            let directory = private_run();
            let work = directory.path().join("work");
            if mode == "linked-work" {
                let other = private_run();
                symlink(other.path(), &work).expect("linked folder");
                invoke(mode, directory.path());
            } else {
                std::fs::create_dir(&work).expect("work folder");
                if mode == "inside-git" {
                    std::fs::create_dir(directory.path().join(".git")).expect("Git marker");
                } else if mode == "existing-workspace" {
                    ticketd_core::Workspace::open(directory.path().join("workspace.sqlite3"))
                        .expect("existing synthetic Workspace");
                }
                invoke(mode, directory.path());
            }
            assert!(captures(directory.path()).is_empty());
        }
        let directory = private_run();
        std::fs::create_dir(directory.path().join("work")).expect("work folder");
        invoke("disabled", directory.path());
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("run contents")
                .count(),
            1
        );
        invoke("enabled", directory.path());
        let files = captures(directory.path());
        assert_eq!(files.len(), 2);
        for file in files {
            let mut expected = b"ticketd-harness-recording-v1\n".to_vec();
            for direction in [1, 2] {
                expected.push(direction);
                expected.extend((STIMULUS.len() as u32).to_le_bytes());
                expected.extend(STIMULUS);
            }
            assert_eq!(std::fs::read(&file).expect("recording"), expected);
            assert_eq!(
                file.metadata().expect("metadata").permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn readable_stderr_has_no_terminal_codes_skips_log_lines_and_keeps_the_last_lines() {
        let raw = "old\nolder\n\u{1b}[2m2026-11-12T16:56:48Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m worker quit\n\u{1b}]0;title\u{7}done\n";
        assert_eq!(readable_lines(raw), "older\ndone");
        let only_logs = "2026-11-12T16:56:48.1Z  WARN a\n2026-11-12T16:56:49Z ERROR rmcp::transport::worker: worker quit\n";
        assert_eq!(readable_lines(only_logs), "");
    }

    #[tokio::test]
    async fn stderr_keeps_only_a_bounded_tail() {
        let tail = StderrTail::default();
        let mut noise = vec![b'a'; MAX_STDERR_TAIL_BYTES * 2];
        noise.extend_from_slice(b"final line\n");

        tail.clone()
            .drain(noise.as_slice(), crate::Harness::Codex)
            .await;

        let snapshot = tail.snapshot();
        assert!(snapshot.len() <= MAX_STDERR_TAIL_BYTES);
        assert!(snapshot.ends_with("final line"));
    }
}
