//! Connecting a Workspace to its folder in the storage, the device registry
//! kept there, the full sync run with its recovery states, and what the
//! desktop shows about all of it.
//!
//! One Workspace syncs to one folder. Nothing here deletes a record or a file
//! in the storage; disconnecting only forgets the folder.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::{
    RecordKind,
    attachments::{AttachmentDownloads, MANIFEST},
    engine::{HELD_FILE_IDS, dirty_kind, touch},
    remote::{RemoteError, RemoteFile, RemoteFolder, RemoteKey, RemoteKind, RemoteStorage},
};
use crate::{
    Error, SyncKind, Workspace,
    s3::{S3Target, checked_prefix},
    sync_files::MAX_FILE_BYTES,
};

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
const RECORDS: &str = "('ticket', 'document', 'plan', 'project', 'automation_agent', 'automation')";

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
/// the device registry and the one before it.
pub(crate) fn migrate_run_token(connection: &Connection) -> Result<(), Error> {
    add_columns(
        connection,
        &[
            ("sync_state", "run_token", "TEXT"),
            ("sync_state", "run_previous", "TEXT"),
            // Whether the next run writes a fresh token: once per app session.
            ("sync_state", "run_due", "INTEGER NOT NULL DEFAULT 1"),
        ],
    )
}

/// Format version 62: how often in a row the download of an Attachment's
/// current version failed. Format 61 was in use before this column existed.
pub(crate) fn migrate_download_attempts(connection: &Connection) -> Result<(), Error> {
    add_columns(
        connection,
        &[("sync_attachments", "attempts", "INTEGER NOT NULL DEFAULT 0")],
    )
}

/// Format version 63: the storage's identity of the file each record was last
/// synced with, so another file for the same record is recognised.
pub(crate) fn migrate_file_identity(connection: &Connection) -> Result<(), Error> {
    add_columns(connection, &[("sync_files", "file", "TEXT")])
}

/// Format version 64: when the storage made that file, which tells an older
/// file that came back from one written after it.
pub(crate) fn migrate_file_created(connection: &Connection) -> Result<(), Error> {
    add_columns(connection, &[("sync_files", "file_created", "TEXT")])
}

/// Format version 65: the folder this Workspace synced with until it was
/// disconnected, and the account that folder is in, for reconnecting to it.
pub(crate) fn migrate_last_folder(connection: &Connection) -> Result<(), Error> {
    add_columns(
        connection,
        &[
            ("sync_state", "last_folder", "TEXT"),
            ("sync_state", "last_account", "TEXT"),
        ],
    )
}

/// Format version 98: which storage the sync binding uses, where in it (the S3
/// bucket and prefix), and this desktop's own way into it (the AWS CLI profile
/// and the path to the `aws` program). Every binding made before is Google
/// Drive. The last-synced copies tell [`remembered`] whether a folder is in
/// the storage the Workspace is connecting to now.
pub(crate) fn migrate_provider(connection: &Connection) -> Result<(), Error> {
    add_columns(
        connection,
        &[
            (
                "sync_state",
                "provider",
                "TEXT NOT NULL DEFAULT 'google_drive'",
            ),
            ("sync_state", "s3_bucket", "TEXT"),
            ("sync_state", "s3_prefix", "TEXT"),
            ("sync_state", "aws_profile", "TEXT"),
            ("sync_state", "aws_cli_path", "TEXT"),
            (
                "sync_state",
                "last_provider",
                "TEXT NOT NULL DEFAULT 'google_drive'",
            ),
            ("sync_state", "last_bucket", "TEXT"),
            ("sync_state", "last_prefix", "TEXT"),
        ],
    )
}

/// Format version 99: the S3 service the binding's bucket was reached through, so a
/// profile that later points elsewhere stops sync instead of switching services. Bindings
/// made before record nothing; the desktop records the profile's service on its next
/// successful build.
pub(crate) fn migrate_endpoint(connection: &Connection) -> Result<(), Error> {
    add_columns(connection, &[("sync_state", "s3_endpoint", "TEXT")])
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, Error> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        [table, column],
        |row| row.get(0),
    )?)
}

fn add_columns(connection: &Connection, columns: &[(&str, &str, &str)]) -> Result<(), Error> {
    for (table, column, definition) in columns {
        if !has_column(connection, table, column)? {
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
    /// The S3 profile now reaches another service than the Workspace's bucket was connected
    /// through; the status carries the message. The way out is Disconnect (to move the bucket
    /// on purpose) or pointing the profile back.
    ServiceChanged,
    /// The `aws` program is missing or too old; the status carries the message. The person
    /// chooses where it is, or installs it.
    CliUnavailable,
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
    /// Stop syncing here, then connect again; a retry only works once the profile is changed
    /// back.
    Disconnect,
    /// Choose the `aws` program (or install one), then retry.
    ChooseProgram,
}

impl SyncRecovery {
    pub fn action(self) -> SyncRecoveryAction {
        match self {
            Self::FolderMissing => SyncRecoveryAction::Reupload,
            Self::AuthorizationExpired => SyncRecoveryAction::Reconnect,
            Self::ServiceChanged => SyncRecoveryAction::Disconnect,
            Self::CliUnavailable => SyncRecoveryAction::ChooseProgram,
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
            RemoteError::ServiceChanged(_) => Some(Self::ServiceChanged),
            RemoteError::CliUnavailable(_) => Some(Self::CliUnavailable),
            RemoteError::PreconditionFailed { .. }
            | RemoteError::NotFound
            | RemoteError::BucketMissing(_)
            | RemoteError::Other(_) => None,
        }
    }
}

/// The storage a Workspace's sync folder lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncProvider {
    GoogleDrive,
    S3,
}

impl SyncProvider {
    /// The storage as a person names it, for messages.
    pub fn name(self) -> &'static str {
        match self {
            Self::GoogleDrive => "Google Drive",
            Self::S3 => "S3",
        }
    }
}

/// Where an S3 binding keeps its folder, and how this desktop reaches it.
/// The bucket and prefix belong to the Workspace; the profile and the path to
/// the `aws` program are this desktop's own, like a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct S3Binding {
    pub bucket: String,
    /// Where in the bucket the Workspace folders are kept, as the person wrote it.
    pub prefix: String,
    /// The AWS CLI profile this desktop signs in through.
    pub profile: String,
    /// The `aws` program when the person chose it; `None` finds it on the usual paths.
    pub aws_cli_path: Option<String>,
    /// The S3 service the bucket was connected through: `scheme://host[:port]` for an
    /// S3-compatible service, the empty string for AWS's own, and `None` until it is
    /// recorded (a binding made before it was kept). A profile that now reaches another
    /// service stops sync: moving a bucket on purpose is Disconnect, then connect again.
    pub endpoint: Option<String>,
}

/// [`Workspace::sync_google_sign_in`] on a connection, for a check made inside a write lock.
pub(crate) fn google_sign_in_of(
    connection: &Connection,
) -> Result<Option<(String, Option<String>)>, Error> {
    let state = state(connection)?;
    Ok(match (state.provider, state.connection) {
        (SyncProvider::GoogleDrive, Some(connection)) => Some((connection, state.account)),
        _ => None,
    })
}

/// Why a sign-in as another Google account is refused while Files or Workspace sync is
/// already on one.
pub(crate) fn other_google_account() -> Error {
    Error::Sync(
        "Workspace sync and Files are signed in to another Google account; sign in with that account, or use another Google account for both in Settings › Files"
            .into(),
    )
}

/// What a person is told when a profile reaches another S3 service than the one the
/// Workspace's bucket was connected through. The endpoints are as [`S3Binding::endpoint`]
/// keeps them.
pub fn s3_service_changed(recorded: &str, now: &str) -> String {
    let name = |endpoint: &str| {
        if endpoint.is_empty() {
            "AWS".to_owned()
        } else {
            endpoint.to_owned()
        }
    };
    format!(
        "This profile now points to another S3 service: it reaches {}, and this Workspace's bucket was connected through {}. To move the bucket on purpose, disconnect sync, then connect again; otherwise point the profile back.",
        name(now),
        name(recorded)
    )
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

/// One computer of the device registry, as Settings lists the computers that share this Workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncDevice {
    pub id: String,
    pub name: String,
    /// The two-letter code in the references of tickets made on that computer.
    pub code: String,
    /// When that computer last uploaded a change; `None` until it has.
    pub last_synced_at: Option<String>,
    /// Whether this is the computer the list is read on.
    pub this: bool,
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
    /// The account shown for the sign-in: the Drive email, or the AWS identity
    /// (ARN) the profile signs in as.
    pub account: Option<String>,
    /// The storage this Workspace syncs with; Google Drive until another is connected.
    pub provider: SyncProvider,
    /// For [`SyncProvider::S3`], the bucket and this desktop's way into it.
    pub s3: Option<S3Binding>,
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
    /// How long the storage asked to be left alone, on the status a run
    /// returns when it was rate limited. It is not stored: a status read
    /// afterwards has none.
    #[serde(skip)]
    pub retry_after: Option<Duration>,
    /// On the status of a run that did not start, because another run of this
    /// Workspace file was still in progress in this process. That run made no
    /// call to the storage and changed nothing. It is not stored.
    #[serde(skip)]
    pub run_in_progress: bool,
}

/// Where this Workspace syncs to and as whom: what a host needs to start a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncBinding {
    pub folder_id: String,
    /// The storage sign-in the desktop stored; `None` if it never signed in.
    pub connection_id: Option<String>,
    pub provider: SyncProvider,
    /// For [`SyncProvider::S3`], the bucket and this desktop's way into it. An
    /// S3 binding has no `connection_id`: nothing of the sign-in is stored.
    pub s3: Option<S3Binding>,
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
    /// The folder this Workspace synced with before it was disconnected, when
    /// [`Workspace::sync_reconnect`] can go back to it.
    pub reconnect: Option<SyncFolder>,
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

/// The version of a listed shared JSON file, to read it by. The device list
/// and the Attachment list are far smaller than the most a record may be: one
/// that is larger is not read into memory, and not replaced either.
fn fits(id: &str, file: &RemoteFile) -> Result<String, Error> {
    if file.size > MAX_FILE_BYTES {
        return Err(Error::Sync(format!(
            "{id}.json in the sync folder is larger than {} MiB and was not read; remove it from the sync folder to let ticketd write it again",
            MAX_FILE_BYTES / (1024 * 1024)
        )));
    }
    Ok(file.version.clone())
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
    last_folder: Option<String>,
    last_account: Option<String>,
    provider: SyncProvider,
    s3_bucket: Option<String>,
    s3_prefix: Option<String>,
    aws_profile: Option<String>,
    aws_cli_path: Option<String>,
    s3_endpoint: Option<String>,
    last_provider: SyncProvider,
    last_bucket: Option<String>,
    last_prefix: Option<String>,
}

impl State {
    /// The S3 location and profile, while this is an S3 binding.
    fn s3(&self) -> Option<S3Binding> {
        if self.provider != SyncProvider::S3 {
            return None;
        }
        Some(S3Binding {
            bucket: self.s3_bucket.clone()?,
            prefix: self.s3_prefix.clone().unwrap_or_default(),
            profile: self.aws_profile.clone().unwrap_or_default(),
            aws_cli_path: self.aws_cli_path.clone(),
            endpoint: self.s3_endpoint.clone(),
        })
    }

    /// Whether the desktop has signed in to the storage, before a folder is chosen.
    fn signed_in(&self) -> bool {
        self.connection.is_some() || self.s3().is_some()
    }
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

/// What [`state`] reads, in the order it reads them.
const STATE_COLUMNS: &str = "connection, account, folder, folder_name, device_id, device_name, poll_interval_secs, attachment_download, last_synced_at, recovery, first_sync, first_total, recovery_message, run_token, run_previous, run_due, last_folder, last_account, provider, s3_bucket, s3_prefix, aws_profile, aws_cli_path, last_provider, last_bucket, last_prefix, s3_endpoint";

/// Whether the sync state is there with every column [`state`] reads: a Workspace of an
/// older format has none of them or only the first of them.
fn has_state(connection: &Connection) -> Result<bool, Error> {
    if !crate::backup::table_exists(connection, "sync_state")? {
        return Ok(false);
    }
    for column in STATE_COLUMNS.split(", ") {
        if !has_column(connection, "sync_state", column)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn state(connection: &Connection) -> Result<State, Error> {
    Ok(connection.query_row(
        &format!("SELECT {STATE_COLUMNS} FROM sync_state"),
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
                last_folder: row.get(16)?,
                last_account: row.get(17)?,
                provider: from_label(row.get(18)?).unwrap_or(SyncProvider::GoogleDrive),
                s3_bucket: row.get(19)?,
                s3_prefix: row.get(20)?,
                aws_profile: row.get(21)?,
                aws_cli_path: row.get(22)?,
                last_provider: from_label(row.get(23)?).unwrap_or(SyncProvider::GoogleDrive),
                last_bucket: row.get(24)?,
                last_prefix: row.get(25)?,
                s3_endpoint: row.get(26)?,
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
    // Without the last-synced copies there is nothing to reconnect with.
    if has_column(connection, "sync_state", "last_folder")? {
        connection
            .execute_batch("UPDATE sync_state SET last_folder = NULL, last_account = NULL;")?;
    }
    if has_column(connection, "sync_state", "last_bucket")? {
        connection
            .execute_batch("UPDATE sync_state SET last_bucket = NULL, last_prefix = NULL;")?;
    }
    connection.execute_batch(GIVE_UP_DOWNLOADS)?;
    forget_synced(connection)
}

/// See [`super::remember_replaced_folder`].
pub(super) fn remember_replaced_folder(
    restored: &Connection,
    replaced: &Connection,
) -> Result<(), Error> {
    // A replaced Workspace of an older format has nothing to remember. Any other failure to
    // read it stops the restore here, before the live Workspace changes.
    if !has_state(replaced)? {
        return Ok(());
    }
    let was = state(replaced)?;
    // The folder belongs to one Workspace: a backup of another one is not offered it.
    let same_workspace = match (
        crate::embedded_attachments::workspace_id(replaced),
        crate::embedded_attachments::workspace_id(restored),
    ) {
        (Ok(replaced), Ok(restored)) => replaced == restored,
        _ => false,
    };
    // The backup may be of a format before these columns.
    migrate_last_folder(restored)?;
    migrate_provider(restored)?;
    migrate_endpoint(restored)?;
    // The sign-in and the settings belong to this computer, not to the Workspace's content:
    // they stay whatever the backup is of and wherever it was made.
    restored.execute(
        "UPDATE sync_state SET connection = ?1, account = ?2, provider = ?3, s3_bucket = ?4, s3_prefix = ?5, aws_profile = ?6, aws_cli_path = ?7, s3_endpoint = ?8, device_name = ?9, poll_interval_secs = ?10, attachment_download = ?11",
        params![
            was.connection,
            was.account,
            label(was.provider)?,
            was.s3_bucket,
            was.s3_prefix,
            was.aws_profile,
            was.aws_cli_path,
            was.s3_endpoint,
            was.device_name,
            was.poll_interval_secs,
            label(was.attachment_download)?,
        ],
    )?;
    // Files and sync share the sign-in kept above: a Files folder in another account goes.
    let kept = was
        .connection
        .as_deref()
        .filter(|_| was.provider == SyncProvider::GoogleDrive);
    crate::upload_destination::follow_kept_google_sign_in(restored, kept)?;
    if !same_workspace {
        return Ok(());
    }
    let syncing = was.folder.is_some();
    let Some(folder) = was.folder.clone().or_else(|| was.last_folder.clone()) else {
        return Ok(());
    };
    let (account, provider, bucket, prefix) = if syncing {
        (
            was.account.clone(),
            was.provider,
            was.s3_bucket.clone(),
            was.s3_prefix.clone(),
        )
    } else {
        (
            was.last_account.clone(),
            was.last_provider,
            was.last_bucket.clone(),
            was.last_prefix.clone(),
        )
    };
    restored.execute(
        "UPDATE sync_state SET last_folder = ?1, last_account = ?2, last_provider = ?3, last_bucket = ?4, last_prefix = ?5",
        params![folder, account, label(provider)?, bucket, prefix],
    )?;
    Ok(())
}

/// The folder a disconnected Workspace can go back to: the one it last synced
/// with, while the storage connected is the one that folder is in and still
/// lists it. For Google Drive that is the same account; for S3 the same bucket
/// and prefix, through whichever profile and identity reach them.
fn remembered(state: &State, folders: &[RemoteFolder]) -> Option<SyncFolder> {
    if state.folder.is_some() || state.last_provider != state.provider {
        return None;
    }
    let same_storage = match state.provider {
        SyncProvider::GoogleDrive => state
            .account
            .as_ref()
            .filter(|account| !account.is_empty())
            .is_some_and(|account| state.last_account.as_ref() == Some(account)),
        SyncProvider::S3 => {
            state.s3_bucket.is_some()
                && state.last_bucket == state.s3_bucket
                && state.last_prefix == state.s3_prefix
        }
    };
    if !same_storage {
        return None;
    }
    let last = state.last_folder.as_ref()?;
    let folder = folders.iter().find(|folder| folder.id == *last)?;
    Some(SyncFolder {
        id: folder.id.clone(),
        name: folder.name.clone(),
    })
}

/// A record as the status names it, or `None` when it is not in this Workspace.
fn item(connection: &Connection, kind: RecordKind, id: &str) -> Result<Option<SyncItem>, Error> {
    let sql = match kind {
        RecordKind::Ticket => "SELECT reference, title FROM tickets WHERE id = ?1",
        RecordKind::Document => "SELECT NULL, COALESCE(title, '') FROM documents WHERE id = ?1",
        RecordKind::Plan => "SELECT NULL, name FROM plans WHERE id = ?1",
        RecordKind::Project => "SELECT NULL, name FROM projects WHERE id = ?1",
        RecordKind::Automation => "SELECT NULL, name FROM automations WHERE id = ?1",
        RecordKind::AutomationAgent => "SELECT NULL, name FROM automation_agents WHERE id = ?1",
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

    /// The computers that share this Workspace: this one first, with its name as it is now
    /// (the registry gets a new name by the next run), then the others as the registry
    /// stood when this computer last read it, the most recent change first. Reads only this
    /// Workspace's copy of the registry, so it needs no sign-in and no network; before the
    /// first run it lists this computer alone.
    pub fn sync_devices(&self) -> Result<Vec<SyncDevice>, Error> {
        let state = state(&self.connection)?;
        let cached: Option<String> = self
            .connection
            .query_row(
                "SELECT content FROM sync_files WHERE kind = 'devices' AND id = ?1",
                [REGISTRY],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let registry: Registry = match cached {
            Some(content) => read_shared(content.as_bytes())?,
            None => Registry::default(),
        };
        let mine = state.device_id.as_deref();
        let this = |id: &str, device: Option<&RegisteredDevice>| SyncDevice {
            id: id.to_owned(),
            name: state.device_name.clone().unwrap_or_else(computer_name),
            code: self.device_code().unwrap_or_default(),
            last_synced_at: device.and_then(|device| device.last_synced_at.clone()),
            this: true,
        };
        let mut others: Vec<SyncDevice> = registry
            .devices
            .iter()
            .filter(|(id, _)| Some(id.as_str()) != mine)
            .map(|(id, device)| SyncDevice {
                id: id.clone(),
                name: device.name.clone(),
                code: device.code.clone(),
                last_synced_at: device.last_synced_at.clone(),
                this: false,
            })
            .collect();
        others.sort_by(|a, b| {
            b.last_synced_at
                .cmp(&a.last_synced_at)
                .then_with(|| a.name.cmp(&b.name))
        });
        let first = match mine {
            Some(id) => this(id, registry.devices.get(id)),
            None => this("", None),
        };
        Ok(std::iter::once(first).chain(others).collect())
    }

    /// The `aws` program this desktop's person chose, if any. Unlike the bucket, it is kept
    /// before a connection exists and after one ends: it belongs to this desktop.
    pub fn sync_aws_cli_path(&self) -> Result<Option<String>, Error> {
        Ok(state(&self.connection)?.aws_cli_path)
    }

    /// Remembers the `aws` program for this desktop (`None` forgets it). A connected S3
    /// binding runs the new program from its next call.
    pub fn set_sync_aws_cli_path(&mut self, path: Option<&str>) -> Result<(), Error> {
        self.connection
            .execute("UPDATE sync_state SET aws_cli_path = ?1", [path])?;
        touch(&self.connection)?;
        Ok(())
    }

    /// Remember the storage sign-in, before a folder is chosen. Both values are
    /// the desktop's own: the core only keeps them with the Workspace.
    ///
    /// Files and Workspace sync share one Google account, so the sign-in has to be the one
    /// the Files folder already uses, and, once a folder is bound, the one that folder was
    /// made with: signing in again as another account would leave the two on different
    /// accounts. [`Workspace::switch_google_account`] is how both move together.
    pub fn sync_connect(
        &mut self,
        connection_id: &str,
        account: &str,
    ) -> Result<SyncStatus, Error> {
        self.bind_google(connection_id, account, true)
    }

    /// [`Workspace::sync_connect`] without the shared-account check on the Files folder, for
    /// the caller that moves the Files destination along with the sign-in.
    pub(crate) fn connect_google(
        &mut self,
        connection_id: &str,
        account: &str,
    ) -> Result<SyncStatus, Error> {
        self.bind_google(connection_id, account, false)
    }

    fn bind_google(
        &mut self,
        connection_id: &str,
        account: &str,
        files_must_match: bool,
    ) -> Result<SyncStatus, Error> {
        // Read, checked and written under one write lock, as `sync_connect_s3` does: another
        // connection to this Workspace file could bind an S3 folder in between otherwise, and
        // this update would keep that folder while clearing the S3 settings.
        // The Files folder is checked in the same lock: a Files folder chosen through another
        // handle in between would otherwise end up on another account than this sign-in.
        crate::write_scope::run(&self.connection, |scope| {
            if files_must_match {
                crate::upload_destination::refuse_other_files_google_sign_in(scope, connection_id)?;
            }
            let state = state(scope)?;
            if state.folder.is_some() && state.provider != SyncProvider::GoogleDrive {
                return Err(Error::Sync(format!(
                    "this Workspace syncs with {}; disconnect it before connecting to Google Drive",
                    state.provider.name()
                )));
            }
            if state.folder.is_some()
                && state
                    .connection
                    .as_deref()
                    .is_some_and(|held| held != connection_id)
            {
                return Err(other_google_account());
            }
            scope.execute(
                "UPDATE sync_state SET provider = 'google_drive', s3_bucket = NULL, s3_prefix = NULL, aws_profile = NULL, s3_endpoint = NULL, connection = ?1, account = ?2",
                [connection_id, account],
            )?;
            Ok(())
        })?;
        touch(&self.connection)?;
        self.sync_status()
    }

    /// Remember an S3 binding, before a folder is chosen: the bucket and prefix
    /// the folder is kept in, this desktop's AWS CLI profile and `aws` program,
    /// and the AWS identity (ARN) the profile signs in as, shown as the account.
    /// Nothing of the sign-in is stored: the desktop asks the AWS CLI for
    /// credentials whenever it needs them. Once a folder is chosen, the bucket
    /// and prefix stay; the profile may change, since another profile can reach
    /// the same bucket.
    pub fn sync_connect_s3(&mut self, s3: &S3Binding, identity: &str) -> Result<SyncStatus, Error> {
        if s3.bucket.trim().is_empty() || s3.profile.trim().is_empty() {
            return Err(Error::Sync(
                "name the S3 bucket and the AWS CLI profile to sign in through".into(),
            ));
        }
        // What the S3 storage would refuse later, refused now: a binding that can never sync
        // is worse than none.
        S3Target::new(&s3.bucket, "us-east-1", None)
            .map_err(|error| Error::Sync(error.to_string()))?;
        checked_prefix(&s3.prefix).map_err(|error| Error::Sync(error.to_string()))?;
        // The binding is read, checked and written under one write lock: another connection
        // to this Workspace file could bind a folder in between otherwise.
        crate::write_scope::run(&self.connection, |scope| {
            let state = state(scope)?;
            if state.folder.is_some() {
                if state.provider != SyncProvider::S3 {
                    return Err(Error::Sync(format!(
                        "this Workspace syncs with {}; disconnect it before connecting to S3",
                        state.provider.name()
                    )));
                }
                if state.s3_bucket.as_deref() != Some(s3.bucket.as_str())
                    || state.s3_prefix.as_deref() != Some(s3.prefix.as_str())
                {
                    return Err(Error::Sync(
                        "this Workspace syncs with another S3 bucket or prefix; disconnect it before connecting to this one".into(),
                    ));
                }
            }
            // A bound Workspace keeps the service it was connected through; a caller that does
            // not know the profile's service leaves it as it is.
            let endpoint = match (state.folder.is_some(), &state.s3_endpoint, &s3.endpoint) {
                (true, Some(recorded), Some(now)) if recorded != now => {
                    return Err(Error::Sync(s3_service_changed(recorded, now)));
                }
                (true, Some(recorded), None) => Some(recorded.clone()),
                _ => s3.endpoint.clone(),
            };
            scope.execute(
                "UPDATE sync_state SET provider = 's3', connection = NULL, s3_bucket = ?1, s3_prefix = ?2, aws_profile = ?3, aws_cli_path = ?4, s3_endpoint = ?5, account = ?6",
                params![s3.bucket, s3.prefix, s3.profile, s3.aws_cli_path, endpoint, identity],
            )?;
            Ok(())
        })?;
        touch(&self.connection)?;
        self.sync_status()
    }

    /// Stop syncing here. Local content and the folder in the storage stay as
    /// they are, and so do the last-synced copies and this desktop's place in
    /// the device registry: the folder is remembered with its account, for
    /// [`Workspace::sync_reconnect`].
    pub fn sync_disconnect(&mut self) -> Result<SyncStatus, Error> {
        // Signing out before a folder is chosen leaves what was remembered.
        self.connection.execute(
            "UPDATE sync_state SET last_account = CASE WHEN folder IS NULL THEN last_account ELSE account END, last_provider = CASE WHEN folder IS NULL THEN last_provider ELSE provider END, last_bucket = CASE WHEN folder IS NULL THEN last_bucket ELSE s3_bucket END, last_prefix = CASE WHEN folder IS NULL THEN last_prefix ELSE s3_prefix END, last_folder = COALESCE(folder, last_folder), provider = 'google_drive', s3_bucket = NULL, s3_prefix = NULL, aws_profile = NULL, s3_endpoint = NULL, connection = NULL, account = NULL, folder = NULL, folder_name = NULL, last_synced_at = NULL, recovery = NULL, recovery_message = NULL, first_sync = NULL",
            [],
        )?;
        self.connection.execute_batch(GIVE_UP_DOWNLOADS)?;
        touch(&self.connection)?;
        self.sync_status()
    }

    /// Go back to the folder this Workspace synced with before it was
    /// disconnected. The next [`Workspace::sync_now`] is an ordinary run after
    /// a long time offline: the last-synced copies are still the merge bases,
    /// this desktop is still the one the device registry lists, and nothing is
    /// replaced on either side.
    pub fn sync_reconnect(&mut self, remote: &dyn RemoteStorage) -> Result<SyncStatus, Error> {
        remote.check_usable()?;
        let state = state(&self.connection)?;
        let folder = remembered(&state, &remote.folders()?).ok_or_else(|| {
            Error::Sync(match state.provider {
                SyncProvider::GoogleDrive => "the folder this Workspace synced with is not in this Google Drive account; upload or download instead",
                SyncProvider::S3 => "the folder this Workspace synced with is not in this S3 bucket and prefix; upload or download instead",
            }.into())
        })?;
        self.connection.execute(
            "UPDATE sync_state SET folder = ?1, folder_name = ?2, first_sync = NULL, first_total = 0, recovery = NULL, recovery_message = NULL",
            params![folder.id, folder.name],
        )?;
        touch(&self.connection)?;
        self.sync_status()
    }

    /// Record which S3 service the bound bucket is reached through, for a binding made
    /// before one was kept. A recorded service is never replaced: a profile that reaches
    /// another one stops sync instead. See [`S3Binding::endpoint`].
    pub fn sync_record_s3_endpoint(&self, endpoint: &str) -> Result<(), Error> {
        self.connection.execute(
            "UPDATE sync_state SET s3_endpoint = ?1 WHERE provider = 's3' AND s3_endpoint IS NULL",
            [endpoint],
        )?;
        Ok(())
    }

    /// The sync destination, or `None` when no folder is chosen. One small
    /// read, for a host that asks often.
    pub fn sync_binding(&self) -> Result<Option<SyncBinding>, Error> {
        let state = state(&self.connection)?;
        let s3 = state.s3();
        Ok(state.folder.map(|folder_id| SyncBinding {
            folder_id,
            connection_id: state.connection,
            provider: state.provider,
            s3,
            device_name: state.device_name.unwrap_or_else(computer_name),
            poll_secs: state.poll_interval_secs,
        }))
    }

    /// The Google sign-in Workspace sync holds, with the account it shows: a connection
    /// id and an email address. `None` while sync is not signed in to Google Drive.
    pub(crate) fn sync_google_sign_in(&self) -> Result<Option<(String, Option<String>)>, Error> {
        google_sign_in_of(&self.connection)
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
            // A held file has a notice instead of counting as a pending upload.
            let mut statement = connection.prepare(HELD_FILE_IDS)?;
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
                &format!(
                    "SELECT COUNT(*) FROM sync_dirty d WHERE d.id NOT IN ({HELD_FILE_IDS}) AND ((d.kind = 'ticket' AND d.id IN (SELECT id FROM tickets)) OR (d.kind = 'document' AND d.id IN (SELECT id FROM documents)) OR (d.kind = 'plan' AND d.id IN (SELECT id FROM plans)) OR (d.kind = 'project' AND d.id IN (SELECT id FROM projects)) OR (d.kind = 'automation' AND d.id IN (SELECT id FROM automations)) OR (d.kind = 'automation_agent' AND d.id IN (SELECT id FROM automation_agents)))"
                ),
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
        // Reading a notice does not make a held change reach the storage.
        // A file replaced from here needs nothing more.
        let unreadable = count(
            connection,
            &format!("SELECT (SELECT COUNT(*) FROM sync_notices WHERE read = 0 AND json_extract(notice, '$.kind') IN ('unreadable_file', 'oversized_record'))
                  + (SELECT COUNT(*) FROM sync_dirty WHERE id IN ({HELD_FILE_IDS}))"),
        )?;
        let blocked = matches!(
            state.recovery,
            Some(
                SyncRecovery::FolderMissing
                    | SyncRecovery::AuthorizationExpired
                    | SyncRecovery::StorageFull
                    | SyncRecovery::ServiceChanged
                    | SyncRecovery::CliUnavailable
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
                        "SELECT (SELECT COUNT(*) FROM tickets) + (SELECT COUNT(*) FROM documents) + (SELECT COUNT(*) FROM plans) + (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM automations) + (SELECT COUNT(*) FROM automation_agents) + (SELECT COUNT(*) FROM attachments WHERE kind = 'local_snapshot')",
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
                (None, _) if state.signed_in() => SyncConnection::Choosing,
                (None, _) => SyncConnection::NotConnected,
            },
            provider: state.provider,
            s3: state.s3(),
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
            recovery_message: state.recovery_message.filter(|_| {
                matches!(
                    state.recovery,
                    Some(
                        SyncRecovery::Error
                            | SyncRecovery::ServiceChanged
                            | SyncRecovery::CliUnavailable
                    )
                )
            }),
            recovery: state.recovery,
            first_sync,
            retry_after: None,
            run_in_progress: false,
        })
    }

    /// What this Workspace holds, and the Workspaces already in the storage,
    /// for choosing between uploading and downloading.
    pub fn sync_setup_options(&self, remote: &dyn RemoteStorage) -> Result<SetupOptions, Error> {
        remote.check_usable()?;
        let connection = &self.connection;
        let local = SyncCounts {
            tickets: count(connection, "SELECT COUNT(*) FROM tickets")?,
            documents: count(connection, "SELECT COUNT(*) FROM documents")?,
            attachments: count(
                connection,
                "SELECT COUNT(*) FROM attachments WHERE kind = 'local_snapshot'",
            )?,
        };
        let folders = remote.folders()?;
        let reconnect = remembered(&state(connection)?, &folders);
        let mut existing = Vec::new();
        for folder in folders {
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
                .filter(|file| file.size <= MAX_FILE_BYTES)
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
        Ok(SetupOptions {
            local,
            existing,
            reconnect,
        })
    }

    /// Give this Workspace a folder of its own in the storage, using `name`
    /// with an available numbered suffix if another Workspace uses that name.
    /// The next [`Workspace::sync_now`] is the first upload.
    ///
    /// The folder is identified by this Workspace's own identity, so a
    /// Workspace that was connected before returns to the same folder and name.
    pub fn sync_upload_workspace(
        &mut self,
        remote: &dyn RemoteStorage,
        name: &str,
    ) -> Result<SyncStatus, Error> {
        remote.check_usable()?;
        if state(&self.connection)?.folder.is_some() {
            return Err(Error::Sync(
                "this Workspace already syncs to a folder; disconnect it first".into(),
            ));
        }
        let folder = crate::embedded_attachments::workspace_id(&self.connection)?;
        let folders = remote.folders()?;
        let name = if let Some(existing) = folders.iter().find(|existing| existing.id == folder) {
            existing.name.clone()
        } else {
            let names: BTreeSet<_> = folders.iter().map(|folder| folder.name.as_str()).collect();
            let mut available = name.to_owned();
            let mut suffix = 2;
            while names.contains(available.as_str()) {
                available = format!("{name} ({suffix})");
                suffix += 1;
            }
            available
        };
        remote.ensure_folder(&folder, &name)?;
        forget_synced(&self.connection)?;
        bind(&self.connection, &folder, &name, SyncDirection::Upload)?;
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
        remote.check_usable()?;
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
                "UPDATE sync_state SET connection = ?1, account = ?2, device_name = ?3, poll_interval_secs = ?4, attachment_download = ?5, provider = ?6, s3_bucket = ?7, s3_prefix = ?8, aws_profile = ?9, aws_cli_path = ?10, s3_endpoint = ?11",
                params![
                    state.connection,
                    state.account,
                    state.device_name,
                    state.poll_interval_secs,
                    label(state.attachment_download)?,
                    label(state.provider)?,
                    state.s3_bucket,
                    state.s3_prefix,
                    state.aws_profile,
                    state.aws_cli_path,
                    state.s3_endpoint
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

    /// One full sync run: join the device registry, send Attachment bytes, sync
    /// the records, fetch Attachment bytes. The only way to run sync.
    ///
    /// The first run of a Workspace file in this process also begins the app
    /// session: downloads cut off when the app last stopped start again, a
    /// file held back as one from a newer ticketd is read again, and this
    /// desktop writes a fresh run token into its entry of the device registry,
    /// which is how a copy of the Workspace file that also syncs is found out.
    ///
    /// A run never overlaps another run of the same Workspace file in this
    /// process: it returns at once, with [`SyncStatus::run_in_progress`] set
    /// and no call to the storage. Other processes are not looked at; the CLI
    /// never syncs. A host still keeps `sync_download_workspace` away from a
    /// run, and reads [`SyncStatus::retry_after`] of the status returned.
    ///
    /// A failed run is not an error here: it becomes the status's `recovery`
    /// (with `recovery_message` for a failure that has no state of its own),
    /// and every local change is kept for the next run. `Err` means the
    /// Workspace is not connected or the outcome could not be saved.
    pub fn sync_now(&mut self, remote: &dyn RemoteStorage) -> Result<SyncStatus, Error> {
        self.exclusive_run(|workspace| workspace.run(remote))
    }

    /// The corrective action of the current recovery state, then a sync run
    /// (see [`Workspace::sync_now`], which it shares its rules with). A missing
    /// folder is created again and this Workspace uploaded to it whole; every
    /// other state is a new attempt (after the desktop signed in again, for an
    /// expired authorization).
    pub fn sync_recover(&mut self, remote: &dyn RemoteStorage) -> Result<SyncStatus, Error> {
        self.exclusive_run(|workspace| {
            let state = state(&workspace.connection)?;
            if state.recovery == Some(SyncRecovery::FolderMissing) {
                let folder = state.folder.ok_or_else(not_connected)?;
                let name = state.folder_name.unwrap_or_default();
                remote.ensure_folder(&folder, &name)?;
                forget_synced(&workspace.connection)?;
                bind(&workspace.connection, &folder, &name, SyncDirection::Upload)?;
            }
            workspace.run(remote)
        })
    }

    fn exclusive_run(
        &mut self,
        run: impl FnOnce(&mut Self) -> Result<(), Error>,
    ) -> Result<SyncStatus, Error> {
        let file = self.run_key();
        let Some(_running) = Running::claim(&file) else {
            return Ok(SyncStatus {
                run_in_progress: true,
                ..self.sync_status()?
            });
        };
        let outcome = self.begin_session(&file).and_then(|()| run(self));
        self.conclude(outcome)
    }

    /// What identifies this Workspace file among the runs of the process.
    fn run_key(&self) -> PathBuf {
        let path = self
            .connection
            .path()
            .map(PathBuf::from)
            .unwrap_or_default();
        path.canonicalize().unwrap_or(path)
    }

    /// Begin the app session of `file` unless this process already did. Not
    /// begun again after a failure, so that the next run does.
    fn begin_session(&mut self, file: &Path) -> Result<(), Error> {
        if Running::session_begun(file) {
            return Ok(());
        }
        self.connection
            .execute("UPDATE sync_state SET run_due = 1", [])?;
        self.connection
            .execute("UPDATE sync_files SET version = NULL WHERE newer", [])?;
        self.reset_interrupted_downloads()?;
        Running::begin_session(file);
        Ok(())
    }

    fn conclude(&mut self, outcome: Result<(), Error>) -> Result<SyncStatus, Error> {
        let before = state(&self.connection)?;
        let retry_after = match &outcome {
            Err(Error::Remote(RemoteError::RateLimited { retry_after })) => *retry_after,
            _ => None,
        };
        let (recovery, message) = match outcome {
            Ok(()) => (None, None),
            // Nothing ran, so there is nothing to recover from.
            Err(error) if before.folder.is_none() => return Err(error),
            Err(error) => match &error {
                // Its sentence is the whole message, and is kept to be shown.
                Error::Remote(RemoteError::ServiceChanged(said)) => {
                    (Some(SyncRecovery::ServiceChanged), Some(said.clone()))
                }
                Error::Remote(RemoteError::CliUnavailable(said)) => {
                    (Some(SyncRecovery::CliUnavailable), Some(said.clone()))
                }
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
        Ok(SyncStatus {
            retry_after,
            ..self.sync_status()?
        })
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
            let listed = listing
                .iter()
                .find(|file| file.key == RemoteKey::new(RemoteKind::Devices, id));
            listed.map(|file| fits(id, file)).transpose()
        };
        let (registry, manifest) = (version(REGISTRY)?, version(MANIFEST)?);
        let (device_id, device_name) =
            self.register(remote, &folder, registry.as_deref(), &state)?;
        // Bytes go up before any record that names them.
        self.sync_attachment_records(remote, &folder, manifest.as_deref())?;
        let uploaded = self.sync_listed(remote, &folder, &device_name, listing)?;
        if uploaded > 0 {
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
                            Some(file) => fetch(&fits(id, file)?)?,
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

/// Which Workspace files this process runs sync on right now, and which have
/// begun their app session. A Workspace file is one desktop, however many
/// handles on it exist.
static RUNS: Mutex<Runs> = Mutex::new(Runs {
    running: BTreeSet::new(),
    begun: BTreeSet::new(),
});

struct Runs {
    running: BTreeSet<PathBuf>,
    begun: BTreeSet<PathBuf>,
}

fn runs() -> MutexGuard<'static, Runs> {
    RUNS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The right to run sync on one Workspace file, given back when dropped, also
/// when the run panics.
struct Running(PathBuf);

impl Running {
    fn claim(file: &Path) -> Option<Self> {
        runs()
            .running
            .insert(file.to_path_buf())
            .then(|| Self(file.to_path_buf()))
    }

    fn session_begun(file: &Path) -> bool {
        runs().begun.contains(file)
    }

    fn begin_session(file: &Path) {
        runs().begun.insert(file.to_path_buf());
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        runs().running.remove(&self.0);
    }
}
