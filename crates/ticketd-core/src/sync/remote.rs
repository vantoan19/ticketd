//! Remote file storage interface for Workspace sync, and its in-memory fake.
//!
//! The remote only stores bytes. Merging, Markdown conversion and scheduling
//! belong to the sync engine. Every file is identified by record kind + GUID,
//! never by its readable name.
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
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

/// The operations of [`RemoteStorage`], for failure injection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteOp {
    Folders,
    EnsureFolder,
    List,
    Download,
    Write,
    Revisions,
}

struct Fault {
    op: RemoteOp,
    /// Matching calls still to let through before this one fires.
    remaining: usize,
    after_applying: bool,
    error: RemoteError,
}

struct FakeRevision {
    version: String,
    modified: String,
    bytes: Arc<Vec<u8>>,
}

struct FakeFile {
    name: String,
    revisions: Vec<FakeRevision>,
}

#[derive(Default)]
struct FakeFolder {
    name: String,
    files: BTreeMap<RemoteKey, FakeFile>,
}

struct FakeState {
    folders: BTreeMap<String, FakeFolder>,
    faults: Vec<Fault>,
    calls: Vec<RemoteOp>,
    versions: u64,
    now: String,
    reversed: bool,
    omitted: Vec<RemoteKey>,
}

/// In-memory [`RemoteStorage`] for engine tests: one fake is one storage
/// account. Clones share the same state, so give each Workspace a clone.
#[derive(Clone)]
pub struct FakeRemote(Arc<Mutex<FakeState>>);

impl Default for FakeRemote {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(FakeState {
            folders: BTreeMap::new(),
            faults: Vec::new(),
            calls: Vec::new(),
            versions: 0,
            now: "2026-01-01T00:00:00Z".into(),
            reversed: false,
            omitted: Vec::new(),
        })))
    }
}

impl FakeRemote {
    pub fn new() -> Self {
        Self::default()
    }

    fn state(&self) -> MutexGuard<'_, FakeState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The `nth` next call of `op` (1 = the next one) fails with `error` and changes nothing.
    pub fn fail(&self, op: RemoteOp, nth: usize, error: RemoteError) {
        self.inject(op, nth, false, error);
    }

    /// The `nth` next write is stored, but its caller gets `error`: a lost response.
    pub fn drop_write(&self, nth: usize, error: RemoteError) {
        self.inject(RemoteOp::Write, nth, true, error);
    }

    fn inject(&self, op: RemoteOp, nth: usize, after_applying: bool, error: RemoteError) {
        self.state().faults.push(Fault {
            op,
            remaining: nth.saturating_sub(1),
            after_applying,
            error,
        });
    }

    /// Listings come back in the opposite order while set.
    pub fn reverse_listings(&self, reversed: bool) {
        self.state().reversed = reversed;
    }

    /// The next listing leaves these files out, as an inconsistent paged listing can.
    pub fn omit_from_next_listing(&self, keys: &[RemoteKey]) {
        self.state().omitted = keys.to_vec();
    }

    /// The folder and its files disappear, as when the person deletes it in the storage.
    pub fn remove_folder(&self, folder: &str) {
        self.state().folders.remove(folder);
    }

    /// One file disappears with its revisions. Returns whether it existed.
    pub fn remove_file(&self, folder: &str, key: &RemoteKey) -> bool {
        self.state()
            .folders
            .get_mut(folder)
            .is_some_and(|f| f.files.remove(key).is_some())
    }

    /// The time stamped on revisions written from now on (RFC 3339).
    pub fn set_now(&self, now: &str) {
        self.state().now = now.into();
    }

    /// Every call made so far, in order, including failed ones.
    pub fn calls(&self) -> Vec<RemoteOp> {
        self.state().calls.clone()
    }

    /// Records the call and returns the state, the injected failure to report
    /// after applying (if any), or the injected failure to report instead.
    fn begin(
        &self,
        op: RemoteOp,
    ) -> Result<(MutexGuard<'_, FakeState>, Option<RemoteError>), RemoteError> {
        let mut state = self.state();
        state.calls.push(op);
        let mut fired = None;
        for (index, fault) in state.faults.iter_mut().enumerate() {
            if fault.op != op {
                continue;
            }
            if fault.remaining == 0 {
                fired.get_or_insert(index);
            } else {
                fault.remaining -= 1;
            }
        }
        match fired.map(|index| state.faults.remove(index)) {
            Some(fault) if fault.after_applying => Ok((state, Some(fault.error))),
            Some(fault) => Err(fault.error),
            None => Ok((state, None)),
        }
    }
}

fn check(folder: &str, key: Option<&RemoteKey>) -> Result<(), RemoteError> {
    if valid_identifier(folder) && key.is_none_or(|key| valid_identifier(&key.id)) {
        Ok(())
    } else {
        Err(invalid_identifier())
    }
}

fn fake_file(key: &RemoteKey, file: &FakeFile) -> Option<RemoteFile> {
    file.revisions.last().map(|revision| RemoteFile {
        key: key.clone(),
        name: file.name.clone(),
        version: revision.version.clone(),
        size: revision.bytes.len() as u64,
    })
}

impl RemoteStorage for FakeRemote {
    fn folders(&self) -> Result<Vec<RemoteFolder>, RemoteError> {
        let (state, _) = self.begin(RemoteOp::Folders)?;
        Ok(state
            .folders
            .iter()
            .map(|(id, folder)| RemoteFolder {
                id: id.clone(),
                name: folder.name.clone(),
            })
            .collect())
    }

    fn ensure_folder(&self, folder: &str, name: &str) -> Result<(), RemoteError> {
        check(folder, None)?;
        let (mut state, _) = self.begin(RemoteOp::EnsureFolder)?;
        state
            .folders
            .entry(folder.into())
            .or_insert_with(|| FakeFolder {
                name: name.into(),
                files: BTreeMap::new(),
            });
        Ok(())
    }

    fn list(&self, folder: &str) -> Result<Vec<RemoteFile>, RemoteError> {
        check(folder, None)?;
        let (mut state, _) = self.begin(RemoteOp::List)?;
        let omitted = std::mem::take(&mut state.omitted);
        let stored = state
            .folders
            .get(folder)
            .ok_or(RemoteError::FolderMissing)?;
        let mut files: Vec<RemoteFile> = stored
            .files
            .iter()
            .filter(|(key, _)| !omitted.contains(key))
            .filter_map(|(key, file)| fake_file(key, file))
            .collect();
        if state.reversed {
            files.reverse();
        }
        Ok(files)
    }

    fn download(
        &self,
        folder: &str,
        key: &RemoteKey,
        version: &str,
        output: &mut dyn Write,
    ) -> Result<(), RemoteError> {
        check(folder, Some(key))?;
        let bytes = {
            let (state, _) = self.begin(RemoteOp::Download)?;
            let stored = state
                .folders
                .get(folder)
                .ok_or(RemoteError::FolderMissing)?;
            stored
                .files
                .get(key)
                .and_then(|file| file.revisions.iter().find(|r| r.version == version))
                .map(|revision| Arc::clone(&revision.bytes))
                .ok_or(RemoteError::NotFound)?
        };
        output
            .write_all(&bytes)
            .map_err(|_| RemoteError::Other("cannot write the downloaded bytes".into()))
    }

    fn write(
        &self,
        folder: &str,
        key: &RemoteKey,
        name: &str,
        expected: Option<&str>,
        content: &mut dyn RemoteContent,
    ) -> Result<RemoteFile, RemoteError> {
        check(folder, Some(key))?;
        let mut bytes = Vec::new();
        content
            .seek(SeekFrom::Start(0))
            .and_then(|_| content.read_to_end(&mut bytes))
            .map_err(|_| RemoteError::Other("cannot read the content to upload".into()))?;
        let (mut state, lost_response) = self.begin(RemoteOp::Write)?;
        let state = &mut *state;
        let stored = state
            .folders
            .get_mut(folder)
            .ok_or(RemoteError::FolderMissing)?;
        let current = stored.files.get(key).and_then(|file| fake_file(key, file));
        let unchanged = stored
            .files
            .get(key)
            .and_then(|file| file.revisions.last())
            .is_some_and(|revision| *revision.bytes == bytes);
        let result = if unchanged {
            current.ok_or(RemoteError::NotFound)?
        } else if current.as_ref().map(|file| file.version.as_str()) != expected {
            return Err(RemoteError::PreconditionFailed { current });
        } else {
            state.versions += 1;
            let file = stored.files.entry(key.clone()).or_insert_with(|| FakeFile {
                name: String::new(),
                revisions: Vec::new(),
            });
            file.name = name.into();
            file.revisions.push(FakeRevision {
                version: format!("v{}", state.versions),
                modified: state.now.clone(),
                bytes: Arc::new(bytes),
            });
            fake_file(key, file).ok_or(RemoteError::NotFound)?
        };
        match lost_response {
            Some(error) => Err(error),
            None => Ok(result),
        }
    }

    fn revisions(&self, folder: &str, key: &RemoteKey) -> Result<Vec<RemoteRevision>, RemoteError> {
        check(folder, Some(key))?;
        let (state, _) = self.begin(RemoteOp::Revisions)?;
        let stored = state
            .folders
            .get(folder)
            .ok_or(RemoteError::FolderMissing)?;
        let file = stored.files.get(key).ok_or(RemoteError::NotFound)?;
        Ok(file
            .revisions
            .iter()
            .map(|revision| RemoteRevision {
                version: revision.version.clone(),
                modified: revision.modified.clone(),
                size: revision.bytes.len() as u64,
            })
            .collect())
    }
}
