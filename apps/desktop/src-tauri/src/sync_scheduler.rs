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
    sync::{DirtyRecord, SyncReport, remote::RemoteStorage},
};

/// How often Drive is checked for changes unless the person chose otherwise.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the binding uses it once a Workspace can connect")
)]
pub const DEFAULT_POLL: Duration = Duration::from_secs(60);
/// The shortest poll a setting may ask for.
pub const MIN_POLL: Duration = Duration::from_secs(30);
/// How long after the last local change its upload starts.
const UPLOAD_DELAY: Duration = Duration::from_secs(3);
/// How long quitting waits for the last upload.
pub const EXIT_LIMIT: Duration = Duration::from_secs(10);

/// What this Workspace syncs with. Everything that syncs reads it from one place.
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
/// `None` while the Workspace is not connected.
type Bound = dyn Fn() -> Result<Option<Binding>, Error> + Send + Sync;

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

    /// Runs sync if one is due at `now` (time since the app started). `None`
    /// when nothing was due, the Workspace is not connected, or a run is
    /// already in progress. A failed run is not repeated before the next poll
    /// or local change.
    pub fn tick(&self, now: Duration) -> Result<Option<SyncReport>, Error> {
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
        self.run(&binding, now).map(Some)
    }

    /// Sync now: waits for a run in progress, then runs. `None` when not connected.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "its command answers with the sync status, which is not built yet"
        )
    )]
    pub fn sync_now(&self, now: Duration) -> Result<Option<SyncReport>, Error> {
        let Some(binding) = self.binding()? else {
            return Ok(None);
        };
        let _running = lock(&self.running);
        self.run(&binding, now).map(Some)
    }

    fn run(&self, binding: &Binding, now: Duration) -> Result<SyncReport, Error> {
        // The Workspace is opened for this run alone; its writes are short
        // transactions, so other commands are not held up by the network.
        let result = (self.open)().and_then(|mut workspace| {
            workspace.sync(binding.remote.as_ref(), &binding.folder, &binding.device)
        });
        let mut watch = lock(&self.watch);
        watch.connected = true;
        watch.upload_at = None;
        watch.poll_at = now + binding.poll.max(MIN_POLL);
        result
    }

    /// One last run before quitting, given `limit` to finish. Returns what is
    /// still waiting to upload: empty when everything reached the storage or
    /// the Workspace does not sync. A failed upload is reported the same way.
    pub fn flush(
        self: &Arc<Self>,
        now: Duration,
        limit: Duration,
    ) -> Result<Vec<DirtyRecord>, Error> {
        let Some(binding) = self.binding()? else {
            return Ok(Vec::new());
        };
        let (done, finished) = mpsc::channel();
        let scheduler = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("workspace-sync-exit".into())
            .spawn(move || {
                let _running = lock(&scheduler.running);
                let _ = scheduler.run(&binding, now);
                let _ = done.send(());
            });
        if spawned.is_ok() {
            let _ = finished.recv_timeout(limit);
        }
        (self.open)()?.dirty_records()
    }

    /// Starts sync for as long as the app runs: expires old History once, then
    /// asks every second whether a run is due.
    pub fn start(self: Arc<Self>, started: Instant) {
        let spawned = std::thread::Builder::new()
            .name("workspace-sync".into())
            .spawn(move || {
                if let Err(error) =
                    (self.open)().and_then(|mut workspace| workspace.expire_versions(None))
                {
                    eprintln!("could not expire old versions: {error}");
                }
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
pub(crate) mod tests {
    use super::*;
    use std::io::Write;
    use ticketd_core::{
        TicketPatch,
        sync::remote::{
            FakeRemote, RemoteContent, RemoteError, RemoteFile, RemoteFolder, RemoteKey, RemoteOp,
            RemoteRevision,
        },
    };

    pub(crate) const FOLDER: &str = "workspace";
    const SECOND: Duration = Duration::from_secs(1);

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

    pub(crate) struct Desk {
        _directory: tempfile::TempDir,
        pub remote: FakeRemote,
        pub scheduler: Arc<Scheduler>,
        bound: Arc<Mutex<Option<Binding>>>,
        path: std::path::PathBuf,
    }

    impl Desk {
        pub fn workspace(&self) -> Workspace {
            Workspace::open(&self.path).unwrap()
        }
        fn bind(&self, binding: Option<Binding>) {
            *lock(&self.bound) = binding;
        }
        fn binding(&self, poll: Duration) -> Binding {
            Binding {
                folder: FOLDER.into(),
                device: "Desk A".into(),
                poll,
                remote: Arc::new(self.remote.clone()),
            }
        }
        fn uploads(&self) -> usize {
            let writes = |calls: Vec<RemoteOp>| {
                calls
                    .into_iter()
                    .filter(|op| *op == RemoteOp::Write)
                    .count()
            };
            writes(self.remote.calls())
        }
    }

    /// A connected desktop with one ticket not yet uploaded.
    pub(crate) fn desk() -> Desk {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.sqlite3");
        Workspace::open(&path)
            .unwrap()
            .create_ticket("First")
            .unwrap();
        let remote = FakeRemote::new();
        remote.ensure_folder(FOLDER, "Test").unwrap();
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
        };
        desk.bind(Some(desk.binding(DEFAULT_POLL)));
        desk
    }

    #[test]
    fn runs_at_launch_and_again_when_the_connection_returns() {
        let desk = desk();
        let report = desk.scheduler.tick(Duration::ZERO).unwrap().unwrap();
        assert_eq!(report.uploaded, 1);
        assert_eq!(desk.scheduler.tick(SECOND).unwrap(), None);

        desk.bind(None);
        assert_eq!(desk.scheduler.tick(2 * SECOND).unwrap(), None);
        desk.bind(Some(desk.binding(DEFAULT_POLL)));
        assert!(desk.scheduler.tick(3 * SECOND).unwrap().is_some());
    }

    #[test]
    fn polls_every_minute_by_default_and_never_faster_than_thirty_seconds() {
        let desk = desk();
        assert!(desk.scheduler.tick(Duration::ZERO).unwrap().is_some());
        assert_eq!(desk.scheduler.tick(59 * SECOND).unwrap(), None);
        assert!(desk.scheduler.tick(60 * SECOND).unwrap().is_some());

        desk.bind(Some(desk.binding(5 * SECOND)));
        assert!(desk.scheduler.sync_now(100 * SECOND).unwrap().is_some());
        assert_eq!(desk.scheduler.tick(129 * SECOND).unwrap(), None);
        assert!(desk.scheduler.tick(130 * SECOND).unwrap().is_some());
    }

    #[test]
    fn uploads_once_a_few_seconds_after_the_last_local_change() {
        let desk = desk();
        desk.scheduler.tick(Duration::ZERO).unwrap();
        let uploaded = desk.uploads();

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
        let report = desk.scheduler.tick(6 * SECOND).unwrap().unwrap();
        assert_eq!((report.uploaded, report.pending), (1, 0));
        assert_eq!(desk.uploads(), uploaded + 1);
        assert_eq!(desk.scheduler.tick(7 * SECOND).unwrap(), None);
    }

    #[test]
    fn a_failed_run_waits_for_the_next_poll() {
        let desk = desk();
        desk.remote.fail(RemoteOp::List, 1, RemoteError::Offline);
        assert!(matches!(
            desk.scheduler.tick(Duration::ZERO),
            Err(Error::Remote(RemoteError::Offline))
        ));
        assert_eq!(desk.scheduler.tick(10 * SECOND).unwrap(), None);
        let report = desk.scheduler.tick(60 * SECOND).unwrap().unwrap();
        assert_eq!(report.uploaded, 1);
    }

    #[test]
    fn sync_now_runs_at_once_and_does_nothing_when_not_connected() {
        let desk = desk();
        desk.scheduler.tick(Duration::ZERO).unwrap();
        desk.workspace().create_ticket("Second").unwrap();
        let report = desk.scheduler.sync_now(SECOND).unwrap().unwrap();
        assert_eq!(report.uploaded, 1);

        desk.bind(None);
        assert_eq!(desk.scheduler.sync_now(2 * SECOND).unwrap(), None);
    }

    /// Binds the desk to a storage that holds every listing until the returned
    /// sender is used or dropped; the receiver tells when a run reached it.
    fn gate(desk: &Desk) -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
        let (open, gate) = mpsc::channel();
        let (entered, reached) = mpsc::channel();
        desk.bind(Some(Binding {
            remote: Arc::new(Gated {
                inner: desk.remote.clone(),
                gate: Mutex::new(gate),
                entered: Mutex::new(entered),
            }),
            ..desk.binding(DEFAULT_POLL)
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

        // Due (never ran from a tick), but the first run still holds the storage.
        assert_eq!(desk.scheduler.tick(SECOND).unwrap(), None);
        drop(open);
        assert_eq!(first.join().unwrap().unwrap().unwrap().uploaded, 1);
        let lists = |calls: Vec<RemoteOp>| calls.into_iter().filter(|op| *op == RemoteOp::List);
        assert_eq!(lists(desk.remote.calls()).count(), 1);
    }

    #[test]
    fn the_exit_flush_uploads_what_is_pending() {
        let desk = desk();
        let pending = desk.scheduler.flush(Duration::ZERO, EXIT_LIMIT).unwrap();
        assert_eq!(pending, []);
        assert_eq!(desk.uploads(), 1);
    }

    #[test]
    fn the_exit_flush_stops_waiting_at_its_limit_and_reports_what_is_left() {
        let desk = desk();
        let (open, reached) = gate(&desk);
        let pending = desk
            .scheduler
            .flush(Duration::ZERO, Duration::ZERO)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].kind, ticketd_core::sync::RecordKind::Ticket);

        // Let the abandoned run end before the Workspace file goes away.
        reached.recv().unwrap();
        drop(open);
        drop(lock(&desk.scheduler.running));
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
