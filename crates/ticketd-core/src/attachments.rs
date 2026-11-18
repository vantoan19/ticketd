use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Error, Ticket, Workspace, WriteRequest, WriteResult, relationships};

pub const DEFAULT_ATTACHMENT_LIMIT: u64 = 100 * 1024 * 1024;

pub(crate) fn migrate_upload_settings(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachment_upload_settings (id INTEGER PRIMARY KEY CHECK(id = 1), limit_bytes INTEGER NOT NULL CHECK(limit_bytes > 0));
         INSERT OR IGNORE INTO attachment_upload_settings VALUES (1, 104857600);",
    )?;
    crate::change_token::migrate(connection)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    LocalSnapshot,
    ExternalReference,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentPurgeState {
    #[default]
    Retained,
    Pending,
    Purged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentOpenTarget {
    LocalPath(PathBuf),
    ExternalUrl(String),
}

/// A reusable file identity, separate from Documents and Implementation evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub display_name: String,
    pub original_filename: String,
    /// Always known for local snapshots; providers may omit a native file's size.
    pub size_bytes: Option<u64>,
    pub kind: AttachmentKind,
    /// Upload provenance is independent of the provider's current content or availability.
    #[serde(default)]
    pub uploaded_copy: bool,
    /// A local relative path or opaque provider locator; never a credential.
    pub locator: String,
    #[serde(default)]
    pub quarantined: bool,
    #[serde(default)]
    pub purge_state: AttachmentPurgeState,
    /// First registration, unknown for legacy records without timestamp evidence.
    #[serde(default)]
    pub added_at: Option<String>,
}

// Kept with the synced bytes so a failed database commit never loses upload identity.
#[derive(Serialize, Deserialize)]
struct CompletedUpload {
    request_id: String,
    request: String,
    attachment: Attachment,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, original_filename TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), kind TEXT NOT NULL CHECK(kind = 'local_snapshot'), locator TEXT NOT NULL UNIQUE);
         CREATE TABLE IF NOT EXISTS ticket_attachments (ticket_id TEXT NOT NULL REFERENCES tickets(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(ticket_id, attachment_id));
         CREATE INDEX IF NOT EXISTS ticket_attachments_by_attachment ON ticket_attachments(attachment_id, ticket_id);",
    )?;
    crate::change_token::migrate(connection)?;
    Ok(())
}

impl Workspace {
    pub fn attachment_upload_limit(&self) -> Result<u64, Error> {
        Ok(self.connection.query_row(
            "SELECT limit_bytes FROM attachment_upload_settings WHERE id=1",
            [],
            |row| row.get(0),
        )?)
    }

    /// Applies to future copies, not completed outcomes replayed by request ID.
    pub fn set_attachment_upload_limit(&self, bytes: u64) -> Result<(), Error> {
        if bytes == 0 || bytes >= i64::MAX as u64 {
            return Err(Error::Attachment(
                "upload limit must be between 1 and 9223372036854775806 bytes".into(),
            ));
        }
        self.connection.execute(
            "UPDATE attachment_upload_settings SET limit_bytes=?1 WHERE id=1",
            [bytes],
        )?;
        Ok(())
    }

    pub(crate) fn attachment_directory(&self) -> Result<PathBuf, Error> {
        attachment_directory(&self.connection)
    }

    /// Store an immutable snapshot. Retry the same request ID and arguments after
    /// any failure or lost response, even if the original file has since moved.
    pub fn import_attachment(
        &mut self,
        request_id: &str,
        source: impl AsRef<Path>,
        display_name: Option<&str>,
    ) -> Result<Attachment, Error> {
        self.import_attachment_with_progress(request_id, source, display_name, |_, _| true)
    }

    /// Reports actual copied bytes. Returning false cancels before publication;
    /// a completed snapshot is always retained and safely replayable.
    pub fn import_attachment_with_progress(
        &mut self,
        request_id: &str,
        source: impl AsRef<Path>,
        display_name: Option<&str>,
        progress: impl FnMut(u64, u64) -> bool,
    ) -> Result<Attachment, Error> {
        let source = source.as_ref();
        let source_text = source
            .to_str()
            .ok_or_else(|| Error::Attachment("file path must be valid Unicode".into()))?;
        let request = serde_json::to_string(&WriteRequest::ImportAttachment {
            source: source_text.into(),
            display_name: display_name.map(str::to_owned),
        })?;
        let filename = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Error::Attachment("file must have a Unicode filename".into()))?;
        self.import_snapshot(
            request_id,
            &request,
            filename,
            display_name,
            || {
                let input = File::open(source).map_err(|e| crate::path_error("file", source, e))?;
                let metadata = input.metadata()?;
                if !metadata.is_file() {
                    return Err(Error::Attachment("choose a regular file".into()));
                }
                Ok((input, metadata.len()))
            },
            progress,
        )
    }

    /// Capture clipboard/drop bytes through the same bounded, recoverable snapshot workflow.
    /// The content digest is part of request equality; raw bytes are not stored in outcomes.
    pub fn import_attachment_bytes(
        &mut self,
        request_id: &str,
        filename: &str,
        bytes: &[u8],
        progress: impl FnMut(u64, u64) -> bool,
    ) -> Result<Attachment, Error> {
        let request = serde_json::to_string(&serde_json::json!({
            "operation": "capture_attachment", "filename": filename,
            "sha256": format!("{:x}", Sha256::digest(bytes)),
        }))?;
        self.import_snapshot(
            request_id,
            &request,
            filename,
            None,
            || Ok((std::io::Cursor::new(bytes), bytes.len() as u64)),
            progress,
        )
    }

    #[allow(clippy::too_many_arguments)] // Both adapters share one publication and recovery boundary.
    fn import_snapshot<R: Read>(
        &mut self,
        request_id: &str,
        request: &str,
        filename: &str,
        display_name: Option<&str>,
        input: impl FnOnce() -> Result<(R, u64), Error>,
        mut progress: impl FnMut(u64, u64) -> bool,
    ) -> Result<Attachment, Error> {
        if request_id.trim().is_empty() {
            return Err(Error::Attachment(
                "supply a nonempty upload request ID for safe retry".into(),
            ));
        }
        if !valid_filename(filename) {
            return Err(Error::Attachment(
                "supply a filename without directories or drive/stream syntax".into(),
            ));
        }
        self.begin_attachment_upload(request_id, Some(crate::AttachmentUploadDestination::Local))?;
        let root = self.attachment_directory()?;
        fs::create_dir_all(&root)?;
        let _upload_lock = lock_uploads(&root)?;
        self.recover_uploads_locked(&root)?;
        if crate::drive::upload_request_claimed(&self.connection, request_id)? {
            return Err(Error::RequestConflict(request_id.into()));
        }
        let previous: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT request, outcome FROM request_outcomes WHERE id=?1",
                [request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((previous, outcome)) = previous {
            if previous != request {
                return Err(Error::RequestConflict(request_id.into()));
            }
            return match serde_json::from_str(&outcome)? {
                WriteResult::Attachment(file) => replay_attachment(&self.connection, file),
                _ => Err(Error::RequestConflict(request_id.into())),
            };
        }
        let (mut input, total) = input()?;
        let limit = self.attachment_upload_limit()?;
        if total > limit {
            return Err(upload_limit_error(limit));
        }
        let original_filename = filename.to_owned();
        let display_name = display_name.unwrap_or(&original_filename);
        if display_name.trim().is_empty() {
            return Err(Error::Attachment("display name must not be empty".into()));
        }
        let id = Uuid::new_v4().to_string();
        let staged = tempfile::Builder::new()
            .prefix(".upload-")
            .tempdir_in(&root)?;
        fs::create_dir(staged.path().join("bytes"))?;
        let mut output = File::create(staged.path().join("bytes").join(&original_filename))?;
        let size_bytes = copy_upload(&mut input, &mut output, limit, total, &mut progress)?;
        output.sync_all()?;
        drop(output);
        let attachment = Attachment {
            locator: format!("{id}/bytes/{original_filename}"),
            id: id.clone(),
            display_name: display_name.into(),
            original_filename,
            size_bytes: Some(size_bytes),
            kind: AttachmentKind::LocalSnapshot,
            uploaded_copy: false,
            quarantined: false,
            purge_state: AttachmentPurgeState::Retained,
            added_at: Some(self.connection.query_row(
                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                [],
                |row| row.get(0),
            )?),
        };
        let completed = CompletedUpload {
            request_id: request_id.into(),
            request: request.into(),
            attachment: attachment.clone(),
        };
        let mut manifest = File::create(staged.path().join(".ticketd-upload.json"))?;
        manifest.write_all(&serde_json::to_vec(&completed)?)?;
        manifest.sync_all()?;
        drop(manifest);
        sync_directory(&staged.path().join("bytes"))?;
        sync_directory(staged.path())?;
        fs::rename(staged.path(), root.join(&id))?;
        sync_directory(&root)?;
        // From here on, failure leaves a completed snapshot and recovery manifest.
        self.record_completed_upload(&completed)?;
        Ok(attachment)
    }

    fn record_completed_upload(&self, completed: &CompletedUpload) -> Result<(), Error> {
        let tx = self.connection.unchecked_transaction()?;
        crate::write_scope::lock(&tx)?;
        let stored: Option<String> = tx
            .query_row(
                "SELECT request FROM request_outcomes WHERE id=?1",
                [&completed.request_id],
                |r| r.get(0),
            )
            .optional()?;
        let file = &completed.attachment;
        tx.execute("INSERT OR IGNORE INTO attachments(id, display_name, original_filename, size_bytes, kind, locator, added_at) VALUES (?1, ?2, ?3, ?4, 'local_snapshot', ?5, ?6)",
            params![file.id, file.display_name, file.original_filename, file.size_bytes, file.locator, file.added_at])?;
        if crate::drive::upload_request_claimed(&tx, &completed.request_id)? {
            // A concurrent Drive allocation may have claimed this ID while the
            // local copy ran. Preserve its bytes without poisoning later recovery.
            tx.commit()?;
            return Err(Error::RequestConflict(completed.request_id.clone()));
        }
        if let Some(stored) = stored {
            if stored != completed.request {
                // A competing ordinary write may have claimed the ID during the
                // file copy. Preserve the completed file without replacing its outcome.
                tx.commit()?;
                return Err(Error::RequestConflict(completed.request_id.clone()));
            }
        } else {
            tx.execute(
                "INSERT INTO request_outcomes(id, request, outcome) VALUES (?1, ?2, ?3)",
                params![
                    completed.request_id,
                    completed.request,
                    serde_json::to_string(&WriteResult::Attachment(completed.attachment.clone()))?
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn recover_uploads_locked(&self, root: &Path) -> Result<(), Error> {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            // Incomplete staging directories have no published identity.
            if Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() {
                continue;
            }
            let recorded: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1)",
                [entry.file_name().to_string_lossy().as_ref()],
                |r| r.get(0),
            )?;
            if recorded {
                continue;
            }
            let manifest = entry.path().join(".ticketd-upload.json");
            let completed: CompletedUpload = serde_json::from_slice(&fs::read(manifest)?)?;
            if completed.attachment.id != entry.file_name().to_string_lossy() {
                return Err(Error::Attachment("upload recovery identity does not match its directory; preserve the snapshot and repair its recovery record".into()));
            }
            match self.record_completed_upload(&completed) {
                Ok(()) | Err(Error::RequestConflict(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub(crate) fn recover_uploads(&self) -> Result<(), Error> {
        let root = self.attachment_directory()?;
        if !root.exists() {
            return Ok(());
        }
        let _lock = lock_uploads(&root)?;
        self.recover_uploads_locked(&root)
    }

    pub(crate) fn attachment_backup_lock(&self) -> Result<File, Error> {
        let root = self.attachment_directory()?;
        fs::create_dir_all(&root)?;
        let lock = lock_uploads(&root)?;
        self.recover_uploads_locked(&root)?;
        Ok(lock)
    }

    pub fn attachment(&self, id: &str) -> Result<Attachment, Error> {
        self.recover_uploads()?;
        read_attachment(&self.connection, id)
    }

    /// Includes completed uploads whose insertion was abandoned; never deletes bytes.
    pub fn attachments(&self, limit: u32, offset: u32) -> Result<Vec<Attachment>, Error> {
        self.recover_uploads()?;
        let mut stmt = self.connection.prepare("SELECT id, display_name, original_filename, size_bytes, locator, kind, quarantined, added_at, purge_state, EXISTS(SELECT 1 FROM drive_upload_operations u WHERE u.attachment_id=attachments.id) FROM attachments ORDER BY rowid DESC LIMIT ?1 OFFSET ?2")?;
        Ok(stmt
            .query_map(params![limit.min(1000), offset], attachment_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Direct associations only; files in linked Documents are not flattened here.
    pub fn ticket_attachments(&self, reference: &str) -> Result<Vec<Attachment>, Error> {
        self.recover_uploads()?;
        let ticket_id = relationships::id(&self.connection, reference)?;
        let mut stmt = self.connection.prepare("SELECT a.id, a.display_name, a.original_filename, a.size_bytes, a.locator, a.kind, a.quarantined, a.added_at, a.purge_state, EXISTS(SELECT 1 FROM drive_upload_operations u WHERE u.attachment_id=a.id) FROM attachments a JOIN ticket_attachments t ON t.attachment_id=a.id WHERE t.ticket_id=?1 ORDER BY a.rowid")?;
        Ok(stmt
            .query_map([ticket_id], attachment_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn set_ticket_attachment(
        &mut self,
        reference: &str,
        id: &str,
        present: bool,
    ) -> Result<Ticket, Error> {
        // Recover before the savepoint; the retryable write adapter recovers before BEGIN.
        crate::write_scope::run(&self.connection, |tx| {
            let attachment = read_attachment(tx, id)?;
            // Check the ticket first: a refused write must not move quarantined bytes,
            // because the savepoint cannot roll back a filesystem move.
            let ticket_id = tx.editable(reference)?;
            if present {
                crate::attachment_cleanup::restore_reference(tx, id)?;
                validate_attachment_reference(tx, &attachment)?;
                tx.execute("INSERT OR IGNORE INTO ticket_attachments(ticket_id, attachment_id) VALUES (?1, ?2)", params![ticket_id, id])?;
            } else {
                tx.execute(
                    "DELETE FROM ticket_attachments WHERE ticket_id=?1 AND attachment_id=?2",
                    params![ticket_id, id],
                )?;
            }
            crate::read_ticket(tx, reference)
        })
    }

    fn validate_attachment_bytes(&self, attachment: &Attachment) -> Result<PathBuf, Error> {
        validate_attachment_bytes(&self.connection, attachment)
    }

    /// Replace just one direct association, retaining both immutable snapshots and all other uses.
    pub(crate) fn replace_ticket_attachment(
        &mut self,
        reference: &str,
        previous_id: &str,
        replacement_id: &str,
    ) -> Result<Ticket, Error> {
        if previous_id == replacement_id {
            return Err(Error::Attachment("choose a new attachment identity".into()));
        }
        crate::write_scope::run(&self.connection, |tx| {
            let replacement = read_attachment(tx, replacement_id)?;
            // Refuse before restoring: the savepoint cannot roll back a filesystem move.
            let ticket_id = tx.editable(reference)?;
            let selected: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ticket_attachments WHERE ticket_id=?1 AND attachment_id=?2)", params![ticket_id, previous_id], |row| row.get(0))?;
            if !selected {
                return Err(Error::Attachment(
                    "this association changed; select the reference again before replacing it"
                        .into(),
                ));
            }
            crate::attachment_cleanup::restore_reference(tx, replacement_id)?;
            validate_attachment_reference(tx, &replacement)?;
            tx.execute(
            "INSERT OR IGNORE INTO ticket_attachments(ticket_id, attachment_id) VALUES (?1, ?2)",
            params![ticket_id, replacement_id],
        )?;
            tx.execute(
                "DELETE FROM ticket_attachments WHERE ticket_id=?1 AND attachment_id=?2",
                params![ticket_id, previous_id],
            )?;
            crate::read_ticket(tx, reference)
        })
    }

    /// Explicit native-open support. Adapters must never open a file automatically.
    pub fn attachment_open_target(&self, id: &str) -> Result<AttachmentOpenTarget, Error> {
        let file = self.attachment(id)?;
        match file.kind {
            AttachmentKind::LocalSnapshot => Ok(AttachmentOpenTarget::LocalPath(
                self.attachment_open_path(id)?,
            )),
            AttachmentKind::ExternalReference => {
                let reference = self.drive_reference(id)?;
                if !crate::drive::safe_web_url(&reference.metadata.web_url) {
                    return Err(Error::Attachment(
                        "invalid Drive viewer URL; select the file again".into(),
                    ));
                }
                Ok(AttachmentOpenTarget::ExternalUrl(
                    reference.metadata.web_url,
                ))
            }
        }
    }

    /// Local-only compatibility seam; external content uses attachment_open_target.
    pub fn attachment_open_path(&self, id: &str) -> Result<PathBuf, Error> {
        let attachment = self.attachment(id)?;
        let extension = Path::new(&attachment.original_filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        // Never launch executables/scripts or active HTML. Other formats can be exported.
        if !matches!(
            extension.as_str(),
            "txt"
                | "log"
                | "md"
                | "csv"
                | "json"
                | "pdf"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "bmp"
                | "mp3"
                | "wav"
                | "ogg"
                | "mp4"
                | "webm"
                | "mov"
        ) {
            return Err(Error::Attachment("native open is unavailable for this file type; export it and choose an application explicitly".into()));
        }
        self.validate_attachment_bytes(&attachment)
    }

    /// Export stored bytes without overwriting an existing destination or leaving partial output.
    pub fn export_attachment(&self, id: &str, destination: impl AsRef<Path>) -> Result<(), Error> {
        let attachment = self.attachment(id)?;
        if attachment.kind == AttachmentKind::ExternalReference
            && self.drive_uploaded_copy(id)?.is_some()
        {
            let transport = crate::drive::GoogleTransport::default();
            let provider = crate::drive::GoogleDriveCopies::new(
                &crate::drive::PlatformCredentialStore,
                &transport,
            );
            let result = self.export_drive_uploaded_copy(id, destination, &provider)?;
            return if result.status == crate::drive::DriveCopyStatus::Unchanged {
                Ok(())
            } else {
                Err(Error::Attachment(format!(
                    "Uploaded-copy bytes were not verified: {}",
                    result.message
                )))
            };
        }
        let (_, mut source) =
            crate::attachment_previews::open_snapshot(&self.connection, &attachment)
                .map_err(|error| Error::Attachment(error.message))?;
        let destination = destination.as_ref();
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut output = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| crate::path_error("destination folder", parent, e))?;
        let copied = std::io::copy(&mut source, &mut output)?;
        if Some(copied) != attachment.size_bytes {
            return Err(Error::Attachment(
                "stored bytes changed while exporting; retry after restoring the snapshot".into(),
            ));
        }
        output.as_file().sync_all()?;
        output
            .persist_noclobber(destination)
            .map_err(|e| match e.error.kind() {
                std::io::ErrorKind::AlreadyExists => Error::FileExists(destination.into()),
                _ => Error::from(e.error),
            })?;
        sync_directory(parent)?;
        Ok(())
    }
}

/// A file name that stays inside its Attachment's own directory.
pub(crate) fn valid_filename(name: &str) -> bool {
    !matches!(name, "" | "." | "..") && !name.contains(['/', '\\', ':', '\0'])
}

fn upload_limit_error(limit: u64) -> Error {
    Error::UploadLimit { limit }
}

fn copy_upload(
    input: &mut impl Read,
    output: &mut impl Write,
    limit: u64,
    total: u64,
    progress: &mut impl FnMut(u64, u64) -> bool,
) -> Result<u64, Error> {
    let mut copied = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        if !progress(copied, total) {
            return Err(Error::Attachment(
                "upload canceled before completion; retry the same operation to resume safely"
                    .into(),
            ));
        }
        let count = input.take(limit - copied + 1).read(&mut buffer)?;
        if count == 0 {
            return Ok(copied);
        }
        copied += count as u64;
        if copied > limit {
            return Err(upload_limit_error(limit));
        }
        output.write_all(&buffer[..count])?;
    }
}

pub(crate) fn read_attachment(connection: &Connection, id: &str) -> Result<Attachment, Error> {
    // Earlier migrations rebuild embedded indexes before the new columns exist.
    let version =
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    let columns = match version {
        54.. => "quarantined, added_at, purge_state",
        53 => "quarantined, added_at, 'retained'",
        _ => "0, NULL, 'retained'",
    };
    let uploaded_copy = if version >= 52 {
        "EXISTS(SELECT 1 FROM drive_upload_operations u WHERE u.attachment_id=attachments.id)"
    } else {
        "0"
    };
    if let Some(file) = connection.query_row(&format!("SELECT id, display_name, original_filename, size_bytes, locator, kind, {columns}, {uploaded_copy} FROM attachments WHERE id=?1"), [id], attachment_row).optional()? {
        return Ok(file);
    }
    if version >= 52 {
        let remote_id: Option<String> = connection.query_row("SELECT json_extract(operation,'$.remote_file_id') FROM drive_upload_operations WHERE attachment_id=?1 AND (json_extract(operation,'$.state')='completed' OR json_extract(operation,'$.record_removed')=1)", [id], |row| row.get(0)).optional()?.flatten();
        if let Some(remote_id) = remote_id.filter(|value| crate::drive::valid_file_id(value)) {
            return Err(removed_remote_error(id, &remote_id));
        }
    }
    Err(Error::Attachment(format!(
        "'{id}' was not found; use attachment list to find a workspace attachment ID"
    )))
}

fn removed_remote_error(id: &str, remote_id: &str) -> Error {
    Error::Attachment(format!(
        "'{id}' is no longer registered in ticketd. The file remains in Drive: https://drive.google.com/file/d/{remote_id}/view . Choose it again in the Google Drive picker to re-add it; retrying an old receipt does not restore the record."
    ))
}

/// Preserve original replay metadata, but never imply purged bytes are still available.
pub(crate) fn replay_attachment(
    connection: &Connection,
    mut file: Attachment,
) -> Result<Attachment, Error> {
    let current = read_attachment(connection, &file.id).map_err(|error| {
        if matches!(error, Error::Attachment(_))
            && file.kind == AttachmentKind::ExternalReference
            && let Some(remote_id) = file
                .locator
                .rsplit(':')
                .next()
                .filter(|value| crate::drive::valid_file_id(value))
        {
            return removed_remote_error(&file.id, remote_id);
        }
        error
    })?;
    file.purge_state = current.purge_state;
    file.uploaded_copy = current.uploaded_copy;
    Ok(file)
}

fn attachment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get(0)?,
        display_name: row.get(1)?,
        original_filename: row.get(2)?,
        size_bytes: row.get(3)?,
        locator: row.get(4)?,
        uploaded_copy: row.get(9)?,
        quarantined: row.get(6)?,
        added_at: row.get(7)?,
        purge_state: match row.get::<_, String>(8)?.as_str() {
            "retained" => AttachmentPurgeState::Retained,
            "pending" => AttachmentPurgeState::Pending,
            "purged" => AttachmentPurgeState::Purged,
            value => {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    format!("unknown purge state: {value}").into(),
                ));
            }
        },
        kind: match row.get::<_, String>(5)?.as_str() {
            "local_snapshot" => AttachmentKind::LocalSnapshot,
            "external_reference" => AttachmentKind::ExternalReference,
            value => {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    format!("unknown attachment kind: {value}").into(),
                ));
            }
        },
    })
}

pub(crate) fn lock_uploads(root: &Path) -> Result<File, Error> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".uploads.lock"))?;
    FileExt::lock_exclusive(&lock)?;
    Ok(lock)
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(crate) fn validate_attachment_bytes(
    connection: &Connection,
    attachment: &Attachment,
) -> Result<PathBuf, Error> {
    crate::attachment_previews::open_snapshot(connection, attachment)
        .map(|(path, _)| path)
        .map_err(|error| Error::Attachment(error.message))
}

pub(crate) fn attachment_directory(connection: &Connection) -> Result<PathBuf, Error> {
    let path = connection
        .path()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| Error::Attachment("workspace has no file path".into()))?;
    let mut path = std::ffi::OsString::from(path);
    path.push(".attachments");
    Ok(PathBuf::from(path))
}

pub(crate) fn validate_attachment_reference(
    connection: &Connection,
    attachment: &Attachment,
) -> Result<(), Error> {
    match attachment.kind {
        AttachmentKind::LocalSnapshot => {
            validate_attachment_bytes(connection, attachment)?;
        }
        AttachmentKind::ExternalReference => {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM drive_references WHERE attachment_id=?1)",
                [&attachment.id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::Attachment(
                    "Drive reference metadata is incomplete; select the file again".into(),
                ));
            }
        }
    }
    Ok(())
}
