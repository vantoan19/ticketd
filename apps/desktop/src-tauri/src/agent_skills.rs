//! Lets Settings install the ticketd skill for each supported agent harness.
//!
//! The agent is chosen by its registry id; the destination folder is derived
//! here, never taken from the webview.
use serde::Serialize;
use std::ffi::OsString;
use std::path::Path;
use ticketd_chat_host::cli::login_shell_variable;
use ticketd_core::agent_skills::{self, AGENTS, Agent, InstallOutcome, SkillState};

#[derive(Debug, Serialize)]
pub struct AgentSkill {
    pub id: &'static str,
    pub name: &'static str,
    /// The skill folder, with the home folder shortened to `~` except on Windows.
    pub path: String,
    /// Whether the harness has files of its own for this user.
    pub detected: bool,
    /// None when the folder could not be read; `error` then says why.
    pub state: Option<SkillState>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentSkillInstall {
    /// Where the replaced `SKILL.md` was saved, when one was replaced.
    pub backup: Option<String>,
}

/// The app's own variable when it has one, else the login shell's: an app
/// started from the Finder or Dock misses variables set in shell profiles, so
/// the harness would read a folder the app never looked at.
fn harness_env(name: &str) -> Option<OsString> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .or_else(|| login_shell_variable(name).map(OsString::from))
}

fn display(path: &Path, home: &Path) -> String {
    shorten(path, home, cfg!(windows))
}

/// Explorer and cmd do not expand `~`, so Windows shows the full path.
fn shorten(path: &Path, home: &Path, windows: bool) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if !windows => Path::new("~").join(rest).display().to_string(),
        _ => path.display().to_string(),
    }
}

/// One agent's row; a folder that cannot be read affects only its own row.
fn describe(agent: &'static Agent, home: &Path) -> AgentSkill {
    let directory = agent.skill_directory(home, harness_env);
    let (state, error) = match agent_skills::skill_state(&directory) {
        Ok(state) => (Some(state), None),
        Err(error) => (None, Some(error.to_string())),
    };
    AgentSkill {
        id: agent.key.as_str(),
        name: agent.name,
        path: display(&directory, home),
        detected: agent.detected(home, harness_env),
        state,
        error,
    }
}

/// Rewrites the copies ticketd installed and nobody edited, so an update never
/// leaves an agent with an old skill. Runs once per launch, in the background;
/// edited copies and agents without a copy are left alone.
pub fn refresh_at_launch() {
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(home) = agent_skills::user_home() else {
            return;
        };
        for refreshed in refresh_in(&home, cfg!(debug_assertions), harness_env) {
            match refreshed.result {
                Ok(()) => tracing::info!(agent = refreshed.agent.name, "updated the ticketd skill"),
                Err(error) => tracing::warn!(
                    agent = refreshed.agent.name,
                    %error,
                    "could not update the ticketd skill"
                ),
            }
        }
    });
}

/// A development build (`cargo run`, a worktree's build) does nothing here: its skill text is
/// not a release's, and it would rewrite the person's real, unedited skill with it, which the
/// installed app then rewrites back.
fn refresh_in(
    home: &Path,
    debug_build: bool,
    env: impl Fn(&str) -> Option<OsString>,
) -> Vec<agent_skills::Refreshed> {
    if debug_build {
        return Vec::new();
    }
    agent_skills::refresh_unedited(home, env)
}

/// Reports the ticketd skill's state for every supported agent.
#[tauri::command]
pub async fn agent_skills() -> Result<Vec<AgentSkill>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = agent_skills::user_home().map_err(|error| error.to_string())?;
        Ok(AGENTS.iter().map(|agent| describe(agent, &home)).collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Installs or updates the skill for one agent; `replace` overwrites an edited
/// or foreign copy after saving it beside the new one.
#[tauri::command]
pub async fn install_agent_skill(
    agent: String,
    replace: bool,
) -> Result<AgentSkillInstall, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent = Agent::find(&agent).ok_or_else(|| format!("unknown agent '{agent}'"))?;
        let home = agent_skills::user_home().map_err(|error| error.to_string())?;
        let directory = agent.skill_directory(&home, harness_env);
        let outcome = agent_skills::install_skill(&directory, replace)
            .map_err(|error| format!("cannot install the skill for {}: {error}", agent.name))?;
        Ok(AgentSkillInstall {
            backup: match outcome {
                InstallOutcome::Replaced { backup } => Some(display(&backup, &home)),
                _ => None,
            },
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_development_build_leaves_the_skills_alone_and_a_release_looks_at_them() {
        use std::os::unix::fs::PermissionsExt;
        // A skill file that cannot be read is reported by a refresh that looks at it, and
        // by nothing else, so this tells a refresh that ran from one that did not.
        // The environment is empty so that no real agent folder is looked at.
        let unset = |_: &str| None;
        let home = tempfile::tempdir().unwrap();
        let claude = Agent::find("claude-code").unwrap();
        let directory = claude.skill_directory(home.path(), unset);
        std::fs::create_dir_all(&directory).unwrap();
        let skill = directory.join("SKILL.md");
        std::fs::write(&skill, "older ticketd skill").unwrap();
        std::fs::set_permissions(&skill, std::fs::Permissions::from_mode(0o000)).unwrap();

        assert!(refresh_in(home.path(), true, unset).is_empty());
        assert!(
            refresh_in(home.path(), false, unset)
                .iter()
                .any(|refreshed| refreshed.agent.name == claude.name)
        );
    }

    #[test]
    fn the_home_folder_is_shortened_except_on_windows() {
        let home = Path::new("/home/user");
        let skill = home.join(".claude").join("skills").join("ticketd");
        assert_eq!(
            shorten(&skill, home, false),
            Path::new("~")
                .join(".claude")
                .join("skills")
                .join("ticketd")
                .display()
                .to_string()
        );
        assert_eq!(shorten(&skill, home, true), skill.display().to_string());
        let elsewhere = Path::new("/profile/skills/ticketd");
        assert_eq!(
            shorten(elsewhere, home, false),
            elsewhere.display().to_string()
        );
    }
}
