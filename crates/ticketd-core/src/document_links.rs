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
    /// True for a reference a person attached to the ticket, as opposed to a mention in its text.
    pub explicit: bool,
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

/// Explicit-link mentions plus plain-text Ticket reference mentions resolved when read, so a reference to a
/// ticket created later appears, and the context graph and link lists always agree.
/// Explicit ticket-to-Document references (the `ticket_documents` table) join them with the
/// an empty passage (there is no text to quote) and `explicit` set.
const DOCUMENT_MENTIONS: &str = "(SELECT source_id, target_id, passage, 0 AS explicit FROM context_mentions UNION SELECT n.source_id, t.id, n.passage, 0 FROM numeric_mentions n JOIN tickets t ON t.reference = n.reference WHERE n.activity = 0 UNION SELECT ticket_id, document_id, '', 1 FROM ticket_documents)";

/// The plain-text mention index and its per-ticket Activity projection. Both hold the
/// reference as written, so a mention of a ticket that does not exist yet resolves later.
pub(crate) const MENTION_INDEX_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS numeric_mentions (source_id TEXT NOT NULL, activity INTEGER NOT NULL, reference TEXT NOT NULL, passage TEXT NOT NULL, PRIMARY KEY(source_id, activity, reference, passage));
    CREATE INDEX IF NOT EXISTS numeric_mentions_number ON numeric_mentions(reference, activity, source_id, passage);
    CREATE TABLE IF NOT EXISTS activity_graph_numbers (ticket_id TEXT NOT NULL, activity_id TEXT NOT NULL, reference TEXT NOT NULL, passage TEXT NOT NULL, PRIMARY KEY(ticket_id, activity_id, reference, passage));
    CREATE INDEX IF NOT EXISTS activity_graph_numbers_source ON activity_graph_numbers(activity_id, reference, passage);
    CREATE TRIGGER IF NOT EXISTS activity_graph_numbers_insert AFTER INSERT ON numeric_mentions WHEN NEW.activity=1 BEGIN INSERT OR IGNORE INTO activity_graph_numbers SELECT ticket_id, NEW.source_id, NEW.reference, NEW.passage FROM activities WHERE id=NEW.source_id; END;
    CREATE TRIGGER IF NOT EXISTS activity_graph_numbers_delete AFTER DELETE ON numeric_mentions WHEN OLD.activity=1 BEGIN DELETE FROM activity_graph_numbers WHERE activity_id=OLD.source_id AND reference=OLD.reference AND passage=OLD.passage; END;";

/// Every standalone Ticket reference in plain text (`T-`, a two-letter device code, then a
/// counter: `T-KQ43`), as the byte offset and length of the token. This is the one rule for
/// what counts as a plain-text mention.
pub(crate) fn ticket_references(text: &str) -> Vec<(usize, usize)> {
    let boundary = |c: char| !c.is_alphanumeric() && c != '-' && c != '_';
    let mut found = Vec::new();
    for (at, _) in text.match_indices("T-") {
        let rest = &text[at + 2..];
        let letters = rest.bytes().take_while(u8::is_ascii_uppercase).count();
        let digits = rest[letters..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if letters == 2
            && digits > 0
            && !rest[letters..].starts_with('0')
            && text[..at].chars().next_back().is_none_or(boundary)
            && rest[letters + digits..].chars().next().is_none_or(boundary)
        {
            found.push((at, 2 + letters + digits));
        }
    }
    found
}

/// Whether `text` is exactly one well-formed Ticket reference.
pub(crate) fn is_ticket_reference(text: &str) -> bool {
    ticket_references(text) == [(0, text.len())]
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
    crate::embedded_attachments::index(tx, id, body)?;
    index_numbers(tx, id, body, false)?;
    index_text(tx, id, body, false)
}

pub(crate) fn index_external_body(tx: &Connection, id: &str, body: &str) -> Result<(), Error> {
    crate::embedded_attachments::index_external(tx, id, body)?;
    index_numbers(tx, id, body, false)?;
    index_text(tx, id, body, false)
}

pub(crate) fn index_activity(tx: &Connection, id: &str, body: &str) -> Result<(), Error> {
    crate::embedded_attachments::index(tx, id, body)?;
    index_activity_mentions(tx, id, body)
}

/// A brief received from another device stays readable when its file links cannot resolve here.
pub(crate) fn index_external_activity(tx: &Connection, id: &str, body: &str) -> Result<(), Error> {
    crate::embedded_attachments::index_external(tx, id, body)?;
    index_activity_mentions(tx, id, body)
}

fn index_activity_mentions(tx: &Connection, id: &str, body: &str) -> Result<(), Error> {
    index_numbers(tx, id, body, true)?;
    index_text(tx, id, body, true)?;
    // Backlinks recognize visible ticket references even in link text and
    // decoded Markdown runs; retain those established references here too.
    for (text, range) in crate::backlinks::text_runs(body) {
        for (at, len) in ticket_references(&text) {
            let target: Option<String> = tx
                .query_row(
                    "SELECT id FROM tickets WHERE reference = ?1",
                    [&text[at..at + len]],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(target) = target {
                let offset = body[range.clone()]
                    .find(&text[at..at + len])
                    .map_or(range.start, |n| range.start + n);
                tx.execute("INSERT OR IGNORE INTO activity_mentions (activity_id, target_id, passage) VALUES (?1, ?2, ?3)", params![id, target, passage(body, offset)])?;
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
        for (at, len) in ticket_references(&text) {
            let reference = &text[at..at + len];
            let offset = body[range.clone()]
                .find(reference)
                .map_or(range.start, |n| range.start + n);
            tx.execute("INSERT OR IGNORE INTO numeric_mentions(source_id, activity, reference, passage) VALUES (?1, ?2, ?3, ?4)", params![id, activity, reference, passage(body, offset)])?;
        }
    }
    for (event, range) in Parser::new(body).into_offset_iter() {
        if let Event::Start(Tag::Link { dest_url, .. }) = event
            && let Some(reference) = dest_url
                .strip_prefix("ticketd://ticket/")
                .filter(|reference| is_ticket_reference(reference))
        {
            tx.execute("INSERT OR IGNORE INTO numeric_mentions(source_id, activity, reference, passage) VALUES (?1, ?2, ?3, ?4)", params![id, activity, reference, passage(body, range.start)])?;
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
            Event::Text(text) if activity && !in_link && !in_code => {
                for (at, len) in ticket_references(text) {
                    let target = tx
                        .query_row(
                            "SELECT id FROM tickets WHERE reference = ?1",
                            [&text[at..at + len]],
                            |r| r.get::<_, String>(0),
                        )
                        .optional()?;
                    if let Some(target) = target {
                        let at = body[range.clone()]
                            .find(&text[at..at + len])
                            .map_or(range.start, |offset| range.start + offset);
                        tx.execute(insert, params![id, target, passage(body, at)])?;
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
                tx.query_row(
                    "SELECT id FROM tickets WHERE reference = ?1",
                    [reference],
                    |r| r.get::<_, String>(0),
                )
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

/// The first plain-text line of Markdown: markers, emphasis and link syntax removed, whitespace
/// collapsed, at most 120 characters. This is the one rule for a Document's derived heading.
pub fn derive_heading(markdown: &str) -> Option<String> {
    const MAX: usize = 120;
    let mut line = String::new();
    let mut found = None;
    for event in Parser::new_ext(
        markdown,
        pulldown_cmark::Options::ENABLE_STRIKETHROUGH | pulldown_cmark::Options::ENABLE_TASKLISTS,
    ) {
        match event {
            Event::Text(text)
            | Event::Code(text)
            | Event::InlineMath(text)
            | Event::Html(text)
            | Event::InlineHtml(text) => {
                line.push_str(&text);
            }
            Event::End(
                TagEnd::Emphasis
                | TagEnd::Strong
                | TagEnd::Strikethrough
                | TagEnd::Link
                | TagEnd::Image,
            ) => {}
            Event::SoftBreak | Event::HardBreak | Event::End(_) | Event::Rule => {
                let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
                line.clear();
                if !collapsed.is_empty() {
                    found = Some(collapsed);
                    break;
                }
            }
            _ => {}
        }
    }
    let collapsed = found?;
    if collapsed.chars().count() <= MAX {
        return Some(collapsed);
    }
    let cut: String = collapsed.chars().take(MAX - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// A heading for Activity details taken from the update's brief: its first sentence, at most
/// 80 characters, so a long brief is not repeated whole as the Document's name.
pub fn derive_brief_heading(markdown: &str) -> Option<String> {
    const MAX: usize = 80;
    let line = derive_heading(markdown)?;
    let chars: Vec<char> = line.chars().collect();
    let end = (0..chars.len())
        .find(|&index| {
            matches!(chars[index], '.' | '!' | '?')
                && chars.get(index + 1).is_none_or(|next| next.is_whitespace())
        })
        .map_or(chars.len(), |index| {
            // A full stop ends the sentence quietly; ! and ? are part of it.
            if chars[index] == '.' {
                index
            } else {
                index + 1
            }
        });
    let sentence: String = chars[..end].iter().collect();
    if sentence.chars().count() <= MAX {
        return Some(sentence);
    }
    let cut: String = sentence.chars().take(MAX - 1).collect();
    // Prefer ending on a whole word.
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    Some(format!("{}…", cut.trim_end()))
}

pub(crate) fn register_heading_function(connection: &Connection) -> Result<(), Error> {
    use rusqlite::functions::FunctionFlags;
    connection.create_scalar_function(
        "ticketd_brief_heading",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(ctx
                .get::<Option<String>>(0)?
                .and_then(|text| derive_brief_heading(&text)))
        },
    )?;
    connection.create_scalar_function(
        "ticketd_heading",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(ctx
                .get::<Option<String>>(0)?
                .and_then(|text| derive_heading(&text)))
        },
    )?;
    Ok(())
}

/// Markdown link text must not contain brackets that would end the label early.
fn link_text(heading: &str) -> String {
    heading
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
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
                let heading = link_text(&self.show_document(reference)?.heading);
                Ok(format!("[{heading}](ticketd://document/{reference})"))
            }
            Some("plan") => {
                let plan = crate::plans::get(&self.connection, reference)?;
                Ok(format!(
                    "[{}](ticketd://plan/{reference})",
                    link_text(&plan.name)
                ))
            }
            _ => Err(Error::NotFound(reference.to_owned())),
        }
    }
    pub fn create_ticket_from_document(&mut self, id: &str, title: &str) -> Result<Ticket, Error> {
        self.create_ticket_from_document_following(id, title, false)
    }

    /// Like `create_ticket_from_document`; with `follow` the local person follows the new
    /// ticket, starting after its setup so it does not fill the inbox.
    pub fn create_ticket_from_document_following(
        &mut self,
        id: &str,
        title: &str,
        follow: bool,
    ) -> Result<Ticket, Error> {
        // The scope folds the creation and the body that links the Document into one
        // `ticket.created` event.
        self.in_write_scope(|workspace| {
            let source = workspace.show_document(id)?;
            if source.trashed {
                return Err(Error::DocumentTrashed(id.to_owned()));
            }
            let ticket = workspace.create_ticket(title)?;
            if follow {
                crate::inbox::follow(&workspace.connection, &ticket.id)?;
            }
            workspace.change_ticket(
                &ticket.reference,
                TicketPatch {
                    body: Some(format!(
                        "[{}](ticketd://document/{id})",
                        link_text(&source.heading)
                    )),
                    ..Default::default()
                },
            )
        })
    }

    fn context_link_page(
        &self,
        id: &str,
        outgoing: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ContextLink>, Error> {
        // Accept a Ticket reference as well as an entity ID.
        let id = &if id.starts_with("T-") {
            crate::relationships::id(&self.connection, id)?
        } else {
            id.to_owned()
        };
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM entities WHERE id = ?1)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound(id.to_owned()));
        }
        let column = if outgoing { "source_id" } else { "target_id" };
        let mut statement = self.connection.prepare(&format!("SELECT m.source_id, m.target_id, s.kind, t.kind, m.passage, COALESCE((SELECT reference FROM tickets WHERE id = s.id), (SELECT {h} FROM documents d WHERE d.id = s.id), (SELECT name FROM plans WHERE id = s.id), s.id), COALESCE((SELECT reference FROM tickets WHERE id = t.id), (SELECT {h} FROM documents d WHERE d.id = t.id), (SELECT name FROM plans WHERE id = t.id), t.id), m.activity_id , COALESCE((SELECT trashed FROM documents WHERE id = s.id), (SELECT trashed FROM tickets WHERE id = s.id), 0), COALESCE((SELECT trashed FROM documents WHERE id = t.id), (SELECT trashed FROM tickets WHERE id = t.id), 0), m.explicit FROM (SELECT source_id, target_id, passage, NULL AS activity_id, explicit FROM {mentions} UNION ALL SELECT a.ticket_id, m.target_id, m.passage, m.activity_id, 0 FROM activity_mentions m JOIN activities a ON a.id = m.activity_id) m JOIN entities s ON s.id = m.source_id JOIN entities t ON t.id = m.target_id WHERE m.{column} = ?1 ORDER BY m.source_id, m.target_id, m.passage LIMIT ?2 OFFSET ?3", h = crate::documents::HEADING, mentions = DOCUMENT_MENTIONS))?;
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
                    explicit: r.get(10)?,
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
        let mut statement = self.connection.prepare(&format!("SELECT t.reference, t.title, m.passage FROM {DOCUMENT_MENTIONS} m JOIN tickets t ON t.id = m.source_id WHERE m.target_id = ?1 ORDER BY t.number, m.passage LIMIT ?2 OFFSET ?3"))?;
        let links = statement
            .query_map(params![id, limit.clamp(1, 100), offset], |r| {
                Ok(DocumentBacklink {
                    source_reference: r.get::<_, String>(0)?,
                    source_title: r.get(1)?,
                    passage: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(links)
    }
}
