//! Workspace sync between a person's desktops through their own file storage:
//! change capture, the merge rules, the remote file storage interface and the
//! sync run that ties them together.

mod attachments;
mod capture;
mod engine;
#[cfg(feature = "fake-remote")]
mod fake_remote;
pub mod merge;
pub mod remote;
mod setup;

pub use crate::sync_files::MAX_FILE_BYTES;
pub use attachments::{AttachmentAvailability, AttachmentAvailabilityState, AttachmentDownloads};
pub use capture::{DirtyRecord, RecordKind};
pub(crate) use capture::{TRIGGER_EVENTS, captured_tables};
pub(crate) use engine::removed_by_sync;
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

/// Leave the sync folder and drop the last-synced copies, in a Workspace that
/// was just restored from a backup of any format version that has sync.
pub(crate) fn forget_folder(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::forget_folder(connection)
}

/// Format version 60.
pub(crate) fn migrate_recovery(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::migrate_recovery(connection)
}

/// Format version 61.
pub(crate) fn migrate_run_token(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::migrate_run_token(connection)
}

/// Format version 62.
pub(crate) fn migrate_download_attempts(
    connection: &rusqlite::Connection,
) -> Result<(), crate::Error> {
    setup::migrate_download_attempts(connection)
}

/// Format version 63.
pub(crate) fn migrate_file_identity(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::migrate_file_identity(connection)
}

/// Format version 64.
pub(crate) fn migrate_file_created(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::migrate_file_created(connection)
}

/// Format version 65.
pub(crate) fn migrate_last_folder(connection: &rusqlite::Connection) -> Result<(), crate::Error> {
    setup::migrate_last_folder(connection)
}
