//! A development-only tap on the bytes the harness pipes actually transfer.

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::task::{Context, Poll};
use std::thread;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::Harness;
use crate::stdio::{Io, Reader, Serving, Writer};

pub(super) const SWITCH: &str = "TICKETD_RECORD_HARNESS";
const HEADER: &[u8] = b"ticketd-harness-recording-v1\n";
const CHUNK_BYTES: usize = 64 * 1024;
const MAX_RECORDING_BYTES: usize = 64 * 1024 * 1024;

/// Called once during desktop startup, before the Workspace is opened elsewhere.
/// The callback returns the path from the actual opened Workspace.
pub fn prepare_harness_recording(
    open_workspace: impl FnOnce() -> Result<PathBuf, ticketd_core::Error>,
) -> io::Result<()> {
    let Some(selected) = env::var_os(SWITCH) else {
        return Ok(());
    };
    let harness = selected
        .to_str()
        .and_then(crate::registration)
        .map(|entry| entry.descriptor)
        .ok_or_else(|| io::Error::other("Choose a registered harness for recording"))?;

    let requested = env::var_os("TICKETD_TEST_WORKSPACE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.file_name() == Some("workspace.sqlite3".as_ref()))
        .ok_or_else(invalid_run)?;
    let parent = requested.parent().ok_or_else(invalid_run)?;
    let metadata = parent.symlink_metadata().map_err(|_| invalid_run())?;
    let directory = parent.canonicalize().map_err(|_| invalid_run())?;
    let temp = Path::new("/tmp")
        .canonicalize()
        .map_err(|_| invalid_run())?;
    if !metadata.is_dir()
        || metadata.mode() & 0o077 != 0
        || directory.parent() != Some(temp.as_path())
        || directory
            .ancestors()
            .any(|path| path.join(".git").try_exists().unwrap_or(true))
    {
        return Err(invalid_run());
    }
    // SQLite also opens sidecar files by name. The only existing entry may be
    // the synthetic work folder, so no old database, lock or sidecar is reused.
    let mut entries = fs::read_dir(&directory).map_err(|_| invalid_run())?;
    if !matches!(entries.next(), Some(Ok(entry)) if entry.file_name() == "work")
        || entries.next().is_some()
    {
        return Err(invalid_run());
    }
    let work = directory.join("work");
    let work_metadata = check_work(&work, metadata.uid()).map_err(|_| invalid_run())?;
    let workspace = directory.join("workspace.sqlite3");
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&workspace)
        .map_err(|_| invalid_run())?;
    let database = file.metadata().map_err(|_| invalid_run())?;
    if database.uid() != metadata.uid() {
        return Err(invalid_run());
    }

    let actual = open_workspace()
        .and_then(|path| path.canonicalize().map_err(Into::into))
        .map_err(|_| invalid_run())?;
    if actual != workspace || !FileIdentity::of(&database).matches_file(&actual) {
        return Err(invalid_run());
    }
    let run = RecordingRun {
        harness,
        directory,
        workspace,
        work,
        root_identity: FileIdentity::of(&metadata),
        database_identity: FileIdentity::of(&database),
        work_identity: FileIdentity::of(&work_metadata),
        owner: metadata.uid(),
    };
    RUN.set(run).map_err(|_| invalid_run())
}

fn invalid_run() -> io::Error {
    io::Error::other(
        "Harness recording needs a fresh private folder under /tmp with a work folder and a new workspace.sqlite3",
    )
}

static RUN: OnceLock<RecordingRun> = OnceLock::new();

pub(super) struct RecordingRun {
    harness: Harness,
    directory: PathBuf,
    workspace: PathBuf,
    work: PathBuf,
    root_identity: FileIdentity,
    database_identity: FileIdentity,
    work_identity: FileIdentity,
    owner: u32,
}

#[derive(PartialEq, Eq)]
struct FileIdentity(u64, u64);

impl FileIdentity {
    fn of(metadata: &fs::Metadata) -> Self {
        Self(metadata.dev(), metadata.ino())
    }

    fn matches_file(&self, path: &Path) -> bool {
        path.symlink_metadata().is_ok_and(|metadata| {
            metadata.is_file() && metadata.nlink() == 1 && Self::of(&metadata) == *self
        })
    }
}

/// A scratch folder may contain ordinary files and directories owned by the run
/// owner. Following links here would allow fixture prompts to read other data.
fn check_work(work: &Path, owner: u32) -> io::Result<fs::Metadata> {
    let root = work.symlink_metadata()?;
    if !root.is_dir() || root.uid() != owner || root.mode() & 0o022 != 0 {
        return Err(invalid_run());
    }
    let mut pending = vec![work.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in fs::read_dir(folder)? {
            let entry = entry?;
            let metadata = entry.path().symlink_metadata()?;
            if metadata.uid() != owner || metadata.mode() & 0o022 != 0 {
                return Err(invalid_run());
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if !metadata.is_file() || metadata.nlink() != 1 {
                return Err(invalid_run());
            }
        }
    }
    Ok(root)
}

pub(super) fn before_spawn(
    harness: Harness,
    serving: Serving,
    working_directory: Option<&Path>,
) -> io::Result<Option<&'static RecordingRun>> {
    let Some(run) = RUN.get().filter(|run| {
        run.harness == harness && matches!(serving, Serving::Chat { run_id: None, .. })
    }) else {
        return Ok(None);
    };
    let valid = working_directory
        .filter(|path| {
            path.symlink_metadata()
                .is_ok_and(|metadata| metadata.is_dir())
        })
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| path == run.work)
        && run.directory.symlink_metadata().is_ok_and(|metadata| {
            metadata.is_dir()
                && metadata.mode() & 0o077 == 0
                && FileIdentity::of(&metadata) == run.root_identity
        })
        && run.database_identity.matches_file(&run.workspace)
        && check_work(&run.work, run.owner)
            .is_ok_and(|metadata| FileIdentity::of(&metadata) == run.work_identity);
    if !valid {
        return Err(io::Error::other(
            "Use this recording run's private work folder and its original disposable Workspace",
        ));
    }
    Ok(Some(run))
}

impl RecordingRun {
    pub(super) fn work(&self) -> &Path {
        &self.work
    }

    pub(super) fn tap(&self, mut io: Io) -> io::Result<Io> {
        let sender = start(&self.directory, self.harness.key.as_str())?;
        io.stdout = Box::new(TappedReader(io.stdout, Arc::clone(&sender)));
        io.stdin = Box::new(TappedWriter(io.stdin, sender));
        Ok(io)
    }
}

struct Chunk {
    direction: u8,
    bytes: Vec<u8>,
}

type Sender = Arc<Mutex<Queue>>;

struct Queue {
    send: Option<SyncSender<Chunk>>,
    incomplete: Arc<AtomicBool>,
}

impl Queue {
    fn record(&mut self, direction: u8, bytes: &[u8]) {
        let Some(send) = &self.send else {
            return;
        };
        for chunk in bytes.chunks(CHUNK_BYTES) {
            if send
                .try_send(Chunk {
                    direction,
                    bytes: chunk.to_vec(),
                })
                .is_err()
            {
                self.abandon();
                break;
            }
        }
    }

    fn abandon(&mut self) {
        self.incomplete.store(true, Ordering::Release);
        self.send = None;
    }
}

fn start(directory: &Path, harness: &'static str) -> io::Result<Sender> {
    let stem = format!("{harness}-{}", uuid::Uuid::new_v4());
    let pending = directory.join(format!("{stem}.wire.partial"));
    let completed = directory.join(format!("{stem}.wire"));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&pending)?;
    // Queue more than a maximum-size protocol frame. If the disk still cannot
    // keep up, abandon the capture without making the Chat wait for it.
    let (send, receive) = mpsc::sync_channel(256);
    let incomplete = Arc::new(AtomicBool::new(false));
    let sender = Arc::new(Mutex::new(Queue {
        send: Some(send),
        incomplete: Arc::clone(&incomplete),
    }));
    let pending_for_worker = pending.clone();
    if let Err(error) = thread::Builder::new()
        .name("ticketd-harness-recording".into())
        .spawn(move || {
            finish(
                file,
                receive,
                &incomplete,
                &pending_for_worker,
                &completed,
                harness,
            )
        })
    {
        let _ = fs::remove_file(&pending);
        return Err(error);
    }
    Ok(sender)
}

fn finish(
    file: File,
    receive: Receiver<Chunk>,
    incomplete: &AtomicBool,
    pending: &Path,
    completed: &Path,
    harness: &'static str,
) {
    match save(file, receive) {
        Ok(()) if incomplete.load(Ordering::Acquire) => {
            tracing::warn!(harness, "harness recording incomplete");
        }
        Ok(()) => match fs::rename(pending, completed) {
            Ok(()) => return,
            Err(error) => {
                tracing::warn!(harness, error_kind = ?error.kind(), "could not finish harness recording");
            }
        },
        Err(error) => {
            tracing::warn!(harness, error_kind = ?error.kind(), "could not save harness recording");
        }
    }
    let _ = fs::remove_file(pending);
}

fn save(file: File, receive: Receiver<Chunk>) -> io::Result<()> {
    let mut output = BufWriter::new(file);
    output.write_all(HEADER)?;
    let mut total = HEADER.len();
    for chunk in receive {
        // A direction byte and little-endian length precede each exact chunk.
        let size = chunk.bytes.len() as u32;
        total += 5 + chunk.bytes.len();
        if total > MAX_RECORDING_BYTES {
            return Err(io::Error::other("harness recording reached its size limit"));
        }
        output.write_all(&[chunk.direction])?;
        output.write_all(&size.to_le_bytes())?;
        output.write_all(&chunk.bytes)?;
    }
    output.flush()
}

fn lock(sender: &Sender) -> MutexGuard<'_, Queue> {
    sender.lock().unwrap_or_else(PoisonError::into_inner)
}

struct TappedReader(Reader, Sender);

impl AsyncRead for TappedReader {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let Self(reader, sender) = self.get_mut();
        let mut sender = lock(sender);
        let before = buffer.filled().len();
        let polled = Pin::new(reader).poll_read(cx, buffer);
        match &polled {
            Poll::Ready(Ok(())) => sender.record(2, &buffer.filled()[before..]),
            Poll::Ready(Err(_)) => sender.abandon(),
            Poll::Pending => {}
        }
        polled
    }
}

struct TappedWriter(Writer, Sender);

impl AsyncWrite for TappedWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let Self(writer, sender) = self.get_mut();
        // Serialize the nonblocking polls so a reply follows the write it answers.
        let mut sender = lock(sender);
        let polled = Pin::new(writer).poll_write(cx, buffer);
        match &polled {
            Poll::Ready(Ok(written)) => sender.record(1, &buffer[..*written]),
            Poll::Ready(Err(_)) => sender.abandon(),
            Poll::Pending => {}
        }
        polled
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}
