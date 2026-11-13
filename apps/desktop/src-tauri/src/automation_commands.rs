//! Commands for the Automations page. The rules live in the core; these translate.

use ticketd_core::{Automation, AutomationAgent, AutomationAgentSettings, AutomationDefinition};

use crate::open_workspace;

/// An agent as the Agents list shows it: with the Automations that use it, which
/// is why it cannot be deleted while there are any.
#[derive(serde::Serialize)]
pub struct ListedAgent {
    #[serde(flatten)]
    agent: AutomationAgent,
    used_by: Vec<String>,
}

#[tauri::command]
pub fn automation_agent_list() -> Result<Vec<ListedAgent>, String> {
    open_workspace()
        .and_then(|workspace| {
            workspace
                .automation_agents()?
                .into_iter()
                .map(|agent| {
                    Ok(ListedAgent {
                        used_by: workspace.automations_using_agent(&agent.id)?,
                        agent,
                    })
                })
                .collect()
        })
        .map_err(|error| error.to_string())
}

/// A new agent starts from the core's defaults and is edited in place.
#[tauri::command]
pub fn automation_agent_create() -> Result<AutomationAgent, String> {
    open_workspace()
        .and_then(|mut workspace| {
            workspace.create_automation_agent(AutomationAgentSettings::default())
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn automation_agent_update(
    id: String,
    settings: AutomationAgentSettings,
) -> Result<AutomationAgent, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.update_automation_agent(&id, settings))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn automation_agent_delete(id: String) -> Result<(), String> {
    open_workspace()
        .and_then(|mut workspace| workspace.delete_automation_agent(&id))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn automation_list() -> Result<Vec<Automation>, String> {
    open_workspace()
        .and_then(|workspace| workspace.automations())
        .map_err(|error| error.to_string())
}

/// A new Automation starts empty and off, and is edited in place.
#[tauri::command]
pub fn automation_create() -> Result<Automation, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.create_automation(AutomationDefinition::default()))
        .map_err(|error| error.to_string())
}

/// Replaces the whole definition: renaming and reshaping are the same edit.
#[tauri::command]
pub fn automation_update(
    id: String,
    definition: AutomationDefinition,
) -> Result<Automation, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.update_automation(&id, definition))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn automation_delete(id: String) -> Result<(), String> {
    open_workspace()
        .and_then(|mut workspace| workspace.delete_automation(&id))
        .map_err(|error| error.to_string())
}

/// On or off for this device only.
#[tauri::command]
pub fn automation_set_enabled(id: String, enabled: bool) -> Result<Automation, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.set_automation_enabled(&id, enabled))
        .map_err(|error| error.to_string())
}
