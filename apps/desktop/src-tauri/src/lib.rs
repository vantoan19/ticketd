//! Desktop adapter for the shared ticketd core.
mod agent_skills;
mod attachment_commands;
mod attachment_media;
mod automation_commands;
mod automation_runner;
#[cfg(target_os = "linux")]
mod chat_clipboard;
mod chat_commands;
mod chat_reports;
mod chat_ticketd;
mod chat_view;
mod chats;
mod cli_status;
mod diagnostics_commands;
mod drive_commands;
mod folder_probe;
mod notification_permission;
mod restore_points;
#[cfg(test)]
mod runtime_trace;
mod s3_commands;
mod s3_storage;
mod sync_commands;
mod sync_scheduler;
mod updates;
mod wake;
mod webview_report;
mod workspace_session;

use ticketd_core::{
    Activity, ActivityPatch, BackupInspection, BatchOperation, ContextGraph, ContextGraphPage,
    CurrentWork, DependencyGraph, Document, DocumentPatch, DocumentSearchResult, DocumentSummary,
    Evidence, EvidenceInput, HistoryEntry, InboxEntry, LatestUpdate, MetadataSelection, Plan,
    PlanView, Project, ProjectArchiveOutcome, ProjectRemoteChange, SidebarCounts, Status,
    StatusCounts, Ticket, TicketChange, TicketFilter, TicketPatch, Workspace, WorkspaceGraph,
    WorkspaceGraphRequest, WorkspaceInfo, WriteRequest, WriteResult,
    source::{ExtensionRegistry, RefreshControl, RefreshProgress},
};

/// A failure the interface acts on by kind. The message is only for reading, so
/// the interface never has to parse it to decide what to do; it keeps the
/// underlying cause for the interface's "Details".
#[derive(Debug, serde::Serialize)]
pub(crate) struct BridgeFailure {
    /// The core's [`ticketd_core::FailureKind`] code (such as `workspace_read_only`,
    /// `not_found` or `cycle`), a source or publication code, `batch_operation`
    /// (see `index` and `cause`), `review_changed`, `review_mode`, or `failed`.
    code: &'static str,
    /// For `batch_operation`, which operation of the batch was rejected.
    index: Option<usize>,
    /// For `batch_operation`, the kind of the rejected operation's failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    cause: Option<&'static str>,
    message: String,
}

impl BridgeFailure {
    pub(crate) fn plain(message: &str) -> Self {
        Self::coded("failed", message.into())
    }

    fn coded(code: &'static str, message: String) -> Self {
        Self {
            code,
            index: None,
            cause: None,
            message,
        }
    }
}

impl std::fmt::Display for BridgeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// A message the desktop wrote itself, such as an unexpected result.
impl From<String> for BridgeFailure {
    fn from(message: String) -> Self {
        Self::coded("failed", message)
    }
}

impl From<&str> for BridgeFailure {
    fn from(message: &str) -> Self {
        Self::plain(message)
    }
}

/// Failures from the desktop host itself (windows, IPC, the opener) have no domain kind.
macro_rules! plain_failure {
    ($($error:ty),* $(,)?) => {$(
        impl From<$error> for BridgeFailure {
            fn from(error: $error) -> Self {
                Self::coded("failed", error.to_string())
            }
        }
    )*};
}
plain_failure!(
    tauri::Error,
    tauri_plugin_opener::Error,
    serde_json::Error,
    tauri::http::header::ToStrError,
);

impl<T> From<std::sync::PoisonError<T>> for BridgeFailure {
    fn from(error: std::sync::PoisonError<T>) -> Self {
        Self::coded("failed", error.to_string())
    }
}

impl From<ticketd_core::drive::DriveError> for BridgeFailure {
    fn from(error: ticketd_core::drive::DriveError) -> Self {
        let message = error.message.clone();
        Self::coded(ticketd_core::Error::Drive(error).kind().code(), message)
    }
}

impl From<ticketd_core::Error> for BridgeFailure {
    fn from(error: ticketd_core::Error) -> Self {
        match error {
            ticketd_core::Error::BatchOperation { index, source } => Self {
                code: "batch_operation",
                index: Some(index),
                cause: Some(source.kind().code()),
                message: source.to_string(),
            },
            ticketd_core::Error::DependencyReviewChanged
            | ticketd_core::Error::SyncReviewChanged => {
                Self::coded("review_changed", error.to_string())
            }
            ticketd_core::Error::DependencyReviewMode(_) => {
                Self::coded("review_mode", error.to_string())
            }
            ticketd_core::Error::Source(ref source) => Self::coded(
                source.code(),
                source.message_for(ticketd_core::source::Surface::Desktop),
            ),
            ticketd_core::Error::Publication(ref publication) => {
                Self::coded(publication.code(), error.to_string())
            }
            ticketd_core::Error::InvalidProjectRemote => {
                Self::coded("invalid_project_remote", error.to_string())
            }
            ticketd_core::Error::ProjectRemoteTaken { .. } => {
                Self::coded("project_remote_taken", error.to_string())
            }
            ticketd_core::Error::ProjectCheckoutRequired(_) => {
                Self::coded("project_checkout_required", error.to_string())
            }
            ticketd_core::Error::SourceRepositoryNotListed(_) => {
                Self::coded("source_repository_not_listed", error.to_string())
            }
            ticketd_core::Error::ProjectSourceHostMismatch { .. } => {
                Self::coded("project_source_host_mismatch", error.to_string())
            }
            other => Self::coded(other.kind().code(), other.to_string()),
        }
    }
}

static SESSION: workspace_session::Session = workspace_session::Session::new();

/// The workspace for one command, as the person using the desktop: their own changes
/// do not notify them.
fn open_workspace() -> Result<ticketd_core::WorkspaceGuard, ticketd_core::Error> {
    SESSION.open(Workspace::open_default)
}

/// The desktop's warm session, for work that replaces the workspace file.
fn workspace_session() -> Result<std::sync::Arc<ticketd_core::WorkspaceSession>, ticketd_core::Error>
{
    SESSION.session(Workspace::open_default)
}

#[tauri::command(async)]
fn recent_documents(
    offset: u32,
    include_support: bool,
) -> Result<Vec<DocumentSummary>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.recent_documents_including_support(50, offset, include_support))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn pinned_documents(offset: u32) -> Result<Vec<DocumentSummary>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.pinned_documents(50, offset))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn search_documents(
    query: String,
    tag: Option<String>,
    offset: u32,
    include_support: bool,
) -> Result<Vec<DocumentSearchResult>, BridgeFailure> {
    open_workspace()
        .and_then(|w| {
            w.search_documents_including_support(
                &query,
                tag.as_deref(),
                50,
                offset,
                include_support,
            )
        })
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn keep_document(id: String, request_id: String) -> Result<Document, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), WriteRequest::KeepDocument { id }))
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Document(document) => Ok(document),
        _ => Err("Unexpected document result".into()),
    }
}
#[tauri::command(async)]
fn set_document_pin(id: String, pinned: bool) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.set_document_pin(&id, pinned))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn document_tags(id: String) -> Result<Vec<String>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.document_tags(&id))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_document_tag(id: String, tag: String, present: bool) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.set_document_tag(&id, &tag, present))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn all_documents(
    offset: u32,
    include_support: bool,
) -> Result<Vec<DocumentSummary>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.all_documents_page(50, offset, include_support))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn current_work_documents(include_support: bool) -> Result<CurrentWork, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.current_work(include_support))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn finished_documents(
    offset: u32,
    include_support: bool,
) -> Result<Vec<DocumentSummary>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.finished_documents_page(50, offset, include_support))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn unlinked_documents(
    offset: u32,
    include_support: bool,
) -> Result<Vec<DocumentSummary>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.unlinked_documents_page(50, offset, include_support))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn documents_by_title(
    offset: u32,
    include_support: bool,
) -> Result<Vec<DocumentSummary>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.documents_by_title_page(50, offset, include_support))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn trashed_documents(offset: u32) -> Result<Vec<DocumentSummary>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.trashed_documents_page(50, offset))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_document_trashed(
    id: String,
    trashed: bool,
    request_id: String,
) -> Result<Document, BridgeFailure> {
    let request = if trashed {
        WriteRequest::TrashDocument { id }
    } else {
        WriteRequest::RestoreDocument { id }
    };
    match open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), request))
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Document(document) => Ok(document),
        _ => Err("Unexpected document result".into()),
    }
}
#[tauri::command(async)]
fn show_document(id: String) -> Result<Document, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.show_document(&id))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn document_row(id: String) -> Result<DocumentSummary, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.document_row(&id))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn document_version(id: String) -> Result<(String, bool), BridgeFailure> {
    open_workspace()
        .and_then(|w| w.document_version(&id))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn open_document(id: String) -> Result<Document, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.open_document(&id))
        .map_err(BridgeFailure::from)
}
/// The first save of a new Document keeps the summary typed before it.
fn create_document_request(
    title: Option<String>,
    summary: Option<String>,
    body: Option<String>,
) -> WriteRequest {
    WriteRequest::CreateDocument {
        title,
        summary,
        body: body.unwrap_or_default(),
    }
}

#[tauri::command(async)]
fn save_document(
    id: Option<String>,
    title: Option<String>,
    body: Option<String>,
    title_changed: bool,
    expected_updated_at: Option<String>,
    request_id: String,
    // Absent keeps the stored summary; an empty value clears it.
    summary: Option<String>,
) -> Result<Document, BridgeFailure> {
    // Autosaving an existing Document is last-write-wins and idempotent, so it skips the
    // replay record that would otherwise keep a full copy of every autosaved body forever.
    // Creating still uses the request ID, because a repeated create would duplicate.
    let Some(id) = id else {
        let request = create_document_request(title, summary, body);
        return match open_workspace()
            .and_then(|mut w| w.write(Some(&request_id), request))
            .map_err(BridgeFailure::from)?
        {
            WriteResult::Document(document) => Ok(document),
            _ => Err("Unexpected save result".into()),
        };
    };
    let patch = DocumentPatch {
        title: title_changed.then_some(title),
        body,
        summary: summary.map(Some),
        expected_updated_at,
    };
    open_workspace()
        .and_then(|mut w| w.change_document(&id, patch))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn context_link_markdown(reference: String) -> Result<String, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.context_link_markdown(&reference))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn document_context_links(
    id: String,
    offset: Option<u32>,
) -> Result<
    (
        Vec<ticketd_core::ContextLink>,
        Vec<ticketd_core::ContextLink>,
    ),
    BridgeFailure,
> {
    open_workspace()
        .and_then(|w| {
            let offset = offset.unwrap_or(0);
            let mut backlinks = w.context_backlinks(&id, 100, offset)?;
            // A Plan the Document is attached to is a connection even though no Markdown
            // link states it. The designated spec is not `explicit`; a supporting
            // Document is, because a person attached it.
            if offset == 0 {
                for (plan, spec) in w.document_plans(&id)? {
                    backlinks.push(ticketd_core::ContextLink {
                        activity_id: None,
                        source_id: plan.id,
                        target_id: id.clone(),
                        source_kind: "plan".into(),
                        target_kind: "document".into(),
                        passage: String::new(),
                        source_label: plan.name,
                        target_label: String::new(),
                        source_trashed: false,
                        target_trashed: false,
                        explicit: !spec,
                    });
                }
            }
            Ok((w.context_links(&id, 100, 0)?, backlinks))
        })
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn ticket_from_document(
    id: String,
    title: String,
    request_id: String,
    follow: Option<bool>,
) -> Result<ticketd_core::Ticket, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::CreateTicketFromDocument {
                    id,
                    title,
                    follow: follow.unwrap_or(false),
                },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected ticket result".into()),
    }
}

#[tauri::command(async)]
fn reminder(reference: String) -> Result<Option<String>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.reminder(&reference))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_reminder(
    reference: String,
    due_at: Option<String>,
    request_id: String,
) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::SetReminder { reference, due_at },
            )
        })
        .map(|_| ())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn inbox(
    offset: u32,
    limit: Option<u32>,
    unread_only: Option<bool>,
) -> Result<Vec<InboxEntry>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.inbox_page(limit.unwrap_or(100), offset, unread_only.unwrap_or(false)))
        .map_err(BridgeFailure::from)
}
/// The interface's change poll (ADR 0013) is also how the background loops learn
/// that the Workspace changed: a token that moved since the last read wakes them.
#[tauri::command(async)]
fn workspace_change_token() -> Result<i64, BridgeFailure> {
    static LAST: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(i64::MIN);
    let token = open_workspace().and_then(|w| w.change_token())?;
    if LAST.swap(token, std::sync::atomic::Ordering::SeqCst) != token {
        wake::CHANGED.notify();
    }
    Ok(token)
}
#[tauri::command(async)]
fn sidebar_counts() -> Result<SidebarCounts, BridgeFailure> {
    open_workspace()
        .and_then(|w| {
            let mut counts = w.sidebar_counts()?;
            // The Inbox lists what sync needs read beside its own entries.
            counts.unread_inbox += sync_commands::unread(&w)?;
            Ok(counts)
        })
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn is_following(reference: String) -> Result<bool, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.is_following(&reference))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_following(
    reference: String,
    following: bool,
    request_id: String,
) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::SetFollowing {
                    reference,
                    following,
                },
            )
        })
        .map(|_| ())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_inbox_read(ids: Vec<i64>, read: bool, request_id: String) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), WriteRequest::SetInboxRead { ids, read }))
        .map(|_| ())
        .map_err(BridgeFailure::from)
}

// `async` commands run off the main thread, so a slow integrity check or copy
// of a large workspace file does not freeze the window.
#[tauri::command(async)]
fn export_workspace(path: String) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|workspace| workspace.export_file(path))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn list_projects() -> Result<Vec<Project>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.list_projects())
        .map_err(BridgeFailure::from)
}
/// The favicon a Project's folder ships, probed now and never stored. `None` when no
/// checkout has one, so the Project shows its letter tile.
#[tauri::command(async)]
fn project_icon(id: String) -> Result<Option<folder_probe::Favicon>, BridgeFailure> {
    let project = open_workspace()
        .and_then(|w| w.show_project(&id))
        .map_err(BridgeFailure::from)?;
    Ok(std::iter::once(&project.path)
        .chain(&project.paths)
        .find_map(|path| folder_probe::favicon(std::path::Path::new(path))))
}
#[tauri::command(async)]
fn detect_project_remote(path: String) -> ticketd_core::ProjectRemoteDetection {
    ticketd_core::detect_project_remote(std::path::Path::new(&path))
}

#[tauri::command(async)]
fn create_project(
    name: String,
    path: String,
    remote: Option<String>,
) -> Result<Project, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.create_project_with_remote(&name, &path, remote.as_deref()))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn edit_project(
    id: String,
    name: String,
    path: String,
    remote: Option<String>,
    clear_remote: Option<bool>,
) -> Result<Project, BridgeFailure> {
    let remote = match (remote.as_deref(), clear_remote.unwrap_or(false)) {
        (Some(_), true) => {
            return Err(BridgeFailure::plain(
                "Choose one change to the Project remote.",
            ));
        }
        (Some(remote), false) => ProjectRemoteChange::Set(remote),
        (None, true) => ProjectRemoteChange::Clear,
        (None, false) => ProjectRemoteChange::Keep,
    };
    open_workspace()
        .and_then(|mut w| w.edit_project_with_remote(&id, &name, &path, remote))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn set_project_archived(
    id: String,
    archived: bool,
    expected_change: Option<String>,
) -> Result<ProjectArchiveOutcome, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.change_project_archive(&id, archived, expected_change.as_deref()))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn project_source_candidates(
    project_id: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Vec<ticketd_core::source::ProjectSourceCandidate>, BridgeFailure> {
    let engine = sources.engine().map_err(ticketd_core::Error::from)?;
    Ok(open_workspace()?.project_source_candidates(&engine, &project_id)?)
}

#[tauri::command(async)]
fn preview_connect_source(
    source: String,
    project_id: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::ConnectSourcePreview, BridgeFailure> {
    let engine = sources.engine().map_err(ticketd_core::Error::from)?;
    Ok(open_workspace()?.preview_connect_source(&engine, &source, &project_id)?)
}

#[tauri::command(async)]
fn connect_source_match_count(
    source: String,
    project_id: String,
    expected_fingerprint: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Option<ticketd_core::source::ConnectSourceMatchCount>, BridgeFailure> {
    let engine = sources.engine().map_err(ticketd_core::Error::from)?;
    Ok(open_workspace()?.connect_source_match_count(
        &engine,
        &source,
        &project_id,
        &expected_fingerprint,
    )?)
}

#[tauri::command(async)]
fn connect_source(
    source: String,
    project_id: String,
    expected_fingerprint: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::ConnectSourceOutcome, BridgeFailure> {
    let engine = sources.engine().map_err(ticketd_core::Error::from)?;
    Ok(open_workspace()?.connect_source(&engine, &source, &project_id, &expected_fingerprint)?)
}

#[tauri::command(async)]
fn context_graph(reference: String, include_details: bool) -> Result<ContextGraph, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.context_graph(&reference, include_details))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn workspace_graph(request: WorkspaceGraphRequest) -> Result<WorkspaceGraph, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.workspace_graph(&request))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn context_graph_expanded(
    reference: String,
    include_details: bool,
    expanded_ids: Vec<String>,
    pages: Vec<ContextGraphPage>,
) -> Result<ContextGraph, BridgeFailure> {
    open_workspace()
        .and_then(|w| {
            w.context_graph_with_pages(&reference, include_details, &expanded_ids, &pages)
        })
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn dependency_graph(reference: String) -> Result<DependencyGraph, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.dependency_graph(&reference))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn plan_dependency_graph(id: String) -> Result<DependencyGraph, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.plan_dependency_graph(&id))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn ticket_backlinks(
    reference: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<ticketd_core::Backlink>, BridgeFailure> {
    open_workspace()
        .and_then(|workspace| workspace.backlinks(&reference, limit, offset))
        .map_err(BridgeFailure::from)
}

/// The source's comments and events retrieved for a ticket (read-only).
#[tauri::command(async)]
fn source_conversation(
    reference: String,
) -> Result<Vec<ticketd_core::source::ConversationEntry>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.source_conversation(&reference))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn show_ticket(reference: String) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.show_ticket(&reference))
        .map_err(BridgeFailure::from)
}

#[derive(serde::Serialize)]
#[serde(untagged)]
enum TicketPage {
    Full(Vec<ticketd_core::TicketWithUpdate>),
    Metadata(ticketd_core::TicketMetadataPage),
}
#[tauri::command(async)]
fn find_tickets_with_updates(
    filter: TicketFilter,
    projection: Option<String>,
    ids: Option<Vec<String>>,
    references: Option<Vec<String>>,
) -> Result<TicketPage, BridgeFailure> {
    if projection
        .as_deref()
        .is_some_and(|value| value != "metadata" && value != "flow")
    {
        return Err("Unknown Ticket projection".into());
    }
    let selection = match (ids.as_deref(), references.as_deref()) {
        (Some(_), Some(_)) => return Err("Name tickets by id or by reference, not both".into()),
        (Some(ids), None) => Some(MetadataSelection::Ids(ids)),
        (None, Some(references)) => Some(MetadataSelection::References(references)),
        (None, None) => None,
    };
    open_workspace()
        .and_then(|w| match projection.as_deref() {
            Some(value) => w
                .find_ticket_metadata(&filter, selection, value == "flow")
                .map(TicketPage::Metadata),
            None => w.find_tickets_with_updates(&filter).map(TicketPage::Full),
        })
        .map_err(BridgeFailure::from)
}
/// Every Inbox entry with whether it still needs the person, in one read.
#[tauri::command(async)]
fn inbox_attention() -> Result<ticketd_core::InboxAttention, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.inbox_attention())
        .map_err(BridgeFailure::from)
}
/// A page of list or board rows: what `find_tickets_with_updates` finds, without bodies.
#[tauri::command(async)]
fn find_ticket_rows(filter: TicketFilter) -> Result<Vec<ticketd_core::TicketRow>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.find_ticket_rows(&filter))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn count_tickets(filter: TicketFilter) -> Result<StatusCounts, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.count_tickets(&filter))
        .map_err(BridgeFailure::from)
}
/// How many tickets each source filter (All, a provider, Local) would show.
#[tauri::command(async)]
fn count_by_source(
    filter: TicketFilter,
) -> Result<ticketd_core::source::SourceCounts, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.count_by_source(&filter))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn search_tickets(
    query: String,
    project: Option<String>,
    unlinked: bool,
    limit: u32,
    offset: u32,
) -> Result<Vec<Ticket>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.search_tickets(&query, project.as_deref(), unlinked, limit, offset))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn list_trash() -> Result<Vec<Ticket>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.list_trash())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_trashed(reference: String, trashed: bool) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.set_trashed(&reference, trashed, None))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn register_checkout(id: String, path: String) -> Result<Project, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.register_checkout(&id, &path))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn remove_checkout(id: String, path: String) -> Result<Project, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.remove_checkout(&id, &path))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // Preserve named IPC fields while adding an optional retry ID.
fn create_ticket(
    title: String,
    body: String,
    status: Status,
    project_id: Option<String>,
    plan_id: Option<String>,
    tags: Vec<String>,
    follow: bool,
    request_id: Option<String>,
    blockers: Option<Vec<String>>,
) -> Result<Ticket, BridgeFailure> {
    match open_workspace()
        .and_then(|mut workspace| {
            workspace.write(
                request_id.as_deref(),
                WriteRequest::CreateTicketWithContent {
                    title,
                    body,
                    status,
                    project_id,
                    plan_id,
                    tags,
                    follow,
                    blockers: blockers.unwrap_or_default(),
                },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected ticket creation result".into()),
    }
}

#[tauri::command(async)]
fn bulk_change(
    references: Vec<String>,
    change: TicketChange,
    request_id: String,
) -> Result<Vec<Ticket>, BridgeFailure> {
    let operations = references
        .into_iter()
        .map(|ticket| BatchOperation::Change {
            ticket,
            change: Box::new(change.clone()),
        })
        .collect();
    match open_workspace()
        .and_then(|mut workspace| {
            workspace.write(Some(&request_id), WriteRequest::Batch { operations })
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Tickets(tickets) => Ok(tickets),
        _ => Err(BridgeFailure::plain("Unexpected batch result")),
    }
}

#[tauri::command(async)]
fn bulk_status(
    references: Vec<String>,
    status: Status,
    request_id: String,
) -> Result<Vec<Ticket>, BridgeFailure> {
    let operations = references
        .into_iter()
        .map(|ticket| BatchOperation::Change {
            ticket,
            change: Box::new(TicketChange {
                patch: TicketPatch {
                    status: Some(status),
                    ..Default::default()
                },
                ..Default::default()
            }),
        })
        .collect();
    match open_workspace()
        .and_then(|mut workspace| {
            workspace.write(Some(&request_id), WriteRequest::Batch { operations })
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Tickets(tickets) => Ok(tickets),
        _ => Err(BridgeFailure::plain("Unexpected batch result")),
    }
}

#[tauri::command(async)]
fn change_ticket(
    reference: String,
    patch: TicketPatch,
    request_id: Option<String>,
) -> Result<Ticket, BridgeFailure> {
    match open_workspace()
        .and_then(|mut workspace| {
            workspace.write(
                request_id.as_deref(),
                WriteRequest::ChangeTicket { reference, patch },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected ticket result".into()),
    }
}

#[tauri::command(async)]
fn ticket_history(reference: String) -> Result<Vec<HistoryEntry>, BridgeFailure> {
    open_workspace()
        .and_then(|workspace| workspace.ticket_history(&reference))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn list_evidence(reference: String, offset: u32) -> Result<Vec<Evidence>, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.evidence(&reference, 50, offset))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn add_evidence(
    reference: String,
    input: EvidenceInput,
    request_id: String,
) -> Result<Evidence, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::AddEvidence { reference, input },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Evidence(value) => Ok(value),
        _ => Err("Unexpected evidence result".into()),
    }
}
#[tauri::command(async)]
fn edit_evidence(
    reference: String,
    id: String,
    input: EvidenceInput,
    request_id: String,
) -> Result<Evidence, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::EditEvidence {
                    reference,
                    id,
                    input,
                },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Evidence(value) => Ok(value),
        _ => Err("Unexpected evidence result".into()),
    }
}
#[tauri::command(async)]
fn delete_evidence(reference: String, id: String, request_id: String) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::DeleteEvidence { reference, id },
            )
        })
        .map(|_| ())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn latest_update(reference: String) -> Result<Option<LatestUpdate>, BridgeFailure> {
    open_workspace()
        .and_then(|workspace| workspace.latest_update(&reference))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn activity_feed(
    reference: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<ticketd_core::ActivityFeedEntry>, BridgeFailure> {
    open_workspace()
        .and_then(|workspace| workspace.activity_feed(&reference, limit, offset))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn get_activity(reference: String, id: String) -> Result<Option<Activity>, BridgeFailure> {
    open_workspace()
        .and_then(|workspace| match workspace.activity(&reference, &id) {
            Ok(note) => Ok(Some(note)),
            Err(ticketd_core::Error::ActivityNotFound(_)) => Ok(None),
            Err(error) => Err(error),
        })
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn add_activity(reference: String, brief: String) -> Result<Activity, BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| {
            let activity = workspace.add_activity(&reference, &brief, None)?;
            workspace.discard_inbox_for_own_update(&activity.id)?;
            Ok(activity)
        })
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn add_activity_with_details(
    reference: String,
    brief: String,
    details: Option<String>,
    existing_document_id: Option<String>,
    request_id: String,
) -> Result<Activity, BridgeFailure> {
    let request = WriteRequest::AddActivityWithDetails {
        reference,
        brief,
        agent: None,
        details,
        existing_document_id,
    };
    let mut workspace = open_workspace().map_err(BridgeFailure::from)?;
    match workspace
        .write(Some(&request_id), request)
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Activity(activity) => {
            // The person who wrote it is not notified of their own update.
            workspace
                .discard_inbox_for_own_update(&activity.id)
                .map_err(BridgeFailure::from)?;
            Ok(activity)
        }
        _ => Err("Unexpected activity result".into()),
    }
}

#[tauri::command(async)]
fn edit_activity(
    reference: String,
    id: String,
    patch: ActivityPatch,
) -> Result<Activity, BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| workspace.edit_activity(&reference, &id, patch))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn delete_activity(reference: String, id: String) -> Result<(), BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| workspace.delete_activity(&reference, &id))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn search_tags(query: String) -> Result<Vec<String>, BridgeFailure> {
    open_workspace()
        .and_then(|workspace| workspace.search_tags(&query, 50))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn add_tag(reference: String, tag: String) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| workspace.add_tag(&reference, &tag))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn remove_tag(reference: String, tag: String) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| workspace.remove_tag(&reference, &tag))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn preview_duplicate_dependencies(
    source: String,
    canonical: String,
    separate: Option<bool>,
) -> Result<ticketd_core::DuplicateDependencyPreview, BridgeFailure> {
    open_workspace()
        .and_then(|workspace| {
            if separate.unwrap_or(false) {
                workspace.preview_dependency_move(&source, &canonical)
            } else {
                workspace.preview_duplicate_dependencies(&source, &canonical)
            }
        })
        .map_err(BridgeFailure::from)
}

/// What a whole set of choices does to each waiting ticket, for the review to show.
#[tauri::command(async)]
fn evaluate_dependency_review(
    source: String,
    canonical: String,
    separate: bool,
    decisions: Vec<ticketd_core::DependencyDecision>,
) -> Result<Vec<ticketd_core::WaitingOutcome>, BridgeFailure> {
    let mode = if separate {
        ticketd_core::ReviewMode::Separate
    } else {
        ticketd_core::ReviewMode::Duplicate
    };
    open_workspace()
        .and_then(|workspace| {
            workspace.evaluate_dependency_review(&source, &canonical, mode, &decisions)
        })
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn mark_duplicate_reviewed(
    source: String,
    canonical: String,
    expected_canonical: String,
    decisions: Vec<ticketd_core::DependencyDecision>,
    request_id: String,
) -> Result<Ticket, BridgeFailure> {
    let result = open_workspace()
        .and_then(|mut workspace| {
            workspace.write(
                Some(&request_id),
                WriteRequest::MarkDuplicateReviewed {
                    source,
                    canonical,
                    expected_canonical,
                    decisions,
                    agent: None,
                },
            )
        })
        .map_err(BridgeFailure::from)?;
    match result {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err(BridgeFailure::plain("Unexpected write result")),
    }
}

#[tauri::command(async)]
fn edit_dependencies_reviewed(
    source: String,
    canonical: String,
    expected_canonical: String,
    decisions: Vec<ticketd_core::DependencyDecision>,
    request_id: String,
) -> Result<Ticket, BridgeFailure> {
    let result = open_workspace()
        .and_then(|mut workspace| {
            workspace.write(
                Some(&request_id),
                WriteRequest::EditDependenciesReviewed {
                    source,
                    canonical,
                    expected_canonical,
                    decisions,
                    agent: None,
                },
            )
        })
        .map_err(BridgeFailure::from)?;
    match result {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err(BridgeFailure::plain("Unexpected write result")),
    }
}

#[tauri::command(async)]
fn remove_duplicate(source: String, request_id: String) -> Result<Ticket, BridgeFailure> {
    let result = open_workspace()
        .and_then(|mut workspace| {
            workspace.write(
                Some(&request_id),
                WriteRequest::RemoveDuplicate {
                    source,
                    agent: None,
                },
            )
        })
        .map_err(BridgeFailure::from)?;
    match result {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected write result".into()),
    }
}

#[tauri::command(async)]
fn take_ownership(reference: String, request_id: String) -> Result<Ticket, BridgeFailure> {
    let result = open_workspace()
        .and_then(|mut workspace| {
            workspace.write(
                Some(&request_id),
                WriteRequest::TakeOwnership {
                    reference,
                    agent: None,
                },
            )
        })
        .map_err(BridgeFailure::from)?;
    match result {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected write result".into()),
    }
}

#[tauri::command(async)]
fn contextual_relationships(
    reference: String,
    offset: u32,
) -> Result<ticketd_core::TicketContext, BridgeFailure> {
    open_workspace()
        .and_then(|w| {
            w.ticket_context(
                &reference,
                ticketd_core::ContextOptions {
                    relationships: true,
                    offset,
                    ..Default::default()
                },
            )
        })
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn change_contextual_relationship(
    source: String,
    target: String,
    kind: ticketd_core::RelationshipKind,
    add: bool,
    request_id: String,
) -> Result<Ticket, BridgeFailure> {
    let request = if add {
        WriteRequest::AddContextualRelationship {
            source,
            target,
            kind,
            agent: None,
        }
    } else {
        WriteRequest::RemoveContextualRelationship {
            source,
            target,
            kind,
            agent: None,
        }
    };
    match open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), request))
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected write result".into()),
    }
}

#[tauri::command(async)]
fn add_dependency(blocker: String, dependent: String) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| workspace.add_dependency(&blocker, &dependent, None))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn remove_dependency(blocker: String, dependent: String) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| workspace.remove_dependency(&blocker, &dependent, None))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn detach_child(parent: String, child: String) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.detach_child(&parent, &child, None))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_parent(reference: String, parent: Option<String>) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut workspace| workspace.set_parent(&reference, parent.as_deref(), None))
        .map_err(BridgeFailure::from)
}

#[tauri::command(async)]
fn list_plans(limit: Option<u32>, offset: Option<u32>) -> Result<Vec<Plan>, BridgeFailure> {
    open_workspace()
        .and_then(|w| {
            w.list_plans_bounded(true, limit.map(|value| value.min(100)), offset.unwrap_or(0))
        })
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_plan_document(
    plan_id: String,
    document_id: String,
    present: bool,
    request_id: String,
) -> Result<Plan, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::SetPlanDocument {
                    plan_id,
                    document_id,
                    present,
                },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Plan(plan) => Ok(plan),
        _ => Err("Unexpected Plan result".into()),
    }
}

#[tauri::command(async)]
fn set_ticket_document(
    reference: String,
    document_id: String,
    present: bool,
    request_id: String,
) -> Result<Ticket, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::SetTicketDocument {
                    reference,
                    document_id,
                    present,
                },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected ticket result".into()),
    }
}

#[tauri::command(async)]
fn set_plan_spec(
    plan_id: String,
    document_id: Option<String>,
    request_id: String,
) -> Result<Plan, BridgeFailure> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::SetPlanSpec {
                    plan_id,
                    document_id,
                },
            )
        })
        .map_err(BridgeFailure::from)?
    {
        WriteResult::Plan(plan) => Ok(plan),
        _ => Err("Unexpected Plan result".into()),
    }
}

#[tauri::command(async)]
fn show_plan(
    id: String,
    limit: Option<u32>,
    offset: Option<u32>,
    include_members: Option<bool>,
) -> Result<PlanView, BridgeFailure> {
    open_workspace()
        .and_then(|w| {
            w.show_plan_bounded(
                &id,
                limit.map(|value| value.min(501)),
                offset.unwrap_or(0),
                include_members.unwrap_or(true),
            )
        })
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn create_plan(name: String) -> Result<Plan, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.create_plan(&name))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn change_plan(
    id: String,
    name: Option<String>,
    archived: Option<bool>,
) -> Result<Plan, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.change_plan(&id, name.as_deref(), archived))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_plan_purpose(id: String, purpose: String) -> Result<Plan, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.set_plan_purpose(&id, &purpose))
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn set_plan(reference: String, plan: Option<String>) -> Result<Ticket, BridgeFailure> {
    open_workspace()
        .and_then(|mut w| w.set_plan(&reference, plan.as_deref(), None))
        .map_err(BridgeFailure::from)
}

/// Where the workspace file is, read without opening it: the startup recovery
/// screen names the file even when it cannot be opened.
#[tauri::command(async)]
fn workspace_location() -> Result<String, BridgeFailure> {
    ticketd_core::default_workspace_path()
        .map(|path| path.display().to_string())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn workspace_info() -> Result<WorkspaceInfo, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.workspace_info())
        .map_err(BridgeFailure::from)
}
#[tauri::command(async)]
fn inspect_backup(path: String) -> Result<BackupInspection, BridgeFailure> {
    open_workspace()
        .and_then(|w| w.inspect_backup(path))
        .map_err(BridgeFailure::from)
}

/// A source operation that failed. `code` is the core's stable kind, and
/// `fields` carries per-field validation problems when the settings were invalid.
#[derive(Debug, serde::Serialize)]
struct SourceFailure {
    code: &'static str,
    message: String,
    fields: Vec<ticketd_core::source::FieldIssue>,
}

impl From<ticketd_core::Error> for SourceFailure {
    fn from(error: ticketd_core::Error) -> Self {
        match error {
            ticketd_core::Error::Source(source) => Self {
                code: source.code(),
                fields: source.issues().to_vec(),
                message: source.message_for(ticketd_core::source::Surface::Desktop),
            },
            ticketd_core::Error::Publication(publication) => Self {
                code: publication.code(),
                fields: Vec::new(),
                message: publication.to_string(),
            },
            other => Self {
                code: "failed",
                message: other.to_string(),
                fields: Vec::new(),
            },
        }
    }
}

impl From<ticketd_core::source::SourceError> for SourceFailure {
    fn from(error: ticketd_core::source::SourceError) -> Self {
        ticketd_core::Error::from(error).into()
    }
}

#[derive(serde::Serialize)]
struct SourceEntry {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    development: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    unavailable: bool,
    connector: ticketd_core::source::SourceDescription,
    saved: Option<ticketd_core::source::SavedSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_id: Option<String>,
}

type SourceRegistry = std::sync::Arc<ExtensionRegistry>;

async fn source_task<T: Send + 'static>(
    sources: tauri::State<'_, SourceRegistry>,
    operation: impl FnOnce(&ExtensionRegistry) -> Result<T, SourceFailure> + Send + 'static,
) -> Result<T, SourceFailure> {
    let registry = sources.inner().clone();
    tauri::async_runtime::spawn_blocking(move || operation(&registry))
        .await
        .map_err(|error| SourceFailure {
            code: "failed",
            message: error.to_string(),
            fields: Vec::new(),
        })?
}

/// The available connectors and each of their device-local connections.
#[tauri::command(async)]
fn list_sources(
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Vec<SourceEntry>, SourceFailure> {
    let workspace = open_workspace()?;
    let engine = sources.engine()?;
    let saved = workspace.saved_sources()?;
    let mut entries = Vec::new();
    for connector in engine.descriptions() {
        let provider = &connector.descriptor.provider;
        let next_id = workspace.next_source_connection_id(provider)?;
        let development = sources.is_development(provider);
        let first = entries.len();
        entries.extend(
            saved
                .iter()
                .filter(|source| &source.provider == provider)
                .map(|source| SourceEntry {
                    development,
                    unavailable: false,
                    connector: connector.clone(),
                    saved: Some(source.clone()),
                    next_id: Some(next_id.clone()),
                }),
        );
        if entries.len() == first {
            entries.push(SourceEntry {
                development,
                unavailable: false,
                connector,
                saved: None,
                next_id: Some(next_id),
            });
        }
    }
    for source in saved {
        if engine.description(&source.provider).is_err() {
            entries.push(SourceEntry {
                development: false,
                unavailable: true,
                connector: workspace.unavailable_source_description(&source.provider)?,
                saved: Some(source),
                next_id: None,
            });
        }
    }
    Ok(entries)
}
#[tauri::command(async)]
fn source_repository_routes(
    connection: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Vec<ticketd_core::source::SourceRepositoryRoute>, BridgeFailure> {
    let engine = sources.engine().map_err(ticketd_core::Error::from)?;
    Ok(open_workspace()?.source_repository_routes(&engine, &connection)?)
}
#[tauri::command(async)]
fn link_source_repository_project(
    connection: String,
    repository: String,
    project_id: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Project, BridgeFailure> {
    let engine = sources.engine().map_err(ticketd_core::Error::from)?;
    Ok(open_workspace()?.link_source_repository_project(
        &engine,
        &connection,
        &repository,
        &project_id,
    )?)
}
#[tauri::command(async)]
fn create_source_repository_project(
    connection: String,
    repository: String,
    name: String,
    path: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Project, BridgeFailure> {
    let engine = sources.engine().map_err(ticketd_core::Error::from)?;
    Ok(open_workspace()?.create_source_repository_project(
        &engine,
        &connection,
        &repository,
        &name,
        &path,
    )?)
}
#[tauri::command]
async fn source_check_connection(
    provider: String,
    config: ticketd_core::source::ConfigValues,
    connection: Option<String>,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::ConnectionInfo, SourceFailure> {
    source_task(sources, move |registry| {
        let engine = registry.engine()?;
        let workspace = open_workspace()?;
        Ok(
            workspace.check_source_connection(
                &engine,
                &provider,
                connection.as_deref(),
                &config,
            )?,
        )
    })
    .await
}
#[tauri::command]
async fn source_options(
    provider: String,
    field: String,
    query: String,
    config: ticketd_core::source::ConfigValues,
    connection: Option<String>,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Vec<ticketd_core::source::ChoiceOption>, SourceFailure> {
    source_task(sources, move |registry| {
        let engine = registry.engine()?;
        let workspace = open_workspace()?;
        Ok(workspace.source_options(
            &engine,
            &provider,
            connection.as_deref(),
            &field,
            &query,
            &config,
        )?)
    })
    .await
}
#[tauri::command(async)]
fn source_configuration_summary(
    provider: String,
    config: ticketd_core::source::ConfigValues,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<Vec<ticketd_core::source::SummaryPart>, SourceFailure> {
    Ok(sources
        .engine()?
        .configuration_summary(&provider, &config)?)
}
#[tauri::command]
async fn source_preview(
    provider: String,
    config: ticketd_core::source::ConfigValues,
    connection: Option<String>,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::DiscoveryPreview, SourceFailure> {
    source_task(sources, move |registry| {
        let engine = registry.engine()?;
        let workspace = open_workspace()?;
        Ok(workspace.preview_source(&engine, &provider, connection.as_deref(), &config)?)
    })
    .await
}
#[tauri::command]
async fn save_source(
    provider: String,
    config: ticketd_core::source::ConfigValues,
    connection: Option<String>,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::SaveOutcome, SourceFailure> {
    source_task(sources, move |registry| {
        let mut workspace = open_workspace()?;
        let engine = registry.engine()?;
        match connection {
            Some(id) => Ok(workspace.update_source_connection(&engine, &id, &config)?),
            None => Ok(workspace.save_source(&engine, &provider, &config)?),
        }
    })
    .await
}
#[tauri::command]
async fn add_source_connection(
    provider: String,
    connection: String,
    name: String,
    config: ticketd_core::source::ConfigValues,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::SaveOutcome, SourceFailure> {
    source_task(sources, move |registry| {
        Ok(open_workspace()?.add_source_connection(
            &registry.engine()?,
            &provider,
            Some(&connection),
            Some(&name),
            &config,
        )?)
    })
    .await
}
#[tauri::command]
async fn update_source_credentials(
    connection: String,
    credentials: ticketd_core::source::ConfigValues,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::SavedSource, SourceFailure> {
    source_task(sources, move |registry| {
        Ok(open_workspace()?.update_source_credentials(
            &registry.engine()?,
            &connection,
            &credentials,
        )?)
    })
    .await
}
#[tauri::command(async)]
fn rename_source_connection(
    connection: String,
    name: String,
) -> Result<ticketd_core::source::SavedSource, SourceFailure> {
    Ok(open_workspace()?.rename_source(&connection, &name)?)
}

#[tauri::command]
async fn remove_source_connection(
    connection: String,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<(), SourceFailure> {
    source_task(sources, move |_| {
        Ok(open_workspace()?.remove_source_connection(&connection)?)
    })
    .await
}

/// The one refresh coordinator of this process: the startup and periodic runs and
/// every explicit refresh go through it, so they never overlap or retry in a tight loop.
struct Refresher(
    std::sync::Arc<ticketd_core::source::RefreshCoordinator>,
    ActiveRefreshes,
);

type ActiveRefreshes = std::sync::Mutex<std::collections::HashMap<String, RefreshControl>>;

struct RegisteredRefresh<'a> {
    id: String,
    active: &'a ActiveRefreshes,
    control: RefreshControl,
}

impl<'a> RegisteredRefresh<'a> {
    fn start(id: String, active: &'a ActiveRefreshes) -> Result<Self, SourceFailure> {
        use std::collections::hash_map::Entry;
        let mut running = active.lock().unwrap_or_else(|error| error.into_inner());
        if uuid::Uuid::parse_str(&id).is_ok()
            && let Entry::Vacant(entry) = running.entry(id.clone())
        {
            let control = RefreshControl::default();
            entry.insert(control.clone());
            return Ok(Self {
                id,
                active,
                control,
            });
        }
        Err(SourceFailure {
            code: "failed",
            message: "Invalid or already active source refresh ID".into(),
            fields: Vec::new(),
        })
    }
}

impl Drop for RegisteredRefresh<'_> {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
        self.control.cancel();
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RefreshUpdate {
    Started,
    Progress(RefreshProgress),
}

/// Imports matching issues and refreshes every externally owned ticket (or just `ticket`).
/// Provider calls finish before the workspace is written; per-ticket failures come back
/// in the report so the saved content stays visible beside the warning. An explicit
/// refresh waits for a running one instead of overlapping it.
#[tauri::command]
async fn refresh_sources(
    webview: tauri::Webview,
    ticket: Option<String>,
    connection: Option<String>,
    retry: Option<bool>,
    refresh_id: Option<String>,
    updates: Option<tauri::ipc::JavaScriptChannelId>,
    refresher: tauri::State<'_, Refresher>,
) -> Result<ticketd_core::source::RefreshReport, SourceFailure> {
    use tauri::Manager;

    let updates = updates.map(|channel| channel.channel_on(webview.clone()));
    let registration = refresh_id
        .map(|id| RegisteredRefresh::start(id, &refresher.1))
        .transpose()?;
    let coordinator = refresher.0.clone();
    let control = registration.as_ref().map(|run| run.control.clone());
    let progress = control.as_ref().map(RefreshControl::progress);
    let operation = source_task(webview.state(), move |registry| {
        if retry.unwrap_or(false) {
            let id = match (&connection, &ticket) {
                (Some(id), _) => Some(id.clone()),
                (None, Some(ticket)) => open_workspace()?.ticket_source_connection(ticket)?,
                (None, None) => None,
            };
            if let Some(id) = id {
                registry.retry(&id);
            }
        }
        let engine = registry.engine()?;
        let engine = if let Some(control) = control {
            engine.with_refresh_control(control)
        } else {
            engine
        };
        Ok(coordinator.refresh_connection_now(
            &engine,
            &open_workspace,
            connection.as_deref(),
            ticket.as_deref(),
        )?)
    });
    let (Some(updates), Some(mut progress)) = (updates, progress) else {
        return operation.await;
    };
    let _ = updates.send(RefreshUpdate::Started);
    tokio::pin!(operation);
    loop {
        tokio::select! {
            biased;
            Ok(()) = progress.changed() => {
                let update = *progress.borrow_and_update();
                if let Some(progress) = update {
                    let _ = updates.send(RefreshUpdate::Progress(progress));
                }
            }
            result = &mut operation => return result,
        }
    }
}

#[tauri::command]
fn cancel_source_refresh(refresh_id: String, refresher: tauri::State<'_, Refresher>) -> bool {
    let active = refresher
        .1
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(control) = active.get(&refresh_id) {
        control.cancel();
        return true;
    }
    false
}

/// What publishing would send, and whether it is allowed. No network, no write.
#[tauri::command(async)]
fn preview_publication(
    reference: String,
    provider: String,
    destination: Option<String>,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::PublicationPreview, SourceFailure> {
    let workspace = open_workspace()?;
    Ok(workspace.preview_publication(
        &sources.engine()?,
        &reference,
        &provider,
        destination.as_deref(),
    )?)
}

/// Publishes a local ticket once. The attempt is saved before the provider is called and
/// no database handle is held while waiting; an unknown outcome comes back as a
/// `publication_unresolved` failure and stays on the ticket.
#[tauri::command]
async fn publish_ticket(
    reference: String,
    provider: String,
    destination: Option<String>,
    expected_fingerprint: Option<String>,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::PublishOutcome, SourceFailure> {
    source_task(sources, move |registry| {
        let mut workspace = open_workspace()?;
        Ok(workspace.publish_ticket(
            &registry.engine()?,
            &reference,
            &ticketd_core::source::PublishOptions {
                connection: Some(provider),
                destination,
                now: None,
                expected_fingerprint,
                agent: None,
            },
        )?)
    })
    .await
}

/// What is known and unknown about an unresolved publication and which actions are
/// safe. With `search`, asks the source for issues that may be the one created; a
/// failed search is reported in the review, never read as "none".
#[tauri::command]
async fn review_publication(
    reference: String,
    search: bool,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::PublicationReview, SourceFailure> {
    source_task(sources, move |registry| {
        let workspace = open_workspace()?;
        Ok(workspace.review_publication(&registry.engine()?, &reference, search)?)
    })
    .await
}

/// Settles an unresolved publication: attach a verified issue, or confirm that
/// nothing was created. Evidence the source cannot give leaves it unresolved.
#[tauri::command]
async fn resolve_publication(
    reference: String,
    resolution: ticketd_core::source::Resolution,
    accept_different_content: Option<bool>,
    sources: tauri::State<'_, SourceRegistry>,
) -> Result<ticketd_core::source::PublishOutcome, SourceFailure> {
    source_task(sources, move |registry| {
        let mut workspace = open_workspace()?;
        Ok(workspace.resolve_publication(
            &registry.engine()?,
            &reference,
            &ticketd_core::source::ResolveOptions {
                resolution,
                now: None,
                agent: None,
                accept_different_content: accept_different_content.unwrap_or(false),
            },
        )?)
    })
    .await
}

#[derive(serde::Serialize)]
struct SourceHealth {
    /// A refresh is running now (startup, periodic or explicit).
    refreshing: bool,
    sources: Vec<ticketd_core::source::SourceStatus>,
    /// How often the periodic refresh runs while the app is open, in seconds.
    interval_secs: u64,
}

/// What the interface needs to say how fresh each source is: persisted status plus
/// whether a refresh is running. It does no network I/O.
#[tauri::command(async)]
fn source_health(refresher: tauri::State<'_, Refresher>) -> Result<SourceHealth, SourceFailure> {
    let sources = open_workspace()?.source_statuses()?;
    Ok(SourceHealth {
        refreshing: refresher.0.is_refreshing(),
        sources,
        interval_secs: ticketd_core::source::RefreshPolicy::default().interval_secs,
    })
}

/// Starts the periodic refresh while the desktop runs. It wakes every few seconds only
/// to ask the coordinator whether a run is due; nothing outlives the app.
fn start_periodic_refresh(
    coordinator: std::sync::Arc<ticketd_core::source::RefreshCoordinator>,
    sources: SourceRegistry,
) {
    let spawned = std::thread::Builder::new()
        .name("source-refresh".into())
        .spawn(move || {
            let mut reported: Option<String> = None;
            loop {
                // A source that fails is recorded per source by the refresh itself,
                // and the coordinator spaces the next attempt. What it cannot record
                // (the workspace would not open, the hold could not be read) is said
                // once on stderr, and again only if it changes or comes back.
                let tick = sources
                    .engine()
                    .map_err(ticketd_core::Error::from)
                    .and_then(|engine| coordinator.tick(&engine, &open_workspace));
                // Until the next refresh is due (it opens nothing before), at most
                // the idle fallback; a refresh that failed tries again after ten seconds.
                let wait = match &tick {
                    Ok(ticketd_core::source::Run::Skipped(
                        ticketd_core::source::Skip::NotDue { in_secs },
                    )) => std::time::Duration::from_secs(*in_secs).min(wake::IDLE),
                    _ => std::time::Duration::from_secs(10),
                };
                match tick {
                    Ok(_) => reported = None,
                    Err(error) => {
                        let message = error.to_string();
                        if reported.as_deref() != Some(message.as_str()) {
                            tracing::warn!(
                                error_kind = error.kind().code(),
                                "periodic source refresh could not run"
                            );
                            reported = Some(message);
                        }
                    }
                }
                std::thread::sleep(wait);
            }
        });
    if let Err(error) = spawned {
        tracing::error!(%error, "could not start periodic source refresh");
    }
}

/// Delivers reminders to the Inbox as they come due while the desktop runs. Reads never
/// deliver them, so the change poll stays off the write lock; this is the one writer, and
/// it takes the lock only when a reminder is due. It sleeps until the next reminder is
/// due, or a change (a reminder set or moved) wakes it. A delivery moves the change
/// token, so the views, and the reminder notification, follow at their next poll.
fn start_reminder_timer(
    open: impl Fn() -> Result<ticketd_core::WorkspaceGuard, ticketd_core::Error> + Send + 'static,
) {
    let spawned = std::thread::Builder::new()
        .name("reminders".into())
        .spawn(move || {
            let mut reported: Option<String> = None;
            let mut seen = 0;
            loop {
                let next = open().and_then(|mut w| {
                    w.deliver_due_reminders()?;
                    w.next_reminder_due_in()
                });
                let wait = match next {
                    Ok(next) => {
                        reported = None;
                        next.map_or(wake::IDLE, |due| due.min(wake::IDLE))
                    }
                    Err(error) => {
                        let message = error.to_string();
                        if reported.as_deref() != Some(message.as_str()) {
                            tracing::warn!(
                                error_kind = error.kind().code(),
                                %error,
                                "due reminders could not be delivered"
                            );
                            reported = Some(message);
                        }
                        wake::IDLE
                    }
                };
                wake::CHANGED.wait(&mut seen, wait);
            }
        });
    if let Err(error) = spawned {
        tracing::error!(%error, "could not start the reminder timer");
    }
}

/// The span a command handler runs in: the command's name, and the `request_id` when the
/// interface sent one with it (a write's request ID, which the core also records).
fn command_span(command: &str, payload: &tauri::ipc::InvokeBody) -> tracing::Span {
    let request_id = match payload {
        tauri::ipc::InvokeBody::Json(arguments) => arguments
            .get("requestId")
            .and_then(serde_json::Value::as_str),
        tauri::ipc::InvokeBody::Raw(_) => None,
    };
    tracing::debug_span!("command", command, request_id)
}

/// Runs each command handler inside a span named for the command, so the lines it logs say
/// which command they belong to.
///
/// The span is at `debug`: the interface's change poll is a command and runs every second,
/// so an `info` span would log a line for each one. Debug logging shows them.
///
/// Only the synchronous part of a command is inside the span. Tauri runs an `async`
/// command's future on its own runtime, where the handler cannot reach it, so for those the
/// span ends when the future is created: its close time is not the command's duration, and
/// lines the future logs later do not carry it. A command whose duration matters opens its
/// own span around its work.
fn traced<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let span = command_span(invoke.message.command(), invoke.message.payload());
        span.in_scope(|| handler(invoke))
    }
}

const QUIT_MENU_ID: &str = "quit";

/// Whether a request to exit the app must first go through the window's close
/// guard, which finishes uploads and shows what did not upload. With no window
/// left there is nobody to ask, and a restart is never held.
fn holds_exit(code: Option<i32>, window_open: bool) -> bool {
    window_open && code.is_some_and(|code| code != tauri::RESTART_EXIT_CODE)
}

/// Quits the way closing the window does, so every way out is guarded alike.
fn request_quit(app: &tauri::AppHandle) {
    use tauri::Manager;
    if updates::install_in_progress(app) {
        return;
    }
    // Working Chats are asked about first; the answer comes back through here.
    if chat_commands::confirms_quit(app) {
        return;
    }
    match app.get_webview_window("main") {
        Some(window) => {
            if let Err(error) = window.close() {
                tracing::warn!(%error, "could not ask the window to close");
            }
        }
        None => app.exit(0),
    }
}

/// macOS quits from the application menu without asking any window, so its Quit
/// item is replaced by one this app answers itself.
fn guard_menu_quit(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    // The default application menu comes first and ends with the native Quit.
    if let Some(MenuItemKind::Submenu(application)) = menu.items()?.first() {
        if let Some(MenuItemKind::Predefined(native_quit)) = application.items()?.last() {
            application.remove(native_quit)?;
        }
        application.append(&MenuItem::with_id(
            app,
            QUIT_MENU_ID,
            format!("Quit {}", app.package_info().name),
            true,
            Some("Cmd+Q"),
        )?)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

/// The desktop's logs handle, held in managed state for the whole run and dropped on exit.
/// Commands that read or change the logs take it from here.
struct Logs(std::sync::Mutex<Option<ticketd_diagnostics::DesktopLogs>>);

/// What the startup watchdog has heard from the boot module.
#[derive(Default)]
struct StartupProgress {
    /// The window is shown; from then on its visibility belongs to the person.
    revealed: std::sync::atomic::AtomicBool,
    /// The application modules loaded.
    booted: std::sync::atomic::AtomicBool,
}

impl StartupProgress {
    fn finished(&self) -> bool {
        self.revealed.load(std::sync::atomic::Ordering::SeqCst)
            && self.booted.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// The app owns the metadata for the sidecars it distributes.
fn install_bundled_sources(registry: &ExtensionRegistry) {
    const SOURCES: &[(&str, &str)] = &[(
        "ticketd-source-linear",
        include_str!("../../../../crates/ticketd-source-linear/description.json"),
    )];
    let Ok(application) = std::env::current_exe() else {
        tracing::warn!("could not locate bundled source extensions");
        return;
    };
    for (name, metadata) in SOURCES {
        let Ok(description) = serde_json::from_str(metadata) else {
            tracing::warn!(name, "could not load bundled source description");
            continue;
        };
        let sidecar = application.with_file_name(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        if let Err(error) =
            registry.install_bundled(&sidecar, env!("CARGO_PKG_VERSION"), description)
        {
            tracing::warn!(
                name,
                error_kind = error.code(),
                "could not install bundled source extension"
            );
        }
    }
}

pub fn run() -> Result<(), tauri::Error> {
    let started = std::time::Instant::now();
    let sync = std::sync::Arc::new(sync_scheduler::Scheduler::new(
        Box::new(open_workspace),
        Box::new(sync_commands::binding),
        Box::new(sync_commands::upkeep),
    ));
    let coordinator = std::sync::Arc::new(ticketd_core::source::RefreshCoordinator::new(
        std::sync::Arc::new(ticketd_core::source::SystemClock),
        ticketd_core::source::RefreshPolicy::default(),
    ));
    let sources = std::sync::Arc::new(ExtensionRegistry::device().map_err(|error| {
        tauri::Error::Setup((Box::new(error) as Box<dyn std::error::Error>).into())
    })?);
    install_bundled_sources(&sources);
    let refresh_registry = sources.clone();
    let app = tauri::Builder::default()
        // Must be the first plugin. One process owns Chat execution: starting ticketd
        // again shows the running app's window instead of starting a second host.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            chat_commands::show_window(app);
        }))
        .register_asynchronous_uri_scheme_protocol(
            "attachment-media",
            |context, request, responder| {
                if context.webview_label() != "main" {
                    responder.respond(attachment_media::denied(tauri::http::StatusCode::FORBIDDEN));
                    return;
                }
                attachment_media::handle(request, responder);
            },
        )
        .manage(drive_commands::DrivePickerOperations::default())
        .manage(Refresher(
            std::sync::Arc::clone(&coordinator),
            ActiveRefreshes::default(),
        ))
        .manage(sources.clone())
        .manage(sync_commands::SyncHost {
            scheduler: std::sync::Arc::clone(&sync),
            started,
        })
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                let dev_url = if tauri::is_dev() {
                    app.config().build.dev_url.clone()
                } else {
                    None
                };
                window.with_webview(move |webview| {
                    chat_clipboard::install(&webview.inner(), dev_url);
                })?;
            }
            #[cfg(all(debug_assertions, unix))]
            ticketd_chat_host::prepare_harness_recording(|| {
                open_workspace()?
                    .workspace_info()
                    .map(|info| info.path.into())
            })?;
            // The boot module shows the window first (revealed), then loads the
            // application modules (booted). A broken module or stalled painting
            // IPC must never leave the process invisible or blank.
            let startup = std::sync::Arc::new(StartupProgress::default());
            let (progressed, mut progress) = tokio::sync::mpsc::unbounded_channel();
            let reveal_event = {
                let (startup, progressed) = (startup.clone(), progressed.clone());
                tauri::Listener::once(app, "ticketd://startup-revealed", move |_| {
                    startup
                        .revealed
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    let _ = progressed.send(());
                })
            };
            let boot_event = {
                let startup = startup.clone();
                tauri::Listener::once(app, "ticketd://startup-booted", move |_| {
                    startup
                        .booted
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    let _ = progressed.send(());
                })
            };
            let startup_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    while !startup.finished() && progress.recv().await.is_some() {}
                })
                .await;
                if startup.finished() {
                    return;
                }
                tauri::Listener::unlisten(&startup_app, reveal_event);
                tauri::Listener::unlisten(&startup_app, boot_event);
                if let Some(window) = tauri::Manager::get_webview_window(&startup_app, "main") {
                    if !startup.booted.load(std::sync::atomic::Ordering::SeqCst)
                        && let Err(error) =
                            window.eval(include_str!("../../public/startup-fallback.js"))
                    {
                        tracing::warn!(%error, "could not display startup guidance");
                    }
                    // Once shown, visibility belongs to the person. In
                    // particular, Cmd+H during these five seconds must stay hidden.
                    if startup.revealed.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    match window.is_visible() {
                        Ok(true) => return,
                        Ok(false) => {}
                        Err(error) => {
                            tracing::warn!(%error, "could not check startup window visibility");
                        }
                    }
                    if let Err(error) = window.show() {
                        tracing::warn!(%error, "could not reveal ticketd after startup");
                    }
                }
            });
            let version = app.package_info().version.to_string();
            let chat = chat_commands::ChatBridge::new(version);
            let runner = automation_runner::AutomationRunner::new(
                chat.chats(),
                std::sync::Arc::new(open_workspace),
                automation_runner::notifier(app.handle().clone()),
            );
            automation_runner::start(runner.clone(), app.handle().clone());
            tauri::Manager::manage(app, runner);
            tauri::Manager::manage(app, chat);
            chat_commands::on_notification_click(app.handle());
            updates::start(app.handle());
            agent_skills::refresh_at_launch();
            start_periodic_refresh(coordinator, refresh_registry);
            start_reminder_timer(open_workspace);
            restore_points::start(open_workspace);
            sync_commands::publish_status(app.handle().clone());
            sync.start(started, sync_commands::at_launch);
            if cfg!(target_os = "macos") {
                guard_menu_quit(app.handle())?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                request_quit(app);
            }
        })
        .plugin(tauri_plugin_opener::init())
        // Tauri classifies registered schemes as local IPC origins. Media is never a document.
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("attachment-media-navigation")
                .on_navigation(|_, url| {
                    url.scheme() != "attachment-media"
                        && url.host_str() != Some("attachment-media.localhost")
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Registered for the Rust API only: no capability grants the page its commands.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(traced(tauri::generate_handler![
            drive_commands::drive_configuration,
            drive_commands::drive_reference,
            drive_commands::drive_uploaded_copy_status,
            drive_commands::check_drive_reference,
            drive_commands::recover_drive_reference,
            drive_commands::select_drive_files,
            drive_commands::select_drive_upload_folder,
            drive_commands::attachment_upload_destination,
            drive_commands::set_attachment_upload_destination,
            drive_commands::begin_attachment_upload,
            drive_commands::check_drive_upload,
            drive_commands::open_drive_upload,
            attachment_commands::upload_drive_file,
            drive_commands::cancel_drive_selection,
            attachment_commands::import_attachment,
            attachment_commands::capture_attachment,
            attachment_commands::cancel_attachment_upload,
            automation_commands::automation_agent_list,
            automation_commands::automation_agent_create,
            automation_commands::automation_agent_update,
            automation_commands::automation_agent_delete,
            automation_commands::automation_list,
            automation_commands::automation_create,
            automation_commands::automation_create_example,
            automation_commands::automation_duplicate,
            automation_commands::automation_update,
            automation_commands::automation_delete,
            automation_commands::automation_set_enabled,
            automation_commands::automation_run_list,
            automation_commands::automation_run_list_all,
            automation_commands::automation_text_preview,
            automation_commands::automation_run_get,
            automation_commands::automation_run_stop,
            automation_commands::automation_run_again,
            automation_commands::automation_run_now,
            automation_commands::automation_run_dismiss,
            automation_commands::automation_run_taken_over_in,
            automation_commands::automation_run_list_for_ticket,
            automation_commands::automation_stop_and_turn_off,
            automation_commands::automation_runs_at_once,
            automation_commands::set_automation_runs_at_once,
            automation_commands::start_at_login,
            automation_commands::set_start_at_login,
            attachment_commands::attachment_upload_limit,
            attachment_commands::attachment_workspace_id,
            attachment_commands::set_attachment_upload_limit,
            attachment_commands::list_attachments,
            attachment_commands::search_attachments,
            attachment_commands::attachment_cleanup_reviews,
            attachment_commands::attachment_cleanup_review,
            attachment_commands::purge_attachment,
            attachment_commands::remove_remote_attachment,
            attachment_commands::open_removed_drive_file,
            attachment_commands::quarantine_attachment,
            attachment_commands::restore_attachment,
            attachment_commands::rename_attachment,
            attachment_commands::inspect_attachment,
            attachment_commands::ticket_attachments,
            attachment_commands::set_ticket_attachment,
            attachment_commands::replace_ticket_attachment,
            attachment_commands::export_attachment,
            attachment_commands::export_markdown_with_files,
            attachment_commands::open_attachment,
            attachment_commands::attachment_uri,
            attachment_commands::resolve_attachment_uri,
            attachment_commands::attachment_preview,
            attachment_commands::draft_retentions,
            attachment_commands::complete_draft_cutover,
            attachment_commands::draft_cutover_pending,
            attachment_commands::retain_draft,
            attachment_commands::attachment_usage,
            context_link_markdown,
            document_context_links,
            ticket_from_document,
            recent_documents,
            keep_document,
            pinned_documents,
            search_documents,
            set_document_pin,
            document_tags,
            set_document_tag,
            all_documents,
            trashed_documents,
            current_work_documents,
            finished_documents,
            unlinked_documents,
            documents_by_title,
            set_document_trashed,
            show_document,
            document_row,
            document_version,
            open_document,
            save_document,
            restore_points::restore_points,
            restore_points::save_restore_point,
            list_sources,
            source_repository_routes,
            link_source_repository_project,
            create_source_repository_project,
            refresh_sources,
            cancel_source_refresh,
            take_ownership,
            source_health,
            preview_publication,
            publish_ticket,
            review_publication,
            resolve_publication,
            count_by_source,
            source_check_connection,
            source_options,
            source_configuration_summary,
            source_preview,
            save_source,
            add_source_connection,
            update_source_credentials,
            rename_source_connection,
            remove_source_connection,
            workspace_info,
            workspace_location,
            chat_commands::restore_workspace,
            inspect_backup,
            export_workspace,
            list_plans,
            show_plan,
            set_plan_document,
            set_ticket_document,
            set_plan_spec,
            create_plan,
            change_plan,
            set_plan_purpose,
            set_plan,
            cli_status::check_cli,
            cli_status::install_cli,
            cli_status::install_cli_in_user_bin,
            notification_permission::notification_permission,
            notification_permission::request_notification_permission,
            notification_permission::open_notification_settings,
            agent_skills::agent_skills,
            agent_skills::install_agent_skill,
            list_projects,
            register_checkout,
            remove_checkout,
            detect_project_remote,
            create_project,
            edit_project,
            set_project_archived,
            project_source_candidates,
            preview_connect_source,
            connect_source_match_count,
            connect_source,
            show_ticket,
            search_tickets,
            find_tickets_with_updates,
            find_ticket_rows,
            inbox_attention,
            count_tickets,
            context_graph,
            workspace_graph,
            context_graph_expanded,
            dependency_graph,
            plan_dependency_graph,
            list_trash,
            set_trashed,
            create_ticket,
            change_ticket,
            bulk_status,
            bulk_change,
            ticket_history,
            reminder,
            set_reminder,
            inbox,
            is_following,
            set_following,
            set_inbox_read,
            sidebar_counts,
            workspace_change_token,
            list_evidence,
            add_evidence,
            edit_evidence,
            delete_evidence,
            ticket_backlinks,
            source_conversation,
            latest_update,
            activity_feed,
            get_activity,
            add_activity,
            add_activity_with_details,
            edit_activity,
            delete_activity,
            search_tags,
            add_tag,
            remove_tag,
            preview_duplicate_dependencies,
            evaluate_dependency_review,
            mark_duplicate_reviewed,
            edit_dependencies_reviewed,
            remove_duplicate,
            contextual_relationships,
            change_contextual_relationship,
            add_dependency,
            remove_dependency,
            set_parent,
            detach_child,
            chat_commands::chat_enabled,
            chat_commands::chat_set_enabled,
            chat_commands::chat_overview,
            chat_commands::chat_set_notify,
            chat_commands::chat_mark_read,
            chat_commands::chat_read_through,
            chat_commands::chat_folder_project,
            chat_commands::chat_mark_unread,
            chat_commands::chat_set_muted,
            chat_commands::chat_list,
            chat_commands::chat_harnesses,
            chat_commands::chat_harness_catalog,
            chat_commands::chat_harness_options,
            chat_commands::chat_harness_skills,
            chat_commands::chat_folder_use,
            chat_commands::chat_create,
            chat_commands::chat_open,
            chat_commands::chat_close,
            chat_commands::chat_send,
            chat_commands::chat_capture_attachment,
            chat_commands::chat_export_attachment,
            chat_commands::chat_linked_to,
            chat_commands::chat_files,
            chat_commands::chat_step_output,
            chat_commands::chat_remove_queued,
            chat_commands::chat_confirm_queue_edit,
            chat_commands::chat_check_queue_edits,
            chat_commands::chat_resume_queue,
            chat_commands::chat_send_queued_now,
            chat_commands::chat_stop,
            chat_commands::chat_answer,
            chat_commands::chat_resolve_uncertain,
            chat_commands::chat_check_again,
            chat_commands::chat_set_folder,
            chat_commands::chat_set_retention,
            chat_commands::chat_search_records,
            chat_commands::chat_set_link,
            chat_commands::chat_resume,
            chat_commands::chat_save_as_document,
            chat_commands::chat_change_setting,
            chat_commands::chat_suggestions,
            chat_commands::chat_open_file,
            chat_commands::chat_open_folder,
            project_icon,
            chat_commands::chat_answer_quit,
            chat_commands::chat_stopping,
            chat_commands::close_keeps_running,
            webview_report::report_webview_error,
            sync_commands::sync_conflicts,
            sync_commands::sync_conflict,
            sync_commands::resolve_sync_conflict,
            sync_commands::sync_notices,
            sync_commands::set_sync_read,
            sync_commands::record_versions,
            sync_commands::record_version,
            sync_commands::restore_record_version,
            sync_commands::sync_flush_on_exit,
            sync_commands::sync_status,
            diagnostics_commands::diagnostics_log_level,
            diagnostics_commands::diagnostics_start_report,
            diagnostics_commands::diagnostics_cancel_report,
            updates::updates_state,
            updates::updates_set_automatic,
            updates::updates_check,
            updates::updates_dismiss,
            updates::updates_restart_details,
            updates::updates_install,
            diagnostics_commands::diagnostics_open_logs_folder,
            diagnostics_commands::diagnostics_recent_errors,
            diagnostics_commands::diagnostics_export_file_name,
            diagnostics_commands::diagnostics_issue_details,
            diagnostics_commands::diagnostics_save_report,
            sync_commands::sync_connect,
            sync_commands::use_another_google_account,
            sync_commands::use_sync_uploads_folder,
            s3_commands::s3_profiles,
            s3_commands::s3_choose_cli,
            s3_commands::s3_identity,
            s3_commands::s3_sign_in,
            s3_commands::s3_buckets,
            s3_commands::sync_connect_s3,
            s3_commands::s3_folder_links,
            sync_commands::sync_setup_options,
            sync_commands::sync_upload_workspace,
            sync_commands::sync_reconnect,
            sync_commands::sync_download_workspace,
            sync_commands::sync_now,
            sync_commands::sync_recover,
            sync_commands::sync_disconnect,
            sync_commands::sync_open_folder,
            sync_commands::sync_settings,
            sync_commands::sync_devices,
            sync_commands::set_sync_settings,
            sync_commands::attachment_availability,
            sync_commands::download_attachment
        ]))
        .build(tauri::generate_context!())?;
    // The log folder is named for the app's identifier, which only a built app knows. The
    // setup hook and the event loop have not started yet, so nothing before this is lost
    // but the app's own construction. A path the platform cannot give is an empty one,
    // which makes logging fall back to stderr like any other unusable folder.
    {
        use tauri::Manager;
        let log_dir = app.path().app_log_dir().unwrap_or_default();
        sources.set_log_dir(&log_dir);
        app.manage(Logs(std::sync::Mutex::new(Some(
            ticketd_diagnostics::init_desktop(log_dir),
        ))));
        tracing::info!(version = %app.package_info().version, "ticketd started");
    }
    app.run(|app, event| {
        use tauri::Manager;
        if let tauri::RunEvent::Exit = event {
            // Tauri ends the process with `std::process::exit`, so the handle is dropped
            // here, where it still runs.
            let logs = app
                .try_state::<Logs>()
                .and_then(|logs| logs.0.lock().ok()?.take());
            if let Some(sources) = app.try_state::<SourceRegistry>() {
                sources.shutdown();
            }
            chat_commands::shutdown(app);
            updates::install_on_quit(app);
            drop(logs);
            return;
        }
        if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
            if *code != Some(tauri::RESTART_EXIT_CODE) && updates::install_in_progress(app) {
                api.prevent_exit();
                return;
            }
            if holds_exit(*code, app.get_webview_window("main").is_some()) {
                api.prevent_exit();
                request_quit(app);
                return;
            }
        }
        chat_commands::on_run_event(app, &event);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::holds_exit;

    #[test]
    fn a_new_document_keeps_the_summary_typed_before_its_first_save() {
        let request = super::create_document_request(
            Some("Checkout".into()),
            Some("Why we split it".into()),
            Some("Body".into()),
        );
        let value = serde_json::to_value(&request).expect("serializable");
        assert_eq!(value["summary"], "Why we split it");
        // A caller that omits the summary leaves it unset.
        let without = serde_json::to_value(super::create_document_request(None, None, None))
            .expect("serializable");
        assert!(without.get("summary").is_none());
    }

    #[test]
    fn an_exit_request_goes_through_the_window_while_one_is_open() {
        assert!(holds_exit(Some(0), true));
        // The last window is gone, or the app restarts itself.
        assert!(!holds_exit(Some(0), false));
        assert!(!holds_exit(None, false));
        assert!(!holds_exit(Some(tauri::RESTART_EXIT_CODE), true));
    }

    #[test]
    fn a_command_span_carries_the_command_and_the_request_id_when_it_has_one() {
        let dir = tempfile::tempdir().expect("log folder");
        let logs = ticketd_diagnostics::DesktopLogs::open(dir.path(), Default::default());
        logs.set_debug(true);
        let with =
            tauri::ipc::InvokeBody::Json(serde_json::json!({"id": "T-1", "requestId": "req-7"}));
        let without = tauri::ipc::InvokeBody::Json(serde_json::json!({"id": "T-1"}));
        let raw = tauri::ipc::InvokeBody::Raw(vec![1, 2, 3]);
        logs.with_default(|| {
            for (command, payload) in [("one", &with), ("two", &without), ("three", &raw)] {
                super::command_span(command, payload).in_scope(|| tracing::warn!("inside"));
            }
        });

        let mut seen = Vec::new();
        for entry in std::fs::read_dir(dir.path()).expect("folder") {
            let path = entry.expect("entry").path();
            if path.extension().is_some_and(|extension| extension == "log") {
                for line in std::fs::read_to_string(path).expect("file").lines() {
                    let line: serde_json::Value = serde_json::from_str(line).expect("json line");
                    if line["message"] == "inside" {
                        seen.push((
                            line["spans"][0]["command"].as_str().map(str::to_owned),
                            line["spans"][0]["request_id"].as_str().map(str::to_owned),
                        ));
                    }
                }
            }
        }
        assert_eq!(
            seen,
            [
                (Some("one".to_owned()), Some("req-7".to_owned())),
                (Some("two".to_owned()), None),
                (Some("three".to_owned()), None),
            ]
        );
    }

    #[test]
    fn a_source_failure_crosses_the_bridge_with_the_public_message() {
        use ticketd_core::source::SourceError;

        let error = SourceError::Unavailable("GitHub could not be reached".into())
            .with_detail("synthetic transport diagnostic");
        let failure =
            serde_json::to_value(super::SourceFailure::from(error)).expect("serializable");
        assert_eq!(
            failure,
            serde_json::json!({
                "code": "unavailable",
                "message": "GitHub could not be reached",
                "fields": [],
            })
        );
    }

    #[test]
    fn a_failure_crosses_the_bridge_with_its_kind_and_cause() {
        let read_only = || {
            ticketd_core::Error::Directory(std::io::Error::new(
                std::io::ErrorKind::ReadOnlyFilesystem,
                "read-only file system",
            ))
        };
        let failure =
            serde_json::to_value(super::BridgeFailure::from(read_only())).expect("serializable");
        assert_eq!(failure["code"], "workspace_read_only");
        // The raw cause stays readable for Details.
        assert!(
            failure["message"]
                .as_str()
                .is_some_and(|message| message.contains("read-only file system"))
        );
        let batch = serde_json::to_value(super::BridgeFailure::from(
            ticketd_core::Error::BatchOperation {
                index: 1,
                source: Box::new(read_only()),
            },
        ))
        .expect("serializable");
        assert_eq!(batch["code"], "batch_operation");
        assert_eq!(batch["index"], 1);
        assert_eq!(batch["cause"], "workspace_read_only");
    }
}
