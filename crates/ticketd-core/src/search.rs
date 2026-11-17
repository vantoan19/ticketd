#[derive(Debug, Serialize)]
pub struct TicketWithUpdate {
    pub ticket: crate::Ticket,
    pub latest_update: Option<crate::LatestUpdate>,
}

use crate::{Error, Ticket, Workspace, listed_ticket_from_row, read_scope, relationships};
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
    pub plan: Option<String>,
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
            plan: None,
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

/// Existing Ticket values for bounded graph/Flow reads; never a partial full Ticket.
#[derive(Debug, Serialize)]
pub struct TicketMetadata {
    pub id: String,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub trashed: bool,
    pub project_id: Option<String>,
    pub plan_id: Option<String>,
    pub availability: Option<String>,
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<crate::source::SourceAvailability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prerequisites: Option<Vec<relationships::Prerequisite>>,
}
#[derive(Debug, Serialize)]
pub struct TicketMetadataPage {
    pub items: Vec<TicketMetadata>,
    pub omitted: bool,
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
        if let Some(plan) = &filter.plan {
            crate::plans::get(&self.connection, plan)?;
        }
        let family = filter
            .family
            .as_ref()
            .map(|reference| relationships::id(&self.connection, reference))
            .transpose()?;
        let mut sql = String::new();
        let mut values: Vec<Value> = Vec::new();
        if !filter.query.is_empty() {
            sql.push_str(" AND (instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.body), lower(?)) > 0 OR EXISTS (SELECT 1 FROM activities n WHERE n.ticket_id = t.id AND instr(lower(n.brief), lower(?)) > 0))");
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
        if let Some(plan) = &filter.plan {
            sql.push_str(" AND t.plan_id = ?");
            values.push(plan.clone().into());
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
            sql.push_str(" AND ");
            sql.push_str(&match availability {
                Availability::Ready => crate::readiness::ready_sql("t"),
                Availability::Blocked => crate::readiness::blocked_sql("t"),
            });
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
        read_scope::run(&self.connection, |connection| {
            let (conditions, mut values) = self.filter_conditions(filter)?;
            let mut sql = format!(
                "SELECT t.id, t.reference, t.title, t.status, t.body, t.project_id, t.plan_id, t.trashed, {} FROM tickets t WHERE t.trashed = 0{conditions}",
                crate::readiness::indicator_sql("t")
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
            let mut statement = connection.prepare_cached(&sql)?;
            let mut tickets = statement
                .query_map(params_from_iter(values), listed_ticket_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            for ticket in &mut tickets {
                crate::hydrate(connection, ticket)?;
            }
            Ok(tickets)
        })
    }

    /// Metadata projection of the existing filtered page. Body, activity, parent,
    /// child and unrelated source payloads are never selected or hydrated. Flow may request
    /// at most 50 prerequisite values per Ticket; omissions are explicit.
    pub fn find_ticket_metadata(
        &self,
        filter: &TicketFilter,
        ids: Option<&[String]>,
        prerequisites: bool,
    ) -> Result<TicketMetadataPage, Error> {
        read_scope::run(&self.connection, |tx| {
            let (conditions, mut values) = self.filter_conditions(filter)?;
            let mut sql = format!(
                "SELECT t.id, t.reference, t.title, t.status, t.trashed, t.project_id, t.plan_id, t.updated_at, {} FROM tickets t WHERE t.trashed = 0{conditions}",
                crate::readiness::indicator_sql("t")
            );
            if let Some(ids) = ids {
                if ids.len() > 250 {
                    return Err(Error::InvalidBatch(
                        "Metadata selection exceeds 250 identities".into(),
                    ));
                }
                sql.push_str(&format!(
                    " AND t.id IN ({})",
                    vec!["?"; ids.len()].join(",")
                ));
                values.extend(ids.iter().cloned().map(Value::from));
            }
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
            let mut statement = tx.prepare(&sql)?;
            let mut items = statement
                .query_map(params_from_iter(values), |row| {
                    let status: String = row.get(3)?;
                    Ok(TicketMetadata {
                        id: row.get(0)?,
                        reference: row.get(1)?,
                        title: row.get(2)?,
                        status: status.parse().map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        trashed: row.get(4)?,
                        project_id: row.get(5)?,
                        plan_id: row.get(6)?,
                        availability: row.get(8)?,
                        updated_at: row.get(7)?,
                        source: None,
                        prerequisites: None,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let mut omitted = false;
            for ticket in &mut items {
                if prerequisites {
                    ticket.source = crate::source::availability_projection(tx, &ticket.id)?;
                    let mut blockers = relationships::prerequisites(tx, &ticket.id, Some(51))?;
                    omitted |= blockers.len() > 50;
                    blockers.truncate(50);
                    ticket.prerequisites = Some(blockers);
                }
            }
            Ok(TicketMetadataPage { items, omitted })
        })
    }

    /// Return the same filtered ticket page with bounded authored progress.
    pub fn find_tickets_with_updates(
        &self,
        filter: &TicketFilter,
    ) -> Result<Vec<TicketWithUpdate>, Error> {
        read_scope::run(&self.connection, |tx| {
            self.find_tickets(filter)?
                .into_iter()
                .map(|ticket| {
                    let latest_update = crate::activities::latest(tx, &ticket.id)?;
                    Ok(TicketWithUpdate {
                        ticket,
                        latest_update,
                    })
                })
                .collect()
        })
    }

    /// Count the tickets of the whole filtered result set by status, ignoring its paging.
    /// Uses the same conditions as [`Workspace::find_tickets`].
    pub fn count_tickets(&self, filter: &TicketFilter) -> Result<StatusCounts, Error> {
        read_scope::run(&self.connection, |connection| {
            let (conditions, values) = self.filter_conditions(filter)?;
            let sql = format!(
                "SELECT t.status, COUNT(*) FROM tickets t WHERE t.trashed = 0{conditions} GROUP BY t.status"
            );
            let mut statement = connection.prepare_cached(&sql)?;
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
        })
    }

    /// Search saved content using a literal, ASCII case-insensitive substring.
    /// Exact references lead, then reference matches, then saved content matches.
    /// Each group is ordered by descending ticket reference; at most 100 per page.
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
        read_scope::run(&self.connection, |connection| {
            if let Some(id) = project {
                self.show_project(id)?;
            }
            let mut statement = connection.prepare(&format!(
            "SELECT t.id, t.reference, t.title, t.status, t.body, t.project_id, t.plan_id, t.trashed, {} FROM tickets t WHERE t.trashed = 0 AND (?2 IS NULL OR t.project_id = ?2) AND (?3 = 0 OR t.project_id IS NULL) AND (instr(lower(t.reference), lower(?1)) > 0 OR instr(lower(t.title), lower(?1)) > 0 OR instr(lower(t.body), lower(?1)) > 0 OR EXISTS (SELECT 1 FROM activities n WHERE n.ticket_id = t.id AND instr(lower(n.brief), lower(?1)) > 0)) ORDER BY CASE WHEN lower(t.reference) = lower(?1) OR lower(substr(t.reference, 3)) = lower(?1) THEN 0 WHEN instr(lower(t.reference), lower(?1)) > 0 THEN 1 ELSE 2 END, t.number DESC LIMIT ?4 OFFSET ?5",
            crate::readiness::indicator_sql("t")
        ))?;
            let mut tickets = statement
                .query_map(
                    params![query, project, unlinked, limit.clamp(1, 100), offset],
                    listed_ticket_from_row,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            for ticket in &mut tickets {
                crate::hydrate(connection, ticket)?;
            }
            Ok(tickets)
        })
    }
}
