use crate::{Error, Ticket, Workspace, history, relationships};
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) fn migrate(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch("CREATE TABLE duplicate_tickets (source_id TEXT PRIMARY KEY REFERENCES tickets(id), canonical_id TEXT NOT NULL REFERENCES tickets(id), restore_status TEXT); PRAGMA user_version = 15;")?;
    Ok(())
}

pub(crate) fn populate(conn: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    ticket.duplicate_of = conn.query_row("SELECT 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id WHERE d.source_id = ?1", [&ticket.id], |r| r.get(0)).optional()?;
    let mut stmt = conn.prepare("SELECT 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id WHERE d.canonical_id = ?1 ORDER BY t.number")?;
    ticket.duplicates = stmt
        .query_map([&ticket.id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(())
}

impl Workspace {
    pub fn mark_duplicate(
        &mut self,
        source: &str,
        canonical: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let source_id = relationships::id(&tx, source)?;
        let canonical_id = relationships::id(&tx, canonical)?;
        crate::ensure_editable(&tx, &source_id)?;
        crate::ensure_editable(&tx, &canonical_id)?;
        let destination: String = tx.query_row("SELECT COALESCE((SELECT canonical_id FROM duplicate_tickets WHERE source_id = ?1), ?1)", [&canonical_id], |r| r.get(0))?;
        crate::ensure_editable(&tx, &destination)?;
        if source_id == canonical_id || source_id == destination {
            return Err(Error::DuplicateCycle);
        }
        let incident: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM dependencies WHERE blocker_id = ?1 OR dependent_id = ?1)",
            [&source_id],
            |r| r.get(0),
        )?;
        if incident {
            return Err(Error::DuplicateDependencies);
        }
        let status: String = tx.query_row(
            "SELECT status FROM tickets WHERE id = ?1",
            [&source_id],
            |r| r.get(0),
        )?;
        let previous: Option<String> = tx.query_row("SELECT 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id WHERE d.source_id = ?1", [&source_id], |r| r.get(0)).optional()?;
        let target: String = tx.query_row(
            "SELECT 'T-' || number FROM tickets WHERE id = ?1",
            [&destination],
            |r| r.get(0),
        )?;
        if previous.as_deref() != Some(&target) {
            let mut stmt = tx.prepare("SELECT t.id, 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id WHERE d.canonical_id = ?1")?;
            let children = stmt
                .query_map([&source_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            tx.execute(
                "UPDATE duplicate_tickets SET canonical_id = ?1 WHERE canonical_id = ?2",
                params![destination, source_id],
            )?;
            for (id, _) in children {
                history::record(&tx, &id, "relationship:duplicate", source, &target, agent)?;
            }
            tx.execute("INSERT INTO duplicate_tickets (source_id, canonical_id, restore_status) VALUES (?1, ?2, ?3) ON CONFLICT(source_id) DO UPDATE SET canonical_id = excluded.canonical_id", params![source_id, destination, status])?;
            history::record(
                &tx,
                &source_id,
                "relationship:duplicate",
                previous.as_deref().unwrap_or(""),
                &target,
                agent,
            )?;
        }
        if status != "Canceled" {
            tx.execute(
                "UPDATE tickets SET status = 'Canceled' WHERE id = ?1",
                [&source_id],
            )?;
            history::record(&tx, &source_id, "status", &status, "Canceled", agent)?;
        }
        tx.commit()?;
        self.show_ticket(source)
    }

    pub fn remove_duplicate(&mut self, source: &str, agent: Option<&str>) -> Result<Ticket, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let id = relationships::id(&tx, source)?;
        crate::ensure_editable(&tx, &id)?;
        let existing: Option<(Option<String>, String, String)> = tx.query_row("SELECT d.restore_status, 'T-' || c.number, s.status FROM duplicate_tickets d JOIN tickets c ON c.id = d.canonical_id JOIN tickets s ON s.id = d.source_id WHERE d.source_id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        if let Some((restore, canonical, status)) = existing {
            tx.execute("DELETE FROM duplicate_tickets WHERE source_id = ?1", [&id])?;
            history::record(&tx, &id, "relationship:duplicate", &canonical, "", agent)?;
            if let Some(restore) = restore.filter(|r| r != &status) {
                tx.execute(
                    "UPDATE tickets SET status = ?1 WHERE id = ?2",
                    params![restore, id],
                )?;
                history::record(&tx, &id, "status", &status, &restore, agent)?;
            }
        }
        tx.commit()?;
        self.show_ticket(source)
    }
}
