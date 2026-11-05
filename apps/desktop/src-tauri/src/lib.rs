//! Desktop adapter for the shared ticketd core.
mod cli_status;

use ticketd_core::{
    Activity, ActivityPatch, BackupInspection, BackupRecord, BatchOperation, ContextGraph,
    ContextGraphPage, DependencyGraph, Document, DocumentPatch, DocumentSearchResult,
    DocumentSummary, Evidence, EvidenceInput, HistoryEntry, InboxEntry, LatestUpdate, Plan,
    PlanView, Project, SafetyBackup, SidebarCounts, Status, StatusCounts, Ticket, TicketChange,
    TicketFilter, TicketPatch, Workspace, WorkspaceGraph, WorkspaceGraphRequest, WorkspaceInfo,
    WriteRequest, WriteResult,
};

/// A failure the interface acts on by kind. The message is only for reading, so
/// the interface never has to parse it to decide what to do.
#[derive(Debug, serde::Serialize)]
struct BridgeFailure {
    /// `batch_operation` (see `index`), `review_changed`, `review_mode`, or `failed`.
    code: &'static str,
    /// For `batch_operation`, which operation of the batch was rejected.
    index: Option<usize>,
    message: String,
}

impl BridgeFailure {
    fn plain(message: &str) -> Self {
        Self {
            code: "failed",
            index: None,
            message: message.into(),
        }
    }
}

impl From<ticketd_core::Error> for BridgeFailure {
    fn from(error: ticketd_core::Error) -> Self {
        match error {
            ticketd_core::Error::BatchOperation { index, source } => Self {
                code: "batch_operation",
                index: Some(index),
                message: source.to_string(),
            },
            ticketd_core::Error::DependencyReviewChanged => Self {
                code: "review_changed",
                index: None,
                message: ticketd_core::Error::DependencyReviewChanged.to_string(),
            },
            ticketd_core::Error::DependencyReviewMode(mode) => Self {
                code: "review_mode",
                index: None,
                message: ticketd_core::Error::DependencyReviewMode(mode).to_string(),
            },
            other => Self {
                code: "failed",
                index: None,
                message: other.to_string(),
            },
        }
    }
}

/// Opens the workspace as the person using the desktop: their own changes do not notify them.
fn open_workspace() -> Result<Workspace, ticketd_core::Error> {
    let mut workspace = Workspace::open_default()?;
    workspace.act_as_local_person()?;
    Ok(workspace)
}

#[tauri::command]
fn recent_documents(offset: u32, include_support: bool) -> Result<Vec<DocumentSummary>, String> {
    open_workspace()
        .and_then(|w| w.recent_documents_including_support(50, offset, include_support))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn pinned_documents(offset: u32) -> Result<Vec<DocumentSummary>, String> {
    open_workspace()
        .and_then(|w| w.pinned_documents(50, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn search_documents(
    query: String,
    tag: Option<String>,
    offset: u32,
    include_support: bool,
) -> Result<Vec<DocumentSearchResult>, String> {
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
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn keep_document(id: String, request_id: String) -> Result<Document, String> {
    match open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), WriteRequest::KeepDocument { id }))
        .map_err(|e| e.to_string())?
    {
        WriteResult::Document(document) => Ok(document),
        _ => Err("Unexpected document result".into()),
    }
}
#[tauri::command]
fn set_document_pin(id: String, pinned: bool) -> Result<(), String> {
    open_workspace()
        .and_then(|mut w| w.set_document_pin(&id, pinned))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn document_tags(id: String) -> Result<Vec<String>, String> {
    open_workspace()
        .and_then(|w| w.document_tags(&id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_document_tag(id: String, tag: String, present: bool) -> Result<(), String> {
    open_workspace()
        .and_then(|mut w| w.set_document_tag(&id, &tag, present))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn trashed_documents(offset: u32) -> Result<Vec<DocumentSummary>, String> {
    open_workspace()
        .and_then(|w| w.trashed_documents_page(50, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_document_trashed(id: String, trashed: bool, request_id: String) -> Result<Document, String> {
    let request = if trashed {
        WriteRequest::TrashDocument { id }
    } else {
        WriteRequest::RestoreDocument { id }
    };
    match open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), request))
        .map_err(|e| e.to_string())?
    {
        WriteResult::Document(document) => Ok(document),
        _ => Err("Unexpected document result".into()),
    }
}
#[tauri::command]
fn show_document(id: String) -> Result<Document, String> {
    open_workspace()
        .and_then(|w| w.show_document(&id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn document_version(id: String) -> Result<(String, bool), String> {
    open_workspace()
        .and_then(|w| w.document_version(&id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn open_document(id: String) -> Result<Document, String> {
    open_workspace()
        .and_then(|mut w| w.open_document(&id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn save_document(
    id: Option<String>,
    title: Option<String>,
    body: Option<String>,
    title_changed: bool,
    expected_updated_at: Option<String>,
    request_id: String,
) -> Result<Document, String> {
    // Autosaving an existing Document is last-write-wins and idempotent, so it skips the
    // replay record that would otherwise keep a full copy of every autosaved body forever.
    // Creating still uses the request ID, because a repeated create would duplicate.
    let Some(id) = id else {
        let request = WriteRequest::CreateDocument {
            title,
            body: body.unwrap_or_default(),
        };
        return match open_workspace()
            .and_then(|mut w| w.write(Some(&request_id), request))
            .map_err(|e| e.to_string())?
        {
            WriteResult::Document(document) => Ok(document),
            _ => Err("Unexpected save result".into()),
        };
    };
    let patch = DocumentPatch {
        title: title_changed.then_some(title),
        body,
        expected_updated_at,
    };
    open_workspace()
        .and_then(|mut w| w.change_document(&id, patch))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn context_link_markdown(reference: String) -> Result<String, String> {
    open_workspace()
        .and_then(|w| w.context_link_markdown(&reference))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn document_context_links(
    id: String,
    offset: Option<u32>,
) -> Result<
    (
        Vec<ticketd_core::ContextLink>,
        Vec<ticketd_core::ContextLink>,
    ),
    String,
> {
    open_workspace()
        .and_then(|w| {
            let offset = offset.unwrap_or(0);
            let mut backlinks = w.context_backlinks(&id, 100, offset)?;
            // A Plan that uses this Document as its spec is a connection even though
            // no Markdown link states it.
            for plan in w.list_plans(false)?.into_iter().filter(|_| offset == 0) {
                if plan.spec_document_id.as_deref() == Some(id.as_str()) {
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
                    });
                }
            }
            Ok((w.context_links(&id, 100, 0)?, backlinks))
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn ticket_from_document(
    id: String,
    title: String,
    request_id: String,
    follow: Option<bool>,
) -> Result<ticketd_core::Ticket, String> {
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
        .map_err(|e| e.to_string())?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected ticket result".into()),
    }
}

#[tauri::command]
fn reminder(reference: String) -> Result<Option<String>, String> {
    open_workspace()
        .and_then(|w| w.reminder(&reference))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_reminder(
    reference: String,
    due_at: Option<String>,
    request_id: String,
) -> Result<(), String> {
    open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::SetReminder { reference, due_at },
            )
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn inbox(
    offset: u32,
    limit: Option<u32>,
    unread_only: Option<bool>,
) -> Result<Vec<InboxEntry>, String> {
    open_workspace()
        .and_then(|w| w.inbox_page(limit.unwrap_or(100), offset, unread_only.unwrap_or(false)))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn sidebar_counts() -> Result<SidebarCounts, String> {
    open_workspace()
        .and_then(|w| w.sidebar_counts())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn is_following(reference: String) -> Result<bool, String> {
    open_workspace()
        .and_then(|w| w.is_following(&reference))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_following(reference: String, following: bool, request_id: String) -> Result<(), String> {
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
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_inbox_read(ids: Vec<i64>, read: bool, request_id: String) -> Result<(), String> {
    open_workspace()
        .and_then(|mut w| w.write(Some(&request_id), WriteRequest::SetInboxRead { ids, read }))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// `async` commands run off the main thread, so a slow integrity check or copy
// of a large workspace file does not freeze the window.
#[tauri::command(async)]
fn export_workspace(path: String) -> Result<(), String> {
    open_workspace()
        .and_then(|workspace| workspace.export_file(path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_projects() -> Result<Vec<Project>, String> {
    open_workspace()
        .and_then(|w| w.list_projects())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn create_project(name: String, path: String) -> Result<Project, String> {
    open_workspace()
        .and_then(|mut w| w.create_project(&name, &path))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn edit_project(id: String, name: String, path: String) -> Result<Project, String> {
    open_workspace()
        .and_then(|mut w| w.edit_project(&id, &name, &path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn context_graph(reference: String, include_details: bool) -> Result<ContextGraph, String> {
    open_workspace()
        .and_then(|w| w.context_graph(&reference, include_details))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn workspace_graph(request: WorkspaceGraphRequest) -> Result<WorkspaceGraph, String> {
    open_workspace()
        .and_then(|w| w.workspace_graph(&request))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn context_graph_expanded(
    reference: String,
    include_details: bool,
    expanded_ids: Vec<String>,
    pages: Vec<ContextGraphPage>,
) -> Result<ContextGraph, String> {
    open_workspace()
        .and_then(|w| {
            w.context_graph_with_pages(&reference, include_details, &expanded_ids, &pages)
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn dependency_graph(reference: String) -> Result<DependencyGraph, String> {
    open_workspace()
        .and_then(|w| w.dependency_graph(&reference))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn plan_dependency_graph(id: String) -> Result<DependencyGraph, String> {
    open_workspace()
        .and_then(|w| w.plan_dependency_graph(&id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ticket_backlinks(
    reference: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<ticketd_core::Backlink>, String> {
    open_workspace()
        .and_then(|workspace| workspace.backlinks(&reference, limit, offset))
        .map_err(|e| e.to_string())
}

/// The source's comments and events retrieved for a ticket (read-only).
#[tauri::command]
fn source_conversation(
    reference: String,
) -> Result<Vec<ticketd_core::source::ConversationEntry>, String> {
    open_workspace()
        .and_then(|w| w.source_conversation(&reference))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn show_ticket(reference: String) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|w| w.show_ticket(&reference))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn find_tickets_with_updates(
    filter: TicketFilter,
) -> Result<Vec<ticketd_core::TicketWithUpdate>, String> {
    open_workspace()
        .and_then(|w| w.find_tickets_with_updates(&filter))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn count_tickets(filter: TicketFilter) -> Result<StatusCounts, String> {
    open_workspace()
        .and_then(|w| w.count_tickets(&filter))
        .map_err(|e| e.to_string())
}
/// How many tickets each source filter (All, a provider, Local) would show.
#[tauri::command]
fn count_by_source(filter: TicketFilter) -> Result<ticketd_core::source::SourceCounts, String> {
    open_workspace()
        .and_then(|w| w.count_by_source(&filter))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn search_tickets(
    query: String,
    project: Option<String>,
    unlinked: bool,
    limit: u32,
    offset: u32,
) -> Result<Vec<Ticket>, String> {
    open_workspace()
        .and_then(|w| w.search_tickets(&query, project.as_deref(), unlinked, limit, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn list_trash() -> Result<Vec<Ticket>, String> {
    open_workspace()
        .and_then(|w| w.list_trash())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_trashed(reference: String, trashed: bool) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut w| w.set_trashed(&reference, trashed, None))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn register_checkout(id: String, path: String) -> Result<Project, String> {
    open_workspace()
        .and_then(|mut w| w.register_checkout(&id, &path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_checkout(id: String, path: String) -> Result<Project, String> {
    open_workspace()
        .and_then(|mut w| w.remove_checkout(&id, &path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_ticket(
    title: String,
    body: String,
    status: Status,
    project_id: Option<String>,
    plan_id: Option<String>,
    tags: Vec<String>,
    follow: bool,
) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut workspace| {
            // `follow` is the desktop's "Follow tickets I create" preference; creating and
            // following commit together.
            let mut tickets = workspace.apply_batch_following(
                vec![
                    BatchOperation::Create {
                        name: "new".into(),
                        title,
                        project_id,
                    },
                    BatchOperation::Change {
                        ticket: "$new".into(),
                        change: Box::new(TicketChange {
                            patch: TicketPatch {
                                body: Some(body),
                                status: Some(status),
                                plan_id: plan_id.map(Some),
                                ..Default::default()
                            },
                            add_tags: tags,
                            ..Default::default()
                        }),
                    },
                ],
                follow,
            )?;
            tickets
                .pop()
                .ok_or_else(|| ticketd_core::Error::InvalidBatch("missing result".into()))
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn change_ticket(reference: String, patch: TicketPatch) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.change_ticket(&reference, patch))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn ticket_history(reference: String) -> Result<Vec<HistoryEntry>, String> {
    open_workspace()
        .and_then(|workspace| workspace.ticket_history(&reference))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_evidence(reference: String, offset: u32) -> Result<Vec<Evidence>, String> {
    open_workspace()
        .and_then(|w| w.evidence(&reference, 50, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn add_evidence(
    reference: String,
    input: EvidenceInput,
    request_id: String,
) -> Result<Evidence, String> {
    match open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::AddEvidence { reference, input },
            )
        })
        .map_err(|e| e.to_string())?
    {
        WriteResult::Evidence(value) => Ok(value),
        _ => Err("Unexpected evidence result".into()),
    }
}
#[tauri::command]
fn edit_evidence(
    reference: String,
    id: String,
    input: EvidenceInput,
    request_id: String,
) -> Result<Evidence, String> {
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
        .map_err(|e| e.to_string())?
    {
        WriteResult::Evidence(value) => Ok(value),
        _ => Err("Unexpected evidence result".into()),
    }
}
#[tauri::command]
fn delete_evidence(reference: String, id: String, request_id: String) -> Result<(), String> {
    open_workspace()
        .and_then(|mut w| {
            w.write(
                Some(&request_id),
                WriteRequest::DeleteEvidence { reference, id },
            )
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn latest_update(reference: String) -> Result<Option<LatestUpdate>, String> {
    open_workspace()
        .and_then(|workspace| workspace.latest_update(&reference))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn activity_feed(
    reference: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<ticketd_core::ActivityFeedEntry>, String> {
    open_workspace()
        .and_then(|workspace| workspace.activity_feed(&reference, limit, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_activity(reference: String, id: String) -> Result<Option<Activity>, String> {
    open_workspace()
        .and_then(|workspace| match workspace.activity(&reference, &id) {
            Ok(note) => Ok(Some(note)),
            Err(ticketd_core::Error::ActivityNotFound(_)) => Ok(None),
            Err(error) => Err(error),
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn add_activity(reference: String, brief: String) -> Result<Activity, String> {
    open_workspace()
        .and_then(|mut workspace| {
            let activity = workspace.add_activity(&reference, &brief, None)?;
            workspace.discard_inbox_for_own_update(&activity.id)?;
            Ok(activity)
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn add_activity_with_details(
    reference: String,
    brief: String,
    details: Option<String>,
    existing_document_id: Option<String>,
    request_id: String,
) -> Result<Activity, String> {
    let request = WriteRequest::AddActivityWithDetails {
        reference,
        brief,
        agent: None,
        details,
        existing_document_id,
    };
    let mut workspace = open_workspace().map_err(|error| error.to_string())?;
    match workspace
        .write(Some(&request_id), request)
        .map_err(|error| error.to_string())?
    {
        WriteResult::Activity(activity) => {
            // The person who wrote it is not notified of their own update.
            workspace
                .discard_inbox_for_own_update(&activity.id)
                .map_err(|error| error.to_string())?;
            Ok(activity)
        }
        _ => Err("Unexpected activity result".into()),
    }
}

#[tauri::command]
fn edit_activity(reference: String, id: String, patch: ActivityPatch) -> Result<Activity, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.edit_activity(&reference, &id, patch))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn delete_activity(reference: String, id: String) -> Result<(), String> {
    open_workspace()
        .and_then(|mut workspace| workspace.delete_activity(&reference, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn search_tags(query: String) -> Result<Vec<String>, String> {
    open_workspace()
        .and_then(|workspace| workspace.search_tags(&query, 50))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn add_tag(reference: String, tag: String) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.add_tag(&reference, &tag))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_tag(reference: String, tag: String) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.remove_tag(&reference, &tag))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn preview_duplicate_dependencies(
    source: String,
    canonical: String,
    separate: Option<bool>,
) -> Result<ticketd_core::DuplicateDependencyPreview, String> {
    open_workspace()
        .and_then(|workspace| {
            if separate.unwrap_or(false) {
                workspace.preview_dependency_move(&source, &canonical)
            } else {
                workspace.preview_duplicate_dependencies(&source, &canonical)
            }
        })
        .map_err(|e| e.to_string())
}

/// What a whole set of choices does to each waiting ticket, for the review to show.
#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn remove_duplicate(source: String, request_id: String) -> Result<Ticket, String> {
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
        .map_err(|e| e.to_string())?;
    match result {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected write result".into()),
    }
}

#[tauri::command]
fn take_ownership(reference: String, request_id: String) -> Result<Ticket, String> {
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
        .map_err(|e| e.to_string())?;
    match result {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected write result".into()),
    }
}

#[tauri::command]
fn contextual_relationships(
    reference: String,
    offset: u32,
) -> Result<ticketd_core::TicketContext, String> {
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
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn change_contextual_relationship(
    source: String,
    target: String,
    kind: ticketd_core::RelationshipKind,
    add: bool,
    request_id: String,
) -> Result<Ticket, String> {
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
        .map_err(|e| e.to_string())?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected write result".into()),
    }
}

#[tauri::command]
fn add_dependency(blocker: String, dependent: String) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.add_dependency(&blocker, &dependent, None))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_dependency(blocker: String, dependent: String) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.remove_dependency(&blocker, &dependent, None))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn detach_child(parent: String, child: String) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut w| w.detach_child(&parent, &child, None))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_parent(reference: String, parent: Option<String>) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut workspace| workspace.set_parent(&reference, parent.as_deref(), None))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_plans() -> Result<Vec<Plan>, String> {
    open_workspace()
        .and_then(|w| w.list_plans(true))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_plan_document(
    plan_id: String,
    document_id: String,
    present: bool,
    request_id: String,
) -> Result<Plan, String> {
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
        .map_err(|e| e.to_string())?
    {
        WriteResult::Plan(plan) => Ok(plan),
        _ => Err("Unexpected Plan result".into()),
    }
}

#[tauri::command]
fn set_plan_spec(
    plan_id: String,
    document_id: Option<String>,
    request_id: String,
) -> Result<Plan, String> {
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
        .map_err(|e| e.to_string())?
    {
        WriteResult::Plan(plan) => Ok(plan),
        _ => Err("Unexpected Plan result".into()),
    }
}

#[tauri::command]
fn show_plan(id: String) -> Result<PlanView, String> {
    open_workspace()
        .and_then(|w| w.show_plan(&id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn create_plan(name: String) -> Result<Plan, String> {
    open_workspace()
        .and_then(|mut w| w.create_plan(&name))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn change_plan(id: String, name: Option<String>, archived: Option<bool>) -> Result<Plan, String> {
    open_workspace()
        .and_then(|mut w| w.change_plan(&id, name.as_deref(), archived))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_plan_purpose(id: String, purpose: String) -> Result<Plan, String> {
    open_workspace()
        .and_then(|mut w| w.set_plan_purpose(&id, &purpose))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_plan(reference: String, plan: Option<String>) -> Result<Ticket, String> {
    open_workspace()
        .and_then(|mut w| w.set_plan(&reference, plan.as_deref(), None))
        .map_err(|e| e.to_string())
}

/// Saves a backup. Returns whether it was also recorded as the last backup.
#[tauri::command(async)]
fn backup_workspace(path: String) -> Result<bool, String> {
    open_workspace()
        .and_then(|w| w.backup(&path))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn last_backup() -> Result<Option<BackupRecord>, String> {
    open_workspace()
        .and_then(|w| w.last_backup())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn workspace_info() -> Result<WorkspaceInfo, String> {
    open_workspace()
        .and_then(|w| w.workspace_info())
        .map_err(|e| e.to_string())
}
#[tauri::command(async)]
fn restore_workspace(path: String) -> Result<String, String> {
    Workspace::restore_default(path)
        .map(|safety| safety.display().to_string())
        .map_err(|e| e.to_string())
}
#[tauri::command(async)]
fn inspect_backup(path: String) -> Result<BackupInspection, String> {
    open_workspace()
        .and_then(|w| w.inspect_backup(path))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn safety_backups() -> Result<Vec<SafetyBackup>, String> {
    open_workspace()
        .and_then(|w| w.safety_backups())
        .map_err(|e| e.to_string())
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
                message: source.to_string(),
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
    connector: ticketd_core::source::ConnectorDescriptor,
    saved: Option<ticketd_core::source::SavedSource>,
}

/// The built-in sources and what is saved for each. Network commands below run
/// off the UI thread; none holds a database handle while it waits.
#[tauri::command(async)]
fn list_sources() -> Result<Vec<SourceEntry>, SourceFailure> {
    let workspace = open_workspace()?;
    let engine = ticketd_core::source::Engine::builtin();
    engine
        .connectors()
        .into_iter()
        .map(|connector| {
            let saved = workspace.saved_source(&connector.provider)?;
            Ok(SourceEntry { connector, saved })
        })
        .collect()
}
#[tauri::command(async)]
fn source_check_connection(
    provider: String,
    config: ticketd_core::source::ConfigValues,
) -> Result<ticketd_core::source::ConnectionInfo, SourceFailure> {
    Ok(ticketd_core::source::Engine::builtin().check_connection(&provider, &config)?)
}
#[tauri::command(async)]
fn source_options(
    provider: String,
    field: String,
    query: String,
    config: ticketd_core::source::ConfigValues,
) -> Result<Vec<ticketd_core::source::ChoiceOption>, SourceFailure> {
    Ok(ticketd_core::source::Engine::builtin().options(&provider, &field, &query, &config)?)
}
#[tauri::command(async)]
fn source_preview(
    provider: String,
    config: ticketd_core::source::ConfigValues,
) -> Result<ticketd_core::source::DiscoveryPreview, SourceFailure> {
    Ok(open_workspace()?.preview_source(
        &ticketd_core::source::Engine::builtin(),
        &provider,
        &config,
    )?)
}
#[tauri::command(async)]
fn save_source(
    provider: String,
    config: ticketd_core::source::ConfigValues,
) -> Result<ticketd_core::source::SaveOutcome, SourceFailure> {
    let mut workspace = open_workspace()?;
    Ok(workspace.save_source(&ticketd_core::source::Engine::builtin(), &provider, &config)?)
}

/// The one refresh coordinator of this process: the startup and periodic runs and
/// every explicit refresh go through it, so they never overlap or retry in a tight loop.
struct Refresher(std::sync::Arc<ticketd_core::source::RefreshCoordinator>);

/// Imports matching issues and refreshes every externally owned ticket (or just `ticket`).
/// Provider calls finish before the workspace is written; per-ticket failures come back
/// in the report so the saved content stays visible beside the warning. An explicit
/// refresh waits for a running one instead of overlapping it.
#[tauri::command(async)]
fn refresh_sources(
    ticket: Option<String>,
    refresher: tauri::State<'_, Refresher>,
) -> Result<ticketd_core::source::RefreshReport, SourceFailure> {
    Ok(refresher.0.refresh_now(
        &ticketd_core::source::Engine::builtin(),
        &open_workspace,
        ticket.as_deref(),
    )?)
}

/// What publishing would send, and whether it is allowed. No network, no write.
#[tauri::command(async)]
fn preview_publication(
    reference: String,
    provider: String,
    destination: Option<String>,
) -> Result<ticketd_core::source::PublicationPreview, SourceFailure> {
    let workspace = open_workspace()?;
    Ok(workspace.preview_publication(
        &ticketd_core::source::Engine::builtin(),
        &reference,
        &provider,
        destination.as_deref(),
    )?)
}

/// Publishes a local ticket once. The attempt is saved before GitHub is called and
/// no database handle is held while waiting; an unknown outcome comes back as a
/// `publication_unresolved` failure and stays on the ticket.
#[tauri::command(async)]
fn publish_ticket(
    reference: String,
    provider: String,
    destination: Option<String>,
    expected_fingerprint: Option<String>,
) -> Result<ticketd_core::source::PublishOutcome, SourceFailure> {
    let mut workspace = open_workspace()?;
    Ok(workspace.publish_ticket(
        &ticketd_core::source::Engine::builtin(),
        &reference,
        &ticketd_core::source::PublishOptions {
            provider,
            destination,
            now: None,
            expected_fingerprint,
            agent: None,
        },
    )?)
}

/// What is known and unknown about an unresolved publication and which actions are
/// safe. With `search`, asks the source for issues that may be the one created; a
/// failed search is reported in the review, never read as "none".
#[tauri::command(async)]
fn review_publication(
    reference: String,
    search: bool,
) -> Result<ticketd_core::source::PublicationReview, SourceFailure> {
    let workspace = open_workspace()?;
    Ok(workspace.review_publication(
        &ticketd_core::source::Engine::builtin(),
        &reference,
        search,
    )?)
}

/// Settles an unresolved publication: attach a verified issue, or confirm that
/// nothing was created. Evidence the source cannot give leaves it unresolved.
#[tauri::command(async)]
fn resolve_publication(
    reference: String,
    resolution: ticketd_core::source::Resolution,
    accept_different_content: Option<bool>,
) -> Result<ticketd_core::source::PublishOutcome, SourceFailure> {
    let mut workspace = open_workspace()?;
    Ok(workspace.resolve_publication(
        &ticketd_core::source::Engine::builtin(),
        &reference,
        &ticketd_core::source::ResolveOptions {
            resolution,
            now: None,
            agent: None,
            accept_different_content: accept_different_content.unwrap_or(false),
        },
    )?)
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
#[tauri::command]
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
fn start_periodic_refresh(coordinator: std::sync::Arc<ticketd_core::source::RefreshCoordinator>) {
    let spawned = std::thread::Builder::new()
        .name("source-refresh".into())
        .spawn(move || {
            let engine = ticketd_core::source::Engine::builtin();
            let mut reported: Option<String> = None;
            loop {
                // A source that fails is recorded per source by the refresh itself,
                // and the coordinator spaces the next attempt. What it cannot record
                // (the workspace would not open, the hold could not be read) is said
                // once on stderr, and again only if it changes or comes back.
                match coordinator.tick(&engine, &open_workspace) {
                    Ok(_) => reported = None,
                    Err(error) => {
                        let message = error.to_string();
                        if reported.as_deref() != Some(message.as_str()) {
                            eprintln!("periodic source refresh could not run: {message}");
                            reported = Some(message);
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(10));
            }
        });
    if let Err(error) = spawned {
        eprintln!("could not start periodic source refresh: {error}");
    }
}

pub fn run() -> Result<(), tauri::Error> {
    let coordinator = std::sync::Arc::new(ticketd_core::source::RefreshCoordinator::new(
        std::sync::Arc::new(ticketd_core::source::SystemClock),
        ticketd_core::source::RefreshPolicy::default(),
    ));
    tauri::Builder::default()
        .manage(Refresher(std::sync::Arc::clone(&coordinator)))
        .setup(move |_| {
            start_periodic_refresh(coordinator);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
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
            trashed_documents,
            set_document_trashed,
            show_document,
            document_version,
            open_document,
            save_document,
            backup_workspace,
            list_sources,
            refresh_sources,
            take_ownership,
            source_health,
            preview_publication,
            publish_ticket,
            review_publication,
            resolve_publication,
            count_by_source,
            source_check_connection,
            source_options,
            source_preview,
            save_source,
            last_backup,
            workspace_info,
            restore_workspace,
            inspect_backup,
            safety_backups,
            export_workspace,
            list_plans,
            show_plan,
            set_plan_document,
            set_plan_spec,
            create_plan,
            change_plan,
            set_plan_purpose,
            set_plan,
            cli_status::check_cli,
            list_projects,
            register_checkout,
            remove_checkout,
            create_project,
            edit_project,
            show_ticket,
            search_tickets,
            find_tickets_with_updates,
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
            detach_child
        ])
        .run(tauri::generate_context!())
}
