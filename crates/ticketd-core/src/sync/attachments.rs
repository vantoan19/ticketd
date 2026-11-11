//! Managed Attachments in the storage: the bytes of each are one file, and a
//! shared manifest describes them, so a device can list an Attachment it has
//! not downloaded and check the bytes when it does.
//!
//! A managed Attachment is an immutable snapshot, so its bytes are written
//! once. Only its display name can change afterwards. Attachments that
//! reference a file elsewhere are not synced.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    time::{Duration, Instant},
};

use super::{
    RecordKind, SyncNoticeKind,
    engine::{notify, touch},
    remote::{RemoteError, RemoteKey, RemoteKind, RemoteStorage, digest},
};
use crate::{Error, Workspace, attachments};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The id of the manifest file, beside the device registry.
pub(super) const MANIFEST: &str = "attachments";
/// How many received bytes pass between two saved progress values. Small, so
/// that a slow transfer still shows as moving to whoever waits for it.
// ponytail: progress moves as the storage hands bytes over (Drive: 256 KiB
// ranges), so a transfer slower than one such piece a minute still reads as
// stalled to a waiting open; have the adapter report bytes within a range if
// such links have to be waited out.
const PROGRESS_STEP: u64 = 64 * 1024;
/// `sync_attachments.failed` of an Attachment whose bytes on this device are
/// missing or damaged, so they cannot be uploaded.
const UNREADABLE_HERE: &str = "local";
/// How long a download on another connection may show no progress before an
/// open that waits for it gives up.
const STALLED: Duration = Duration::from_secs(60);
/// How many downloads of one Attachment the storage may fail in a row before
/// runs stop trying it.
const DOWNLOAD_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    /// The display name.
    name: String,
    filename: String,
    size: u64,
    sha256: String,
    /// The version of the bytes file in the storage.
    version: String,
    #[serde(default)]
    added_at: Option<String>,
    /// What a newer ticketd keeps here, written back as it was read.
    #[serde(flatten)]
    other: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    attachments: BTreeMap<String, Entry>,
    #[serde(flatten)]
    other: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentAvailabilityState {
    Downloaded,
    Downloading,
    NotDownloaded,
}

/// Whether an Attachment's bytes are on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentAvailability {
    pub id: String,
    pub state: AttachmentAvailabilityState,
    /// Percent received, while downloading.
    pub progress: Option<u8>,
}

/// Attachment bytes this device is still to fetch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentDownloads {
    pub count: u64,
    pub bytes_left: u64,
}

/// What a manifest entry must satisfy before any of it names a local file.
fn usable(id: &str, entry: &Entry) -> bool {
    crate::sync_files::is_guid(id)
        && attachments::valid_filename(&entry.filename)
        && !entry.name.trim().is_empty()
        && entry.sha256.len() == 64
        && entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        && i64::try_from(entry.size).is_ok()
}

/// Managed Attachments held here that the storage does not hold yet: id and
/// display name. One whose bytes could not be read here is reported by a
/// notice instead, and is listed only for `retrying`.
fn awaiting_upload(
    connection: &Connection,
    retrying: bool,
) -> Result<Vec<(String, String)>, Error> {
    let mut statement = connection.prepare(
        "SELECT id, display_name FROM attachments WHERE kind = 'local_snapshot' AND quarantined = 0 AND purge_state = 'retained'
         AND id NOT IN (SELECT id FROM sync_attachments WHERE NOT (?1 AND failed IS ?2 AND version IS NULL)) ORDER BY rowid",
    )?;
    Ok(statement
        .query_map(params![retrying, UNREADABLE_HERE], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<_, _>>()?)
}

/// What the status lists as Attachments still to upload.
pub(super) fn pending_uploads(connection: &Connection) -> Result<Vec<(String, String)>, Error> {
    awaiting_upload(connection, false)
}

/// What is downloading now, plus everything not downloaded when downloads are automatic.
pub(super) fn downloads(
    connection: &Connection,
    automatic: bool,
) -> Result<AttachmentDownloads, Error> {
    Ok(connection.query_row(
        "SELECT COUNT(*), COALESCE(SUM(MAX(a.size_bytes - s.progress, 0)), 0) FROM sync_attachments s JOIN attachments a ON a.id = s.id
         WHERE s.state = 'downloading' OR (?1 AND s.state = 'not_downloaded')",
        [automatic],
        |row| {
            Ok(AttachmentDownloads {
                count: row.get(0)?,
                bytes_left: row.get(1)?,
            })
        },
    )?)
}

/// Writes received bytes to the staged file, hashing them and saving how far
/// the download is so another connection can show it.
struct Receiving<'a> {
    file: File,
    hash: Sha256,
    received: u64,
    saved: u64,
    connection: &'a Connection,
    id: &'a str,
    /// Why a write failed here. The storage reports any failed write of its
    /// output as a failure of its own, so this is how a fault of this device
    /// (a full disk) is told from one of the storage.
    fault: Option<std::io::Error>,
}

impl Write for Receiving<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.receive(bytes).inspect_err(|error| {
            self.fault = Some(std::io::Error::new(error.kind(), error.to_string()));
        })
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

impl Receiving<'_> {
    fn receive(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.file.write(bytes)?;
        self.hash.update(&bytes[..written]);
        self.received += written as u64;
        if self.received - self.saved >= PROGRESS_STEP {
            self.saved = self.received;
            self.connection
                .execute(
                    "UPDATE sync_attachments SET progress = ?2 WHERE id = ?1",
                    params![self.id, self.received],
                )
                .map_err(std::io::Error::other)?;
        }
        Ok(written)
    }
}

fn hex(hash: Sha256) -> String {
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Workspace {
    /// Upload the bytes of Attachments the storage does not hold, then bring
    /// the manifest and this Workspace's Attachment records in line. Runs
    /// before records sync, so a record never names an Attachment whose bytes
    /// are not in the storage or whose record is not here.
    pub(super) fn sync_attachment_records(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        manifest: Option<&str>,
    ) -> Result<(), Error> {
        let marks: Vec<_> = self
            .dirty_records()?
            .into_iter()
            .filter(|dirty| dirty.kind == RecordKind::Attachment)
            .collect();
        let changed: BTreeSet<&str> = marks.iter().map(|dirty| dirty.id.as_str()).collect();
        // The display name of each changed Attachment, to publish in the manifest.
        let mut renamed = BTreeMap::new();
        for id in &changed {
            let name: Option<String> = self
                .connection
                .query_row(
                    "SELECT display_name FROM attachments WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            renamed.extend(name.map(|name| ((*id).to_owned(), name)));
        }

        let mut uploaded = BTreeSet::new();
        for (id, _) in awaiting_upload(&self.connection, true)? {
            let attachment = attachments::read_attachment(&self.connection, &id)?;
            let readable = attachments::validate_attachment_bytes(&self.connection, &attachment)
                .and_then(|path| Ok(File::open(path)?))
                .and_then(|mut file| {
                    let (sha256, _) = digest(&mut file)?;
                    Ok((file, sha256))
                });
            let (mut file, sha256) = match readable {
                Ok(readable) => readable,
                // Bytes that are missing or damaged here cannot be offered to
                // other devices. That is this one Attachment's trouble: it is
                // reported once and tried again by each run, without holding
                // up the rest or counting as an upload that is on its way.
                Err(error) => {
                    self.connection.execute(
                        "INSERT INTO sync_attachments (id, sha256, state, failed) VALUES (?1, '', 'downloaded', ?2) ON CONFLICT(id) DO NOTHING",
                        params![id, UNREADABLE_HERE],
                    )?;
                    notify(
                        &self.connection,
                        &format!("attachment-here:{id}"),
                        &SyncNoticeKind::UnreadableFile {
                            path: format!("attachments/{}", attachment.original_filename),
                            reason: error.to_string(),
                        },
                    )?;
                    continue;
                }
            };
            let key = RemoteKey::new(RemoteKind::Attachment, id.clone());
            let stored =
                match remote.write(folder, &key, &attachment.original_filename, None, &mut file) {
                    Ok(stored) => stored,
                    // Already there, from an interrupted run or another device.
                    Err(RemoteError::PreconditionFailed {
                        current: Some(stored),
                    }) => stored,
                    Err(error) => return Err(error.into()),
                };
            self.connection.execute(
                "INSERT INTO sync_attachments (id, sha256, version, state) VALUES (?1, ?2, ?3, 'downloaded')
                 ON CONFLICT(id) DO UPDATE SET sha256 = excluded.sha256, version = excluded.version, failed = NULL",
                params![id, sha256, stored.version],
            )?;
            touch(&self.connection)?;
            uploaded.insert(id);
        }

        let mut statement = self.connection.prepare(
            "SELECT a.id, a.display_name, a.original_filename, a.size_bytes, s.sha256, s.version, a.added_at FROM attachments a JOIN sync_attachments s ON s.id = a.id
             WHERE s.state = 'downloaded' AND s.version IS NOT NULL AND a.size_bytes IS NOT NULL",
        )?;
        let held: Vec<(String, Entry)> = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    Entry {
                        name: row.get(1)?,
                        filename: row.get(2)?,
                        size: row.get(3)?,
                        sha256: row.get(4)?,
                        version: row.get(5)?,
                        added_at: row.get(6)?,
                        other: BTreeMap::new(),
                    },
                ))
            })?
            .collect::<Result<_, _>>()?;
        drop(statement);
        let manifest: Manifest = self.shared_file(
            remote,
            folder,
            MANIFEST,
            manifest,
            &mut |manifest: &mut Manifest| {
                let mut written = false;
                for (id, entry) in &held {
                    match manifest.attachments.get_mut(id) {
                        None => {
                            manifest.attachments.insert(id.clone(), entry.clone());
                            written = true;
                        }
                        Some(listed) => {
                            // Only the device that just wrote the bytes knows better
                            // than the manifest where they are.
                            if uploaded.contains(id) && listed.version != entry.version {
                                listed.version.clone_from(&entry.version);
                                listed.sha256.clone_from(&entry.sha256);
                                written = true;
                            }
                        }
                    }
                }
                // A rename is published whether or not the bytes are here.
                for (id, name) in &renamed {
                    if let Some(listed) = manifest.attachments.get_mut(id)
                        && listed.name != *name
                    {
                        listed.name.clone_from(name);
                        written = true;
                    }
                }
                written
            },
        )?;

        self.applying_incoming(None, |workspace| {
            let connection = &workspace.connection;
            for (id, entry) in &manifest.attachments {
                if !usable(id, entry) {
                    continue;
                }
                let local: Option<String> = connection
                    .query_row(
                        "SELECT display_name FROM attachments WHERE id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match local {
                    None => {
                        connection.execute(
                            "INSERT INTO attachments (id, display_name, original_filename, size_bytes, kind, locator, added_at) VALUES (?1, ?2, ?3, ?4, 'local_snapshot', ?5, ?6)",
                            params![
                                id,
                                entry.name,
                                entry.filename,
                                entry.size,
                                format!("{id}/bytes/{}", entry.filename),
                                entry.added_at
                            ],
                        )?;
                        connection.execute(
                            "INSERT INTO sync_attachments (id, sha256, version, state) VALUES (?1, ?2, ?3, 'not_downloaded')",
                            params![id, entry.sha256, entry.version],
                        )?;
                    }
                    Some(name) => {
                        if name != entry.name && !changed.contains(id.as_str()) {
                            connection.execute(
                                "UPDATE attachments SET display_name = ?2 WHERE id = ?1",
                                params![id, entry.name],
                            )?;
                        }
                        connection.execute(
                            "UPDATE sync_attachments SET version = ?2, sha256 = ?3, attempts = 0 WHERE id = ?1 AND state != 'downloaded' AND version IS NOT ?2",
                            params![id, entry.version, entry.sha256],
                        )?;
                    }
                }
            }
            Ok(())
        })?;
        for mark in &marks {
            // An Attachment the manifest does not list gets its entry, with the
            // name it has then, when its bytes upload.
            let published = match (renamed.get(&mark.id), manifest.attachments.get(&mark.id)) {
                (Some(name), Some(listed)) => listed.name == *name,
                _ => true,
            };
            if published {
                self.clear_dirty(mark)?;
            }
        }
        Ok(())
    }

    /// Fetch every Attachment not downloaded yet. One whose bytes are missing
    /// from the storage, fail the integrity check or cannot be saved here is
    /// left for later and does not stop the others or fail the run; one that
    /// another connection is fetching is left to it.
    pub(super) fn download_attachments(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
    ) -> Result<(), Error> {
        let mut statement = self.connection.prepare(
            "SELECT id FROM sync_attachments WHERE state = 'not_downloaded' AND version IS NOT NULL AND failed IS NOT version ORDER BY id",
        )?;
        let waiting: Vec<String> = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        drop(statement);
        let mut failed = None;
        for id in waiting {
            match self.fetch_attachment(remote, folder, &id, false) {
                Ok(()) => {}
                // Recorded where it happened.
                Err(
                    Error::Attachment(_)
                    | Error::Directory(_)
                    | Error::Remote(RemoteError::NotFound),
                ) => {}
                // A failure of the storage that may well pass: the others are
                // still tried, and the run fails with it so the next one
                // tries again and nothing is left to read once it worked.
                Err(error @ Error::Remote(RemoteError::Other(_))) => {
                    failed.get_or_insert(error);
                }
                Err(error) => return Err(error),
            }
        }
        failed.map_or(Ok(()), Err)
    }

    /// Give up the downloads that were under way when the app last stopped,
    /// so they start again. For the host to call once at launch, before its
    /// first run: while the app runs, a download under way belongs to the
    /// connection fetching it.
    pub fn reset_interrupted_downloads(&mut self) -> Result<(), Error> {
        let reset = self.connection.execute(
            "UPDATE sync_attachments SET state = 'not_downloaded', progress = 0 WHERE state = 'downloading'",
            [],
        )?;
        if reset > 0 {
            touch(&self.connection)?;
        }
        Ok(())
    }

    /// Fetch one Attachment's bytes now, for opening it. Does nothing when
    /// they are already here, and waits when another connection (a scheduled
    /// run, another open) is fetching them.
    pub fn download_attachment(
        &mut self,
        remote: &dyn RemoteStorage,
        id: &str,
    ) -> Result<(), Error> {
        let folder: Option<String> =
            self.connection
                .query_row("SELECT folder FROM sync_state", [], |row| row.get(0))?;
        let folder = folder.ok_or_else(|| {
            Error::Sync("this Workspace is not connected to a sync folder".into())
        })?;
        self.fetch_attachment(remote, &folder, id, true)
    }

    /// Whether each Attachment's bytes are on this device. Ids that are not
    /// Attachments of this Workspace are left out.
    pub fn attachment_availability(
        &self,
        ids: &[String],
    ) -> Result<Vec<AttachmentAvailability>, Error> {
        let mut found = Vec::new();
        for id in ids {
            let row: Option<(Option<String>, Option<u64>, Option<u64>)> = self
                .connection
                .query_row(
                    "SELECT s.state, s.progress, a.size_bytes FROM attachments a LEFT JOIN sync_attachments s ON s.id = a.id WHERE a.id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((state, progress, size)) = row else {
                continue;
            };
            let state = match state.as_deref() {
                Some("downloading") => AttachmentAvailabilityState::Downloading,
                Some("not_downloaded") => AttachmentAvailabilityState::NotDownloaded,
                // An Attachment added here, or one that sync does not carry.
                _ => AttachmentAvailabilityState::Downloaded,
            };
            let progress = match (state, progress, size) {
                (AttachmentAvailabilityState::Downloading, Some(received), Some(size)) => {
                    Some((received.saturating_mul(100) / size.max(1)).min(100) as u8)
                }
                _ => None,
            };
            found.push(AttachmentAvailability {
                id: id.clone(),
                state,
                progress,
            });
        }
        Ok(found)
    }

    /// Wait while another connection fetches an Attachment's bytes.
    fn await_download(&self, id: &str, name: &str) -> Result<(), Error> {
        let mut moved: (Option<u64>, Instant) = (None, Instant::now());
        loop {
            let progress: Option<u64> = self
                .connection
                .query_row(
                    "SELECT progress FROM sync_attachments WHERE id = ?1 AND state = 'downloading'",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(progress) = progress else {
                return Ok(());
            };
            if moved.0 != Some(progress) {
                moved = (Some(progress), Instant::now());
            } else if moved.1.elapsed() > STALLED {
                return Err(Error::Attachment(format!(
                    "'{name}' is being downloaded and has not moved for a minute; try again"
                )));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Fetch one Attachment's bytes unless they are here. A row in state
    /// `downloading` belongs to the connection that set it: with `wait` this
    /// call waits for that download and uses its result, without it the
    /// Attachment is left to its owner.
    ///
    /// A fault of this device (no room, no permission, something in the way)
    /// needs the person, so it is told once per Attachment wherever in the
    /// fetch it happens. A failure of the storage for this one file fails the
    /// caller's run the first few times and then becomes a notice too; being
    /// offline or signed out is the caller's to report.
    fn fetch_attachment(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        id: &str,
        wait: bool,
    ) -> Result<(), Error> {
        let attachment = attachments::read_attachment(&self.connection, id)?;
        let fetched = self.fetch_bytes(remote, folder, id, &attachment, wait);
        if let Err(error @ Error::Directory(_)) = &fetched {
            notify(
                &self.connection,
                &format!("attachment-save:{id}"),
                &SyncNoticeKind::UnreadableFile {
                    path: format!("attachments/{}", attachment.original_filename),
                    reason: error.to_string(),
                },
            )?;
        }
        fetched
    }

    fn fetch_bytes(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        id: &str,
        attachment: &attachments::Attachment,
        wait: bool,
    ) -> Result<(), Error> {
        let filename = attachment.original_filename.as_str();
        let size = attachment.size_bytes.unwrap_or_default();
        let set = |state: &str| -> Result<(), Error> {
            self.connection.execute(
                "UPDATE sync_attachments SET state = ?2, progress = 0 WHERE id = ?1",
                [id, state],
            )?;
            touch(&self.connection)
        };
        let root = self.attachment_directory()?;
        fs::create_dir_all(&root)?;
        let target = root.join(id);
        let existing = target.join("bytes").join(filename);
        let (sha256, version) = loop {
            type Row = (String, Option<String>, String);
            let row: Option<Row> = self
                .connection
                .query_row(
                    "SELECT sha256, version, state FROM sync_attachments WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((sha256, version, state)) = row else {
                return Ok(());
            };
            if state == "downloaded" {
                return Ok(());
            }
            if state == "downloading" {
                if !wait {
                    return Ok(());
                }
                self.await_download(id, &attachment.display_name)?;
                continue;
            }
            let version = version.ok_or(RemoteError::NotFound)?;
            if existing.is_file() {
                // Left by a download that finished just before the app stopped.
                if digest(&mut File::open(&existing)?)? == (sha256, size) {
                    return set("downloaded");
                }
                let reason = format!(
                    "'{}' has other content on this device than was uploaded; its files were left as they are",
                    attachment.display_name
                );
                notify(
                    &self.connection,
                    &format!("attachment-save:{id}"),
                    &SyncNoticeKind::UnreadableFile {
                        path: format!("attachments/{filename}"),
                        reason: reason.clone(),
                    },
                )?;
                return Err(Error::Attachment(reason));
            }
            // Only one connection gets the row from `not_downloaded`.
            let claimed = self.connection.execute(
                "UPDATE sync_attachments SET state = 'downloading', progress = 0 WHERE id = ?1 AND state = 'not_downloaded'",
                [id],
            )?;
            if claimed == 1 {
                touch(&self.connection)?;
                break (sha256, version);
            }
        };
        let received = (|| -> Result<bool, Error> {
            // The prefix that backups and upload recovery already skip.
            let staged = tempfile::Builder::new()
                .prefix(".upload-")
                .tempdir_in(&root)?;
            fs::create_dir(staged.path().join("bytes"))?;
            let mut output = Receiving {
                file: File::create(staged.path().join("bytes").join(filename))?,
                hash: Sha256::new(),
                received: 0,
                saved: 0,
                connection: &self.connection,
                id,
                fault: None,
            };
            let key = RemoteKey::new(RemoteKind::Attachment, id);
            if let Err(error) = remote.download(folder, &key, &version, &mut output) {
                return Err(match output.fault.take() {
                    Some(fault) => Error::Directory(fault),
                    None => error.into(),
                });
            }
            let Receiving {
                file,
                hash,
                received,
                ..
            } = output;
            file.sync_all()?;
            // Windows does not move a directory with an open file in it.
            drop(file);
            if received < size {
                // Cut short on the way, which need not say anything about the file.
                return Err(RemoteError::Other(
                    "the download stopped before all of it arrived".into(),
                )
                .into());
            }
            if (hex(hash), received) != (sha256.clone(), size) {
                return Ok(false);
            }
            let _uploads = attachments::lock_uploads(&root)?;
            if let Err(error) = fs::rename(staged.path(), &target) {
                // Something is there already. If it is these very bytes, they are here.
                let same = existing.is_file()
                    && digest(&mut File::open(&existing)?)? == (sha256.clone(), size);
                if !same {
                    return Err(error.into());
                }
            }
            attachments::sync_directory(&root)?;
            Ok(true)
        })();
        match received {
            Ok(true) => {
                self.connection.execute(
                    "UPDATE sync_attachments SET attempts = 0, failed = NULL WHERE id = ?1",
                    [id],
                )?;
                set("downloaded")
            }
            Ok(false) => {
                self.connection.execute(
                    "UPDATE sync_attachments SET failed = ?2 WHERE id = ?1",
                    [id, version.as_str()],
                )?;
                set("not_downloaded")?;
                let reason = "the downloaded bytes are not the ones that were uploaded";
                notify(
                    &self.connection,
                    &format!("attachment:{id}:{version}"),
                    &SyncNoticeKind::UnreadableFile {
                        path: format!("attachments/{filename}"),
                        reason: reason.into(),
                    },
                )?;
                Err(Error::Attachment(format!(
                    "'{}' could not be downloaded: {reason}",
                    attachment.display_name
                )))
            }
            // A failure of the storage for this one file. It may pass, so the
            // first few fail the run, which tries again and leaves nothing to
            // read once it worked. One that keeps coming back is this file's
            // trouble: it is told once and left to an explicit download, so
            // that it does not fail every run from then on.
            Err(Error::Remote(RemoteError::Other(reason))) => {
                set("not_downloaded")?;
                let attempts: u32 = self.connection.query_row(
                    "UPDATE sync_attachments SET attempts = attempts + 1 WHERE id = ?1 RETURNING attempts",
                    [id],
                    |row| row.get(0),
                )?;
                let message = format!(
                    "'{}' could not be downloaded: {reason}",
                    attachment.display_name
                );
                if attempts < DOWNLOAD_ATTEMPTS {
                    return Err(RemoteError::Other(message).into());
                }
                self.connection.execute(
                    "UPDATE sync_attachments SET failed = ?2 WHERE id = ?1",
                    [id, version.as_str()],
                )?;
                notify(
                    &self.connection,
                    &format!("attachment-fetch:{id}:{version}"),
                    &SyncNoticeKind::UnreadableFile {
                        path: format!("attachments/{filename}"),
                        reason,
                    },
                )?;
                Err(Error::Attachment(message))
            }
            Err(error) => {
                set("not_downloaded")?;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)] // Setup that fails must fail the test.

    use super::*;

    #[test]
    fn a_write_that_fails_on_this_device_is_kept_apart_from_a_failure_of_the_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bytes");
        fs::write(&path, "").unwrap();
        let connection = Connection::open_in_memory().unwrap();
        let mut receiving = Receiving {
            // Opened for reading only, so no byte can be written to it.
            file: File::open(&path).unwrap(),
            hash: Sha256::new(),
            received: 0,
            saved: 0,
            connection: &connection,
            id: "attachment",
            fault: None,
        };

        assert!(receiving.write_all(b"downloaded bytes").is_err());

        assert!(receiving.fault.is_some());
        assert_eq!(receiving.received, 0);
    }
}
