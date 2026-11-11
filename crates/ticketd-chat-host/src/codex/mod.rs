//! The Codex adapter: the user's installed `codex app-server` over structured stdio.
//!
//! Codex keeps its own sign-in, configuration, instructions, approval policy and
//! sandbox. The adapter passes only the working directory and never reads
//! credentials, overrides settings or chooses how the user is billed.

mod discovery;
mod mapping;
mod rpc;
mod runtime;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::process::{Child, Command};
use tokio::time::timeout;

use crate::{
    Harness, HarnessAdapter, Inspection, OpenRequest, OpenedRuntime, Problem, ProblemKind,
    ProviderDetail,
};

use discovery::{LaunchEnvironment, Os};
use runtime::{ChildProcess, Io, Options};

const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Hosts Chats on the Codex installation found in the launch environment, or on an
/// executable the user selected.
#[derive(Debug, Clone, Default)]
pub struct CodexAdapter {
    selected: Option<PathBuf>,
}

impl CodexAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses this executable instead of searching for one.
    pub fn with_executable(executable: impl Into<PathBuf>) -> Self {
        Self {
            selected: Some(executable.into()),
        }
    }

    fn executable(&self) -> Option<PathBuf> {
        let is_file = |path: &Path| path.is_file();
        match &self.selected {
            Some(selected) => is_file(selected).then(|| selected.clone()),
            None => discovery::locate(Os::current(), &LaunchEnvironment::current(), is_file),
        }
    }
}

#[async_trait]
impl HarnessAdapter for CodexAdapter {
    fn harness(&self) -> Harness {
        Harness::Codex
    }

    async fn inspect(&self) -> Inspection {
        let Some(executable) = self.executable() else {
            return Inspection::NotInstalled;
        };
        let reported = match version_output(&executable).await {
            Ok(reported) => reported,
            Err(reason) => return Inspection::ProbeFailed { reason },
        };
        let version = Some(reported.trim().to_owned());
        if discovery::parse_version(&reported)
            .is_some_and(|found| found < discovery::MINIMUM_VERSION)
        {
            return Inspection::Incompatible {
                executable,
                version,
                requirement: discovery::version_requirement(),
            };
        }
        let login = match spawn(&executable) {
            Ok(io) => runtime::probe_login(io, Options::default()).await,
            Err(_) => crate::LoginState::Unknown,
        };
        Inspection::Installed {
            capabilities: discovery::capabilities(Some(&reported)),
            executable,
            version,
            login,
        }
    }

    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem> {
        let executable = self.executable().ok_or_else(|| Problem {
            kind: ProblemKind::NotInstalled,
            message: "Codex was not found. Install the Codex CLI (for example \
                      `npm install -g @openai/codex`), sign in with `codex login`, then \
                      recheck."
                .to_owned(),
            detail: None,
        })?;
        let io = spawn(&executable).map_err(|error| Problem {
            kind: ProblemKind::Other,
            message: format!("Could not start {}: {error}", executable.display()),
            detail: Some(ProviderDetail::new("spawn", &error.to_string())),
        })?;
        runtime::open_over(io, &request, Options::default()).await
    }
}

async fn version_output(executable: &Path) -> Result<String, String> {
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

/// Starts `codex app-server` on stdio with the launch environment unchanged, so
/// Codex finds its own configuration and sign-in.
fn spawn(executable: &Path) -> std::io::Result<Io> {
    let mut command = Command::new(executable);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let missing = || std::io::Error::other("the Codex process has no standard streams");
    Ok(Io {
        stdin: Box::new(child.stdin.take().ok_or_else(missing)?),
        stdout: Box::new(child.stdout.take().ok_or_else(missing)?),
        stderr: child
            .stderr
            .take()
            .map(|stderr| Box::new(stderr) as runtime::Reader),
        child: Box::new(Process(child)),
    })
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
