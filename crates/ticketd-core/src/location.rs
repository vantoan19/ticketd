use serde::{Deserialize, Serialize};

use crate::{Error, Workspace};

/// Where the workspace lives and how much it holds, shared by the desktop
/// Settings page and any other surface that describes the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    /// Full path of the workspace file.
    pub path: String,
    /// Tickets outside Trash.
    pub tickets: u64,
    pub projects: u64,
    /// Efforts that are not archived.
    pub active_efforts: u64,
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
            active_efforts: count("SELECT COUNT(*) FROM efforts WHERE archived = 0")?,
            path,
            format_version,
        })
    }
}
