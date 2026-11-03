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
    pub projects: u64,
    /// Plans that are not archived.
    pub active_plans: u64,
    pub size_bytes: u64,
    /// The workspace format (schema) version.
    pub format_version: u32,
}

impl Workspace {
    pub fn workspace_info(&self) -> Result<WorkspaceInfo, Error> {
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
            projects: count("SELECT COUNT(*) FROM projects")?,
            active_plans: count("SELECT COUNT(*) FROM plans WHERE archived = 0")?,
            path,
            format_version,
        })
    }
}
