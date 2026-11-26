//! Single-file attachment backup container, independent of the workspace schema.
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use rusqlite::{Connection, MAIN_DB, blob::ZeroBlob, params};
use sha2::{Digest, Sha256};

use crate::{Error, backup::table_exists};

/// Attachment files are inside the backup, as blobs: a backup saved anywhere restores anywhere.
const CONTAINER_VERSION: i64 = 1;
/// Attachment files are in a `files` folder beside the backup, one file per distinct content
/// and shared by every restore point there. Only restore points use it: see `restore_points`.
const SHARED_CONTAINER_VERSION: i64 = 2;
/// Where restore points keep attachment files, named by their SHA-256.
pub(crate) const SHARED_FILES_FOLDER: &str = "files";

pub(crate) fn attachment_root(database: &Path) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(".attachments");
    PathBuf::from(path)
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn checked_path(path: &str) -> Result<PathBuf, Error> {
    // Use a portable spelling: Windows separators, drive prefixes and ADS must
    // not become paths when a backup is moved between operating systems.
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(path).is_absolute()
    {
        return Err(Error::Backup(format!(
            "unsafe attachment backup path: {path}"
        )));
    }
    Ok(PathBuf::from(path))
}

/// All retained files, including unreferenced snapshots and future quarantine.
/// In-progress staging and the coordination lock are not retained content.
fn retained_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), Error> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if directory == root
            && (name == ".uploads.lock" || name.to_string_lossy().starts_with(".upload-"))
        {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
            return Err(Error::Backup(format!(
                "attachment storage contains a non-regular entry: {}",
                entry.path().display()
            )));
        }
        if kind.is_dir() {
            retained_files(root, &entry.path(), files)?;
        } else {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| Error::Backup(e.to_string()))?
                .to_str()
                .ok_or_else(|| Error::Backup("attachment paths must be Unicode".into()))?
                .replace('\\', "/");
            checked_path(&relative)?;
            files.push((relative, entry.path()));
        }
    }
    Ok(())
}

pub(crate) fn digest(reader: &mut impl Read) -> Result<String, Error> {
    transfer(reader, &mut std::io::sink()).map(|(_, hash)| hash)
}

fn transfer(reader: &mut impl Read, writer: &mut impl Write) -> Result<(u64, String), Error> {
    let mut hash = Sha256::new();
    let mut total = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        hash.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, format!("{:x}", hash.finalize())))
}

/// Capture paths while the database writer barrier holds, without retaining file handles.
pub(crate) fn retained_file_inventory(root: &Path) -> Result<Vec<(String, PathBuf)>, Error> {
    if root.exists() && root.symlink_metadata()?.file_type().is_symlink() {
        return Err(Error::Backup("managed attachment storage must not be a symbolic link; preserve its files and restore a complete backup".into()));
    }
    let mut files = Vec::new();
    retained_files(root, root, &mut files)?;
    Ok(files)
}

/// The retained file to read for `source`. Cleanup holds the upload lock, but canonical Undo may
/// restore a file after inventory capture. It can only move quarantine -> bytes here.
fn open_retained(source: &Path, relative: &str) -> Result<PathBuf, Error> {
    match fs::metadata(source) {
        Ok(_) => Ok(source.to_path_buf()),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && relative.contains("/quarantine/") =>
        {
            let parent = source
                .parent()
                .and_then(Path::parent)
                .ok_or_else(|| Error::Backup("invalid retained byte path".into()))?;
            Ok(parent.join("bytes").join(
                source
                    .file_name()
                    .ok_or_else(|| Error::Backup("invalid retained filename".into()))?,
            ))
        }
        Err(error) => Err(error.into()),
    }
}

/// The caller holds the upload lock; ordinary writes can resume while bytes stream.
pub(crate) fn pack(connection: &Connection, files: Vec<(String, PathBuf)>) -> Result<(), Error> {
    let has_attachments = table_exists(connection, "attachments")?
        && connection.query_row("SELECT EXISTS(SELECT 1 FROM attachments)", [], |r| {
            r.get::<_, bool>(0)
        })?;
    if files.is_empty() && !has_attachments {
        return Ok(());
    }
    let tx = connection.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE ticketd_backup_container(version INTEGER NOT NULL, inventory_sha256 TEXT NOT NULL);
         INSERT INTO ticketd_backup_container VALUES (1, '');
         CREATE TABLE ticketd_backup_files(path TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL);"
    )?;
    for (relative, source) in files {
        let path = open_retained(&source, &relative)?;
        let mut input = File::open(&path)?;
        let size = input.metadata()?.len();
        let blob_size = i32::try_from(size)
            .ok()
            .filter(|_| size <= crate::attachments::MAX_BACKUP_FILE_BYTES)
            .ok_or_else(|| too_large(&tx, &relative, size))?;
        // The checksum is known before the row is written. Updating a row afterwards would
        // rewrite its whole blob and leave the old pages free, doubling the backup's size.
        let (hashed, hash) = transfer(&mut input, &mut std::io::sink())?;
        if hashed != size {
            return Err(Error::Backup(format!(
                "attachment changed during backup: {relative}"
            )));
        }
        tx.execute("INSERT INTO ticketd_backup_files(path, size_bytes, sha256, data) VALUES (?1, ?2, ?3, ?4)", params![relative, size, hash, ZeroBlob(blob_size)])?;
        let id = tx.last_insert_rowid();
        let mut blob = tx.blob_open(MAIN_DB, "ticketd_backup_files", "data", id, false)?;
        input.seek(SeekFrom::Start(0))?;
        let (copied, copied_hash) = transfer(&mut input, &mut blob)?;
        drop(blob);
        if copied != size || copied_hash != hash {
            return Err(Error::Backup(format!(
                "attachment changed during backup: {relative}"
            )));
        }
    }
    let inventory = inventory_digest(&tx)?;
    tx.execute(
        "UPDATE ticketd_backup_container SET inventory_sha256=?1",
        [inventory],
    )?;
    tx.commit()?;
    validate(connection)
}

/// [`pack`] for a restore point: the files go into `store`, one file per distinct content, and
/// the point records only their names. The caller holds the upload lock. A file already in the
/// store is not copied again, which is what makes seven points cost about one copy.
pub(crate) fn pack_external(
    connection: &Connection,
    files: Vec<(String, PathBuf)>,
    store: &Path,
) -> Result<(), Error> {
    let has_attachments = table_exists(connection, "attachments")?
        && connection.query_row("SELECT EXISTS(SELECT 1 FROM attachments)", [], |r| {
            r.get::<_, bool>(0)
        })?;
    if files.is_empty() && !has_attachments {
        return Ok(());
    }
    fs::create_dir_all(store)?;
    let tx = connection.unchecked_transaction()?;
    tx.execute_batch(&format!(
        "CREATE TABLE ticketd_backup_container(version INTEGER NOT NULL, inventory_sha256 TEXT NOT NULL);
         INSERT INTO ticketd_backup_container VALUES ({SHARED_CONTAINER_VERSION}, '');
         CREATE TABLE ticketd_backup_files(path TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL);"
    ))?;
    for (relative, source) in files {
        let path = open_retained(&source, &relative)?;
        let mut input = File::open(&path)?;
        let size = input.metadata()?.len();
        let (hashed, hash) = transfer(&mut input, &mut std::io::sink())?;
        if hashed != size {
            return Err(Error::Backup(format!(
                "attachment changed during backup: {relative}"
            )));
        }
        let shared = store.join(&hash);
        if fs::metadata(&shared).is_ok_and(|kept| kept.len() == size) {
            // The same bytes are already kept for an earlier point.
        } else {
            input.seek(SeekFrom::Start(0))?;
            let mut staged = tempfile::NamedTempFile::new_in(store)?;
            let (copied, copied_hash) = transfer(&mut input, &mut staged)?;
            if copied != size || copied_hash != hash {
                return Err(Error::Backup(format!(
                    "attachment changed during backup: {relative}"
                )));
            }
            staged.as_file().sync_all()?;
            staged
                .persist(&shared)
                .map_err(|error| Error::Directory(error.error))?;
        }
        tx.execute(
            "INSERT INTO ticketd_backup_files(path, size_bytes, sha256, data) VALUES (?1, ?2, ?3, x'')",
            params![relative, size, hash],
        )?;
    }
    let inventory = inventory_digest(&tx)?;
    tx.execute(
        "UPDATE ticketd_backup_container SET inventory_sha256=?1",
        [inventory],
    )?;
    tx.commit()?;
    sync_directory(store)?;
    validate(connection)
}

/// The folder a restore point keeps its attachment files in: `files`, beside the point.
fn shared_files(connection: &Connection) -> Result<PathBuf, Error> {
    connection
        .path()
        .map(Path::new)
        .and_then(Path::parent)
        .map(|folder| folder.join(SHARED_FILES_FOLDER))
        .ok_or_else(|| Error::Backup("a restore point must be a file".into()))
}

/// A retained file too big for a backup. Name the Attachment and say what to do: the backup
/// would otherwise fail on every attempt, and nothing else can fix it.
fn too_large(connection: &Connection, relative: &str, size: u64) -> Error {
    let limit = crate::attachments::MAX_BACKUP_FILE_BYTES;
    let id = relative.split('/').next().unwrap_or_default();
    let named: Option<String> = connection
        .query_row(
            "SELECT display_name FROM attachments WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .ok();
    let which = match &named {
        Some(name) => format!("the attachment '{name}' ({id})"),
        None => format!("the retained file {relative}"),
    };
    Error::Backup(format!(
        "{which} is {size} bytes, more than the {limit} bytes a backup can hold, so no backup can be made until it is removed from storage. Save a copy elsewhere with `ticketd attachment export {id} <new-path>`, then remove it with `ticketd attachment quarantine {id}` and `ticketd attachment purge --confirm {id}` (it must not be in use)"
    ))
}

pub(crate) fn container_version(connection: &Connection) -> Result<Option<i64>, Error> {
    if !table_exists(connection, "ticketd_backup_container")? {
        return Ok(None);
    }
    let count: u64 =
        connection.query_row("SELECT COUNT(*) FROM ticketd_backup_container", [], |r| {
            r.get(0)
        })?;
    if count != 1 {
        return Err(Error::Backup(
            "invalid attachment backup container header".into(),
        ));
    }
    let version =
        connection.query_row("SELECT version FROM ticketd_backup_container", [], |r| {
            r.get(0)
        })?;
    if version != CONTAINER_VERSION && version != SHARED_CONTAINER_VERSION {
        return Err(Error::Backup(format!(
            "unsupported attachment backup container version {version}; update ticketd"
        )));
    }
    Ok(Some(version))
}

pub(crate) fn validate(connection: &Connection) -> Result<(), Error> {
    let version = container_version(connection)?;
    let packaged = version.is_some();
    // A restore point's bytes are in files, which `visit_files` has just read to the end.
    let held = if version == Some(SHARED_CONTAINER_VERSION) {
        ""
    } else {
        " AND length(data)=?2"
    };
    if packaged {
        let expected: String = connection.query_row(
            "SELECT inventory_sha256 FROM ticketd_backup_container",
            [],
            |r| r.get(0),
        )?;
        if inventory_digest(connection)? != expected {
            return Err(Error::Backup("retained attachment file inventory is incomplete or damaged; choose a complete backup. Nothing was restored".into()));
        }
        visit_files(connection, None)?;
    } else if table_exists(connection, "ticketd_backup_files")? {
        return Err(Error::Backup(
            "attachment backup container header is missing".into(),
        ));
    }
    if table_exists(connection, "attachments")? {
        let has_purge =
            connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? >= 54;
        if has_purge
            && connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM attachments WHERE purge_state='pending')",
                [],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Err(Error::Backup("Permanent attachment purge is pending. Retry the explicit purge before creating a complete backup; no deletion was retried automatically.".into()));
        }
        // An Attachment synced from another device and not downloaded yet has no
        // bytes here to keep; the restored Workspace downloads them as before.
        let downloaded = if table_exists(connection, "sync_attachments")? {
            " AND id NOT IN (SELECT id FROM sync_attachments WHERE state != 'downloaded')"
        } else {
            ""
        };
        let retained = if has_purge {
            " AND purge_state='retained'"
        } else {
            ""
        };
        let mut query = connection.prepare(&format!(
            "SELECT display_name, locator, size_bytes FROM attachments WHERE kind='local_snapshot'{retained}{downloaded}"
        ))?;
        let mut rows = query.query([])?;
        let mut missing = Vec::new();
        while let Some(row) = rows.next()? {
            let name: String = row.get(0)?;
            let locator: String = row.get(1)?;
            let size: u64 = row.get(2)?;
            checked_path(&locator)?;
            let present = packaged && connection.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM ticketd_backup_files WHERE (path=?1 OR path=?3) AND size_bytes=?2{held})"),
                params![locator, size, crate::attachment_cleanup::quarantine_locator(&locator)], |r| r.get::<_, bool>(0)
            )?;
            if !present {
                missing.push(name);
            }
        }
        if !missing.is_empty() {
            return Err(Error::Backup(format!(
                "missing attachment bytes: {}; choose a complete backup. Nothing was restored",
                missing.join(", ")
            )));
        }
    }
    Ok(())
}

fn inventory_digest(connection: &Connection) -> Result<String, Error> {
    let mut hash = Sha256::new();
    let mut query = connection
        .prepare("SELECT path, size_bytes, sha256 FROM ticketd_backup_files ORDER BY path")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let path: String = row.get(0)?;
        let size: u64 = row.get(1)?;
        let digest: String = row.get(2)?;
        hash.update(serde_json::to_vec(&(path, size, digest))?);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn visit_files(connection: &Connection, destination: Option<&Path>) -> Result<(), Error> {
    let shared = if container_version(connection)? == Some(SHARED_CONTAINER_VERSION) {
        Some(shared_files(connection)?)
    } else {
        None
    };
    let mut query = connection.prepare(
        "SELECT rowid, path, size_bytes, sha256 FROM ticketd_backup_files ORDER BY path",
    )?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let path: String = row.get(1)?;
        let size: u64 = row.get(2)?;
        let expected: String = row.get(3)?;
        let relative = checked_path(&path)?;
        let damaged = || {
            Error::Backup(format!(
                "missing or damaged attachment bytes: {path}; choose a complete backup"
            ))
        };
        // A point's file is named by its checksum, so a name that is not one is not read.
        let mut source: Box<dyn Read> = if let Some(store) = &shared {
            if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(damaged());
            }
            Box::new(File::open(store.join(&expected)).map_err(|_| damaged())?)
        } else {
            Box::new(connection.blob_open(MAIN_DB, "ticketd_backup_files", "data", id, true)?)
        };
        let (actual_size, hash) = if let Some(root) = destination {
            let target = root.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = File::options().write(true).create_new(true).open(&target)?;
            let result = transfer(&mut source, &mut output)?;
            output.sync_all()?;
            result
        } else {
            transfer(&mut source, &mut std::io::sink())?
        };
        if size != actual_size || hash != expected {
            return Err(Error::Backup(format!(
                "missing or damaged attachment bytes: {path}; choose a complete backup"
            )));
        }
    }
    Ok(())
}

pub(crate) fn extract(connection: &Connection, destination: &Path) -> Result<(), Error> {
    if container_version(connection)?.is_some() {
        visit_files(connection, Some(destination))?;
    }
    sync_directory(destination)
}

pub(crate) fn unpack_database(connection: &Connection) -> Result<(), Error> {
    let packaged = container_version(connection)?.is_some();
    connection.execute_batch(
        "DROP TABLE IF EXISTS ticketd_backup_files; DROP TABLE IF EXISTS ticketd_backup_container;",
    )?;
    if packaged {
        // DROP leaves blob pages in the freelist. Only the external attachment
        // root should retain those bytes in the restored live workspace.
        connection.execute_batch("VACUUM")?;
    }
    Ok(())
}

pub(crate) fn content(connection: &Connection) -> Result<crate::AttachmentBackupContent, Error> {
    let container_version = container_version(connection)?.and_then(|v| u32::try_from(v).ok());
    let (local_snapshots, remote_references) = if table_exists(connection, "attachments")? {
        let has_purge =
            connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? >= 54;
        connection.query_row(if has_purge {
            "SELECT COUNT(CASE WHEN kind='local_snapshot' AND purge_state='retained' THEN 1 END), COUNT(CASE WHEN kind!='local_snapshot' THEN 1 END) FROM attachments"
        } else {
            "SELECT COUNT(CASE WHEN kind='local_snapshot' THEN 1 END), COUNT(CASE WHEN kind!='local_snapshot' THEN 1 END) FROM attachments"
        }, [], |r| Ok((r.get(0)?, r.get(1)?)))?
    } else {
        (0, 0)
    };
    let (retained_files, retained_bytes) = if container_version.is_some() {
        connection.query_row("SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM ticketd_backup_files WHERE path NOT LIKE '%/.ticketd-upload.json'", [], |r| Ok((r.get(0)?, r.get(1)?)))?
    } else {
        (0, 0)
    };
    Ok(crate::AttachmentBackupContent {
        container_version,
        local_snapshots,
        retained_files,
        retained_bytes,
        remote_references,
        remote_bytes_included: false,
        remote_access_verified: false,
    })
}
