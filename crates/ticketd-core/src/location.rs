//! Where the workspace lives and which storage format it uses.
use crate::{Error, Workspace};
use std::path::PathBuf;

/// The workspace file the desktop app and CLI share for this operating-system user.
pub fn default_workspace_path() -> Result<PathBuf, Error> {
    crate::default_path()
}

impl Workspace {
    /// The storage format version of this workspace, after any migration on open.
    pub fn format_version(&self) -> Result<i64, Error> {
        Ok(self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }
}
