//! Workspace sync between a person's desktops through their own file storage:
//! change capture, the merge rules, the remote file storage interface and the
//! sync run that ties them together.

mod attachments;
mod capture;
mod engine;
pub mod merge;
pub mod remote;
mod setup;

pub use attachments::{AttachmentAvailability, AttachmentAvailabilityState, AttachmentDownloads};
pub use capture::{DirtyRecord, RecordKind};
pub(crate) use capture::{TRIGGER_EVENTS, captured_tables};
pub use engine::{
    SyncChoice, SyncConflict, SyncConflictField, SyncNotice, SyncNoticeKind, SyncReport,
    SyncResolution,
};
pub use setup::{
    AttachmentDownload, ExistingWorkspace, FirstSync, MIN_POLL_INTERVAL_SECS, SetupOptions,
    SyncBinding, SyncConnection, SyncCounts, SyncDirection, SyncFolder, SyncItem, SyncRecovery,
    SyncRecoveryAction, SyncSettings, SyncState, SyncStatus,
};

pub(crate) fn migrate(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    capture::migrate(connection)?;
    engine::migrate(connection)
}

/// The sync destination and Attachment transfer state (format version 59).
pub(crate) fn migrate_setup(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::migrate(connection)
}

/// Format version 60.
pub(crate) fn migrate_recovery(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::migrate_recovery(connection)
}
