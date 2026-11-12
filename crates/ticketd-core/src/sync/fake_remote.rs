//! The in-memory [`RemoteStorage`] that sync tests run against, with failure
//! injection. Built only with the `fake-remote` feature, so no application
//! carries it.
use std::collections::BTreeMap;
use std::io::{SeekFrom, Write};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::remote::{
    RemoteContent, RemoteError, RemoteFile, RemoteFolder, RemoteKey, RemoteRevision, RemoteStorage,
    invalid_identifier, valid_identifier,
};

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
    /// The storage's identity of this file; a key can be written again as another file.
    id: String,
    /// The clock when the file was made.
    created: String,
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
    unseen: Vec<(RemoteKey, Vec<u8>)>,
    removed: Vec<(String, RemoteKey, FakeFile)>,
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
            unseen: Vec::new(),
            removed: Vec::new(),
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

    /// Another device's write of `key` lands just before the next update of it,
    /// after that update's version check passed: the update still succeeds and
    /// `content` is left only as the revision before it.
    pub fn write_unseen_before_next_update(&self, key: &RemoteKey, content: &[u8]) {
        self.state().unseen.push((key.clone(), content.to_vec()));
    }

    /// The folder and its files disappear, as when the person deletes it in the storage.
    pub fn remove_folder(&self, folder: &str) {
        self.state().folders.remove(folder);
    }

    /// One file disappears with its revisions, as when it is moved to the
    /// storage's trash. Returns whether it existed.
    pub fn remove_file(&self, folder: &str, key: &RemoteKey) -> bool {
        let mut state = self.state();
        let removed = state
            .folders
            .get_mut(folder)
            .and_then(|stored| stored.files.remove(key));
        let existed = removed.is_some();
        state
            .removed
            .extend(removed.map(|file| (folder.to_owned(), key.clone(), file)));
        existed
    }

    /// A removed file comes back, as when it is restored from the storage's
    /// trash. It is older than a file written for the key meanwhile, so it is
    /// the one listed from now on. Returns whether a removed file existed.
    pub fn restore_file(&self, folder: &str, key: &RemoteKey) -> bool {
        let mut state = self.state();
        let Some(index) = state
            .removed
            .iter()
            .position(|(f, k, _)| f == folder && k == key)
        else {
            return false;
        };
        let (_, _, file) = state.removed.remove(index);
        match state.folders.get_mut(folder) {
            Some(stored) => {
                stored.files.insert(key.clone(), file);
                true
            }
            None => false,
        }
    }

    /// The time stamped on files made and revisions written from now on (RFC 3339).
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
        file_id: file.id.clone(),
        created: file.created.clone(),
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
            let id = format!("file-{}", state.versions);
            let created = state.now.clone();
            let file = stored.files.entry(key.clone()).or_insert_with(|| FakeFile {
                created,
                id,
                name: String::new(),
                revisions: Vec::new(),
            });
            file.name = name.into();
            if let Some(index) = state.unseen.iter().position(|(unseen, _)| unseen == key) {
                file.revisions.push(FakeRevision {
                    version: format!("v{}", state.versions),
                    modified: state.now.clone(),
                    bytes: Arc::new(state.unseen.remove(index).1),
                });
                state.versions += 1;
            }
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
