use super::open_workspace;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri_plugin_opener::OpenerExt;
use ticketd_core::{
    Attachment,
    drive::{
        DesktopOAuthClient, GoogleDrive, GoogleTransport, PickerSession, PlatformCredentialStore,
    },
};

#[derive(Default)]
pub struct DrivePickerOperations(pub Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

#[derive(Serialize)]
pub struct DriveConfiguration {
    configured: bool,
    message: String,
}
#[tauri::command]
pub fn drive_configuration() -> DriveConfiguration {
    match DesktopOAuthClient::from_environment() {
        Ok(_) => DriveConfiguration {
            configured: true,
            message: "Ready to select files in your system browser".into(),
        },
        Err(error) => DriveConfiguration {
            configured: false,
            message: error.to_string(),
        },
    }
}

#[derive(Serialize)]
pub struct DriveFiles {
    files: Vec<Attachment>,
    failures: Vec<String>,
}

#[tauri::command]
pub async fn select_drive_files(
    app: tauri::AppHandle,
    operations: tauri::State<'_, DrivePickerOperations>,
    operation_id: String,
) -> Result<DriveFiles, String> {
    if operation_id.trim().is_empty() || operation_id.len() > 128 {
        return Err("invalid Drive selection operation".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let operations = Arc::clone(&operations.0);
    {
        let mut active = operations
            .lock()
            .map_err(|_| "Drive picker state is unavailable")?;
        if !active.is_empty() {
            return Err("another Drive selection is active; complete or cancel it first".into());
        }
        active.insert(operation_id.clone(), Arc::clone(&cancelled));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let session = PickerSession::begin(
            DesktopOAuthClient::from_environment().map_err(|e| e.to_string())?,
            Duration::from_secs(180),
        )
        .map_err(|e| e.to_string())?;
        // The core generated this pinned Google URL. It never crosses the WebView.
        app.opener()
            .open_url(session.authorization_url(), None::<&str>)
            .map_err(|_| "could not open the system browser for Drive selection".to_owned())?;
        let transport = GoogleTransport::default();
        let selection = session
            .finish(&transport, &PlatformCredentialStore, &cancelled)
            .map_err(|e| e.to_string())?;
        let provider = GoogleDrive::new(
            &selection.connection_id,
            &PlatformCredentialStore,
            &transport,
        );
        let mut workspace = open_workspace().map_err(|e| e.to_string())?;
        let mut files = Vec::new();
        let mut failures = Vec::new();
        for id in selection.file_ids {
            if cancelled.load(Ordering::SeqCst) {
                break;
            }
            match workspace.reference_drive_file(&selection.connection_id, &id, None, &provider) {
                Ok(file) => {
                    if !files
                        .iter()
                        .any(|existing: &Attachment| existing.id == file.id)
                    {
                        files.push(file);
                    }
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        Ok(DriveFiles { files, failures })
    })
    .await
    .map_err(|_| "Drive selection could not finish".to_owned());
    operations
        .lock()
        .map_err(|_| "Drive picker state is unavailable")?
        .remove(&operation_id);
    result?
}

#[tauri::command]
pub fn cancel_drive_selection(
    operations: tauri::State<'_, DrivePickerOperations>,
    operation_id: String,
) -> Result<(), String> {
    if let Some(cancelled) = operations
        .0
        .lock()
        .map_err(|_| "Drive picker state is unavailable")?
        .get(&operation_id)
    {
        cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}
