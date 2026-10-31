use crate::{
    BatchOperation, Effort, Error, Evidence, EvidenceInput, Note, NotePatch, Project,
    RelationshipKind, Ticket, TicketChange, TicketPatch, Workspace,
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
    AddNote {
        reference: String,
        content: String,
        agent: Option<String>,
    },
    EditNote {
        reference: String,
        id: String,
        patch: NotePatch,
    },
    DeleteNote {
        reference: String,
        id: String,
    },
    AddTag {
        reference: String,
        name: String,
    },
    RemoveTag {
        reference: String,
        name: String,
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
    CreateEffort {
        name: String,
    },
    ChangeEffort {
        id: String,
        name: Option<String>,
        archived: Option<bool>,
    },
    SetEffort {
        reference: String,
        effort: Option<String>,
        agent: Option<String>,
    },
}
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
// Results are owned at the public boundary; boxing tickets would complicate every caller.
#[allow(clippy::large_enum_variant)]
pub enum WriteResult {
    Ticket(Ticket),
    Tickets(Vec<Ticket>),
    Note(Note),
    Evidence(Evidence),
    Project(Project),
    Effort(Effort),
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
                    return Ok(serde_json::from_str(&outcome)?);
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
            WriteRequest::SetFollowing {
                reference,
                following,
            } => {
                self.set_following(&reference, following)?;
                WriteResult::Deleted
            }
            WriteRequest::SetInboxRead { ids, read } => {
                self.set_inbox_read(&ids, read)?;
                WriteResult::Deleted
            }
            WriteRequest::CreateTicket { title, project_id } => {
                WriteResult::Ticket(self.create_ticket_in_project(&title, project_id.as_deref())?)
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
            WriteRequest::AddNote {
                reference,
                content,
                agent,
            } => WriteResult::Note(self.add_note(&reference, &content, agent.as_deref())?),
            WriteRequest::EditNote {
                reference,
                id,
                patch,
            } => WriteResult::Note(self.edit_note(&reference, &id, patch)?),
            WriteRequest::DeleteNote { reference, id } => {
                self.delete_note(&reference, &id)?;
                WriteResult::Deleted
            }
            WriteRequest::AddTag { reference, name } => {
                WriteResult::Ticket(self.add_tag(&reference, &name)?)
            }
            WriteRequest::RemoveTag { reference, name } => {
                WriteResult::Ticket(self.remove_tag(&reference, &name)?)
            }
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
            WriteRequest::CreateEffort { name } => WriteResult::Effort(self.create_effort(&name)?),
            WriteRequest::ChangeEffort { id, name, archived } => {
                WriteResult::Effort(self.change_effort(&id, name.as_deref(), archived)?)
            }
            WriteRequest::SetEffort {
                reference,
                effort,
                agent,
            } => WriteResult::Ticket(self.set_effort(
                &reference,
                effort.as_deref(),
                agent.as_deref(),
            )?),
        })
    }
}
