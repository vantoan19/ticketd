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
pub struct PlanView {
    pub plan: Plan,
    pub members: Vec<Ticket>,
    pub counts: PlanCounts,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0); ALTER TABLE tickets ADD COLUMN plan_id TEXT REFERENCES plans(id);")?;
    Ok(())
}
pub(crate) fn get(connection: &Connection, id: &str) -> Result<Plan, Error> {
    connection
        .query_row(
            "SELECT id, name, archived, purpose FROM plans WHERE id = ?1",
            [id],
            |r| {
                Ok(Plan {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    archived: r.get(2)?,
                    purpose: r.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::PlanNotFound(id.into()))
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
        get(&self.connection, id)?;
        self.connection.execute("UPDATE plans SET name = COALESCE(?1, name), archived = COALESCE(?2, archived) WHERE id = ?3", params![name, archived, id])?;
        get(&self.connection, id)
    }
    pub fn set_plan_purpose(&mut self, id: &str, purpose: &str) -> Result<Plan, Error> {
        get(&self.connection, id)?;
        self.connection.execute(
            "UPDATE plans SET purpose = ?1 WHERE id = ?2",
            params![purpose, id],
        )?;
        get(&self.connection, id)
    }
    pub fn list_plans(&self, include_archived: bool) -> Result<Vec<Plan>, Error> {
        let mut stmt = self.connection.prepare(
            "SELECT id, name, archived, purpose FROM plans WHERE ?1 OR archived = 0 ORDER BY name, id",
        )?;
        Ok(stmt
            .query_map([include_archived], |r| {
                Ok(Plan {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    archived: r.get(2)?,
                    purpose: r.get(3)?,
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
        tx.commit()?;
        Ok(PlanView {
            plan,
            members,
            counts,
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
