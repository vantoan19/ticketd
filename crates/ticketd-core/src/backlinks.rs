use std::collections::HashSet;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::{Error, Status, Workspace, document_links::ticket_references, relationships};

#[derive(Debug, Serialize)]
pub struct Backlink {
    pub source_reference: String,
    pub source_title: String,
    pub activity_id: Option<String>,
    /// When the mentioning update was reported; `None` for a ticket description.
    pub reported_at: Option<String>,
    pub passage: String,
    /// Where the mention sits in the Markdown body, counted in Unicode scalar values
    /// (chars), as `passage` is, with a leading U+FEFF not counted:
    /// `body.chars().skip(mention_start).take(mention_end - mention_start)` is the
    /// span. The span is the reference itself when its source has no escapes or
    /// entities; otherwise it is the whole run of text the reference was decoded from.
    pub mention_start: usize,
    pub mention_end: usize,
}

#[derive(Debug, Serialize)]
pub struct TicketMentions {
    pub items: Vec<MentioningTicket>,
    pub total: usize,
}

#[derive(Debug, Serialize)]
pub struct MentioningTicket {
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub mentioned_at: String,
    pub passages: Vec<MentionPassage>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct MentionPassagePage {
    pub items: Vec<MentionPassage>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct MentionPassage {
    pub activity_id: Option<String>,
    pub reported_at: Option<String>,
    pub passage: String,
    pub mention_start: usize,
    pub mention_end: usize,
}

/// A byte offset as a count of chars, not counting a leading byte order mark: the
/// Markdown parser drops it, so renderers never see it.
fn char_offset(content: &str, byte: usize) -> usize {
    let chars = content[..byte].chars().count();
    chars - usize::from(content.starts_with('\u{feff}') && byte > 0)
}

// Markdown escapes and entities can split one visible text node into several events.
pub(crate) fn text_runs(content: &str) -> Vec<(String, std::ops::Range<usize>)> {
    let mut runs = Vec::new();
    let mut current: Option<(String, std::ops::Range<usize>)> = None;
    let mut in_code = false;
    for (event, range) in Parser::new(content).into_offset_iter() {
        if let Event::Text(text) = &event
            && !in_code
        {
            if let Some((value, span)) = &mut current {
                value.push_str(text);
                span.end = range.end;
            } else {
                current = Some((text.to_string(), range));
            }
            continue;
        }
        if let Some(run) = current.take() {
            runs.push(run);
        }
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(TagEnd::CodeBlock) => in_code = false,
            _ => {}
        }
    }
    if let Some(run) = current {
        runs.push(run);
    }
    runs
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch(
        "CREATE TABLE backlink_passages (
            source_id TEXT NOT NULL,
            activity INTEGER NOT NULL,
            reference TEXT NOT NULL,
            ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            mention_start INTEGER NOT NULL,
            mention_end INTEGER NOT NULL,
            passage TEXT NOT NULL,
            PRIMARY KEY (source_id, activity, reference, mention_start)
         );
         CREATE INDEX backlink_passages_reference
            ON backlink_passages(reference, ticket_id);
         CREATE INDEX backlink_passages_ticket ON backlink_passages(ticket_id);
         CREATE TRIGGER backlink_passages_activity_delete AFTER DELETE ON activities
            BEGIN DELETE FROM backlink_passages WHERE source_id = OLD.id AND activity = 1; END;",
    )?;
    let mut sources = tx.prepare(
        "SELECT id, id, body, 0 FROM tickets
         UNION ALL SELECT id, ticket_id, brief, 1 FROM activities",
    )?;
    let mut sources = sources.query([])?;
    while let Some(row) = sources.next()? {
        let body: String = row.get(2)?;
        store_passages(
            tx,
            &row.get::<_, String>(0)?,
            &row.get::<_, String>(1)?,
            &body,
            row.get(3)?,
            &text_runs(&body),
        )?;
    }
    Ok(())
}

/// Replace the visible passage projection in the transaction that saves its Markdown.
pub(crate) fn index(
    tx: &Connection,
    source: &str,
    body: &str,
    activity: bool,
    runs: &[(String, std::ops::Range<usize>)],
) -> Result<(), Error> {
    let owner = if activity {
        "SELECT ticket_id FROM activities WHERE id = ?1"
    } else {
        "SELECT id FROM tickets WHERE id = ?1"
    };
    let ticket: Option<String> = tx
        .prepare_cached(owner)?
        .query_row([source], |row| row.get(0))
        .optional()?;
    if let Some(ticket) = ticket {
        tx.execute(
            "DELETE FROM backlink_passages WHERE source_id = ?1 AND activity = ?2",
            params![source, activity],
        )?;
        store_passages(tx, source, &ticket, body, activity, runs)?;
    }
    Ok(())
}

fn store_passages(
    tx: &Connection,
    source: &str,
    ticket: &str,
    body: &str,
    activity: bool,
    runs: &[(String, std::ops::Range<usize>)],
) -> Result<(), Error> {
    let mut insert = tx.prepare_cached(
        "INSERT INTO backlink_passages
            (source_id, activity, reference, ticket_id, mention_start, mention_end, passage)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let mut line_start = None;
    let mut line_references = HashSet::new();
    for (text, range) in runs {
        let references = ticket_references(text);
        if references.is_empty() {
            continue;
        }
        let start = body[..range.start].rfind('\n').map_or(0, |at| at + 1);
        if line_start != Some(start) {
            line_start = Some(start);
            line_references.clear();
        }
        let end = body[range.end..]
            .find('\n')
            .map_or(body.len(), |at| range.end + at);
        let line = &body[start..end];
        let raw = &body[range.clone()];
        let raw_references = (!raw.contains(['&', '\\'])).then(|| ticket_references(raw));
        for (at, length) in references {
            let reference = &text[at..at + length];
            if !line_references.insert(reference) {
                continue;
            }
            // Escapes and entities can change offsets within a decoded text run.
            let span = raw_references
                .as_ref()
                .and_then(|matches| {
                    matches
                        .iter()
                        .find(|&&(at, len)| &raw[at..at + len] == reference)
                })
                .map_or_else(
                    || range.clone(),
                    |&(at, len)| range.start + at..range.start + at + len,
                );
            let before = body[start..span.start].chars().count();
            let passage: String = line
                .chars()
                .skip(before.saturating_sub(256))
                .take(512)
                .collect();
            insert.execute(params![
                source,
                activity,
                reference,
                ticket,
                char_offset(body, span.start),
                char_offset(body, span.end),
                passage
            ])?;
        }
    }
    Ok(())
}

impl Workspace {
    /// Return a page of current incoming references from visible tickets.
    pub fn backlinks(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Backlink>, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            relationships::id(tx, reference)?;
            query(tx, reference, limit, offset)
        })
    }

    /// Return a page of mentioning tickets, newest first, with their first three passages.
    pub fn ticket_mentions(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<TicketMentions, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            relationships::id(tx, reference)?;
            let total = mentioning_ticket_count(tx, reference)?;
            let mut statement = tx.prepare_cached(
                "SELECT t.id, t.reference, t.title, t.status, MAX(COALESCE(a.reported_at, t.updated_at))
                 FROM backlink_passages b JOIN tickets t ON t.id = b.ticket_id
                 LEFT JOIN activities a ON b.activity = 1 AND a.id = b.source_id
                 WHERE b.reference = ?1 AND t.reference <> ?1 AND t.trashed = 0
                 GROUP BY b.ticket_id
                 ORDER BY 5 DESC, t.number DESC LIMIT ?2 OFFSET ?3",
            )?;
            let mut rows = statement.query(params![reference, limit.clamp(1, 100), offset])?;
            let mut items = Vec::new();
            while let Some(row) = rows.next()? {
                let page = passage_page(tx, reference, &row.get::<_, String>(0)?, 3, 0)?;
                let title: String = row.get(2)?;
                items.push(MentioningTicket {
                    reference: row.get(1)?,
                    title: title.chars().take(256).collect(),
                    status: row.get::<_, String>(3)?.parse()?,
                    mentioned_at: row.get(4)?,
                    passages: page.items,
                    next_offset: page.next_offset,
                });
            }
            Ok(TicketMentions { items, total })
        })
    }

    /// Read more passages from one mentioning ticket.
    pub fn ticket_mention_passages(
        &self,
        reference: &str,
        source_reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<MentionPassagePage, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            relationships::id(tx, reference)?;
            let ticket = relationships::id(tx, source_reference)?;
            passage_page(tx, reference, &ticket, limit, offset)
        })
    }
}

/// Count the sources of mentions using the same indexed projection as their pages.
pub(crate) fn mentioning_ticket_count(tx: &Connection, reference: &str) -> Result<usize, Error> {
    Ok(tx
        .prepare_cached(
            "SELECT COUNT(DISTINCT b.ticket_id)
         FROM backlink_passages b JOIN tickets t ON t.id = b.ticket_id
         WHERE b.reference = ?1 AND t.reference <> ?1 AND t.trashed = 0",
        )?
        .query_row([reference], |row| row.get(0))?)
}

fn passage_page(
    tx: &Connection,
    reference: &str,
    ticket: &str,
    limit: u32,
    offset: u32,
) -> Result<MentionPassagePage, Error> {
    let limit = limit.clamp(1, 100);
    let mut statement = tx.prepare_cached(
        "SELECT a.id, a.reported_at, b.passage, b.mention_start, b.mention_end
         FROM backlink_passages b JOIN tickets t ON t.id = b.ticket_id
         LEFT JOIN activities a ON b.activity = 1 AND a.id = b.source_id
         WHERE b.reference = ?1 AND b.ticket_id = ?2 AND t.reference <> ?1 AND t.trashed = 0
         ORDER BY COALESCE(a.reported_at, t.updated_at) DESC, a.number DESC, b.mention_start
         LIMIT ?3 OFFSET ?4",
    )?;
    let mut items = statement
        .query_map(params![reference, ticket, limit + 1, offset], |row| {
            Ok(MentionPassage {
                activity_id: row.get(0)?,
                reported_at: row.get(1)?,
                passage: row.get(2)?,
                mention_start: row.get(3)?,
                mention_end: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let next_offset = if items.len() > limit as usize {
        items.pop();
        offset.checked_add(limit)
    } else {
        None
    };
    Ok(MentionPassagePage { items, next_offset })
}

pub(crate) fn query(
    tx: &Connection,
    reference: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Backlink>, Error> {
    let mut statement = tx.prepare_cached(
        "SELECT t.reference, t.title, a.id, a.reported_at, b.passage, b.mention_start, b.mention_end
         FROM backlink_passages b JOIN tickets t ON t.id = b.ticket_id
         LEFT JOIN activities a ON b.activity = 1 AND a.id = b.source_id
         WHERE b.reference = ?1 AND t.reference <> ?1 AND t.trashed = 0
         ORDER BY t.number, a.number, b.mention_start LIMIT ?2 OFFSET ?3",
    )?;
    Ok(statement
        .query_map(params![reference, limit.clamp(1, 100), offset], |row| {
            let title: String = row.get(1)?;
            Ok(Backlink {
                source_reference: row.get(0)?,
                source_title: title.chars().take(256).collect(),
                activity_id: row.get(2)?,
                reported_at: row.get(3)?,
                passage: row.get(4)?,
                mention_start: row.get(5)?,
                mention_end: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::char_offset;

    #[test]
    fn char_offsets_skip_a_leading_byte_order_mark_and_count_chars() {
        let content = "\u{feff}😀 T-KQ1";
        let at = content.find("T-KQ1").unwrap();
        assert_eq!(char_offset(content, at), 2);
        assert_eq!(char_offset("😀 T-KQ1", "😀 ".len()), 2);
    }
}
