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

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0); ALTER TABLE tickets ADD COLUMN plan_id TEXT REFERENCES plans(id);")?;
    Ok(())
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
impl Workspace {
    pub fn create_plan(&mut self, name: &str) -> Result<Plan, Error> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::EmptyPlanName);
        }
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
        let name = name.map(str::trim);
        if name == Some("") {
            return Err(Error::EmptyPlanName);
        }
        let current = get(&self.connection, id)?;
        if current.archived && archived != Some(false) {
            return Err(Error::PlanArchived);
        }
        self.connection.execute("UPDATE plans SET name = COALESCE(?1, name), archived = COALESCE(?2, archived) WHERE id = ?3", params![name, archived, id])?;
        get(&self.connection, id)
    }
    pub fn set_plan_purpose(&mut self, id: &str, purpose: &str) -> Result<Plan, Error> {
        ensure_active(&self.connection, id)?;
        self.connection.execute(
            "UPDATE plans SET purpose = ?1 WHERE id = ?2",
            params![purpose, id],
        )?;
        get(&self.connection, id)
    }
    pub fn list_plans(&self, include_archived: bool) -> Result<Vec<Plan>, Error> {
        let mut stmt = self.connection.prepare(
            "SELECT id, name, archived, purpose, spec_document_id FROM plans WHERE ?1 OR archived = 0 ORDER BY name, id",
        )?;
        Ok(stmt
            .query_map([include_archived], |r| {
                Ok(Plan {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    archived: r.get(2)?,
                    purpose: r.get(3)?,
                    spec_document_id: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }
    pub fn show_plan(&self, id: &str) -> Result<PlanView, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let plan = get(&tx, id)?;
        let mut stmt = tx.prepare(
            "SELECT number FROM tickets WHERE plan_id = ?1 AND trashed = 0 ORDER BY number",
        )?;
        let references = stmt
            .query_map([id], |r| Ok(format!("T-{}", r.get::<_, i64>(0)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut counts = PlanCounts::default();
        let mut members = Vec::new();
        for reference in references {
            let ticket = self.show_ticket(&reference)?;
            match ticket.status {
                Status::Todo => counts.todo += 1,
                Status::InProgress => counts.in_progress += 1,
                Status::InReview => counts.in_review += 1,
                Status::Done => counts.done += 1,
                Status::Canceled => counts.canceled += 1,
                Status::Duplicate => counts.duplicate += 1,
            };
            members.push(ticket);
        }
        let documents = {
            let mut stmt = tx.prepare(&format!("SELECT d.id, {}, d.trashed FROM plan_documents pd JOIN documents d ON d.id = pd.document_id WHERE pd.plan_id = ?1 ORDER BY d.id", crate::documents::HEADING))?;
            stmt.query_map([id], |row| {
                Ok(PlanDocument {
                    id: row.get(0)?,
                    heading: row.get(1)?,
                    trashed: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        };
        tx.commit()?;
        Ok(PlanView {
            plan,
            members,
            counts,
            documents,
        })
    }
    /// Bounded, snapshot-consistent Plan context for agents. Bodies are opt-in.
    pub fn plan_context(&self, id: &str, bodies: bool) -> Result<serde_json::Value, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let plan = get(&tx, id)?;
        let mut counts = serde_json::Map::new();
        {
            let mut stmt = tx.prepare("SELECT status, count(*) FROM tickets WHERE plan_id = ?1 AND trashed = 0 GROUP BY status ORDER BY status")?;
            for row in
                stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))?
            {
                let (status, count) = row?;
                counts.insert(status, count.into());
            }
        }
        let tickets = {
            let mut stmt = tx.prepare("SELECT number, substr(title, 1, 256), status, length(title) > 256 FROM tickets WHERE plan_id = ?1 AND trashed = 0 ORDER BY number LIMIT 21")?;
            stmt.query_map([id], |r| Ok(serde_json::json!({"reference": format!("T-{}", r.get::<_, i64>(0)?), "title": r.get::<_, String>(1)?, "title_truncated": r.get::<_, bool>(3)?, "status": r.get::<_, String>(2)?})))?.collect::<Result<Vec<_>, _>>()?
        };
        let dependencies = {
            let mut stmt = tx.prepare("SELECT b.number, d.number FROM dependencies x JOIN tickets b ON b.id = x.blocker_id JOIN tickets d ON d.id = x.dependent_id WHERE (b.plan_id = ?1 OR d.plan_id = ?1) AND (b.trashed = 0 OR d.trashed = 0) ORDER BY b.number, d.number LIMIT 21")?;
            stmt.query_map([id], |r| Ok(serde_json::json!({"blocker": format!("T-{}", r.get::<_, i64>(0)?), "dependent": format!("T-{}", r.get::<_, i64>(1)?)})))?.collect::<Result<Vec<_>, _>>()?
        };
        let documents = {
            let mut stmt = tx.prepare(&format!("SELECT d.id, {}, d.trashed, CASE WHEN ?2 THEN substr(d.body, 1, 4096) ELSE NULL END, length(d.body) > 4096 FROM plan_documents pd JOIN documents d ON d.id = pd.document_id WHERE pd.plan_id = ?1 ORDER BY d.id LIMIT 21", crate::documents::HEADING))?;
            stmt.query_map(params![id, bodies], |r| { let doc_id: String = r.get(0)?; Ok(serde_json::json!({"id": doc_id, "heading": r.get::<_, String>(1)?, "trashed": r.get::<_, bool>(2)?, "body": r.get::<_, Option<String>>(3)?, "body_truncated": bodies && r.get::<_, bool>(4)?, "fetch": format!("ticketd document read {}", doc_id)})) })?.collect::<Result<Vec<_>, _>>()?
        };
        tx.commit()?;
        Ok(serde_json::json!({
            "plan": {"id": plan.id, "name": plan.name.chars().take(256).collect::<String>(), "purpose": plan.purpose.chars().take(4096).collect::<String>(), "archived": plan.archived, "spec_document_id": plan.spec_document_id, "name_truncated": plan.name.chars().count() > 256, "purpose_truncated": plan.purpose.chars().count() > 4096},
            "counts": counts,
            "tickets": &tickets[..tickets.len().min(20)], "tickets_omitted": tickets.len() > 20,
            "dependencies": &dependencies[..dependencies.len().min(20)], "dependencies_omitted": dependencies.len() > 20,
            "documents": &documents[..documents.len().min(20)], "documents_omitted": documents.len() > 20,
            "fetch_more": format!("ticketd plan show {id}")
        }))
    }
    pub fn set_plan_document(
        &mut self,
        plan_id: &str,
        document_id: &str,
        present: bool,
    ) -> Result<Plan, Error> {
        self.connection.execute_batch("SAVEPOINT plan_document")?;
        let result = (|| {
            crate::transaction_write_lock(&self.connection)?;
            ensure_active(&self.connection, plan_id)?;
            let document = self.show_document(document_id)?;
            if present && document.trashed {
                return Err(Error::DocumentTrashed(document_id.to_owned()));
            }
            if present {
                self.connection.execute(
                    "INSERT OR IGNORE INTO plan_documents(plan_id, document_id) VALUES (?1, ?2)",
                    params![plan_id, document_id],
                )?;
            } else {
                self.connection.execute("UPDATE plans SET spec_document_id = NULL WHERE id = ?1 AND spec_document_id = ?2", params![plan_id, document_id])?;
                self.connection.execute(
                    "DELETE FROM plan_documents WHERE plan_id = ?1 AND document_id = ?2",
                    params![plan_id, document_id],
                )?;
            }
            get(&self.connection, plan_id)
        })();
        match result {
            Ok(plan) => {
                self.connection.execute_batch("RELEASE plan_document")?;
                Ok(plan)
            }
            Err(error) => {
                self.connection
                    .execute_batch("ROLLBACK TO plan_document; RELEASE plan_document")?;
                Err(error)
            }
        }
    }
    pub fn set_plan_spec(
        &mut self,
        plan_id: &str,
        document_id: Option<&str>,
    ) -> Result<Plan, Error> {
        self.connection.execute_batch("SAVEPOINT plan_spec")?;
        let result = (|| {
            crate::transaction_write_lock(&self.connection)?;
            ensure_active(&self.connection, plan_id)?;
            if let Some(id) = document_id {
                self.keep_document(id)?;
                self.connection.execute(
                    "INSERT OR IGNORE INTO plan_documents(plan_id, document_id) VALUES (?1, ?2)",
                    params![plan_id, id],
                )?;
            }
            self.connection.execute(
                "UPDATE plans SET spec_document_id = ?2 WHERE id = ?1",
                params![plan_id, document_id],
            )?;
            get(&self.connection, plan_id)
        })();
        match result {
            Ok(plan) => {
                self.connection.execute_batch("RELEASE plan_spec")?;
                Ok(plan)
            }
            Err(error) => {
                self.connection
                    .execute_batch("ROLLBACK TO plan_spec; RELEASE plan_spec")?;
                Err(error)
            }
        }
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
