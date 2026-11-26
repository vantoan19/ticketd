use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{
    Error, Workspace,
    backup_review::{BackupCheck, Ladder, check_backup},
};
use rusqlite::{Connection, backup::Backup};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The most recent backup that was saved and verified, whichever surface made it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupRecord {
    /// Absolute path of the backup file when it was made.
    pub path: String,
    /// UTC time the backup finished, as an RFC 3339 timestamp.
    pub completed_at: String,
}

/// The Workspace file `path` names, with links followed, also before it exists.
pub(crate) fn resolve(path: &Path) -> Result<PathBuf, Error> {
    Ok(match path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            parent
                .canonicalize()
                .map_err(|e| crate::path_error("workspace folder", parent, e))?
                .join(
                    path.file_name()
                        .ok_or_else(|| Error::Backup("invalid workspace path".into()))?,
                )
        }
        Err(error) => return Err(error.into()),
    })
}

/// The lock file beside a Workspace, given its resolved path.
pub(crate) fn lock_path(resolved: &Path) -> PathBuf {
    let mut name = resolved.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

pub(crate) fn lock_file(path: &Path) -> Result<File, Error> {
    let resolved = resolve(path)?;
    let name = lock_path(&resolved);
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(name)?)
}

/// Copies `source` into `destination`, which is left a single file whatever the
/// journal mode of `source`: the copy takes its header, WAL flag included.
pub(crate) fn copy(source: &Connection, destination: &mut Connection) -> Result<(), Error> {
    Backup::new(source, destination)?.run_to_completion(100, Duration::from_millis(25), None)?;
    crate::session::single_file(destination)
}

pub(crate) fn table_exists(connection: &Connection, table: &str) -> Result<bool, Error> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )?)
}

/// The schema objects a Workspace of this format version has but `connection` lacks:
/// tables, `table.column`s, triggers and unique indexes, by name. The Workspace format
/// module builds the version in memory, so no list here can drift from the migrations.
///
/// Context identities, derived indexes and capture triggers are all part of that check:
/// missing triggers silently corrupt subsequent writes after a restore, and without its
/// sync capture triggers a restored Workspace would silently stop uploading edits.
pub(crate) fn missing_objects(connection: &Connection, version: i64) -> Result<Vec<String>, Error> {
    let expected = crate::format::objects_at(version)?;
    Ok(expected.missing_from(&crate::format::Objects::read(connection)?))
}

/// The marker in the file name of a copy saved before a restore replaced the workspace.
pub(crate) const SAFETY_MARKER: &str = ".safety-";
/// The marker in the file name of a copy saved before a format migration.
pub(crate) const PRE_MIGRATION_MARKER: &str = ".pre-migration-";
/// Between a pre-migration copy's identifier and the version of ticketd that migrated.
pub(crate) const PRE_MIGRATION_VERSION_MARKER: &str = "-for-";

/// Restore accepts exactly the files that inspecting a backup calls valid.
pub(crate) fn validate(connection: &Connection) -> Result<(), Error> {
    validate_against(connection, Ladder::Required)
}

fn validate_against(connection: &Connection, ladder: Ladder) -> Result<(), Error> {
    // A backup from before Efforts became Plans gets the legacy-schema message, not a missing table.
    if table_exists(connection, "efforts").unwrap_or(false) {
        return Err(Error::LegacyEffortWorkspace);
    }
    let check = check_backup(connection, ladder)?;
    match &check {
        BackupCheck::Valid { .. } => Ok(()),
        BackupCheck::NewerFormat { backup_version, .. } => {
            Err(Error::NewerSchema(i64::from(*backup_version)))
        }
        other => Err(Error::Backup(other.refusal().unwrap_or_default())),
    }
}

impl Workspace {
    /// Create a consistent backup without overwriting an existing file.
    /// Returns whether the backup was also recorded as the last backup; the
    /// backup itself is saved either way.
    pub fn backup(&self, path: impl AsRef<Path>) -> Result<bool, Error> {
        let _uploads = self.attachment_backup_lock()?;
        let path = path.as_ref();
        save_snapshot(&self.connection, &self.attachment_directory()?, path, true)?;
        // The backup is already saved and checked, so a failure to note it
        // must not discard it; the previous record simply stays.
        let recorded = path
            .canonicalize()
            .map(|absolute| absolute.display().to_string())
            .unwrap_or_else(|_| path.display().to_string());
        Ok(self
            .connection
            .execute(
                "INSERT INTO last_backup (id, path, completed_at) VALUES (1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
                 ON CONFLICT(id) DO UPDATE SET path = excluded.path, completed_at = excluded.completed_at",
                [recorded],
            )
            .is_ok())
    }

    /// The last successful backup, or `None` when none was recorded.
    pub fn last_backup(&self) -> Result<Option<BackupRecord>, Error> {
        Self::read_last_backup(&self.connection)
    }

    pub(crate) fn read_last_backup(connection: &Connection) -> Result<Option<BackupRecord>, Error> {
        match connection.query_row(
            "SELECT path, completed_at FROM last_backup WHERE id = 1",
            [],
            |row| {
                Ok(BackupRecord {
                    path: row.get(0)?,
                    completed_at: row.get(1)?,
                })
            },
        ) {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn migration_backup(
        connection: &Connection,
        workspace: &Path,
    ) -> Result<PathBuf, Error> {
        let root = crate::backup_archive::attachment_root(workspace);
        std::fs::create_dir_all(&root)?;
        let _uploads = crate::attachments::lock_uploads(&root)?;
        let mut name = workspace.as_os_str().to_os_string();
        // The version that migrated the file names the update in the list of restore points.
        name.push(format!(
            "{PRE_MIGRATION_MARKER}{}{PRE_MIGRATION_VERSION_MARKER}{}.sqlite3",
            Uuid::new_v4(),
            env!("CARGO_PKG_VERSION")
        ));
        let path = PathBuf::from(name);
        save_snapshot(connection, &root, &path, false)?;
        Ok(path)
    }
}

/// How a snapshot holds the retained attachment files.
pub(crate) enum Packing<'a> {
    /// Inside the snapshot, which then restores anywhere.
    Embedded,
    /// In this folder, shared with other snapshots: a restore point.
    Shared(&'a Path),
}

/// Publish only a fully written single-file snapshot; never clobber another file.
pub(crate) fn save_snapshot(
    source: &Connection,
    root: &Path,
    path: &Path,
    check_schema: bool,
) -> Result<(), Error> {
    save_snapshot_packed(source, root, path, check_schema, &Packing::Embedded)
}

pub(crate) fn save_snapshot_packed(
    source: &Connection,
    root: &Path,
    path: &Path,
    check_schema: bool,
    packing: &Packing<'_>,
) -> Result<(), Error> {
    if path.exists() {
        return Err(Error::FileExists(path.to_path_buf()));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent_absolute = parent
        .canonicalize()
        .map_err(|e| crate::path_error("destination folder", parent, e))?;
    if root.exists() && parent_absolute.starts_with(root.canonicalize()?) {
        return Err(Error::Backup(
            "save the backup outside managed attachment storage".into(),
        ));
    }
    let staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| crate::path_error("destination folder", parent, e))?;
    let mut destination = Connection::open(staged.path())?;
    // Byte-restoring reference writes take only the SQLite writer lock. Freeze them
    // for the snapshot/path inventory, never for hashing/copying large file bodies.
    let barrier = if let Some(path) = source.path().filter(|path| !path.is_empty()) {
        let barrier = Connection::open(path)?;
        crate::session::configure(&barrier)?;
        barrier.execute_batch("BEGIN IMMEDIATE")?;
        Some(barrier)
    } else {
        None
    };
    copy(source, &mut destination)?;
    let files = crate::backup_archive::retained_file_inventory(root)?;
    drop(barrier);
    if check_schema {
        crate::source::forget_connections(&destination)?;
    }
    match packing {
        Packing::Embedded => crate::backup_archive::pack(&destination, files)?,
        Packing::Shared(store) => {
            crate::backup_archive::pack_external(&destination, files, store)?;
        }
    }
    if check_schema {
        // The ladder is not required of the live Workspace: see `Ladder::Unchecked`.
        validate_against(&destination, Ladder::Unchecked)?;
    }
    drop(destination);
    staged.as_file().sync_all()?;
    staged.persist_noclobber(path).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            Error::FileExists(path.to_path_buf())
        } else {
            Error::Directory(error.error)
        }
    })?;
    crate::backup_archive::sync_directory(parent)
}
