//! What a list shows about its tickets beyond their own rows, read for the whole page at
//! once: each relationship is one query over the page's ticket ids, not one per ticket.
//!
//! The ids go in as one JSON array (`json_each`), so every statement has fixed text and
//! stays in the connection's statement cache however long the page is.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::activities::{LatestUpdate, ReportedUpdate, UpdateBrief};
use crate::hierarchy::RelatedTicket;
use crate::relationships::Prerequisite;
use crate::search::{PrerequisiteCounts, SourcePill, TicketRow};
use crate::{Error, Status, Ticket};

/// The ids of a page, as the JSON array the statements below read.
pub(crate) struct Ids(String);

impl Ids {
    pub(crate) fn of<'a>(ids: impl IntoIterator<Item = &'a str>) -> Result<Self, Error> {
        Ok(Self(serde_json::to_string(
            &ids.into_iter().collect::<Vec<_>>(),
        )?))
    }
}

/// Rows of `sql`, which selects a ticket id first, grouped by that id in the order read.
fn grouped<T>(
    connection: &Connection,
    sql: &str,
    ids: &Ids,
    row: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<HashMap<String, Vec<T>>, Error> {
    let mut statement = connection.prepare_cached(sql)?;
    let mut rows = statement.query([&ids.0])?;
    let mut grouped: HashMap<String, Vec<T>> = HashMap::new();
    while let Some(found) = rows.next()? {
        grouped.entry(found.get(0)?).or_default().push(row(found)?);
    }
    Ok(grouped)
}

fn status_at(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Status> {
    row.get::<_, String>(index)?.parse().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

pub(crate) fn tags(
    connection: &Connection,
    ids: &Ids,
) -> Result<HashMap<String, Vec<String>>, Error> {
    grouped(
        connection,
        "SELECT ticket_id, tag_name FROM ticket_tags WHERE ticket_id IN (SELECT value FROM json_each(?1)) ORDER BY ticket_id, tag_name",
        ids,
        |row| row.get(1),
    )
}

/// Each ticket's blockers, by ticket number.
pub(crate) fn prerequisites(
    connection: &Connection,
    ids: &Ids,
) -> Result<HashMap<String, Vec<Prerequisite>>, Error> {
    grouped(
        connection,
        "SELECT d.dependent_id, t.reference, t.title, t.status, t.trashed FROM dependencies d JOIN tickets t ON t.id = d.blocker_id
          WHERE d.dependent_id IN (SELECT value FROM json_each(?1)) ORDER BY t.number",
        ids,
        |row| {
            let status = status_at(row, 3)?;
            Ok(Prerequisite {
                reference: row.get(1)?,
                title: row.get(2)?,
                trashed: row.get(4)?,
                unresolved: crate::readiness::unresolved(status),
                status,
            })
        },
    )
}

fn related(row: &rusqlite::Row<'_>) -> rusqlite::Result<RelatedTicket> {
    Ok(RelatedTicket {
        reference: row.get(1)?,
        title: row.get(2)?,
        trashed: row.get(3)?,
    })
}

pub(crate) fn parents(
    connection: &Connection,
    ids: &Ids,
) -> Result<HashMap<String, Vec<RelatedTicket>>, Error> {
    grouped(
        connection,
        "SELECT p.child_id, t.reference, t.title, t.trashed FROM ticket_parents p JOIN tickets t ON t.id = p.parent_id
          WHERE p.child_id IN (SELECT value FROM json_each(?1))",
        ids,
        related,
    )
}

fn children(
    connection: &Connection,
    ids: &Ids,
) -> Result<HashMap<String, Vec<RelatedTicket>>, Error> {
    grouped(
        connection,
        "SELECT p.parent_id, t.reference, t.title, t.trashed FROM ticket_parents p JOIN tickets t ON t.id = p.child_id
          WHERE p.parent_id IN (SELECT value FROM json_each(?1)) ORDER BY t.number",
        ids,
        related,
    )
}

/// The ticket each duplicate duplicates: its id and its reference.
pub(crate) fn duplicate_of(
    connection: &Connection,
    ids: &Ids,
) -> Result<HashMap<String, Vec<(String, String)>>, Error> {
    grouped(
        connection,
        "SELECT d.source_id, d.canonical_id, t.reference FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id
          WHERE d.source_id IN (SELECT value FROM json_each(?1))",
        ids,
        |row| Ok((row.get(1)?, row.get(2)?)),
    )
}

fn duplicates(connection: &Connection, ids: &Ids) -> Result<HashMap<String, Vec<String>>, Error> {
    grouped(
        connection,
        "SELECT d.canonical_id, t.reference FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id
          WHERE d.canonical_id IN (SELECT value FROM json_each(?1)) ORDER BY t.number",
        ids,
        |row| row.get(1),
    )
}

/// The tickets of the page that have the record a query looks for.
fn having(connection: &Connection, sql: &str, ids: &Ids) -> Result<Vec<String>, Error> {
    let mut statement = connection.prepare_cached(sql)?;
    Ok(statement
        .query_map([&ids.0], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

/// The latest Activity of each ticket, with its brief cut to what a row shows.
pub(crate) fn latest_updates(
    connection: &Connection,
    ids: &Ids,
) -> Result<HashMap<String, Vec<LatestUpdate>>, Error> {
    grouped(
        connection,
        "SELECT j.value, a.id, a.brief, a.reported_at, a.updated_at, a.editing_agent, a.supporting_document_id
           FROM json_each(?1) j JOIN activities a ON a.number = (SELECT number FROM activities WHERE ticket_id = j.value ORDER BY number DESC LIMIT 1)",
        ids,
        |row| {
            Ok(LatestUpdate {
                activity_id: row.get(1)?,
                brief: UpdateBrief::of(&row.get::<_, String>(2)?),
                reported_at: row.get(3)?,
                updated_at: row.get(4)?,
                editing_agent: row.get(5)?,
                supporting_document_id: row.get(6)?,
            })
        },
    )
}

fn first<T>(map: &mut HashMap<String, Vec<T>>, id: &str) -> Option<T> {
    map.remove(id).and_then(|mut values| {
        if values.is_empty() {
            None
        } else {
            Some(values.swap_remove(0))
        }
    })
}

fn all<T>(map: &mut HashMap<String, Vec<T>>, id: &str) -> Vec<T> {
    map.remove(id).unwrap_or_default()
}

/// Fills in everything shown about `tickets` beyond their own rows and availability.
pub(crate) fn hydrate(connection: &Connection, tickets: &mut [Ticket]) -> Result<(), Error> {
    if tickets.is_empty() {
        return Ok(());
    }
    let ids = Ids::of(tickets.iter().map(|ticket| ticket.id.as_str()))?;
    let mut tags = tags(connection, &ids)?;
    let mut prerequisites = prerequisites(connection, &ids)?;
    let mut parents = parents(connection, &ids)?;
    let mut children = children(connection, &ids)?;
    let mut duplicate_of = duplicate_of(connection, &ids)?;
    let mut duplicates = duplicates(connection, &ids)?;
    let mut latest = grouped(
        connection,
        "SELECT j.value, t.updated_at, a.id, a.reported_at, a.editing_agent
           FROM json_each(?1) j JOIN tickets t ON t.id = j.value
           LEFT JOIN activities a ON a.number = (SELECT number FROM activities WHERE ticket_id = j.value ORDER BY number DESC LIMIT 1)",
        &ids,
        |row| {
            let update = match row.get::<_, Option<String>>(2)? {
                Some(activity_id) => Some(ReportedUpdate {
                    activity_id,
                    reported_at: row.get(3)?,
                    editing_agent: row.get(4)?,
                }),
                None => None,
            };
            Ok((row.get::<_, Option<String>>(1)?, update))
        },
    )?;
    // Few tickets have a source or a publication under way: only those read theirs.
    let sourced = having(
        connection,
        "SELECT ticket_id FROM external_identities WHERE ticket_id IN (SELECT value FROM json_each(?1))",
        &ids,
    )?;
    let publishing = having(
        connection,
        "SELECT DISTINCT ticket_id FROM publication_attempts WHERE status IN ('in_flight', 'unresolved') AND ticket_id IN (SELECT value FROM json_each(?1))",
        &ids,
    )?;
    for ticket in tickets.iter_mut() {
        let id = ticket.id.as_str();
        ticket.tags = all(&mut tags, id);
        ticket.prerequisites = all(&mut prerequisites, id);
        ticket.parent = first(&mut parents, id);
        ticket.children = all(&mut children, id);
        ticket.duplicates = all(&mut duplicates, id);
        let direct = first(&mut duplicate_of, id);
        ticket.duplicate_redirect = match &direct {
            Some((canonical_id, _)) => crate::duplicates::redirect(connection, canonical_id)?,
            None => None,
        };
        ticket.duplicate_of = direct.map(|(_, reference)| reference);
        (ticket.updated_at, ticket.latest_update) = first(&mut latest, id).unwrap_or_default();
        ticket.source = None;
        if sourced.iter().any(|sourced| sourced == id) {
            crate::source::populate_tracking(connection, ticket)?;
        }
        ticket.publication = None;
        if publishing.iter().any(|publishing| publishing == &ticket.id) {
            crate::source::populate_publication(connection, ticket)?;
        }
    }
    Ok(())
}

/// Fills in what list and board rows show about their relationships.
pub(crate) fn rows(connection: &Connection, rows: &mut [TicketRow]) -> Result<(), Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids = Ids::of(rows.iter().map(|row| row.id.as_str()))?;
    let mut tags = tags(connection, &ids)?;
    let mut prerequisites = prerequisites(connection, &ids)?;
    let mut parents = parents(connection, &ids)?;
    let mut duplicate_of = duplicate_of(connection, &ids)?;
    let mut latest = latest_updates(connection, &ids)?;
    let mut pills = grouped(
        connection,
        "SELECT i.ticket_id, i.provider, i.locator, i.display FROM external_identities i
           JOIN external_ownership o ON o.ticket_id = i.ticket_id JOIN source_sync s ON s.ticket_id = i.ticket_id
          WHERE o.authority = 'external' AND i.ticket_id IN (SELECT value FROM json_each(?1))",
        &ids,
        |row| {
            let (provider, locator, display): (String, String, String) =
                (row.get(1)?, row.get(2)?, row.get(3)?);
            let (provider_name, place, number) =
                crate::source::display_parts(&provider, &locator, &display);
            Ok(SourcePill {
                provider,
                provider_name,
                place,
                number,
                display,
            })
        },
    )?;
    for row in rows.iter_mut() {
        let id = row.id.as_str();
        row.tags = all(&mut tags, id);
        let blockers = all(&mut prerequisites, id);
        row.prerequisites = PrerequisiteCounts {
            total: blockers.len(),
            unresolved: blockers.iter().filter(|blocker| blocker.unresolved).count(),
        };
        row.parent = first(&mut parents, id);
        row.duplicate_of = first(&mut duplicate_of, id).map(|(_, reference)| reference);
        row.latest_update = first(&mut latest, id);
        row.source = first(&mut pills, id);
    }
    Ok(())
}

/// The one ticket `reference`, with everything shown about it.
pub(crate) fn one(connection: &Connection, reference: &str) -> Result<Ticket, Error> {
    let found = connection
        .prepare_cached(&format!(
            "SELECT id, reference, title, status, body, project_id, plan_id, trashed, {} FROM tickets WHERE reference = ?1",
            crate::source::held_sql("tickets.id")
        ))?
        .query_row([reference], |row| {
            Ok((crate::ticket_from_row(row)?, row.get::<_, bool>(8)?))
        })
        .optional()?;
    let (ticket, held) = found.ok_or_else(|| Error::NotFound(reference.to_owned()))?;
    let mut tickets = [ticket];
    hydrate(connection, &mut tickets)?;
    let [mut ticket] = tickets;
    // The prerequisites are already read: readiness is judged from them.
    ticket.availability = crate::readiness::judge(
        ticket.status,
        ticket.trashed,
        held,
        ticket.prerequisites.iter().map(|blocker| blocker.status),
    )
    .indicator();
    Ok(ticket)
}
