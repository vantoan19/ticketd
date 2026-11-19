use crate::{
    Activity, ActivityPatch, BatchOperation, Document, DocumentPatch, Error, Evidence,
    EvidenceInput, Plan, Project, RelationshipKind, Status, Ticket, TicketChange, TicketPatch,
    Workspace,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// A request ID covers the entire operation, including attribution, order and all supplied
/// strings. JSON serialization of this typed request defines equality: array order and exact
/// strings matter; omitted optional fields deserialize to their defaults. IDs share one
/// workspace-wide namespace across all operations.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum WriteRequest {
    RemoveRemoteAttachment {
        id: String,
    },
    QuarantineAttachment {
        id: String,
    },
    RestoreAttachment {
        id: String,
    },
    RenameAttachment {
        id: String,
        display_name: String,
    },
    ImportAttachment {
        source: String,
        display_name: Option<String>,
    },
    SetTicketAttachment {
        reference: String,
        attachment_id: String,
        present: bool,
    },
    ReplaceTicketAttachment {
        reference: String,
        previous_id: String,
        replacement_id: String,
    },
    CreateTicketFromDocument {
        id: String,
        title: String,
        /// Make the local person follow the new ticket, as the desktop preference asks.
        #[serde(default)]
        follow: bool,
    },
    CreateDocument {
        title: Option<String>,
        body: String,
    },
    ChangeDocument {
        id: String,
        patch: DocumentPatch,
    },
    SetDocumentPin {
        id: String,
        pinned: bool,
    },
    SetDocumentTag {
        id: String,
        tag: String,
        present: bool,
    },
    KeepDocument {
        id: String,
    },
    SetTicketDocument {
        reference: String,
        document_id: String,
        present: bool,
    },
    TrashDocument {
        id: String,
    },
    RestoreDocument {
        id: String,
    },
    AddEvidence {
        reference: String,
        input: EvidenceInput,
    },
    EditEvidence {
        reference: String,
        id: String,
        input: EvidenceInput,
    },
    DeleteEvidence {
        reference: String,
        id: String,
    },
    SetReminder {
        reference: String,
        due_at: Option<String>,
    },
    SetFollowing {
        reference: String,
        following: bool,
    },
    SetInboxRead {
        ids: Vec<i64>,
        read: bool,
    },
    CreateTicket {
        title: String,
        project_id: Option<String>,
    },
    CreateTicketWithContent {
        title: String,
        body: String,
        status: Status,
        project_id: Option<String>,
        plan_id: Option<String>,
        tags: Vec<String>,
        #[serde(default)]
        follow: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        blockers: Vec<String>,
    },
    ChangeTicket {
        reference: String,
        patch: TicketPatch,
    },
    TicketChange {
        reference: String,
        change: TicketChange,
    },
    Batch {
        operations: Vec<BatchOperation>,
    },
    SetTrashed {
        reference: String,
        trashed: bool,
        agent: Option<String>,
    },
    AddActivity {
        reference: String,
        brief: String,
        agent: Option<String>,
    },
    AddActivityWithDetails {
        reference: String,
        brief: String,
        agent: Option<String>,
        details: Option<String>,
        existing_document_id: Option<String>,
    },
    EditActivity {
        reference: String,
        id: String,
        patch: ActivityPatch,
    },
    DeleteActivity {
        reference: String,
        id: String,
    },
    AddTag {
        reference: String,
        name: String,
        // Omitted when absent so the canonical form of a request without an agent, which
        // a stored outcome is compared against on replay, is unchanged.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    RemoveTag {
        reference: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    MarkDuplicate {
        source: String,
        canonical: String,
        agent: Option<String>,
    },
    MarkDuplicateReviewed {
        source: String,
        canonical: String,
        expected_canonical: String,
        decisions: Vec<crate::DependencyDecision>,
        agent: Option<String>,
    },
    EditDependenciesReviewed {
        source: String,
        canonical: String,
        expected_canonical: String,
        decisions: Vec<crate::DependencyDecision>,
        agent: Option<String>,
    },
    RemoveDuplicate {
        source: String,
        agent: Option<String>,
    },
    TakeOwnership {
        reference: String,
        agent: Option<String>,
    },
    AddContextualRelationship {
        source: String,
        target: String,
        kind: RelationshipKind,
        agent: Option<String>,
    },
    RemoveContextualRelationship {
        source: String,
        target: String,
        kind: RelationshipKind,
        agent: Option<String>,
    },
    AddDependency {
        blocker: String,
        dependent: String,
        agent: Option<String>,
    },
    RemoveDependency {
        blocker: String,
        dependent: String,
        agent: Option<String>,
    },
    SetParent {
        child: String,
        parent: Option<String>,
        agent: Option<String>,
    },
    DetachChild {
        parent: String,
        child: String,
        agent: Option<String>,
    },
    CreateProject {
        name: String,
        path: String,
    },
    EditProject {
        id: String,
        name: String,
        path: String,
    },
    RegisterCheckout {
        id: String,
        path: String,
    },
    RemoveCheckout {
        id: String,
        path: String,
    },
    CreatePlan {
        name: String,
    },
    ChangePlan {
        id: String,
        name: Option<String>,
        archived: Option<bool>,
    },
    SetPlanDocument {
        plan_id: String,
        document_id: String,
        present: bool,
    },
    SetPlanSpec {
        plan_id: String,
        document_id: Option<String>,
    },
    SetPlanPurpose {
        id: String,
        purpose: String,
    },
    SetPlan {
        reference: String,
        plan: Option<String>,
        agent: Option<String>,
    },
    /// Make an earlier version of a ticket or Document current again.
    RestoreVersion {
        id: i64,
    },
    /// Settle fields of a record that needs review after sync.
    ResolveSyncConflict {
        kind: crate::SyncKind,
        id: String,
        resolutions: Vec<crate::sync::SyncResolution>,
    },
}
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
// Results are owned at the public boundary; boxing tickets would complicate every caller.
#[allow(clippy::large_enum_variant)]
pub enum WriteResult {
    RemoteAttachmentRemoved(crate::RemoteAttachmentRemoval),
    Attachment(crate::Attachment),
    Document(Document),
    Ticket(Ticket),
    Tickets(Vec<Ticket>),
    Activity(Activity),
    Evidence(Evidence),
    Project(Project),
    Plan(Plan),
    /// A reminder now: the due time as stored, or none after a dismissal.
    Reminder(Option<String>),
    /// Whether the ticket is now followed.
    Following(bool),
    /// The read state the given inbox entries now have.
    InboxRead(bool),
    Deleted,
}

impl Workspace {
    /// Execute a write, optionally retaining its result forever for retry. Different IDs
    /// do not protect against concurrent edits to the same fields.
    pub fn write(
        &mut self,
        request_id: Option<&str>,
        request: WriteRequest,
    ) -> Result<WriteResult, Error> {
        // A blank ID would key unrelated writes to one stored outcome (ADR 0002).
        if request_id.is_some_and(|id| id.trim().is_empty()) {
            return Err(Error::EmptyRequestId);
        }
        if let WriteRequest::ImportAttachment {
            source,
            display_name,
        } = &request
        {
            let generated = uuid::Uuid::new_v4().to_string();
            return self
                .import_attachment(
                    request_id.unwrap_or(&generated),
                    source,
                    display_name.as_deref(),
                )
                .map(WriteResult::Attachment);
        }
        self.recover_uploads()?;
        // File coordination must precede BEGIN; nested workflows reuse this scope.
        let _file_moves = if matches!(
            request,
            WriteRequest::QuarantineAttachment { .. } | WriteRequest::RestoreAttachment { .. }
        ) {
            Some(self.attachment_backup_lock()?)
        } else {
            None
        };
        let canonical = serde_json::to_string(&request)?;
        self.connection.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            if let Some(id) = request_id {
                let stored: Option<(String, String)> = self
                    .connection
                    .query_row(
                        "SELECT request, outcome FROM request_outcomes WHERE id = ?1",
                        [id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((previous, outcome)) = stored {
                    if previous != canonical {
                        return Err(Error::RequestConflict(id.to_owned()));
                    }
                    let result = serde_json::from_str(&outcome)?;
                    return match result {
                        WriteResult::Attachment(file) => {
                            crate::attachments::replay_attachment(&self.connection, file)
                                .map(WriteResult::Attachment)
                        }
                        other => Ok(other),
                    };
                }
            }
            if let Some(id) = request_id {
                let reserved: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM attachment_upload_destinations WHERE request_id=?1)", [id], |r| r.get(0))?;
                if reserved {
                    return Err(Error::RequestConflict(id.into()));
                }
            }
            let outcome = self.execute_write(request)?;
            if let Some(id) = request_id {
                self.connection.execute(
                    "INSERT INTO request_outcomes (id, request, outcome) VALUES (?1, ?2, ?3)",
                    params![id, canonical, serde_json::to_string(&outcome)?],
                )?;
            }
            Ok(outcome)
        })();
        match result {
            Ok(outcome) => {
                if let Err(error) = self.connection.execute_batch("COMMIT") {
                    let _ = self.connection.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(outcome)
            }
            Err(error) => {
                let _ = self.connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    fn execute_write(&mut self, request: WriteRequest) -> Result<WriteResult, Error> {
        Ok(match request {
            WriteRequest::RemoveRemoteAttachment { id } => {
                WriteResult::RemoteAttachmentRemoved(self.remove_remote_attachment(&id)?)
            }
            WriteRequest::QuarantineAttachment { id } => {
                WriteResult::Attachment(self.quarantine_attachment_locked(&id)?)
            }
            WriteRequest::RestoreAttachment { id } => {
                WriteResult::Attachment(self.restore_attachment_locked(&id)?)
            }
            WriteRequest::RenameAttachment { id, display_name } => {
                WriteResult::Attachment(self.rename_attachment(&id, &display_name)?)
            }
            WriteRequest::ImportAttachment { .. } => {
                return Err(Error::Attachment(
                    "uploads must run outside a database transaction".into(),
                ));
            }
            WriteRequest::SetTicketAttachment {
                reference,
                attachment_id,
                present,
            } => WriteResult::Ticket(self.set_ticket_attachment(
                &reference,
                &attachment_id,
                present,
            )?),
            WriteRequest::ReplaceTicketAttachment {
                reference,
                previous_id,
                replacement_id,
            } => WriteResult::Ticket(self.replace_ticket_attachment(
                &reference,
                &previous_id,
                &replacement_id,
            )?),
            WriteRequest::CreateTicketFromDocument { id, title, follow } => WriteResult::Ticket(
                self.create_ticket_from_document_following(&id, &title, follow)?,
            ),
            WriteRequest::CreateDocument { title, body } => {
                WriteResult::Document(self.create_document(title.as_deref(), &body)?)
            }
            WriteRequest::ChangeDocument { id, patch } => {
                WriteResult::Document(self.change_document(&id, patch)?)
            }
            WriteRequest::SetDocumentPin { id, pinned } => {
                self.set_document_pin(&id, pinned)?;
                WriteResult::Deleted
            }
            WriteRequest::SetDocumentTag { id, tag, present } => {
                self.set_document_tag(&id, &tag, present)?;
                WriteResult::Deleted
            }
            WriteRequest::SetTicketDocument {
                reference,
                document_id,
                present,
            } => {
                WriteResult::Ticket(self.set_ticket_document(&reference, &document_id, present)?)
            }
            WriteRequest::KeepDocument { id } => WriteResult::Document(self.keep_document(&id)?),
            WriteRequest::TrashDocument { id } => {
                WriteResult::Document(self.set_document_trashed(&id, true)?)
            }
            WriteRequest::RestoreDocument { id } => {
                WriteResult::Document(self.set_document_trashed(&id, false)?)
            }
            WriteRequest::AddEvidence { reference, input } => {
                WriteResult::Evidence(self.add_evidence(&reference, input)?)
            }
            WriteRequest::EditEvidence {
                reference,
                id,
                input,
            } => WriteResult::Evidence(self.edit_evidence(&reference, &id, input)?),
            WriteRequest::DeleteEvidence { reference, id } => {
                self.delete_evidence(&reference, &id)?;
                WriteResult::Deleted
            }
            WriteRequest::SetReminder { reference, due_at } => {
                self.set_reminder(&reference, due_at.as_deref())?;
                WriteResult::Reminder(self.reminder(&reference)?)
            }
            WriteRequest::SetFollowing {
                reference,
                following,
            } => {
                self.set_following(&reference, following)?;
                WriteResult::Following(following)
            }
            WriteRequest::SetInboxRead { ids, read } => {
                self.set_inbox_read(&ids, read)?;
                WriteResult::InboxRead(read)
            }
            WriteRequest::CreateTicket { title, project_id } => {
                WriteResult::Ticket(self.create_ticket_in_project(&title, project_id.as_deref())?)
            }
            WriteRequest::CreateTicketWithContent {
                title,
                body,
                status,
                project_id,
                plan_id,
                tags,
                follow,
                blockers,
            } => {
                let mut tickets = self.apply_batch_following(
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
                                add_blockers: blockers,
                                ..Default::default()
                            }),
                        },
                    ],
                    follow,
                )?;
                WriteResult::Ticket(
                    tickets
                        .pop()
                        .ok_or_else(|| Error::InvalidBatch("missing creation result".into()))?,
                )
            }
            WriteRequest::ChangeTicket { reference, patch } => {
                WriteResult::Ticket(self.change_ticket(&reference, patch)?)
            }
            WriteRequest::TicketChange { reference, change } => {
                WriteResult::Ticket(self.apply_ticket_change(&reference, change)?)
            }
            WriteRequest::Batch { operations } => {
                WriteResult::Tickets(self.apply_batch(operations)?)
            }
            WriteRequest::SetTrashed {
                reference,
                trashed,
                agent,
            } => WriteResult::Ticket(self.set_trashed(&reference, trashed, agent.as_deref())?),
            WriteRequest::AddActivity {
                reference,
                brief,
                agent,
            } => WriteResult::Activity(self.add_activity(&reference, &brief, agent.as_deref())?),
            WriteRequest::AddActivityWithDetails {
                reference,
                brief,
                agent,
                details,
                existing_document_id,
            } => WriteResult::Activity(self.add_activity_with_details(
                &reference,
                &brief,
                agent.as_deref(),
                details.as_deref(),
                existing_document_id.as_deref(),
            )?),
            WriteRequest::EditActivity {
                reference,
                id,
                patch,
            } => WriteResult::Activity(self.edit_activity(&reference, &id, patch)?),
            WriteRequest::DeleteActivity { reference, id } => {
                self.delete_activity(&reference, &id)?;
                WriteResult::Deleted
            }
            WriteRequest::AddTag {
                reference,
                name,
                agent,
            } => WriteResult::Ticket(self.add_tag_as(&reference, &name, agent.as_deref())?),
            WriteRequest::RemoveTag {
                reference,
                name,
                agent,
            } => WriteResult::Ticket(self.remove_tag_as(&reference, &name, agent.as_deref())?),
            WriteRequest::MarkDuplicate {
                source,
                canonical,
                agent,
            } => WriteResult::Ticket(self.mark_duplicate(&source, &canonical, agent.as_deref())?),
            WriteRequest::MarkDuplicateReviewed {
                source,
                canonical,
                expected_canonical,
                decisions,
                agent,
            } => WriteResult::Ticket(self.mark_duplicate_reviewed(
                &source,
                &canonical,
                &expected_canonical,
                decisions,
                agent.as_deref(),
            )?),
            WriteRequest::EditDependenciesReviewed {
                source,
                canonical,
                expected_canonical,
                decisions,
                agent,
            } => WriteResult::Ticket(self.edit_dependencies_reviewed(
                &source,
                &canonical,
                &expected_canonical,
                decisions,
                agent.as_deref(),
            )?),
            WriteRequest::RemoveDuplicate { source, agent } => {
                WriteResult::Ticket(self.remove_duplicate(&source, agent.as_deref())?)
            }
            WriteRequest::TakeOwnership { reference, agent } => {
                WriteResult::Ticket(self.take_ownership(&reference, agent.as_deref())?)
            }
            WriteRequest::AddContextualRelationship {
                source,
                target,
                kind,
                agent,
            } => WriteResult::Ticket(self.add_contextual_relationship(
                &source,
                &target,
                kind,
                agent.as_deref(),
            )?),
            WriteRequest::RemoveContextualRelationship {
                source,
                target,
                kind,
                agent,
            } => WriteResult::Ticket(self.remove_contextual_relationship(
                &source,
                &target,
                kind,
                agent.as_deref(),
            )?),
            WriteRequest::AddDependency {
                blocker,
                dependent,
                agent,
            } => {
                WriteResult::Ticket(self.add_dependency(&blocker, &dependent, agent.as_deref())?)
            }
            WriteRequest::RemoveDependency {
                blocker,
                dependent,
                agent,
            } => WriteResult::Ticket(self.remove_dependency(
                &blocker,
                &dependent,
                agent.as_deref(),
            )?),
            WriteRequest::SetParent {
                child,
                parent,
                agent,
            } => {
                WriteResult::Ticket(self.set_parent(&child, parent.as_deref(), agent.as_deref())?)
            }
            WriteRequest::DetachChild {
                parent,
                child,
                agent,
            } => WriteResult::Ticket(self.detach_child(&parent, &child, agent.as_deref())?),
            WriteRequest::CreateProject { name, path } => {
                WriteResult::Project(self.create_project(&name, &path)?)
            }
            WriteRequest::EditProject { id, name, path } => {
                WriteResult::Project(self.edit_project(&id, &name, &path)?)
            }
            WriteRequest::RegisterCheckout { id, path } => {
                WriteResult::Project(self.register_checkout(&id, &path)?)
            }
            WriteRequest::RemoveCheckout { id, path } => {
                WriteResult::Project(self.remove_checkout(&id, &path)?)
            }
            WriteRequest::CreatePlan { name } => WriteResult::Plan(self.create_plan(&name)?),
            WriteRequest::ChangePlan { id, name, archived } => {
                WriteResult::Plan(self.change_plan(&id, name.as_deref(), archived)?)
            }
            WriteRequest::SetPlanDocument {
                plan_id,
                document_id,
                present,
            } => WriteResult::Plan(self.set_plan_document(&plan_id, &document_id, present)?),
            WriteRequest::SetPlanSpec {
                plan_id,
                document_id,
            } => WriteResult::Plan(self.set_plan_spec(&plan_id, document_id.as_deref())?),
            WriteRequest::RestoreVersion { id } => {
                self.restore_version(id)?;
                WriteResult::Deleted
            }
            WriteRequest::ResolveSyncConflict {
                kind,
                id,
                resolutions,
            } => {
                self.resolve_sync_conflict(kind, &id, &resolutions)?;
                WriteResult::Deleted
            }
            WriteRequest::SetPlanPurpose { id, purpose } => {
                WriteResult::Plan(self.set_plan_purpose(&id, &purpose)?)
            }
            WriteRequest::SetPlan {
                reference,
                plan,
                agent,
            } => {
                WriteResult::Ticket(self.set_plan(&reference, plan.as_deref(), agent.as_deref())?)
            }
        })
    }
}
