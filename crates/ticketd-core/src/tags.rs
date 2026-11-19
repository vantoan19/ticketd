use rusqlite::{Connection, params};

use crate::write_scope::WriteScope;
use crate::{Error, Ticket, Workspace, history, ticket_change};

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
    let mut statement = connection.prepare_cached(
        "SELECT tag_name FROM ticket_tags WHERE ticket_id = ?1 ORDER BY tag_name",
    )?;
    Ok(statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

/// The longest tag a new tagging may use. Tags already stored stay valid.
const MAX_TAG: usize = 100;

/// The tag name as stored. A write checks this before it enters the write scope, so a
/// blank name is refused at once instead of after waiting for another writer's lock.
/// Finding or removing a tag accepts any stored name, so a tag from before the limits
/// can still be removed.
fn normalize(name: &str) -> Result<String, Error> {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return Err(Error::EmptyTag);
    }
    Ok(name)
}

/// [`normalize`] for a name that is about to be added: it must also be short and free of
/// the characters that make tags ambiguous (a comma does not split in `list --tag`).
pub(crate) fn normalize_new(name: &str) -> Result<String, Error> {
    let name = normalize(name)?;
    if name.chars().count() > MAX_TAG || name.contains([',', '\t', '\n', '\r']) {
        return Err(Error::InvalidTag { max: MAX_TAG });
    }
    Ok(name)
}

impl Workspace {
    /// Search the workspace tag vocabulary, including tags without current members.
    pub fn search_tags(&self, query: &str, limit: u32) -> Result<Vec<String>, Error> {
        let mut statement = self
            .connection
            .prepare("SELECT name FROM tags WHERE instr(name, ?1) > 0 ORDER BY name LIMIT ?2")?;
        Ok(statement
            .query_map(params![query.trim().to_lowercase(), limit.min(50)], |row| {
                row.get(0)
            })?
            .collect::<Result<_, _>>()?)
    }

    /// Add a normalized workspace tag without replacing other memberships.
    pub fn add_tag(&mut self, reference: &str, name: &str) -> Result<Ticket, Error> {
        self.add_tag_as(reference, name, None)
    }

    /// [`Self::add_tag`], attributed to an editing agent.
    pub fn add_tag_as(
        &mut self,
        reference: &str,
        name: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        normalize_new(name)?;
        ticket_change::commit(&self.connection, reference, |scope| {
            add(scope, reference, name, agent)
        })
    }

    /// Remove one normalized tag without replacing other memberships.
    pub fn remove_tag(&mut self, reference: &str, name: &str) -> Result<Ticket, Error> {
        self.remove_tag_as(reference, name, None)
    }

    /// [`Self::remove_tag`], attributed to an editing agent.
    pub fn remove_tag_as(
        &mut self,
        reference: &str,
        name: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        normalize(name)?;
        ticket_change::commit(&self.connection, reference, |scope| {
            remove(scope, reference, name, agent)
        })
    }
}

/// Tag a ticket. The name is checked (see [`normalize_new`]) before the ticket is looked up. Tagging a ticket
/// that already has the tag changes nothing and leaves no history. A change is recorded
/// like any other, which also moves the ticket's `updated_at`.
pub(crate) fn add(
    scope: &WriteScope<'_>,
    reference: &str,
    name: &str,
    agent: Option<&str>,
) -> Result<(), Error> {
    let name = normalize_new(name)?;
    let ticket_id = scope.editable(reference)?;
    scope.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", [&name])?;
    let changed = scope.execute(
        "INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_name) VALUES (?1, ?2)",
        params![ticket_id, name],
    )?;
    if changed != 0 {
        history::record(scope, &ticket_id, "tag", "", &name, agent)?;
    }
    Ok(())
}

pub(crate) fn remove(
    scope: &WriteScope<'_>,
    reference: &str,
    name: &str,
    agent: Option<&str>,
) -> Result<(), Error> {
    let name = normalize(name)?;
    let ticket_id = scope.editable(reference)?;
    let changed = scope.execute(
        "DELETE FROM ticket_tags WHERE ticket_id = ?1 AND tag_name = ?2",
        params![ticket_id, name],
    )?;
    if changed != 0 {
        history::record(scope, &ticket_id, "tag", &name, "", agent)?;
    }
    Ok(())
}
