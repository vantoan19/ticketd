use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Ticket, Workspace, WriteRequest, WriteResult, relationships};

pub const DEFAULT_ATTACHMENT_LIMIT: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    LocalSnapshot,
}

/// A reusable file identity, separate from Documents and Implementation evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub display_name: String,
    pub original_filename: String,
    pub size_bytes: u64,
    pub kind: AttachmentKind,
    /// Relative to this workspace's managed attachment directory.
    pub locator: String,
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
    connection.pragma_update(None, "user_version", 47)?;
    Ok(())
}

impl Workspace {
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
        let source = source.as_ref();
        let source_text = source
            .to_str()
            .ok_or_else(|| Error::Attachment("file path must be valid Unicode".into()))?;
        if request_id.trim().is_empty() {
            return Err(Error::Attachment(
                "supply a nonempty upload request ID for safe retry".into(),
            ));
        }
        let request = serde_json::to_string(&WriteRequest::ImportAttachment {
            source: source_text.into(),
            display_name: display_name.map(str::to_owned),
        })?;
        let root = self.attachment_directory()?;
        fs::create_dir_all(&root)?;
        let _upload_lock = lock_uploads(&root)?;
        self.recover_uploads_locked(&root)?;
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
                WriteResult::Attachment(file) => Ok(file),
                _ => Err(Error::RequestConflict(request_id.into())),
            };
        }
        let mut input = File::open(source)?;
        if !input.metadata()?.is_file() {
            return Err(Error::Attachment("choose a regular file".into()));
        }
        if input.metadata()?.len() > DEFAULT_ATTACHMENT_LIMIT {
            return Err(Error::Attachment(
                "file exceeds the 100 MiB upload limit".into(),
            ));
        }
        let original_filename = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Error::Attachment("file must have a Unicode filename".into()))?
            .to_owned();
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
        let size_bytes = std::io::copy(
            &mut Read::by_ref(&mut input).take(DEFAULT_ATTACHMENT_LIMIT + 1),
            &mut output,
        )?;
        if size_bytes > DEFAULT_ATTACHMENT_LIMIT {
            return Err(Error::Attachment(
                "file exceeds the 100 MiB upload limit".into(),
            ));
        }
        output.sync_all()?;
        drop(output);
        let attachment = Attachment {
            locator: format!("{id}/bytes/{original_filename}"),
            id: id.clone(),
            display_name: display_name.into(),
            original_filename,
            size_bytes,
            kind: AttachmentKind::LocalSnapshot,
        };
        let completed = CompletedUpload {
            request_id: request_id.into(),
            request,
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
        crate::transaction_write_lock(&tx)?;
        let stored: Option<String> = tx
            .query_row(
                "SELECT request FROM request_outcomes WHERE id=?1",
                [&completed.request_id],
                |r| r.get(0),
            )
            .optional()?;
        let file = &completed.attachment;
        tx.execute("INSERT OR IGNORE INTO attachments(id, display_name, original_filename, size_bytes, kind, locator) VALUES (?1, ?2, ?3, ?4, 'local_snapshot', ?5)",
            params![file.id, file.display_name, file.original_filename, file.size_bytes, file.locator])?;
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

    pub(crate) fn database_only_backup_lock(&self) -> Result<File, Error> {
        let root = self.attachment_directory()?;
        fs::create_dir_all(&root)?;
        let lock = lock_uploads(&root)?;
        self.recover_uploads_locked(&root)?;
        reject_database_only_attachments(&self.connection)?;
        Ok(lock)
    }

    pub fn attachment(&self, id: &str) -> Result<Attachment, Error> {
        self.recover_uploads()?;
        read_attachment(&self.connection, id)
    }

    /// Includes completed uploads whose insertion was abandoned; never deletes bytes.
    pub fn attachments(&self, limit: u32, offset: u32) -> Result<Vec<Attachment>, Error> {
        self.recover_uploads()?;
        let mut stmt = self.connection.prepare("SELECT id, display_name, original_filename, size_bytes, locator FROM attachments ORDER BY rowid DESC LIMIT ?1 OFFSET ?2")?;
        Ok(stmt
            .query_map(params![limit.min(1000), offset], attachment_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Direct associations only; files in linked Documents are not flattened here.
    pub fn ticket_attachments(&self, reference: &str) -> Result<Vec<Attachment>, Error> {
        self.recover_uploads()?;
        let ticket_id = relationships::id(&self.connection, reference)?;
        let mut stmt = self.connection.prepare("SELECT a.id, a.display_name, a.original_filename, a.size_bytes, a.locator FROM attachments a JOIN ticket_attachments t ON t.attachment_id=a.id WHERE t.ticket_id=?1 ORDER BY a.rowid")?;
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
        let attachment = read_attachment(&self.connection, id)?;
        if present {
            self.validate_attachment_bytes(&attachment)?;
        }
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let ticket_id = relationships::id(&tx, reference)?;
        let trashed: bool = tx.query_row(
            "SELECT trashed FROM tickets WHERE id=?1",
            [&ticket_id],
            |r| r.get(0),
        )?;
        if trashed {
            return Err(Error::Trashed(reference.into()));
        }
        if present {
            tx.execute("INSERT OR IGNORE INTO ticket_attachments(ticket_id, attachment_id) VALUES (?1, ?2)", params![ticket_id, id])?;
        } else {
            tx.execute(
                "DELETE FROM ticket_attachments WHERE ticket_id=?1 AND attachment_id=?2",
                params![ticket_id, id],
            )?;
        }
        tx.commit()?;
        self.show_ticket(reference)
    }

    fn validate_attachment_bytes(&self, attachment: &Attachment) -> Result<PathBuf, Error> {
        validate_attachment_bytes(&self.connection, attachment)
    }

    /// Explicit native-open support. Adapters must never open a file automatically.
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
        let source = self.validate_attachment_bytes(&attachment)?;
        let destination = destination.as_ref();
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut output = tempfile::NamedTempFile::new_in(parent)?;
        let copied = std::io::copy(&mut File::open(source)?, &mut output)?;
        if copied != attachment.size_bytes {
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

pub(crate) fn read_attachment(connection: &Connection, id: &str) -> Result<Attachment, Error> {
    connection.query_row("SELECT id, display_name, original_filename, size_bytes, locator FROM attachments WHERE id=?1", [id], attachment_row).optional()?
        .ok_or_else(|| Error::Attachment(format!("'{id}' was not found; use attachment list to find a workspace attachment ID")))
}

fn attachment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get(0)?,
        display_name: row.get(1)?,
        original_filename: row.get(2)?,
        size_bytes: row.get(3)?,
        locator: row.get(4)?,
        kind: AttachmentKind::LocalSnapshot,
    })
}

fn lock_uploads(root: &Path) -> Result<File, Error> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".uploads.lock"))?;
    FileExt::lock_exclusive(&lock)?;
    Ok(lock)
}

// Replaced by attachment-aware packaging in the backup slice. Never report a
// database-only copy as complete, including safety copies made during restore.
pub(crate) fn reject_database_only_attachments(connection: &Connection) -> Result<(), Error> {
    let recorded = crate::backup::table_exists(connection, "attachments")?
        && connection.query_row("SELECT EXISTS(SELECT 1 FROM attachments)", [], |r| {
            r.get::<_, bool>(0)
        })?;
    let completed_files = if let Some(path) = connection.path().filter(|p| !p.is_empty()) {
        let mut path = std::ffi::OsString::from(path);
        path.push(".attachments");
        match fs::read_dir(PathBuf::from(path)) {
            Ok(entries) => {
                let mut completed = false;
                for entry in entries {
                    if Uuid::parse_str(&entry?.file_name().to_string_lossy()).is_ok() {
                        completed = true;
                        break;
                    }
                }
                completed
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        }
    } else {
        false
    };
    if recorded || completed_files {
        return Err(Error::Backup("database-only backup/restore cannot preserve retained attachment snapshots; attachment-aware backup support is required. Export individual files for now".into()));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), Error> {
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
    if Uuid::parse_str(&attachment.id).is_err()
        || Path::new(&attachment.original_filename).file_name()
            != Some(std::ffi::OsStr::new(&attachment.original_filename))
        || attachment.locator != format!("{}/bytes/{}", attachment.id, attachment.original_filename)
    {
        return Err(Error::Attachment(
            "invalid managed snapshot locator; preserve the file and repair its metadata".into(),
        ));
    }
    let path = attachment_directory(connection)?.join(&attachment.locator);
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == attachment.size_bytes => Ok(path),
        Ok(_) => Err(Error::Attachment(format!(
            "stored bytes for '{}' are incomplete; restore them from a complete backup or choose a new attachment",
            attachment.display_name
        ))),
        Err(error) => Err(Error::Attachment(format!(
            "cannot read stored bytes for '{}' ({}): {error}; restore the snapshot or choose a new attachment",
            attachment.display_name, attachment.id
        ))),
    }
}

fn attachment_directory(connection: &Connection) -> Result<PathBuf, Error> {
    let path = connection
        .path()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| Error::Attachment("workspace has no file path".into()))?;
    let mut path = std::ffi::OsString::from(path);
    path.push(".attachments");
    Ok(PathBuf::from(path))
}
