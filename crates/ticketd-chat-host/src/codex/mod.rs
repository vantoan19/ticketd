//! The Codex adapter: the user's installed `codex app-server` over structured stdio.
//!
//! Codex keeps its own sign-in, configuration and instructions. For a person's Chat
//! the adapter passes only the working directory, so the approval policy and sandbox
//! are theirs too; it overrides the model or effort only when the person chose one in
//! the Chat, from that Chat's next turn. For an unattended session (an Automation
//! run) it turns approvals off, maps the agent's switches to Codex's shell and
//! sandbox (writes only in the step's folder, or none), gives the agent ticketd's
//! own tool for its tickets, and starts none of the person's MCP servers, plugins or
//! apps. A Chat taken over from a run resumes with the person's approvals and
//! sandbox again. It never reads credentials, grants full access or chooses
//! how the user is billed.

mod discovery;
mod mapping;
mod report;
mod rpc;
mod runtime;
#[cfg(test)]
mod tests;
mod ticket_tool;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::stdio::{Serving, spawn, version_output};
use crate::{
    Harness, HarnessAdapter, HarnessOptions, Inspection, OpenRequest, OpenedRuntime, Problem,
    ProblemKind, ProviderDetail, Unattended,
};
use ticketd_core::AutomationAgentTools;

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
/// no approvals given (Codex may ask, and the session declines at once: with the
/// policy "never" Codex reports a patch it rejects as nothing at all, 4B1), and the
/// sandbox the switches ask for, never full access. "Edit files" off is a read-only
/// sandbox; on, the agent may write in the step's folder (`working_directory`) and
/// nowhere else, not even the temporary folders Codex would add by itself. The
/// Workspace data folder is not writable: the agent records its result through
/// ticketd's own tool, which does not go through the sandbox. "Use the web" opens the
/// network, which is closed otherwise. "Run commands" and "Read files" are not sandbox
/// settings: see `switch_overrides`.
pub(super) fn unattended_params(
    unattended: &Unattended,
    working_directory: &Path,
) -> (Value, Value) {
    let tools = &unattended.tools;
    let mut thread = json!({
        "approvalPolicy": "on-request",
        "sandbox": if tools.edit_files { "workspace-write" } else { "read-only" },
    });
    if let Some(model) = &unattended.model {
        thread["model"] = json!(model);
    }
    let policy = if tools.edit_files {
        json!({
            "type": "workspaceWrite",
            "networkAccess": tools.use_web,
            "writableRoots": [working_directory.to_string_lossy()],
            "excludeTmpdirEnvVar": true,
            "excludeSlashTmp": true,
        })
    } else {
        json!({"type": "readOnly", "networkAccess": tools.use_web})
    };
    let turn = json!({"approvalPolicy": "on-request", "sandboxPolicy": policy});
    (thread, turn)
}

/// The `config` overrides that carry the "Run commands" switch. Codex has no read
/// tool: it reads files through its shell, so "Run commands" off removes the shell
/// and with it the agent's reading (what Codex itself loads, such as AGENTS.md, still
/// loads). Its image viewer, which reads any image file, goes with it. With "Run
/// commands" on the agent may run any command inside the sandbox: Codex has no list
/// of allowed commands, and no setting here limits what it reads.
pub(super) fn switch_overrides(tools: &AutomationAgentTools) -> Value {
    let mut overrides = json!({"features.shell_tool": tools.run_commands});
    if !tools.run_commands {
        overrides["features.view_image"] = json!(false);
    }
    overrides
}

/// Whether the agent gets no Codex environment at all (no shell, and no `apply_patch`
/// to write files): neither "Run commands" nor "Edit files" is on. Only ticketd's own
/// tool is left. `thread/start.environments` is how Codex says so.
pub(super) fn has_no_environment(tools: &AutomationAgentTools) -> bool {
    !tools.run_commands && !tools.edit_files
}

/// The `config` overrides of an unattended thread: none of the person's own MCP
/// servers, plugins (which bring servers and skills of their own) or ChatGPT apps
/// start, and everything else a config override can switch off is off too: hooks (a
/// `PermissionRequest` hook could allow what the session declines), the `notify`
/// program, project AGENTS.md, memories, sub-agents, computer and browser use, the
/// bundled skills and the skills list in the prompt (#387 L5, D4). Every key is in
/// Codex's config schema from 0.162.1 to 0.169.
/// Still applying, because no override reaches them: the person's rules, global
/// AGENTS.md and the skills in `~/.agents/skills`.
/// `config` is the person's configuration (`config/read`), which names their servers;
/// Codex merges an override table into theirs, so each is turned off by name.
// ponytail: a server added to the person's configuration between the read and
// `thread/start` still starts; the next run reads it again.
pub(super) fn personal_tools_off(config: Option<&Value>) -> Value {
    let mut off = json!({
        "features.plugins": false,
        "features.apps": false,
        "features.hooks": false,
        "features.memories": false,
        "features.multi_agent": false,
        "features.computer_use": false,
        "features.browser_use": false,
        "notify": [],
        "project_doc_max_bytes": 0,
        "skills.bundled.enabled": false,
        "skills.include_instructions": false,
    });
    let servers = config
        .and_then(|config| config["mcp_servers"].as_object())
        .into_iter()
        .flat_map(|servers| servers.keys());
    for server in servers {
        off[format!("mcp_servers.{server}.enabled")] = json!(false);
    }
    off
}

/// What `thread/resume` is told for a Chat the person took over from a run: the
/// approval policy and sandbox their own configuration sets, or Codex's defaults
/// when it sets none. Without them the thread keeps the agent's (#387 L2, D3).
pub(super) fn own_approvals(config: Option<&Value>) -> Value {
    let setting = |key: &str, default: &str| {
        config
            .map(|config| &config[key])
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| json!(default))
    };
    json!({
        "approvalPolicy": setting("approval_policy", "on-request"),
        "sandbox": setting("sandbox_mode", "read-only"),
    })
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
