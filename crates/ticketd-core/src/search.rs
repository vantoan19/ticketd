use crate::{Error, Ticket, Workspace, hierarchy, relationships, tags, ticket_from_row};
use rusqlite::params;

impl Workspace {
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
        }
        Ok(tickets)
    }
}
