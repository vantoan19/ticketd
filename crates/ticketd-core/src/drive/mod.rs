//! Google Drive references, blob uploads and Workspace sync storage. Only sync rewrites
//! files, and only ones it created; nothing here deletes or changes sharing.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Attachment, Error, Workspace};
mod client;
mod provider;
pub use provider::*;
mod oauth;
pub use oauth::*;
mod uploads;
pub use uploads::*;
pub(crate) mod copies;
mod upload_provider;
pub use copies::*;
mod copy_provider;
pub use copy_provider::GoogleDriveCopies;
mod remote;
pub use remote::DriveRemote;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveErrorKind {
    Unconfigured,
    Reauthorize,
    SelectFile,
    PermissionDenied,
    Missing,
    InaccessibleOrMissing,
    Offline,
    RateLimited,
    Unsupported,
    InvalidResponse,
    Cancelled,
    Uncertain,
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

/// An explicit observation, not a cached assertion about the current account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveAccess {
    pub reference: DriveReference,
    pub failure: Option<DriveError>,
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
    /// Inspect current access without discarding last-known details on provider failure.
    pub fn check_drive_reference(
        &mut self,
        id: &str,
        provider: &dyn AttachmentProvider,
    ) -> Result<DriveAccess, Error> {
        let reference = self.drive_reference(id)?;
        match self.resolve_drive_reference(id, provider) {
            Ok(reference) => Ok(DriveAccess {
                reference,
                failure: None,
            }),
            Err(Error::Drive(failure)) => Ok(DriveAccess {
                reference,
                failure: Some(failure),
            }),
            Err(error) => Err(error),
        }
    }

    /// Recovery must never substitute another file or account for existing uses.
    pub fn recover_drive_reference(
        &mut self,
        id: &str,
        selection: &DriveSelection,
        provider: &dyn AttachmentProvider,
    ) -> Result<DriveReference, Error> {
        let reference = self.drive_reference(id)?;
        validate_recovery_selection(&reference, selection)?;
        self.resolve_drive_reference(id, provider)
    }

    pub fn begin_drive_reference_recovery(
        &self,
        id: &str,
        client: DesktopOAuthClient,
        timeout: std::time::Duration,
    ) -> Result<PickerSession, Error> {
        Ok(PickerSession::begin_recovery(
            client,
            timeout,
            self.drive_reference(id)?,
        )?)
    }

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
        let uploading:Option<String>=tx.query_row("SELECT attachment_id FROM drive_upload_operations WHERE json_extract(operation,'$.remote_file_id')=?1 AND json_extract(operation,'$.request.destination.connection_id')=?2",params![file_id,connection_id],|r|r.get(0)).optional()?;
        let id = previous
            .or(uploading)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute("INSERT OR IGNORE INTO attachments(id, display_name, original_filename, size_bytes, kind, locator, added_at) VALUES (?1, ?2, ?2, ?3, 'external_reference', ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))", params![id, metadata.name, metadata.size_bytes, format!("drive:{connection_id}:{file_id}")])?;
        tx.execute("INSERT INTO drive_references(attachment_id, connection_id, file_id, metadata) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(attachment_id) DO UPDATE SET metadata=excluded.metadata", params![id, connection_id, file_id, serde_json::to_string(&metadata)?])?;
        tx.execute(
            "UPDATE attachments SET size_bytes=?1 WHERE id=?2",
            params![metadata.size_bytes, id],
        )?;
        // Only deliberate file selection re-registers a previously removed uploaded copy.
        tx.execute("UPDATE drive_upload_operations SET operation=json_set(operation,'$.record_removed',json('false')) WHERE attachment_id=?1", [&id])?;
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
        let metadata = provider.metadata(
            &reference.metadata.id,
            reference.metadata.resource_key.as_deref(),
        )?;
        validate_metadata(&reference.metadata.id, &metadata)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // Refresh is not selection: a concurrent removal must not register a new record.
        crate::attachments::read_attachment(&tx, id)?;
        tx.execute(
            "UPDATE drive_references SET metadata=?1 WHERE attachment_id=?2",
            params![serde_json::to_string(&metadata)?, id],
        )?;
        tx.execute(
            "UPDATE attachments SET size_bytes=?1 WHERE id=?2",
            params![metadata.size_bytes, id],
        )?;
        tx.commit()?;
        self.drive_reference(id)
    }
}

pub(super) fn validate_recovery_selection(
    reference: &DriveReference,
    selection: &DriveSelection,
) -> Result<(), DriveError> {
    if selection.connection_id != reference.connection_id {
        return Err(DriveError::new(
            DriveErrorKind::Reauthorize,
            "Reconnect with the original Google account and ticketd OAuth client; the existing reference was not changed",
        ));
    }
    if selection.file_ids.as_slice() != [reference.metadata.id.as_str()] {
        return Err(DriveError::new(
            DriveErrorKind::SelectFile,
            "Select only the original file in the Drive Picker; choosing a replacement is a separate action and the existing reference was not changed",
        ));
    }
    Ok(())
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
        && !url
            .query_pairs()
            .chain(url::form_urlencoded::parse(
                url.fragment().unwrap_or_default().as_bytes(),
            ))
            .any(|(key, _)| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "access_token"
                        | "refresh_token"
                        | "id_token"
                        | "token"
                        | "code"
                        | "client_secret"
                        | "code_verifier"
                        | "code_challenge"
                        | "state"
                        | "authorization"
                )
            })
}
