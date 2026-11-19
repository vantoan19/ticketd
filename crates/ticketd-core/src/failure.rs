//! What kind of failure an [`Error`] is, so an interface chooses its words and
//! its next step by kind instead of reading the message. The message (and its
//! underlying cause) is kept for "Details"; the kind decides everything else.

use crate::Error;
use crate::drive::DriveErrorKind;
use crate::sync::remote::RemoteError;

/// The stable kinds the interfaces act on. Most failures are `Failed`: their
/// message was written for people and is shown as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The workspace can be read but not written (a read-only file, folder or volume).
    WorkspaceReadOnly,
    /// The workspace file cannot be opened or read (moved, unreadable, damaged).
    WorkspaceUnreadable,
    /// Another ticketd operation holds the workspace.
    WorkspaceLocked,
    /// The disk holding the workspace or a remote storage is full.
    DiskFull,
    /// The named record or file does not exist.
    NotFound,
    /// The change would make a ticket depend on, duplicate or contain itself.
    Cycle,
    /// The record changed elsewhere, or a request was reused for different content.
    Conflict,
    /// A file is larger than the workspace upload limit.
    TooLarge,
    /// An account must be connected or reconnected first.
    NotSignedIn,
    /// A service cannot be reached.
    Offline,
    /// Any other failure; its message says what happened.
    Failed,
}

impl FailureKind {
    /// The wire code the desktop bridge sends.
    pub fn code(self) -> &'static str {
        match self {
            Self::WorkspaceReadOnly => "workspace_read_only",
            Self::WorkspaceUnreadable => "workspace_unreadable",
            Self::WorkspaceLocked => "workspace_locked",
            Self::DiskFull => "disk_full",
            Self::NotFound => "not_found",
            Self::Cycle => "cycle",
            Self::Conflict => "conflict",
            Self::TooLarge => "too_large",
            Self::NotSignedIn => "not_signed_in",
            Self::Offline => "offline",
            Self::Failed => "failed",
        }
    }

    /// Whether the failure is about the whole workspace rather than one change.
    pub fn is_workspace(self) -> bool {
        matches!(
            self,
            Self::WorkspaceReadOnly
                | Self::WorkspaceUnreadable
                | Self::WorkspaceLocked
                | Self::DiskFull
        )
    }
}

impl Error {
    /// The kind of this failure. A batch or a reopen reports the kind of its cause.
    pub fn kind(&self) -> FailureKind {
        match self {
            Self::WorkspaceUnavailable { source, .. } => match source.kind() {
                kind if kind.is_workspace() => kind,
                _ => FailureKind::WorkspaceUnreadable,
            },
            Self::BatchOperation { source, .. }
            | Self::BatchNamed { source, .. }
            | Self::SafetyCopy { source } => source.kind(),
            Self::Restore { source, .. } | Self::Migration { source, .. } => match source.kind() {
                kind if kind.is_workspace() => kind,
                _ => FailureKind::Failed,
            },
            Self::RestoreLock { .. } => FailureKind::WorkspaceLocked,
            Self::Database(error) => database_kind(error),
            Self::Directory(error) => io_kind(error),
            Self::Drive(error) => match error.kind {
                DriveErrorKind::Unconfigured | DriveErrorKind::Reauthorize => {
                    FailureKind::NotSignedIn
                }
                DriveErrorKind::Offline => FailureKind::Offline,
                DriveErrorKind::Missing | DriveErrorKind::InaccessibleOrMissing => {
                    FailureKind::NotFound
                }
                DriveErrorKind::SelectFile
                | DriveErrorKind::PermissionDenied
                | DriveErrorKind::RateLimited
                | DriveErrorKind::Unsupported
                | DriveErrorKind::InvalidResponse
                | DriveErrorKind::Cancelled
                | DriveErrorKind::Uncertain => FailureKind::Failed,
            },
            Self::Remote(error) => match error {
                RemoteError::Unauthorized => FailureKind::NotSignedIn,
                RemoteError::Offline => FailureKind::Offline,
                RemoteError::StorageFull => FailureKind::DiskFull,
                RemoteError::FolderMissing | RemoteError::NotFound => FailureKind::NotFound,
                RemoteError::PreconditionFailed { .. } => FailureKind::Conflict,
                RemoteError::RateLimited { .. } | RemoteError::Other(_) => FailureKind::Failed,
            },
            Self::UploadLimit { .. } => FailureKind::TooLarge,
            Self::TicketChanged(_) | Self::DocumentChanged(_) | Self::RequestConflict(_) => {
                FailureKind::Conflict
            }
            Self::NotFound(_)
            | Self::DocumentNotFound(_)
            | Self::ChatNotFound(_)
            | Self::PlanNotFound(_)
            | Self::ProjectNotFound(_)
            | Self::EvidenceNotFound(_)
            | Self::ActivityNotFound(_)
            | Self::AutomationAgentNotFound(_)
            | Self::AutomationNotFound(_)
            | Self::AutomationRunNotFound(_)
            | Self::InboxEntryNotFound(_) => FailureKind::NotFound,
            Self::DependencyCycle { .. }
            | Self::DependencySelf(_)
            | Self::DuplicateCycle
            | Self::InvalidHierarchy
            | Self::RelationshipSelfLink
            | Self::ReviewSameTicket => FailureKind::Cycle,
            Self::Attachment(_)
            | Self::InvalidAutomationAgent(_)
            | Self::AutomationAgentInUse(_)
            | Self::AutomationRun(_)
            | Self::AutomationRunAutomationDeleted
            | Self::InvalidAutomation(_)
            | Self::AutomationUnfinished(_)
            | Self::ChatTrashed(_)
            | Self::ChatSubmissionUnresolved(_)
            | Self::Chat(_)
            | Self::Backup(_)
            | Self::LegacyEffortWorkspace
            | Self::Serialization(_)
            | Self::InvalidBatch(_)
            | Self::InvalidReminderTime(_)
            | Self::NoReminder(_)
            | Self::SnoozeNotLater { .. }
            | Self::InvalidGraphRequest(_)
            | Self::EmptyPlanName
            | Self::PlanNameTooLong(_)
            | Self::AmbiguousProject(_)
            | Self::CheckoutTaken(_)
            | Self::CheckoutNotRegistered(_)
            | Self::InvalidCheckoutPath
            | Self::EmptyProject
            | Self::DuplicateDependencies
            | Self::DuplicateNeedsCanonical
            | Self::DuplicateCanonicalUnresolved(_)
            | Self::DependencyReviewChanged
            | Self::SyncReviewChanged
            | Self::DependencyReviewMode(_)
            | Self::PlanArchived
            | Self::EmptyTag
            | Self::InvalidTag { .. }
            | Self::EmptyRequestId
            | Self::Trashed(_)
            | Self::DocumentTrashed(_)
            | Self::MissingRelatedTicket
            | Self::EmptyTitle
            | Self::TitleNotOneLine
            | Self::TitleTooLong(_)
            | Self::InvalidEvidence(_)
            | Self::ConflictingActivitySupport
            | Self::EmptyActivityBrief
            | Self::ExternalContent { .. }
            | Self::ExternalStatus { .. }
            | Self::NotSynchronized(_)
            | Self::AlreadyLocal(_)
            | Self::SourceAvailable { .. }
            | Self::Source(_)
            | Self::Publication(_)
            | Self::NoDataDirectory
            | Self::FileExists(_)
            | Self::NoCheckoutFolder(_)
            | Self::Path(_)
            | Self::SyncFile(_)
            | Self::Sync(_)
            | Self::NewerSchema(_) => FailureKind::Failed,
        }
    }
}

fn database_kind(error: &rusqlite::Error) -> FailureKind {
    use rusqlite::ErrorCode;
    let rusqlite::Error::SqliteFailure(failure, _) = error else {
        return FailureKind::Failed;
    };
    match failure.code {
        ErrorCode::ReadOnly => FailureKind::WorkspaceReadOnly,
        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => FailureKind::WorkspaceLocked,
        ErrorCode::DiskFull => FailureKind::DiskFull,
        ErrorCode::CannotOpen
        | ErrorCode::NotADatabase
        | ErrorCode::DatabaseCorrupt
        | ErrorCode::PermissionDenied => FailureKind::WorkspaceUnreadable,
        _ => FailureKind::Failed,
    }
}

fn io_kind(error: &std::io::Error) -> FailureKind {
    use std::io::ErrorKind;
    match error.kind() {
        // Directory errors come from creating or writing workspace files, so a
        // refused permission means the workspace cannot be written.
        ErrorKind::ReadOnlyFilesystem | ErrorKind::PermissionDenied => {
            FailureKind::WorkspaceReadOnly
        }
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => FailureKind::DiskFull,
        _ => FailureKind::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite(code: std::ffi::c_int) -> Error {
        Error::Database(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            Some("raw".into()),
        ))
    }

    #[test]
    fn storage_failures_name_the_workspace_state() {
        assert_eq!(
            sqlite(rusqlite::ffi::SQLITE_READONLY).kind().code(),
            "workspace_read_only"
        );
        assert_eq!(
            sqlite(rusqlite::ffi::SQLITE_BUSY).kind().code(),
            "workspace_locked"
        );
        assert_eq!(
            sqlite(rusqlite::ffi::SQLITE_FULL).kind().code(),
            "disk_full"
        );
        assert_eq!(
            sqlite(rusqlite::ffi::SQLITE_CANTOPEN).kind().code(),
            "workspace_unreadable"
        );
        // A batch reports its cause, and the message keeps the raw text.
        let batch = Error::BatchOperation {
            index: 2,
            source: Box::new(sqlite(rusqlite::ffi::SQLITE_READONLY)),
        };
        assert_eq!(batch.kind(), FailureKind::WorkspaceReadOnly);
        assert!(batch.to_string().contains("raw"));
    }

    #[test]
    fn domain_failures_have_their_own_kinds() {
        assert_eq!(Error::NotFound("T-1".into()).kind(), FailureKind::NotFound);
        assert_eq!(
            Error::DependencyCycle {
                blocker: "T-1".into(),
                dependent: "T-2".into(),
                detail: "T-2 already blocks T-1.".into(),
            }
            .kind(),
            FailureKind::Cycle
        );
        assert_eq!(
            Error::TicketChanged("T-1".into()).kind(),
            FailureKind::Conflict
        );
        assert_eq!(
            Error::UploadLimit { limit: 1_048_576 }.kind(),
            FailureKind::TooLarge
        );
        assert_eq!(Error::EmptyTitle.kind(), FailureKind::Failed);
    }
}
