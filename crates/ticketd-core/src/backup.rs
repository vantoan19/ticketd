use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{
    Error, FORMAT_VERSION, Workspace,
    backup_review::{BackupCheck, check_backup},
    default_path,
};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, backup::Backup};
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

pub(crate) fn lock_file(path: &Path) -> Result<File, Error> {
    let resolved = match path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            parent.canonicalize()?.join(
                path.file_name()
                    .ok_or_else(|| Error::Backup("invalid workspace path".into()))?,
            )
        }
        Err(error) => return Err(error.into()),
    };
    let mut name = resolved.as_os_str().to_os_string();
    name.push(".lock");
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(name)?)
}

pub(crate) fn copy(source: &Connection, destination: &mut Connection) -> Result<(), Error> {
    Backup::new(source, destination)?.run_to_completion(100, Duration::from_millis(25), None)?;
    Ok(())
}

/// Each table a ticketd workspace has, with the format version that added it.
const TABLES: [(&str, i64); 31] = [
    ("entities", 31),
    ("documents", 31),
    ("document_opens", 31),
    ("context_mentions", 35),
    ("tickets", 1),
    ("ticket_history", 3),
    ("tags", 4),
    ("ticket_tags", 4),
    ("notes", 5),
    ("dependencies", 6),
    ("contextual_relationships", 19),
    ("projects", 7),
    ("plans", 8),
    ("plan_documents", 39),
    ("ticket_parents", 9),
    ("project_checkouts", 10),
    ("request_outcomes", 12),
    ("ticket_follows", 14),
    ("inbox_entries", 14),
    ("duplicate_tickets", 15),
    ("evidence", 16),
    ("ticket_reminders", 18),
    ("last_backup", 20),
    ("source_configurations", 22),
    ("external_identities", 23),
    ("external_ownership", 23),
    ("source_sync", 23),
    ("external_duplicate_targets", 23),
    ("source_conversation", 24),
    ("source_status", 25),
    ("publication_attempts", 26),
];

pub(crate) fn table_exists(connection: &Connection, table: &str) -> Result<bool, Error> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )?)
}

/// The tables a workspace of this format version should have but does not.
pub(crate) fn missing_tables(
    connection: &Connection,
    version: i64,
) -> Result<Vec<&'static str>, Error> {
    let mut missing = Vec::new();
    for (table, introduced) in TABLES {
        if version >= introduced
            && !(table == "notes" && version >= 32)
            && !table_exists(connection, table)?
        {
            missing.push(table);
        }
    }
    if version >= 32 && !table_exists(connection, "activities")? {
        missing.push("activities");
    }
    Ok(missing)
}

/// The marker in the file name of a copy saved before a restore replaced the workspace.
pub(crate) const SAFETY_MARKER: &str = ".safety-";
/// The marker in the file name of a copy saved before a format migration.
pub(crate) const PRE_MIGRATION_MARKER: &str = ".pre-migration-";

/// Restore accepts exactly the files that inspecting a backup calls valid.
pub(crate) fn validate(connection: &Connection) -> Result<(), Error> {
    match check_backup(connection)? {
        BackupCheck::Valid { .. } => Ok(()),
        BackupCheck::NewerFormat { backup_version, .. } => {
            Err(Error::NewerSchema(i64::from(backup_version)))
        }
        BackupCheck::NotTicketd => Err(Error::Backup("not a ticketd workspace backup".into())),
        BackupCheck::MissingTables { tables } => Err(Error::Backup(format!(
            "missing table {}",
            tables.join(", ")
        ))),
        BackupCheck::Damaged { reason } => Err(Error::Backup(reason)),
        BackupCheck::CurrentWorkspace => {
            Err(Error::Backup("backup is the current workspace".into()))
        }
    }
}

/// Opens a new file, refusing to replace one that already exists.
fn create_new(path: &Path) -> Result<File, Error> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => Error::FileExists(path.to_path_buf()),
            _ => error.into(),
        })
}

impl Workspace {
    /// Create a consistent backup without overwriting an existing file.
    /// Returns whether the backup was also recorded as the last backup; the
    /// backup itself is saved either way.
    pub fn backup(&self, path: impl AsRef<Path>) -> Result<bool, Error> {
        let path = path.as_ref();
        drop(create_new(path)?);
        let result = (|| {
            let mut dest = Connection::open(path)?;
            copy(&self.connection, &mut dest)?;
            validate(&dest)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(path);
            return result.map(|()| false);
        }
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

    fn read_last_backup(connection: &Connection) -> Result<Option<BackupRecord>, Error> {
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
        let mut name = workspace.as_os_str().to_os_string();
        name.push(format!("{PRE_MIGRATION_MARKER}{}.sqlite3", Uuid::new_v4()));
        let path = PathBuf::from(name);
        drop(create_new(&path)?);
        let result = (|| {
            let mut destination = Connection::open(&path)?;
            copy(connection, &mut destination)?;
            Ok::<_, Error>(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        result?;
        Ok(path)
    }

    pub fn restore_default(path: impl AsRef<Path>) -> Result<PathBuf, Error> {
        Self::restore(default_path()?, path)
    }

    /// Restore only when no workspace connection is open. Returns the safety backup path.
    pub fn restore(
        workspace: impl AsRef<Path>,
        backup: impl AsRef<Path>,
    ) -> Result<PathBuf, Error> {
        let workspace = workspace.as_ref();
        let backup = backup.as_ref();
        let lock = lock_file(workspace)?;
        FileExt::try_lock_exclusive(&lock).map_err(|source| {
            if source.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                Error::RestoreLock { source }
            } else {
                Error::Directory(source)
            }
        })?;
        let source = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        source.execute_batch("BEGIN")?;
        validate(&source)?;
        if workspace.canonicalize()? == backup.canonicalize()? {
            return Err(Error::Backup("backup is the current workspace".into()));
        }
        let mut current = Connection::open(workspace)?;
        current.busy_timeout(Duration::from_secs(10))?;
        let current_version: i64 =
            current.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current_version > FORMAT_VERSION {
            return Err(Error::NewerSchema(current_version));
        }
        let mut name = workspace.as_os_str().to_os_string();
        name.push(format!("{SAFETY_MARKER}{}.sqlite3", Uuid::new_v4()));
        let safety = PathBuf::from(name);
        drop(create_new(&safety)?);
        let mut safety_db = Connection::open(&safety)?;
        copy(&current, &mut safety_db)?;
        drop(safety_db);
        // The restored file brings its own, older record. The last backup is a
        // fact about this computer, so keep the one from before the restore.
        let last_backup = Self::read_last_backup(&current).ok().flatten();
        copy(&source, &mut current).map_err(|source| Error::Restore {
            safety: safety.clone(),
            source: Box::new(source),
        })?;
        if let Some(record) = last_backup {
            // Only a restored workspace of the current format has the table; an
            // older one gets an empty record when it is migrated.
            let _ = current.execute(
                "INSERT INTO last_backup (id, path, completed_at) VALUES (1, ?1, ?2) \
                 ON CONFLICT(id) DO UPDATE SET path = excluded.path, completed_at = excluded.completed_at",
                [record.path, record.completed_at],
            );
        }
        Ok(safety)
    }
}
