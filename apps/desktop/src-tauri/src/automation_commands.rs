//! Commands for the Automations page. The rules live in the core; these translate.

use std::sync::Arc;

use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;
use ticketd_chat_host::WorkspaceOpener;
use ticketd_core::{
    Automation, AutomationAgent, AutomationAgentSettings, AutomationDefinition, AutomationExample,
    AutomationRun, AutomationRunStatus, AutomationRunTicket, AutomationStepStatus,
};

use crate::chat_commands::ChatBridge;
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

/// One of the examples the empty page offers, as an Automation that is off.
#[tauri::command]
pub fn automation_create_example(example: AutomationExample) -> Result<Automation, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.create_example_automation(example))
        .map_err(|error| error.to_string())
}

/// A copy of an Automation, off.
#[tauri::command]
pub fn automation_duplicate(id: String) -> Result<Automation, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.duplicate_automation(&id))
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

/// A step's text with its fields filled in from the ticket changed most recently,
/// and `tag` for the tag from the event. `None` while the Workspace has no ticket.
#[tauri::command]
pub fn automation_text_preview(
    text: String,
    tag: Option<String>,
) -> Result<Option<String>, String> {
    open_workspace()
        .and_then(|workspace| workspace.preview_automation_text(&text, tag.as_deref()))
        .map_err(|error| error.to_string())
}

/// A run as a list shows it. The run view reads the whole run.
#[derive(serde::Serialize)]
pub struct ListedRun {
    id: String,
    automation_id: String,
    /// The Automation as it is called now.
    automation_name: String,
    status: AutomationRunStatus,
    /// Why it needs attention.
    reason: Option<String>,
    /// It needs attention and the person has not yet acted on it.
    needs_you: bool,
    ticket: Option<AutomationRunTicket>,
    created_at: String,
}

fn listed(runs: Vec<AutomationRun>) -> Vec<ListedRun> {
    runs.into_iter()
        .map(|run| ListedRun {
            id: run.id,
            automation_id: run.automation_id,
            automation_name: run.automation_name,
            status: run.status,
            reason: run.reason,
            needs_you: run.needs_you,
            ticket: run.ticket,
            created_at: run.created_at,
        })
        .collect()
}

/// An Automation's runs on this device, newest first.
#[tauri::command]
pub fn automation_run_list(automation_id: String) -> Result<Vec<ListedRun>, String> {
    open_workspace()
        .and_then(|workspace| workspace.automation_runs(&automation_id))
        .map(listed)
        .map_err(|error| error.to_string())
}

/// The runs of every Automation on this device, newest first.
#[tauri::command]
pub fn automation_run_list_all() -> Result<Vec<ListedRun>, String> {
    open_workspace()
        .and_then(|workspace| workspace.all_automation_runs())
        .map(listed)
        .map_err(|error| error.to_string())
}

/// The runs that acted on a ticket, newest first.
#[tauri::command]
pub fn automation_run_list_for_ticket(reference: String) -> Result<Vec<ListedRun>, String> {
    open_workspace()
        .and_then(|workspace| workspace.ticket_automation_runs(&reference))
        .map(listed)
        .map_err(|error| error.to_string())
}

/// One run with the definition it executes and each step it reached.
#[tauri::command]
pub fn automation_run_get(id: String) -> Result<AutomationRun, String> {
    open_workspace()
        .and_then(|workspace| workspace.automation_run(&id))
        .map_err(|error| error.to_string())
}

/// Ends a run in progress as Needs attention, and interrupts the agent it was
/// running: the core no longer takes that turn's outcome, so nothing waits for it.
#[tauri::command]
pub async fn automation_run_stop(
    bridge: State<'_, ChatBridge>,
    id: String,
) -> Result<AutomationRun, String> {
    let (stopped, chat_id) = open_workspace()
        .and_then(|mut workspace| {
            let chat_id = workspace
                .automation_run(&id)?
                .steps
                .into_iter()
                .find(|step| step.status == AutomationStepStatus::Running)
                .and_then(|step| step.chat_id);
            Ok((workspace.stop_automation_run(&id)?, chat_id))
        })
        .map_err(|error| error.to_string())?;
    if let Some(chat_id) = chat_id {
        // ponytail: an interrupt that fails leaves the agent to its turn and time
        // limits; the run has ended either way.
        let _ = bridge.chats().stop(&chat_id).await;
    }
    Ok(stopped)
}

/// Queues a new run for the event that started a finished one, which then no
/// longer needs the person.
#[tauri::command]
pub fn automation_run_again(id: String) -> Result<AutomationRun, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.run_automation_again(&id))
        .map_err(|error| error.to_string())
}

/// The person wants nothing more from a run that needs attention.
#[tauri::command]
pub fn automation_run_dismiss(id: String) -> Result<AutomationRun, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.dismiss_automation_run(&id))
        .map_err(|error| error.to_string())
}

/// "Stop it and turn off": off for this device, with the Automation's active runs
/// ended as Needs attention and their agents interrupted.
#[tauri::command]
pub async fn automation_stop_and_turn_off(
    bridge: State<'_, ChatBridge>,
    id: String,
) -> Result<Automation, String> {
    let stopped = match bridge.chats().automation_host() {
        Some(host) => {
            let open: WorkspaceOpener = Arc::new(open_workspace);
            ticketd_automation_runner::stop_and_turn_off(&open, &host, &id).await
        }
        // Chat is off: no agent is running, so there is only the record to change.
        None => open_workspace()
            .and_then(|mut workspace| workspace.stop_and_turn_off_automation(&id).map(drop)),
    };
    stopped
        .and_then(|()| open_workspace()?.automation(&id))
        .map_err(|error| error.to_string())
}

/// How many runs execute at once on this device.
#[tauri::command]
pub fn automation_runs_at_once() -> Result<usize, String> {
    open_workspace()
        .and_then(|workspace| workspace.automation_runs_at_once())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_automation_runs_at_once(runs: usize) -> Result<(), String> {
    open_workspace()
        .and_then(|workspace| workspace.set_automation_runs_at_once(runs))
        .map_err(|error| error.to_string())
}

/// Whether the system starts ticketd when the person signs in to this computer.
#[tauri::command]
pub fn start_at_login(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_start_at_login(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    // Asked only for a change: removing an entry that is not there is an error.
    if autolaunch.is_enabled().map_err(|error| error.to_string())? == enabled {
        return Ok(());
    }
    if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    }
    .map_err(|error| error.to_string())
}
