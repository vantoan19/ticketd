use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use rusqlite::Connection;
use serde::Serialize;

use crate::{Error, Workspace, relationships};

#[derive(Debug, Serialize)]
pub struct Backlink {
    pub source_reference: String,
    pub source_title: String,
    pub note_id: Option<String>,
    pub passage: String,
    /// Source span of the text holding the reference, in UTF-16 code units of the
    /// Markdown (the unit JavaScript string offsets use), so a renderer can locate it.
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

fn contains_reference(text: &str, reference: &str) -> bool {
    find_reference(text, reference).is_some()
}

// Markdown escapes and entities can split one visible text node into several events.
fn text_runs(content: &str) -> Vec<(String, std::ops::Range<usize>)> {
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
        let tx = self.connection.unchecked_transaction()?;
        relationships::id(&tx, reference)?;
        let links = query(&tx, reference, limit, offset)?;
        tx.commit()?;
        Ok(links)
    }
}

pub(crate) fn query(
    tx: &Connection,
    reference: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Backlink>, Error> {
    let pattern = format!("%{reference}%");
    let mut statement = tx.prepare("SELECT t.number,t.title,NULL,t.body,0 FROM tickets t WHERE t.trashed=0 AND (t.body LIKE ?1 OR instr(t.body,'&')>0 OR instr(t.body,char(92))>0) UNION ALL SELECT t.number,t.title,n.id,n.content,n.number FROM notes n JOIN tickets t ON t.id=n.ticket_id WHERE t.trashed=0 AND (n.content LIKE ?1 OR instr(n.content,'&')>0 OR instr(n.content,char(92))>0) ORDER BY 1,5")?;
    let mut rows = statement.query([pattern])?;
    let mut links = Vec::new();
    let mut seen = 0u32;
    let limit = limit.clamp(1, 100);
    while let Some(row) = rows.next()? {
        let number: i64 = row.get(0)?;
        let title: String = row.get(1)?;
        let note_id: Option<String> = row.get(2)?;
        let content: String = row.get(3)?;
        let mut last_line = None;
        for (text, range) in text_runs(&content) {
            if !contains_reference(&text, reference) {
                continue;
            }
            let start = content[..range.start].rfind('\n').map_or(0, |i| i + 1);
            if last_line == Some(start) {
                continue;
            }
            last_line = Some(start);
            let end = content[range.end..]
                .find('\n')
                .map_or(content.len(), |i| range.end + i);
            if seen >= offset {
                // Narrow the run to the reference when the source spells it out; a run
                // whose source uses escapes or entities keeps its whole span.
                let mention = find_reference(&content[range.clone()], reference)
                    .map_or(range.clone(), |at| {
                        range.start + at..range.start + at + reference.len()
                    });
                let mention = content[..mention.start].encode_utf16().count()
                    ..content[..mention.end].encode_utf16().count();
                links.push(Backlink {
                    source_reference: format!("T-{number}"),
                    source_title: title.chars().take(256).collect(),
                    note_id: note_id.clone(),
                    mention_start: mention.start,
                    mention_end: mention.end,
                    passage: {
                        let line = &content[start..end];
                        let reference_offset = line.find(reference).unwrap_or(range.start - start);
                        let before = line[..reference_offset].chars().count();
                        line.chars()
                            .skip(before.saturating_sub(256))
                            .take(512)
                            .collect()
                    },
                });
                if links.len() == limit as usize {
                    break;
                }
            }
            seen = seen.saturating_add(1);
        }
        if links.len() == limit as usize {
            break;
        }
    }
    drop(rows);
    drop(statement);
    Ok(links)
}
