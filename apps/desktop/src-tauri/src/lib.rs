//! Desktop adapter for the shared ticketd core.
mod cli_status;

use ticketd_core::{
    BackupInspection, BackupRecord, BatchOperation, DependencyGraph, Effort, EffortView, Evidence,
    EvidenceInput, HistoryEntry, InboxEntry, Note, NotePatch, Project, SafetyBackup, SidebarCounts,
    Status, Ticket, TicketChange, TicketFilter, TicketPatch, Workspace, WorkspaceInfo,
    WriteRequest, WriteResult,
};

/// A failure the interface acts on by kind. The message is only for reading, so
/// the interface never has to parse it to decide what to do.
#[derive(Debug, serde::Serialize)]
struct BridgeFailure {
    /// `batch_operation` (see `index`), `review_changed`, or `failed`.
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
            other => Self {
                code: "failed",
                index: None,
                message: other.to_string(),
            },
        }
    }
}

#[tauri::command]
fn reminder(reference: String) -> Result<Option<String>, String> {
    Workspace::open_default()
        .and_then(|w| w.reminder(&reference))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_reminder(
    reference: String,
    due_at: Option<String>,
    request_id: String,
) -> Result<(), String> {
    Workspace::open_default()
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
    Workspace::open_default()
        .and_then(|w| w.inbox_page(limit.unwrap_or(100), offset, unread_only.unwrap_or(false)))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn sidebar_counts() -> Result<SidebarCounts, String> {
    Workspace::open_default()
        .and_then(|w| w.sidebar_counts())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn is_following(reference: String) -> Result<bool, String> {
    Workspace::open_default()
        .and_then(|w| w.is_following(&reference))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_following(reference: String, following: bool, request_id: String) -> Result<(), String> {
    Workspace::open_default()
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
    Workspace::open_default()
        .and_then(|mut w| w.write(Some(&request_id), WriteRequest::SetInboxRead { ids, read }))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// `async` commands run off the main thread, so a slow integrity check or copy
// of a large workspace file does not freeze the window.
#[tauri::command(async)]
fn export_workspace(path: String) -> Result<(), String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.export_file(path))
        .map_err(|error| error.to_string())
}

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
fn dependency_graph(reference: String) -> Result<DependencyGraph, String> {
    Workspace::open_default()
        .and_then(|w| w.dependency_graph(&reference))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_tickets() -> Result<Vec<Ticket>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.list_tickets())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn ticket_backlinks(
    reference: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<ticketd_core::Backlink>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.backlinks(&reference, limit, offset))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn show_ticket(reference: String) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|w| w.show_ticket(&reference))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn find_tickets(filter: TicketFilter) -> Result<Vec<Ticket>, String> {
    Workspace::open_default()
        .and_then(|w| w.find_tickets(&filter))
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
    Workspace::open_default()
        .and_then(|w| w.search_tickets(&query, project.as_deref(), unlinked, limit, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn list_trash() -> Result<Vec<Ticket>, String> {
    Workspace::open_default()
        .and_then(|w| w.list_trash())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_trashed(reference: String, trashed: bool) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut w| w.set_trashed(&reference, trashed, None))
        .map_err(|e| e.to_string())
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
fn create_ticket(
    title: String,
    body: String,
    status: Status,
    project_id: Option<String>,
    effort_id: Option<String>,
    tags: Vec<String>,
    follow: bool,
) -> Result<Ticket, String> {
    Workspace::open_default()
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
                                effort_id: effort_id.map(Some),
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
    match Workspace::open_default()
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
    match Workspace::open_default()
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
fn list_evidence(reference: String, offset: u32) -> Result<Vec<Evidence>, String> {
    Workspace::open_default()
        .and_then(|w| w.evidence(&reference, 50, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn add_evidence(
    reference: String,
    input: EvidenceInput,
    request_id: String,
) -> Result<Evidence, String> {
    match Workspace::open_default()
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
    match Workspace::open_default()
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
    Workspace::open_default()
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
fn list_notes(reference: String, limit: u32, offset: u32) -> Result<Vec<Note>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.notes(&reference, limit, offset))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_note(reference: String, id: String) -> Result<Option<Note>, String> {
    Workspace::open_default()
        .and_then(|workspace| match workspace.note(&reference, &id) {
            Ok(note) => Ok(Some(note)),
            Err(ticketd_core::Error::NoteNotFound(_)) => Ok(None),
            Err(error) => Err(error),
        })
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
fn search_tags(query: String) -> Result<Vec<String>, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.search_tags(&query, 50))
        .map_err(|error| error.to_string())
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
fn mark_duplicate(source: String, canonical: String, request_id: String) -> Result<Ticket, String> {
    let result = Workspace::open_default()
        .and_then(|mut workspace| {
            workspace.write(
                Some(&request_id),
                WriteRequest::MarkDuplicate {
                    source,
                    canonical,
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
fn preview_duplicate_dependencies(
    source: String,
    canonical: String,
) -> Result<ticketd_core::DuplicateDependencyPreview, String> {
    Workspace::open_default()
        .and_then(|workspace| workspace.preview_duplicate_dependencies(&source, &canonical))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn mark_duplicate_reviewed(
    source: String,
    canonical: String,
    expected_canonical: String,
    decisions: Vec<ticketd_core::DependencyDecision>,
    request_id: String,
) -> Result<Ticket, BridgeFailure> {
    let result = Workspace::open_default()
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
    let result = Workspace::open_default()
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
    let result = Workspace::open_default()
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
fn contextual_relationships(
    reference: String,
    offset: u32,
) -> Result<ticketd_core::TicketContext, String> {
    Workspace::open_default()
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
    match Workspace::open_default()
        .and_then(|mut w| w.write(Some(&request_id), request))
        .map_err(|e| e.to_string())?
    {
        WriteResult::Ticket(ticket) => Ok(ticket),
        _ => Err("Unexpected write result".into()),
    }
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
fn detach_child(parent: String, child: String) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut w| w.detach_child(&parent, &child, None))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_parent(reference: String, parent: Option<String>) -> Result<Ticket, String> {
    Workspace::open_default()
        .and_then(|mut workspace| workspace.set_parent(&reference, parent.as_deref(), None))
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

/// Saves a backup. Returns whether it was also recorded as the last backup.
#[tauri::command(async)]
fn backup_workspace(path: String) -> Result<bool, String> {
    Workspace::open_default()
        .and_then(|w| w.backup(&path))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn last_backup() -> Result<Option<BackupRecord>, String> {
    Workspace::open_default()
        .and_then(|w| w.last_backup())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn workspace_info() -> Result<WorkspaceInfo, String> {
    Workspace::open_default()
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
    Workspace::open_default()
        .and_then(|w| w.inspect_backup(path))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn safety_backups() -> Result<Vec<SafetyBackup>, String> {
    Workspace::open_default()
        .and_then(|w| w.safety_backups())
        .map_err(|e| e.to_string())
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            backup_workspace,
            last_backup,
            workspace_info,
            restore_workspace,
            inspect_backup,
            safety_backups,
            export_workspace,
            list_efforts,
            show_effort,
            create_effort,
            change_effort,
            set_effort,
            cli_status::check_cli,
            list_projects,
            register_checkout,
            remove_checkout,
            create_project,
            edit_project,
            list_tickets,
            show_ticket,
            search_tickets,
            find_tickets,
            dependency_graph,
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
            list_notes,
            get_note,
            add_note,
            edit_note,
            delete_note,
            search_tags,
            add_tag,
            remove_tag,
            mark_duplicate,
            preview_duplicate_dependencies,
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
