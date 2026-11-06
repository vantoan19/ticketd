//! Restore stages both resources, then uses atomic file replacement as its commit
//! point. A synced journal lets the next open resolve an interrupted root swap.
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, FORMAT_VERSION, Workspace, backup, backup_archive, default_path};

#[derive(Serialize, Deserialize)]
struct RestoreJournal {
    token: Uuid,
    had_root: bool,
    database_sha256: String,
}

fn sibling(workspace: &Path, suffix: &str) -> PathBuf {
    let mut name = workspace.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn reported_path(path: PathBuf) -> PathBuf {
    // canonicalize supplies Windows' internal verbatim prefix; keep the public
    // safety-path contract usable with ordinary paths and CLI consumers.
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(disk) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(disk);
        }
    }
    path
}

pub(crate) fn pending(workspace: &Path) -> bool {
    sibling(workspace, ".restore.json").exists()
}

/// Called under the exclusive workspace lock, before opening any connection.
pub(crate) fn recover(workspace: &Path) -> Result<(), Error> {
    let marker = sibling(workspace, ".restore.json");
    if !marker.exists() {
        return Ok(());
    }
    let journal: RestoreJournal = serde_json::from_slice(&fs::read(&marker)?).map_err(|error| {
        Error::Backup(format!("cannot read interrupted restore recovery record: {error}; preserve the workspace files and restore the complete safety backup"))
    })?;
    let root = backup_archive::attachment_root(workspace);
    let retired = sibling(
        workspace,
        &format!(".restore-{}.attachments", journal.token),
    );
    let committed = workspace.is_file()
        && backup_archive::digest(&mut File::open(workspace)?)? == journal.database_sha256;
    if committed {
        if retired.exists() {
            fs::remove_dir_all(&retired)?;
        }
    } else if retired.exists() {
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::rename(&retired, &root)?;
    } else if !journal.had_root && root.exists() {
        fs::remove_dir_all(&root)?;
    }
    let parent = workspace
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    backup_archive::sync_directory(parent)?;
    fs::remove_file(marker)?;
    Ok(())
}

impl Workspace {
    pub fn restore_default(path: impl AsRef<Path>) -> Result<PathBuf, Error> {
        Self::restore(default_path()?, path)
    }

    /// Restore only when no workspace connection is open. Returns a complete
    /// safety backup, including all retained bytes of the previous workspace.
    pub fn restore(
        workspace: impl AsRef<Path>,
        backup: impl AsRef<Path>,
    ) -> Result<PathBuf, Error> {
        let workspace = workspace.as_ref();
        let backup = backup.as_ref();
        if !backup.is_file() {
            return Err(Error::Backup(format!(
                "backup file not found: {}",
                backup.display()
            )));
        }
        let lock = backup::lock_file(workspace)?;
        FileExt::try_lock_exclusive(&lock).map_err(|source| {
            if source.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                Error::RestoreLock { source }
            } else {
                Error::Directory(source)
            }
        })?;
        let reported_workspace = if workspace
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            reported_path(workspace.canonicalize()?)
        } else {
            workspace.to_path_buf()
        };
        // Resolve paths once so the recovery journal always names the same root,
        // including when the caller reached the database through a symlink.
        let workspace = if workspace.exists() {
            workspace.canonicalize()?
        } else {
            let parent = workspace
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            parent.canonicalize()?.join(
                workspace
                    .file_name()
                    .ok_or_else(|| Error::Backup("invalid workspace path".into()))?,
            )
        };
        recover(&workspace)?;
        if workspace.exists() && workspace.canonicalize()? == backup.canonicalize()? {
            return Err(Error::Backup("backup is the current workspace".into()));
        }
        let source = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        source.execute_batch("BEGIN")?;
        backup::validate(&source)?;
        let parent = workspace
            .parent()
            .ok_or_else(|| Error::Backup("workspace has no directory".into()))?;
        let staged_files = tempfile::Builder::new()
            .prefix(".ticketd-restore-")
            .tempdir_in(parent)?;
        backup_archive::extract(&source, staged_files.path())?;
        let staged = tempfile::NamedTempFile::new_in(parent)?;
        let mut restored = Connection::open(staged.path())?;
        backup::copy(&source, &mut restored)?;
        backup_archive::unpack_database(&restored)?;

        // All potentially failing staging work happens before touching live data.
        let current = if workspace.exists() {
            Connection::open(&workspace)?
        } else {
            Connection::open_in_memory()?
        };
        current.busy_timeout(Duration::from_secs(10))?;
        let version: i64 = current.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > FORMAT_VERSION {
            return Err(Error::NewerSchema(version));
        }
        if let Some(record) = Self::read_last_backup(&current).ok().flatten()
            && backup::table_exists(&restored, "last_backup")?
        {
            restored.execute(
                    "INSERT INTO last_backup(id, path, completed_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET path=excluded.path, completed_at=excluded.completed_at",
                    [record.path, record.completed_at],
                )?;
        }
        drop(restored);
        staged.as_file().sync_all()?;
        let root = backup_archive::attachment_root(&workspace);
        let safety = sibling(
            &reported_workspace,
            &format!("{}{}.sqlite3", backup::SAFETY_MARKER, Uuid::new_v4()),
        );
        backup::save_snapshot(&current, &root, &safety, false)?;
        drop(current);
        let journal = RestoreJournal {
            token: Uuid::new_v4(),
            had_root: root.exists(),
            database_sha256: backup_archive::digest(&mut File::open(staged.path())?)?,
        };
        let marker = sibling(&workspace, ".restore.json");
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(&serde_json::to_vec(&journal)?)?;
        file.as_file().sync_all()?;
        file.persist_noclobber(&marker)
            .map_err(|e| Error::Directory(e.error))?;
        backup_archive::sync_directory(parent)?;
        let retired = sibling(
            &workspace,
            &format!(".restore-{}.attachments", journal.token),
        );
        let result = (|| {
            if journal.had_root {
                fs::rename(&root, &retired)?;
            }
            fs::rename(staged_files.path(), &root)?;
            backup_archive::sync_directory(parent)?;
            // tempfile uses atomic replacement on Unix and MoveFileEx on Windows.
            staged
                .persist(&workspace)
                .map_err(|e| Error::Directory(e.error))?;
            backup_archive::sync_directory(parent)?;
            Ok::<_, Error>(())
        })();
        if let Err(error) = result {
            // The digest decides whether replacement reached its commit point;
            // never roll files back after the new database is already installed.
            recover(&workspace).map_err(|source| Error::Restore {
                safety: safety.clone(),
                source: Box::new(source),
            })?;
            return Err(Error::Restore {
                safety,
                source: Box::new(error),
            });
        }
        // A cleanup failure leaves a valid journal for the next exclusive open.
        let _ = recover(&workspace);
        Ok(safety)
    }
}
