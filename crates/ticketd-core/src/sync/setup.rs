//! Connecting a Workspace to its folder in the storage, the device registry
//! kept there, the full sync run with its recovery states, and what the
//! desktop shows about all of it.
//!
//! One Workspace syncs to one folder. Nothing here deletes a record or a file
//! in the storage; disconnecting only forgets the folder.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Cursor,
    path::PathBuf,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::{
    RecordKind,
    attachments::{AttachmentDownloads, MANIFEST},
    engine::{dirty_kind, touch},
    remote::{RemoteError, RemoteKey, RemoteKind, RemoteStorage},
};
use crate::{Error, SyncKind, Workspace};

/// The shortest time between two polls of the storage.
pub const MIN_POLL_INTERVAL_SECS: u64 = 30;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const REGISTRY: &str = "devices";
/// How many pending uploads the status names; the rest are only counted.
const PENDING_PAGE: usize = 50;
/// The format of the shared JSON files this version writes. A file that says
/// a higher number is not rewritten from here.
const SHARED_FORMAT: u64 = 1;
/// The `sync_files.kind` values of records, as opposed to the shared files.
const RECORDS: &str = "('ticket', 'document', 'plan', 'project')";

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "-- What this device knows about its sync destination. All of it is local.
         CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), connection TEXT, account TEXT, folder TEXT, folder_name TEXT, device_id TEXT, device_name TEXT, poll_interval_secs INTEGER NOT NULL DEFAULT 60, attachment_download TEXT NOT NULL DEFAULT 'automatic', last_synced_at TEXT, recovery TEXT, first_sync TEXT, first_total INTEGER NOT NULL DEFAULT 0);
         INSERT OR IGNORE INTO sync_state (id) VALUES (1);
         -- One row per managed Attachment the storage holds. `failed` is the version
         -- whose bytes did not pass the integrity check.
         CREATE TABLE IF NOT EXISTS sync_attachments (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, version TEXT, state TEXT NOT NULL CHECK (state IN ('downloaded', 'downloading', 'not_downloaded')), progress INTEGER NOT NULL DEFAULT 0, failed TEXT);",
    )?;
    Ok(())
}

/// Format version 60: the message of a failure that has no recovery state of
/// its own, and the mark of a file written in a newer format than this
/// desktop reads.
pub(crate) fn migrate_recovery(connection: &Connection) -> Result<(), Error> {
    add_columns(
        connection,
        &[
            ("sync_state", "recovery_message", "TEXT"),
            ("sync_files", "newer", "INTEGER NOT NULL DEFAULT 0"),
        ],
    )
}

/// Format version 61: the run token this desktop last wrote into its entry of
/// the device registry and the one before it, and how often in a row the
/// download of an Attachment failed.
pub(crate) fn migrate_run_token(connection: &Connection) -> Result<(), Error> {
    add_columns(
        connection,
        &[
            ("sync_state", "run_token", "TEXT"),
            ("sync_state", "run_previous", "TEXT"),
            // Whether the next run writes a fresh token: once per app session.
            ("sync_state", "run_due", "INTEGER NOT NULL DEFAULT 1"),
            // Downloads of the current version that the storage failed in a row.
            ("sync_attachments", "attempts", "INTEGER NOT NULL DEFAULT 0"),
        ],
    )
}

fn add_columns(connection: &Connection, columns: &[(&str, &str, &str)]) -> Result<(), Error> {
    for (table, column, definition) in columns {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !present {
            connection.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition};"
            ))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncConnection {
    NotConnected,
    /// Signed in to the storage; upload or download not chosen yet.
    Choosing,
    Connected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    SavedLocally,
    UploadPending,
    Uploaded,
    AttachmentDownloadPending,
    NeedsAttention,
}

/// Why the last sync run could not use the storage. Local work is kept in
/// every one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRecovery {
    /// The folder is gone, or lists no files where some were synced before.
    FolderMissing,
    AuthorizationExpired,
    StorageFull,
    Offline,
    RateLimited,
    /// Any other failure of a run; the status carries its message.
    Error,
}

/// The one thing that gets sync out of a recovery state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRecoveryAction {
    /// Upload this Workspace again; [`Workspace::sync_recover`] does it.
    Reupload,
    /// Sign in to the storage again, then run [`Workspace::sync_recover`].
    Reconnect,
    Retry,
}

impl SyncRecovery {
    pub fn action(self) -> SyncRecoveryAction {
        match self {
            Self::FolderMissing => SyncRecoveryAction::Reupload,
            Self::AuthorizationExpired => SyncRecoveryAction::Reconnect,
            Self::StorageFull | Self::Offline | Self::RateLimited | Self::Error => {
                SyncRecoveryAction::Retry
            }
        }
    }

    fn of(error: &RemoteError) -> Option<Self> {
        match error {
            RemoteError::FolderMissing => Some(Self::FolderMissing),
            RemoteError::Unauthorized => Some(Self::AuthorizationExpired),
            RemoteError::StorageFull => Some(Self::StorageFull),
            RemoteError::Offline => Some(Self::Offline),
            RemoteError::RateLimited { .. } => Some(Self::RateLimited),
            RemoteError::PreconditionFailed { .. }
            | RemoteError::NotFound
            | RemoteError::Other(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentDownload {
    Automatic,
    /// Bytes are fetched when the person opens the Attachment.
    OnOpen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncSettings {
    /// This desktop's name in the device registry; the computer name until set.
    pub desktop_name: String,
    pub device_code: String,
    pub poll_interval_secs: u64,
    pub attachment_download: AttachmentDownload,
}

/// A record or Attachment named in the status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncItem {
    pub kind: RecordKind,
    pub id: String,
    /// The Ticket reference; `None` for other kinds.
    pub reference: Option<String>,
    /// The record's title or name, or the Attachment's display name.
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncFolder {
    pub id: String,
    pub name: String,
}

/// Progress of the first upload or download after setup, counted in files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstSync {
    pub direction: SyncDirection,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatus {
    pub connection: SyncConnection,
    /// What the desktop stored at sign-in: its storage connection and the account shown.
    pub connection_id: Option<String>,
    pub account: Option<String>,
    pub folder: Option<SyncFolder>,
    pub state: SyncState,
    pub last_synced_at: Option<String>,
    /// Empty unless connected. A saved change is listed as soon as it commits.
    /// Only the oldest few are named; `pending_total` counts all of them.
    pub pending_uploads: Vec<SyncItem>,
    pub pending_total: u64,
    pub attachment_downloads: AttachmentDownloads,
    pub needs_review: Vec<SyncItem>,
    pub recovery: Option<SyncRecovery>,
    /// What went wrong, while `recovery` is [`SyncRecovery::Error`].
    pub recovery_message: Option<String>,
    pub first_sync: Option<FirstSync>,
}

/// Where this Workspace syncs to and as whom: what a host needs to start a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncBinding {
    pub folder_id: String,
    /// The storage sign-in the desktop stored; `None` if it never signed in.
    pub connection_id: Option<String>,
    pub device_name: String,
    pub poll_secs: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncCounts {
    pub tickets: u64,
    pub documents: u64,
    pub attachments: u64,
}

/// A Workspace folder found in the storage, as far as the storage can tell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExistingWorkspace {
    pub folder_id: String,
    pub folder_name: String,
    pub devices: u64,
    /// The desktop that last uploaded a change, and when.
    pub last_synced_by: Option<String>,
    pub last_synced_at: Option<String>,
    pub counts: SyncCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupOptions {
    pub local: SyncCounts,
    pub existing: Vec<ExistingWorkspace>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct RegisteredDevice {
    name: String,
    code: String,
    #[serde(default)]
    last_synced_at: Option<String>,
    /// A random value the desktop replaces on the first run of each app
    /// session and also keeps locally. A desktop that finds another value here than the ones it
    /// wrote is a copy of the Workspace that did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run: Option<String>,
    /// What a newer ticketd keeps here, written back as it was read.
    #[serde(flatten)]
    other: BTreeMap<String, serde_json::Value>,
}

/// The device registry file: every desktop that joined the folder, by device id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    devices: BTreeMap<String, RegisteredDevice>,
    /// Device codes a desktop of this folder held and gave up. Tickets carry
    /// them in their references, so no desktop takes one again.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    retired: BTreeSet<String>,
    #[serde(flatten)]
    other: BTreeMap<String, serde_json::Value>,
}

/// Read a shared JSON file. One that is not JSON at all is replaced by the
/// next write; one in a newer format stops the run instead.
fn read_shared<T: DeserializeOwned + Default>(bytes: &[u8]) -> Result<T, Error> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Ok(T::default());
    };
    let format = value.get("format").and_then(serde_json::Value::as_u64);
    if format.is_some_and(|format| format > SHARED_FORMAT) {
        return Err(Error::Sync(
            "the sync folder was written by a newer ticketd; update ticketd on this desktop to sync with it".into(),
        ));
    }
    Ok(serde_json::from_value(value).unwrap_or_default())
}

fn write_shared<T: Serialize>(value: &T) -> Result<String, Error> {
    let mut json = serde_json::to_value(value)?;
    if let Some(object) = json.as_object_mut() {
        object.insert("format".into(), SHARED_FORMAT.into());
    }
    Ok(serde_json::to_string_pretty(&json)?)
}

struct State {
    connection: Option<String>,
    account: Option<String>,
    folder: Option<String>,
    folder_name: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
    poll_interval_secs: u64,
    attachment_download: AttachmentDownload,
    last_synced_at: Option<String>,
    recovery: Option<SyncRecovery>,
    recovery_message: Option<String>,
    first_sync: Option<SyncDirection>,
    first_total: u64,
    run_token: Option<String>,
    run_previous: Option<String>,
    run_due: bool,
}

/// A unit enum as the text serde gives it, for a column.
fn label<T: Serialize>(value: T) -> Result<String, Error> {
    Ok(serde_json::to_value(value)?
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

fn from_label<T: DeserializeOwned>(text: Option<String>) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(text?)).ok()
}

fn state(connection: &Connection) -> Result<State, Error> {
    Ok(connection.query_row(
        "SELECT connection, account, folder, folder_name, device_id, device_name, poll_interval_secs, attachment_download, last_synced_at, recovery, first_sync, first_total, recovery_message, run_token, run_previous, run_due FROM sync_state",
        [],
        |row| {
            Ok(State {
                connection: row.get(0)?,
                account: row.get(1)?,
                folder: row.get(2)?,
                folder_name: row.get(3)?,
                device_id: row.get(4)?,
                device_name: row.get(5)?,
                poll_interval_secs: row.get(6)?,
                attachment_download: from_label(row.get(7)?)
                    .unwrap_or(AttachmentDownload::Automatic),
                last_synced_at: row.get(8)?,
                recovery: from_label(row.get(9)?),
                first_sync: from_label(row.get(10)?),
                first_total: row.get(11)?,
                recovery_message: row.get(12)?,
                run_token: row.get(13)?,
                run_previous: row.get(14)?,
                run_due: row.get(15)?,
            })
        },
    )?)
}

// ponytail: the environment and /etc/hostname only. A desktop that knows a
// better name sets it through `set_sync_settings`.
fn computer_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .chain(std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().to_owned())
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| "This desktop".into())
}

fn not_connected() -> Error {
    Error::Sync("this Workspace is not connected to a sync folder".into())
}

fn count(connection: &Connection, sql: &str) -> Result<u64, Error> {
    Ok(connection.query_row(sql, [], |row| row.get(0))?)
}

/// Forget what was synced, so the next run uploads every record and every
/// Attachment held here. Attachments not downloaded yet stay known as such.
fn forget_synced(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "DELETE FROM sync_files; DELETE FROM sync_attachments WHERE state = 'downloaded';",
    )?;
    Ok(())
}

/// A download under way has no one left to finish it once the folder is let
/// go of: the row would say `downloading` until the next launch.
const GIVE_UP_DOWNLOADS: &str = "UPDATE sync_attachments SET state = 'not_downloaded', progress = 0 WHERE state = 'downloading';";

/// See [`super::forget_folder`]. The backup may be of an earlier format
/// version, so only what format version 59 has is named.
pub(super) fn forget_folder(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "UPDATE sync_state SET folder = NULL, folder_name = NULL, last_synced_at = NULL, recovery = NULL, first_sync = NULL;",
    )?;
    connection.execute_batch(GIVE_UP_DOWNLOADS)?;
    forget_synced(connection)
}

/// A record as the status names it, or `None` when it is not in this Workspace.
fn item(connection: &Connection, kind: RecordKind, id: &str) -> Result<Option<SyncItem>, Error> {
    let sql = match kind {
        RecordKind::Ticket => "SELECT reference, title FROM tickets WHERE id = ?1",
        RecordKind::Document => "SELECT NULL, COALESCE(title, '') FROM documents WHERE id = ?1",
        RecordKind::Plan => "SELECT NULL, name FROM plans WHERE id = ?1",
        RecordKind::Project => "SELECT NULL, name FROM projects WHERE id = ?1",
        // Named by what the storage holds, not by a mark.
        RecordKind::Attachment => return Ok(None),
    };
    Ok(connection
        .query_row(sql, [id], |row| {
            Ok(SyncItem {
                kind,
                id: id.to_owned(),
                reference: row.get(0)?,
                title: row.get(1)?,
            })
        })
        .optional()?)
}

fn bind(
    connection: &Connection,
    folder: &str,
    name: &str,
    direction: SyncDirection,
) -> Result<(), Error> {
    connection.execute(
        "UPDATE sync_state SET folder = ?1, folder_name = ?2, first_sync = ?3, first_total = 0, recovery = NULL, recovery_message = NULL, last_synced_at = NULL",
        params![folder, name, label(direction)?],
    )?;
    touch(connection)
}

impl Workspace {
    pub fn sync_settings(&self) -> Result<SyncSettings, Error> {
        let state = state(&self.connection)?;
        Ok(SyncSettings {
            desktop_name: state.device_name.unwrap_or_else(computer_name),
            device_code: self.device_code()?,
            poll_interval_secs: state.poll_interval_secs,
            attachment_download: state.attachment_download,
        })
    }

    /// The new name reaches the device registry on the next sync run.
    pub fn set_sync_settings(
        &mut self,
        desktop_name: &str,
        poll_interval_secs: u64,
        attachment_download: AttachmentDownload,
    ) -> Result<SyncSettings, Error> {
        let name: String = desktop_name.chars().filter(|c| !c.is_control()).collect();
        if name.trim().is_empty() {
            return Err(Error::Sync("give this desktop a name".into()));
        }
        if poll_interval_secs < MIN_POLL_INTERVAL_SECS {
            return Err(Error::Sync(format!(
                "check for changes every {MIN_POLL_INTERVAL_SECS} seconds or less often"
            )));
        }
        self.connection.execute(
            "UPDATE sync_state SET device_name = ?1, poll_interval_secs = ?2, attachment_download = ?3",
            params![name.trim(), poll_interval_secs, label(attachment_download)?],
        )?;
        touch(&self.connection)?;
        self.sync_settings()
    }

    /// Remember the storage sign-in, before a folder is chosen. Both values are
    /// the desktop's own: the core only keeps them with the Workspace.
    pub fn sync_connect(
        &mut self,
        connection_id: &str,
        account: &str,
    ) -> Result<SyncStatus, Error> {
        self.connection.execute(
            "UPDATE sync_state SET connection = ?1, account = ?2",
            [connection_id, account],
        )?;
        touch(&self.connection)?;
        self.sync_status()
    }

    /// Stop syncing here. Local content and the folder in the storage stay as they are.
    pub fn sync_disconnect(&mut self) -> Result<SyncStatus, Error> {
        self.connection.execute(
            "UPDATE sync_state SET connection = NULL, account = NULL, folder = NULL, folder_name = NULL, last_synced_at = NULL, recovery = NULL, recovery_message = NULL, first_sync = NULL",
            [],
        )?;
        self.connection.execute_batch(GIVE_UP_DOWNLOADS)?;
        touch(&self.connection)?;
        self.sync_status()
    }

    /// The sync destination, or `None` when no folder is chosen. One small
    /// read, for a host that asks often.
    pub fn sync_binding(&self) -> Result<Option<SyncBinding>, Error> {
        type Row = (Option<String>, Option<String>, Option<String>, u64);
        let (folder, connection_id, name, poll_secs): Row = self.connection.query_row(
            "SELECT folder, connection, device_name, poll_interval_secs FROM sync_state",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        Ok(folder.map(|folder_id| SyncBinding {
            folder_id,
            connection_id,
            device_name: name.unwrap_or_else(computer_name),
            poll_secs,
        }))
    }

    /// How many records in review and notices are unread.
    pub fn sync_unread_count(&self) -> Result<usize, Error> {
        Ok(self.connection.query_row(
            "SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM sync_conflicts GROUP BY kind, id HAVING MIN(read) = 0))
                  + (SELECT COUNT(*) FROM sync_notices WHERE read = 0)",
            [],
            |row| row.get(0),
        )?)
    }

    /// What to show about sync. Reads this Workspace only, never the storage.
    pub fn sync_status(&self) -> Result<SyncStatus, Error> {
        let connection = &self.connection;
        let state = state(connection)?;
        let connected = state.folder.is_some();
        let mut pending_uploads = Vec::new();
        let mut pending_total = 0;
        if connected {
            // A record whose file only a newer ticketd reads is not on its way
            // anywhere: its notice says so instead.
            let mut statement = connection.prepare("SELECT id FROM sync_files WHERE newer")?;
            let held = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<BTreeSet<_>, _>>()?;
            drop(statement);
            for dirty in self.dirty_records()? {
                if pending_uploads.len() == PENDING_PAGE {
                    break;
                }
                if held.contains(&dirty.id) {
                    continue;
                }
                pending_uploads.extend(item(connection, dirty.kind, &dirty.id)?);
            }
            let attachments = super::attachments::pending_uploads(connection)?;
            pending_total = count(
                connection,
                "SELECT COUNT(*) FROM sync_dirty d WHERE d.id NOT IN (SELECT id FROM sync_files WHERE newer) AND ((d.kind = 'ticket' AND d.id IN (SELECT id FROM tickets)) OR (d.kind = 'document' AND d.id IN (SELECT id FROM documents)) OR (d.kind = 'plan' AND d.id IN (SELECT id FROM plans)) OR (d.kind = 'project' AND d.id IN (SELECT id FROM projects)))",
            )? + attachments.len() as u64;
            let room = PENDING_PAGE - pending_uploads.len();
            for (id, title) in attachments.into_iter().take(room) {
                pending_uploads.push(SyncItem {
                    kind: RecordKind::Attachment,
                    id,
                    reference: None,
                    title,
                });
            }
        }
        let mut statement = connection.prepare(
            "SELECT kind, id FROM sync_conflicts GROUP BY kind, id ORDER BY MAX(detected_at) DESC, id",
        )?;
        let conflicting = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut needs_review = Vec::new();
        for (kind, id) in conflicting {
            if let Some(kind) = SyncKind::parse(&kind) {
                needs_review.extend(item(connection, dirty_kind(kind), &id)?);
            }
        }
        let attachment_downloads = if connected {
            super::attachments::downloads(
                connection,
                state.attachment_download == AttachmentDownload::Automatic,
            )?
        } else {
            AttachmentDownloads::default()
        };
        let unreadable = count(
            connection,
            "SELECT COUNT(*) FROM sync_notices WHERE read = 0 AND json_extract(notice, '$.kind') = 'unreadable_file'",
        )?;
        let blocked = matches!(
            state.recovery,
            Some(
                SyncRecovery::FolderMissing
                    | SyncRecovery::AuthorizationExpired
                    | SyncRecovery::StorageFull
                    | SyncRecovery::Error
            )
        );
        let sync_state = if blocked || !needs_review.is_empty() || unreadable > 0 {
            SyncState::NeedsAttention
        } else if !connected || state.recovery.is_some() {
            SyncState::SavedLocally
        } else if pending_total > 0 {
            SyncState::UploadPending
        } else if attachment_downloads.count > 0 {
            SyncState::AttachmentDownloadPending
        } else {
            SyncState::Uploaded
        };
        let first_sync = match state.first_sync {
            Some(direction) if connected => {
                let done = count(
                    connection,
                    &format!(
                        "SELECT (SELECT COUNT(*) FROM sync_files WHERE version IS NOT NULL AND kind IN {RECORDS}) + (SELECT COUNT(*) FROM sync_attachments WHERE state = 'downloaded')"
                    ),
                )?;
                let total = match direction {
                    SyncDirection::Upload => count(
                        connection,
                        "SELECT (SELECT COUNT(*) FROM tickets) + (SELECT COUNT(*) FROM documents) + (SELECT COUNT(*) FROM plans) + (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM attachments WHERE kind = 'local_snapshot')",
                    )?,
                    SyncDirection::Download => state.first_total,
                };
                Some(FirstSync {
                    direction,
                    done: done.min(total),
                    total,
                })
            }
            _ => None,
        };
        Ok(SyncStatus {
            connection: match (&state.folder, &state.connection) {
                (Some(_), _) => SyncConnection::Connected,
                (None, Some(_)) => SyncConnection::Choosing,
                (None, None) => SyncConnection::NotConnected,
            },
            connection_id: state.connection,
            account: state.account,
            folder: state.folder.map(|id| SyncFolder {
                id,
                name: state.folder_name.unwrap_or_default(),
            }),
            state: sync_state,
            last_synced_at: state.last_synced_at,
            pending_uploads,
            pending_total,
            attachment_downloads,
            needs_review,
            recovery_message: state
                .recovery_message
                .filter(|_| state.recovery == Some(SyncRecovery::Error)),
            recovery: state.recovery,
            first_sync,
        })
    }

    /// What this Workspace holds, and the Workspaces already in the storage,
    /// for choosing between uploading and downloading.
    pub fn sync_setup_options(&self, remote: &dyn RemoteStorage) -> Result<SetupOptions, Error> {
        let connection = &self.connection;
        let local = SyncCounts {
            tickets: count(connection, "SELECT COUNT(*) FROM tickets")?,
            documents: count(connection, "SELECT COUNT(*) FROM documents")?,
            attachments: count(
                connection,
                "SELECT COUNT(*) FROM attachments WHERE kind = 'local_snapshot'",
            )?,
        };
        let mut existing = Vec::new();
        for folder in remote.folders()? {
            let listing = match remote.list(&folder.id) {
                Ok(listing) => listing,
                // Removed since it was listed.
                Err(RemoteError::FolderMissing) => continue,
                Err(error) => return Err(error.into()),
            };
            let of = |kind| listing.iter().filter(|file| file.key.kind == kind).count() as u64;
            let registry: Registry = listing
                .iter()
                .find(|file| file.key == RemoteKey::new(RemoteKind::Devices, REGISTRY))
                .and_then(|file| {
                    let mut bytes = Vec::new();
                    remote
                        .download(&folder.id, &file.key, &file.version, &mut bytes)
                        .ok()?;
                    read_shared(&bytes).ok()
                })
                .unwrap_or_default();
            let last = registry
                .devices
                .values()
                .filter(|device| device.last_synced_at.is_some())
                .max_by(|a, b| a.last_synced_at.cmp(&b.last_synced_at));
            existing.push(ExistingWorkspace {
                devices: registry.devices.len() as u64,
                last_synced_by: last.map(|device| device.name.clone()),
                last_synced_at: last.and_then(|device| device.last_synced_at.clone()),
                counts: SyncCounts {
                    tickets: of(RemoteKind::Ticket),
                    documents: of(RemoteKind::Document),
                    attachments: of(RemoteKind::Attachment),
                },
                folder_id: folder.id,
                folder_name: folder.name,
            });
        }
        Ok(SetupOptions { local, existing })
    }

    /// Give this Workspace a folder of its own in the storage, named `name`.
    /// The next [`Workspace::sync_now`] is the first upload.
    ///
    /// The folder is identified by this Workspace's own identity, so a
    /// Workspace that was connected before returns to the same folder.
    pub fn sync_upload_workspace(
        &mut self,
        remote: &dyn RemoteStorage,
        name: &str,
    ) -> Result<SyncStatus, Error> {
        if state(&self.connection)?.folder.is_some() {
            return Err(Error::Sync(
                "this Workspace already syncs to a folder; disconnect it first".into(),
            ));
        }
        let folder = crate::embedded_attachments::workspace_id(&self.connection)?;
        remote.ensure_folder(&folder, name)?;
        forget_synced(&self.connection)?;
        bind(&self.connection, &folder, name, SyncDirection::Upload)?;
        self.sync_status()
    }

    /// Replace this Workspace with the one in `folder_id` of the storage.
    ///
    /// The two are never merged: the local Workspace is saved whole as a safety
    /// backup (returned) and an empty one bound to the folder takes its place,
    /// keeping this desktop's sign-in and sync settings. The next
    /// [`Workspace::sync_now`] on the returned Workspace is the first download.
    /// No other connection to this Workspace may be open.
    pub fn sync_download_workspace(
        self,
        remote: &dyn RemoteStorage,
        folder_id: &str,
    ) -> Result<(Workspace, PathBuf), Error> {
        let folder = remote
            .folders()?
            .into_iter()
            .find(|folder| folder.id == folder_id)
            .ok_or(RemoteError::FolderMissing)?;
        let state = state(&self.connection)?;
        let path = self
            .connection
            .path()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| Error::Sync("this Workspace has no file to replace".into()))?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::Sync("this Workspace has no directory".into()))?;
        let staging = tempfile::Builder::new()
            .prefix(".ticketd-download-")
            .tempdir_in(parent)?;
        let replacement = staging.path().join("backup.sqlite3");
        {
            let empty = Workspace::open(staging.path().join("workspace.sqlite3"))?;
            // Attachment links name the Workspace they belong to, so every device
            // of one Workspace carries the identity its folder is named by.
            empty
                .connection
                .execute("UPDATE attachment_workspace SET id = ?1", [&folder.id])?;
            empty.connection.execute(
                "UPDATE sync_state SET connection = ?1, account = ?2, device_name = ?3, poll_interval_secs = ?4, attachment_download = ?5",
                params![
                    state.connection,
                    state.account,
                    state.device_name,
                    state.poll_interval_secs,
                    label(state.attachment_download)?
                ],
            )?;
            bind(
                &empty.connection,
                &folder.id,
                &folder.name,
                SyncDirection::Download,
            )?;
            empty.backup(&replacement)?;
        }
        drop(self);
        let safety = Workspace::restore_from(&path, &replacement, true)?;
        Ok((Workspace::open(&path)?, safety))
    }

    /// For the host to call once at launch, before its first run: downloads
    /// cut off when the app last stopped start again, and the first run
    /// writes a fresh run token into this desktop's entry of the device
    /// registry, which is how a copy of this Workspace file that also syncs
    /// is found out.
    pub fn start_sync_session(&mut self) -> Result<(), Error> {
        self.connection
            .execute("UPDATE sync_state SET run_due = 1", [])?;
        self.reset_interrupted_downloads()
    }

    /// One full sync run: join the device registry, send Attachment bytes, sync
    /// the records, fetch Attachment bytes.
    ///
    /// A failed run is not an error here: it becomes the status's `recovery`
    /// (with `recovery_message` for a failure that has no state of its own),
    /// and every local change is kept for the next run. `Err` means the
    /// Workspace is not connected or the outcome could not be saved.
    pub fn sync_now(&mut self, remote: &dyn RemoteStorage) -> Result<SyncStatus, Error> {
        let outcome = self.run(remote);
        self.conclude(outcome)
    }

    /// The corrective action of the current recovery state, then a sync run.
    /// A missing folder is created again and this Workspace uploaded to it
    /// whole; every other state is a new attempt (after the desktop signed in
    /// again, for an expired authorization).
    pub fn sync_recover(&mut self, remote: &dyn RemoteStorage) -> Result<SyncStatus, Error> {
        let outcome = (|| {
            let state = state(&self.connection)?;
            if state.recovery == Some(SyncRecovery::FolderMissing) {
                let folder = state.folder.ok_or_else(not_connected)?;
                let name = state.folder_name.unwrap_or_default();
                remote.ensure_folder(&folder, &name)?;
                forget_synced(&self.connection)?;
                bind(&self.connection, &folder, &name, SyncDirection::Upload)?;
            }
            self.run(remote)
        })();
        self.conclude(outcome)
    }

    fn conclude(&mut self, outcome: Result<(), Error>) -> Result<SyncStatus, Error> {
        let before = state(&self.connection)?;
        let (recovery, message) = match outcome {
            Ok(()) => (None, None),
            // Nothing ran, so there is nothing to recover from.
            Err(error) if before.folder.is_none() => return Err(error),
            Err(error) => match &error {
                Error::Remote(remote) if SyncRecovery::of(remote).is_some() => {
                    (SyncRecovery::of(remote), None)
                }
                _ => (Some(SyncRecovery::Error), Some(error.to_string())),
            },
        };
        self.connection.execute(
            "UPDATE sync_state SET recovery = ?1, recovery_message = ?2",
            params![recovery.map(label).transpose()?, message],
        )?;
        if recovery.is_none() {
            self.connection.execute(
                &format!("UPDATE sync_state SET first_sync = NULL, last_synced_at = {NOW}"),
                [],
            )?;
        }
        // Whatever else the run changed moved the change token as it happened.
        // The time of the last sync alone does not: a view that shows it reads
        // the status on its own clock.
        let shown = (before.recovery, &before.recovery_message) != (recovery, &message)
            || (recovery.is_none() && before.first_sync.is_some());
        if shown {
            touch(&self.connection)?;
        }
        self.sync_status()
    }

    fn run(&mut self, remote: &dyn RemoteStorage) -> Result<(), Error> {
        let state = state(&self.connection)?;
        let folder = state.folder.clone().ok_or_else(not_connected)?;
        let listing = remote.list(&folder)?;
        let records = listing
            .iter()
            .filter(|file| !matches!(file.key.kind, RemoteKind::Attachment | RemoteKind::Devices))
            .count();
        // Files that were there and are all gone are a storage problem, never deletions.
        let synced = count(
            &self.connection,
            &format!(
                "SELECT COUNT(*) FROM sync_files WHERE version IS NOT NULL AND kind IN {RECORDS}"
            ),
        )?;
        if records == 0 && synced > 0 {
            return Err(RemoteError::FolderMissing.into());
        }
        if state.first_sync == Some(SyncDirection::Download) {
            let attachments = listing
                .iter()
                .filter(|file| file.key.kind == RemoteKind::Attachment)
                .count();
            self.connection.execute(
                "UPDATE sync_state SET first_total = ?1",
                [(records + attachments) as u64],
            )?;
            touch(&self.connection)?;
        }
        let version = |id: &str| {
            listing
                .iter()
                .find(|file| file.key == RemoteKey::new(RemoteKind::Devices, id))
                .map(|file| file.version.clone())
        };
        let (registry, manifest) = (version(REGISTRY), version(MANIFEST));
        let (device_id, device_name) =
            self.register(remote, &folder, registry.as_deref(), &state)?;
        // Bytes go up before any record that names them.
        self.sync_attachment_records(remote, &folder, manifest.as_deref())?;
        let report = self.sync_listed(remote, &folder, &device_name, listing)?;
        if report.uploaded > 0 {
            let now: String = self
                .connection
                .query_row(&format!("SELECT {NOW}"), [], |row| row.get(0))?;
            let known = self.shared_version(REGISTRY)?;
            self.shared_file::<Registry>(
                remote,
                &folder,
                REGISTRY,
                known.as_deref(),
                &mut |registry| match registry.devices.get_mut(&device_id) {
                    Some(device) => {
                        device.last_synced_at = Some(now.clone());
                        true
                    }
                    None => false,
                },
            )?;
        }
        // Last, so that a download that fails takes nothing else with it.
        if state.attachment_download == AttachmentDownload::Automatic {
            self.download_attachments(remote, &folder)?;
        }
        Ok(())
    }

    /// Make sure the registry lists this device under a code no other device
    /// holds. Returns this device's id and name.
    fn register(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        listed: Option<&str>,
        state: &State,
    ) -> Result<(String, String), Error> {
        let name = state.device_name.clone().unwrap_or_else(computer_name);
        let registry: Registry =
            self.shared_file(remote, folder, REGISTRY, listed, &mut |_| false)?;
        let wrote = [&state.run_token, &state.run_previous];
        let seen = state
            .device_id
            .as_ref()
            .and_then(|id| registry.devices.get(id))
            .and_then(|device| device.run.clone());
        // A run token this desktop did not write: a copy of this Workspace
        // file synced under the same device identity. The one that finds out
        // leaves the entry to the other and joins as a new desktop, which
        // below also gives it a code the other does not hold.
        let copied = seen
            .as_ref()
            .is_some_and(|seen| !wrote.contains(&&Some(seen.clone())));
        let (id, token) = match &state.device_id {
            Some(id) if !copied => {
                // A fresh token once per app session, so that a run with
                // nothing to send writes nothing. The token before is kept
                // because the answer to a write can be lost; a write that
                // did not arrive is repeated as it was.
                let token = match &state.run_token {
                    Some(token) if !(state.run_due && seen == state.run_token) => token.clone(),
                    _ => Uuid::new_v4().to_string(),
                };
                (id.clone(), token)
            }
            _ => (Uuid::new_v4().to_string(), Uuid::new_v4().to_string()),
        };
        let (id, token) = if state.run_token.as_ref() == Some(&token) {
            (id, token)
        } else {
            let previous = state.run_token.as_ref().filter(|_| !copied);
            // Only if the Workspace still stores what this run read: another
            // process on the same Workspace file may have run meanwhile, and
            // the file and the registry must not end up with tokens from
            // different processes.
            let stored = self.connection.execute(
                "UPDATE sync_state SET device_id = ?1, run_token = ?2, run_previous = ?3 WHERE device_id IS ?4 AND run_token IS ?5",
                params![id, token, previous, state.device_id, state.run_token],
            )?;
            if stored == 1 {
                (id, token)
            } else {
                // What that process stored is this desktop's identity too.
                let now: (Option<String>, Option<String>) = self.connection.query_row(
                    "SELECT device_id, run_token FROM sync_state",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                match now {
                    (Some(id), Some(token)) => (id, token),
                    _ => {
                        return Err(Error::Sync(
                            "another ticketd process changed this desktop's sync identity; sync will try again".into(),
                        ));
                    }
                }
            }
        };
        let holder = |code: &str| {
            registry
                .devices
                .iter()
                .filter(|(other, device)| **other != id && device.code == code)
                .map(|(other, _)| other.clone())
                .min()
        };
        let mut code = self.device_code()?;
        // A device that is joining gives way, also to a code that was given up:
        // tickets made under it are still around. Of two that joined at the
        // same moment with one code, the one with the later id gives way.
        let joined = registry.devices.contains_key(&id);
        if (!joined && registry.retired.contains(&code))
            || holder(&code).is_some_and(|other| !joined || other < id)
        {
            while holder(&code).is_some() || registry.retired.contains(&code) {
                code = self.renew_device_code()?;
            }
        }
        let known = self.shared_version(REGISTRY)?;
        self.shared_file::<Registry>(
            remote,
            folder,
            REGISTRY,
            known.as_deref(),
            &mut |registry| {
                let Registry {
                    devices, retired, ..
                } = registry;
                let device = devices.entry(id.clone()).or_default();
                if device.name == name && device.code == code && device.run.as_ref() == Some(&token)
                {
                    return false;
                }
                device.run = Some(token.clone());
                device.name.clone_from(&name);
                let before = std::mem::replace(&mut device.code, code.clone());
                if !before.is_empty() && before != code {
                    retired.insert(before);
                }
                true
            },
        )?;
        if state.run_due {
            self.connection
                .execute("UPDATE sync_state SET run_due = 0", [])?;
        }
        Ok((id, name))
    }

    /// The version of a shared file as this device last read or wrote it.
    pub(super) fn shared_version(&self, id: &str) -> Result<Option<String>, Error> {
        Ok(self
            .connection
            .query_row(
                "SELECT version FROM sync_files WHERE kind = 'devices' AND id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    /// Read a small JSON file that every device of the folder writes, apply
    /// `change` to it, and write it back if `change` says it changed anything.
    ///
    /// `current` is the file's version in the storage as far as the caller
    /// knows, `None` when it is not there. When another device wrote first, the
    /// change is applied again to what that device wrote, so two devices
    /// writing at once both end up in the file. Where the storage cannot refuse
    /// a late write (Drive), an entry can still be replaced: `change` is run on
    /// every sync run, which puts a missing entry back.
    pub(super) fn shared_file<T: Serialize + DeserializeOwned + Default>(
        &self,
        remote: &dyn RemoteStorage,
        folder: &str,
        id: &str,
        current: Option<&str>,
        change: &mut dyn FnMut(&mut T) -> bool,
    ) -> Result<T, Error> {
        let key = RemoteKey::new(RemoteKind::Devices, id);
        let fetch = |version: &str| -> Result<Option<T>, Error> {
            let mut bytes = Vec::new();
            match remote.download(folder, &key, version, &mut bytes) {
                Ok(()) => Ok(Some(read_shared(&bytes)?)),
                Err(RemoteError::NotFound) => Ok(None),
                Err(error) => Err(error.into()),
            }
        };
        let cached: Option<(Option<String>, Option<String>)> = self
            .connection
            .query_row(
                "SELECT version, content FROM sync_files WHERE kind = 'devices' AND id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let mut version = current.map(str::to_owned);
        let mut value: T = match (&version, cached) {
            (Some(current), Some((Some(seen), Some(content)))) if *current == seen => {
                read_shared(content.as_bytes())?
            }
            (Some(current), _) => match fetch(current)? {
                Some(value) => value,
                None => {
                    version = None;
                    T::default()
                }
            },
            (None, _) => T::default(),
        };
        // Each failed attempt means another device got its write in, so a few
        // attempts are plenty for a handful of desktops.
        for _ in 0..5 {
            let text = if change(&mut value) {
                let text = write_shared(&value)?;
                match remote.write(
                    folder,
                    &key,
                    &format!("{id}.json"),
                    version.as_deref(),
                    &mut Cursor::new(text.as_bytes()),
                ) {
                    Ok(file) => version = Some(file.version),
                    Err(RemoteError::PreconditionFailed { current }) => {
                        let read = match &current {
                            Some(file) => fetch(&file.version)?,
                            None => None,
                        };
                        version = current.map(|file| file.version).filter(|_| read.is_some());
                        value = read.unwrap_or_default();
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                }
                text
            } else {
                write_shared(&value)?
            };
            self.connection.execute(
                "INSERT INTO sync_files (kind, id, version, content) VALUES ('devices', ?1, ?2, ?3)
                 ON CONFLICT(kind, id) DO UPDATE SET version = excluded.version, content = excluded.content",
                params![id, version, text],
            )?;
            return Ok(value);
        }
        Err(RemoteError::Other(format!(
            "{id}.json kept changing in the storage; sync will try again"
        ))
        .into())
    }
}
