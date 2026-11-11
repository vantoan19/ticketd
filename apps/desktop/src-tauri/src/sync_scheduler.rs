//! Decides when the desktop runs Workspace sync: at launch and when a
//! connection appears, on a poll, shortly after a local change, on request and
//! once more on exit. Time is passed in and the storage comes from the
//! binding, so none of it needs a clock or a network to be exercised.

use std::{
    sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc},
    time::{Duration, Instant},
};

use ticketd_core::{
    Error, Workspace,
    sync::{MIN_POLL_INTERVAL_SECS, SyncItem, SyncStatus, remote::RemoteStorage},
};

/// How long after the last local change its upload starts.
const UPLOAD_DELAY: Duration = Duration::from_secs(3);
/// How long quitting waits for the last upload.
pub const EXIT_LIMIT: Duration = Duration::from_secs(10);

/// What this Workspace syncs with, read from the Workspace before every use.
#[derive(Clone)]
pub struct Binding {
    /// The Workspace folder identifier in the storage.
    pub folder: String,
    /// This desktop's name, as other desktops show it.
    pub device: String,
    pub poll: Duration,
    pub remote: Arc<dyn RemoteStorage>,
}

type Open = dyn Fn() -> Result<Workspace, Error> + Send + Sync;
/// `None` while the Workspace is not connected to a folder.
type Bound = dyn Fn() -> Result<Option<Binding>, Error> + Send + Sync;
/// A sync workflow of the core: an ordinary run, or the recovery action.
type Run = fn(&mut Workspace, &dyn RemoteStorage) -> Result<SyncStatus, Error>;

#[derive(Default)]
struct Watch {
    /// A run was attempted since the connection appeared.
    connected: bool,
    poll_at: Duration,
    upload_at: Option<Duration>,
    /// The newest local change already counted towards an upload.
    seen_mark: i64,
}

pub struct Scheduler {
    open: Box<Open>,
    binding: Box<Bound>,
    watch: Mutex<Watch>,
    /// Held for the length of a run, so two never overlap.
    running: Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Scheduler {
    pub fn new(open: Box<Open>, binding: Box<Bound>) -> Self {
        Self {
            open,
            binding,
            watch: Mutex::default(),
            running: Mutex::default(),
        }
    }

    pub fn binding(&self) -> Result<Option<Binding>, Error> {
        (self.binding)()
    }

    /// Keeps sync from running while the caller replaces the Workspace file;
    /// waits for a run in progress.
    pub fn hold(&self) -> MutexGuard<'_, ()> {
        lock(&self.running)
    }

    /// Runs sync if one is due at `now` (time since the app started). `None`
    /// when nothing was due, the Workspace is not connected, or a run is
    /// already in progress. A run the storage refused is not repeated before
    /// the next poll or local change.
    pub fn tick(&self, now: Duration) -> Result<Option<SyncStatus>, Error> {
        let Some(binding) = self.binding()? else {
            // The next connection starts with a run.
            *lock(&self.watch) = Watch::default();
            return Ok(None);
        };
        let latest = (self.open)()?
            .dirty_records()?
            .iter()
            .map(|record| record.mark)
            .max()
            .unwrap_or(0);
        let due = {
            let mut watch = lock(&self.watch);
            if latest > watch.seen_mark {
                // Each further change moves the upload later, so a burst uploads once.
                watch.seen_mark = latest;
                watch.upload_at = Some(now + UPLOAD_DELAY);
            }
            !watch.connected || now >= watch.poll_at || watch.upload_at.is_some_and(|at| now >= at)
        };
        if !due {
            return Ok(None);
        }
        let Ok(_running) = self.running.try_lock() else {
            return Ok(None);
        };
        self.run(&binding, now, Workspace::sync_now).map(Some)
    }

    /// Sync now: waits for a run in progress, then runs. `None` when not connected.
    pub fn sync_now(&self, now: Duration) -> Result<Option<SyncStatus>, Error> {
        self.exclusive(now, Workspace::sync_now)
    }

    /// The corrective action of the current recovery state, then a run.
    pub fn recover(&self, now: Duration) -> Result<Option<SyncStatus>, Error> {
        self.exclusive(now, Workspace::sync_recover)
    }

    fn exclusive(&self, now: Duration, run: Run) -> Result<Option<SyncStatus>, Error> {
        let Some(binding) = self.binding()? else {
            return Ok(None);
        };
        let _running = lock(&self.running);
        self.run(&binding, now, run).map(Some)
    }

    fn run(&self, binding: &Binding, now: Duration, run: Run) -> Result<SyncStatus, Error> {
        // The Workspace is opened for this run alone; its writes are short
        // transactions, so other commands are not held up by the network.
        let result =
            (self.open)().and_then(|mut workspace| run(&mut workspace, binding.remote.as_ref()));
        let mut watch = lock(&self.watch);
        watch.connected = true;
        watch.upload_at = None;
        let least = Duration::from_secs(MIN_POLL_INTERVAL_SECS);
        watch.poll_at = now + binding.poll.max(least);
        result
    }

    /// One last run before quitting, given `limit` to finish. Returns what is
    /// still waiting to upload: empty when everything reached the storage or
    /// the Workspace does not sync. A failed upload is reported the same way.
    pub fn flush(self: &Arc<Self>, now: Duration, limit: Duration) -> Result<Vec<SyncItem>, Error> {
        let Some(binding) = self.binding()? else {
            return Ok(Vec::new());
        };
        let (done, finished) = mpsc::channel();
        let scheduler = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("workspace-sync-exit".into())
            .spawn(move || {
                let _running = lock(&scheduler.running);
                let _ = scheduler.run(&binding, now, Workspace::sync_now);
                let _ = done.send(());
            });
        if spawned.is_ok() {
            let _ = finished.recv_timeout(limit);
        }
        Ok((self.open)()?.sync_status()?.pending_uploads)
    }

    /// Starts sync for as long as the app runs: `at_launch` once, then asks
    /// every second whether a run is due.
    pub fn start(self: Arc<Self>, started: Instant, at_launch: impl FnOnce() + Send + 'static) {
        let spawned = std::thread::Builder::new()
            .name("workspace-sync".into())
            .spawn(move || {
                at_launch();
                // Said once on stderr, and again only if it changes or comes back.
                let mut reported: Option<String> = None;
                loop {
                    match self.tick(started.elapsed()) {
                        Ok(_) => reported = None,
                        Err(error) => {
                            let message = error.to_string();
                            if reported.as_deref() != Some(message.as_str()) {
                                eprintln!("Workspace sync could not run: {message}");
                                reported = Some(message);
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            });
        if let Err(error) = spawned {
            eprintln!("could not start Workspace sync: {error}");
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Setup that fails must fail the test.
mod tests {
    use super::*;
    use std::io::Write;
    use ticketd_core::{
        TicketPatch,
        sync::{
            SyncRecovery,
            remote::{
                FakeRemote, RemoteContent, RemoteError, RemoteFile, RemoteFolder, RemoteKey,
                RemoteOp, RemoteRevision,
            },
        },
    };

    const SECOND: Duration = Duration::from_secs(1);
    const MINUTE: Duration = Duration::from_secs(60);

    /// A fake storage whose listing waits until the test lets it through.
    struct Gated {
        inner: FakeRemote,
        gate: Mutex<mpsc::Receiver<()>>,
        entered: Mutex<mpsc::Sender<()>>,
    }

    impl RemoteStorage for Gated {
        fn folders(&self) -> Result<Vec<RemoteFolder>, RemoteError> {
            self.inner.folders()
        }
        fn ensure_folder(&self, folder: &str, name: &str) -> Result<(), RemoteError> {
            self.inner.ensure_folder(folder, name)
        }
        fn list(&self, folder: &str) -> Result<Vec<RemoteFile>, RemoteError> {
            let _ = lock(&self.entered).send(());
            // Returns when the test sends or drops its end.
            let _ = lock(&self.gate).recv();
            self.inner.list(folder)
        }
        fn download(
            &self,
            folder: &str,
            key: &RemoteKey,
            version: &str,
            output: &mut dyn Write,
        ) -> Result<(), RemoteError> {
            self.inner.download(folder, key, version, output)
        }
        fn write(
            &self,
            folder: &str,
            key: &RemoteKey,
            name: &str,
            expected: Option<&str>,
            content: &mut dyn RemoteContent,
        ) -> Result<RemoteFile, RemoteError> {
            self.inner.write(folder, key, name, expected, content)
        }
        fn revisions(
            &self,
            folder: &str,
            key: &RemoteKey,
        ) -> Result<Vec<RemoteRevision>, RemoteError> {
            self.inner.revisions(folder, key)
        }
    }

    struct Desk {
        _directory: tempfile::TempDir,
        remote: FakeRemote,
        scheduler: Arc<Scheduler>,
        bound: Arc<Mutex<Option<Binding>>>,
        path: std::path::PathBuf,
        folder: String,
    }

    impl Desk {
        fn workspace(&self) -> Workspace {
            Workspace::open(&self.path).unwrap()
        }
        fn bind(&self, binding: Option<Binding>) {
            *lock(&self.bound) = binding;
        }
        fn binding(&self, poll: Duration) -> Binding {
            Binding {
                folder: self.folder.clone(),
                device: "Desk A".into(),
                poll,
                remote: Arc::new(self.remote.clone()),
            }
        }
        fn pending(&self) -> usize {
            self.workspace()
                .sync_status()
                .unwrap()
                .pending_uploads
                .len()
        }
    }

    /// A desktop connected to a folder, with one ticket not yet uploaded.
    fn desk() -> Desk {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.sqlite3");
        let remote = FakeRemote::new();
        let mut workspace = Workspace::open(&path).unwrap();
        workspace.create_ticket("First").unwrap();
        workspace
            .sync_connect("connection", "mina@example.com")
            .unwrap();
        let status = workspace.sync_upload_workspace(&remote, "Test").unwrap();
        let bound = Arc::new(Mutex::new(None));
        let (open_path, source) = (path.clone(), Arc::clone(&bound));
        let scheduler = Arc::new(Scheduler::new(
            Box::new(move || Workspace::open(&open_path)),
            Box::new(move || Ok(lock(&source).clone())),
        ));
        let desk = Desk {
            _directory: directory,
            remote,
            scheduler,
            bound,
            path,
            folder: status.folder.unwrap().id,
        };
        desk.bind(Some(desk.binding(MINUTE)));
        desk
    }

    #[test]
    fn runs_at_launch_and_again_when_the_connection_returns() {
        let desk = desk();
        assert_eq!(desk.pending(), 1);
        let status = desk.scheduler.tick(Duration::ZERO).unwrap().unwrap();
        assert_eq!(status.pending_uploads, []);
        assert!(status.last_synced_at.is_some());
        assert_eq!(desk.scheduler.tick(SECOND).unwrap(), None);

        desk.bind(None);
        assert_eq!(desk.scheduler.tick(2 * SECOND).unwrap(), None);
        desk.bind(Some(desk.binding(MINUTE)));
        assert!(desk.scheduler.tick(3 * SECOND).unwrap().is_some());
    }

    #[test]
    fn polls_at_the_set_interval_and_never_faster_than_thirty_seconds() {
        let desk = desk();
        assert!(desk.scheduler.tick(Duration::ZERO).unwrap().is_some());
        assert_eq!(desk.scheduler.tick(59 * SECOND).unwrap(), None);
        assert!(desk.scheduler.tick(60 * SECOND).unwrap().is_some());

        // The interval is read again for every run.
        desk.bind(Some(desk.binding(5 * SECOND)));
        assert!(desk.scheduler.sync_now(100 * SECOND).unwrap().is_some());
        assert_eq!(desk.scheduler.tick(129 * SECOND).unwrap(), None);
        assert!(desk.scheduler.tick(130 * SECOND).unwrap().is_some());
    }

    #[test]
    fn uploads_once_a_few_seconds_after_the_last_local_change() {
        let desk = desk();
        desk.scheduler.tick(Duration::ZERO).unwrap();

        let ticket = desk.workspace().create_ticket("Second").unwrap();
        assert_eq!(desk.scheduler.tick(SECOND).unwrap(), None);
        let patch = TicketPatch {
            title: Some("Second, renamed".into()),
            ..Default::default()
        };
        desk.workspace()
            .change_ticket(&ticket.reference, patch)
            .unwrap();
        // The second change restarts the wait that began at one second.
        assert_eq!(desk.scheduler.tick(3 * SECOND).unwrap(), None);
        assert_eq!(desk.scheduler.tick(5 * SECOND).unwrap(), None);
        assert_eq!(desk.pending(), 1);
        let status = desk.scheduler.tick(6 * SECOND).unwrap().unwrap();
        assert_eq!(status.pending_uploads, []);
        assert_eq!(desk.scheduler.tick(7 * SECOND).unwrap(), None);
    }

    #[test]
    fn a_refused_run_is_recorded_and_waits_for_the_next_poll() {
        let desk = desk();
        desk.remote.fail(RemoteOp::List, 1, RemoteError::Offline);
        let status = desk.scheduler.tick(Duration::ZERO).unwrap().unwrap();
        assert_eq!(status.recovery, Some(SyncRecovery::Offline));
        assert_eq!(desk.scheduler.tick(10 * SECOND).unwrap(), None);
        let status = desk.scheduler.tick(60 * SECOND).unwrap().unwrap();
        assert_eq!((status.recovery, status.pending_uploads.len()), (None, 0));
    }

    #[test]
    fn sync_now_runs_at_once_and_does_nothing_when_not_connected() {
        let desk = desk();
        desk.scheduler.tick(Duration::ZERO).unwrap();
        desk.workspace().create_ticket("Second").unwrap();
        let status = desk.scheduler.sync_now(SECOND).unwrap().unwrap();
        assert_eq!(status.pending_uploads, []);

        desk.bind(None);
        assert_eq!(desk.scheduler.sync_now(2 * SECOND).unwrap(), None);
    }

    #[test]
    fn recovering_from_a_missing_folder_uploads_the_workspace_again() {
        let desk = desk();
        desk.scheduler.tick(Duration::ZERO).unwrap();
        desk.remote.remove_folder(&desk.folder);
        let status = desk.scheduler.sync_now(SECOND).unwrap().unwrap();
        assert_eq!(status.recovery, Some(SyncRecovery::FolderMissing));

        let status = desk.scheduler.recover(2 * SECOND).unwrap().unwrap();
        assert_eq!((status.recovery, status.pending_uploads.len()), (None, 0));
        assert!(!desk.remote.list(&desk.folder).unwrap().is_empty());
    }

    /// Binds the desk to a storage that holds every listing until the returned
    /// sender is dropped; the receiver tells when a run reached it.
    fn gate(desk: &Desk) -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
        let (open, gate) = mpsc::channel();
        let (entered, reached) = mpsc::channel();
        desk.bind(Some(Binding {
            remote: Arc::new(Gated {
                inner: desk.remote.clone(),
                gate: Mutex::new(gate),
                entered: Mutex::new(entered),
            }),
            ..desk.binding(MINUTE)
        }));
        (open, reached)
    }

    #[test]
    fn a_run_in_progress_is_never_joined_by_a_second_one() {
        let desk = desk();
        let (open, reached) = gate(&desk);
        let scheduler = Arc::clone(&desk.scheduler);
        let first = std::thread::spawn(move || scheduler.sync_now(Duration::ZERO));
        reached.recv().unwrap();

        // Due, but the first run still holds the storage.
        assert_eq!(desk.scheduler.tick(61 * SECOND).unwrap(), None);
        drop(open);
        let status = first.join().unwrap().unwrap().unwrap();
        assert_eq!(status.pending_uploads, []);
    }

    #[test]
    fn the_exit_flush_uploads_what_is_pending() {
        let desk = desk();
        let pending = desk.scheduler.flush(Duration::ZERO, EXIT_LIMIT).unwrap();
        assert_eq!(pending, []);
        assert!(!desk.remote.list(&desk.folder).unwrap().is_empty());
    }

    #[test]
    fn the_exit_flush_stops_waiting_at_its_limit_and_reports_what_is_left() {
        let desk = desk();
        let (open, reached) = gate(&desk);
        let pending = desk
            .scheduler
            .flush(Duration::ZERO, Duration::ZERO)
            .unwrap();
        let titles: Vec<_> = pending.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(titles, ["First"]);

        // Let the abandoned run end before the Workspace file goes away.
        reached.recv().unwrap();
        drop(open);
        drop(desk.scheduler.hold());
    }

    #[test]
    fn the_exit_flush_reports_a_failed_upload_as_pending_and_nothing_when_not_connected() {
        let desk = desk();
        desk.remote.fail(RemoteOp::List, 1, RemoteError::Offline);
        let pending = desk.scheduler.flush(Duration::ZERO, EXIT_LIMIT).unwrap();
        assert_eq!(pending.len(), 1);

        desk.bind(None);
        assert_eq!(
            desk.scheduler.flush(Duration::ZERO, EXIT_LIMIT).unwrap(),
            []
        );
    }
}
