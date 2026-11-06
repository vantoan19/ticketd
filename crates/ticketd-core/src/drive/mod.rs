//! Existing-file references. This capability deliberately has no remote mutation operations.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Attachment, Error, Workspace};
mod provider;
pub use provider::*;
mod oauth;
pub use oauth::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveErrorKind {
    Unconfigured,
    Reauthorize,
    SelectFile,
    InaccessibleOrMissing,
    Offline,
    RateLimited,
    Unsupported,
    InvalidResponse,
    Cancelled,
}

#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize)]
#[error("{message}")]
pub struct DriveError {
    pub kind: DriveErrorKind,
    pub message: String,
}

impl DriveError {
    pub fn new(kind: DriveErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveMetadata {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: Option<u64>,
    pub web_url: String,
    pub resource_key: Option<String>,
}

/// Independent of ticket-source connectors; resolution never downloads or converts content.
pub trait AttachmentProvider {
    fn metadata(
        &self,
        file_id: &str,
        resource_key: Option<&str>,
    ) -> Result<DriveMetadata, DriveError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveReference {
    pub connection_id: String,
    pub metadata: DriveMetadata,
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    // SQLite's documented table-rebuild procedure, with foreign keys disabled by
    // the migration owner and checked before commit. Existing child rows stay intact.
    tx.execute_batch("CREATE TABLE attachments_v51 (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, original_filename TEXT NOT NULL, size_bytes INTEGER CHECK(size_bytes >= 0), kind TEXT NOT NULL CHECK(kind IN ('local_snapshot', 'external_reference')), locator TEXT NOT NULL UNIQUE, CHECK(kind != 'local_snapshot' OR size_bytes IS NOT NULL));
        INSERT INTO attachments_v51 SELECT id, display_name, original_filename, size_bytes, kind, locator FROM attachments;
        DROP TABLE attachments;
        ALTER TABLE attachments_v51 RENAME TO attachments;
        CREATE TABLE IF NOT EXISTS drive_references (attachment_id TEXT PRIMARY KEY REFERENCES attachments(id), connection_id TEXT NOT NULL, file_id TEXT NOT NULL, metadata TEXT NOT NULL, UNIQUE(connection_id, file_id));")?;
    crate::change_token::migrate(tx)?;
    tx.pragma_update(None, "user_version", 51)?;
    Ok(())
}

impl Workspace {
    /// Network resolution precedes the short atomic write. Repeated/concurrent
    /// selection of the same connection/file preserves the workspace identity.
    pub fn reference_drive_file(
        &mut self,
        connection_id: &str,
        file_id: &str,
        resource_key: Option<&str>,
        provider: &dyn AttachmentProvider,
    ) -> Result<Attachment, Error> {
        if Uuid::parse_str(connection_id).is_err() {
            return Err(Error::Attachment(
                "invalid Drive connection handle; select the file in Google Drive again".into(),
            ));
        }
        let metadata = provider.metadata(file_id, resource_key)?;
        validate_metadata(file_id, &metadata)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT attachment_id FROM drive_references WHERE connection_id=?1 AND file_id=?2",
                params![connection_id, file_id],
                |r| r.get(0),
            )
            .optional()?;
        let id = previous.unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute("INSERT OR IGNORE INTO attachments(id, display_name, original_filename, size_bytes, kind, locator) VALUES (?1, ?2, ?2, ?3, 'external_reference', ?4)", params![id, metadata.name, metadata.size_bytes, format!("drive:{connection_id}:{file_id}")])?;
        tx.execute("INSERT INTO drive_references(attachment_id, connection_id, file_id, metadata) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(attachment_id) DO UPDATE SET metadata=excluded.metadata", params![id, connection_id, file_id, serde_json::to_string(&metadata)?])?;
        tx.execute(
            "UPDATE attachments SET size_bytes=?1 WHERE id=?2",
            params![metadata.size_bytes, id],
        )?;
        tx.commit()?;
        self.attachment(&id)
    }

    pub fn drive_reference(&self, id: &str) -> Result<DriveReference, Error> {
        let (connection_id, metadata): (String, String) = self
            .connection
            .query_row(
                "SELECT connection_id, metadata FROM drive_references WHERE attachment_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                Error::Attachment("this attachment is not an external Drive reference".into())
            })?;
        Ok(DriveReference {
            connection_id,
            metadata: serde_json::from_str(&metadata)?,
        })
    }

    /// Refresh current source metadata. Failures leave last-known metadata intact.
    pub fn resolve_drive_reference(
        &mut self,
        id: &str,
        provider: &dyn AttachmentProvider,
    ) -> Result<DriveReference, Error> {
        let reference = self.drive_reference(id)?;
        self.reference_drive_file(
            &reference.connection_id,
            &reference.metadata.id,
            reference.metadata.resource_key.as_deref(),
            provider,
        )?;
        self.drive_reference(id)
    }
}

pub(crate) fn validate_metadata(file_id: &str, metadata: &DriveMetadata) -> Result<(), DriveError> {
    if !valid_file_id(file_id)
        || metadata.id != file_id
        || metadata.name.trim().is_empty()
        || !safe_web_url(&metadata.web_url)
        || metadata
            .size_bytes
            .is_some_and(|size| size > i64::MAX as u64)
    {
        return Err(DriveError::new(
            DriveErrorKind::InvalidResponse,
            "Drive returned invalid file metadata; select the file again",
        ));
    }
    if matches!(
        metadata.mime_type.as_str(),
        "application/vnd.google-apps.folder" | "application/vnd.google-apps.shortcut"
    ) {
        return Err(DriveError::new(
            DriveErrorKind::Unsupported,
            "choose a file rather than a folder or shortcut",
        ));
    }
    Ok(())
}

pub(crate) fn valid_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

pub fn safe_web_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && matches!(url.host_str(), Some("drive.google.com" | "docs.google.com"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}
