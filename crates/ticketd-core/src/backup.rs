use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{Error, Workspace, default_path};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, backup::Backup};
use uuid::Uuid;

fn lock_file(path: &Path) -> Result<File, Error> {
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

pub(crate) fn shared_lock(path: &Path) -> Result<File, Error> {
    let file = lock_file(path)?;
    FileExt::lock_shared(&file)?;
    Ok(file)
}

fn copy(source: &Connection, destination: &mut Connection) -> Result<(), Error> {
    Backup::new(source, destination)?.run_to_completion(100, Duration::from_millis(25), None)?;
    Ok(())
}

fn validate(connection: &Connection) -> Result<(), Error> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 12 {
        return Err(Error::NewerSchema(version));
    }
    if version != 12 {
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
    for table in [
        "tickets",
        "request_outcomes",
        "ticket_history",
        "notes",
        "projects",
        "efforts",
        "project_checkouts",
        "ticket_parents",
        "dependencies",
        "tags",
        "ticket_tags",
    ] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::Backup(format!("missing table {table}")));
        }
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
        }
        result
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
        FileExt::try_lock_exclusive(&lock).map_err(|e| {
            Error::Backup(format!(
                "workspace is in use; close other ticketd operations and retry: {e}"
            ))
        })?;
        let source = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        source.execute_batch("BEGIN")?;
        validate(&source)?;
        if workspace.canonicalize()? == backup.canonicalize()? {
            return Err(Error::Backup("backup is the current workspace".into()));
        }
        let mut current = Connection::open(workspace)?;
        current.busy_timeout(Duration::from_secs(10))?;
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
        validate(&safety_db)?;
        drop(safety_db);
        copy(&source, &mut current).map_err(|e| {
            Error::Backup(format!(
                "restore failed: {e}; safety backup: {}",
                safety.display()
            ))
        })?;
        Ok(safety)
    }
}
