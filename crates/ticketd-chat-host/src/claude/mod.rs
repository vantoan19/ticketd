//! The Claude Code adapter: ticketd's packaged Agent SDK bridge over structured
//! stdio, always driving the user's installed official Claude Code.
//!
//! Claude Code keeps its own sign-in, settings, instructions, skills, plugins, hooks,
//! MCP servers and permission mode. The adapter passes only the working directory,
//! the executable it found and the session to resume. It never reads credentials and
//! never asks for permissions to be skipped.

mod report;
mod runtime;
mod session;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::Value;

use crate::install::{LaunchEnvironment, Os, parse_version};
use crate::stdio::spawn;
use crate::{
    Capabilities, Capability, Harness, HarnessAdapter, HarnessOptions, Inspection, LoginState,
    OpenRequest, OpenedRuntime, Problem, ProblemKind, ProviderDetail,
};

use runtime::Options;

/// File name of the bridge without its extension. Tauri ships it as a sidecar, so the
/// host passes `<folder of the application executable>/<this name>` (`.exe` on
/// Windows) to [`ClaudeAdapter::new`].
pub const BRIDGE_SIDECAR_NAME: &str = "ticketd-chat-bridge-claude";

/// Hosts Chats on the Claude Code installation found in the launch environment, or
/// on an executable the user selected, through the bridge at the given path.
#[derive(Debug, Clone)]
pub struct ClaudeAdapter {
    bridge: PathBuf,
    selected: Option<PathBuf>,
}

impl ClaudeAdapter {
    /// `bridge` is the packaged bridge executable.
    pub fn new(bridge: impl Into<PathBuf>) -> Self {
        Self {
            bridge: bridge.into(),
            selected: None,
        }
    }

    /// Uses this Claude Code executable instead of searching for one.
    pub fn with_executable(bridge: impl Into<PathBuf>, executable: impl Into<PathBuf>) -> Self {
        Self {
            bridge: bridge.into(),
            selected: Some(executable.into()),
        }
    }

    /// The installed Claude Code as an absolute path, which the bridge requires.
    fn executable(&self) -> Option<PathBuf> {
        let is_file = |path: &Path| path.is_file();
        let found = match &self.selected {
            Some(selected) => is_file(selected).then(|| selected.clone()),
            None => locate(Os::current(), &LaunchEnvironment::current(), is_file),
        }?;
        std::path::absolute(found).ok()
    }
}

#[async_trait]
impl HarnessAdapter for ClaudeAdapter {
    fn harness(&self) -> Harness {
        Harness::ClaudeCode
    }

    async fn inspect(&self) -> Inspection {
        let Some(executable) = self.executable() else {
            return Inspection::NotInstalled;
        };
        match spawn(&self.bridge, &[], None) {
            Ok(io) => runtime::probe(io, &executable, Options::default()).await,
            Err(error) => Inspection::ProbeFailed {
                reason: self.bridge_problem(&error).message,
            },
        }
    }

    async fn options(&self) -> Result<HarnessOptions, String> {
        let executable = self
            .executable()
            .ok_or_else(|| "Claude Code was not found".to_owned())?;
        let io =
            spawn(&self.bridge, &[], None).map_err(|error| self.bridge_problem(&error).message)?;
        runtime::probe_options(io, &executable, Options::default()).await
    }

    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem> {
        let executable = self.executable().ok_or_else(not_installed)?;
        let io = spawn(&self.bridge, &[], Some(&request.chat_id))
            .map_err(|error| self.bridge_problem(&error))?;
        runtime::open_over(io, &request, &executable, Options::default()).await
    }
}

impl ClaudeAdapter {
    fn bridge_problem(&self, error: &std::io::Error) -> Problem {
        Problem {
            kind: ProblemKind::Other,
            message: format!(
                "Could not start ticketd's Claude bridge at {}: {error}",
                self.bridge.display()
            ),
            detail: Some(ProviderDetail::new("spawn", &error.to_string())),
            resets_at: None,
        }
    }
}

fn not_installed() -> Problem {
    Problem {
        kind: ProblemKind::NotInstalled,
        message: "Claude Code was not found. Install the official Claude Code, sign in by \
                  running `claude`, then recheck."
            .to_owned(),
        detail: None,
        resets_at: None,
    }
}

/// Where Claude Code may be, most specific first: `PATH` in order, then the folders
/// its installers use.
fn candidates(os: Os, environment: &LaunchEnvironment) -> Vec<PathBuf> {
    let names: &[&str] = match os {
        // ponytail: an npm installation's `claude.cmd` shim is not selected, because
        // the Agent SDK starts the executable directly. Such a user selects the
        // executable explicitly.
        Os::Windows => &["claude.exe"],
        Os::Mac | Os::Linux => &["claude"],
    };
    let home = |relative: &str| environment.home.as_ref().map(|home| home.join(relative));
    let folder = |path: &str| Some(PathBuf::from(path));
    // The native installer's folder first, then package managers, then the folder
    // of a migrated local installation.
    let known = match os {
        Os::Windows => vec![home(".local/bin"), home(".claude/local")],
        Os::Mac => vec![
            home(".local/bin"),
            folder("/opt/homebrew/bin"),
            folder("/usr/local/bin"),
            home(".claude/local"),
        ],
        Os::Linux => vec![
            home(".local/bin"),
            folder("/usr/local/bin"),
            folder("/usr/bin"),
            home(".claude/local"),
        ],
    };
    environment.candidates(names, known)
}

fn locate(
    os: Os,
    environment: &LaunchEnvironment,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    candidates(os, environment)
        .into_iter()
        .find(|candidate| is_file(candidate))
}

/// Judges the bridge's `inspection` event: the installed Claude Code against the
/// version the bridge's Agent SDK was built for.
fn verdict(executable: &Path, inspection: &Value) -> Inspection {
    let text = |field: &str| inspection[field].as_str();
    let version = text("claude_version");
    let (Some(installed), Some(built_for)) = (
        version.and_then(parse_version),
        text("sdk_claude_code_version").and_then(parse_version),
    ) else {
        // A probe that could not read a version is not a verdict on the version.
        return match text("error") {
            Some(error) => Inspection::ProbeFailed {
                reason: error.to_owned(),
            },
            None => Inspection::Installed {
                executable: executable.to_owned(),
                version: version.map(str::to_owned),
                login: LoginState::Unknown,
                capabilities: capabilities(None),
            },
        };
    };
    let sdk = text("sdk_version").unwrap_or("unknown");
    let built_for_text = text("sdk_claude_code_version").unwrap_or_default();
    if installed < built_for {
        return Inspection::Incompatible {
            executable: executable.to_owned(),
            version: version.map(str::to_owned),
            requirement: format!("Claude Code {built_for_text} or newer"),
        };
    }
    let pairing = if installed == built_for {
        format!("Claude Code {built_for_text} is the version Agent SDK {sdk} was built for")
    } else {
        format!(
            "Claude Code {} is newer than {built_for_text}, the version Agent SDK {sdk} was \
             built for",
            version.unwrap_or_default()
        )
    };
    Inspection::Installed {
        executable: executable.to_owned(),
        version: version.map(str::to_owned),
        // Sign-in stays with Claude Code; ticketd reads no credential to find out.
        login: LoginState::Unknown,
        capabilities: capabilities(Some(&pairing)),
    }
}

/// What a session supports. `pairing` describes a readable version pair.
fn capabilities(pairing: Option<&str>) -> Capabilities {
    Capabilities {
        steering: Capability::Unknown {
            reason: "The bridge can add input to a running turn, but this has not been \
                     validated against a live Claude Code; follow-ups stay queued"
                .to_owned(),
        },
        native_resume: match pairing {
            Some(pairing) => Capability::Supported {
                behavior: (),
                evidence: format!(
                    "The bridge passes the session to the Agent SDK's `resume` option; \
                     {pairing}; not yet confirmed against a live session"
                ),
            },
            None => Capability::Unknown {
                reason: "Claude Code did not report a version ticketd can read".to_owned(),
            },
        },
    }
}
