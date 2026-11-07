use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{DriveError, DriveErrorKind, DriveMetadata, valid_file_id, validate_metadata};
use crate::{Attachment, Error, Workspace};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveUploadDestination {
    pub connection_id: String,
    pub folder_id: String,
    pub resource_key: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveFolder {
    pub id: String,
    pub name: String,
    pub can_add_children: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveUploadRequest {
    pub destination: DriveUploadDestination,
    pub filename: String,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveUploadState {
    Pending,
    Uncertain,
    Completed,
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveUploadedFile {
    pub metadata: DriveMetadata,
    pub sha256_checksum: Option<String>,
    pub version: Option<String>,
    pub operation_id: Option<String>,
    pub parent_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveUploadOperation {
    pub request_id: String,
    pub attachment_id: String,
    pub remote_file_id: Option<String>,
    pub request: DriveUploadRequest,
    pub state: DriveUploadState,
    pub provenance: Option<DriveUploadedFile>,
    /// Record cleanup must survive late upload reconciliation and stale journal writes.
    #[serde(default)]
    pub record_removed: bool,
}

/// Blob creation only. No overwrite, conversion, deletion or sharing capability.
pub trait DriveUploadProvider {
    fn folder(&self, id: &str, resource_key: Option<&str>) -> Result<DriveFolder, DriveError>;
    fn reserve_file_id(&self) -> Result<String, DriveError>;
    /// None means no visible completed item, not proof that a remote write failed.
    fn uploaded_file(&self, id: &str) -> Result<Option<DriveUploadedFile>, DriveError>;
    /// Always use the operation's reserved ID. Session URLs remain transient.
    fn upload_blob(
        &self,
        operation: &DriveUploadOperation,
        input: &mut dyn Read,
        progress: &mut dyn FnMut(u64, u64) -> bool,
    ) -> Result<(), DriveError>;
}

pub(crate) fn migrate_uploads(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS drive_upload_operations (request_id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL UNIQUE, operation TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS drive_upload_request_namespace BEFORE INSERT ON drive_upload_operations WHEN EXISTS(SELECT 1 FROM request_outcomes WHERE id=new.request_id) BEGIN SELECT RAISE(ABORT, 'request ID already used; choose a new upload operation'); END;
        CREATE TRIGGER IF NOT EXISTS write_drive_request_namespace BEFORE INSERT ON request_outcomes WHEN EXISTS(SELECT 1 FROM drive_upload_operations WHERE request_id=new.id) BEGIN SELECT RAISE(ABORT, 'request ID already used by a Drive upload'); END;")?;
    crate::change_token::migrate(tx)?;
    tx.pragma_update(None, "user_version", 52)?;
    Ok(())
}
pub(crate) fn upload_request_claimed(connection: &Connection, id: &str) -> Result<bool, Error> {
    // Attachment recovery also runs while opening pre-52 workspaces.
    if !crate::backup::table_exists(connection, "drive_upload_operations")? {
        return Ok(false);
    }
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM drive_upload_operations WHERE request_id=?1)",
        [id],
        |r| r.get(0),
    )?)
}

impl Workspace {
    fn drive_upload_lock(&self, request_id: &str) -> Result<File, Error> {
        let locks = self.attachment_directory()?.join(".drive-upload-locks");
        std::fs::create_dir_all(&locks)?;
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(locks.join(format!("{:x}.lock", Sha256::digest(request_id.as_bytes()))))?;
        fs2::FileExt::lock_exclusive(&lock)?;
        Ok(lock)
    }
    /// Reconcile only: never sends input bytes or issues another create.
    pub fn check_drive_upload(
        &mut self,
        request_id: &str,
        provider: &dyn DriveUploadProvider,
    ) -> Result<DriveUploadOperation, Error> {
        let _lock = self.drive_upload_lock(request_id)?;
        let operation = self.drive_upload(request_id)?;
        if operation.state != DriveUploadState::Completed
            && let Some(id) = &operation.remote_file_id
            && let Some(file) = provider.uploaded_file(id)?
        {
            self.complete_drive_upload(operation, file)?;
        }
        self.drive_upload(request_id)
    }
    pub fn validate_drive_upload_destination(
        &self,
        destination: &DriveUploadDestination,
        provider: &dyn DriveUploadProvider,
    ) -> Result<DriveFolder, Error> {
        if Uuid::parse_str(&destination.connection_id).is_err()
            || !valid_file_id(&destination.folder_id)
            || destination
                .resource_key
                .as_deref()
                .is_some_and(|k| !valid_file_id(k))
        {
            return Err(Error::Attachment(
                "select a valid Drive account and upload folder".into(),
            ));
        }
        let folder =
            provider.folder(&destination.folder_id, destination.resource_key.as_deref())?;
        if folder.id != destination.folder_id
            || folder.name.trim().is_empty()
            || !folder.can_add_children
        {
            return Err(Error::Attachment(
                "choose a writable Drive folder; this folder cannot receive files".into(),
            ));
        }
        Ok(folder)
    }
    pub fn drive_upload(&self, request_id: &str) -> Result<DriveUploadOperation, Error> {
        self.find_drive_upload(request_id)?
            .ok_or_else(|| Error::Attachment("Drive upload operation not found".into()))
    }
    fn find_drive_upload(&self, request_id: &str) -> Result<Option<DriveUploadOperation>, Error> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT operation FROM drive_upload_operations WHERE request_id=?1",
                [request_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(value.map(|v| serde_json::from_str(&v)).transpose()?)
    }
    pub fn drive_uploads(&self) -> Result<Vec<DriveUploadOperation>, Error> {
        let mut stmt = self
            .connection
            .prepare("SELECT operation FROM drive_upload_operations ORDER BY rowid")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .map(|v| Ok(serde_json::from_str(&v?)?))
            .collect()
    }
    pub fn drive_uploaded_copy(
        &self,
        attachment_id: &str,
    ) -> Result<Option<DriveUploadOperation>, Error> {
        let id: Option<String> = self
            .connection
            .query_row(
                "SELECT request_id FROM drive_upload_operations WHERE attachment_id=?1",
                [attachment_id],
                |r| r.get(0),
            )
            .optional()?;
        id.map(|id| self.drive_upload(&id)).transpose()
    }
    pub fn drive_upload_open_url(&self, request_id: &str) -> Result<String, Error> {
        let operation = self.drive_upload(request_id)?;
        let id = operation
            .remote_file_id
            .filter(|id| valid_file_id(id))
            .ok_or_else(|| {
                Error::Attachment(
                    "No remote file ID has been allocated yet; retry this upload".into(),
                )
            })?;
        Ok(format!("https://drive.google.com/file/d/{id}/view"))
    }
    fn save_drive_upload(&self, operation: &DriveUploadOperation) -> Result<(), Error> {
        self.connection.execute(
            "UPDATE drive_upload_operations SET operation=CASE WHEN json_extract(operation,'$.record_removed')=1 THEN json_set(?1,'$.record_removed',json('true')) ELSE ?1 END WHERE request_id=?2",
            params![serde_json::to_string(operation)?, operation.request_id],
        )?;
        Ok(())
    }
    pub fn upload_drive_file(
        &mut self,
        request_id: &str,
        source: impl AsRef<Path>,
        destination: &DriveUploadDestination,
        provider: &dyn DriveUploadProvider,
        progress: impl FnMut(u64, u64) -> bool,
    ) -> Result<Attachment, Error> {
        let source = source.as_ref();
        let filename = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Error::Attachment("file must have a Unicode filename".into()))?;
        self.run_drive_upload(
            request_id,
            filename,
            destination,
            provider,
            || {
                let file = File::open(source)?;
                if !file.metadata()?.is_file() {
                    return Err(Error::Attachment("choose a regular file".into()));
                }
                Ok(Box::new(file) as Box<dyn Read>)
            },
            progress,
        )
    }
    pub fn upload_drive_bytes(
        &mut self,
        request_id: &str,
        filename: &str,
        bytes: &[u8],
        destination: &DriveUploadDestination,
        provider: &dyn DriveUploadProvider,
        progress: impl FnMut(u64, u64) -> bool,
    ) -> Result<Attachment, Error> {
        if let Some(previous) = self.find_drive_upload(request_id)?
            && (previous.request.size_bytes != bytes.len() as u64
                || previous.request.sha256 != format!("{:x}", Sha256::digest(bytes)))
        {
            return Err(Error::RequestConflict(request_id.into()));
        }
        self.run_drive_upload(
            request_id,
            filename,
            destination,
            provider,
            || Ok(Box::new(std::io::Cursor::new(bytes)) as Box<dyn Read>),
            progress,
        )
    }
    fn run_drive_upload<'a>(
        &mut self,
        request_id: &str,
        filename: &str,
        destination: &DriveUploadDestination,
        provider: &dyn DriveUploadProvider,
        input: impl FnOnce() -> Result<Box<dyn Read + 'a>, Error>,
        mut progress: impl FnMut(u64, u64) -> bool,
    ) -> Result<Attachment, Error> {
        if request_id.trim().is_empty()
            || request_id.len() > 128
            || filename.trim().is_empty()
            || filename.contains(['/', '\\', ':', '\0'])
            || matches!(filename, "." | "..")
        {
            return Err(Error::Attachment(
                "supply a valid upload request ID and filename".into(),
            ));
        }
        // Cross-process ownership has no lease expiry during a slow network request.
        // Process exit releases this lock; all DB transactions remain short.
        let _lock = self.drive_upload_lock(request_id)?;
        let previous = self.find_drive_upload(request_id)?;
        if let Some(operation) = &previous {
            if operation.request.destination != *destination
                || operation.request.filename != filename
            {
                return Err(Error::RequestConflict(request_id.into()));
            }
            if operation.record_removed {
                return self.attachment(&operation.attachment_id);
            }
            if operation.state == DriveUploadState::Completed {
                return self.attachment(&operation.attachment_id);
            }
            if let Some(file_id) = &operation.remote_file_id
                && let Some(file) = provider.uploaded_file(file_id)?
            {
                return self.complete_drive_upload(operation.clone(), file);
            }
        }
        self.validate_drive_upload_destination(destination, provider)?;
        let mut source = input()?;
        // Freeze exactly the hashed bytes in an anonymous OS temporary file, never
        // a retained workspace cache. A changed original cannot alter this upload.
        let mut frozen = tempfile::tempfile()?;
        let limit = self.attachment_upload_limit()?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let count = source.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > limit {
                return Err(Error::Attachment(format!(
                    "file exceeds the workspace upload limit of {limit} bytes; change it in Settings > Attachments"
                )));
            }
            if !progress(0, total) {
                return Err(cancelled().into());
            }
            hash.update(&chunk[..count]);
            frozen.write_all(&chunk[..count])?;
        }
        frozen.seek(SeekFrom::Start(0))?;
        let request = DriveUploadRequest {
            destination: destination.clone(),
            filename: filename.into(),
            size_bytes: total,
            sha256: format!("{:x}", hash.finalize()),
        };
        let mut operation = if let Some(operation) = previous {
            if operation.request != request {
                return Err(Error::RequestConflict(request_id.into()));
            }
            operation
        } else {
            let operation = DriveUploadOperation {
                request_id: request_id.into(),
                attachment_id: Uuid::new_v4().to_string(),
                remote_file_id: None,
                request,
                state: DriveUploadState::Pending,
                provenance: None,
                record_removed: false,
            };
            self.connection.execute(
                "INSERT INTO drive_upload_operations(request_id,attachment_id,operation) VALUES (?1,?2,?3)",
                params![
                    operation.request_id,
                    operation.attachment_id,
                    serde_json::to_string(&operation)?
                ],
            )?;
            operation
        };
        if operation.remote_file_id.is_none() {
            let id = provider.reserve_file_id()?;
            if !valid_file_id(&id) {
                return Err(super::invalid_response().into());
            }
            operation.remote_file_id = Some(id);
            self.save_drive_upload(&operation)?;
        }
        if !progress(0, total) {
            operation.state = DriveUploadState::Cancelled;
            self.save_drive_upload(&operation)?;
            return Err(cancelled().into());
        }
        // Persist uncertainty before the first create, so crash recovery never
        // mistakes a pending remote effect for a fresh upload.
        operation.state = DriveUploadState::Uncertain;
        self.save_drive_upload(&operation)?;
        let result = provider.upload_blob(&operation, &mut frozen, &mut progress);
        // Even cancellation or a lost response can follow successful completion.
        let resolved = provider.uploaded_file(
            operation
                .remote_file_id
                .as_deref()
                .ok_or_else(super::invalid_response)?,
        );
        match resolved {
            Ok(Some(file)) => self.complete_drive_upload(operation, file),
            _ => {
                if result
                    .as_ref()
                    .is_err_and(|e| e.kind == DriveErrorKind::Cancelled)
                {
                    operation.state = DriveUploadState::Cancelled;
                    self.save_drive_upload(&operation)?;
                }
                result?;
                Err(DriveError::new(DriveErrorKind::Uncertain,"Upload completion is uncertain. Check status before retrying the same operation; any completed file remains in Drive.").into())
            }
        }
    }
    fn complete_drive_upload(
        &mut self,
        mut operation: DriveUploadOperation,
        file: DriveUploadedFile,
    ) -> Result<Attachment, Error> {
        let id = operation
            .remote_file_id
            .as_deref()
            .ok_or_else(super::invalid_response)?;
        validate_metadata(id, &file.metadata)?;
        if file.metadata.size_bytes != Some(operation.request.size_bytes)
            || file.sha256_checksum.as_deref() != Some(&operation.request.sha256)
            || file.operation_id.as_deref() != Some(&operation.attachment_id)
            || !file
                .parent_ids
                .contains(&operation.request.destination.folder_id)
        {
            return Err(DriveError::new(DriveErrorKind::Uncertain,"Drive item could not be verified against this upload. Open in Drive; retry must keep the original operation and file ID.").into());
        }
        operation.state = DriveUploadState::Completed;
        operation.provenance = Some(file.clone());
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current: String = tx.query_row(
            "SELECT operation FROM drive_upload_operations WHERE request_id=?1",
            [&operation.request_id],
            |row| row.get(0),
        )?;
        operation.record_removed =
            serde_json::from_str::<DriveUploadOperation>(&current)?.record_removed;
        if !operation.record_removed {
            tx.execute(
            "INSERT INTO attachments(id,display_name,original_filename,size_bytes,kind,locator,added_at) VALUES (?1,?2,?2,?3,'external_reference',?4,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING",
            params![
                operation.attachment_id,
                operation.request.filename,
                operation.request.size_bytes,
                format!("drive:{}:{id}", operation.request.destination.connection_id)
            ],
        )?;
            tx.execute(
            "INSERT INTO drive_references(attachment_id,connection_id,file_id,metadata) VALUES (?1,?2,?3,?4) ON CONFLICT(attachment_id) DO UPDATE SET metadata=excluded.metadata",
            params![
                operation.attachment_id,
                operation.request.destination.connection_id,
                id,
                serde_json::to_string(&file.metadata)?
            ],
        )?;
        }
        tx.execute(
            "UPDATE drive_upload_operations SET operation=?1 WHERE request_id=?2",
            params![serde_json::to_string(&operation)?, operation.request_id],
        )?;
        tx.commit()?;
        self.attachment(&operation.attachment_id)
    }
}
fn cancelled() -> DriveError {
    DriveError::new(
        DriveErrorKind::Cancelled,
        "Upload canceled. Any completed remote file remains in Drive; check the same operation before retrying.",
    )
}
