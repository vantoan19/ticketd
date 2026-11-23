//! The Claude Code adapter: ticketd's packaged Agent SDK bridge over structured
//! stdio, always driving the user's installed official Claude Code.
//!
//! Claude Code keeps its own sign-in, settings, instructions, skills, plugins, hooks,
//! MCP servers and permission mode. For a person's Chat the adapter passes only the
//! working directory, the executable it found and the session to resume. For an
//! unattended session (an Automation run) it also passes the agent's model, allowed
//! tools and turn limit; Claude Code denies what is not allowed instead of asking,
//! and the person's own settings files are left out so they cannot allow more. It
//! never reads credentials. It asks for permissions to be skipped (Full access) only
//! when the person picked that for their Chat, never for an unattended session.

mod report;
mod runtime;
mod session;
mod steps;

pub use steps::read_claude_steps;
#[cfg(test)]
pub(crate) mod tests;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::install::{LaunchEnvironment, Os, parse_version};
use crate::stdio::{Serving, spawn};
use crate::{
    Capabilities, Capability, Harness, HarnessAdapter, HarnessOptions, Inspection, LoginState,
    OpenRequest, OpenedRuntime, Problem, ProblemKind, ProviderDetail, Setting, Unattended,
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
    /// What the last check found Claude Code offers: the check already asked, so
    /// `options` need not start it again.
    offered: Arc<Mutex<Option<HarnessOptions>>>,
    /// Shared by every bridge it starts, so they share what `inspect` found.
    options: Options,
}

impl ClaudeAdapter {
    /// `bridge` is the packaged bridge executable.
    pub fn new(bridge: impl Into<PathBuf>) -> Self {
        Self {
            bridge: bridge.into(),
            selected: None,
            offered: Arc::default(),
            options: Options::default(),
        }
    }

    /// Uses this Claude Code executable instead of searching for one.
    pub fn with_executable(bridge: impl Into<PathBuf>, executable: impl Into<PathBuf>) -> Self {
        Self {
            bridge: bridge.into(),
            selected: Some(executable.into()),
            offered: Arc::default(),
            options: Options::default(),
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
        match spawn(&self.bridge, &[], Serving::Nothing, self.harness(), None) {
            Ok(io) => {
                let (inspection, offered) =
                    runtime::probe(io, &executable, self.options.clone()).await;
                *self.offered.lock().unwrap_or_else(PoisonError::into_inner) =
                    offered.and_then(Result::ok);
                inspection
            }
            Err(error) => Inspection::ProbeFailed {
                reason: self.bridge_problem(&error).message,
            },
        }
    }

    async fn options(&self) -> Result<HarnessOptions, String> {
        let checked = self
            .offered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(options) = checked {
            return Ok(options);
        }
        let executable = self
            .executable()
            .ok_or_else(|| "Claude Code was not found".to_owned())?;
        let io = spawn(&self.bridge, &[], Serving::Nothing, self.harness(), None)
            .map_err(|error| self.bridge_problem(&error).message)?;
        runtime::probe_options(io, &executable, self.options.clone()).await
    }

    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem> {
        let executable = self.executable().ok_or_else(not_installed)?;
        let io = spawn(
            &self.bridge,
            &[],
            Serving::of(&request),
            self.harness(),
            Some(&request.working_directory),
        )
        .map_err(|error| self.bridge_problem(&error))?;
        runtime::open_over(io, &request, &executable, self.options.clone()).await
    }

    /// The mode opening gives a person's Chat: the pick, else the offered mode its
    /// record kept, else "Ask before edits" for a Chat that ran before. Without a
    /// record Claude Code's own `defaultMode` would decide, which only a session shows.
    fn permission_before_session(
        &self,
        recorded: Option<&str>,
        picked: Option<&str>,
    ) -> Option<Setting> {
        let mode = picked
            .map(str::to_owned)
            .or_else(|| runtime::recorded_settings(recorded).permission)
            .or_else(|| recorded.map(|_| report::DEFAULT_PERMISSION_MODE.to_owned()))?;
        Some(report::permission_setting(mode))
    }

    fn record_permission(&self, recorded: Option<&str>, value: &str) -> Option<String> {
        runtime::record_reopen_with(recorded, "permission_mode", value)
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

/// What the bridge is told for an unattended session. Claude Code runs in its
/// "don't ask" permission mode: a tool on `allowed_tools` runs, anything else is
/// denied without a prompt. The bridge loads none of the person's own Claude Code
/// settings for such a session, so this list is the whole of what the agent may do.
/// The tools of a switch that is off are also disallowed outright, which takes them
/// away from the agent: Claude Code would otherwise read files in the step's folder
/// without needing a rule.
///
/// A command rule matches the command as the agent wrote it, up to the `*` (Claude
/// Code's permissions documentation, "Bash" and "PowerShell"). The agent's main shell
/// is PowerShell on Windows and Bash elsewhere, so each command is allowed in both.
/// The ticketd CLI is allowed by its name only: its folder is first on the agent's
/// `PATH` (see `Serving`) and its context says to call it by name. A rule for its path
/// did not match as written in either shell (live check, #387 L1), so none is given.
pub(super) fn unattended_options(unattended: &Unattended) -> Value {
    let tools = &unattended.tools;
    let (mut allowed, mut disallowed) = (Vec::new(), Vec::<String>::new());
    // A file tool's bare name would allow it on any path (#387 3B1). The step's
    // folder is Claude Code's working directory, where reading needs no rule and
    // outside which the bridge has Claude Code refuse every file tool. So a switch
    // that is on allows reading by not taking it away, and editing by the one rule
    // for Edit, Write and NotebookEdit below the working directory (Claude Code's
    // permissions documentation, "Read and Edit"). Claude Code's `Edit` refuses a
    // file it has not read, so editing keeps `Read`; finding files stays with "read
    // files" (#387 M12, D15).
    for (on, names) in [
        (tools.read_files || tools.edit_files, ["Read"].as_slice()),
        (tools.read_files, &["Glob", "Grep", "LSP"]),
        (tools.edit_files, &["Edit", "Write", "NotebookEdit"]),
    ] {
        if !on {
            disallowed.extend(names.iter().map(|name| (*name).to_owned()));
        }
    }
    if tools.edit_files {
        allowed.push("Edit(./**)".to_owned());
    }
    let web = ["WebFetch", "WebSearch"].map(str::to_owned);
    if tools.use_web {
        allowed.extend(web);
    } else {
        disallowed.extend(web);
    }
    const SHELLS: [&str; 2] = ["Bash", "PowerShell"];
    // The ticketd CLI is always allowed, by its name, with or without `.exe`.
    for command in ["ticketd", "ticketd.exe"] {
        allowed.extend(SHELLS.map(|shell| format!("{shell}({command} *)")));
    }
    // "Any command" is said outright: an empty list allows none.
    match (tools.run_commands, tools.any_command) {
        (false, _) => {}
        (true, true) => allowed.extend(SHELLS.map(str::to_owned)),
        (true, false) => {
            for command in &tools.allowed_commands {
                allowed.extend(SHELLS.map(|shell| format!("{shell}({command} *)")));
            }
        }
    }
    let mut options = json!({
        "allowed_tools": allowed,
        "disallowed_tools": disallowed,
        "max_turns": unattended.turn_limit,
    });
    if let Some(model) = &unattended.model {
        options["model"] = json!(model);
    }
    options
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
