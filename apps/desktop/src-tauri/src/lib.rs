//! Desktop adapter for the shared ticketd core.
use ticketd_core::{Ticket, Workspace};

#[tauri::command]
fn list_tickets() -> Result<Vec<Ticket>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.list_tickets())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_ticket(title: String) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.create_ticket(&title))
        .map_err(|error| error.to_string())
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_tickets, create_ticket])
        .run(tauri::generate_context!())
}
