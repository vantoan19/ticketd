//! Opens commands against the desktop's workspace for the lifetime of the app.
use std::{path::PathBuf, sync::Mutex};

use ticketd_core::{Error, Workspace};

pub(crate) struct Session {
    path: Mutex<Option<PathBuf>>,
}

impl Session {
    pub(crate) const fn new() -> Self {
        Self {
            path: Mutex::new(None),
        }
    }

    pub(crate) fn open(
        &self,
        initialize: impl FnOnce() -> Result<Workspace, Error>,
    ) -> Result<Workspace, Error> {
        // Hold the lock through first initialization so simultaneous startup commands
        // cannot initialize a second workspace after the first one has disappeared.
        let mut path = self.path.lock().map_err(|_| {
            Error::Path("workspace session is unavailable; restart ticketd and retry".into())
        })?;
        let mut workspace = match path.as_deref() {
            Some(path) => Workspace::open_existing(path)?,
            None => {
                let workspace = initialize()?;
                *path = Some(PathBuf::from(workspace.workspace_info()?.path));
                workspace
            }
        };
        drop(path);
        workspace.act_as_local_person()?;
        Ok(workspace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_can_retry_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("new-installation");
        let path = folder.join("workspace.sqlite3");
        let session = Session::new();
        let open = || session.open(|| Workspace::open(&path));
        assert!(open().is_err());
        assert!(!path.exists());
        std::fs::create_dir(&folder).unwrap();
        assert!(open().unwrap().list_tickets().unwrap().is_empty());
        assert!(path.exists());
        assert!(open().unwrap().list_tickets().unwrap().is_empty());
    }

    #[test]
    fn missing_workspace_rejects_refresh_and_writes_then_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.sqlite3");
        let preserved = directory.path().join("preserved.sqlite3");
        let session = Session::new();
        let open = || session.open(|| Workspace::open(&path));
        let ticket = open()
            .unwrap()
            .create_ticket("Preserve this outcome")
            .unwrap();
        std::fs::rename(&path, &preserved).unwrap();

        let refresh = open().and_then(|workspace| workspace.list_tickets());
        let error = refresh.unwrap_err();
        let message = error.to_string();
        assert!(message.contains("cannot reopen workspace"), "{message}");
        assert!(message.contains(path.to_str().unwrap()), "{message}");
        assert!(
            message.contains("unable to open database file"),
            "{message}"
        );
        assert!(message.contains("then retry"), "{message}");
        assert!(std::error::Error::source(&error).is_some());
        assert!(
            !path.exists(),
            "Refresh must not create a replacement workspace"
        );
        let write = open().and_then(|mut workspace| workspace.create_ticket("Do not create"));
        assert!(write.is_err(), "Writes must report the missing workspace");
        assert!(
            !path.exists(),
            "Writes must not create a replacement workspace"
        );

        std::fs::rename(&preserved, &path).unwrap();
        assert_eq!(open().unwrap().list_tickets().unwrap(), vec![ticket]);
    }
}
