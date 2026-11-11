//! Workspace sync between a person's desktops through their own file storage:
//! change capture, the merge rules, the remote file storage interface and the
//! sync run that ties them together.

mod capture;
mod engine;
pub mod merge;
pub mod remote;

pub use capture::{DirtyRecord, RecordKind};
pub(crate) use capture::{TRIGGER_EVENTS, captured_tables};
pub use engine::{
    SyncChoice, SyncConflict, SyncConflictField, SyncNotice, SyncNoticeKind, SyncReport,
    SyncResolution,
};

pub(crate) fn migrate(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    capture::migrate(connection)?;
    engine::migrate(connection)
}
