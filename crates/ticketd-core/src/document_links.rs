use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::{Error, Ticket, TicketPatch, Workspace};

#[derive(Debug, Serialize)]
pub struct ContextLink {
    pub activity_id: Option<String>,
    pub source_id: String,
    pub target_id: String,
    pub source_kind: String,
    pub target_kind: String,
    pub passage: String,
    pub source_label: String,
    pub target_label: String,
    pub source_trashed: bool,
    pub target_trashed: bool,
}

#[derive(Debug, Serialize)]
pub struct DocumentBacklink {
    pub source_reference: String,
    pub source_title: String,
    pub passage: String,
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch("INSERT OR IGNORE INTO entities(id, kind) SELECT id, 'ticket' FROM tickets; INSERT OR IGNORE INTO entities(id, kind) SELECT id, 'plan' FROM plans;
        CREATE TRIGGER IF NOT EXISTS ticket_entity_insert AFTER INSERT ON tickets BEGIN INSERT INTO entities(id,kind) VALUES (NEW.id,'ticket'); END;
        CREATE TRIGGER IF NOT EXISTS plan_entity_insert AFTER INSERT ON plans BEGIN INSERT INTO entities(id,kind) VALUES (NEW.id,'plan'); END;
        CREATE TABLE IF NOT EXISTS context_mentions (source_id TEXT NOT NULL REFERENCES entities(id), target_id TEXT NOT NULL REFERENCES entities(id), passage TEXT NOT NULL, PRIMARY KEY(source_id, target_id, passage));
        CREATE INDEX IF NOT EXISTS context_mentions_target ON context_mentions(target_id, source_id); PRAGMA user_version = 35;")?;
    let mut statement =
        tx.prepare("SELECT id, body FROM tickets UNION ALL SELECT id, body FROM documents")?;
    let items = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, body) in items {
        index_body(tx, &id, &body)?;
    }
    Ok(())
}

fn passage(body: &str, at: usize) -> String {
    let start = body[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = body[at..].find('\n').map_or(body.len(), |i| at + i);
    let before = body[start..at].chars().count();
    body[start..end]
        .chars()
        .skip(before.saturating_sub(256))
        .take(512)
        .collect()
}

pub(crate) fn index_body(tx: &Connection, id: &str, body: &str) -> Result<(), Error> {
    index_numbers(tx, id, body, false)?;
    index_text(tx, id, body, false)
}

pub(crate) fn index_activity(tx: &Connection, id: &str, body: &str) -> Result<(), Error> {
    index_numbers(tx, id, body, true)?;
    index_text(tx, id, body, true)?;
    // Backlinks recognize visible ticket references even in link text and
    // decoded Markdown runs; retain those established references here too.
    for (text, range) in crate::backlinks::text_runs(body) {
        for (at, _) in text.match_indices("T-") {
            let rest = &text[at + 2..];
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            let boundary = |c: char| !c.is_alphanumeric() && c != '-' && c != '_';
            if digits == 0
                || rest.starts_with('0')
                || !text[..at].chars().next_back().is_none_or(boundary)
                || !rest[digits..].chars().next().is_none_or(boundary)
            {
                continue;
            }
            if let Ok(number) = rest[..digits].parse::<i64>() {
                let target: Option<String> = tx
                    .query_row(
                        "SELECT id FROM tickets WHERE number = ?1",
                        [number],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(target) = target {
                    let offset = body[range.clone()]
                        .find(&text[at..at + 2 + digits])
                        .map_or(range.start, |n| range.start + n);
                    tx.execute("INSERT OR IGNORE INTO activity_mentions (activity_id, target_id, passage) VALUES (?1, ?2, ?3)", params![id, target, passage(body, offset)])?;
                }
            }
        }
    }
    Ok(())
}

fn index_numbers(tx: &Connection, id: &str, body: &str, activity: bool) -> Result<(), Error> {
    tx.execute(
        "DELETE FROM numeric_mentions WHERE source_id = ?1 AND activity = ?2",
        params![id, activity],
    )?;
    for (text, range) in crate::backlinks::text_runs(body) {
        for (at, _) in text.match_indices("T-") {
            let rest = &text[at + 2..];
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            let boundary = |c: char| !c.is_alphanumeric() && c != '-' && c != '_';
            if digits == 0
                || rest.starts_with('0')
                || !text[..at].chars().next_back().is_none_or(boundary)
                || !rest[digits..].chars().next().is_none_or(boundary)
            {
                continue;
            }
            if let Ok(number) = rest[..digits].parse::<i64>() {
                let offset = body[range.clone()]
                    .find(&text[at..at + 2 + digits])
                    .map_or(range.start, |n| range.start + n);
                tx.execute("INSERT OR IGNORE INTO numeric_mentions(source_id, activity, number, passage) VALUES (?1, ?2, ?3, ?4)", params![id, activity, number, passage(body, offset)])?;
            }
        }
    }
    Ok(())
}

fn index_text(tx: &Connection, id: &str, body: &str, activity: bool) -> Result<(), Error> {
    let (delete, insert) = if activity {
        (
            "DELETE FROM activity_mentions WHERE activity_id = ?1",
            "INSERT OR IGNORE INTO activity_mentions (activity_id, target_id, passage) VALUES (?1, ?2, ?3)",
        )
    } else {
        (
            "DELETE FROM context_mentions WHERE source_id = ?1",
            "INSERT OR IGNORE INTO context_mentions (source_id, target_id, passage) VALUES (?1, ?2, ?3)",
        )
    };
    tx.execute(delete, [id])?;
    let mut in_link = false;
    let mut in_code = false;
    for (event, range) in Parser::new(body).into_offset_iter() {
        match &event {
            Event::Start(Tag::Link { .. }) => in_link = true,
            Event::End(TagEnd::Link) => in_link = false,
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Text(text) if !in_link && !in_code => {
                for (at, _) in text.match_indices("T-") {
                    let rest = &text[at + 2..];
                    let digits = rest.chars().take_while(char::is_ascii_digit).count();
                    let before = text[..at].chars().next_back();
                    let after = rest[digits..].chars().next();
                    let boundary = |c: char| !c.is_alphanumeric() && c != '-' && c != '_';
                    if digits == 0
                        || rest.starts_with('0')
                        || !before.is_none_or(boundary)
                        || !after.is_none_or(boundary)
                    {
                        continue;
                    }
                    if let Ok(number) = rest[..digits].parse::<i64>() {
                        let target = tx
                            .query_row("SELECT id FROM tickets WHERE number = ?1", [number], |r| {
                                r.get::<_, String>(0)
                            })
                            .optional()?;
                        if let Some(target) = target {
                            let at = body[range.clone()]
                                .find(&text[at..at + 2 + digits])
                                .map_or(range.start, |offset| range.start + offset);
                            tx.execute(insert, params![id, target, passage(body, at)])?;
                        }
                    }
                }
            }
            _ => {}
        }
        if let Event::Start(Tag::Link { dest_url, .. }) = event {
            let target = if let Some(document) = dest_url.strip_prefix("ticketd://document/") {
                tx.query_row("SELECT id FROM documents WHERE id = ?1", [document], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
            } else if let Some(reference) = dest_url.strip_prefix("ticketd://ticket/") {
                let number = reference
                    .strip_prefix("T-")
                    .and_then(|n| n.parse::<i64>().ok());
                tx.query_row("SELECT id FROM tickets WHERE number = ?1", [number], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
            } else if let Some(plan) = dest_url.strip_prefix("ticketd://plan/") {
                tx.query_row("SELECT id FROM plans WHERE id = ?1", [plan], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
            } else {
                None
            };
            if let Some(target) = target {
                tx.execute(insert, params![id, target, passage(body, range.start)])?;
            }
        }
    }
    Ok(())
}

impl Workspace {
    pub fn context_link_markdown(&self, reference: &str) -> Result<String, Error> {
        if reference.starts_with("T-") {
            let ticket = self.show_ticket(reference)?;
            return Ok(format!(
                "[{}](ticketd://ticket/{})",
                ticket.reference, ticket.reference
            ));
        }
        let kind: Option<String> = self
            .connection
            .query_row(
                "SELECT kind FROM entities WHERE id = ?1",
                [reference],
                |r| r.get(0),
            )
            .optional()?;
        match kind.as_deref() {
            Some("document") => {
                self.show_document(reference)?;
                Ok(format!("[Document](ticketd://document/{reference})"))
            }
            Some("plan") => {
                crate::plans::get(&self.connection, reference)?;
                Ok(format!("[Plan](ticketd://plan/{reference})"))
            }
            _ => Err(Error::NotFound(reference.to_owned())),
        }
    }
    pub fn create_ticket_from_document(&mut self, id: &str, title: &str) -> Result<Ticket, Error> {
        self.connection
            .execute_batch("SAVEPOINT create_ticket_from_document")?;
        let result = (|| {
            if self.show_document(id)?.trashed {
                return Err(Error::Trashed(id.to_owned()));
            }
            let ticket = self.create_ticket(title)?;
            self.change_ticket(
                &ticket.reference,
                TicketPatch {
                    body: Some(format!("[Source Document](ticketd://document/{id})")),
                    ..Default::default()
                },
            )
        })();
        match result {
            Ok(ticket) => {
                self.connection
                    .execute_batch("RELEASE create_ticket_from_document")?;
                Ok(ticket)
            }
            Err(error) => {
                self.connection.execute_batch(
                    "ROLLBACK TO create_ticket_from_document; RELEASE create_ticket_from_document",
                )?;
                Err(error)
            }
        }
    }

    fn context_link_page(
        &self,
        id: &str,
        outgoing: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ContextLink>, Error> {
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM entities WHERE id = ?1)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound(id.to_owned()));
        }
        let column = if outgoing { "source_id" } else { "target_id" };
        let mut statement = self.connection.prepare(&format!("SELECT m.source_id, m.target_id, s.kind, t.kind, m.passage, COALESCE((SELECT 'T-' || number FROM tickets WHERE id = s.id), (SELECT COALESCE(NULLIF(title,''), 'Untitled Document') FROM documents WHERE id = s.id), (SELECT name FROM plans WHERE id = s.id), s.id), COALESCE((SELECT 'T-' || number FROM tickets WHERE id = t.id), (SELECT COALESCE(NULLIF(title,''), 'Untitled Document') FROM documents WHERE id = t.id), (SELECT name FROM plans WHERE id = t.id), t.id), m.activity_id , COALESCE((SELECT trashed FROM documents WHERE id = s.id), (SELECT trashed FROM tickets WHERE id = s.id), 0), COALESCE((SELECT trashed FROM documents WHERE id = t.id), (SELECT trashed FROM tickets WHERE id = t.id), 0) FROM (SELECT source_id, target_id, passage, NULL AS activity_id FROM context_mentions UNION ALL SELECT a.ticket_id, m.target_id, m.passage, m.activity_id FROM activity_mentions m JOIN activities a ON a.id = m.activity_id) m JOIN entities s ON s.id = m.source_id JOIN entities t ON t.id = m.target_id WHERE m.{column} = ?1 ORDER BY m.source_id, m.target_id, m.passage LIMIT ?2 OFFSET ?3"))?;
        let links = statement
            .query_map(params![id, limit.clamp(1, 100), offset], |r| {
                Ok(ContextLink {
                    activity_id: r.get(7)?,
                    source_id: r.get(0)?,
                    target_id: r.get(1)?,
                    source_kind: r.get(2)?,
                    target_kind: r.get(3)?,
                    passage: r.get(4)?,
                    source_label: r.get(5)?,
                    target_label: r.get(6)?,
                    source_trashed: r.get(8)?,
                    target_trashed: r.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(links)
    }
    pub fn context_links(
        &self,
        id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ContextLink>, Error> {
        self.context_link_page(id, true, limit, offset)
    }
    pub fn context_backlinks(
        &self,
        id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ContextLink>, Error> {
        self.context_link_page(id, false, limit, offset)
    }
    pub fn document_backlinks(
        &self,
        id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<DocumentBacklink>, Error> {
        self.show_document(id)?;
        let mut statement = self.connection.prepare("SELECT t.number, t.title, m.passage FROM context_mentions m JOIN tickets t ON t.id = m.source_id WHERE m.target_id = ?1 ORDER BY t.number, m.passage LIMIT ?2 OFFSET ?3")?;
        let links = statement
            .query_map(params![id, limit.clamp(1, 100), offset], |r| {
                Ok(DocumentBacklink {
                    source_reference: format!("T-{}", r.get::<_, i64>(0)?),
                    source_title: r.get(1)?,
                    passage: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(links)
    }
}
