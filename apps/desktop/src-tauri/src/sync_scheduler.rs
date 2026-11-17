//! Decides when the desktop runs Workspace sync: at launch and when a
//! connection appears, on a poll, shortly after a local change, on request and
//! once more on exit; and the daily upkeep that needs no connection. Time is passed in and the storage comes from the
//! binding, so none of it needs a clock or a network to be exercised.

use std::{
    sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError, mpsc},
    time::{Duration, Instant},
};

use ticketd_core::{
    Error, Workspace, WorkspaceGuard,
    sync::{MIN_POLL_INTERVAL_SECS, SyncItem, SyncRecovery, SyncStatus, remote::RemoteStorage},
};

/// How long after the last local change its upload starts.
const UPLOAD_DELAY: Duration = Duration::from_secs(3);
/// How long quitting waits for the last upload.
pub const EXIT_LIMIT: Duration = Duration::from_secs(10);
/// How often the upkeep runs while the app stays open.
const UPKEEP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// How long after a failed upkeep it is tried again.
const UPKEEP_RETRY: Duration = Duration::from_secs(60);
/// The longest the scheduler stays away from a storage that rate limited it,
/// however long the storage asked for.
const RETRY_LIMIT: Duration = Duration::from_secs(15 * 60);

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

type Open = dyn Fn() -> Result<WorkspaceGuard, Error> + Send + Sync;
/// `None` while the Workspace is not connected to a folder.
type Bound = dyn Fn(&Workspace) -> Result<Option<Binding>, Error> + Send + Sync;
/// What the Workspace needs now and then whether or not it syncs, such as
/// dropping versions past their 30 days.
type Upkeep = dyn Fn(&mut Workspace) -> Result<(), Error> + Send + Sync;
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
    /// No run starts by itself before this: the storage rate limited the last
    /// one and said how long to stay away.
    not_before: Duration,
}

pub struct Scheduler {
    open: Box<Open>,
    binding: Box<Bound>,
    upkeep: Box<Upkeep>,
    /// When the upkeep runs next (at the first tick, then once a day), and
    /// the failure last reported, if it is still failing.
    upkeep_at: Mutex<(Duration, Option<String>)>,
    watch: Mutex<Watch>,
    /// Held for the length of a run, so two never overlap.
    running: Mutex<()>,
}

/// What a tick failed with, for stderr. The core keeps a failed run in the
/// status, where the interface shows it; a tick that could not even open the
/// Workspace or save that outcome is known only here.
fn failure(tick: &Result<Option<SyncStatus>, Error>) -> Option<String> {
    match tick {
        Err(error) => Some(error.to_string()),
        Ok(Some(status)) if status.recovery == Some(SyncRecovery::Error) => Some(
            status
                .recovery_message
                .clone()
                .unwrap_or_else(|| "unknown failure".into()),
        ),
        Ok(_) => None,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Scheduler {
    pub fn new(open: Box<Open>, binding: Box<Bound>, upkeep: Box<Upkeep>) -> Self {
        Self {
            open,
            binding,
            upkeep,
            upkeep_at: Mutex::default(),
            watch: Mutex::default(),
            running: Mutex::default(),
        }
    }

    pub fn binding(&self) -> Result<Option<Binding>, Error> {
        (self.binding)(&*(self.open)()?)
    }

    /// Keeps sync away from the Workspace while the caller replaces its file:
    /// waits for a run in progress, and no tick opens the Workspace until the
    /// guard is dropped. What was watched belonged to the Workspace being
    /// replaced, whose change marks the new one does not continue, so the
    /// watch starts over.
    pub fn hold(&self) -> MutexGuard<'_, ()> {
        let held = lock(&self.running);
        *lock(&self.watch) = Watch::default();
        held
    }

    /// Runs sync if one is due at `now` (time since the app started). `None`
    /// when nothing was due, the Workspace is not connected, or a run is
    /// already in progress. A run the storage refused is not repeated before
    /// the next poll or local change, nor before a rate limiting storage
    /// asked to be tried again (at most [`RETRY_LIMIT`]).
    pub fn tick(&self, now: Duration) -> Result<Option<SyncStatus>, Error> {
        // Taken before anything opens the Workspace: whoever holds it may be
        // replacing the Workspace file, which an open handle would refuse.
        let _running = match self.running.try_lock() {
            Ok(running) => running,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return Ok(None),
        };
        let mut workspace = (self.open)()?;
        self.keep_up(&mut workspace, now);
        let Some(binding) = (self.binding)(&workspace)? else {
            // The next connection starts with a run.
            *lock(&self.watch) = Watch::default();
            return Ok(None);
        };
        let latest = workspace.change_mark()?;
        let due = {
            let mut watch = lock(&self.watch);
            if latest < watch.seen_mark {
                // The marks of one Workspace only grow: this is another file
                // at the same path (restored by the CLI, say), and it is
                // synced like a new connection.
                *watch = Watch::default();
            }
            if latest > watch.seen_mark {
                // Each further change moves the upload later, so a burst uploads once.
                watch.seen_mark = latest;
                watch.upload_at = Some(now + UPLOAD_DELAY);
            }
            let due = !watch.connected
                || now >= watch.poll_at
                || watch.upload_at.is_some_and(|at| now >= at);
            due && now >= watch.not_before
        };
        if !due {
            return Ok(None);
        }
        self.run(Ok(workspace), &binding, now, Workspace::sync_now)
            .map(Some)
    }

    /// Runs the upkeep when it is due. A failure is tried again after
    /// [`UPKEEP_RETRY`] and never holds up sync.
    fn keep_up(&self, workspace: &mut Workspace, now: Duration) {
        let mut next = lock(&self.upkeep_at);
        let (at, reported) = &mut *next;
        if now < *at {
            return;
        }
        let failed = (self.upkeep)(workspace)
            .err()
            .map(|error| error.to_string());
        *at = now + failed.as_ref().map_or(UPKEEP_INTERVAL, |_| UPKEEP_RETRY);
        // Said once on stderr, and again only if it changes or comes back.
        if let Some(message) = &failed
            && reported.as_ref() != Some(message)
        {
            eprintln!("Workspace upkeep could not run: {message}");
        }
        *reported = failed;
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
        let _running = lock(&self.running);
        let workspace = (self.open)()?;
        let Some(binding) = (self.binding)(&workspace)? else {
            return Ok(None);
        };
        self.run(Ok(workspace), &binding, now, run).map(Some)
    }

    /// The caller holds `running`. The Workspace handle is this run's alone;
    /// its writes are short transactions, so other commands are not held up by
    /// the network.
    fn run(
        &self,
        workspace: Result<WorkspaceGuard, Error>,
        binding: &Binding,
        now: Duration,
        run: Run,
    ) -> Result<SyncStatus, Error> {
        // What this run takes with it needs no upload of its own afterwards.
        let mut taken = None;
        let result = workspace.and_then(|mut workspace| {
            taken = Some(workspace.change_mark()?);
            run(&mut workspace, binding.remote.as_ref())
        });
        let mut watch = lock(&self.watch);
        if let Some(taken) = taken {
            watch.seen_mark = watch.seen_mark.max(taken);
        }
        watch.connected = true;
        watch.upload_at = None;
        let least = Duration::from_secs(MIN_POLL_INTERVAL_SECS);
        watch.poll_at = now + binding.poll.max(least);
        let asked = result.as_ref().ok().and_then(|status| status.retry_after);
        watch.not_before = now + asked.unwrap_or_default().min(RETRY_LIMIT);
        result
    }

    /// One last run before quitting, given `limit` to finish. Returns what is
    /// still waiting to upload, as the first of them and how many there are:
    /// none when everything reached the storage or the Workspace does not
    /// sync. A failed upload is reported the same way.
    pub fn flush(
        self: &Arc<Self>,
        now: Duration,
        limit: Duration,
    ) -> Result<(Vec<SyncItem>, u64), Error> {
        let Some(binding) = self.binding()? else {
            return Ok((Vec::new(), 0));
        };
        let (done, finished) = mpsc::channel();
        let scheduler = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("workspace-sync-exit".into())
            .spawn(move || {
                let _running = lock(&scheduler.running);
                let _ = scheduler.run((scheduler.open)(), &binding, now, Workspace::sync_now);
                let _ = done.send(());
            });
        if spawned.is_ok() {
            let _ = finished.recv_timeout(limit);
        }
        let status = (self.open)()?.sync_status()?;
        Ok((status.pending_uploads, status.pending_total))
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
                        // Nothing was due: what was last said still stands.
                        Ok(None) => {}
                        tick => {
                            let message = failure(&tick);
                            if let Some(message) = &message
                                && reported.as_ref() != Some(message)
                            {
                                eprintln!("Workspace sync could not run: {message}");
                            }
                            reported = message;
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
    use std::{
        io::Write,
        sync::atomic::{AtomicUsize, Ordering},
    };
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
        /// How often the scheduler opened the Workspace.
        opens: Arc<AtomicUsize>,
        /// How often the upkeep ran.
        upkeeps: Arc<AtomicUsize>,
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
        let opens = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&opens);
        let upkeeps = Arc::new(AtomicUsize::new(0));
        let kept = Arc::clone(&upkeeps);
        let scheduler = Arc::new(Scheduler::new(
            Box::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                ticketd_core::WorkspaceSession::for_file(&open_path)?.workspace()
            }),
            Box::new(move |_| Ok(lock(&source).clone())),
            Box::new(move |_| {
                kept.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        ));
        let desk = Desk {
            _directory: directory,
            remote,
            scheduler,
            opens,
            upkeeps,
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
    fn upkeep_runs_at_the_first_tick_and_once_a_day_connected_or_not() {
        let desk = desk();
        desk.bind(None);
        let day = 24 * 60 * MINUTE;
        desk.scheduler.tick(Duration::ZERO).unwrap();
        assert_eq!(desk.upkeeps.load(Ordering::SeqCst), 1);
        desk.scheduler.tick(day - SECOND).unwrap();
        assert_eq!(desk.upkeeps.load(Ordering::SeqCst), 1);
        desk.bind(Some(desk.binding(MINUTE)));
        desk.scheduler.tick(day).unwrap();
        assert_eq!(desk.upkeeps.load(Ordering::SeqCst), 2);
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

    /// F54: a storage that says how long to stay away is left alone that long
    /// by the runs the scheduler starts itself, up to a quarter of an hour.
    #[test]
    fn a_rate_limited_run_waits_as_long_as_the_storage_asked_before_the_next_automatic_one() {
        let desk = desk();
        let limited = |wait: Duration| {
            let retry_after = Some(wait);
            let error = RemoteError::RateLimited { retry_after };
            desk.remote.fail(RemoteOp::List, 1, error);
        };
        limited(5 * MINUTE);
        let status = desk.scheduler.tick(Duration::ZERO).unwrap().unwrap();
        assert_eq!(status.recovery, Some(SyncRecovery::RateLimited));
        // Neither the poll nor a local change runs it sooner.
        desk.workspace().create_ticket("Second").unwrap();
        assert_eq!(desk.scheduler.tick(MINUTE).unwrap(), None);
        assert_eq!(desk.scheduler.tick(5 * MINUTE - SECOND).unwrap(), None);
        let status = desk.scheduler.tick(5 * MINUTE).unwrap().unwrap();
        assert_eq!((status.recovery, status.pending_uploads.len()), (None, 0));

        // An hour asked for is a quarter of an hour waited.
        limited(60 * MINUTE);
        let from = 10 * MINUTE;
        assert!(desk.scheduler.tick(from).unwrap().is_some());
        assert_eq!(
            desk.scheduler.tick(from + 15 * MINUTE - SECOND).unwrap(),
            None
        );
        assert!(desk.scheduler.tick(from + 15 * MINUTE).unwrap().is_some());

        // Sync now is the person asking: it runs at once.
        limited(60 * MINUTE);
        let from = 40 * MINUTE;
        assert!(desk.scheduler.tick(from).unwrap().is_some());
        let status = desk.scheduler.sync_now(from + SECOND).unwrap().unwrap();
        assert_eq!(status.recovery, None);
    }

    /// F54: an upkeep that failed is tried again a minute later: not a day
    /// later, and not by every tick.
    #[test]
    fn a_failed_upkeep_runs_again_after_a_minute() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.sqlite3");
        drop(Workspace::open(&path).unwrap());
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let scheduler = Scheduler::new(
            Box::new(move || ticketd_core::WorkspaceSession::for_file(&path)?.workspace()),
            Box::new(|_| Ok(None)),
            Box::new(move |_| match counted.fetch_add(1, Ordering::SeqCst) {
                0 => Err(Error::NotFound("a busy Workspace".into())),
                _ => Ok(()),
            }),
        );
        scheduler.tick(Duration::ZERO).unwrap();
        scheduler.tick(MINUTE - SECOND).unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        scheduler.tick(MINUTE).unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        // Once it worked, the next one is a day away.
        scheduler.tick(2 * MINUTE).unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
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
        assert_eq!(pending, (vec![], 0));
        assert!(!desk.remote.list(&desk.folder).unwrap().is_empty());
    }

    #[test]
    fn the_exit_flush_stops_waiting_at_its_limit_and_reports_what_is_left() {
        let desk = desk();
        let (open, reached) = gate(&desk);
        let (pending, total) = desk
            .scheduler
            .flush(Duration::ZERO, Duration::ZERO)
            .unwrap();
        assert_eq!(total, 1);
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
        let (pending, total) = desk.scheduler.flush(Duration::ZERO, EXIT_LIMIT).unwrap();
        assert_eq!((pending.len(), total), (1, 1));

        desk.bind(None);
        assert_eq!(
            desk.scheduler.flush(Duration::ZERO, EXIT_LIMIT).unwrap(),
            (vec![], 0)
        );
    }

    #[test]
    fn a_failure_with_no_state_of_its_own_is_kept_in_the_status_and_said_on_stderr() {
        let desk = desk();
        desk.remote
            .fail(RemoteOp::List, 1, RemoteError::Other("nonsense".into()));
        let tick = desk.scheduler.tick(Duration::ZERO);
        assert_eq!(
            failure(&tick).as_deref(),
            Some("sync storage: storage: nonsense")
        );
        // The interface reads the same failure from the status.
        let status = desk.workspace().sync_status().unwrap();
        assert_eq!(status.recovery, Some(SyncRecovery::Error));
        assert_eq!(
            status.recovery_message.as_deref(),
            Some("sync storage: storage: nonsense")
        );

        // A state the interface words itself, and a run that worked, say nothing.
        desk.remote.fail(RemoteOp::List, 1, RemoteError::Offline);
        assert_eq!(failure(&desk.scheduler.tick(MINUTE)), None);
        assert_eq!(failure(&desk.scheduler.tick(2 * MINUTE)), None);
        assert!(failure(&Err(Error::NotFound("workspace".into()))).is_some());
    }

    #[test]
    fn a_tick_leaves_the_workspace_alone_while_its_file_is_being_replaced() {
        let desk = desk();
        let opened = || desk.opens.load(Ordering::SeqCst);
        let replacing = desk.scheduler.hold();
        // Due, since nothing ran yet, but the Workspace is not even opened.
        assert_eq!(desk.scheduler.tick(Duration::ZERO).unwrap(), None);
        assert_eq!(opened(), 0);
        drop(replacing);

        // A tick that runs opens the Workspace once for everything it does.
        assert!(desk.scheduler.tick(SECOND).unwrap().is_some());
        assert_eq!(opened(), 1);
    }

    #[test]
    fn a_workspace_replaced_behind_the_scheduler_is_synced_like_a_new_connection() {
        let desk = desk();
        for title in ["Second", "Third", "Fourth"] {
            desk.workspace().create_ticket(title).unwrap();
        }
        desk.scheduler.tick(Duration::ZERO).unwrap();

        // Replaced from outside the app, as a restore by the CLI does: the
        // scheduler is not told, and the new file's change marks start over.
        std::fs::remove_file(&desk.path).unwrap();
        let mut replaced = desk.workspace();
        replaced.create_ticket("Other").unwrap();
        replaced
            .sync_connect("connection", "mina@example.com")
            .unwrap();
        let status = replaced
            .sync_upload_workspace(&desk.remote, "Other")
            .unwrap();
        drop(replaced);
        desk.bind(Some(Binding {
            folder: status.folder.unwrap().id,
            ..desk.binding(MINUTE)
        }));
        assert!(desk.scheduler.tick(SECOND).unwrap().is_some());

        desk.workspace().create_ticket("Another").unwrap();
        assert_eq!(desk.scheduler.tick(2 * SECOND).unwrap(), None);
        let status = desk.scheduler.tick(5 * SECOND).unwrap().unwrap();
        assert_eq!(status.pending_uploads, []);
    }

    #[test]
    fn a_replaced_workspace_uploads_its_changes_after_the_usual_wait() {
        let desk = desk();
        // Several changes here, so the watch has seen a high change mark.
        for title in ["Second", "Third", "Fourth"] {
            desk.workspace().create_ticket(title).unwrap();
        }
        desk.scheduler.tick(Duration::ZERO).unwrap();

        // The Workspace file is replaced by one whose marks start over.
        let replacing = desk.scheduler.hold();
        std::fs::remove_file(&desk.path).unwrap();
        let mut replaced = desk.workspace();
        replaced.create_ticket("Other").unwrap();
        replaced
            .sync_connect("connection", "mina@example.com")
            .unwrap();
        let status = replaced
            .sync_upload_workspace(&desk.remote, "Other")
            .unwrap();
        drop(replaced);
        desk.bind(Some(Binding {
            folder: status.folder.unwrap().id,
            ..desk.binding(MINUTE)
        }));
        drop(replacing);
        // The replaced Workspace is synced straight away, like a new connection.
        assert!(desk.scheduler.tick(SECOND).unwrap().is_some());

        desk.workspace().create_ticket("Another").unwrap();
        assert_eq!(desk.scheduler.tick(2 * SECOND).unwrap(), None);
        assert_eq!(desk.pending(), 1);
        let status = desk.scheduler.tick(5 * SECOND).unwrap().unwrap();
        assert_eq!(status.pending_uploads, []);
    }
}
