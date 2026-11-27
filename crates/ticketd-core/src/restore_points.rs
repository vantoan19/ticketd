//! Restore points: a copy of the Workspace saved on this computer the first time ticketd opens
//! each day, so a person can always go back a few days without having thought about it.
//!
//! The points live in a folder beside the Workspace file, `<workspace>.restore-points`, which is
//! this computer's app data. They are never part of the Workspace, never synced and never
//! travel to another computer. Each point is a backup in the container of `backup_archive`,
//! except that its attachment files are kept in one `files` folder shared by every point: a
//! file that did not change costs nothing in the next point, and deleting an old point
//! deletes only the files no remaining point names. `ticketd backup PATH` is untouched and
//! still writes a standalone file that restores anywhere.
//!
//! A point is two files, `<id>.sqlite3` and `<id>.json`. The record is written last, after the
//! point has been checked as a restore would check it, so a point without one is an unfinished
//! write and is cleared on the next pass. Safety copies (before a restore or an update) stay
//! beside the Workspace as they always have; the list shows them with the points and the
//! retention below never touches them.
use std::{
    collections::BTreeSet,
    fs::{self, File},
    path::{Path, PathBuf},
};

use chrono::{DateTime, FixedOffset, Local, SecondsFormat, Utc};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    Error, Workspace,
    backup::{PRE_MIGRATION_VERSION_MARKER, Packing, save_snapshot_packed},
    backup_archive::{SHARED_FILES_FOLDER, sync_directory},
    backup_review::{BackupCheck, Ladder, WorkspaceSummary, check_backup, open_backup, summarize},
};

/// How many daily and saved-by-you points are kept; safety copies are kept besides them.
pub const RESTORE_POINTS_KEPT: usize = 7;

const FOLDER_SUFFIX: &str = ".restore-points";
const LOCK: &str = ".lock";

/// Why a restore point was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestorePointKind {
    /// Saved the first time ticketd opened that day.
    Daily,
    /// Saved by the person, with Back up now.
    Manual,
    /// Saved before a restore replaced the Workspace.
    Safety,
    /// Saved before an update changed the Workspace's format.
    PreMigration,
}

/// One copy to go back to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestorePoint {
    /// The file to inspect and restore.
    pub path: String,
    pub kind: RestorePointKind,
    /// When it was saved, as an RFC 3339 timestamp.
    pub saved_at: String,
    /// The file's own size. Attachment files kept for several points are not counted here.
    pub size_bytes: u64,
    /// What it holds; `None` when it could not be read.
    pub summary: Option<WorkspaceSummary>,
    /// Why it cannot be restored, or `None` when it can.
    pub problem: Option<String>,
    /// For a copy saved before an update: the version that updated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_version: Option<String>,
}

/// Every copy to go back to, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestorePointList {
    pub points: Vec<RestorePoint>,
    /// Disk used by all of them, shared files counted once.
    pub total_bytes: u64,
}

/// What is written beside a point once it has been checked.
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    kind: RestorePointKind,
    saved_at: String,
    /// The day it was saved on, in the person's own time zone.
    local_date: String,
    summary: Option<WorkspaceSummary>,
    problem: Option<String>,
    /// The attachment files it needs, by checksum.
    files: Vec<String>,
}

fn io(error: std::io::Error) -> Error {
    Error::Directory(error)
}

impl Workspace {
    /// The folder this Workspace's restore points are kept in. It may not exist yet.
    pub fn restore_points_folder(&self) -> Result<PathBuf, Error> {
        let path = self
            .connection
            .path()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| Error::Backup("this workspace has no file to keep copies of".into()))?;
        let mut name = std::ffi::OsString::from(path);
        name.push(FOLDER_SUFFIX);
        Ok(PathBuf::from(name))
    }

    /// [`Workspace::save_daily_restore_point_at`] for the person's clock.
    pub fn save_daily_restore_point(&self) -> Result<Option<RestorePoint>, Error> {
        self.save_daily_restore_point_at(Local::now().fixed_offset())
    }

    /// Saves today's restore point unless one was already saved today: the first call on each
    /// day does the work. `now` is the person's own time, which decides what a day is. Returns
    /// the new point, or `None` when there was nothing to do (or another process is saving).
    pub fn save_daily_restore_point_at(
        &self,
        now: DateTime<FixedOffset>,
    ) -> Result<Option<RestorePoint>, Error> {
        let folder = self.restore_points_folder()?;
        fs::create_dir_all(&folder).map_err(io)?;
        let Some(_lock) = lock(&folder, false)? else {
            return Ok(None);
        };
        let today = now.date_naive().to_string();
        if records(&folder)?
            .iter()
            .any(|(_, record)| record.kind == RestorePointKind::Daily && record.local_date == today)
        {
            return Ok(None);
        }
        self.save_point(&folder, RestorePointKind::Daily, now)
            .map(Some)
    }

    /// [`Workspace::save_manual_restore_point_at`] for the person's clock.
    pub fn save_manual_restore_point(&self) -> Result<RestorePoint, Error> {
        self.save_manual_restore_point_at(Local::now().fixed_offset())
    }

    /// Saves a restore point now, for Back up now. It needs no file path and replaces nothing.
    pub fn save_manual_restore_point_at(
        &self,
        now: DateTime<FixedOffset>,
    ) -> Result<RestorePoint, Error> {
        let folder = self.restore_points_folder()?;
        fs::create_dir_all(&folder).map_err(io)?;
        let Some(_lock) = lock(&folder, true)? else {
            return Err(Error::Backup(
                "another backup is being saved; try again in a moment".into(),
            ));
        };
        self.save_point(&folder, RestorePointKind::Manual, now)
    }

    /// The restore points and the safety copies saved before restores and updates, newest
    /// first, with what they cost on disk.
    pub fn restore_points(&self) -> Result<RestorePointList, Error> {
        let folder = self.restore_points_folder()?;
        let mut points = Vec::new();
        let mut total_bytes = 0;
        for (stem, record) in records(&folder)? {
            let size_bytes = fs::metadata(point_file(&folder, &stem)).map_or(0, |m| m.len());
            total_bytes += size_bytes;
            let missing = record
                .files
                .iter()
                .any(|hash| !folder.join(SHARED_FILES_FOLDER).join(hash).is_file());
            points.push(RestorePoint {
                path: point_file(&folder, &stem).display().to_string(),
                kind: record.kind,
                saved_at: record.saved_at,
                size_bytes,
                summary: record.summary,
                problem: record.problem.or_else(|| {
                    missing.then(|| "an attachment file it keeps is missing".to_owned())
                }),
                update_version: None,
            });
        }
        total_bytes += directory_bytes(&folder.join(SHARED_FILES_FOLDER));
        for copy in self.safety_backups()? {
            total_bytes += copy.size_bytes;
            let summary = Connection::open_with_flags(
                &copy.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(Error::from)
            .and_then(|connection| summarize(&connection))
            .ok();
            points.push(RestorePoint {
                kind: match copy.kind {
                    crate::SafetyBackupKind::Safety => RestorePointKind::Safety,
                    crate::SafetyBackupKind::PreMigration => RestorePointKind::PreMigration,
                },
                update_version: updated_to(&copy.path),
                problem: summary.is_none().then(|| "it could not be read".to_owned()),
                path: copy.path,
                saved_at: copy.saved_at,
                size_bytes: copy.size_bytes,
                summary,
            });
        }
        // RFC 3339 timestamps in UTC with one precision sort as text.
        points.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then(a.path.cmp(&b.path)));
        Ok(RestorePointList {
            points,
            total_bytes,
        })
    }

    /// Writes, checks and records one point, then keeps the newest seven. The caller holds the
    /// folder's lock.
    fn save_point(
        &self,
        folder: &Path,
        kind: RestorePointKind,
        now: DateTime<FixedOffset>,
    ) -> Result<RestorePoint, Error> {
        clear_unfinished(folder)?;
        let saved = now.with_timezone(&Utc);
        let stem = format!(
            "{}-{}-{}",
            saved.format("%Y%m%dT%H%M%SZ"),
            if kind == RestorePointKind::Daily {
                "daily"
            } else {
                "manual"
            },
            &Uuid::new_v4().simple().to_string()[..8]
        );
        let path = point_file(folder, &stem);
        let uploads = self.attachment_backup_lock()?;
        let store = folder.join(SHARED_FILES_FOLDER);
        save_snapshot_packed(
            &self.connection,
            &self.attachment_directory()?,
            &path,
            true,
            &Packing::Shared(&store),
        )?;
        drop(uploads);
        // The check a restore would make, on the file as saved. A point that fails it is kept
        // and says so: the person finds out now, not when they need it.
        let (summary, problem) = match check(&path) {
            Ok(checked) => checked,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        let record = Record {
            kind,
            saved_at: saved.to_rfc3339_opts(SecondsFormat::Secs, true),
            local_date: now.date_naive().to_string(),
            summary,
            problem,
            files: shared_hashes(&path)?,
        };
        let staged = tempfile::Builder::new()
            .prefix(".tmp")
            .tempfile_in(folder)
            .map_err(io)?;
        serde_json::to_writer(&staged, &record)?;
        staged.as_file().sync_all().map_err(io)?;
        staged
            .persist_noclobber(record_file(folder, &stem))
            .map_err(|error| io(error.error))?;
        sync_directory(folder)?;
        let size_bytes = fs::metadata(&path).map_or(0, |m| m.len());
        prune(folder)?;
        Ok(RestorePoint {
            path: path.display().to_string(),
            kind,
            saved_at: record.saved_at,
            size_bytes,
            summary: record.summary,
            problem: record.problem,
            update_version: None,
        })
    }
}

fn point_file(folder: &Path, stem: &str) -> PathBuf {
    folder.join(format!("{stem}.sqlite3"))
}

fn record_file(folder: &Path, stem: &str) -> PathBuf {
    folder.join(format!("{stem}.json"))
}

/// The version of ticketd that updated the Workspace after this copy was saved.
fn updated_to(path: &str) -> Option<String> {
    let (_, version) = path
        .strip_suffix(".sqlite3")?
        .rsplit_once(PRE_MIGRATION_VERSION_MARKER)?;
    let plain = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+');
    (!version.is_empty() && version.bytes().all(plain)).then(|| version.to_owned())
}

/// The folder's lock. With `wait` it is taken even when another process holds it for a
/// moment; without, a held lock gives `None`.
fn lock(folder: &Path, wait: bool) -> Result<Option<File>, Error> {
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(folder.join(LOCK))
        .map_err(io)?;
    let contended = fs2::lock_contended_error().raw_os_error();
    for _ in 0..if wait { 200 } else { 1 } {
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(Some(file)),
            Err(error) if error.raw_os_error() == contended => {
                if wait {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
            Err(error) => return Err(io(error)),
        }
    }
    Ok(None)
}

/// The points in a folder: those with a readable record, and those whose record is there but
/// cannot be read.
struct Found {
    /// (file stem, record), newest first.
    points: Vec<(String, Record)>,
    /// Stems of points whose record is damaged. They were finished once, so they are not
    /// cleared as unfinished and what they need is not pruned; they are not listed, as
    /// nothing is known about them.
    unreadable: BTreeSet<String>,
}

fn scan(folder: &Path) -> Result<Found, Error> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Found {
                points: Vec::new(),
                unreadable: BTreeSet::new(),
            });
        }
        Err(error) => return Err(io(error)),
    };
    let mut points = Vec::new();
    let mut unreadable = BTreeSet::new();
    for entry in entries {
        let path = entry.map_err(io)?.path();
        let Some(stem) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|stem| !stem.starts_with('.'))
        else {
            continue;
        };
        if !point_file(folder, stem).is_file() {
            continue;
        }
        match fs::read(&path)
            .map_err(Error::from)
            .and_then(|bytes| Ok(serde_json::from_slice::<Record>(&bytes)?))
        {
            Ok(record) => points.push((stem.to_owned(), record)),
            Err(_) => {
                unreadable.insert(stem.to_owned());
            }
        }
    }
    points.sort_by(|a, b| b.1.saved_at.cmp(&a.1.saved_at).then(b.0.cmp(&a.0)));
    Ok(Found { points, unreadable })
}

/// The finished points as (file stem, record), newest first. A record that cannot be read
/// leaves its point out of the list and out of the retention, so it is never deleted.
fn records(folder: &Path) -> Result<Vec<(String, Record)>, Error> {
    Ok(scan(folder)?.points)
}

/// Removes what an interrupted save left: staged files and points that were never recorded.
fn clear_unfinished(folder: &Path) -> Result<(), Error> {
    let found = scan(folder)?;
    let finished: BTreeSet<String> = found
        .points
        .into_iter()
        .map(|(stem, _)| stem)
        .chain(found.unreadable)
        .collect();
    for entry in fs::read_dir(folder).map_err(io)? {
        let path = entry.map_err(io)?.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let unfinished = if name == LOCK || path.is_dir() {
            false
        } else if let Some(stem) = name.strip_suffix(".sqlite3") {
            !finished.contains(stem)
        } else {
            name.starts_with(".tmp")
                || name
                    .strip_suffix(".json")
                    .is_some_and(|stem| !finished.contains(stem))
        };
        if unfinished {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

/// Keeps the newest seven daily and saved-by-you points, then deletes the attachment files
/// that none of the rest needs. A point whose record cannot be read still needs its files:
/// they are read from the point itself, and when even that fails none are deleted.
fn prune(folder: &Path) -> Result<(), Error> {
    let Found {
        points: all,
        unreadable,
    } = scan(folder)?;
    for (stem, _) in all.iter().skip(RESTORE_POINTS_KEPT) {
        // The record goes first: a point without one is cleared as unfinished.
        fs::remove_file(record_file(folder, stem)).map_err(io)?;
        let _ = fs::remove_file(point_file(folder, stem));
    }
    let mut needed: BTreeSet<String> = all
        .iter()
        .take(RESTORE_POINTS_KEPT)
        .flat_map(|(_, record)| record.files.iter().cloned())
        .collect();
    for stem in &unreadable {
        match shared_hashes(&point_file(folder, stem)) {
            Ok(hashes) => needed.extend(hashes),
            Err(_) => return Ok(()),
        }
    }
    let Ok(entries) = fs::read_dir(folder.join(SHARED_FILES_FOLDER)) else {
        return Ok(());
    };
    for entry in entries {
        let path = entry.map_err(io)?.path();
        let kept = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| needed.contains(name));
        if !kept {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

/// What restoring this file would find: its summary, or why it cannot be restored.
fn check(path: &Path) -> Result<(Option<WorkspaceSummary>, Option<String>), Error> {
    let connection = open_backup(path)?;
    Ok(match check_backup(&connection, Ladder::Required)? {
        BackupCheck::Valid { summary, .. } => (Some(summary), None),
        other => (None, other.refusal()),
    })
}

/// The attachment files a saved point needs, by checksum.
fn shared_hashes(path: &Path) -> Result<Vec<String>, Error> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    if !crate::backup::table_exists(&connection, "ticketd_backup_files")? {
        return Ok(Vec::new());
    }
    let mut query = connection.prepare("SELECT DISTINCT sha256 FROM ticketd_backup_files")?;
    let hashes = query
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(hashes)
}

fn directory_bytes(folder: &Path) -> u64 {
    fs::read_dir(folder).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.metadata().ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .sum()
    })
}
