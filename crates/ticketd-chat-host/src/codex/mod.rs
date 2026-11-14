//! The Codex adapter: the user's installed `codex app-server` over structured stdio.
//!
//! Codex keeps its own sign-in, configuration and instructions. For a person's Chat
//! the adapter passes only the working directory, so the approval policy and sandbox
//! are theirs too; it overrides the model or effort only when the person chose one in
//! the Chat, from that Chat's next turn. For an unattended session (an Automation
//! run) it turns approvals off and limits writes to the step's folder and the
//! Workspace data folder. It never reads credentials, grants full access or chooses
//! how the user is billed.

mod discovery;
mod mapping;
mod report;
mod rpc;
mod runtime;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::stdio::{Serving, spawn, version_output};
use crate::{
    Harness, HarnessAdapter, HarnessOptions, Inspection, OpenRequest, OpenedRuntime, Problem,
    ProblemKind, ProviderDetail, Unattended,
};

use discovery::{LaunchEnvironment, Os};
use runtime::Options;

const ARGUMENTS: &[&str] = &["app-server"];

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

/// What `thread/start` and every `turn/start` are told for an unattended session:
/// approvals off, and Codex's own sandbox. Codex reads files and runs commands
/// inside the sandbox whatever the switches say, and a read-only sandbox would stop
/// the ticketd CLI recording the agent's result, so "read files", "edit files",
/// "run commands" and the list of allowed commands do not apply here. The sandbox
/// always lets the agent write to the step's folder (`working_directory`) and the
/// folders the ticketd CLI writes to, and nowhere else: not the temporary folders
/// Codex would add by itself. Only "use the web" is the agent's own: nothing reaches
/// the network unless it is on. It is never full access.
pub(super) fn unattended_params(
    unattended: &Unattended,
    working_directory: &Path,
) -> (Value, Value) {
    let roots: Vec<_> = std::iter::once(working_directory)
        .chain(unattended.ticketd_folders.iter().map(PathBuf::as_path))
        .map(Path::to_string_lossy)
        .collect();
    let mut thread = json!({"approvalPolicy": "never", "sandbox": "workspace-write"});
    if let Some(model) = &unattended.model {
        thread["model"] = json!(model);
    }
    let turn = json!({
        "approvalPolicy": "never",
        "sandboxPolicy": {
            "type": "workspaceWrite",
            "networkAccess": unattended.tools.use_web,
            "writableRoots": roots,
            "excludeTmpdirEnvVar": true,
            "excludeSlashTmp": true,
        },
    });
    (thread, turn)
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
        let login = match spawn(&executable, ARGUMENTS, Serving::Nothing) {
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

    async fn options(&self) -> Result<HarnessOptions, String> {
        let executable = self
            .executable()
            .ok_or_else(|| "Codex was not found".to_owned())?;
        let io =
            spawn(&executable, ARGUMENTS, Serving::Nothing).map_err(|error| error.to_string())?;
        runtime::probe_options(io, Options::default()).await
    }

    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem> {
        let executable = self.executable().ok_or_else(|| Problem {
            kind: ProblemKind::NotInstalled,
            message: "Codex was not found. Install the Codex CLI (for example \
                      `npm install -g @openai/codex`), sign in with `codex login`, then \
                      recheck."
                .to_owned(),
            detail: None,
            resets_at: None,
        })?;
        let io = spawn(&executable, ARGUMENTS, Serving::of(&request)).map_err(|error| Problem {
            kind: ProblemKind::Other,
            message: format!("Could not start {}: {error}", executable.display()),
            detail: Some(ProviderDetail::new("spawn", &error.to_string())),
            resets_at: None,
        })?;
        runtime::open_over(io, &request, Options::default()).await
    }
}
