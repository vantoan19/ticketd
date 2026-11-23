//! The local stderr files for source connections.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use fs2::FileExt;

const FILE_LIMIT: u64 = 256 * 1024;

/// Both the desktop and the CLI may write a connection's stderr. Hold a file
/// lock across the append so they agree on the boundary between generations.
pub(super) struct ExtensionLog {
    dir: PathBuf,
    id: String,
}

impl ExtensionLog {
    pub(super) fn new(log_dir: &Path, id: &str) -> Option<Self> {
        if id.is_empty()
            || id.len() > 100
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return None;
        }
        Some(Self {
            dir: log_dir.join("sources"),
            id: id.to_owned(),
        })
    }

    pub(super) fn append(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&self.dir)?;
        let lock = append_file(&self.dir.join(format!("{}.lock", self.id)))?;
        for attempt in 0.. {
            match FileExt::try_lock_exclusive(&lock) {
                Ok(()) => break,
                Err(error)
                    if attempt < 5
                        && error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => return Err(error),
            }
        }
        let current = self.dir.join(format!("{}.log", self.id));
        let previous = self.dir.join(format!("{}.1.log", self.id));
        for chunk in bytes.chunks(FILE_LIMIT as usize) {
            let mut file = append_file(&current)?;
            if file.metadata()?.len() + chunk.len() as u64 > FILE_LIMIT {
                drop(file);
                #[cfg(windows)]
                if previous.exists() {
                    fs::remove_file(&previous)?;
                }
                fs::rename(&current, &previous)?;
                file = append_file(&current)?;
            }
            file.write_all(chunk)?;
        }
        Ok(())
    }
}

fn append_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    // On Windows an append-only handle cannot be locked with LockFileEx.
    options.create(true).read(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
