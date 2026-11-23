//! A development-only tap on the bytes the harness pipes actually transfer.

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::thread;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::stdio::{Io, Reader, Serving, Writer};
use crate::{Harness, harness_key};

pub(super) const SWITCH: &str = "TICKETD_RECORD_HARNESS";
const HEADER: &[u8] = b"ticketd-harness-recording-v1\n";
const CHUNK_BYTES: usize = 64 * 1024;
const MAX_RECORDING_BYTES: usize = 64 * 1024 * 1024;

pub(super) fn tap(mut io: Io, harness: Harness, serving: Serving) -> io::Result<Io> {
    let name = harness_key(harness);
    if matches!(serving, Serving::Chat { run_id: None, .. })
        && env::var(SWITCH).is_ok_and(|selected| selected == name)
    {
        let sender = start(&private_run_directory()?, name)?;
        io.stdout = Box::new(TappedReader(io.stdout, Arc::clone(&sender)));
        io.stdin = Box::new(TappedWriter(io.stdin, sender));
    }
    Ok(io)
}

/// Confine recording to a private temporary run containing a development Workspace.
fn private_run_directory() -> io::Result<PathBuf> {
    let invalid = || {
        io::Error::other(
            "Harness recording needs TICKETD_TEST_WORKSPACE in a private temporary folder outside Git",
        )
    };
    let workspace = env::var_os("TICKETD_TEST_WORKSPACE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(invalid)?;
    // Opening a symlink or hard link could have pointed the desktop at real data.
    match fs::symlink_metadata(&workspace) {
        Ok(metadata) if metadata.is_file() && metadata.nlink() == 1 => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        _ => return Err(invalid()),
    }
    let directory = workspace
        .parent()
        .ok_or_else(invalid)?
        .canonicalize()
        .map_err(|_| invalid())?;
    let temp = env::temp_dir().canonicalize().map_err(|_| invalid())?;
    let metadata = directory.metadata().map_err(|_| invalid())?;
    if directory == temp
        || !directory.starts_with(temp)
        || !metadata.is_dir()
        || metadata.mode() & 0o077 != 0
        || directory
            .ancestors()
            .any(|ancestor| ancestor.join(".git").try_exists().unwrap_or(true))
    {
        return Err(invalid());
    }
    Ok(directory)
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
