use crate::{Error, Workspace};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: Option<String>,
    pub body: String,
    #[serde(default)]
    pub heading: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub trashed: bool,
    #[serde(default)]
    pub origin_brief: Option<String>,
    #[serde(default)]
    pub origin_ticket: Option<String>,
    #[serde(default)]
    pub kept: bool,
    /// The author's one-line plain-text summary. ticketd never writes one.
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentSummary {
    pub id: String,
    pub heading: String,
    pub origin_ticket: Option<String>,
    /// Short plain-text excerpt of the body, without Markdown markers.
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
    /// The Plans the Document is attached to, the one it is the spec of first, then Active
    /// before Archived, then by name.
    #[serde(default)]
    pub plans: Vec<DocumentPlanContext>,
    /// The tickets (not in Trash) whose Documents include this one, by ticket number.
    #[serde(default)]
    pub tickets: Vec<DocumentTicketContext>,
    /// Whether the Document has been opened on this computer.
    #[serde(default)]
    pub opened: bool,
    #[serde(default)]
    pub summary: Option<String>,
}

/// A Plan a Document is attached to, as a list row names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentPlanContext {
    pub id: String,
    pub name: String,
    pub archived: bool,
    /// The Document is this Plan's spec.
    pub spec: bool,
}

/// A ticket whose Documents include this one, as a list row names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentTicketContext {
    pub reference: String,
    pub title: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentSearchResult {
    pub id: String,
    pub heading: String,
    pub snippet: String,
    pub origin_ticket: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub plans: Vec<DocumentPlanContext>,
    #[serde(default)]
    pub tickets: Vec<DocumentTicketContext>,
    #[serde(default)]
    pub opened: bool,
    #[serde(default)]
    pub summary: Option<String>,
}

impl From<DocumentSummary> for DocumentSearchResult {
    fn from(summary: DocumentSummary) -> Self {
        Self {
            id: summary.id,
            heading: summary.heading,
            snippet: summary.snippet,
            origin_ticket: summary.origin_ticket,
            tags: summary.tags,
            updated_at: summary.updated_at,
            plans: summary.plans,
            tickets: summary.tickets,
            opened: summary.opened,
            summary: summary.summary,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DocumentPatch {
    /// Outer None leaves the title unchanged; Some(None) removes it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_title"
    )]
    pub title: Option<Option<String>>,
    pub body: Option<String>,
    /// Outer None leaves the summary unchanged; Some(None) or an empty value removes it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_title"
    )]
    pub summary: Option<Option<String>>,
    /// The `updated_at` the caller last saw. When present and stale the change is rejected, so
    /// an editor's autosave cannot silently overwrite a change made elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
}

/// A summary is one line of plain text: line breaks become a space and the ends are
/// trimmed. Nothing left means no summary.
pub(crate) fn one_line_summary(summary: &str) -> Option<String> {
    let line = summary
        .split(['\n', '\r', '\u{85}', '\u{2028}', '\u{2029}'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!line.is_empty()).then_some(line)
}

fn present_title<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

pub(crate) fn migrate(tx: &rusqlite::Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, UNIQUE(id, kind));
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'document' CHECK(kind = 'document'), title TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), FOREIGN KEY(id, kind) REFERENCES entities(id, kind));
        CREATE TABLE IF NOT EXISTS document_opens (sequence INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL UNIQUE REFERENCES documents(id));")?;
    Ok(())
}

/// Format version 100: a Document's optional one-line summary, written by its author.
pub(crate) fn migrate_summary(tx: &rusqlite::Transaction<'_>) -> Result<(), Error> {
    crate::format::add_column_if_missing(tx, "documents", "summary", "TEXT")
}

pub(crate) fn migrate_search(tx: &rusqlite::Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(title, body, content='documents', content_rowid='rowid');
        INSERT INTO document_fts(document_fts) VALUES ('rebuild');
        CREATE TRIGGER IF NOT EXISTS document_fts_insert AFTER INSERT ON documents BEGIN
            INSERT INTO document_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS document_fts_delete AFTER DELETE ON documents BEGIN
            INSERT INTO document_fts(document_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS document_fts_update AFTER UPDATE OF title, body ON documents BEGIN
            INSERT INTO document_fts(document_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
            INSERT INTO document_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
        CREATE TABLE IF NOT EXISTS document_pins (document_id TEXT PRIMARY KEY REFERENCES documents(id));
        CREATE TABLE IF NOT EXISTS document_tags (document_id TEXT NOT NULL REFERENCES documents(id), tag_name TEXT NOT NULL REFERENCES tags(name), PRIMARY KEY(document_id, tag_name));
        CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags(tag_name, document_id);")?;
    Ok(())
}

// A Document's heading: its explicit title, else the originating Activity's brief (docs/product.md, Activities and activity details),
// else the first plain-text line of its body. `ticketd_heading` is registered on every workspace connection.
pub(crate) const HEADING: &str = "coalesce(nullif(substr(trim(d.title), 1, 200), ''), ticketd_brief_heading((SELECT brief FROM activities WHERE id = d.originating_activity_id)), ticketd_heading(substr(d.body, 1, 4096)), 'Untitled')";
/// Columns read by every Document list query; see `summary_from_row`.
pub(crate) fn summary_columns() -> String {
    format!(
        "d.id, {HEADING}, (SELECT t.reference FROM activities a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=d.originating_activity_id), d.body, d.updated_at, (SELECT group_concat(tag_name, char(31)) FROM (SELECT tag_name FROM document_tags WHERE document_id = d.id ORDER BY tag_name)), d.summary, {PLANS_JSON}, {tickets}, EXISTS (SELECT 1 FROM document_opens WHERE document_id = d.id)",
        tickets = tickets_json()
    )
}

/// A row's Plans (Archived included) as a JSON array, the one it is the spec of first.
const PLANS_JSON: &str = "(SELECT json_group_array(json_object('id', id, 'name', name, 'archived', json(CASE archived WHEN 0 THEN 'false' ELSE 'true' END), 'spec', json(CASE spec WHEN 0 THEN 'false' ELSE 'true' END))) FROM (SELECT p.id AS id, p.name AS name, p.archived AS archived, coalesce(p.spec_document_id = d.id, 0) AS spec FROM plan_documents pd JOIN plans p ON p.id = pd.plan_id WHERE pd.document_id = d.id ORDER BY spec DESC, p.archived, p.name, p.id))";

/// A row's tickets, in Trash excluded, as a JSON array: those whose description mentions the
/// Document and those it is attached to.
fn tickets_json() -> String {
    format!(
        "(SELECT json_group_array(json_object('reference', reference, 'title', title, 'status', status)) FROM (SELECT t.reference AS reference, t.title AS title, t.status AS status FROM tickets t WHERE t.trashed = 0 AND t.id IN (SELECT m.source_id FROM {} m WHERE m.target_id = d.id) ORDER BY t.number))",
        crate::document_links::DOCUMENT_MENTIONS
    )
}

pub(crate) fn summary_from_row(
    row: &rusqlite::Row<'_>,
    query: Option<&str>,
) -> rusqlite::Result<DocumentSummary> {
    let body: String = row.get(3)?;
    let heading: String = row.get(1)?;
    let tags: Option<String> = row.get(5)?;
    Ok(DocumentSummary {
        id: row.get(0)?,
        heading: heading.clone(),
        origin_ticket: row.get(2)?,
        snippet: plain_snippet(&body, &heading, query),
        tags: tags
            .map(|value| value.split('\u{1f}').map(str::to_owned).collect())
            .unwrap_or_default(),
        updated_at: row.get(4)?,
        summary: row.get(6)?,
        plans: json_column(row, 7)?,
        tickets: json_column(row, 8)?,
        opened: row.get(9)?,
    })
}

fn json_column<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<Vec<T>> {
    let json: String = row.get(index)?;
    serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, error.into())
    })
}

/// The capture editor's empty-state hint. It is never meant to be saved, but a Document that
/// already holds it as a trailing block must not show it as its excerpt.
const CAPTURE_PLACEHOLDER: &str = "Write a thought…";

/// Plain text of the Markdown `body`, collapsed to one line, without the Document's own
/// `heading` (the row already shows it) or the capture placeholder. With a `query`, the
/// excerpt is centred on its first match so a result shows why it matched.
fn plain_snippet(body: &str, heading: &str, query: Option<&str>) -> String {
    const LIMIT: usize = 160;
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    let body = body.strip_prefix('\u{feff}').unwrap_or(body);
    let mut text = String::new();
    let mut in_code_block = false;
    let mut in_metadata = false;
    // A leading heading is the Document's own heading, which the list already shows.
    let mut skipping_heading = false;
    let mut started = false;
    for event in Parser::new_ext(
        body,
        crate::document_links::HEADING_OPTIONS | Options::ENABLE_TABLES,
    ) {
        match event {
            Event::Start(Tag::MetadataBlock(_)) => in_metadata = true,
            Event::End(TagEnd::MetadataBlock(_)) => {
                in_metadata = false;
                continue;
            }
            _ => {}
        }
        if in_metadata {
            continue;
        }
        if !started && matches!(event, Event::Start(_)) {
            started = true;
            skipping_heading = matches!(event, Event::Start(Tag::Heading { .. }));
            if skipping_heading {
                continue;
            }
        }
        match event {
            Event::End(TagEnd::Heading(_)) if skipping_heading => skipping_heading = false,
            _ if skipping_heading => {}
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Text(part) | Event::Code(part) | Event::InlineMath(part) if !in_code_block => {
                text.push_str(&part);
            }
            // Inline markup ends no word; every other boundary (block, table cell, break) separates words.
            Event::End(
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link,
            ) => {}
            Event::SoftBreak | Event::HardBreak | Event::End(_) | Event::Rule => text.push(' '),
            _ => {}
        }
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    // A search excerpt shows why the Document matched, even when that is the heading.
    let text = if query.is_some() {
        text.as_str()
    } else {
        without_repeated_heading(&text, heading)
    };
    let text = text
        .strip_suffix(CAPTURE_PLACEHOLDER)
        .filter(|rest| rest.is_empty() || rest.ends_with(' '))
        .map_or(text, str::trim_end)
        .to_owned();
    let chars: Vec<char> = text.chars().collect();
    let start = query
        .and_then(|needle| {
            let lower: String = text.to_lowercase();
            let byte = lower.find(&needle.to_lowercase())?;
            // Lowercasing can change byte offsets; fall back to the start when it does.
            (lower.len() == text.len()).then(|| text[..byte].chars().count())
        })
        .map_or(0, |at| at.saturating_sub(40));
    let end = (start + LIMIT).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

/// A body that opens with the Document's heading (a derived heading is its first line) repeats it.
fn without_repeated_heading<'a>(text: &'a str, heading: &str) -> &'a str {
    match text.strip_prefix(heading.trim()) {
        Some(rest) if !heading.trim().is_empty() && (rest.is_empty() || rest.starts_with(' ')) => {
            rest.trim_start()
        }
        _ => text,
    }
}

impl Workspace {
    pub fn create_document(&mut self, title: Option<&str>, body: &str) -> Result<Document, Error> {
        self.create_document_with_summary(title, None, body)
    }

    /// Like [`Workspace::create_document`], with the author's one-line summary.
    pub fn create_document_with_summary(
        &mut self,
        title: Option<&str>,
        summary: Option<&str>,
        body: &str,
    ) -> Result<Document, Error> {
        let summary = summary.and_then(one_line_summary);
        let id = Uuid::new_v4().to_string();
        self.connection.execute_batch("SAVEPOINT create_document")?;
        let result = (|| {
            self.connection.execute(
                "INSERT INTO entities (id, kind) VALUES (?1, 'document')",
                [&id],
            )?;
            self.connection.execute(
                "INSERT INTO documents (id, title, body, summary) VALUES (?1, ?2, ?3, ?4)",
                params![id, title, body, summary],
            )?;
            crate::document_links::index_body(&self.connection, &id, body)?;
            self.open_document(&id)
        })();
        match result.and_then(|document| {
            // Releasing the outermost savepoint can fail at commit, too.
            self.connection.execute_batch("RELEASE create_document")?;
            Ok(document)
        }) {
            Ok(document) => Ok(document),
            Err(error) => {
                self.connection
                    .execute_batch("ROLLBACK TO create_document; RELEASE create_document")?;
                Err(error)
            }
        }
    }

    pub fn show_document(&self, id: &str) -> Result<Document, Error> {
        self.connection
            .query_row(
                &format!("SELECT d.id, d.title, d.body, d.created_at, d.updated_at, d.trashed, (SELECT brief FROM activities WHERE id = d.originating_activity_id), d.kept, (SELECT t.reference FROM activities a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = d.originating_activity_id), {HEADING}, d.summary FROM documents d WHERE d.id = ?1"),
                [id],
                |row| {
                    Ok(Document {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        body: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        trashed: row.get(5)?,
                        origin_brief: row.get(6)?,
                        kept: row.get(7)?,
                        origin_ticket: row.get(8)?,
                        heading: row.get(9)?,
                        summary: row.get(10)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| Error::DocumentNotFound(id.to_owned()))
    }

    /// Cheap change check for an open editor: `(updated_at, trashed)` without reading the body.
    pub fn document_version(&self, id: &str) -> Result<(String, bool), Error> {
        self.connection
            .query_row(
                "SELECT updated_at, trashed FROM documents WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::DocumentNotFound(id.to_owned()))
    }

    /// One Document's list row (Plans, tickets, tags, opened), for a reader that needs the
    /// same context a list row carries. A Document in Trash has a row too.
    pub fn document_summary(&self, id: &str) -> Result<DocumentSummary, Error> {
        let columns = summary_columns();
        self.connection
            .query_row(
                &format!("SELECT {columns} FROM documents d WHERE d.id = ?1"),
                [id],
                |row| summary_from_row(row, None),
            )
            .optional()?
            .ok_or_else(|| Error::DocumentNotFound(id.to_owned()))
    }

    pub fn open_document(&mut self, id: &str) -> Result<Document, Error> {
        let document = self.show_document(id)?;
        self.connection.execute("INSERT INTO document_opens (document_id) VALUES (?1) ON CONFLICT(document_id) DO UPDATE SET sequence = (SELECT coalesce(max(sequence), 0) + 1 FROM document_opens)", [id])?;
        Ok(document)
    }

    pub fn recent_documents(&self) -> Result<Vec<DocumentSummary>, Error> {
        self.recent_documents_page(50, 0)
    }

    pub fn recent_documents_page(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<DocumentSummary>, Error> {
        self.recent_documents_including_support(limit, offset, false)
    }

    pub fn recent_documents_including_support(
        &self,
        limit: u32,
        offset: u32,
        include_support: bool,
    ) -> Result<Vec<DocumentSummary>, Error> {
        let columns = summary_columns();
        let sql = format!(
            "SELECT {columns} FROM documents d LEFT JOIN document_opens o ON d.id = o.document_id WHERE d.trashed = 0 AND (o.document_id IS NOT NULL OR d.kept = 1 OR (?3 AND d.originating_activity_id IS NOT NULL)) AND (?3 OR d.originating_activity_id IS NULL OR d.kept = 1) ORDER BY o.sequence DESC, d.created_at DESC, d.id LIMIT ?1 OFFSET ?2"
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params![limit.min(100), offset, include_support], |row| {
                summary_from_row(row, None)
            })?
            .collect::<Result<_, _>>()?)
    }

    /// Every live Document, most recently changed first, one bounded page at a time.
    /// Activity details are included only when asked for or kept.
    pub fn all_documents_page(
        &self,
        limit: u32,
        offset: u32,
        include_support: bool,
    ) -> Result<Vec<DocumentSummary>, Error> {
        let columns = summary_columns();
        let sql = format!(
            "SELECT {columns} FROM documents d WHERE d.trashed = 0 AND (?3 OR d.originating_activity_id IS NULL OR d.kept = 1) ORDER BY d.updated_at DESC, d.id LIMIT ?1 OFFSET ?2"
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params![limit.min(100), offset, include_support], |row| {
                summary_from_row(row, None)
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn pinned_documents(&self, limit: u32, offset: u32) -> Result<Vec<DocumentSummary>, Error> {
        let columns = summary_columns();
        let sql = format!(
            "SELECT {columns} FROM document_pins p JOIN documents d ON d.id = p.document_id WHERE d.trashed = 0 ORDER BY d.id LIMIT ?1 OFFSET ?2"
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params![limit.min(100), offset], |row| {
                summary_from_row(row, None)
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn search_documents(
        &self,
        query: &str,
        tag: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<DocumentSearchResult>, Error> {
        self.search_documents_including_support(query, tag, limit, offset, false)
    }

    pub fn search_documents_including_support(
        &self,
        query: &str,
        tag: Option<&str>,
        limit: u32,
        offset: u32,
        include_support: bool,
    ) -> Result<Vec<DocumentSearchResult>, Error> {
        let query = query.trim();
        if query.is_empty() {
            let Some(tag) = tag else {
                return Ok(Vec::new());
            };
            let columns = summary_columns();
            let sql = format!(
                "SELECT {columns} FROM document_tags t JOIN documents d ON d.id = t.document_id WHERE t.tag_name = ?1 AND d.trashed = 0 AND (?4 OR d.originating_activity_id IS NULL OR d.kept = 1) ORDER BY d.id LIMIT ?2 OFFSET ?3"
            );
            let mut statement = self.connection.prepare(&sql)?;
            return Ok(statement
                .query_map(
                    params![
                        tag.trim().to_lowercase(),
                        limit.min(100),
                        offset,
                        include_support
                    ],
                    |row| summary_from_row(row, None).map(Into::into),
                )?
                .collect::<Result<_, _>>()?);
        }
        // Every word is a quoted prefix term, so partial words match as the user types.
        let expression = query
            .split_whitespace()
            .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let tag = tag.map(|value| value.trim().to_lowercase());
        let columns = summary_columns();
        // An Activity-details Document is shown under its originating Activity's brief, which is
        // not in the full-text index; match every word against that displayed heading too.
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let heading_match: String = (0..words.len())
            .map(|i| format!(" AND instr(lower({HEADING}), ?{})", i + 6))
            .collect();
        let sql = format!(
            "SELECT * FROM (
                SELECT {columns}, 0 AS source, rank AS score FROM document_fts JOIN documents d ON d.rowid = document_fts.rowid WHERE d.trashed = 0 AND (?5 OR d.originating_activity_id IS NULL OR d.kept = 1) AND document_fts MATCH ?1 AND (?2 IS NULL OR EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag_name = ?2))
                UNION ALL
                SELECT {columns}, 1, 0 FROM documents d WHERE d.trashed = 0 AND d.originating_activity_id IS NOT NULL AND (?5 OR d.kept = 1) AND d.rowid NOT IN (SELECT rowid FROM document_fts WHERE document_fts MATCH ?1) AND (?2 IS NULL OR EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag_name = ?2)){heading_match}
            ) ORDER BY source, score, 1 LIMIT ?3 OFFSET ?4"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let mut values: Vec<rusqlite::types::Value> = vec![
            expression.into(),
            tag.into(),
            i64::from(limit.min(100)).into(),
            i64::from(offset).into(),
            include_support.into(),
        ];
        values.extend(words.into_iter().map(rusqlite::types::Value::from));
        Ok(statement
            .query_map(rusqlite::params_from_iter(values), |row| {
                summary_from_row(row, Some(query)).map(Into::into)
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn keep_document(&mut self, id: &str) -> Result<Document, Error> {
        let doc = self.show_document(id)?;
        if doc.trashed {
            return Err(Error::DocumentTrashed(id.to_owned()));
        }
        self.connection
            .execute("UPDATE documents SET kept = 1 WHERE id = ?1", [id])?;
        self.show_document(id)
    }

    pub fn set_document_pin(&mut self, id: &str, pinned: bool) -> Result<(), Error> {
        self.show_document(id)?;
        if pinned {
            self.connection.execute(
                "INSERT OR IGNORE INTO document_pins(document_id) VALUES (?1)",
                [id],
            )?;
        } else {
            self.connection
                .execute("DELETE FROM document_pins WHERE document_id = ?1", [id])?;
        }
        Ok(())
    }

    pub fn set_document_tag(&mut self, id: &str, tag: &str, present: bool) -> Result<(), Error> {
        // Adding follows the tag rules; removing accepts any stored tag.
        let tag = if present {
            crate::tags::normalize_new(tag)?
        } else {
            let tag = tag.trim().to_lowercase();
            if tag.is_empty() {
                return Err(Error::EmptyTag);
            }
            tag
        };
        self.show_document(id)?;
        crate::write_scope::run(&self.connection, |tx| {
            if present {
                tx.execute("INSERT OR IGNORE INTO tags(name) VALUES (?1)", [&tag])?;
                tx.execute(
                    "INSERT OR IGNORE INTO document_tags(document_id, tag_name) VALUES (?1, ?2)",
                    params![id, tag],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM document_tags WHERE document_id = ?1 AND tag_name = ?2",
                    params![id, tag],
                )?;
            }
            Ok(())
        })
    }

    pub fn document_tags(&self, id: &str) -> Result<Vec<String>, Error> {
        self.read(|_| {
            self.show_document(id)?;
            let mut statement = self.connection.prepare(
                "SELECT tag_name FROM document_tags WHERE document_id = ?1 ORDER BY tag_name",
            )?;
            Ok(statement
                .query_map([id], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
        })
    }

    pub fn change_document(&mut self, id: &str, patch: DocumentPatch) -> Result<Document, Error> {
        if self.show_document(id)?.trashed {
            return Err(Error::DocumentTrashed(id.to_owned()));
        }
        self.in_write_scope(|workspace| {
            if let Some(expected) = &patch.expected_updated_at
                && *expected != workspace.show_document(id)?.updated_at
            {
                return Err(Error::DocumentChanged(id.to_owned()));
            }
            let body_to_index = patch.body.clone();
            let summary_changes = match &patch.summary {
                Some(summary) => workspace.connection.execute(
                    "UPDATE documents SET summary = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND trashed = 0 AND summary IS NOT ?2",
                    params![id, summary.as_deref().and_then(one_line_summary)],
                )?,
                None => 0,
            };
            let changes = summary_changes + match (patch.title, patch.body) {
            (Some(title), Some(body)) => workspace.connection.execute("UPDATE documents SET title = ?2, body = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND trashed = 0", params![id, title, body])?,
            (Some(title), None) => workspace.connection.execute("UPDATE documents SET title = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND trashed = 0", params![id, title])?,
            (None, Some(body)) => workspace.connection.execute("UPDATE documents SET body = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND trashed = 0", params![id, body])?,
            (None, None) => 0,
        };
            let document = workspace.show_document(id)?;
            if changes == 0 && document.trashed {
                return Err(Error::DocumentTrashed(id.to_owned()));
            }
            if let Some(body) = body_to_index {
                crate::document_links::index_body(&workspace.connection, id, &body)?;
            }
            workspace.show_document(id)
        })
    }
    pub fn trashed_documents(&self) -> Result<Vec<DocumentSummary>, Error> {
        self.trashed_documents_page(50, 0)
    }

    pub fn trashed_documents_page(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<DocumentSummary>, Error> {
        let columns = summary_columns();
        let sql = format!(
            "SELECT {columns} FROM documents d WHERE d.trashed = 1 ORDER BY d.updated_at DESC, d.id LIMIT ?1 OFFSET ?2"
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params![limit.min(100), offset], |row| {
                summary_from_row(row, None)
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn set_document_trashed(&mut self, id: &str, trashed: bool) -> Result<Document, Error> {
        self.show_document(id)?;
        self.connection.execute(
            "UPDATE documents SET trashed = ?2 WHERE id = ?1",
            params![id, trashed],
        )?;
        self.show_document(id)
    }
}
