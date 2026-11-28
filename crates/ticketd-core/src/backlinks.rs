use std::collections::HashMap;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use rusqlite::Connection;
use serde::Serialize;

use crate::{Error, Status, Workspace, relationships};

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
}

#[derive(Debug, Serialize)]
pub struct MentionPassage {
    pub activity_id: Option<String>,
    pub reported_at: Option<String>,
    pub passage: String,
    pub mention_start: usize,
    pub mention_end: usize,
}

/// Byte offset of the first occurrence of `reference` that is not part of a longer word.
fn find_reference(text: &str, reference: &str) -> Option<usize> {
    text.match_indices(reference)
        .find(|(start, _)| {
            let before = text[..*start].chars().next_back();
            let after = text[start + reference.len()..].chars().next();
            let boundary = |c: char| !c.is_alphanumeric() && c != '-' && c != '_';
            before.is_none_or(boundary) && after.is_none_or(boundary)
        })
        .map(|(start, _)| start)
}

/// The byte span of a mention within its text run. A run whose source holds escapes
/// or entities decoded to different text, so only the whole run is trustworthy; any
/// other run is searched for the reference token (a table row's run covers the pipes).
fn mention_span(
    content: &str,
    run: &std::ops::Range<usize>,
    reference: &str,
) -> std::ops::Range<usize> {
    let raw = &content[run.clone()];
    if raw.contains(['&', '\\']) {
        return run.clone();
    }
    find_reference(raw, reference).map_or(run.clone(), |at| {
        run.start + at..run.start + at + reference.len()
    })
}

/// A byte offset as a count of chars, not counting a leading byte order mark: the
/// Markdown parser drops it, so renderers never see it.
fn char_offset(content: &str, byte: usize) -> usize {
    let chars = content[..byte].chars().count();
    chars - usize::from(content.starts_with('\u{feff}') && byte > 0)
}

fn contains_reference(text: &str, reference: &str) -> bool {
    find_reference(text, reference).is_some()
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
            let links = query(tx, reference, limit, offset)?;
            Ok(links)
        })
    }

    /// Return mentions grouped by source ticket, ordered by each ticket's latest mention.
    pub fn ticket_mentions(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<TicketMentions, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            relationships::id(tx, reference)?;
            let mut items: Vec<MentioningTicket> = Vec::new();
            let mut seen = HashMap::new();
            let limit = limit.clamp(1, 100) as usize;
            let offset = offset as usize;
            scan(
                tx,
                reference,
                "ORDER BY 8 DESC, 6 DESC, 5 DESC",
                |row, source| {
                    let next = seen.len();
                    let index = *seen.entry(source.reference.clone()).or_insert(next);
                    if let Some(index) = index.checked_sub(offset).filter(|index| *index < limit) {
                        if index == items.len() {
                            items.push(MentioningTicket {
                                reference: source.reference.clone(),
                                title: source.title.chars().take(256).collect(),
                                status: row.get::<_, String>(8)?.parse()?,
                                mentioned_at: row.get(7)?,
                                passages: Vec::new(),
                            });
                        }
                        items[index].passages.extend(source.passages(reference));
                    }
                    Ok(true)
                },
            )?;
            Ok(TicketMentions {
                items,
                total: seen.len(),
            })
        })
    }
}

pub(crate) fn query(
    tx: &Connection,
    reference: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Backlink>, Error> {
    let mut links = Vec::new();
    let mut seen = 0;
    let limit = limit.clamp(1, 100) as usize;
    scan(tx, reference, "ORDER BY 6, 5", |_, source| {
        for passage in source.passages(reference) {
            if seen >= offset {
                links.push(Backlink {
                    source_reference: source.reference.clone(),
                    source_title: source.title.chars().take(256).collect(),
                    activity_id: passage.activity_id,
                    reported_at: passage.reported_at,
                    mention_start: passage.mention_start,
                    mention_end: passage.mention_end,
                    passage: passage.passage,
                });
                if links.len() == limit {
                    return Ok(false);
                }
            }
            seen += 1;
        }
        Ok(true)
    })?;
    Ok(links)
}

struct MentionSource {
    reference: String,
    title: String,
    activity_id: Option<String>,
    content: String,
    reported_at: Option<String>,
    runs: Vec<std::ops::Range<usize>>,
}

impl MentionSource {
    fn passages<'a>(&'a self, reference: &'a str) -> impl Iterator<Item = MentionPassage> + 'a {
        let mut last_line = None;
        self.runs.iter().filter_map(move |range| {
            let content = &self.content;
            let start = content[..range.start].rfind('\n').map_or(0, |i| i + 1);
            if last_line == Some(start) {
                return None;
            }
            last_line = Some(start);
            let end = content[range.end..]
                .find('\n')
                .map_or(content.len(), |i| range.end + i);
            let mention = mention_span(content, range, reference);
            let line = &content[start..end];
            let reference_offset = line.find(reference).unwrap_or(range.start - start);
            let before = line[..reference_offset].chars().count();
            Some(MentionPassage {
                activity_id: self.activity_id.clone(),
                reported_at: self.reported_at.clone(),
                mention_start: char_offset(content, mention.start),
                mention_end: char_offset(content, mention.end),
                passage: line
                    .chars()
                    .skip(before.saturating_sub(256))
                    .take(512)
                    .collect(),
            })
        })
    }
}

fn scan(
    tx: &Connection,
    reference: &str,
    order: &str,
    mut visit: impl FnMut(&rusqlite::Row<'_>, MentionSource) -> Result<bool, Error>,
) -> Result<(), Error> {
    let pattern = format!("%{reference}%");
    let mut statement = tx.prepare(&format!(
        "SELECT t.reference,t.title,NULL,t.body,0,t.number,NULL,t.updated_at,t.status
         FROM tickets t WHERE t.trashed=0 AND (t.body LIKE ?1 OR instr(t.body,'&')>0 OR instr(t.body,char(92))>0)
         UNION ALL SELECT t.reference,t.title,n.id,n.brief,n.number,t.number,n.reported_at,n.reported_at,t.status
         FROM activities n JOIN tickets t ON t.id=n.ticket_id
         WHERE t.trashed=0 AND (n.brief LIKE ?1 OR instr(n.brief,'&')>0 OR instr(n.brief,char(92))>0)
         {order}"
    ))?;
    let mut rows = statement.query([pattern])?;
    while let Some(row) = rows.next()? {
        let source_reference: String = row.get(0)?;
        if reference == source_reference {
            continue;
        }
        let content: String = row.get(3)?;
        let runs: Vec<_> = text_runs(&content)
            .into_iter()
            .filter_map(|(text, range)| contains_reference(&text, reference).then_some(range))
            .collect();
        if runs.is_empty() {
            continue;
        }
        let found = MentionSource {
            reference: source_reference,
            title: row.get(1)?,
            activity_id: row.get(2)?,
            content,
            reported_at: row.get(6)?,
            runs,
        };
        if !visit(row, found)? {
            break;
        }
    }
    Ok(())
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
