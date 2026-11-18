use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::{Error, Workspace};

/// What is on disk at a workspace path, read without creating or migrating anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceFile {
    /// The resolved path when the file exists, otherwise the path as given.
    pub path: PathBuf,
    /// The file's own format version, or `None` when there is no file yet.
    pub format_version: Option<i64>,
}

/// Reads the format version of the workspace file at `path`. It opens the file
/// read-only, so it never creates a missing workspace or migrates an old one.
pub fn workspace_file(path: impl AsRef<Path>) -> Result<WorkspaceFile, Error> {
    let path = path.as_ref();
    let Ok(resolved) = path.canonicalize() else {
        return Ok(WorkspaceFile {
            path: path.to_path_buf(),
            format_version: None,
        });
    };
    let connection = Connection::open_with_flags(
        &resolved,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let format_version = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(WorkspaceFile {
        path: resolved,
        format_version: Some(format_version),
    })
}

/// How sound a workspace file is and how much it holds, without what it holds: for the
/// diagnostics export, which has to describe a damaged file as readily as a sound one.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkspaceHealth {
    /// The file's format version, or `None` when it could not be read.
    pub format_version: Option<i64>,
    /// `ok`, or what SQLite's `quick_check` found, or why it could not be run.
    pub quick_check: String,
    pub file_bytes: u64,
    /// The write-ahead journal beside the file; zero when there is none.
    pub wal_bytes: u64,
    /// Rows in each table the Workspace stores.
    pub row_counts: std::collections::BTreeMap<String, u64>,
}

/// Describes the workspace file at `path`. It opens the file read-only, so it neither
/// creates, migrates nor locks anything, and it never fails: a file that cannot be read is
/// reported as such in the result.
pub fn workspace_health(path: impl AsRef<Path>) -> WorkspaceHealth {
    let path = path.as_ref();
    let size = |path: &Path| std::fs::metadata(path).map_or(0, |meta| meta.len());
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let mut health = WorkspaceHealth {
        file_bytes: size(path),
        wal_bytes: size(Path::new(&wal)),
        ..WorkspaceHealth::default()
    };
    match inspect(path, &mut health) {
        Ok(()) => {}
        Err(error) => health.quick_check = format!("could not be checked: {error}"),
    }
    health
}

fn inspect(path: &Path, health: &mut WorkspaceHealth) -> Result<(), rusqlite::Error> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // The check comes first: a damaged file may fail on everything after it.
    let found: Vec<String> = connection
        .prepare("PRAGMA quick_check(5)")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    health.quick_check = found.join("; ");
    health.format_version =
        Some(connection.pragma_query_value(None, "user_version", |row| row.get(0))?);
    let tables: Vec<(String, String)> = connection
        .prepare(
            "SELECT name, COALESCE(sql, '') FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    // A search index stores its own copy in tables of its own; those are not rows of the
    // Workspace.
    let indexes: Vec<&str> = tables
        .iter()
        .filter(|(_, sql)| sql.to_ascii_uppercase().starts_with("CREATE VIRTUAL"))
        .map(|(name, _)| name.as_str())
        .collect();
    for (name, _) in &tables {
        let own = |index: &&str| name == index || name.starts_with(&format!("{index}_"));
        if indexes.iter().any(own) {
            continue;
        }
        let count: u64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\"")),
            [],
            |row| row.get(0),
        )?;
        health.row_counts.insert(name.clone(), count);
    }
    Ok(())
}

/// [`workspace_file`] for the default workspace location.
pub fn default_workspace_file() -> Result<WorkspaceFile, Error> {
    workspace_file(crate::default_path_unchecked()?)
}

/// Where the workspace lives and how much it holds, shared by the desktop
/// Settings page and any other surface that describes the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    /// Full path of the workspace file.
    pub path: String,
    /// Tickets outside Trash.
    pub tickets: u64,
    /// All Documents, including supporting details and Trash.
    pub documents: u64,
    pub projects: u64,
    /// Plans that are not archived.
    pub active_plans: u64,
    pub size_bytes: u64,
    /// The workspace format (schema) version.
    pub format_version: u32,
}

impl Workspace {
    pub fn workspace_info(&self) -> Result<WorkspaceInfo, Error> {
        self.read(|_| {
            let path = self
                .connection
                .path()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| Error::Backup("workspace has no file path".into()))?
                .to_owned();
            let count = |sql: &str| -> Result<u64, Error> {
                Ok(self.connection.query_row(sql, [], |row| row.get(0))?)
            };
            let format_version: u32 =
                self.connection
                    .pragma_query_value(None, "user_version", |row| row.get(0))?;
            Ok(WorkspaceInfo {
                size_bytes: std::fs::metadata(&path)?.len(),
                tickets: count("SELECT COUNT(*) FROM tickets WHERE trashed = 0")?,
                documents: count("SELECT COUNT(*) FROM documents")?,
                projects: count("SELECT COUNT(*) FROM projects")?,
                active_plans: count("SELECT COUNT(*) FROM plans WHERE archived = 0")?,
                path,
                format_version,
            })
        })
    }
}
