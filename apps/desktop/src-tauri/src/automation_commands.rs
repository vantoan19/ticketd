//! Commands for the Automations page. The rules live in the core; these translate.

use ticketd_core::{AutomationAgent, AutomationAgentSettings};

use crate::open_workspace;

#[tauri::command]
pub fn automation_agent_list() -> Result<Vec<AutomationAgent>, String> {
    open_workspace()
        .and_then(|workspace| workspace.automation_agents())
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
