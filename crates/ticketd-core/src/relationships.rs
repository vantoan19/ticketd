use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Error, Status, Ticket, Workspace, history};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prerequisite {
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub trashed: bool,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS dependencies (blocker_id TEXT NOT NULL REFERENCES tickets(id), dependent_id TEXT NOT NULL REFERENCES tickets(id), PRIMARY KEY (blocker_id, dependent_id));")?;
    Ok(())
}

pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    let mut statement = connection.prepare("SELECT number, title, status, trashed FROM tickets JOIN dependencies ON tickets.id = dependencies.blocker_id WHERE dependencies.dependent_id = ?1 ORDER BY number")?;
    ticket.prerequisites = statement
        .query_map([&ticket.id], |row| {
            let status: String = row.get(2)?;
            Ok(Prerequisite {
                reference: format!("T-{}", row.get::<_, i64>(0)?),
                title: row.get(1)?,
                trashed: row.get(3)?,
                status: status.parse().map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
            })
        })?
        .collect::<Result<_, _>>()?;
    ticket.availability = if ticket.status == Status::Todo {
        Some(
            if ticket
                .prerequisites
                .iter()
                .all(|p| p.status == Status::Done)
            {
                "Ready"
            } else {
                "Blocked"
            }
            .into(),
        )
    } else {
        None
    };
    Ok(())
}

pub(crate) fn id(connection: &Connection, reference: &str) -> Result<String, Error> {
    let number = reference
        .strip_prefix("T-")
        .and_then(|n| n.parse::<i64>().ok());
    connection
        .query_row(
            "SELECT id FROM tickets WHERE number = ?1",
            [number],
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
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let blocker_id = id(&tx, blocker)?;
        let dependent_id = id(&tx, dependent)?;
        crate::ensure_editable(&tx, &blocker_id)?;
        crate::ensure_editable(&tx, &dependent_id)?;
        let cycle: bool = tx.query_row("WITH RECURSIVE reachable(id) AS (SELECT dependent_id FROM dependencies WHERE blocker_id = ?1 UNION SELECT dependencies.dependent_id FROM dependencies JOIN reachable ON dependencies.blocker_id = reachable.id) SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ?2)", params![dependent_id, blocker_id], |row| row.get(0))?;
        if blocker_id == dependent_id || cycle {
            return Err(Error::DependencyCycle);
        }
        let changed = tx.execute(
            "INSERT OR IGNORE INTO dependencies (blocker_id, dependent_id) VALUES (?1, ?2)",
            params![blocker_id, dependent_id],
        )?;
        if changed != 0 {
            history::record(&tx, &dependent_id, "dependency", "", blocker, agent)?;
            history::record(
                &tx,
                &blocker_id,
                "relationship:blocks",
                "",
                dependent,
                agent,
            )?;
        }
        tx.commit()?;
        self.show_ticket(dependent)
    }
    pub fn remove_dependency(
        &mut self,
        blocker: &str,
        dependent: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let blocker_id = id(&tx, blocker)?;
        let dependent_id = id(&tx, dependent)?;
        // Either visible endpoint may detach an edge to a trashed ticket.
        let blocker_trash: bool = tx.query_row(
            "SELECT trashed FROM tickets WHERE id = ?1",
            [&blocker_id],
            |r| r.get(0),
        )?;
        if blocker_trash {
            crate::ensure_editable(&tx, &dependent_id)?;
        } else {
            crate::ensure_editable(&tx, &blocker_id)?;
        }
        let changed = tx.execute(
            "DELETE FROM dependencies WHERE blocker_id = ?1 AND dependent_id = ?2",
            params![blocker_id, dependent_id],
        )?;
        if changed != 0 {
            history::record(&tx, &dependent_id, "dependency", blocker, "", agent)?;
            history::record(
                &tx,
                &blocker_id,
                "relationship:blocks",
                dependent,
                "",
                agent,
            )?;
        }
        tx.commit()?;
        self.show_ticket(dependent)
    }
}
