use crate::{Error, Workspace};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: Option<String>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub trashed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentSummary {
    pub id: String,
    pub heading: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentSearchResult {
    pub id: String,
    pub heading: String,
    pub snippet: String,
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
}

fn present_title<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

pub(crate) fn migrate(tx: &rusqlite::Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, UNIQUE(id, kind));
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'document' CHECK(kind = 'document'), title TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), FOREIGN KEY(id, kind) REFERENCES entities(id, kind));
        CREATE TABLE IF NOT EXISTS document_opens (sequence INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL UNIQUE REFERENCES documents(id));
        PRAGMA user_version = 31;")?;
    Ok(())
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
        CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags(tag_name, document_id);
        PRAGMA user_version = 36;")?;
    Ok(())
}

// Limit headings in list results even when a document has a very long first line.
const HEADING: &str = "coalesce(nullif(substr(trim(d.title), 1, 200), ''), nullif(trim(substr(ltrim(d.body, char(10)||char(13)||' '), 1, min(200, instr(ltrim(d.body, char(10)||char(13)||' ') || char(10), char(10)) - 1))), ''), 'Untitled')";

impl Workspace {
    pub fn create_document(&mut self, title: Option<&str>, body: &str) -> Result<Document, Error> {
        let id = Uuid::new_v4().to_string();
        self.connection.execute_batch("SAVEPOINT create_document")?;
        let result = (|| {
            self.connection.execute(
                "INSERT INTO entities (id, kind) VALUES (?1, 'document')",
                [&id],
            )?;
            self.connection.execute(
                "INSERT INTO documents (id, title, body) VALUES (?1, ?2, ?3)",
                params![id, title, body],
            )?;
            self.open_document(&id)
        })();
        match result {
            Ok(document) => {
                self.connection.execute_batch("RELEASE create_document")?;
                Ok(document)
            }
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
                "SELECT id, title, body, created_at, updated_at, trashed FROM documents WHERE id = ?1",
                [id],
                |row| {
                    Ok(Document {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        body: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        trashed: row.get(5)?,
                    })
                },
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
        let sql = format!(
            "SELECT d.id, {HEADING} FROM document_opens o JOIN documents d ON d.id = o.document_id WHERE d.trashed = 0 ORDER BY o.sequence DESC LIMIT ?1 OFFSET ?2"
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params![limit.min(100), offset], |row| {
                Ok(DocumentSummary {
                    id: row.get(0)?,
                    heading: row.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn pinned_documents(&self, limit: u32, offset: u32) -> Result<Vec<DocumentSummary>, Error> {
        let sql = format!(
            "SELECT d.id, {HEADING} FROM document_pins p JOIN documents d ON d.id = p.document_id WHERE d.trashed = 0 ORDER BY d.id LIMIT ?1 OFFSET ?2"
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params![limit.min(100), offset], |row| {
                Ok(DocumentSummary {
                    id: row.get(0)?,
                    heading: row.get(1)?,
                })
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
        let query = query.trim();
        if query.is_empty() {
            let Some(tag) = tag else {
                return Ok(Vec::new());
            };
            let sql = format!(
                "SELECT d.id, {HEADING} FROM document_tags t JOIN documents d ON d.id = t.document_id WHERE t.tag_name = ?1 AND d.trashed = 0 ORDER BY d.id LIMIT ?2 OFFSET ?3"
            );
            let mut statement = self.connection.prepare(&sql)?;
            return Ok(statement
                .query_map(
                    params![tag.trim().to_lowercase(), limit.min(100), offset],
                    |row| {
                        Ok(DocumentSearchResult {
                            id: row.get(0)?,
                            heading: row.get(1)?,
                            snippet: String::new(),
                        })
                    },
                )?
                .collect::<Result<_, _>>()?);
        }
        let expression = format!("\"{}\"", query.replace('"', "\"\""));
        let tag = tag.map(|value| value.trim().to_lowercase());
        let sql = format!(
            "SELECT d.id, {HEADING}, substr(snippet(document_fts, -1, '', '', '…', 24), 1, 300) FROM document_fts JOIN documents d ON d.rowid = document_fts.rowid WHERE d.trashed = 0 AND document_fts MATCH ?1 AND (?2 IS NULL OR EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag_name = ?2)) ORDER BY rank, d.id LIMIT ?3 OFFSET ?4"
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params![expression, tag, limit.min(100), offset], |row| {
                Ok(DocumentSearchResult {
                    id: row.get(0)?,
                    heading: row.get(1)?,
                    snippet: row.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?)
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
        let tag = tag.trim().to_lowercase();
        if tag.is_empty() {
            return Err(Error::EmptyTag);
        }
        self.show_document(id)?;
        let tx = self.connection.savepoint()?;
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
        tx.commit()?;
        Ok(())
    }

    pub fn document_tags(&self, id: &str) -> Result<Vec<String>, Error> {
        self.show_document(id)?;
        let mut statement = self.connection.prepare(
            "SELECT tag_name FROM document_tags WHERE document_id = ?1 ORDER BY tag_name",
        )?;
        Ok(statement
            .query_map([id], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn change_document(&mut self, id: &str, patch: DocumentPatch) -> Result<Document, Error> {
        if self.show_document(id)?.trashed {
            return Err(Error::Trashed(id.to_owned()));
        }
        let changes = match (patch.title, patch.body) {
            (Some(title), Some(body)) => self.connection.execute("UPDATE documents SET title = ?2, body = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND trashed = 0", params![id, title, body])?,
            (Some(title), None) => self.connection.execute("UPDATE documents SET title = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND trashed = 0", params![id, title])?,
            (None, Some(body)) => self.connection.execute("UPDATE documents SET body = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND trashed = 0", params![id, body])?,
            (None, None) => 0,
        };
        let document = self.show_document(id)?;
        if changes == 0 && document.trashed {
            return Err(Error::Trashed(id.to_owned()));
        }
        Ok(document)
    }
    pub fn trashed_documents(&self) -> Result<Vec<Document>, Error> {
        let mut statement = self.connection.prepare("SELECT id, title, body, created_at, updated_at, trashed FROM documents WHERE trashed = 1 ORDER BY updated_at DESC, id")?;
        let rows = statement.query_map([], |row| {
            Ok(Document {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                trashed: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
