use crate::{Error, Status, Ticket, TicketPatch, Workspace};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Effort {
    pub id: String,
    pub name: String,
    pub archived: bool,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct EffortCounts {
    pub todo: u64,
    pub in_progress: u64,
    pub in_review: u64,
    pub done: u64,
    pub canceled: u64,
    #[serde(default)]
    pub duplicate: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffortView {
    pub effort: Effort,
    pub members: Vec<Ticket>,
    pub counts: EffortCounts,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE efforts (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0); ALTER TABLE tickets ADD COLUMN effort_id TEXT REFERENCES efforts(id);")?;
    Ok(())
}
pub(crate) fn get(connection: &Connection, id: &str) -> Result<Effort, Error> {
    connection
        .query_row(
            "SELECT id, name, archived FROM efforts WHERE id = ?1",
            [id],
            |r| {
                Ok(Effort {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    archived: r.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::EffortNotFound(id.into()))
}
impl Workspace {
    pub fn create_effort(&mut self, name: &str) -> Result<Effort, Error> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::EmptyEffortName);
        }
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO efforts (id, name) VALUES (?1, ?2)",
            params![id, name],
        )?;
        get(&self.connection, &id)
    }
    pub fn change_effort(
        &mut self,
        id: &str,
        name: Option<&str>,
        archived: Option<bool>,
    ) -> Result<Effort, Error> {
        let name = name.map(str::trim);
        if name == Some("") {
            return Err(Error::EmptyEffortName);
        }
        get(&self.connection, id)?;
        self.connection.execute("UPDATE efforts SET name = COALESCE(?1, name), archived = COALESCE(?2, archived) WHERE id = ?3", params![name, archived, id])?;
        get(&self.connection, id)
    }
    pub fn list_efforts(&self, include_archived: bool) -> Result<Vec<Effort>, Error> {
        let mut stmt = self.connection.prepare(
            "SELECT id, name, archived FROM efforts WHERE ?1 OR archived = 0 ORDER BY name, id",
        )?;
        Ok(stmt
            .query_map([include_archived], |r| {
                Ok(Effort {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    archived: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }
    pub fn show_effort(&self, id: &str) -> Result<EffortView, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let effort = get(&tx, id)?;
        let mut stmt = tx.prepare(
            "SELECT number FROM tickets WHERE effort_id = ?1 AND trashed = 0 ORDER BY number",
        )?;
        let references = stmt
            .query_map([id], |r| Ok(format!("T-{}", r.get::<_, i64>(0)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut counts = EffortCounts::default();
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
        Ok(EffortView {
            effort,
            members,
            counts,
        })
    }
    pub fn set_effort(
        &mut self,
        reference: &str,
        effort: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.change_ticket(
            reference,
            TicketPatch {
                effort_id: Some(effort.map(str::to_owned)),
                editing_agent: agent.map(str::to_owned),
                ..Default::default()
            },
        )
    }
}
