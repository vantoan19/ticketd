//! Remote file storage interface for Workspace sync. Its in-memory fake is
//! built only with the `fake-remote` feature, which tests turn on.
//!
//! The remote only stores bytes. Merging, Markdown conversion and scheduling
//! belong to the sync engine. Every file is identified by record kind + GUID,
//! never by its readable name.
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteKind {
    Ticket,
    Document,
    Plan,
    Project,
    /// Raw managed Attachment bytes, stored under `attachments/`.
    Attachment,
    /// The small device-registry file.
    Devices,
}

impl RemoteKind {
    pub const ALL: [Self; 6] = [
        Self::Ticket,
        Self::Document,
        Self::Plan,
        Self::Project,
        Self::Attachment,
        Self::Devices,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ticket => "ticket",
            Self::Document => "document",
            Self::Plan => "plan",
            Self::Project => "project",
            Self::Attachment => "attachment",
            Self::Devices => "devices",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

/// The identity of a remote file.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct RemoteKey {
    pub kind: RemoteKind,
    /// The record GUID. Letters, digits, `-` and `_` only, at most 64 bytes.
    pub id: String,
}

impl RemoteKey {
    pub fn new(kind: RemoteKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteFile {
    pub key: RemoteKey,
    /// Readable name for browsing the storage. Not an identity; may repeat.
    pub name: String,
    /// Opaque. Changes whenever the stored bytes change; compare for equality only.
    pub version: String,
    pub size: u64,
}

/// One stored version of a file, oldest first in listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteRevision {
    pub version: String,
    /// RFC 3339 time at which the storage received this version.
    pub modified: String,
    pub size: u64,
}

/// A Workspace folder this app created in the storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteFolder {
    /// The identifier passed to [`RemoteStorage::ensure_folder`].
    pub id: String,
    pub name: String,
}

/// The recovery states of the sync engine. None of them is a reason to delete local content.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteError {
    #[error("storage authorization expired or was withdrawn; reconnect")]
    Unauthorized,
    #[error("the Workspace folder is missing from the storage")]
    FolderMissing,
    #[error("the storage is full")]
    StorageFull,
    #[error("the storage cannot be reached")]
    Offline,
    #[error("the storage is rate limited")]
    RateLimited { retry_after: Option<Duration> },
    /// The write was not applied: the file is not at the expected version.
    /// `current` is the file as stored now, or `None` when it is missing.
    #[error("the remote file changed since it was last synced")]
    PreconditionFailed { current: Option<RemoteFile> },
    /// The requested file or version is not in the storage.
    #[error("the remote file or version was not found")]
    NotFound,
    #[error("storage: {0}")]
    Other(String),
}

/// Rewindable bytes, so a write can hash its content and retry a transfer.
pub trait RemoteContent: Read + Seek {}
impl<T: Read + Seek> RemoteContent for T {}

/// File storage for one account. `folder` is the Workspace folder identifier
/// chosen by the caller (letters, digits, `-`, `_`; at most 64 bytes).
/// Implementations are shared between threads and hold no Workspace state.
pub trait RemoteStorage: Send + Sync {
    /// Workspace folders this app created in the account.
    fn folders(&self) -> Result<Vec<RemoteFolder>, RemoteError>;

    /// Create the Workspace folder unless it exists. Repeating it is harmless.
    fn ensure_folder(&self, folder: &str, name: &str) -> Result<(), RemoteError>;

    /// Every file in the folder, in no particular order. Compare each
    /// `version` with the last synced one to discover changes. A file may be
    /// absent from one listing and present in the next.
    fn list(&self, folder: &str) -> Result<Vec<RemoteFile>, RemoteError>;

    /// Write the bytes of one version, current or past, to `output`.
    fn download(
        &self,
        folder: &str,
        key: &RemoteKey,
        version: &str,
        output: &mut dyn Write,
    ) -> Result<(), RemoteError>;

    /// Store `content` as the file's new version.
    ///
    /// `expected` is the version last synced, or `None` to create the file.
    /// When the stored bytes already equal `content` the call succeeds without
    /// a new version, so a repeated write never duplicates. Otherwise a file
    /// that is not at `expected` fails with [`RemoteError::PreconditionFailed`].
    fn write(
        &self,
        folder: &str,
        key: &RemoteKey,
        name: &str,
        expected: Option<&str>,
        content: &mut dyn RemoteContent,
    ) -> Result<RemoteFile, RemoteError>;

    /// The versions the storage still keeps, oldest first, ending with the current one.
    fn revisions(&self, folder: &str, key: &RemoteKey) -> Result<Vec<RemoteRevision>, RemoteError>;
}

pub(crate) fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

pub(crate) fn invalid_identifier() -> RemoteError {
    RemoteError::Other("invalid folder or record identifier".into())
}

/// Reads `content` from its start: SHA-256 as lowercase hex, and the length.
pub(crate) fn digest(content: &mut dyn RemoteContent) -> Result<(String, u64), RemoteError> {
    let unreadable = |_| RemoteError::Other("cannot read the content to upload".into());
    content.seek(SeekFrom::Start(0)).map_err(unreadable)?;
    let mut hasher = Sha256::new();
    let size = std::io::copy(content, &mut hasher).map_err(unreadable)?;
    content.seek(SeekFrom::Start(0)).map_err(unreadable)?;
    let hash = hasher.finalize();
    Ok((
        hash.iter().map(|byte| format!("{byte:02x}")).collect(),
        size,
    ))
}

#[cfg(feature = "fake-remote")]
pub use super::fake_remote::{FakeRemote, RemoteOp};
