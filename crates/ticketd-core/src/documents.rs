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

    pub fn recent_documents(&self) -> Result<Vec<Document>, Error> {
        let mut statement = self.connection.prepare("SELECT d.id, d.title, d.body, d.created_at, d.updated_at, d.trashed FROM document_opens o JOIN documents d ON d.id = o.document_id WHERE d.trashed = 0 ORDER BY o.sequence DESC")?;
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
