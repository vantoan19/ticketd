use std::collections::BTreeSet;

use pulldown_cmark::{Event, Options, Parser, Tag};
use rusqlite::{Connection, params};
use uuid::Uuid;

use crate::{Attachment, Error, Workspace};

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachment_workspace (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE);
         CREATE TABLE IF NOT EXISTS embedded_attachments (source_id TEXT NOT NULL, uri TEXT NOT NULL, attachment_id TEXT REFERENCES attachments(id), PRIMARY KEY(source_id, uri));
         CREATE INDEX IF NOT EXISTS embedded_attachments_by_attachment ON embedded_attachments(attachment_id, source_id);
         CREATE TRIGGER IF NOT EXISTS embedded_activity_delete AFTER DELETE ON activities BEGIN DELETE FROM embedded_attachments WHERE source_id=OLD.id; END;",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO attachment_workspace VALUES (1, ?1)",
        [Uuid::new_v4().to_string()],
    )?;
    tx.pragma_update(None, "user_version", 48)?;
    let mut statement = tx.prepare("SELECT id, body FROM tickets UNION ALL SELECT id, body FROM documents UNION ALL SELECT id, brief FROM activities")?;
    let content = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, body) in content {
        index(tx, &id, &body)?;
    }
    Ok(())
}

fn workspace_id(tx: &Connection) -> Result<String, Error> {
    Ok(tx.query_row(
        "SELECT id FROM attachment_workspace WHERE singleton=1",
        [],
        |r| r.get(0),
    )?)
}

/// All Markdown destinations, including image and reference-style syntax, but never code.
fn destinations(markdown: &str) -> BTreeSet<String> {
    Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    )
    .filter_map(|event| match event {
        Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. })
            if dest_url.starts_with("ticketd://attachment/") =>
        {
            Some(dest_url.to_string())
        }
        _ => None,
    })
    .collect()
}

/// Called inside the same transaction as every canonical body/brief write.
pub(crate) fn index(tx: &Connection, source_id: &str, markdown: &str) -> Result<(), Error> {
    // Earlier migrations rebuild mention indexes before attachment tables exist.
    if tx.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? < 48 {
        return Ok(());
    }
    let prefix = format!("ticketd://attachment/{}/", workspace_id(tx)?);
    let mut previous = tx.prepare("SELECT uri FROM embedded_attachments WHERE source_id=?1")?;
    let previous = previous
        .query_map([source_id], |r| r.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    let next = destinations(markdown);
    for uri in &next {
        let id = uri.strip_prefix(&prefix);
        if let Some(id) = id.filter(|_| !previous.contains(uri)) {
            let file = crate::attachments::read_attachment(tx, id)?;
            crate::attachments::validate_attachment_bytes(tx, &file)?;
        }
    }
    tx.execute(
        "DELETE FROM embedded_attachments WHERE source_id=?1",
        [source_id],
    )?;
    for uri in next {
        let id = uri.strip_prefix(&prefix);
        tx.execute(
            "INSERT INTO embedded_attachments(source_id, uri, attachment_id) VALUES (?1, ?2, ?3)",
            params![source_id, uri, id],
        )?;
    }
    Ok(())
}

impl Workspace {
    /// Namespaces local capture recovery without exposing the database path.
    pub fn attachment_workspace_id(&self) -> Result<String, Error> {
        workspace_id(&self.connection)
    }

    /// A stable identity that never embeds a filesystem path or provider URL.
    pub fn attachment_uri(&self, id: &str) -> Result<String, Error> {
        let file = self.attachment(id)?;
        crate::attachments::validate_attachment_bytes(&self.connection, &file)?;
        Ok(format!(
            "ticketd://attachment/{}/{id}",
            workspace_id(&self.connection)?
        ))
    }

    /// Foreign workspace URIs never resolve against this workspace's file IDs.
    pub fn resolve_attachment_uri(&self, uri: &str) -> Result<Attachment, Error> {
        let prefix = format!("ticketd://attachment/{}/", workspace_id(&self.connection)?);
        let id = uri.strip_prefix(&prefix).ok_or_else(|| {
            Error::Attachment(
                "this link belongs to another workspace; open it in its owning workspace".into(),
            )
        })?;
        self.attachment(id)
    }

    /// Derived inline uses only; excludes direct associations and linked Documents.
    pub fn embedded_attachments(&self, source_id: &str) -> Result<Vec<Attachment>, Error> {
        let mut statement = self.connection.prepare("SELECT attachment_id FROM embedded_attachments WHERE source_id=?1 AND attachment_id IS NOT NULL ORDER BY attachment_id")?;
        let ids = statement
            .query_map([source_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| crate::attachments::read_attachment(&self.connection, id))
            .collect()
    }

    /// Preserve unresolved foreign links for inspection without pretending they resolve.
    pub fn embedded_attachment_uris(&self, source_id: &str) -> Result<Vec<String>, Error> {
        let mut statement = self
            .connection
            .prepare("SELECT uri FROM embedded_attachments WHERE source_id=?1 ORDER BY uri")?;
        Ok(statement
            .query_map([source_id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }
}
