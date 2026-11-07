use super::open_workspace;
#[tauri::command(async)]
pub fn drive_uploaded_copy_status(
    id: String,
) -> Result<Option<ticketd_core::drive::DriveCopyInspection>, String> {
    let transport = GoogleTransport::default();
    let provider =
        ticketd_core::drive::GoogleDriveCopies::new(&PlatformCredentialStore, &transport);
    open_workspace()
        .and_then(|w| w.inspect_drive_uploaded_copy(&id, &provider))
        .map_err(|e| e.to_string())
}
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
use ticketd_core::drive::{DriveFolder, DriveUploadDestination, DriveUploadState};
use ticketd_core::{
    Attachment,
    drive::{
        DesktopOAuthClient, GoogleDrive, GoogleTransport, PickerSession, PlatformCredentialStore,
    },
};

#[derive(Serialize)]
pub struct SelectedUploadFolder {
    destination: DriveUploadDestination,
    folder: DriveFolder,
}

#[tauri::command(async)]
pub fn attachment_upload_destination() -> Result<ticketd_core::AttachmentUploadDestination, String>
{
    open_workspace()
        .and_then(|w| w.attachment_upload_destination())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn begin_attachment_upload(
    request_id: String,
    explicit: Option<ticketd_core::AttachmentUploadDestination>,
) -> Result<ticketd_core::AttachmentUploadDestination, String> {
    open_workspace()
        .and_then(|mut w| w.begin_attachment_upload(&request_id, explicit))
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn set_attachment_upload_destination(
    destination: Option<DriveUploadDestination>,
) -> Result<ticketd_core::AttachmentUploadDestination, String> {
    let mut workspace = open_workspace().map_err(|e| e.to_string())?;
    match destination {
        None => workspace.set_local_upload_destination(),
        Some(destination) => {
            let transport = GoogleTransport::default();
            let provider = GoogleDrive::new(
                &destination.connection_id,
                &PlatformCredentialStore,
                &transport,
            );
            workspace.set_drive_upload_destination(&destination, &provider)
        }
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn select_drive_upload_folder(
    app: tauri::AppHandle,
    operations: tauri::State<'_, DrivePickerOperations>,
    operation_id: String,
) -> Result<SelectedUploadFolder, String> {
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
        let session = PickerSession::begin_folder(
            DesktopOAuthClient::from_environment().map_err(|e| e.to_string())?,
            Duration::from_secs(180),
        )
        .map_err(|e| e.to_string())?;
        app.opener()
            .open_url(session.authorization_url(), None::<&str>)
            .map_err(|_| {
                "could not open the system browser for Drive folder selection".to_owned()
            })?;
        let transport = GoogleTransport::default();
        let selection = session
            .finish(&transport, &PlatformCredentialStore, &cancelled)
            .map_err(|e| e.to_string())?;
        let [folder_id] = selection.file_ids.as_slice() else {
            return Err("choose exactly one writable Drive folder".into());
        };
        let destination = DriveUploadDestination {
            connection_id: selection.connection_id.clone(),
            folder_id: folder_id.clone(),
            resource_key: None,
        };
        let provider = GoogleDrive::new(
            &selection.connection_id,
            &PlatformCredentialStore,
            &transport,
        );
        let folder = open_workspace()
            .and_then(|w| w.validate_drive_upload_destination(&destination, &provider))
            .map_err(|e| e.to_string())?;
        Ok(SelectedUploadFolder {
            destination,
            folder,
        })
    })
    .await
    .map_err(|_| "Drive folder selection could not finish".to_owned());
    operations
        .lock()
        .map_err(|_| "Drive picker state is unavailable")?
        .remove(&operation_id);
    result?
}

#[derive(Serialize)]
pub struct UploadStatus {
    state: DriveUploadState,
    attachment: Option<Attachment>,
}
#[tauri::command]
pub fn open_drive_upload(app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    let url = open_workspace()
        .and_then(|w| w.drive_upload_open_url(&request_id))
        .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Could not open this upload in Drive".into())
}
#[tauri::command]
pub async fn check_drive_upload(request_id: String) -> Result<UploadStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut workspace = open_workspace().map_err(|e| e.to_string())?;
        let operation = workspace
            .drive_upload(&request_id)
            .map_err(|e| e.to_string())?;
        let transport = GoogleTransport::default();
        let provider = GoogleDrive::new(
            &operation.request.destination.connection_id,
            &PlatformCredentialStore,
            &transport,
        );
        let operation = workspace
            .check_drive_upload(&request_id, &provider)
            .map_err(|e| e.to_string())?;
        let attachment = if operation.state == DriveUploadState::Completed {
            Some(
                workspace
                    .attachment(&operation.attachment_id)
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        Ok(UploadStatus {
            state: operation.state,
            attachment,
        })
    })
    .await
    .map_err(|_| "Drive upload status could not finish".to_owned())?
}

#[derive(Default)]
pub struct DrivePickerOperations(pub Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

#[derive(Serialize)]
pub struct DriveConfiguration {
    configured: bool,
    message: String,
}

#[tauri::command]
pub fn drive_reference(id: String) -> Result<ticketd_core::drive::DriveReference, String> {
    open_workspace()
        .and_then(|w| w.drive_reference(&id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_drive_reference(id: String) -> Result<ticketd_core::drive::DriveAccess, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut workspace = open_workspace().map_err(|e| e.to_string())?;
        let reference = workspace.drive_reference(&id).map_err(|e| e.to_string())?;
        let transport = GoogleTransport::default();
        let provider = GoogleDrive::new(
            &reference.connection_id,
            &PlatformCredentialStore,
            &transport,
        );
        workspace
            .check_drive_reference(&id, &provider)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Drive access check could not finish".to_owned())?
}

#[tauri::command]
pub async fn recover_drive_reference(
    app: tauri::AppHandle,
    operations: tauri::State<'_, DrivePickerOperations>,
    id: String,
    operation_id: String,
) -> Result<ticketd_core::drive::DriveAccess, String> {
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
        let mut workspace = open_workspace().map_err(|e| e.to_string())?;
        let session = workspace
            .begin_drive_reference_recovery(
                &id,
                DesktopOAuthClient::from_environment().map_err(|e| e.to_string())?,
                Duration::from_secs(180),
            )
            .map_err(|e| e.to_string())?;
        app.opener()
            .open_url(session.authorization_url(), None::<&str>)
            .map_err(|_| "could not open the system browser for Drive recovery".to_owned())?;
        let transport = GoogleTransport::default();
        let selection = session
            .finish(&transport, &PlatformCredentialStore, &cancelled)
            .map_err(|e| e.to_string())?;
        let provider = GoogleDrive::new(
            &selection.connection_id,
            &PlatformCredentialStore,
            &transport,
        );
        workspace
            .recover_drive_reference(&id, &selection, &provider)
            .map(|reference| ticketd_core::drive::DriveAccess {
                reference,
                failure: None,
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Drive recovery could not finish".to_owned());
    operations
        .lock()
        .map_err(|_| "Drive picker state is unavailable")?
        .remove(&operation_id);
    result?
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
