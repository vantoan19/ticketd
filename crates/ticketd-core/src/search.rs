use crate::Status;
use crate::{Error, Ticket, Workspace, hierarchy, relationships, tags, ticket_from_row};
use rusqlite::{params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Availability {
    Ready,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TicketFilter {
    pub query: String,
    pub project: Option<String>,
    pub unlinked: bool,
    pub effort: Option<String>,
    pub status: Option<Status>,
    pub tags: Vec<String>,
    pub availability: Option<Availability>,
    pub family: Option<String>,
    pub limit: u32,
    pub offset: u32,
}
impl Default for TicketFilter {
    fn default() -> Self {
        Self {
            query: String::new(),
            project: None,
            unlinked: false,
            effort: None,
            status: None,
            tags: vec![],
            availability: None,
            family: None,
            limit: 50,
            offset: 0,
        }
    }
}

impl Workspace {
    /// Find non-trashed tickets in descending reference order. Tags use AND semantics.
    pub fn find_tickets(&self, filter: &TicketFilter) -> Result<Vec<Ticket>, Error> {
        if let Some(project) = &filter.project {
            self.show_project(project)?;
        }
        if let Some(effort) = &filter.effort {
            self.show_effort(effort)?;
        }
        let family = filter
            .family
            .as_ref()
            .map(|reference| relationships::id(&self.connection, reference))
            .transpose()?;
        let mut sql = String::from(
            "SELECT t.id, t.number, t.title, t.status, t.body, t.project_id, t.effort_id, t.trashed FROM tickets t WHERE t.trashed = 0",
        );
        let mut values: Vec<Value> = Vec::new();
        if !filter.query.is_empty() {
            sql.push_str(" AND (instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.body), lower(?)) > 0 OR EXISTS (SELECT 1 FROM notes n WHERE n.ticket_id = t.id AND instr(lower(n.content), lower(?)) > 0))");
            for _ in 0..3 {
                values.push(filter.query.clone().into());
            }
        }
        if let Some(project) = &filter.project {
            sql.push_str(" AND t.project_id = ?");
            values.push(project.clone().into());
        }
        if filter.unlinked {
            sql.push_str(" AND t.project_id IS NULL");
        }
        if let Some(effort) = &filter.effort {
            sql.push_str(" AND t.effort_id = ?");
            values.push(effort.clone().into());
        }
        if let Some(status) = filter.status {
            sql.push_str(" AND t.status = ?");
            values.push(status.to_string().into());
        }
        for tag in &filter.tags {
            let tag = tag.trim().to_lowercase();
            if tag.is_empty() {
                return Err(Error::EmptyTag);
            }
            sql.push_str(" AND EXISTS (SELECT 1 FROM ticket_tags tt WHERE tt.ticket_id = t.id AND tt.tag_name = ?)");
            values.push(tag.into());
        }
        if let Some(availability) = filter.availability {
            sql.push_str(" AND t.status = 'Todo' AND ");
            if matches!(availability, Availability::Ready) {
                sql.push_str("NOT ");
            }
            sql.push_str(&format!(
                "EXISTS (SELECT 1 FROM dependencies d JOIN tickets blocker ON blocker.id = d.blocker_id WHERE d.dependent_id = t.id AND {})",
                crate::history::unresolved_blocker_sql("blocker")
            ));
        }
        if let Some(family) = family {
            sql.push_str(" AND (t.id = ? OR EXISTS (SELECT 1 FROM ticket_parents p WHERE p.parent_id = ? AND p.child_id = t.id))");
            values.push(family.clone().into());
            values.push(family.into());
        }
        sql.push_str(" ORDER BY t.number DESC LIMIT ? OFFSET ?");
        values.push(i64::from(filter.limit.clamp(1, 100)).into());
        values.push(i64::from(filter.offset).into());
        let mut statement = self.connection.prepare(&sql)?;
        let mut tickets = statement
            .query_map(params_from_iter(values), ticket_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for ticket in &mut tickets {
            ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
            relationships::populate(&self.connection, ticket)?;
            hierarchy::populate(&self.connection, ticket)?;
            crate::duplicates::populate(&self.connection, ticket)?;
        }
        Ok(tickets)
    }

    /// Search saved content using a literal, ASCII case-insensitive substring.
    /// Results are ordered by descending ticket reference and limited to 100 per page.
    pub fn search_tickets(
        &self,
        query: &str,
        project: Option<&str>,
        unlinked: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Ticket>, Error> {
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(id) = project {
            self.show_project(id)?;
        }
        let mut statement = self.connection.prepare(
            "SELECT t.id, t.number, t.title, t.status, t.body, t.project_id, t.effort_id, t.trashed FROM tickets t WHERE t.trashed = 0 AND (?2 IS NULL OR t.project_id = ?2) AND (?3 = 0 OR t.project_id IS NULL) AND (instr(lower(t.title), lower(?1)) > 0 OR instr(lower(t.body), lower(?1)) > 0 OR EXISTS (SELECT 1 FROM notes n WHERE n.ticket_id = t.id AND instr(lower(n.content), lower(?1)) > 0)) ORDER BY t.number DESC LIMIT ?4 OFFSET ?5"
        )?;
        let mut tickets = statement
            .query_map(
                params![query, project, unlinked, limit.clamp(1, 100), offset],
                ticket_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        for ticket in &mut tickets {
            ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
            relationships::populate(&self.connection, ticket)?;
            hierarchy::populate(&self.connection, ticket)?;
            crate::duplicates::populate(&self.connection, ticket)?;
        }
        Ok(tickets)
    }
}
