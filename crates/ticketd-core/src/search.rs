use crate::{Error, Ticket, Workspace, hierarchy, relationships, tags, ticket_from_row};
use crate::{Status, StatusCounts};
use rusqlite::{params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Availability {
    Ready,
    Blocked,
}

/// How a result set is ordered before paging.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TicketOrder {
    /// Descending ticket reference.
    #[default]
    Newest,
    /// Workflow order of status (In progress, In review, Todo, Done, Canceled, Duplicate), then
    /// descending reference. A list grouped by status pages through this order.
    Workflow,
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
    /// Only externally owned tickets of one provider, or only local ones.
    pub source: Option<crate::source::SourceFilter>,
    pub order: TicketOrder,
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
            source: None,
            order: TicketOrder::Newest,
            limit: 50,
            offset: 0,
        }
    }
}

impl Workspace {
    /// The conditions a filter adds to `tickets t WHERE t.trashed = 0`, as `" AND ..."` clauses.
    /// Listing and counting share them, so a count always describes the tickets the list pages
    /// through.
    pub(crate) fn filter_conditions(
        &self,
        filter: &TicketFilter,
    ) -> Result<(String, Vec<Value>), Error> {
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
        let mut sql = String::new();
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
            sql.push_str(&format!(
                " AND t.status = 'Todo' AND NOT {} AND ",
                crate::source::held_sql("t.id")
            ));
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
        match &filter.source {
            None => {}
            Some(crate::source::SourceFilter::Local) => sql.push_str(
                " AND NOT EXISTS (SELECT 1 FROM external_ownership o WHERE o.ticket_id = t.id AND o.authority = 'external')",
            ),
            Some(crate::source::SourceFilter::Provider(provider)) => {
                sql.push_str(" AND EXISTS (SELECT 1 FROM external_ownership o JOIN external_identities i ON i.ticket_id = o.ticket_id WHERE o.ticket_id = t.id AND o.authority = 'external' AND i.provider = ?)");
                values.push(provider.clone().into());
            }
        }
        Ok((sql, values))
    }

    /// Find non-trashed tickets, newest first unless the filter asks for workflow order.
    /// Tags use AND semantics.
    pub fn find_tickets(&self, filter: &TicketFilter) -> Result<Vec<Ticket>, Error> {
        let (conditions, mut values) = self.filter_conditions(filter)?;
        let mut sql = format!(
            "SELECT t.id, t.number, t.title, t.status, t.body, t.project_id, t.effort_id, t.trashed FROM tickets t WHERE t.trashed = 0{conditions}"
        );
        match filter.order {
            TicketOrder::Newest => sql.push_str(" ORDER BY t.number DESC"),
            TicketOrder::Workflow => sql.push_str(&format!(
                " ORDER BY {}, t.number DESC",
                Status::workflow_order_sql("t.status")
            )),
        }
        sql.push_str(" LIMIT ? OFFSET ?");
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
            crate::source::populate(&self.connection, ticket)?;
        }
        Ok(tickets)
    }

    /// Count the tickets of the whole filtered result set by status, ignoring its paging.
    /// Uses the same conditions as [`Workspace::find_tickets`].
    pub fn count_tickets(&self, filter: &TicketFilter) -> Result<StatusCounts, Error> {
        let (conditions, values) = self.filter_conditions(filter)?;
        let sql = format!(
            "SELECT t.status, COUNT(*) FROM tickets t WHERE t.trashed = 0{conditions} GROUP BY t.status"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(values), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut counts = StatusCounts::default();
        for (status, count) in rows {
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
            crate::source::populate(&self.connection, ticket)?;
        }
        Ok(tickets)
    }
}
