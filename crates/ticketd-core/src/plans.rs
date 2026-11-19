use crate::{Error, Status, Ticket, TicketPatch, Workspace};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub archived: bool,
    #[serde(default)]
    pub spec_document_id: Option<String>,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct PlanCounts {
    pub todo: u64,
    pub in_progress: u64,
    pub in_review: u64,
    pub done: u64,
    pub canceled: u64,
    #[serde(default)]
    pub duplicate: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanDocument {
    pub id: String,
    pub heading: String,
    pub trashed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanView {
    pub plan: Plan,
    pub members: Vec<Ticket>,
    pub counts: PlanCounts,
    #[serde(default)]
    pub documents: Vec<PlanDocument>,
}

/// What `ticketd plan context` prints. Fields serialize in this order, which is the
/// order of the printed JSON.
#[derive(Debug, Serialize)]
pub struct PlanContext {
    pub plan: PlanContextHeader,
    pub counts: PlanCounts,
    pub tickets: Vec<PlanContextTicket>,
    pub tickets_omitted: bool,
    pub dependencies: Vec<PlanContextDependency>,
    pub dependencies_omitted: bool,
    pub documents: Vec<PlanContextDocument>,
    pub documents_omitted: bool,
    pub fetch_more: String,
}
#[derive(Debug, Serialize)]
pub struct PlanContextHeader {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub archived: bool,
    pub spec_document_id: Option<String>,
    pub name_truncated: bool,
    pub purpose_truncated: bool,
}
#[derive(Debug, Serialize)]
pub struct PlanContextTicket {
    pub reference: String,
    pub title: String,
    pub title_truncated: bool,
    pub status: String,
}
#[derive(Debug, Serialize)]
pub struct PlanContextDependency {
    pub blocker: String,
    pub dependent: String,
}
#[derive(Debug, Serialize)]
pub struct PlanContextDocument {
    pub id: String,
    pub heading: String,
    pub trashed: bool,
    pub body: Option<String>,
    pub body_truncated: bool,
    pub fetch: String,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0); ALTER TABLE tickets ADD COLUMN plan_id TEXT REFERENCES plans(id);")?;
    Ok(())
}
/// A Plan's live tickets by status, keyed like every other count in the interface.
fn plan_counts(connection: &Connection, id: &str) -> Result<PlanCounts, Error> {
    let mut counts = PlanCounts::default();
    let mut stmt = connection.prepare(
        "SELECT status, count(*) FROM tickets WHERE plan_id = ?1 AND trashed = 0 GROUP BY status",
    )?;
    for row in stmt.query_map([id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
    })? {
        let (status, count) = row?;
        match status.parse::<Status>()? {
            Status::Todo => counts.todo = count,
            Status::InProgress => counts.in_progress = count,
            Status::InReview => counts.in_review = count,
            Status::Done => counts.done = count,
            Status::Canceled => counts.canceled = count,
            Status::Duplicate => counts.duplicate = count,
        }
    }
    Ok(counts)
}
pub(crate) fn get(connection: &Connection, id: &str) -> Result<Plan, Error> {
    connection
        .query_row(
            "SELECT id, name, archived, purpose, spec_document_id FROM plans WHERE id = ?1",
            [id],
            |r| {
                Ok(Plan {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    archived: r.get(2)?,
                    purpose: r.get(3)?,
                    spec_document_id: r.get(4)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::PlanNotFound(id.into()))
}
/// Writes to an archived Plan are refused; reactivating it is the one change allowed.
pub(crate) fn ensure_active(connection: &Connection, id: &str) -> Result<Plan, Error> {
    let plan = get(connection, id)?;
    if plan.archived {
        return Err(Error::PlanArchived);
    }
    Ok(plan)
}
/// The longest Plan name accepted for a new or renamed Plan. Existing longer names stay.
const MAX_NAME: usize = 1000;
fn valid_name(name: &str) -> Result<&str, Error> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::EmptyPlanName);
    }
    if name.chars().count() > MAX_NAME {
        return Err(Error::PlanNameTooLong(MAX_NAME));
    }
    Ok(name)
}
impl Workspace {
    pub fn create_plan(&mut self, name: &str) -> Result<Plan, Error> {
        let name = valid_name(name)?;
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO plans (id, name) VALUES (?1, ?2)",
            params![id, name],
        )?;
        get(&self.connection, &id)
    }
    pub fn change_plan(
        &mut self,
        id: &str,
        name: Option<&str>,
        archived: Option<bool>,
    ) -> Result<Plan, Error> {
        let name = name.map(valid_name).transpose()?;
        // The archived check and the write share one locked transaction.
        crate::write_scope::run(&self.connection, |scope| {
            let current = get(scope, id)?;
            // Archiving an archived Plan, like reactivating an active one, changes nothing.
            if current.archived && archived == Some(true) && name.is_none() {
                return Ok(current);
            }
            if current.archived && archived != Some(false) {
                return Err(Error::PlanArchived);
            }
            scope.execute("UPDATE plans SET name = COALESCE(?1, name), archived = COALESCE(?2, archived) WHERE id = ?3", params![name, archived, id])?;
            get(scope, id)
        })
    }
    pub fn set_plan_purpose(&mut self, id: &str, purpose: &str) -> Result<Plan, Error> {
        crate::write_scope::run(&self.connection, |scope| {
            ensure_active(scope, id)?;
            scope.execute(
                "UPDATE plans SET purpose = ?1 WHERE id = ?2",
                params![purpose, id],
            )?;
            get(scope, id)
        })
    }
    pub fn list_plans(&self, include_archived: bool) -> Result<Vec<Plan>, Error> {
        self.list_plans_bounded(include_archived, None, 0)
    }
    /// Existing Plan metadata, with an optional caller-owned read budget.
    pub fn list_plans_bounded(
        &self,
        include_archived: bool,
        limit: Option<u32>,
        offset: u32,
    ) -> Result<Vec<Plan>, Error> {
        let mut stmt = self.connection.prepare(
            "SELECT id, name, archived, purpose, spec_document_id FROM plans WHERE ?1 OR archived = 0 ORDER BY name, id LIMIT ?2 OFFSET ?3",
        )?;
        Ok(stmt
            .query_map(
                params![include_archived, limit.map(i64::from).unwrap_or(-1), offset],
                |r| {
                    Ok(Plan {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        archived: r.get(2)?,
                        purpose: r.get(3)?,
                        spec_document_id: r.get(4)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?)
    }
    /// Active Plans a Document is attached to, with whether it is that Plan's designated spec.
    pub fn document_plans(&self, document_id: &str) -> Result<Vec<(Plan, bool)>, Error> {
        let mut stmt = self.connection.prepare(
            "SELECT p.id, p.name, p.archived, p.purpose, p.spec_document_id FROM plan_documents pd JOIN plans p ON p.id = pd.plan_id WHERE pd.document_id = ?1 AND p.archived = 0 ORDER BY p.name, p.id",
        )?;
        Ok(stmt
            .query_map([document_id], |r| {
                let spec: Option<String> = r.get(4)?;
                Ok((
                    Plan {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        archived: r.get(2)?,
                        purpose: r.get(3)?,
                        spec_document_id: spec.clone(),
                    },
                    spec.as_deref() == Some(document_id),
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }
    pub fn show_plan(&self, id: &str) -> Result<PlanView, Error> {
        self.show_plan_bounded(id, None, 0, true)
    }
    /// Preserve the Plan view and full counts while bounding member/document reads.
    pub fn show_plan_bounded(
        &self,
        id: &str,
        limit: Option<u32>,
        offset: u32,
        include_members: bool,
    ) -> Result<PlanView, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            let plan = get(tx, id)?;
            let counts = plan_counts(tx, id)?;
            let bound = limit.map(i64::from).unwrap_or(-1);
            let mut stmt = tx.prepare("SELECT reference FROM tickets WHERE plan_id = ?1 AND trashed = 0 ORDER BY number LIMIT ?2 OFFSET ?3")?;
            let references = stmt
                .query_map(
                    params![id, if include_members { bound } else { 0 }, offset],
                    |r| r.get::<_, String>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let members = references
                .into_iter()
                .map(|reference| self.show_ticket(&reference))
                .collect::<Result<Vec<_>, _>>()?;
            let documents = {
                let mut stmt = tx.prepare(&format!("SELECT d.id, {}, d.trashed FROM plan_documents pd JOIN documents d ON d.id = pd.document_id WHERE pd.plan_id = ?1 ORDER BY d.id LIMIT ?2 OFFSET ?3", crate::documents::HEADING))?;
                stmt.query_map(params![id, bound, offset], |row| {
                    Ok(PlanDocument {
                        id: row.get(0)?,
                        heading: row.get(1)?,
                        trashed: row.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            Ok(PlanView {
                plan,
                members,
                counts,
                documents,
            })
        })
    }
    /// Bounded, snapshot-consistent Plan context for agents. Bodies are opt-in.
    pub fn plan_context(&self, id: &str, bodies: bool) -> Result<PlanContext, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            let plan = get(tx, id)?;
            let counts = plan_counts(tx, id)?;
            let mut tickets = {
                let mut stmt = tx.prepare("SELECT reference, substr(title, 1, 256), status, length(title) > 256 FROM tickets WHERE plan_id = ?1 AND trashed = 0 ORDER BY number LIMIT 21")?;
                stmt.query_map([id], |r| {
                    Ok(PlanContextTicket {
                        reference: r.get(0)?,
                        title: r.get(1)?,
                        title_truncated: r.get(3)?,
                        status: r.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            let mut dependencies = {
                let mut stmt = tx.prepare("SELECT b.reference, d.reference FROM dependencies x JOIN tickets b ON b.id = x.blocker_id JOIN tickets d ON d.id = x.dependent_id WHERE (b.plan_id = ?1 OR d.plan_id = ?1) AND (b.trashed = 0 OR d.trashed = 0) ORDER BY b.number, d.number LIMIT 21")?;
                stmt.query_map([id], |r| {
                    Ok(PlanContextDependency {
                        blocker: r.get(0)?,
                        dependent: r.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            let mut documents = {
                let mut stmt = tx.prepare(&format!("SELECT d.id, {}, d.trashed, CASE WHEN ?2 AND d.trashed = 0 THEN substr(d.body, 1, 4096) ELSE NULL END, ?2 AND d.trashed = 0 AND length(d.body) > 4096 FROM plan_documents pd JOIN documents d ON d.id = pd.document_id WHERE pd.plan_id = ?1 ORDER BY d.id LIMIT 21", crate::documents::HEADING))?;
                stmt.query_map(params![id, bodies], |r| {
                    let doc_id: String = r.get(0)?;
                    Ok(PlanContextDocument {
                        fetch: format!("ticketd document read {doc_id}"),
                        id: doc_id,
                        heading: r.get(1)?,
                        trashed: r.get(2)?,
                        body: r.get(3)?,
                        body_truncated: r.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            let tickets_omitted = tickets.len() > 20;
            let dependencies_omitted = dependencies.len() > 20;
            let documents_omitted = documents.len() > 20;
            tickets.truncate(20);
            dependencies.truncate(20);
            documents.truncate(20);
            Ok(PlanContext {
                plan: PlanContextHeader {
                    id: plan.id,
                    name: plan.name.chars().take(256).collect(),
                    purpose: plan.purpose.chars().take(4096).collect(),
                    archived: plan.archived,
                    spec_document_id: plan.spec_document_id,
                    name_truncated: plan.name.chars().count() > 256,
                    purpose_truncated: plan.purpose.chars().count() > 4096,
                },
                counts,
                tickets,
                tickets_omitted,
                dependencies,
                dependencies_omitted,
                documents,
                documents_omitted,
                fetch_more: format!("ticketd plan show {id}"),
            })
        })
    }
    pub fn set_plan_document(
        &mut self,
        plan_id: &str,
        document_id: &str,
        present: bool,
    ) -> Result<Plan, Error> {
        self.in_write_scope(|workspace| {
            ensure_active(&workspace.connection, plan_id)?;
            let document = workspace.show_document(document_id)?;
            if present && document.trashed {
                return Err(Error::DocumentTrashed(document_id.to_owned()));
            }
            if present {
                workspace.connection.execute(
                    "INSERT OR IGNORE INTO plan_documents(plan_id, document_id) VALUES (?1, ?2)",
                    params![plan_id, document_id],
                )?;
            } else {
                workspace.connection.execute("UPDATE plans SET spec_document_id = NULL WHERE id = ?1 AND spec_document_id = ?2", params![plan_id, document_id])?;
                workspace.connection.execute(
                    "DELETE FROM plan_documents WHERE plan_id = ?1 AND document_id = ?2",
                    params![plan_id, document_id],
                )?;
            }
            get(&workspace.connection, plan_id)
        })
    }
    pub fn set_plan_spec(
        &mut self,
        plan_id: &str,
        document_id: Option<&str>,
    ) -> Result<Plan, Error> {
        self.in_write_scope(|workspace| {
            ensure_active(&workspace.connection, plan_id)?;
            if let Some(id) = document_id {
                workspace.keep_document(id)?;
                workspace.connection.execute(
                    "INSERT OR IGNORE INTO plan_documents(plan_id, document_id) VALUES (?1, ?2)",
                    params![plan_id, id],
                )?;
            }
            workspace.connection.execute(
                "UPDATE plans SET spec_document_id = ?2 WHERE id = ?1",
                params![plan_id, document_id],
            )?;
            get(&workspace.connection, plan_id)
        })
    }
    pub fn set_plan(
        &mut self,
        reference: &str,
        plan: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.change_ticket(
            reference,
            TicketPatch {
                plan_id: Some(plan.map(str::to_owned)),
                editing_agent: agent.map(str::to_owned),
                ..Default::default()
            },
        )
    }
}
