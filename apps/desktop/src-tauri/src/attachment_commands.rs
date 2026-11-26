use tauri_plugin_opener::OpenerExt;
use ticketd_core::{Attachment, Ticket, WriteRequest, WriteResult};

use super::{BridgeFailure, open_workspace};
#[tauri::command(async)]
pub fn remove_remote_attachment(
    id: String,
    request_id: String,
) -> Result<ticketd_core::RemoteAttachmentRemoval, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::RemoveRemoteAttachment { id },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::RemoteAttachmentRemoved(result) => Ok(result),
        _ => Err("Unexpected remote removal result".into()),
    }
}

#[tauri::command]
pub fn open_removed_drive_file(app: tauri::AppHandle, url: String) -> Result<(), BridgeFailure> {
    if !ticketd_core::drive::safe_web_url(&url) {
        return Err("Only a checked Drive file link can be opened".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Could not open the retained file in Drive".into())
}

#[tauri::command(async)]
pub fn attachment_cleanup_review(
    id: String,
) -> Result<ticketd_core::AttachmentCleanupReview, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachment_cleanup_review(&id))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn purge_attachment(id: String) -> Result<Attachment, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.purge_attachment(&id))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn attachment_cleanup_reviews(
    limit: u32,
    offset: u32,
) -> Result<Vec<ticketd_core::AttachmentCleanupReview>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachment_cleanup_reviews(limit, offset))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn quarantine_attachment(id: String, request_id: String) -> Result<Attachment, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), WriteRequest::QuarantineAttachment { id }))
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Attachment(file) => Ok(file),
        _ => Err("unexpected quarantine result".into()),
    }
}

#[tauri::command(async)]
pub fn restore_attachment(id: String, request_id: String) -> Result<Attachment, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), WriteRequest::RestoreAttachment { id }))
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Attachment(file) => Ok(file),
        _ => Err("unexpected restore result".into()),
    }
}

/// The whole text of a stored HTML report, for the viewer's isolated frame.
#[tauri::command]
pub async fn attachment_html(workspace: String, id: String) -> Result<String, BridgeFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|w| w.attachment_html(&workspace, &id))
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

/// The display text of a stored plain-text file (the whole file, or its end when it is very
/// long), for the viewer's log stage. It crosses as one raw binary response of UTF-8, not a
/// JSON string, because it can be 20 MiB.
#[tauri::command]
pub async fn attachment_text(
    workspace: String,
    id: String,
) -> Result<tauri::ipc::Response, BridgeFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|w| w.attachment_text(&workspace, &id))
            .map(|text| tauri::ipc::Response::new(text.into_bytes()))
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

/// The bytes of a stored PDF, for the viewer to render page by page. They cross as one
/// raw binary response (not JSON), read through the checked snapshot and capped by core.
#[tauri::command]
pub async fn attachment_pdf(
    workspace: String,
    id: String,
) -> Result<tauri::ipc::Response, BridgeFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|w| w.attachment_pdf(&workspace, &id))
            .map(tauri::ipc::Response::new)
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

#[tauri::command]
pub async fn attachment_preview(
    workspace: String,
    id: String,
) -> Result<ticketd_core::AttachmentPreview, BridgeFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|w| w.attachment_preview(&workspace, &id))
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

type Uploads = Mutex<HashMap<String, Arc<AtomicBool>>>;
#[tauri::command(async)]
pub fn export_markdown_with_files(
    source: ticketd_core::MarkdownExportSource,
    output: String,
) -> Result<ticketd_core::MarkdownExport, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.export_markdown_with_files(source, output))
        .map_err(BridgeFailure::from)
}

static UPLOADS: OnceLock<Uploads> = OnceLock::new();

struct UploadGuard(String);
impl Drop for UploadGuard {
    fn drop(&mut self) {
        if let Ok(mut uploads) = UPLOADS.get_or_init(Uploads::default).lock() {
            uploads.remove(&self.0);
        }
    }
}
fn start_upload(request_id: &str) -> Result<(UploadGuard, Arc<AtomicBool>), BridgeFailure> {
    let mut uploads = UPLOADS
        .get_or_init(Uploads::default)
        .lock()
        .map_err(BridgeFailure::from)?;
    if uploads.contains_key(request_id) {
        return Err("This upload is still running; wait before retrying the same operation".into());
    }
    let canceled = Arc::new(AtomicBool::new(false));
    uploads.insert(request_id.into(), canceled.clone());
    Ok((UploadGuard(request_id.into()), canceled))
}
#[derive(Clone, serde::Serialize)]
pub struct UploadProgress {
    copied: u64,
    total: u64,
}

fn report_progress(
    progress: &Option<tauri::ipc::Channel<UploadProgress>>,
    canceled: &AtomicBool,
    copied: u64,
    total: u64,
) -> bool {
    if let Some(channel) = progress {
        let _ = channel.send(UploadProgress { copied, total });
    }
    !canceled.load(Ordering::Relaxed)
}

#[tauri::command(async)]
pub fn draft_retentions() -> Result<Vec<ticketd_core::DraftRetention>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.draft_retentions())
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn complete_draft_cutover() -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.complete_draft_cutover())
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn draft_cutover_pending() -> Result<bool, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.draft_cutover_pending())
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn retain_draft(
    draft: ticketd_core::DraftRetention,
) -> Result<ticketd_core::DraftRetention, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.retain_draft(&draft))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn attachment_usage(id: String) -> Result<ticketd_core::AttachmentUsage, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachment_usage(&id))
        .map_err(BridgeFailure::from)
}

#[tauri::command]
pub fn cancel_attachment_upload(request_id: String) -> Result<(), BridgeFailure> {
    let uploads = UPLOADS
        .get_or_init(Uploads::default)
        .lock()
        .map_err(BridgeFailure::from)?;
    if let Some(canceled) = uploads.get(&request_id) {
        canceled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn attachment_upload_limit() -> Result<u64, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachment_upload_limit())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
pub fn attachment_workspace_id() -> Result<String, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachment_workspace_id())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
pub fn set_attachment_upload_limit(bytes: u64) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|w| w.set_attachment_upload_limit(bytes))
        .map_err(BridgeFailure::from)
}

#[tauri::command]
pub async fn capture_attachment(
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Attachment, BridgeFailure> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata {
        filename: String,
        request_id: String,
        progress: tauri::ipc::JavaScriptChannelId,
        destination: Option<ticketd_core::drive::DriveUploadDestination>,
    }
    let metadata: Metadata = serde_json::from_str(
        request
            .headers()
            .get("x-ticketd-upload")
            .ok_or("Missing screenshot metadata")?
            .to_str()
            .map_err(BridgeFailure::from)?,
    )
    .map_err(BridgeFailure::from)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Screenshot capture requires a binary payload".into());
    };
    let bytes = bytes.clone();
    let Metadata {
        filename,
        request_id,
        progress,
        destination,
    } = metadata;
    let progress = Some(progress.channel_on(webview));
    let (guard, canceled) = start_upload(&request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        open_workspace()
            .and_then(|mut w| {
                if let Some(destination) = destination {
                    let transport = ticketd_core::drive::GoogleTransport::default();
                    let provider = ticketd_core::drive::GoogleDrive::new(
                        &destination.connection_id,
                        &ticketd_core::drive::PlatformCredentialStore,
                        &transport,
                    );
                    return w.upload_drive_bytes(
                        &request_id,
                        &filename,
                        &bytes,
                        &destination,
                        &provider,
                        |copied, total| report_progress(&progress, &canceled, copied, total),
                    );
                }
                w.import_attachment_bytes(&request_id, &filename, &bytes, |copied, total| {
                    report_progress(&progress, &canceled, copied, total)
                })
            })
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

#[tauri::command]
pub async fn upload_drive_file(
    webview: tauri::Webview,
    source: String,
    request_id: String,
    destination: ticketd_core::drive::DriveUploadDestination,
    progress: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Attachment, BridgeFailure> {
    let progress = progress.map(|channel| channel.channel_on(webview));
    let (guard, canceled) = start_upload(&request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let transport = ticketd_core::drive::GoogleTransport::default();
        let provider = ticketd_core::drive::GoogleDrive::new(
            &destination.connection_id,
            &ticketd_core::drive::PlatformCredentialStore,
            &transport,
        );
        open_workspace()
            .and_then(|mut w| {
                w.upload_drive_file(
                    &request_id,
                    source,
                    &destination,
                    &provider,
                    |copied, total| report_progress(&progress, &canceled, copied, total),
                )
            })
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

#[tauri::command]
pub async fn import_attachment(
    webview: tauri::Webview,
    source: String,
    request_id: String,
    progress: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Attachment, BridgeFailure> {
    let progress = progress.map(|channel| channel.channel_on(webview));
    let (guard, canceled) = start_upload(&request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        open_workspace()
            .and_then(|mut w| {
                w.import_attachment_with_progress(&request_id, source, None, |copied, total| {
                    report_progress(&progress, &canceled, copied, total)
                })
            })
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

#[tauri::command(async)]
pub fn list_attachments(limit: u32, offset: u32) -> Result<Vec<Attachment>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachments(limit, offset))
        .map_err(BridgeFailure::from)
}

#[tauri::command]
pub async fn search_attachments(
    query: ticketd_core::AttachmentQuery,
) -> Result<Vec<ticketd_core::AttachmentSearchResult>, BridgeFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|w| w.search_attachments(&query))
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

#[tauri::command]
pub async fn rename_attachment(
    id: String,
    display_name: String,
    request_id: String,
) -> Result<Attachment, BridgeFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        match open_workspace()
            .and_then(|mut w| {
                w.write(
                    Some(&request_id),
                    WriteRequest::RenameAttachment { id, display_name },
                )
            })
            .map_err(BridgeFailure::from)?
        {
            WriteResult::Attachment(file) => Ok(file),
            _ => Err("Unexpected attachment rename result".into()),
        }
    })
    .await
    .map_err(BridgeFailure::from)?
}

#[tauri::command(async)]
pub fn inspect_attachment(id: String) -> Result<Attachment, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachment(&id))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn ticket_attachments(reference: String) -> Result<Vec<Attachment>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.ticket_attachments(&reference))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn set_ticket_attachment(
    reference: String,
    attachment_id: String,
    present: bool,
    request_id: String,
) -> Result<Ticket, BridgeFailure> {
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
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected attachment association result".into()),
    }
}

#[tauri::command(async)]
pub fn replace_ticket_attachment(
    reference: String,
    previous_id: String,
    replacement_id: String,
    request_id: String,
) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::ReplaceTicketAttachment {
                    reference,
                    previous_id,
                    replacement_id,
                },
            )
        })
        .map(|_| ())
        .map_err(BridgeFailure::from)
}

#[tauri::command]
pub async fn export_attachment(id: String, destination: String) -> Result<(), BridgeFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace()
            .and_then(|w| w.export_attachment(&id, destination))
            .map_err(BridgeFailure::from)
    })
    .await
    .map_err(BridgeFailure::from)?
}

#[tauri::command(async)]
pub fn open_attachment(app: tauri::AppHandle, id: String) -> Result<(), BridgeFailure> {
    let target = open_workspace()
        .and_then(|workspace| workspace.attachment_open_target(&id))
        .map_err(BridgeFailure::from)?;
    match target {
        ticketd_core::AttachmentOpenTarget::LocalPath(path) => app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(BridgeFailure::from),
        ticketd_core::AttachmentOpenTarget::ExternalUrl(url) => app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "could not open this file in Drive".into()),
    }
}

#[tauri::command(async)]
pub fn attachment_uri(id: String) -> Result<String, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.attachment_uri(&id))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
pub fn resolve_attachment_uri(uri: String) -> Result<Attachment, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.resolve_attachment_uri(&uri))
        .map_err(BridgeFailure::from)
}
