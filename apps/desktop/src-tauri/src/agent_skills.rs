//! Lets Settings install the ticketd skill for each supported agent harness.
//!
//! The agent is chosen by its registry id; the destination folder is derived
//! here, never taken from the webview.
use serde::Serialize;
use std::path::Path;
use ticketd_core::agent_skills::{self, AGENTS, Agent, InstallOutcome, SkillState};

#[derive(Debug, Serialize)]
pub struct AgentSkill {
    pub id: &'static str,
    pub name: &'static str,
    /// The skill folder, with the home folder shortened to `~`.
    pub path: String,
    /// Whether the harness's own folder exists for this user.
    pub detected: bool,
    pub state: SkillState,
}

#[derive(Debug, Serialize)]
pub struct AgentSkillInstall {
    /// Where the replaced `SKILL.md` was saved, when one was replaced.
    pub backup: Option<String>,
}

fn display(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => Path::new("~").join(rest).display().to_string(),
        Err(_) => path.display().to_string(),
    }
}

fn describe(agent: &'static Agent, home: &Path) -> Result<AgentSkill, String> {
    let directory = agent.skill_directory(home);
    let state = agent_skills::skill_state(&directory)
        .map_err(|error| format!("cannot read {}: {error}", display(&directory, home)))?;
    Ok(AgentSkill {
        id: agent.id,
        name: agent.name,
        path: display(&directory, home),
        detected: agent.detected(home),
        state,
    })
}

/// Reports the ticketd skill's state for every supported agent.
#[tauri::command]
pub async fn agent_skills() -> Result<Vec<AgentSkill>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = agent_skills::user_home().map_err(|error| error.to_string())?;
        AGENTS.iter().map(|agent| describe(agent, &home)).collect()
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
        let directory = agent.skill_directory(&home);
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
