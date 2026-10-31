use crate::{Error, Ticket, Workspace, history, relationships};
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
    let mut statement = connection.prepare("SELECT tickets.number, tickets.title, tickets.trashed FROM tickets JOIN ticket_parents ON tickets.id = ticket_parents.parent_id WHERE ticket_parents.child_id = ?1")?;
    ticket.parent = statement
        .query_row([&ticket.id], |row| {
            Ok(RelatedTicket {
                reference: format!("T-{}", row.get::<_, i64>(0)?),
                title: row.get(1)?,
                trashed: row.get(2)?,
            })
        })
        .optional()?;
    let mut statement = connection.prepare("SELECT tickets.number, tickets.title, tickets.trashed FROM tickets JOIN ticket_parents ON tickets.id = ticket_parents.child_id WHERE ticket_parents.parent_id = ?1 ORDER BY tickets.number")?;
    ticket.children = statement
        .query_map([&ticket.id], |row| {
            Ok(RelatedTicket {
                reference: format!("T-{}", row.get::<_, i64>(0)?),
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
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let parent_id = relationships::id(&tx, parent)?;
        let child_id = relationships::id(&tx, child)?;
        crate::ensure_editable(&tx, &parent_id)?;
        let changed = tx.execute(
            "DELETE FROM ticket_parents WHERE child_id = ?1 AND parent_id = ?2",
            params![child_id, parent_id],
        )?;
        if changed != 0 {
            history::record(&tx, &child_id, "parent", parent, "", agent)?;
        }
        tx.commit()?;
        self.show_ticket(parent)
    }
    pub fn set_parent(
        &mut self,
        child: &str,
        parent: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let child_id = relationships::id(&tx, child)?;
        let old: Option<String> = tx.query_row("SELECT 'T-' || tickets.number FROM ticket_parents JOIN tickets ON tickets.id = ticket_parents.parent_id WHERE child_id = ?1", [&child_id], |row| row.get(0)).optional()?;
        // Removing a link is allowed if either endpoint remains visible.
        if parent.is_none() {
            if let Err(error) = crate::ensure_editable(&tx, &child_id) {
                if let Some(ref old_parent) = old {
                    let old_id = relationships::id(&tx, old_parent)?;
                    crate::ensure_editable(&tx, &old_id)?;
                } else {
                    return Err(error);
                }
            }
        } else {
            crate::ensure_editable(&tx, &child_id)?;
        }
        let parent_id = parent.map(|p| relationships::id(&tx, p)).transpose()?;
        if let Some(ref parent_id) = parent_id {
            crate::ensure_editable(&tx, parent_id)?;
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
            if let Some(parent_id) = parent_id {
                tx.execute(
                    "INSERT INTO ticket_parents (child_id, parent_id) VALUES (?1, ?2)",
                    params![child_id, parent_id],
                )?;
            }
            history::record(
                &tx,
                &child_id,
                "parent",
                old.as_deref().unwrap_or(""),
                parent.unwrap_or(""),
                agent,
            )?;
        }
        tx.commit()?;
        self.show_ticket(child)
    }
}
