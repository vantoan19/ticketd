#[derive(Debug, Serialize)]
pub struct TicketWithUpdate {
    pub ticket: crate::Ticket,
    pub latest_update: Option<crate::LatestUpdate>,
}

use crate::{Error, Ticket, Workspace, listed_ticket_from_row, read_scope, relationships};
use crate::{Status, StatusCounts};
use rusqlite::{Connection, params, params_from_iter, types::Value};
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
/// A ticket as a list or board row shows it: its own values without the body, and
/// what the row says about its relationships. The detail pane reads the whole Ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TicketRow {
    pub id: String,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub trashed: bool,
    pub project_id: Option<String>,
    pub plan_id: Option<String>,
    pub availability: Option<String>,
    pub updated_at: Option<String>,
    pub tags: Vec<String>,
    /// The latest Activity, with the start of its brief.
    pub latest_update: Option<crate::LatestUpdate>,
    /// Set only while an external source owns the ticket.
    pub source: Option<SourcePill>,
    pub parent: Option<crate::hierarchy::RelatedTicket>,
    pub duplicate_of: Option<String>,
    pub prerequisites: PrerequisiteCounts,
}

/// A ticket offered to pick up or link: who it is and when it last changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActiveTicket {
    pub id: String,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub project_id: Option<String>,
    /// Last content or organization change; unknown for legacy tickets with no dated records.
    pub updated_at: Option<String>,
}

const ACTIVE_COLUMNS: &str = "id, reference, title, status, project_id, updated_at";

pub(crate) fn active_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActiveTicket> {
    Ok(ActiveTicket {
        id: row.get(0)?,
        reference: row.get(1)?,
        title: row.get(2)?,
        status: row.get::<_, String>(3)?.parse().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        project_id: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// For New Chat's suggestions, out of the Trash, newest first and each once: for each of
/// `under_way`, the first `count` tickets with that status, the tickets of `project` first
/// and then the ones changed last; and the tickets named in the JSON array `references`.
pub(crate) fn suggestion_candidates(
    connection: &Connection,
    project: Option<&str>,
    under_way: [(Status, usize); 2],
    references: &str,
) -> Result<Vec<ActiveTicket>, Error> {
    // The first `count` in that order are among the first `count` of the Project and the
    // first `count` of all: at most as many of all's first come from the Project as it
    // has. Each reads the trashed and status index in order and stops.
    let first = |status: &str, count: &str| {
        let changed_last = |project: &str| {
            format!(
                "SELECT * FROM (SELECT {ACTIVE_COLUMNS}, number FROM tickets WHERE trashed = 0 AND status = {status}{project}
                   ORDER BY updated_at DESC, number DESC LIMIT {count})"
            )
        };
        format!(
            "{} UNION {}",
            changed_last(" AND project_id = ?1"),
            changed_last("")
        )
    };
    let mut statement = connection.prepare_cached(&format!(
        "{} UNION {} UNION SELECT {ACTIVE_COLUMNS}, number FROM tickets WHERE trashed = 0 AND reference IN (SELECT value FROM json_each(?6))
         ORDER BY number DESC",
        first("?2", "?3"),
        first("?4", "?5"),
    ))?;
    let [(first_status, first_count), (second_status, second_count)] = under_way;
    let count = |count: usize| i64::try_from(count).unwrap_or(i64::MAX);
    Ok(statement
        .query_map(
            params![
                project,
                first_status.to_string(),
                count(first_count),
                second_status.to_string(),
                count(second_count),
                references
            ],
            active_from_row,
        )?
        .collect::<Result<_, _>>()?)
}

/// Who owns an externally owned ticket, as its row names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourcePill {
    pub provider: String,
    /// What people call the provider, such as "GitHub".
    pub provider_name: String,
    /// Where the issue lives, such as "owner/repo".
    pub place: String,
    /// The provider's short number for the issue, such as "#98".
    pub number: String,
    pub display: String,
}

/// How many blockers a ticket has, and how many of them still have to be Done.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct PrerequisiteCounts {
    pub total: usize,
    pub unresolved: usize,
}

#[derive(Debug, Serialize)]
pub struct TicketMetadataPage {
    pub items: Vec<TicketMetadata>,
    pub omitted: bool,
}

/// Format version 84: trigram indexes over what ticket search matches, a ticket's title,
/// reference and body and its Activity briefs, kept in step by triggers. A trigram index
/// finds every row holding a substring of three or more characters, folding case more
/// widely than the ASCII-only `lower` the search has always used, so it narrows the
/// candidates and the old comparison still decides.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ticket_search_fts USING fts5(title, reference, body, content='tickets', content_rowid='rowid', tokenize='trigram');
         INSERT INTO ticket_search_fts(ticket_search_fts) VALUES ('rebuild');
         CREATE TRIGGER IF NOT EXISTS ticket_search_fts_insert AFTER INSERT ON tickets BEGIN
             INSERT INTO ticket_search_fts(rowid, title, reference, body) VALUES (new.rowid, new.title, new.reference, new.body);
         END;
         CREATE TRIGGER IF NOT EXISTS ticket_search_fts_delete AFTER DELETE ON tickets BEGIN
             INSERT INTO ticket_search_fts(ticket_search_fts, rowid, title, reference, body) VALUES ('delete', old.rowid, old.title, old.reference, old.body);
         END;
         CREATE TRIGGER IF NOT EXISTS ticket_search_fts_update AFTER UPDATE OF title, reference, body ON tickets
         WHEN OLD.title IS NOT NEW.title OR OLD.reference IS NOT NEW.reference OR OLD.body IS NOT NEW.body BEGIN
             INSERT INTO ticket_search_fts(ticket_search_fts, rowid, title, reference, body) VALUES ('delete', old.rowid, old.title, old.reference, old.body);
             INSERT INTO ticket_search_fts(rowid, title, reference, body) VALUES (new.rowid, new.title, new.reference, new.body);
         END;
         CREATE VIRTUAL TABLE IF NOT EXISTS activity_search_fts USING fts5(brief, content='activities', content_rowid='rowid', tokenize='trigram');
         INSERT INTO activity_search_fts(activity_search_fts) VALUES ('rebuild');
         CREATE TRIGGER IF NOT EXISTS activity_search_fts_insert AFTER INSERT ON activities BEGIN
             INSERT INTO activity_search_fts(rowid, brief) VALUES (new.rowid, new.brief);
         END;
         CREATE TRIGGER IF NOT EXISTS activity_search_fts_delete AFTER DELETE ON activities BEGIN
             INSERT INTO activity_search_fts(activity_search_fts, rowid, brief) VALUES ('delete', old.rowid, old.brief);
         END;
         CREATE TRIGGER IF NOT EXISTS activity_search_fts_update AFTER UPDATE OF brief ON activities
         WHEN OLD.brief IS NOT NEW.brief BEGIN
             INSERT INTO activity_search_fts(activity_search_fts, rowid, brief) VALUES ('delete', old.rowid, old.brief);
             INSERT INTO activity_search_fts(rowid, brief) VALUES (new.rowid, new.brief);
         END;",
    )?;
    Ok(())
}

/// The tickets whose title, reference, body or an Activity brief the trigram indexes
/// say may hold the phrase bound to the parameter `phrase` names, which is read twice. Every one of them is then
/// checked with the comparison search has always made.
fn trigram_hits(phrase: &str) -> String {
    format!(
        "SELECT ht.id FROM ticket_search_fts JOIN tickets ht ON ht.rowid = ticket_search_fts.rowid WHERE ticket_search_fts MATCH {phrase}
         UNION SELECT ha.ticket_id FROM activity_search_fts JOIN activities ha ON ha.rowid = activity_search_fts.rowid WHERE activity_search_fts MATCH {phrase}"
    )
}

/// The `trashed` term of a page query. Newest first, a page reads tickets in number order
/// and stops at the page's end; the `+` keeps SQLite from reading the trashed and status
/// index instead, which would make it sort every ticket to find the first few.
pub(crate) fn trashed_column(order: TicketOrder) -> &'static str {
    match order {
        TicketOrder::Newest => "+t.trashed",
        TicketOrder::Workflow => "t.trashed",
    }
}

/// What a search for some text reads. A trigram index can only narrow a search for three
/// or more characters; a shorter one matches only what every row shows, the title (and
/// for `search_tickets` the reference), instead of reading every body.
enum SearchQuery<'a> {
    Empty,
    Short(&'a str),
    Long {
        text: &'a str,
        /// The text as one FTS5 phrase: quoted, its quotes doubled, so no character in
        /// it is read as query syntax.
        phrase: String,
    },
}

impl<'a> SearchQuery<'a> {
    fn of(text: &'a str) -> Self {
        match text.chars().count() {
            0 => Self::Empty,
            1 | 2 => Self::Short(text),
            _ => Self::Long {
                text,
                phrase: format!("\"{}\"", text.replace('"', "\"\"")),
            },
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
        match SearchQuery::of(&filter.query) {
            SearchQuery::Empty => {}
            SearchQuery::Short(query) => {
                sql.push_str(" AND instr(lower(t.title), lower(?)) > 0");
                values.push(query.to_owned().into());
            }
            SearchQuery::Long { text, phrase } => {
                sql.push_str(&format!(" AND t.id IN ({}) AND (instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.body), lower(?)) > 0 OR EXISTS (SELECT 1 FROM activities n WHERE n.ticket_id = t.id AND instr(lower(n.brief), lower(?)) > 0))", trigram_hits("?")));
                values.push(phrase.clone().into());
                values.push(phrase.into());
                for _ in 0..3 {
                    values.push(text.to_owned().into());
                }
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
            let trashed = trashed_column(filter.order);
            let mut sql = format!(
                "SELECT t.id, t.reference, t.title, t.status, t.body, t.project_id, t.plan_id, t.trashed, {}, t.number AS local_number FROM tickets t WHERE {trashed} = 0{conditions}",
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
            crate::hydrate::hydrate(connection, &mut tickets)?;
            Ok(tickets)
        })
    }

    /// The `limit` tickets out of the Trash whose content or organization changed last,
    /// most recent first.
    pub fn active_tickets(&self, limit: usize) -> Result<Vec<ActiveTicket>, Error> {
        let mut statement = self.connection.prepare_cached(&format!(
            "SELECT {ACTIVE_COLUMNS} FROM tickets WHERE trashed = 0 ORDER BY updated_at DESC, number DESC LIMIT ?1"
        ))?;
        Ok(statement
            .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], active_from_row)?
            .collect::<Result<_, _>>()?)
    }

    /// The page [`Workspace::find_tickets`] finds, as the rows of a list or board: no
    /// bodies, and each relationship read once for the page.
    pub fn find_ticket_rows(&self, filter: &TicketFilter) -> Result<Vec<TicketRow>, Error> {
        read_scope::run(&self.connection, |connection| {
            let (conditions, mut values) = self.filter_conditions(filter)?;
            let trashed = trashed_column(filter.order);
            let mut sql = format!(
                "SELECT t.id, t.reference, t.title, t.status, t.trashed, t.project_id, t.plan_id, t.updated_at, {} FROM tickets t WHERE {trashed} = 0{conditions}",
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
            let mut rows = statement
                .query_map(params_from_iter(values), |row| {
                    Ok(TicketRow {
                        id: row.get(0)?,
                        reference: row.get(1)?,
                        title: row.get(2)?,
                        status: row.get::<_, String>(3)?.parse().map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        trashed: row.get(4)?,
                        project_id: row.get(5)?,
                        plan_id: row.get(6)?,
                        updated_at: row.get(7)?,
                        availability: row.get(8)?,
                        tags: Vec::new(),
                        latest_update: None,
                        source: None,
                        parent: None,
                        duplicate_of: None,
                        prerequisites: PrerequisiteCounts::default(),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            crate::hydrate::rows(connection, &mut rows)?;
            Ok(rows)
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
            let trashed = trashed_column(filter.order);
            let mut sql = format!(
                "SELECT t.id, t.reference, t.title, t.status, t.trashed, t.project_id, t.plan_id, t.updated_at, {} FROM tickets t WHERE {trashed} = 0{conditions}",
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
        let (matched, phrase) = match SearchQuery::of(query) {
            SearchQuery::Empty => return Ok(Vec::new()),
            SearchQuery::Short(_) => (
                "(instr(lower(t.reference), lower(?1)) > 0 OR instr(lower(t.title), lower(?1)) > 0)"
                    .to_owned(),
                None,
            ),
            SearchQuery::Long { phrase, .. } => (
                format!(
                    "t.id IN ({}) AND (instr(lower(t.reference), lower(?1)) > 0 OR instr(lower(t.title), lower(?1)) > 0 OR instr(lower(t.body), lower(?1)) > 0 OR EXISTS (SELECT 1 FROM activities n WHERE n.ticket_id = t.id AND instr(lower(n.brief), lower(?1)) > 0))",
                    trigram_hits("?6")
                ),
                Some(phrase),
            ),
        };
        read_scope::run(&self.connection, |connection| {
            if let Some(id) = project {
                self.show_project(id)?;
            }
            let mut statement = connection.prepare_cached(&format!(
            "SELECT t.id, t.reference, t.title, t.status, t.body, t.project_id, t.plan_id, t.trashed, {}, t.number AS local_number FROM tickets t WHERE t.trashed = 0 AND (?2 IS NULL OR t.project_id = ?2) AND (?3 = 0 OR t.project_id IS NULL) AND {matched} ORDER BY CASE WHEN lower(t.reference) = lower(?1) OR lower(substr(t.reference, 3)) = lower(?1) THEN 0 WHEN instr(lower(t.reference), lower(?1)) > 0 THEN 1 ELSE 2 END, t.number DESC LIMIT ?4 OFFSET ?5",
            crate::readiness::indicator_sql("t")
        ))?;
            let limit = limit.clamp(1, 100);
            let rows = match &phrase {
                Some(phrase) => statement.query_map(
                    params![query, project, unlinked, limit, offset, phrase],
                    listed_ticket_from_row,
                )?,
                None => statement.query_map(
                    params![query, project, unlinked, limit, offset],
                    listed_ticket_from_row,
                )?,
            };
            let mut tickets = rows.collect::<Result<Vec<_>, _>>()?;
            crate::hydrate::hydrate(connection, &mut tickets)?;
            Ok(tickets)
        })
    }
}
