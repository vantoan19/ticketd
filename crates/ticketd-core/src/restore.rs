//! Restore stages both resources, then uses atomic file replacement as its commit
//! point. A synced journal lets the next open resolve an interrupted root swap.
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    Error, FORMAT_VERSION, Workspace, backup, backup_archive, backup_review,
    chats::QUEUED_CHAT_INPUT, default_path, session,
};

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

fn pause_restored_chat_queues(staged: &Connection) -> Result<(), Error> {
    if !backup::table_exists(staged, "chats")? {
        return Ok(());
    }
    let has_held_edits: bool = staged.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chat_messages') WHERE name = 'editing')",
        [],
        |row| row.get(0),
    )?;
    let unheld = if has_held_edits {
        "AND m.editing = 0"
    } else {
        ""
    };
    staged.execute(
        &format!(
            "UPDATE chats SET queue_paused = 1 WHERE queue_paused = 0 AND EXISTS (
                SELECT 1 FROM chat_messages m
                WHERE m.chat_id = chats.id AND {QUEUED_CHAT_INPUT} {unheld}
            )"
        ),
        [],
    )?;
    Ok(())
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
    ///
    /// The restored Workspace is not connected to a sync folder, whatever the
    /// backup or the replaced Workspace was: a run against the folder would
    /// bring back what the restore went back on. It remembers the folder the
    /// replaced Workspace used, with this computer's sign-in, so the person
    /// chooses between going back to it (a merge, with differing values sent to
    /// review) and uploading or downloading again.
    pub fn restore(
        workspace: impl AsRef<Path>,
        backup: impl AsRef<Path>,
    ) -> Result<PathBuf, Error> {
        Self::restore_from(workspace.as_ref(), backup.as_ref(), false)
    }

    /// [`Workspace::restore`], optionally keeping the backup's sync folder: for
    /// the replacement Workspace that downloading a folder prepares.
    pub(crate) fn restore_from(
        workspace: &Path,
        backup: &Path,
        keep_sync_folder: bool,
    ) -> Result<PathBuf, Error> {
        backup_review::require_backup_file(backup)?;
        let folder = workspace
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if !folder.is_dir() {
            let missing = folder
                .metadata()
                .err()
                .unwrap_or_else(|| std::io::ErrorKind::NotADirectory.into());
            return Err(crate::path_error("target folder", folder, missing));
        }
        let lock = backup::resolve(workspace)
            .ok()
            .map(|r| backup::lock_path(&r));
        let lock_existed = lock.as_ref().is_some_and(|lock| lock.exists());
        let result = Self::restore_checked(workspace, backup, keep_sync_folder);
        // A restore that fails before it replaces anything leaves no new lock file behind.
        // Another process holding the lock is not ours to remove.
        if let (Err(error), Some(lock)) = (&result, lock)
            && !lock_existed
            && !matches!(error, Error::RestoreLock { .. })
        {
            let _ = fs::remove_file(lock);
        }
        result
    }

    fn restore_checked(
        workspace: &Path,
        backup: &Path,
        keep_sync_folder: bool,
    ) -> Result<PathBuf, Error> {
        // Warm sessions elsewhere are asked to let go first (ADR 0016).
        let _lock = session::lock_exclusive(workspace, session::RELEASE_WAIT)?;
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
        let source = backup_review::open_backup(backup)?;
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
        // The backup may be older than references this device has since issued, or come from
        // another device: a fresh code keeps the restored counter from issuing one twice.
        // A backup from before device codes gets its code when it is migrated on open.
        if backup::table_exists(&restored, "device")? {
            crate::device::renew_code(&restored)?;
        }
        // For the same reason it joins its sync folder as a device of its own.
        if backup::table_exists(&restored, "sync_state")? {
            restored.execute("UPDATE sync_state SET device_id = NULL", [])?;
            if !keep_sync_folder {
                crate::sync::forget_folder(&restored)?;
            }
        }

        // All potentially failing staging work happens before touching live data.
        let current = if workspace.exists() {
            Connection::open(&workspace)?
        } else {
            Connection::open_in_memory()?
        };
        session::configure(&current)?;
        let version: i64 = current.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > FORMAT_VERSION {
            return Err(Error::NewerSchema(version));
        }
        let local_recovery = backup
            .parent()
            .and_then(|path| path.canonicalize().ok())
            .as_deref()
            == Some(parent)
            && backup
                .file_name()
                .zip(workspace.file_name())
                .is_some_and(|(copy, live)| {
                    copy.to_str()
                        .zip(live.to_str())
                        .is_some_and(|(copy, live)| {
                            copy.strip_prefix(live).is_some_and(|suffix| {
                                suffix.starts_with(backup::PRE_MIGRATION_MARKER)
                                    || suffix.starts_with(backup::SAFETY_MARKER)
                            })
                        })
                });
        if !keep_sync_folder && backup::table_exists(&restored, "sync_state")? {
            crate::sync::remember_replaced_folder(&restored, &current)?;
        }
        if !local_recovery {
            // Convert the old connection binding before discarding settings
            // carried by the incoming backup. The attempt's original GitHub
            // account and tracker clock remain useful on the restored ticket.
            if backup::table_exists(&restored, "source_connections")?
                && !backup::table_exists(&restored, "github_publication_context")?
                && restored.query_row(
                    "SELECT EXISTS(SELECT 1 FROM source_connections WHERE provider = 'github')",
                    [],
                    |row| row.get::<_, bool>(0),
                )?
            {
                let version =
                    restored.pragma_query_value(None, "user_version", |row| row.get(0))?;
                crate::format::migrate(&mut restored, version)?;
            }
            crate::source::forget_connections(&restored)?;
            crate::source::retain_connections(&mut restored, &current)?;
        }
        if let Some(record) = Self::read_last_backup(&current).ok().flatten()
            && backup::table_exists(&restored, "last_backup")?
        {
            restored.execute(
                    "INSERT INTO last_backup(id, path, completed_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET path=excluded.path, completed_at=excluded.completed_at",
                    [record.path, record.completed_at],
                )?;
        }
        // A failed pause leaves the live Workspace alone, and an installed copy is
        // safe even if the desktop is interrupted before reconciling its Chats.
        pause_restored_chat_queues(&restored)?;
        drop(restored);
        staged.as_file().sync_all()?;
        let root = backup_archive::attachment_root(&workspace);
        let safety = sibling(
            &reported_workspace,
            &format!("{}{}.sqlite3", backup::SAFETY_MARKER, Uuid::new_v4()),
        );
        backup::save_snapshot(&current, &root, &safety, false).map_err(|source| {
            Error::SafetyCopy {
                source: Box::new(source),
            }
        })?;
        // The fence before the swap: everything committed is in the replaced file, which
        // the safety copy already holds, and no WAL is left to replay into the new one.
        session::single_file(&current)?;
        drop(current);
        session::remove_wal_files(&workspace)?;
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
