use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{Error, Workspace, default_path};
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
const TABLES: [(&str, i64); 18] = [
    ("tickets", 1),
    ("ticket_history", 3),
    ("tags", 4),
    ("ticket_tags", 4),
    ("notes", 5),
    ("dependencies", 6),
    ("contextual_relationships", 19),
    ("projects", 7),
    ("efforts", 8),
    ("ticket_parents", 9),
    ("project_checkouts", 10),
    ("request_outcomes", 12),
    ("ticket_follows", 14),
    ("inbox_entries", 14),
    ("duplicate_tickets", 15),
    ("evidence", 16),
    ("ticket_reminders", 18),
    ("last_backup", 20),
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
        if version >= introduced && !table_exists(connection, table)? {
            missing.push(table);
        }
    }
    Ok(missing)
}

pub(crate) fn validate(connection: &Connection) -> Result<(), Error> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 20 {
        return Err(Error::NewerSchema(version));
    }
    if !(1..=20).contains(&version) {
        return Err(Error::Backup(format!(
            "unsupported backup schema version {version}"
        )));
    }
    let integrity: String =
        connection.pragma_query_value(None, "integrity_check", |row| row.get(0))?;
    if integrity != "ok" {
        return Err(Error::Backup(format!(
            "integrity check failed: {integrity}"
        )));
    }
    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    if statement.query([])?.next()?.is_some() {
        return Err(Error::Backup("foreign key check failed".into()));
    }
    // Verify this is a ticketd database, not an unrelated database with a matching version.
    if let Some(table) = missing_tables(connection, version)?.first() {
        return Err(Error::Backup(format!("missing table {table}")));
    }
    Ok(())
}

impl Workspace {
    /// Create a consistent backup without overwriting an existing file.
    pub fn backup(&self, path: impl AsRef<Path>) -> Result<(), Error> {
        let path = path.as_ref();
        let file = OpenOptions::new().write(true).create_new(true).open(path)?;
        drop(file);
        let result = (|| {
            let mut dest = Connection::open(path)?;
            copy(&self.connection, &mut dest)?;
            validate(&dest)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(path);
            return result;
        }
        // The backup is already saved and checked, so a failure to note it
        // must not discard it; the previous record simply stays.
        let recorded = path
            .canonicalize()
            .map(|absolute| absolute.display().to_string())
            .unwrap_or_else(|_| path.display().to_string());
        let _ = self.connection.execute(
            "INSERT INTO last_backup (id, path, completed_at) VALUES (1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
             ON CONFLICT(id) DO UPDATE SET path = excluded.path, completed_at = excluded.completed_at",
            [recorded],
        );
        Ok(())
    }

    /// The last successful backup, or `None` when none was recorded.
    pub fn last_backup(&self) -> Result<Option<BackupRecord>, Error> {
        match self.connection.query_row(
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
        name.push(format!(".pre-migration-{}.sqlite3", Uuid::new_v4()));
        let path = PathBuf::from(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        drop(file);
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
        if current_version > 20 {
            return Err(Error::NewerSchema(current_version));
        }
        let mut name = workspace.as_os_str().to_os_string();
        name.push(format!(".safety-{}.sqlite3", Uuid::new_v4()));
        let safety = PathBuf::from(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&safety)?;
        drop(file);
        let mut safety_db = Connection::open(&safety)?;
        copy(&current, &mut safety_db)?;
        drop(safety_db);
        copy(&source, &mut current).map_err(|source| Error::Restore {
            safety: safety.clone(),
            source: Box::new(source),
        })?;
        Ok(safety)
    }
}
