use rusqlite::{Connection, params};

use crate::{Error, Ticket, Workspace};

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS ticket_tags (
             ticket_id TEXT NOT NULL REFERENCES tickets(id),
             tag_name TEXT NOT NULL REFERENCES tags(name),
             PRIMARY KEY (ticket_id, tag_name)
         );",
    )?;
    Ok(())
}

pub(crate) fn for_ticket(connection: &Connection, id: &str) -> Result<Vec<String>, Error> {
    let mut statement = connection
        .prepare("SELECT tag_name FROM ticket_tags WHERE ticket_id = ?1 ORDER BY tag_name")?;
    Ok(statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

fn normalize(name: &str) -> Result<String, Error> {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return Err(Error::EmptyTag);
    }
    Ok(name)
}

impl Workspace {
    /// Search the workspace tag vocabulary, including tags without current members.
    pub fn search_tags(&self, query: &str, limit: u32) -> Result<Vec<String>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT name FROM tags WHERE instr(name, ?1) > 0 ORDER BY name LIMIT ?2",
        )?;
        Ok(statement
            .query_map(params![query.trim().to_lowercase(), limit.min(50)], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    /// Add a normalized workspace tag without replacing other memberships.
    pub fn add_tag(&mut self, reference: &str, name: &str) -> Result<Ticket, Error> {
        let name = normalize(name)?;
        let ticket = self.show_ticket(reference)?;
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        crate::ensure_editable(&transaction, &ticket.id)?;
        transaction.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", [&name])?;
        transaction.execute(
            "INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_name) VALUES (?1, ?2)",
            params![ticket.id, name],
        )?;
        transaction.commit()?;
        self.show_ticket(reference)
    }

    /// Remove one normalized tag without replacing other memberships.
    pub fn remove_tag(&mut self, reference: &str, name: &str) -> Result<Ticket, Error> {
        let name = normalize(name)?;
        let ticket = self.show_ticket(reference)?;
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        crate::ensure_editable(&transaction, &ticket.id)?;
        transaction.execute(
            "DELETE FROM ticket_tags WHERE ticket_id = ?1 AND tag_name = ?2",
            params![ticket.id, name],
        )?;
        transaction.commit()?;
        self.show_ticket(reference)
    }
}
