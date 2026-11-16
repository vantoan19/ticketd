use crate::{Error, Ticket, Workspace, history, relationships, write_scope};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelatedTicket {
    pub reference: String,
    pub title: String,
    pub trashed: bool,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE ticket_parents (child_id TEXT PRIMARY KEY REFERENCES tickets(id), parent_id TEXT NOT NULL REFERENCES tickets(id)); CREATE INDEX ticket_parents_parent ON ticket_parents(parent_id);")?;
    Ok(())
}

pub(crate) fn populate(connection: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    let mut statement = connection.prepare("SELECT tickets.reference, tickets.title, tickets.trashed FROM tickets JOIN ticket_parents ON tickets.id = ticket_parents.parent_id WHERE ticket_parents.child_id = ?1")?;
    ticket.parent = statement
        .query_row([&ticket.id], |row| {
            Ok(RelatedTicket {
                reference: row.get::<_, String>(0)?,
                title: row.get(1)?,
                trashed: row.get(2)?,
            })
        })
        .optional()?;
    let mut statement = connection.prepare("SELECT tickets.reference, tickets.title, tickets.trashed FROM tickets JOIN ticket_parents ON tickets.id = ticket_parents.child_id WHERE ticket_parents.parent_id = ?1 ORDER BY tickets.number")?;
    ticket.children = statement
        .query_map([&ticket.id], |row| {
            Ok(RelatedTicket {
                reference: row.get::<_, String>(0)?,
                title: row.get(1)?,
                trashed: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(())
}

impl Workspace {
    pub fn detach_child(
        &mut self,
        parent: &str,
        child: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        write_scope::run(&self.connection, |tx| {
            // The child may be in Trash: a visible parent can let it go.
            let parent_id = tx.even_if_trashed(parent)?;
            let child_id = tx.even_if_trashed(child)?;
            tx.ensure_editable(&parent_id)?;
            let changed = tx.execute(
                "DELETE FROM ticket_parents WHERE child_id = ?1 AND parent_id = ?2",
                params![child_id, parent_id],
            )?;
            if changed != 0 {
                history::record(tx, &child_id, "parent", parent, "", agent)?;
                history::record(tx, &parent_id, "relationship:child", child, "", agent)?;
            }
            crate::read_ticket(tx, parent)
        })
    }
    pub fn set_parent(
        &mut self,
        child: &str,
        parent: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        write_scope::run(&self.connection, |tx| {
            let child_id = tx.even_if_trashed(child)?;
            let old: Option<String> = tx.query_row("SELECT tickets.reference FROM ticket_parents JOIN tickets ON tickets.id = ticket_parents.parent_id WHERE child_id = ?1", [&child_id], |row| row.get(0)).optional()?;
            // Removing a link is allowed if either endpoint remains visible.
            if parent.is_none() {
                if let Err(error) = tx.ensure_editable(&child_id) {
                    if let Some(ref old_parent) = old {
                        let old_id = relationships::id(tx, old_parent)?;
                        tx.ensure_editable(&old_id)?;
                    } else {
                        return Err(error);
                    }
                }
            } else {
                tx.ensure_editable(&child_id)?;
            }
            let parent_id = parent.map(|p| relationships::id(tx, p)).transpose()?;
            if let Some(ref parent_id) = parent_id {
                tx.ensure_editable(parent_id)?;
                let invalid: bool = tx.query_row("SELECT ?1 = ?2 OR EXISTS(SELECT 1 FROM ticket_parents WHERE child_id = ?2) OR EXISTS(SELECT 1 FROM ticket_parents WHERE parent_id = ?1)", params![child_id, parent_id], |row| row.get(0))?;
                if invalid {
                    return Err(Error::InvalidHierarchy);
                }
            }
            if old.as_deref() != parent {
                tx.execute(
                    "DELETE FROM ticket_parents WHERE child_id = ?1",
                    [&child_id],
                )?;
                if let Some(ref parent_id) = parent_id {
                    tx.execute(
                        "INSERT INTO ticket_parents (child_id, parent_id) VALUES (?1, ?2)",
                        params![child_id, parent_id],
                    )?;
                }
                if let Some(old_parent) = old.as_deref() {
                    let old_id = relationships::id(tx, old_parent)?;
                    history::record(tx, &old_id, "relationship:child", child, "", agent)?;
                }
                if let Some(parent_id) = parent_id {
                    history::record(tx, &parent_id, "relationship:child", "", child, agent)?;
                }
                history::record(
                    tx,
                    &child_id,
                    "parent",
                    old.as_deref().unwrap_or(""),
                    parent.unwrap_or(""),
                    agent,
                )?;
            }
            crate::read_ticket(tx, child)
        })
    }
}
