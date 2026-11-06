use tauri_plugin_opener::OpenerExt;
use ticketd_core::{Attachment, Ticket, WriteRequest, WriteResult};

use super::open_workspace;

#[tauri::command]
pub async fn import_attachment(source: String, request_id: String) -> Result<Attachment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|mut w| w.import_attachment(&request_id, source, None))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_attachments(limit: u32, offset: u32) -> Result<Vec<Attachment>, String> {
    open_workspace()
        .and_then(|w| w.attachments(limit, offset))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn inspect_attachment(id: String) -> Result<Attachment, String> {
    open_workspace()
        .and_then(|w| w.attachment(&id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ticket_attachments(reference: String) -> Result<Vec<Attachment>, String> {
    open_workspace()
        .and_then(|w| w.ticket_attachments(&reference))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_ticket_attachment(
    reference: String,
    attachment_id: String,
    present: bool,
    request_id: String,
) -> Result<Ticket, String> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::SetTicketAttachment {
                    reference,
                    attachment_id,
                    present,
                },
            )
        })
        .map_err(|e| e.to_string())?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected attachment association result".into()),
    }
}

#[tauri::command]
pub async fn export_attachment(id: String, destination: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|w| w.export_attachment(&id, destination))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_attachment(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = open_workspace()
        .and_then(|w| w.attachment_open_path(&id))
        .map_err(|e| e.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn attachment_uri(id: String) -> Result<String, String> {
    open_workspace()
        .and_then(|w| w.attachment_uri(&id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resolve_attachment_uri(uri: String) -> Result<Attachment, String> {
    open_workspace()
        .and_then(|w| w.resolve_attachment_uri(&uri))
        .map_err(|e| e.to_string())
}
