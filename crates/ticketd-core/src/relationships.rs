use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::write_scope::{self, WriteScope};
use crate::{Error, Status, Ticket, Workspace, history, ticket_change};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prerequisite {
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub trashed: bool,
    /// Still has to be Done before the ticket that depends on it is Ready.
    #[serde(default = "unresolved_by_default")]
    pub unresolved: bool,
}

fn unresolved_by_default() -> bool {
    true
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS dependencies (blocker_id TEXT NOT NULL REFERENCES tickets(id), dependent_id TEXT NOT NULL REFERENCES tickets(id), PRIMARY KEY (blocker_id, dependent_id));")?;
    Ok(())
}

pub(crate) fn prerequisites(
    connection: &Connection,
    ticket_id: &str,
    limit: Option<u32>,
) -> Result<Vec<Prerequisite>, Error> {
    // A bounded projection follows the adjacency index before sorting its small
    // result. Sorting all neighbors before LIMIT would defeat the read budget.
    let order = if limit.is_some() {
        "dependencies.blocker_id"
    } else {
        "tickets.number"
    };
    let mut statement = connection.prepare(&format!("SELECT reference, title, status, trashed, tickets.number FROM dependencies JOIN tickets ON tickets.id = dependencies.blocker_id WHERE dependencies.dependent_id = ?1 ORDER BY {order} LIMIT ?2"))?;
    let mut prerequisites = statement
        .query_map(
            params![ticket_id, limit.map(i64::from).unwrap_or(-1)],
            |row| {
                let status: String = row.get(2)?;
                let status: Status = status.parse().map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok((
                    Prerequisite {
                        reference: row.get::<_, String>(0)?,
                        title: row.get(1)?,
                        trashed: row.get(3)?,
                        unresolved: crate::readiness::unresolved(status),
                        status,
                    },
                    row.get::<_, i64>(4)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    prerequisites.sort_by_key(|(_, number)| *number);
    Ok(prerequisites
        .into_iter()
        .map(|(blocker, _)| blocker)
        .collect())
}

/// The prerequisites of a ticket. Its availability is not set here: a read of one ticket
/// asks `readiness::indicator`, and a list selects `readiness::indicator_sql` with the
/// tickets, so a list makes no readiness query per ticket.
pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    ticket.prerequisites = prerequisites(connection, &ticket.id, None)?;
    Ok(())
}

/// Whether `to` can be reached from `from` by following dependencies from a
/// blocker to its dependents, as if the optional `excluding` edge (blocker id,
/// dependent id) did not exist. Adding a dependency from `to` to `from` would
/// close a cycle exactly when this is true.
pub(crate) fn reaches(
    connection: &Connection,
    from: &str,
    to: &str,
    excluding: Option<(&str, &str)>,
) -> Result<bool, Error> {
    // Ticket ids are never empty, so an empty pair excludes nothing.
    let (excluded_blocker, excluded_dependent) = excluding.unwrap_or(("", ""));
    Ok(connection.query_row(
        "WITH RECURSIVE reachable(id) AS (\
           SELECT dependent_id FROM dependencies \
             WHERE blocker_id = ?1 AND NOT (blocker_id = ?3 AND dependent_id = ?4) \
           UNION \
           SELECT d.dependent_id FROM dependencies d JOIN reachable ON d.blocker_id = reachable.id \
             WHERE NOT (d.blocker_id = ?3 AND d.dependent_id = ?4)) \
         SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ?2)",
        params![from, to, excluded_blocker, excluded_dependent],
        |row| row.get(0),
    )?)
}

/// Reference chain `from -> ... -> to` following blocker-to-dependent edges,
/// used to explain a refused cycle. Empty when `to` is unreachable.
fn chain(connection: &Connection, from: &str, to: &str) -> Result<Vec<String>, Error> {
    let mut previous: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut queue = std::collections::VecDeque::from([from.to_owned()]);
    let mut statement = connection.prepare(
        "SELECT dependent_id FROM dependencies WHERE blocker_id = ?1 ORDER BY dependent_id",
    )?;
    while let Some(current) = queue.pop_front() {
        if current == to {
            break;
        }
        let next = statement
            .query_map([&current], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for id in next {
            if id != from && !previous.contains_key(&id) {
                previous.insert(id.clone(), current.clone());
                queue.push_back(id);
            }
        }
    }
    let mut ids = vec![to.to_owned()];
    while let Some(parent) = previous.get(ids.last().map_or("", String::as_str)) {
        ids.push(parent.clone());
    }
    ids.reverse();
    ids.into_iter()
        .map(|id| {
            connection
                .query_row("SELECT reference FROM tickets WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .map_err(Error::from)
        })
        .collect()
}

pub(crate) fn id(connection: &Connection, reference: &str) -> Result<String, Error> {
    connection
        .query_row(
            "SELECT id FROM tickets WHERE reference = ?1",
            [reference],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::NotFound(reference.into()))
}

impl Workspace {
    pub fn add_dependency(
        &mut self,
        blocker: &str,
        dependent: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        ticket_change::commit(&self.connection, dependent, |tx| {
            add_dependency(tx, blocker, dependent, agent)
        })
    }
    pub fn remove_dependency(
        &mut self,
        blocker: &str,
        dependent: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        ticket_change::commit(&self.connection, dependent, |tx| {
            remove_dependency(tx, blocker, dependent, agent)
        })
    }
}

/// Make `blocker` block `dependent`: both must be visible, and the edge must not close a
/// cycle.
pub(crate) fn add_dependency(
    tx: &WriteScope<'_>,
    blocker: &str,
    dependent: &str,
    agent: Option<&str>,
) -> Result<(), Error> {
    let blocker_id = tx.even_if_trashed(blocker)?;
    let dependent_id = tx.even_if_trashed(dependent)?;
    tx.ensure_editable(&blocker_id)?;
    tx.ensure_editable(&dependent_id)?;
    let cycle = reaches(tx, &dependent_id, &blocker_id, None)?;
    if blocker_id == dependent_id {
        return Err(Error::DependencySelf(blocker.into()));
    }
    if cycle {
        let path = chain(tx, &dependent_id, &blocker_id)?;
        let between = path.get(1..path.len().saturating_sub(1)).unwrap_or(&[]);
        let detail = if between.is_empty() {
            format!("{dependent} already blocks {blocker}.")
        } else {
            format!(
                "{dependent} already reaches {blocker} through {}.",
                between.join(" → ")
            )
        };
        return Err(Error::DependencyCycle {
            blocker: blocker.into(),
            dependent: dependent.into(),
            detail,
        });
    }
    let changed = tx.execute(
        "INSERT OR IGNORE INTO dependencies (blocker_id, dependent_id) VALUES (?1, ?2)",
        params![blocker_id, dependent_id],
    )?;
    if changed != 0 {
        history::record(tx, &dependent_id, "dependency", "", blocker, agent)?;
        history::record(tx, &blocker_id, "relationship:blocks", "", dependent, agent)?;
    }
    Ok(())
}

/// Remove the edge. Either visible endpoint may detach an edge to a trashed ticket.
pub(crate) fn remove_dependency(
    tx: &WriteScope<'_>,
    blocker: &str,
    dependent: &str,
    agent: Option<&str>,
) -> Result<(), Error> {
    let blocker_id = tx.even_if_trashed(blocker)?;
    let dependent_id = tx.even_if_trashed(dependent)?;
    tx.ensure_either_editable(&blocker_id, &dependent_id)?;
    let changed = tx.execute(
        "DELETE FROM dependencies WHERE blocker_id = ?1 AND dependent_id = ?2",
        params![blocker_id, dependent_id],
    )?;
    if changed != 0 {
        history::record(tx, &dependent_id, "dependency", blocker, "", agent)?;
        history::record(tx, &blocker_id, "relationship:blocks", dependent, "", agent)?;
    }
    Ok(())
}

/// Related is symmetric; Discovered points from the work to the discovered ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    Related,
    Discovered,
}

impl Workspace {
    pub fn add_contextual_relationship(
        &mut self,
        source: &str,
        target: &str,
        kind: RelationshipKind,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.change_contextual_relationship(source, target, kind, agent, true)
    }

    pub fn remove_contextual_relationship(
        &mut self,
        source: &str,
        target: &str,
        kind: RelationshipKind,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.change_contextual_relationship(source, target, kind, agent, false)
    }

    fn change_contextual_relationship(
        &mut self,
        source: &str,
        target: &str,
        kind: RelationshipKind,
        agent: Option<&str>,
        add: bool,
    ) -> Result<Ticket, Error> {
        write_scope::run(&self.connection, |tx| {
            let source_id = tx.even_if_trashed(source)?;
            let target_id = tx.even_if_trashed(target)?;
            if source_id == target_id {
                return Err(Error::RelationshipSelfLink);
            }
            if add {
                tx.ensure_editable(&source_id)?;
                tx.ensure_editable(&target_id)?;
            } else {
                // Either visible endpoint may detach a relationship to a trashed ticket.
                tx.ensure_either_editable(&source_id, &target_id)?;
            }
            let (first, second) = if kind == RelationshipKind::Related && source_id > target_id {
                (&target_id, &source_id)
            } else {
                (&source_id, &target_id)
            };
            let kind_name = match kind {
                RelationshipKind::Related => "related",
                RelationshipKind::Discovered => "discovered",
            };
            let changed = if add {
                tx.execute("INSERT OR IGNORE INTO contextual_relationships(kind,source_id,target_id) VALUES (?1,?2,?3)", params![kind_name,first,second])?
            } else {
                tx.execute("DELETE FROM contextual_relationships WHERE kind=?1 AND source_id=?2 AND target_id=?3", params![kind_name,first,second])?
            };
            if changed != 0 {
                let (from_target, to_target) = if add { ("", target) } else { (target, "") };
                let (from_source, to_source) = if add { ("", source) } else { (source, "") };
                let (source_kind, target_kind) = match kind {
                    RelationshipKind::Related => ("relationship:related", "relationship:related"),
                    RelationshipKind::Discovered => {
                        ("relationship:discovery", "relationship:discovered-while")
                    }
                };
                history::record(tx, &source_id, source_kind, from_target, to_target, agent)?;
                history::record(tx, &target_id, target_kind, from_source, to_source, agent)?;
            }
            crate::read_ticket(tx, source)
        })
    }
}
