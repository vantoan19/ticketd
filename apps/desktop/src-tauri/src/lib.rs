//! Desktop adapter for the shared ticketd core.
use ticketd_core::{
    Effort, EffortView, HistoryEntry, Note, NotePatch, Project, Ticket, TicketPatch, Workspace,
};

#[tauri::command]
fn list_projects() -> Result<Vec<Project>, String> {
    Workspace::open_default()
        .and_then(|w| w.list_projects())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn create_project(name: String, path: String) -> Result<Project, String> {
    Workspace::open_default()
        .and_then(|mut w| w.create_project(&name, &path))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn edit_project(id: String, name: String, path: String) -> Result<Project, String> {
    Workspace::open_default()
        .and_then(|mut w| w.edit_project(&id, &name, &path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_tickets() -> Result<Vec<Ticket>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.list_tickets())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn register_checkout(id: String, path: String) -> Result<Project, String> {
    Workspace::open_default()
        .and_then(|mut w| w.register_checkout(&id, &path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_checkout(id: String, path: String) -> Result<Project, String> {
    Workspace::open_default()
        .and_then(|mut w| w.remove_checkout(&id, &path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_ticket(title: String, project_id: Option<String>) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.create_ticket_in_project(&title, project_id.as_deref()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn change_ticket(reference: String, patch: TicketPatch) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.change_ticket(&reference, patch))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn ticket_history(reference: String) -> Result<Vec<HistoryEntry>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.ticket_history(&reference))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_notes(reference: String, limit: u32, offset: u32) -> Result<Vec<Note>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.notes(&reference, limit, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn add_note(reference: String, content: String) -> Result<Note, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.add_note(&reference, &content, None))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn edit_note(reference: String, id: String, patch: NotePatch) -> Result<Note, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.edit_note(&reference, &id, patch))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn delete_note(reference: String, id: String) -> Result<(), String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.delete_note(&reference, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn add_tag(reference: String, tag: String) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.add_tag(&reference, &tag))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_tag(reference: String, tag: String) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.remove_tag(&reference, &tag))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn add_dependency(blocker: String, dependent: String) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.add_dependency(&blocker, &dependent, None))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_dependency(blocker: String, dependent: String) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.remove_dependency(&blocker, &dependent, None))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_efforts() -> Result<Vec<Effort>, String> {
    Workspace::open_default()
        .and_then(|w| w.list_efforts(true))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn show_effort(id: String) -> Result<EffortView, String> {
    Workspace::open_default()
        .and_then(|w| w.show_effort(&id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn create_effort(name: String) -> Result<Effort, String> {
    Workspace::open_default()
        .and_then(|mut w| w.create_effort(&name))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn change_effort(
    id: String,
    name: Option<String>,
    archived: Option<bool>,
) -> Result<Effort, String> {
    Workspace::open_default()
        .and_then(|mut w| w.change_effort(&id, name.as_deref(), archived))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_effort(reference: String, effort: Option<String>) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut w| w.set_effort(&reference, effort.as_deref(), None))
        .map_err(|e| e.to_string())
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_efforts,
            show_effort,
            create_effort,
            change_effort,
            set_effort,
            list_projects,
            register_checkout,
            remove_checkout,
            create_project,
            edit_project,
            list_tickets,
            create_ticket,
            change_ticket,
            ticket_history,
            list_notes,
            add_note,
            edit_note,
            delete_note,
            add_tag,
            remove_tag,
            add_dependency,
            remove_dependency
        ])
        .run(tauri::generate_context!())
}
