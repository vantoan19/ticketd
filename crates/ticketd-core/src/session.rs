//! One warm Workspace session per Workspace file per process ([ADR 0016]).
//!
//! A long-running process (the desktop, and the Chat host and Automation runner inside
//! it) uses the Workspace through its session instead of opening it per command. The
//! session keeps the connections it opened, checks and configured, and lends one out per
//! use; it keeps the file in WAL mode, so a reader and a writer do not wait for each
//! other. A kept connection holds the shared Workspace lock, as every open Workspace
//! does, and lets go of it when an exclusive acquirer in another process asks: see
//! [`lock_exclusive`]. Work in this process that replaces the file goes through
//! [`WorkspaceSession::exclusive`].
//!
//! The CLI opens a [`Workspace`] once per invocation and does not use a session.
//!
//! [ADR 0016]: ../../docs/adr/0016-one-warm-workspace-session-per-process-wal-inside-it.md

use std::{
    collections::BTreeMap,
    fs::{self, File},
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak},
    time::{Duration, Instant, SystemTime},
};

use fs2::FileExt;
use rusqlite::Connection;

use crate::{Error, OPEN_WORKSPACES_WAIT, Workspace, backup, document_links};

/// Connection setup shared by every connection the core opens: the Workspace's own
/// opens, and the raw ones that read or write backups and snapshots.
pub(crate) fn configure(connection: &Connection) -> Result<(), Error> {
    document_links::register_heading_function(connection)?;
    connection.busy_timeout(Duration::from_secs(10))?;
    // Room for every statement hydrating a ticket at once (the default is 16),
    // so a list does not evict and re-prepare them per ticket.
    connection.set_prepared_statement_cache_capacity(64);
    Ok(())
}

/// Leaves the file a single file in rollback-journal mode: everything committed is
/// checkpointed into it and the journal mode no longer names a `-wal`. Called before a
/// file is swapped and on every snapshot written, so a backup stays one file.
pub(crate) fn single_file(connection: &Connection) -> Result<(), Error> {
    connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    connection.pragma_update_and_check(None, "journal_mode", "DELETE", |_| Ok(()))?;
    Ok(())
}

/// Removes a `-wal` and `-shm` left beside `workspace`. Called under the exclusive lock
/// right before the file is swapped: SQLite would replay a leftover WAL into the file
/// that replaces it.
pub(crate) fn remove_wal_files(workspace: &Path) -> Result<(), Error> {
    for suffix in ["-wal", "-shm"] {
        match fs::remove_file(sibling(workspace, suffix)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.into());
            }
            _ => {}
        }
    }
    Ok(())
}

fn sibling(workspace: &Path, suffix: &str) -> PathBuf {
    let mut name = workspace.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// How long a restore waits for warm sessions elsewhere to let go: their one-second
/// look at the marker, with room for a use under way to finish.
pub(crate) const RELEASE_WAIT: Duration = Duration::from_secs(2);
/// How often an idle session looks for a release request.
const RELEASE_LOOK: Duration = Duration::from_secs(1);
/// A marker older than any acquirer waits was left by one that died; it is ignored.
const STALE_RELEASE: Duration = Duration::from_secs(15);
/// Idle connections a session keeps; more are opened while uses overlap.
const IDLE_CONNECTIONS: usize = 4;

/// The marker an exclusive acquirer writes beside the Workspace while it waits, so warm
/// sessions in other processes close their connections. Removed when dropped.
pub(crate) struct ReleaseRequest(PathBuf);

impl ReleaseRequest {
    pub(crate) fn new(workspace: &Path) -> Result<Self, Error> {
        let marker = sibling(&backup::resolve(workspace)?, ".release-requested");
        fs::write(&marker, b"")?;
        Ok(Self(marker))
    }
}

impl Drop for ReleaseRequest {
    fn drop(&mut self) {
        // A marker that stays behind goes stale and is ignored.
        let _ = fs::remove_file(&self.0);
    }
}

/// Whether an exclusive acquirer is waiting for the Workspace at `workspace`, which is
/// already resolved.
pub(crate) fn release_requested(workspace: &Path) -> bool {
    fs::metadata(sibling(workspace, ".release-requested"))
        .and_then(|marker| marker.modified())
        .is_ok_and(|written| {
            SystemTime::now()
                .duration_since(written)
                .is_ok_and(|age| age < STALE_RELEASE)
        })
}

/// The exclusive lock on the Workspace at `workspace`, for a restore. While it is held
/// elsewhere, a release request asks warm sessions to let go, for up to `wait`.
pub(crate) fn lock_exclusive(workspace: &Path, wait: Duration) -> Result<File, Error> {
    let lock = backup::lock_file(workspace)?;
    let deadline = Instant::now() + wait;
    let mut request = None;
    loop {
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => return Ok(lock),
            Err(source) if source.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                if Instant::now() >= deadline {
                    return Err(Error::RestoreLock { source });
                }
                if request.is_none() {
                    request = Some(ReleaseRequest::new(workspace)?);
                    WorkspaceSession::release_here(&backup::resolve(workspace)?);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(source) => return Err(Error::Directory(source)),
        }
    }
}

/// What a kept connection was opened against: a schema changed since by another
/// connection (a newer ticketd migrating the file) sends the next use through the
/// open checks again.
fn schema(connection: &Connection) -> Result<(i64, i64), Error> {
    Ok(connection
        .prepare_cached(
            "SELECT schema_version, user_version FROM pragma_schema_version, pragma_user_version",
        )?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))?)
}

struct Warm {
    workspace: Workspace,
    schema: (i64, i64),
}

#[derive(Default)]
struct State {
    idle: Vec<Warm>,
    in_use: usize,
    exclusive: bool,
}

/// The Workspace file of one long-running process, kept open between uses.
pub struct WorkspaceSession {
    /// As the caller named it, for opens and what they report.
    path: PathBuf,
    /// With links followed: the file this session is the one session of.
    resolved: PathBuf,
    state: Mutex<State>,
    changed: Condvar,
}

/// The sessions of this process, one per Workspace file.
static SESSIONS: Mutex<BTreeMap<PathBuf, Weak<WorkspaceSession>>> = Mutex::new(BTreeMap::new());

impl WorkspaceSession {
    /// The session of the existing Workspace file at `path`, shared by every caller in
    /// this process. It never creates the file: a missing one fails each use.
    pub fn for_file(path: impl AsRef<Path>) -> Result<Arc<Self>, Error> {
        let path = path.as_ref();
        let resolved = path
            .canonicalize()
            .map_err(|source| Error::WorkspaceUnavailable {
                path: path.to_path_buf(),
                source: Box::new(source.into()),
            })?;
        let mut sessions = SESSIONS.lock().unwrap_or_else(PoisonError::into_inner);
        sessions.retain(|_, session| session.strong_count() > 0);
        if let Some(session) = sessions.get(&resolved).and_then(Weak::upgrade) {
            return Ok(session);
        }
        let session = Arc::new(Self {
            path: path.to_path_buf(),
            resolved: resolved.clone(),
            state: Mutex::default(),
            changed: Condvar::new(),
        });
        sessions.insert(resolved, Arc::downgrade(&session));
        Self::watch(Arc::downgrade(&session));
        Ok(session)
    }

    /// The Workspace for one use, given back when the guard drops. Waits while
    /// [`WorkspaceSession::exclusive`] work runs.
    pub fn workspace(self: &Arc<Self>) -> Result<WorkspaceGuard, Error> {
        let (kept, released) = {
            let mut state = self.lock();
            while state.exclusive {
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            let released = if release_requested(&self.resolved) {
                std::mem::take(&mut state.idle)
            } else {
                Vec::new()
            };
            state.in_use += 1;
            (state.idle.pop(), released)
        };
        // Closed outside the lock: closing checkpoints the WAL.
        drop(released);
        let mut guard = WorkspaceGuard {
            session: Arc::clone(self),
            warm: None,
        };
        let warm = match kept {
            Some(warm) if self.unchanged(&warm) => warm,
            _ => self.open()?,
        };
        guard.warm = Some(warm);
        Ok(guard)
    }

    /// Several reads in one snapshot; see [`Workspace::read`].
    pub fn read<T>(
        self: &Arc<Self>,
        read: impl FnOnce(&Workspace) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.workspace()?.read(read)
    }

    /// One use that may write.
    pub fn write<T>(
        self: &Arc<Self>,
        write: impl FnOnce(&mut Workspace) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut workspace = self.workspace()?;
        write(&mut workspace)
    }

    /// Runs `work` with no connection of this session open, for work in this process
    /// that replaces the file (a restore, a Drive download). Waits for uses under way to
    /// end, and holds new ones until `work` returns. `work` takes the Workspace's
    /// exclusive lock itself, which asks other processes to let go.
    ///
    /// Never call it while holding a guard of this session: it would wait out its bound
    /// for that guard and fail as in use.
    pub fn exclusive<T>(&self, work: impl FnOnce(&Path) -> Result<T, Error>) -> Result<T, Error> {
        let idle = {
            let mut state = self.lock();
            let deadline = Instant::now() + OPEN_WORKSPACES_WAIT;
            while state.exclusive || state.in_use > 0 {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(Error::RestoreLock {
                        source: std::io::ErrorKind::WouldBlock.into(),
                    });
                }
                state = self
                    .changed
                    .wait_timeout(state, left)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
            state.exclusive = true;
            std::mem::take(&mut state.idle)
        };
        drop(idle);
        let _end = ExclusiveEnd(self);
        work(&self.path)
    }

    /// Lets go of the idle connections of this process's session on `resolved`, if it
    /// has one, without waiting for its tick.
    fn release_here(resolved: &Path) {
        let session = SESSIONS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(resolved)
            .and_then(Weak::upgrade);
        if let Some(session) = session {
            let idle = std::mem::take(&mut session.lock().idle);
            drop(idle);
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn unchanged(&self, warm: &Warm) -> bool {
        // A file moved away under a kept connection would otherwise go on being used.
        self.path.exists()
            && schema(&warm.workspace.connection).is_ok_and(|schema| schema == warm.schema)
    }

    fn open(&self) -> Result<Warm, Error> {
        let workspace = Workspace::open_existing(&self.path)?;
        let connection = &workspace.connection;
        // Durability stays as in rollback mode: every commit is synced.
        connection.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        let schema = schema(connection)?;
        Ok(Warm { workspace, schema })
    }

    fn give_back(&self, warm: Option<Warm>) {
        let mut state = self.lock();
        state.in_use -= 1;
        let dropped = match warm {
            Some(warm)
                if !state.exclusive
                    && state.idle.len() < IDLE_CONNECTIONS
                    && warm.workspace.connection.is_autocommit()
                    && !release_requested(&self.resolved) =>
            {
                state.idle.push(warm);
                None
            }
            other => other,
        };
        drop(state);
        self.changed.notify_all();
        drop(dropped);
    }

    /// Lets go of idle connections within a second of a release request, until the
    /// session is dropped.
    fn watch(session: Weak<Self>) {
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(RELEASE_LOOK);
                let Some(session) = session.upgrade() else {
                    return;
                };
                if release_requested(&session.resolved) {
                    let idle = std::mem::take(&mut session.lock().idle);
                    drop(idle);
                }
            }
        });
    }
}

struct ExclusiveEnd<'a>(&'a WorkspaceSession);

impl Drop for ExclusiveEnd<'_> {
    fn drop(&mut self) {
        self.0.lock().exclusive = false;
        self.0.changed.notify_all();
    }
}

/// One use of a session's Workspace. Derefs to the [`Workspace`].
pub struct WorkspaceGuard {
    session: Arc<WorkspaceSession>,
    warm: Option<Warm>,
}

impl Deref for WorkspaceGuard {
    type Target = Workspace;

    fn deref(&self) -> &Workspace {
        match &self.warm {
            Some(warm) => &warm.workspace,
            None => unreachable!("a guard is handed out only with its Workspace"),
        }
    }
}

impl DerefMut for WorkspaceGuard {
    fn deref_mut(&mut self) -> &mut Workspace {
        match &mut self.warm {
            Some(warm) => &mut warm.workspace,
            None => unreachable!("a guard is handed out only with its Workspace"),
        }
    }
}

impl Drop for WorkspaceGuard {
    fn drop(&mut self) {
        self.session.give_back(self.warm.take());
    }
}

impl std::borrow::Borrow<Workspace> for WorkspaceGuard {
    fn borrow(&self) -> &Workspace {
        self
    }
}

impl std::borrow::BorrowMut<Workspace> for WorkspaceGuard {
    fn borrow_mut(&mut self) -> &mut Workspace {
        self
    }
}
