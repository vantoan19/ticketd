//! The Codex adapter: the user's installed `codex app-server` over structured stdio.
//!
//! Codex keeps its own sign-in, configuration and instructions. For a person's Chat
//! the adapter passes only the working directory, so the approval policy and sandbox
//! are theirs too. For an unattended session (an Automation run) it turns approvals
//! off and sets the sandbox from the agent's allowed tools. It never reads
//! credentials, grants full access or chooses how the user is billed.

mod discovery;
mod mapping;
mod rpc;
mod runtime;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::stdio::{Serving, spawn, version_output};
use crate::{
    Harness, HarnessAdapter, Inspection, OpenRequest, OpenedRuntime, Problem, ProblemKind,
    ProviderDetail, Unattended,
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
/// approvals off, and a sandbox set from the allowed tools. Codex reads files and
/// runs commands inside the sandbox whatever the switches say, so "read files",
/// "run commands" and the list of allowed commands cannot be enforced here; what the
/// sandbox enforces is that nothing is written unless "edit files" is on and nothing
/// reaches the network unless "use the web" is. It is never full access.
pub(super) fn unattended_params(unattended: &Unattended) -> (Value, Value) {
    let network = unattended.tools.use_web;
    let (mode, policy) = if unattended.tools.edit_files {
        let roots: Vec<_> = unattended
            .ticketd_folders
            .iter()
            .map(|folder| folder.to_string_lossy())
            .collect();
        (
            "workspace-write",
            json!({"type": "workspaceWrite", "networkAccess": network, "writableRoots": roots}),
        )
    } else {
        (
            "read-only",
            json!({"type": "readOnly", "networkAccess": network}),
        )
    };
    let mut thread = json!({"approvalPolicy": "never", "sandbox": mode});
    if let Some(model) = &unattended.model {
        thread["model"] = json!(model);
    }
    (
        thread,
        json!({"approvalPolicy": "never", "sandboxPolicy": policy}),
    )
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
