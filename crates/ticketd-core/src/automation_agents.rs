//! Automation agents: named, reusable definitions of who an Automation step runs.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Workspace};

/// The harness an Automation agent runs on, named as the Chat host names it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentHarness {
    #[default]
    ClaudeCode,
    Codex,
}

impl AgentHarness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    fn parse(key: &str) -> Result<Self, Error> {
        match key {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            other => Err(Error::InvalidAutomationAgent(format!(
                "unknown harness '{other}'"
            ))),
        }
    }
}

/// What an Automation agent may do. Anything not allowed here is denied; the
/// ticketd command line is always allowed and so is not a setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationAgentTools {
    pub read_files: bool,
    pub edit_files: bool,
    pub run_commands: bool,
    /// With `run_commands`, the only commands allowed. Empty allows any command.
    pub allowed_commands: Vec<String>,
    pub use_web: bool,
}

impl Default for AutomationAgentTools {
    fn default() -> Self {
        Self {
            read_files: true,
            edit_files: false,
            run_commands: false,
            allowed_commands: Vec::new(),
            use_web: false,
        }
    }
}

/// Everything a person sets on an Automation agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationAgentSettings {
    pub name: String,
    pub harness: AgentHarness,
    /// `None` is the harness's own default model.
    pub model: Option<String>,
    /// The first message of every run, before the ticket.
    pub instructions: String,
    pub tools: AutomationAgentTools,
    /// How many turns one step may take.
    pub turn_limit: u32,
    /// How long one step may run.
    pub time_limit_minutes: u32,
}

impl Default for AutomationAgentSettings {
    fn default() -> Self {
        Self {
            name: String::new(),
            harness: AgentHarness::default(),
            model: None,
            instructions: String::new(),
            tools: AutomationAgentTools::default(),
            turn_limit: 40,
            time_limit_minutes: 20,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationAgent {
    pub id: String,
    #[serde(flatten)]
    pub settings: AutomationAgentSettings,
}

const COLUMNS: &str = "id, name, harness, model, instructions, read_files, edit_files, run_commands, allowed_commands, use_web, turn_limit, time_limit_minutes";

/// `trashed` is the delete: Workspace sync has no deletions, so a record that will
/// synchronize is hidden rather than removed.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS automation_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, instructions TEXT NOT NULL, read_files INTEGER NOT NULL, edit_files INTEGER NOT NULL, run_commands INTEGER NOT NULL, allowed_commands TEXT NOT NULL, use_web INTEGER NOT NULL, turn_limit INTEGER NOT NULL, time_limit_minutes INTEGER NOT NULL, trashed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));",
    )?;
    // Views refresh on the change token, so an agent changed elsewhere shows up.
    crate::change_token::track(connection, "automation_agents")?;
    connection.execute_batch("PRAGMA user_version = 68;")?;
    Ok(())
}

fn validated(mut settings: AutomationAgentSettings) -> Result<AutomationAgentSettings, Error> {
    if settings.turn_limit == 0 || settings.time_limit_minutes == 0 {
        return Err(Error::InvalidAutomationAgent(
            "the turn limit and the time limit must be at least 1".into(),
        ));
    }
    settings.name = settings.name.trim().to_owned();
    settings.model = settings
        .model
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty());
    settings.tools.allowed_commands = settings
        .tools
        .allowed_commands
        .iter()
        .map(|command| command.trim().to_owned())
        .filter(|command| !command.is_empty())
        .collect();
    Ok(settings)
}

fn read(row: &Row<'_>) -> rusqlite::Result<(AutomationAgent, String, String)> {
    Ok((
        AutomationAgent {
            id: row.get(0)?,
            settings: AutomationAgentSettings {
                name: row.get(1)?,
                harness: AgentHarness::default(),
                model: row.get(3)?,
                instructions: row.get(4)?,
                tools: AutomationAgentTools {
                    read_files: row.get(5)?,
                    edit_files: row.get(6)?,
                    run_commands: row.get(7)?,
                    allowed_commands: Vec::new(),
                    use_web: row.get(9)?,
                },
                turn_limit: row.get(10)?,
                time_limit_minutes: row.get(11)?,
            },
        },
        row.get(2)?,
        row.get(8)?,
    ))
}

/// Fills in the two columns stored as text: the harness key and the command list.
fn decode(
    (mut agent, harness, commands): (AutomationAgent, String, String),
) -> Result<AutomationAgent, Error> {
    agent.settings.harness = AgentHarness::parse(&harness)?;
    agent.settings.tools.allowed_commands = serde_json::from_str(&commands)
        .map_err(|error| Error::InvalidAutomationAgent(error.to_string()))?;
    Ok(agent)
}

fn commands_json(settings: &AutomationAgentSettings) -> Result<String, Error> {
    serde_json::to_string(&settings.tools.allowed_commands)
        .map_err(|error| Error::InvalidAutomationAgent(error.to_string()))
}

impl Workspace {
    pub fn create_automation_agent(
        &mut self,
        settings: AutomationAgentSettings,
    ) -> Result<AutomationAgent, Error> {
        let agent = AutomationAgent {
            id: Uuid::new_v4().to_string(),
            settings: validated(settings)?,
        };
        let s = &agent.settings;
        self.connection.execute(
            &format!("INSERT INTO automation_agents ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"),
            params![
                agent.id,
                s.name,
                s.harness.as_str(),
                s.model,
                s.instructions,
                s.tools.read_files,
                s.tools.edit_files,
                s.tools.run_commands,
                commands_json(s)?,
                s.tools.use_web,
                s.turn_limit,
                s.time_limit_minutes
            ],
        )?;
        Ok(agent)
    }

    /// Replaces every setting of an agent.
    pub fn update_automation_agent(
        &mut self,
        id: &str,
        settings: AutomationAgentSettings,
    ) -> Result<AutomationAgent, Error> {
        let s = validated(settings)?;
        let changed = self.connection.execute(
            "UPDATE automation_agents SET name = ?2, harness = ?3, model = ?4, instructions = ?5, read_files = ?6, edit_files = ?7, run_commands = ?8, allowed_commands = ?9, use_web = ?10, turn_limit = ?11, time_limit_minutes = ?12 WHERE id = ?1 AND trashed = 0",
            params![
                id,
                s.name,
                s.harness.as_str(),
                s.model,
                s.instructions,
                s.tools.read_files,
                s.tools.edit_files,
                s.tools.run_commands,
                commands_json(&s)?,
                s.tools.use_web,
                s.turn_limit,
                s.time_limit_minutes
            ],
        )?;
        if changed == 0 {
            return Err(Error::AutomationAgentNotFound(id.to_owned()));
        }
        Ok(AutomationAgent {
            id: id.to_owned(),
            settings: s,
        })
    }

    pub fn delete_automation_agent(&mut self, id: &str) -> Result<(), Error> {
        let changed = self.connection.execute(
            "UPDATE automation_agents SET trashed = 1 WHERE id = ?1 AND trashed = 0",
            [id],
        )?;
        if changed == 0 {
            return Err(Error::AutomationAgentNotFound(id.to_owned()));
        }
        Ok(())
    }

    pub fn automation_agent(&self, id: &str) -> Result<AutomationAgent, Error> {
        self.connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM automation_agents WHERE id = ?1 AND trashed = 0"),
                [id],
                read,
            )
            .optional()?
            .ok_or_else(|| Error::AutomationAgentNotFound(id.to_owned()))
            .and_then(decode)
    }

    /// The agents that are not deleted, newest first.
    pub fn automation_agents(&self) -> Result<Vec<AutomationAgent>, Error> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {COLUMNS} FROM automation_agents WHERE trashed = 0 ORDER BY rowid DESC"
        ))?;
        let rows = statement
            .query_map([], read)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(decode).collect()
    }
}
