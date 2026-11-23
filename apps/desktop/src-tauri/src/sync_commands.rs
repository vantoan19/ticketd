//! Commands for Workspace sync: connecting to Google Drive, status and
//! settings, and reviewing what sync did (records that need review, notices,
//! History). The core holds the rules; this file validates what the interface
//! sends, supplies the Drive connection and words the core's values for display.

use std::{
    sync::{Arc, Mutex, OnceLock, PoisonError, atomic::AtomicBool},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;
use ticketd_core::{
    DocumentPatch, Error, RecordKind, Status, SyncKind, SyncPartKind, SyncRecord, SyncValue,
    TicketPatch, Version, Workspace, WriteRequest,
    drive::{
        DesktopOAuthClient, DriveError, DriveErrorKind, DriveRemote, GoogleTransport,
        PickerSession, PlatformCredentialStore,
    },
    sync::{
        AttachmentAvailability, AttachmentDownload, MAX_FILE_BYTES, S3Binding, SetupOptions,
        SyncChoice, SyncConflict, SyncConnection, SyncItem, SyncNotice, SyncProvider, SyncRecovery,
        SyncResolution, SyncSettings, SyncStatus,
        remote::{RemoteError, RemoteKey, RemoteKind, RemoteStorage},
    },
};

use super::{BridgeFailure, open_workspace, workspace_session};
use crate::{
    s3_storage,
    sync_scheduler::{Binding, EXIT_LIMIT, Scheduler},
};

/// The one scheduler of this process and the instant its time counts from.
pub struct SyncHost {
    pub scheduler: Arc<Scheduler>,
    pub started: Instant,
}

fn transport() -> &'static GoogleTransport {
    static TRANSPORT: OnceLock<GoogleTransport> = OnceLock::new();
    TRANSPORT.get_or_init(GoogleTransport::default)
}

static DRIVE: Mutex<Option<(String, Arc<DriveRemote<'static>>)>> = Mutex::new(None);

/// The Drive storage of a signed-in connection. One value is kept per
/// connection, so its access token and folder lookups last between runs.
fn drive(connection_id: &str) -> Arc<DriveRemote<'static>> {
    let mut kept = DRIVE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((id, remote)) = kept.as_ref()
        && id == connection_id
    {
        return Arc::clone(remote);
    }
    let remote = Arc::new(DriveRemote::new(
        connection_id,
        &PlatformCredentialStore,
        transport(),
    ));
    *kept = Some((connection_id.to_owned(), Arc::clone(&remote)));
    remote
}

/// What this Workspace syncs with, as the core stores it. The scheduler and
/// every command ask through here, so a changed folder, desktop name or poll
/// interval applies to the next thing that runs.
fn binding_of(
    workspace: &Workspace,
    remote: impl FnOnce(&Storage) -> Arc<dyn RemoteStorage>,
) -> Result<Option<Binding>, Error> {
    // One small read: the scheduler asks each time it wakes.
    let Some(bound) = workspace.sync_binding()? else {
        return Ok(None);
    };
    // A Drive binding names its sign-in; an S3 one, its bucket and profile.
    let storage = match (bound.provider, bound.connection_id, bound.s3) {
        (SyncProvider::GoogleDrive, Some(connection), _) => Storage::Drive(connection),
        (SyncProvider::S3, _, Some(s3)) => Storage::S3(s3),
        _ => return Ok(None),
    };
    Ok(Some(Binding {
        folder: bound.folder_id,
        device: bound.device_name,
        poll: Duration::from_secs(bound.poll_secs),
        remote: remote(&storage),
    }))
}

/// What a Workspace's sync reaches, as the core stores it.
pub enum Storage {
    Drive(String),
    S3(S3Binding),
}

impl Storage {
    fn remote(&self) -> Arc<dyn RemoteStorage> {
        match self {
            Self::Drive(connection) => drive(connection),
            Self::S3(binding) => s3_storage::storage(binding),
        }
    }
}

pub fn binding(workspace: &Workspace) -> Result<Option<Binding>, Error> {
    binding_of(workspace, Storage::remote)
}

/// The name macOS shows for this computer. Its apps get no host name in their
/// environment, which is where the core looks.
fn mac_computer_name() -> Option<String> {
    let output = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()?;
    String::from_utf8(output.stdout).ok()
}

/// Names this desktop after the computer where the core could not find a name.
fn name_this_desktop(
    workspace: &mut Workspace,
    computer: impl FnOnce() -> Option<String>,
) -> Result<(), Error> {
    let settings = workspace.sync_settings()?;
    if settings.desktop_name != "This desktop" {
        return Ok(());
    }
    if let Some(name) = computer().filter(|name| !name.trim().is_empty()) {
        workspace.set_sync_settings(
            name.trim(),
            settings.poll_interval_secs,
            settings.attachment_download,
        )?;
    }
    Ok(())
}

/// What the scheduler does at launch and once a day while the app stays open.
pub fn upkeep(workspace: &mut Workspace) -> Result<(), Error> {
    workspace.upkeep(None)
}

/// What the desktop does once when it starts, before the first sync run. The
/// run itself begins the app session: downloads the last session left cut
/// off are fetched again, and this desktop's run token is renewed.
pub fn at_launch() {
    let prepared = open_workspace().and_then(|mut workspace| {
        if cfg!(target_os = "macos") {
            name_this_desktop(&mut workspace, mac_computer_name)?;
        }
        Ok(())
    });
    if let Err(error) = prepared {
        tracing::warn!(
            error_kind = error.kind().code(),
            %error,
            "could not prepare Workspace sync"
        );
    }
}

type Outcome<T> = Result<T, BridgeFailure>;

fn rejected<T>(message: &str) -> Outcome<T> {
    Err(BridgeFailure::plain(message))
}

fn check_request_id(request_id: &str) -> Outcome<()> {
    if request_id.trim().is_empty() || request_id.len() > 128 {
        return rejected("invalid request ID");
    }
    Ok(())
}

fn text(record: &SyncRecord, field: &str) -> String {
    match record.fields.get(field) {
        Some(SyncValue::Text(text)) => text.clone(),
        _ => String::new(),
    }
}

/// How a record is named to a person: its Ticket reference, title or name.
fn label(record: &SyncRecord) -> String {
    ["ref", "title", "name"]
        .into_iter()
        .map(|field| text(record, field))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// A value that is another record's GUID reads as that record's label.
fn named(workspace: &Workspace, value: &str) -> String {
    let guid = value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    if guid {
        for kind in SyncKind::ALL {
            if let Ok(record) = workspace.export_sync_record(kind, value) {
                return label(&record);
            }
        }
    }
    value.to_owned()
}

fn display(workspace: &Workspace, value: Option<&SyncValue>) -> String {
    match value {
        None => String::new(),
        Some(SyncValue::Text(text)) => named(workspace, text),
        Some(SyncValue::Flag(flag)) => if *flag { "Yes" } else { "No" }.into(),
        Some(SyncValue::Set(members)) => members
            .iter()
            .map(|member| named(workspace, member))
            .collect::<Vec<_>>()
            .join(", "),
    }
}

#[derive(Debug, Serialize)]
pub struct ConflictSummary {
    kind: SyncKind,
    id: String,
    reference: Option<String>,
    title: String,
    fields: Vec<String>,
    detected_at: String,
    read: bool,
}

/// The Activity or Implementation evidence a conflicting field belongs to.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Section {
    kind: SyncPartKind,
    /// When an Activity was reported.
    reported_at: Option<String>,
    /// What Implementation evidence is named.
    name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConflictField {
    /// The key the choice is sent back under.
    field: String,
    /// Set when the field is inside a section, whose key alone names nothing.
    section: Option<Section>,
    local: String,
    local_changed_at: Option<String>,
    remote: String,
    remote_changed_at: Option<String>,
    remote_device: String,
    /// Names the other value shown; sent back with the choice made on it.
    detected_at: String,
}

#[derive(Debug, Serialize)]
pub struct Conflict {
    kind: SyncKind,
    id: String,
    reference: Option<String>,
    title: String,
    detected_at: String,
    read: bool,
    local_device: String,
    fields: Vec<ConflictField>,
}

/// The section a field key of the form `<section GUID>:<field>` points into.
fn section(record: &SyncRecord, field: &str) -> Option<Section> {
    let (id, _) = field.split_once(':')?;
    let part = record.parts.iter().find(|part| part.id == id)?;
    let value = |name: &str| match part.fields.get(name) {
        Some(SyncValue::Text(text)) => Some(text.clone()),
        _ => None,
    };
    Some(Section {
        kind: part.kind,
        reported_at: value("reported_at"),
        name: value("name"),
    })
}

fn conflicts(workspace: &Workspace) -> Result<Vec<ConflictSummary>, Error> {
    workspace
        .sync_conflicts()?
        .into_iter()
        .map(|conflict| {
            let record = workspace.export_sync_record(conflict.kind, &conflict.id)?;
            // The list names what changed: a section is named by its kind, once.
            let mut fields: Vec<String> = Vec::new();
            for field in conflict.fields {
                let name = match section(&record, &field.field).map(|section| section.kind) {
                    Some(SyncPartKind::Activity) => "activity".to_owned(),
                    Some(SyncPartKind::Evidence) => "implementation_evidence".to_owned(),
                    None => field.field,
                };
                if !fields.contains(&name) {
                    fields.push(name);
                }
            }
            Ok(ConflictSummary {
                kind: conflict.kind,
                id: conflict.id,
                reference: conflict.reference,
                title: conflict.title,
                fields,
                detected_at: conflict.detected_at,
                read: conflict.read,
            })
        })
        .collect()
}

fn conflict(
    workspace: &Workspace,
    kind: SyncKind,
    id: &str,
    bound: Option<&Binding>,
) -> Result<Conflict, Error> {
    let SyncConflict {
        kind,
        id,
        reference,
        title,
        detected_at,
        read,
        fields,
    } = workspace.sync_conflict(kind, id)?;
    let record = workspace.export_sync_record(kind, &id)?;
    Ok(Conflict {
        kind,
        id,
        reference,
        title,
        detected_at,
        read,
        local_device: bound.map_or_else(|| "This desktop".into(), |bound| bound.device.clone()),
        fields: fields
            .into_iter()
            .map(|field| ConflictField {
                section: section(&record, &field.field),
                local: display(workspace, field.local.as_ref()),
                remote: display(workspace, field.remote.as_ref()),
                local_changed_at: field.local_changed_at,
                remote_changed_at: field.remote_changed_at,
                remote_device: field
                    .remote_device
                    .unwrap_or_else(|| "Another desktop".into()),
                detected_at: field.detected_at,
                field: field.field,
            })
            .collect(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Choice {
    Local,
    Remote,
    Edited,
}

/// One field's decision as the interface sends it.
#[derive(Debug, Deserialize)]
pub struct Resolution {
    field: String,
    choice: Choice,
    value: Option<String>,
    /// The `detected_at` of the field as the review showed it.
    detected_at: String,
}

fn resolve(
    workspace: &mut Workspace,
    kind: SyncKind,
    id: String,
    resolutions: Vec<Resolution>,
    request_id: &str,
) -> Outcome<()> {
    check_request_id(request_id)?;
    if resolutions.is_empty() {
        return rejected("choose a value for at least one field");
    }
    let resolutions = resolutions
        .into_iter()
        .map(|resolution| {
            let choice = match (resolution.choice, resolution.value) {
                (Choice::Local, _) => SyncChoice::Local,
                (Choice::Remote, _) => SyncChoice::Remote,
                // Only Markdown text is edited by hand; other fields have set values.
                // An Automation's body is its steps: taken whole from one desktop.
                (Choice::Edited, Some(value))
                    if kind != SyncKind::Automation
                        && (resolution.field == "body" || resolution.field.ends_with(":body")) =>
                {
                    SyncChoice::Edited(value)
                }
                (Choice::Edited, _) => return rejected("only the text can be edited"),
            };
            Ok(SyncResolution {
                field: resolution.field,
                choice,
                detected_at: resolution.detected_at,
            })
        })
        .collect::<Outcome<Vec<_>>>()?;
    workspace.write(
        Some(request_id),
        WriteRequest::ResolveSyncConflict {
            kind,
            id,
            resolutions,
        },
    )?;
    Ok(())
}

/// Unread sync entries the Inbox shows beside its own.
pub fn unread(workspace: &Workspace) -> Result<u32, Error> {
    // Counted by the core: the sidebar asks on every Workspace change.
    Ok(u32::try_from(workspace.sync_unread_count()?).unwrap_or(u32::MAX))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Local,
    /// The revisions of the file in Google Drive.
    Drive,
    /// The versions of the object in the S3 bucket.
    S3,
}

impl Source {
    /// The storage a version is read from, as a person names it; `None` for
    /// the versions this desktop keeps.
    fn storage(self) -> Option<&'static str> {
        match self {
            Self::Local => None,
            Self::Drive => Some("Google Drive"),
            Self::S3 => Some("S3"),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct VersionEntry {
    id: String,
    timestamp: String,
    /// The other desktop whose change made this version; `None` for this
    /// desktop, and where `oldest` or Drive leaves it unknown.
    device: Option<String>,
    /// The fields in which this version differs from the current one, which is
    /// what selecting it shows. Empty for Drive: its list is not read file by file.
    changed: Vec<String>,
    /// The oldest version kept here: what made it was not recorded.
    oldest: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct VersionField {
    field: &'static str,
    value: String,
    current: String,
}

#[derive(Debug, Serialize)]
pub struct VersionDetail {
    fields: Vec<VersionField>,
}

fn sync_kind(kind: RecordKind) -> SyncKind {
    match kind {
        RecordKind::Ticket => SyncKind::Ticket,
        RecordKind::Document => SyncKind::Document,
    }
}

fn remote_key(kind: RecordKind, id: &str) -> RemoteKey {
    let kind = match kind {
        RecordKind::Ticket => RemoteKind::Ticket,
        RecordKind::Document => RemoteKind::Document,
    };
    RemoteKey::new(kind, id)
}

/// The content History compares and restores, in the order it is shown.
#[derive(PartialEq, Eq)]
struct Content {
    title: String,
    /// Tickets only.
    status: Option<String>,
    body: String,
}

impl Content {
    fn of(kind: RecordKind, record: &SyncRecord) -> Self {
        Self {
            title: text(record, "title"),
            status: (kind == RecordKind::Ticket).then(|| text(record, "status")),
            body: text(record, "body"),
        }
    }

    fn fields(self) -> Vec<(&'static str, String)> {
        let mut fields = vec![("title", self.title)];
        fields.extend(self.status.map(|status| ("status", status)));
        fields.push(("body", self.body));
        fields
    }

    fn saved(version: Version) -> Self {
        Self {
            title: version.title.unwrap_or_default(),
            status: version.status.map(|status| status.to_string()),
            body: version.body,
        }
    }

    /// The fields whose value is not the one `current` has, with both values.
    fn differences(self, current: Self) -> Vec<VersionField> {
        self.fields()
            .into_iter()
            .zip(current.fields())
            .filter(|(earlier, current)| earlier.1 != current.1)
            .map(|((field, value), (_, current))| VersionField {
                field,
                value,
                current,
            })
            .collect()
    }
}

fn versions(
    workspace: &Workspace,
    bound: Option<&Binding>,
    kind: RecordKind,
    id: &str,
    source: Source,
) -> Outcome<Vec<VersionEntry>> {
    // Also what rejects an id that is not a record of this kind.
    let record = workspace.export_sync_record(sync_kind(kind), id)?;
    if let Some(storage) = source.storage() {
        // Without sync there is simply nothing earlier.
        let Some(bound) = bound else {
            return Ok(Vec::new());
        };
        let mut revisions = match bound.remote.revisions(&bound.folder, &remote_key(kind, id)) {
            Ok(revisions) => revisions,
            // Never uploaded: the storage has no versions of it.
            Err(RemoteError::NotFound) => return Ok(Vec::new()),
            Err(error) => {
                return rejected(&format!("Could not load versions from {storage}: {error}"));
            }
        };
        // The storage lists oldest first. Its newest version is left out only when
        // it is what this desktop holds now: a file changed elsewhere and not
        // yet downloaded here is a version to compare and restore like the rest.
        // ponytail: only the newest revision is read; an older one that equals
        // the current content is listed and shows as unchanged when selected.
        revisions.reverse();
        if let Some(newest) = revisions.first() {
            let held = version_content(workspace, Some(bound), kind, id, source, &newest.version)
                .is_ok_and(|content| content == Content::of(kind, &record));
            if held {
                revisions.remove(0);
            }
        }
        // ponytail: who wrote a revision and what it changed would cost a download
        // each; fetch them if the Drive list needs more than times.
        return Ok(revisions
            .into_iter()
            .map(|revision| VersionEntry {
                id: revision.version,
                timestamp: revision.modified,
                device: None,
                changed: Vec::new(),
                oldest: false,
            })
            .collect());
    }
    let reference = match kind {
        RecordKind::Ticket => text(&record, "ref"),
        RecordKind::Document => id.to_owned(),
    };
    let saved = workspace.versions(kind, &reference)?;
    // The core says when and by whom each version was replaced. The list shows
    // when and by whom it came to be, which is what replaced the version before it.
    saved
        .iter()
        .enumerate()
        .map(|(index, version)| {
            // A row names what selecting it shows: where the version differs from now.
            let changed = Content::saved(workspace.version(version.id)?)
                .differences(Content::of(kind, &record))
                .into_iter()
                .map(|difference| difference.field.to_owned())
                .collect();
            Ok(match saved.get(index + 1) {
                Some(made_by) => VersionEntry {
                    id: version.id.to_string(),
                    timestamp: made_by.replaced_at.clone(),
                    device: made_by.device.clone(),
                    changed,
                    oldest: false,
                },
                // The oldest kept version: no earlier change is known, so neither
                // is the desktop it came from. A Document knows when it was
                // created; a ticket only when this version ended.
                None => VersionEntry {
                    id: version.id.to_string(),
                    timestamp: Some(text(&record, "created_at"))
                        .filter(|created| !created.is_empty())
                        .unwrap_or_else(|| version.replaced_at.clone()),
                    device: None,
                    changed,
                    oldest: true,
                },
            })
        })
        .collect()
}

/// The content of one earlier version, wherever it is kept.
fn version_content(
    workspace: &Workspace,
    bound: Option<&Binding>,
    kind: RecordKind,
    id: &str,
    source: Source,
    version: &str,
) -> Outcome<Content> {
    let missing = || rejected("This version is no longer available");
    match source {
        Source::Local => {
            let Ok(number) = version.parse::<i64>() else {
                return missing();
            };
            let saved = workspace.version(number)?;
            if saved.kind != kind || saved.record_id != id {
                return missing();
            }
            Ok(Content::saved(saved))
        }
        Source::Drive | Source::S3 => {
            let storage = source.storage().unwrap_or_default();
            let Some(bound) = bound else {
                return rejected("Sync is not connected");
            };
            // S3's VersionIds run to 1024 bytes; the storage says whether this one exists.
            if version.is_empty() || version.len() > 1024 {
                return missing();
            }
            let unloaded = |error: RemoteError| {
                BridgeFailure::plain(&format!(
                    "Could not load this version from {storage}: {error}"
                ))
            };
            let key = remote_key(kind, id);
            // The storage says how large a version is before any of it is read.
            let revisions = bound
                .remote
                .revisions(&bound.folder, &key)
                .map_err(unloaded)?;
            let Some(revision) = revisions.iter().find(|known| known.version == version) else {
                return missing();
            };
            if revision.size > MAX_FILE_BYTES {
                return rejected(&format!(
                    "This version is larger than {} MiB, the most a record's file may be, and cannot be shown",
                    MAX_FILE_BYTES / (1024 * 1024)
                ));
            }
            let mut bytes = Vec::new();
            bound
                .remote
                .download(&bound.folder, &key, version, &mut bytes)
                .map_err(unloaded)?;
            let record = String::from_utf8(bytes)
                .map_err(|_| Error::SyncFile("the file is not UTF-8 text".into()))
                .and_then(|file| SyncRecord::parse(&file))?;
            if record.kind != sync_kind(kind) || record.id != id {
                return missing();
            }
            Ok(Content::of(kind, &record))
        }
    }
}

fn version_detail(
    workspace: &Workspace,
    bound: Option<&Binding>,
    kind: RecordKind,
    id: &str,
    source: Source,
    version: &str,
) -> Outcome<VersionDetail> {
    let current = Content::of(kind, &workspace.export_sync_record(sync_kind(kind), id)?);
    let earlier = version_content(workspace, bound, kind, id, source, version)?;
    Ok(VersionDetail {
        fields: earlier.differences(current),
    })
}

/// Makes an earlier version's title, text and status current again as an
/// ordinary edit, so what it replaces becomes a version too. Trash is left as
/// it is. A version kept here is restored by the core; one read from the storage is
/// written as the edit it amounts to.
fn restore(
    workspace: &mut Workspace,
    bound: Option<&Binding>,
    kind: RecordKind,
    id: &str,
    source: Source,
    version: &str,
    request_id: &str,
) -> Outcome<()> {
    check_request_id(request_id)?;
    let record = workspace.export_sync_record(sync_kind(kind), id)?;
    let earlier = version_content(workspace, bound, kind, id, source, version)?;
    let request = match (source, kind) {
        (Source::Local, _) => match version.parse() {
            Ok(id) => WriteRequest::RestoreVersion { id },
            Err(_) => return rejected("This version is no longer available"),
        },
        (Source::Drive | Source::S3, RecordKind::Ticket) => WriteRequest::ChangeTicket {
            reference: text(&record, "ref"),
            patch: TicketPatch {
                title: Some(earlier.title),
                body: Some(earlier.body),
                // Duplicate needs its canonical ticket and is set by its own workflow.
                status: earlier
                    .status
                    .and_then(|status| status.parse::<Status>().ok())
                    .filter(|status| *status != Status::Duplicate),
                ..Default::default()
            },
        },
        (Source::Drive | Source::S3, RecordKind::Document) => WriteRequest::ChangeDocument {
            id: id.to_owned(),
            patch: DocumentPatch {
                title: Some(Some(earlier.title).filter(|title| !title.is_empty())),
                body: Some(earlier.body),
                expected_updated_at: None,
            },
        },
    };
    workspace.write(Some(request_id), request)?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ExitReport {
    /// The first of what is left; `pending_total` counts all of it.
    pending: Vec<SyncItem>,
    pending_total: u64,
}

#[tauri::command(async)]
pub fn sync_conflicts() -> Outcome<Vec<ConflictSummary>> {
    Ok(conflicts(&*open_workspace()?)?)
}

#[tauri::command(async)]
pub fn sync_conflict(
    host: tauri::State<'_, SyncHost>,
    kind: SyncKind,
    id: String,
) -> Outcome<Conflict> {
    let bound = host.scheduler.binding()?;
    Ok(conflict(&*open_workspace()?, kind, &id, bound.as_ref())?)
}

#[tauri::command(async)]
pub fn resolve_sync_conflict(
    kind: SyncKind,
    id: String,
    resolutions: Vec<Resolution>,
    request_id: String,
) -> Outcome<()> {
    resolve(&mut *open_workspace()?, kind, id, resolutions, &request_id)
}

#[tauri::command(async)]
pub fn sync_notices() -> Outcome<Vec<SyncNotice>> {
    Ok(open_workspace()?.sync_notices()?)
}

#[tauri::command(async)]
pub fn set_sync_read(ids: Vec<String>, read: bool) -> Outcome<()> {
    if ids.len() > 1000 || ids.iter().any(|id| id.is_empty() || id.len() > 128) {
        return rejected("invalid Inbox entries");
    }
    Ok(open_workspace()?.set_sync_read(&ids, read)?)
}

// History reads the storage when asked to, so these run off the UI thread.
#[tauri::command(async)]
pub fn record_versions(
    host: tauri::State<'_, SyncHost>,
    kind: RecordKind,
    id: String,
    source: Source,
) -> Outcome<Vec<VersionEntry>> {
    let bound = host.scheduler.binding()?;
    versions(&*open_workspace()?, bound.as_ref(), kind, &id, source)
}

#[tauri::command(async)]
pub fn record_version(
    host: tauri::State<'_, SyncHost>,
    kind: RecordKind,
    id: String,
    source: Source,
    version: String,
) -> Outcome<VersionDetail> {
    let bound = host.scheduler.binding()?;
    version_detail(
        &*open_workspace()?,
        bound.as_ref(),
        kind,
        &id,
        source,
        &version,
    )
}

#[tauri::command(async)]
pub fn restore_record_version(
    host: tauri::State<'_, SyncHost>,
    kind: RecordKind,
    id: String,
    source: Source,
    version: String,
    request_id: String,
) -> Outcome<()> {
    let bound = host.scheduler.binding()?;
    restore(
        &mut *open_workspace()?,
        bound.as_ref(),
        kind,
        &id,
        source,
        &version,
        &request_id,
    )
}

/// Uploads what is pending, for at most ten seconds, and says what is left.
/// A failed upload is an answer, not a failure of the command.
#[tauri::command(async)]
pub fn sync_flush_on_exit(host: tauri::State<'_, SyncHost>) -> Outcome<ExitReport> {
    let (pending, pending_total) = host.scheduler.flush(host.started.elapsed(), EXIT_LIMIT)?;
    Ok(ExitReport {
        pending,
        pending_total,
    })
}

fn failed(error: impl std::fmt::Display) -> BridgeFailure {
    BridgeFailure::plain(&error.to_string())
}

/// What a failed Google sign-in is, so the interface can say it: a build
/// without the Drive app configuration, a sign-in the person never finished
/// (closed, cancelled or timed out) and an unreachable Google each have their
/// own code. Anything else stays a plain failure.
fn sign_in_failure(error: DriveError) -> BridgeFailure {
    let code = match error.kind {
        DriveErrorKind::Unconfigured => "drive_unconfigured",
        DriveErrorKind::Cancelled => "sign_in_cancelled",
        DriveErrorKind::Offline => "offline",
        _ => "failed",
    };
    BridgeFailure::coded(code, error.message)
}

/// Google sign-in in the system browser. Returns the connection the credential
/// is kept under and the account's email address when Google names it.
fn sign_in(app: &tauri::AppHandle) -> Outcome<(String, String)> {
    let client = DesktopOAuthClient::from_environment().map_err(sign_in_failure)?;
    let session =
        PickerSession::begin_sign_in(client, Duration::from_secs(180)).map_err(sign_in_failure)?;
    // The core generated this pinned Google URL. It never crosses the WebView.
    app.opener()
        .open_url(session.authorization_url(), None::<&str>)
        .map_err(|_| failed("could not open the system browser to sign in to Google Drive"))?;
    let signed_in = session
        .finish(
            transport(),
            &PlatformCredentialStore,
            &AtomicBool::new(false),
        )
        .map_err(sign_in_failure)?;
    // A kept adapter needs no reset: when Drive refuses its access token, it
    // renews with the credential this sign-in stored.
    Ok((
        signed_in.connection_id,
        signed_in.account.unwrap_or_default(),
    ))
}

/// The storage this Workspace is connected to, before or after a folder is chosen: the
/// signed-in Drive account, or the S3 bucket.
fn signed_in(workspace: &Workspace) -> Outcome<Arc<dyn RemoteStorage>> {
    let status = workspace.sync_status()?;
    match (status.provider, status.connection_id, status.s3) {
        (SyncProvider::GoogleDrive, Some(connection), _) => Ok(drive(&connection)),
        (SyncProvider::GoogleDrive, None, _) => rejected("Sign in to Google Drive first"),
        (SyncProvider::S3, _, Some(s3)) => {
            // A choice about the storage reads the profile as it is now.
            s3_storage::reset();
            Ok(s3_storage::storage(&s3))
        }
        (SyncProvider::S3, _, None) => rejected("Connect S3 first"),
    }
}

/// A folder identifier as the storage interface allows it.
fn check_folder_id(folder_id: &str) -> Outcome<()> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if folder_id.is_empty() || folder_id.len() > 64 || !folder_id.chars().all(allowed) {
        return rejected("invalid Workspace folder");
    }
    Ok(())
}

fn check_attachment_ids(ids: &[String]) -> Outcome<()> {
    if ids.len() > 1000 || ids.iter().any(|id| id.is_empty() || id.len() > 128) {
        return rejected("invalid Attachments");
    }
    Ok(())
}

/// The event that carries the sync status to the interface.
const STATUS_EVENT: &str = "sync-status";
/// How often the status is read while this Workspace syncs: upload progress,
/// going offline and an expired sign-in move no change token.
const STATUS_READ: Duration = Duration::from_secs(2);

/// Tells the interface the sync status each time it changes, so no view polls it.
/// It is read when something may have changed it (a local change, a sync command,
/// a run), every two seconds while connected, and otherwise at the idle fallback.
pub fn publish_status(app: tauri::AppHandle) {
    use tauri::Emitter;
    let spawned = std::thread::Builder::new()
        .name("sync-status".into())
        .spawn(move || {
            let mut seen = 0;
            let mut shown: Option<SyncStatus> = None;
            loop {
                // A failed read keeps what is shown; the next one tries again.
                if let Ok(status) = open_workspace().and_then(|workspace| workspace.sync_status())
                    && shown.as_ref() != Some(&status)
                {
                    if let Err(error) = app.emit(STATUS_EVENT, &status) {
                        tracing::warn!(%error, "could not send the sync status");
                    }
                    shown = Some(status);
                }
                let connected = shown
                    .as_ref()
                    .is_some_and(|status| status.connection != SyncConnection::NotConnected);
                let wait = if connected {
                    STATUS_READ
                } else {
                    crate::wake::IDLE
                };
                crate::wake::CHANGED.wait(&mut seen, wait);
            }
        });
    if let Err(error) = spawned {
        tracing::error!(%error, "could not start sending the sync status");
    }
}
#[tauri::command(async)]
pub fn sync_status() -> Outcome<SyncStatus> {
    Ok(open_workspace()?.sync_status()?)
}

/// Wakes the scheduler, whose next look follows what the command changed.
fn woken<T>(outcome: Outcome<T>) -> Outcome<T> {
    crate::wake::CHANGED.notify();
    outcome
}

// Everything below that reaches Google runs off the UI thread.
#[tauri::command(async)]
pub fn sync_connect(app: tauri::AppHandle) -> Outcome<SyncStatus> {
    let (connection, account) = sign_in(&app)?;
    woken(Ok(open_workspace()?.sync_connect(&connection, &account)?))
}

#[tauri::command(async)]
pub fn sync_setup_options() -> Outcome<SetupOptions> {
    let workspace = open_workspace()?;
    let remote = signed_in(&workspace)?;
    Ok(workspace.sync_setup_options(remote.as_ref())?)
}

/// The first upload itself starts with the scheduler's next look, which this wakes.
#[tauri::command(async)]
pub fn sync_upload_workspace() -> Outcome<SyncStatus> {
    let mut workspace = open_workspace()?;
    let remote = signed_in(&workspace)?;
    woken(Ok(workspace.sync_upload_workspace(
        remote.as_ref(),
        "ticketd Workspace",
    )?))
}

/// Back to the folder this Workspace synced with before it was disconnected.
/// The scheduler's next look runs the sync that merges both sides.
#[tauri::command(async)]
pub fn sync_reconnect() -> Outcome<SyncStatus> {
    let mut workspace = open_workspace()?;
    let remote = signed_in(&workspace)?;
    woken(Ok(workspace.sync_reconnect(remote.as_ref())?))
}

/// The status after a download, and where the replaced Workspace was kept.
#[derive(Debug, Serialize)]
pub struct Downloaded {
    #[serde(flatten)]
    status: SyncStatus,
    safety_backup: String,
}

/// Replaces the Workspace file, like restoring a backup: sync is held off
/// meanwhile, the desktop's session lets go of the file, and the handle used
/// here is the one the core consumes.
#[tauri::command(async)]
pub fn sync_download_workspace(
    host: tauri::State<'_, SyncHost>,
    folder_id: String,
) -> Outcome<Downloaded> {
    check_folder_id(&folder_id)?;
    let remote = signed_in(&*open_workspace()?)?;
    let no_run = host.scheduler.hold();
    let (status, safety_backup) = workspace_session()?.exclusive(|path| {
        let (replaced, safety_backup) =
            Workspace::open_existing(path)?.sync_download_workspace(remote.as_ref(), &folder_id)?;
        Ok((replaced.sync_status()?, safety_backup))
    })?;
    // Let go first, so the run this wakes is not turned away by the hold.
    drop(no_run);
    woken(Ok(Downloaded {
        status,
        safety_backup: safety_backup.display().to_string(),
    }))
}

#[tauri::command(async)]
pub fn sync_now(host: tauri::State<'_, SyncHost>) -> Outcome<SyncStatus> {
    match host.scheduler.sync_now(host.started.elapsed())? {
        Some(status) => Ok(status),
        None => Ok(open_workspace()?.sync_status()?),
    }
}

#[tauri::command(async)]
pub fn sync_recover(
    app: tauri::AppHandle,
    host: tauri::State<'_, SyncHost>,
) -> Outcome<SyncStatus> {
    let status = open_workspace()?.sync_status()?;
    if status.recovery == Some(SyncRecovery::AuthorizationExpired) {
        match status.s3 {
            // The profile's own sign-in; what it signs in as stays what the binding says.
            Some(s3) => crate::s3_commands::sign_in_for_recovery(&s3)?,
            None => {
                let (connection, account) = sign_in(&app)?;
                open_workspace()?.sync_connect(&connection, &account)?;
            }
        }
    }
    match host.scheduler.recover(host.started.elapsed())? {
        Some(status) => Ok(status),
        None => Ok(open_workspace()?.sync_status()?),
    }
}

#[tauri::command(async)]
pub fn sync_disconnect() -> Outcome<SyncStatus> {
    woken(Ok(open_workspace()?.sync_disconnect()?))
}

#[tauri::command(async)]
pub fn sync_open_folder(app: tauri::AppHandle) -> Outcome<()> {
    let status = open_workspace()?.sync_status()?;
    let Some(folder) = status.folder else {
        return rejected("Sync is not connected");
    };
    let (url, place) = match (status.provider, status.connection_id, status.s3) {
        (SyncProvider::S3, _, Some(s3)) => {
            let Some(url) = s3_storage::storage(&s3).console_url(&folder.id) else {
                return rejected("This bucket has no page in the AWS console");
            };
            (url, "the AWS console")
        }
        (SyncProvider::GoogleDrive, Some(connection), _) => {
            let url = drive(&connection).folder_url(&folder.id).map_err(|error| {
                failed(format!(
                    "Could not find the folder in Google Drive: {error}"
                ))
            })?;
            (url, "Google Drive")
        }
        _ => return rejected("Sign in to Google Drive first"),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| failed(format!("Could not open the folder in {place}")))
}

#[tauri::command(async)]
pub fn sync_settings() -> Outcome<SyncSettings> {
    Ok(open_workspace()?.sync_settings()?)
}

#[derive(Debug, Deserialize)]
pub struct SettingsChange {
    desktop_name: String,
    poll_interval_secs: u64,
    attachment_download: AttachmentDownload,
}

fn change_settings(workspace: &mut Workspace, settings: &SettingsChange) -> Outcome<SyncSettings> {
    if settings.desktop_name.chars().count() > 100 {
        return rejected("use a shorter name for this desktop");
    }
    // The core refuses an empty name and a poll under its minimum.
    Ok(workspace.set_sync_settings(
        &settings.desktop_name,
        settings.poll_interval_secs,
        settings.attachment_download,
    )?)
}

#[tauri::command(async)]
pub fn set_sync_settings(settings: SettingsChange) -> Outcome<SyncSettings> {
    woken(change_settings(&mut *open_workspace()?, &settings))
}

#[tauri::command(async)]
pub fn attachment_availability(ids: Vec<String>) -> Outcome<Vec<AttachmentAvailability>> {
    check_attachment_ids(&ids)?;
    Ok(open_workspace()?.attachment_availability(&ids)?)
}

/// Fetches the file and answers when it is here; progress shows meanwhile
/// through `attachment_availability`.
#[tauri::command(async)]
pub fn download_attachment(host: tauri::State<'_, SyncHost>, id: String) -> Outcome<()> {
    check_attachment_ids(std::slice::from_ref(&id))?;
    let Some(bound) = host.scheduler.binding()? else {
        return rejected("Sync is not connected");
    };
    Ok(open_workspace()?.download_attachment(bound.remote.as_ref(), &id)?)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Setup that fails must fail the test.
mod tests {
    use super::*;
    use std::io::Cursor;
    use ticketd_core::sync::{
        SyncNoticeKind,
        remote::{FakeRemote, RemoteOp},
    };

    /// Two desktops syncing one folder; `here` is the one the commands serve.
    struct Desks {
        _directory: tempfile::TempDir,
        remote: FakeRemote,
        there: Workspace,
        here: Workspace,
        bound: Binding,
    }

    impl Desks {
        fn sync_there(&mut self) {
            self.there.sync_now(&self.remote).unwrap();
        }
        fn sync_here(&mut self) {
            self.here.sync_now(&self.remote).unwrap();
        }
    }

    fn desks() -> Desks {
        let directory = tempfile::tempdir().unwrap();
        let remote = FakeRemote::new();
        // As the app sets them up: signed in, `there` uploaded its Workspace
        // and `here` replaced its own with it.
        let desk = |name: &str, file: &str| {
            let mut workspace = Workspace::open(directory.path().join(file)).unwrap();
            workspace
                .set_sync_settings(name, 60, AttachmentDownload::Automatic)
                .unwrap();
            workspace
                .sync_connect("connection", "mina@example.com")
                .unwrap();
            workspace
        };
        let mut there = desk("Desk A", "there.sqlite3");
        there.sync_upload_workspace(&remote, "Test").unwrap();
        let folder = remote.folders().unwrap()[0].id.clone();
        let (mut here, _) = desk("Desk B", "here.sqlite3")
            .sync_download_workspace(&remote, &folder)
            .unwrap();
        here.renew_device_code().unwrap();
        let bound = Binding {
            folder,
            device: "Desk B".into(),
            poll: Duration::from_secs(60),
            remote: Arc::new(remote.clone()),
        };
        Desks {
            _directory: directory,
            remote,
            there,
            here,
            bound,
        }
    }

    fn patch(status: Status, project: &str) -> TicketPatch {
        TicketPatch {
            status: Some(status),
            project_id: Some(Some(project.to_owned())),
            ..Default::default()
        }
    }

    /// Both desktops gave the same ticket a different status and project.
    /// Returns the ticket's GUID.
    fn conflicted(desks: &mut Desks) -> String {
        let ticket = desks.there.create_ticket("Fix login").unwrap();
        let folder = |name: &str| {
            let path = desks._directory.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            path.to_str().unwrap().to_owned()
        };
        let web = desks.there.create_project("Web", &folder("web")).unwrap();
        let api = desks.there.create_project("API", &folder("api")).unwrap();
        desks.sync_there();
        desks.sync_here();
        desks
            .there
            .change_ticket(&ticket.reference, patch(Status::Done, &web.id))
            .unwrap();
        desks
            .here
            .change_ticket(&ticket.reference, patch(Status::InReview, &api.id))
            .unwrap();
        desks.sync_there();
        desks.sync_here();
        ticket.id
    }

    #[test]
    fn a_conflict_shows_both_values_as_a_person_reads_them() {
        let mut desks = desks();
        let id = conflicted(&mut desks);

        let listed = conflicts(&desks.here).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].fields, ["project", "status"]);
        assert_eq!(listed[0].title, "Fix login");

        let shown = conflict(&desks.here, SyncKind::Ticket, &id, Some(&desks.bound)).unwrap();
        assert_eq!(shown.local_device, "Desk B");
        assert_eq!(shown.fields.len(), 2);
        let (project, status) = (&shown.fields[0], &shown.fields[1]);
        // A project is named, not shown as its GUID.
        assert_eq!(
            (project.local.as_str(), project.remote.as_str()),
            ("API", "Web")
        );
        assert_eq!(
            (status.local.as_str(), status.remote.as_str()),
            ("In review", "Done")
        );
        assert_eq!(status.remote_device, "Desk A");
        assert!(status.local_changed_at.is_some());
        // Nothing records when a project was last changed here.
        assert_eq!(project.local_changed_at, None);
        assert!(project.remote_changed_at.is_some());
    }

    /// A choice made without having seen the field in review.
    fn choose(field: &str, choice: Choice, value: Option<&str>) -> Resolution {
        Resolution {
            field: field.into(),
            choice,
            value: value.map(str::to_owned),
            detected_at: String::new(),
        }
    }

    #[test]
    fn a_choice_on_a_value_the_review_did_not_show_is_refused_as_changed() {
        let mut desks = desks();
        let id = conflicted(&mut desks);
        let unseen = vec![choose("status", Choice::Remote, None)];
        let refused = resolve(&mut desks.here, SyncKind::Ticket, id, unseen, "r").unwrap_err();
        assert_eq!(refused.code, "review_changed");
        assert_eq!(conflicts(&desks.here).unwrap().len(), 1);
    }

    #[test]
    fn resolving_applies_the_choices_once_per_request() {
        let mut desks = desks();
        let id = conflicted(&mut desks);
        // As the review sends them: each made on the value it showed.
        let shown = conflict(&desks.here, SyncKind::Ticket, &id, None).unwrap();
        let on_shown = |field: &str, choice| {
            let seen = shown.fields.iter().find(|seen| seen.field == field);
            Resolution {
                detected_at: seen.unwrap().detected_at.clone(),
                ..choose(field, choice, None)
            }
        };
        let choices = || {
            vec![
                on_shown("status", Choice::Remote),
                on_shown("project", Choice::Local),
            ]
        };
        resolve(
            &mut desks.here,
            SyncKind::Ticket,
            id.clone(),
            choices(),
            "request-1",
        )
        .unwrap();
        assert!(conflicts(&desks.here).unwrap().is_empty());
        let record = desks
            .here
            .export_sync_record(SyncKind::Ticket, &id)
            .unwrap();
        assert_eq!(text(&record, "status"), "Done");

        // A repeated request is answered again, not refused for having no conflict left.
        resolve(
            &mut desks.here,
            SyncKind::Ticket,
            id,
            choices(),
            "request-1",
        )
        .unwrap();
    }

    #[test]
    fn resolving_rejects_what_the_review_never_offers() {
        let mut desks = desks();
        let id = conflicted(&mut desks);
        let mut refuse = |resolutions, request_id| {
            resolve(
                &mut desks.here,
                SyncKind::Ticket,
                id.clone(),
                resolutions,
                request_id,
            )
            .unwrap_err()
            .message
        };
        assert_eq!(
            refuse(vec![choose("status", Choice::Edited, Some("Later"))], "r"),
            "only the text can be edited"
        );
        assert_eq!(
            refuse(vec![choose("body", Choice::Edited, None)], "r"),
            "only the text can be edited"
        );
        assert_eq!(refuse(vec![], "r"), "choose a value for at least one field");
        assert_eq!(
            refuse(vec![choose("status", Choice::Local, None)], " "),
            "invalid request ID"
        );
        assert_eq!(conflicts(&desks.here).unwrap().len(), 1);
    }

    #[test]
    fn unread_conflicts_and_notices_count_until_marked_read() {
        let mut desks = desks();
        let id = conflicted(&mut desks);
        let stray = RemoteKey::new(RemoteKind::Ticket, "0c8f3a51-6f0e-4a0b-9d55-2f1f6f3f8a10");
        desks
            .remote
            .write(
                &desks.bound.folder,
                &stray,
                "T-MW21.md",
                None,
                &mut Cursor::new(b"not a ticket"),
            )
            .unwrap();
        desks.sync_here();

        let notices = desks.here.sync_notices().unwrap();
        assert!(matches!(
            notices[0].notice,
            SyncNoticeKind::UnreadableFile { .. }
        ));
        assert_eq!(unread(&desks.here).unwrap(), 2);
        desks
            .here
            .set_sync_read(&[id, notices[0].id.clone()], true)
            .unwrap();
        assert_eq!(unread(&desks.here).unwrap(), 0);
    }

    fn retitle(workspace: &mut Workspace, reference: &str, title: &str) {
        let patch = TicketPatch {
            title: Some(title.into()),
            ..Default::default()
        };
        workspace.change_ticket(reference, patch).unwrap();
    }

    #[test]
    fn local_history_lists_how_each_version_came_to_be_and_restores_one() {
        let mut desks = desks();
        let ticket = desks.here.create_ticket("One").unwrap();
        retitle(&mut desks.here, &ticket.reference, "Two");
        let patch = TicketPatch {
            body: Some("Steps".into()),
            status: Some(Status::InProgress),
            ..Default::default()
        };
        desks.here.change_ticket(&ticket.reference, patch).unwrap();

        let list = versions(
            &desks.here,
            None,
            RecordKind::Ticket,
            &ticket.id,
            Source::Local,
        )
        .unwrap();
        let changed: Vec<_> = list.iter().map(|entry| entry.changed.join(" ")).collect();
        // Newest first, each named by where it differs from the ticket as it is
        // now: "Two" lacks the new status and text, "One" the new title as well.
        assert_eq!(changed, ["status body", "title status body"]);
        // Only the oldest kept version has no recorded origin.
        let oldest: Vec<_> = list.iter().map(|entry| entry.oldest).collect();
        assert_eq!(oldest, [false, true]);

        let first = &list[1].id;
        let detail = |workspace: &Workspace| {
            version_detail(
                workspace,
                None,
                RecordKind::Ticket,
                &ticket.id,
                Source::Local,
                first,
            )
            .unwrap()
            .fields
        };
        let field = |field, value: &str, current: &str| VersionField {
            field,
            value: value.into(),
            current: current.into(),
        };
        assert_eq!(
            detail(&desks.here),
            [
                field("title", "One", "Two"),
                field("status", "Todo", "In progress"),
                field("body", "", "Steps"),
            ]
        );

        let mut again = |request_id| {
            restore(
                &mut desks.here,
                None,
                RecordKind::Ticket,
                &ticket.id,
                Source::Local,
                first,
                request_id,
            )
        };
        again("restore-1").unwrap();
        again("restore-1").unwrap();
        assert_eq!(detail(&desks.here), []);
        assert_eq!(
            desks.here.show_ticket(&ticket.reference).unwrap().title,
            "One"
        );
    }

    #[test]
    fn a_version_of_another_record_is_refused() {
        let mut desks = desks();
        let ticket = desks.here.create_ticket("One").unwrap();
        retitle(&mut desks.here, &ticket.reference, "Two");
        let other = desks.here.create_ticket("Other").unwrap();
        let list = versions(
            &desks.here,
            None,
            RecordKind::Ticket,
            &ticket.id,
            Source::Local,
        )
        .unwrap();

        let refused = version_detail(
            &desks.here,
            None,
            RecordKind::Ticket,
            &other.id,
            Source::Local,
            &list[0].id,
        )
        .unwrap_err();
        assert_eq!(refused.message, "This version is no longer available");
        assert!(
            versions(
                &desks.here,
                None,
                RecordKind::Ticket,
                "nothing",
                Source::Local
            )
            .is_err()
        );
    }

    #[test]
    fn drive_history_lists_and_restores_the_files_earlier_revisions() {
        let mut desks = desks();
        let ticket = desks.there.create_ticket("One").unwrap();
        desks.remote.set_now("2026-03-01T09:00:00Z");
        desks.sync_there();
        retitle(&mut desks.there, &ticket.reference, "Two");
        desks.remote.set_now("2026-03-02T09:00:00Z");
        desks.sync_there();
        desks.sync_here();
        let bound = Some(&desks.bound);
        let (kind, id) = (RecordKind::Ticket, ticket.id.as_str());

        let list = versions(&desks.here, bound, kind, id, Source::Drive).unwrap();
        // The newest revision is the version this desktop holds; it is not listed.
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].timestamp, "2026-03-01T09:00:00Z");
        let detail =
            version_detail(&desks.here, bound, kind, id, Source::Drive, &list[0].id).unwrap();
        assert_eq!(
            detail.fields,
            [VersionField {
                field: "title",
                value: "One".into(),
                current: "Two".into()
            }]
        );

        restore(
            &mut desks.here,
            bound,
            kind,
            id,
            Source::Drive,
            &list[0].id,
            "r",
        )
        .unwrap();
        assert_eq!(
            desks.here.show_ticket(&ticket.reference).unwrap().title,
            "One"
        );
    }

    #[test]
    fn a_version_id_up_to_the_storages_own_limit_is_looked_up_not_refused_unseen() {
        // S3's VersionIds can be 1024 bytes; the storage says whether one exists.
        let mut desks = desks();
        let ticket = desks.there.create_ticket("One").unwrap();
        desks.sync_there();
        desks.sync_here();
        let calls = desks.remote.calls().len();
        let refused = version_detail(
            &desks.here,
            Some(&desks.bound),
            RecordKind::Ticket,
            &ticket.id,
            Source::Drive,
            &"v".repeat(300),
        )
        .unwrap_err();
        assert_eq!(refused.message, "This version is no longer available");
        assert!(desks.remote.calls()[calls..].contains(&RemoteOp::Revisions));
        // Past the limit, nothing is asked.
        let calls = desks.remote.calls().len();
        version_detail(
            &desks.here,
            Some(&desks.bound),
            RecordKind::Ticket,
            &ticket.id,
            Source::Drive,
            &"v".repeat(1025),
        )
        .unwrap_err();
        assert!(!desks.remote.calls()[calls..].contains(&RemoteOp::Revisions));
    }

    #[test]
    fn drive_history_lists_a_newest_revision_this_desktop_has_not_downloaded() {
        let mut desks = desks();
        let ticket = desks.there.create_ticket("One").unwrap();
        desks.remote.set_now("2026-03-01T09:00:00Z");
        desks.sync_there();
        desks.sync_here();
        retitle(&mut desks.there, &ticket.reference, "Two");
        desks.remote.set_now("2026-03-02T09:00:00Z");
        desks.sync_there();
        let bound = Some(&desks.bound);
        let (kind, id) = (RecordKind::Ticket, ticket.id.as_str());

        // This desktop still holds "One": Drive's newest revision is not it.
        let list = versions(&desks.here, bound, kind, id, Source::Drive).unwrap();
        assert_eq!(list[0].timestamp, "2026-03-02T09:00:00Z");
        let detail =
            version_detail(&desks.here, bound, kind, id, Source::Drive, &list[0].id).unwrap();
        assert_eq!(
            detail.fields,
            [VersionField {
                field: "title",
                value: "Two".into(),
                current: "One".into()
            }]
        );
    }

    /// F49: a Drive version larger than a record may be is listed, and is not
    /// read into memory when it is opened or restored.
    #[test]
    fn drive_history_does_not_read_a_version_larger_than_a_record_may_be() {
        let mut desks = desks();
        let ticket = desks.there.create_ticket("One").unwrap();
        desks.sync_there();
        desks.sync_here();
        let key = RemoteKey::new(RemoteKind::Ticket, ticket.id.clone());
        let current = desks.remote.list(&desks.bound.folder).unwrap();
        let current = current.iter().find(|file| file.key == key).unwrap();
        let huge = vec![b'x'; 8 * 1024 * 1024 + 1];
        desks
            .remote
            .write(
                &desks.bound.folder,
                &key,
                "T.md",
                Some(&current.version),
                &mut Cursor::new(huge),
            )
            .unwrap();
        let bound = Some(&desks.bound);
        let (kind, id) = (RecordKind::Ticket, ticket.id.as_str());
        let calls = desks.remote.calls().len();

        let list = versions(&desks.here, bound, kind, id, Source::Drive).unwrap();
        assert_eq!(list.len(), 2);
        let refused =
            version_detail(&desks.here, bound, kind, id, Source::Drive, &list[0].id).unwrap_err();
        assert!(refused.message.contains("8 MiB"), "{}", refused.message);
        let refused = restore(
            &mut desks.here,
            bound,
            kind,
            id,
            Source::Drive,
            &list[0].id,
            "r",
        )
        .unwrap_err();
        assert!(refused.message.contains("8 MiB"), "{}", refused.message);
        assert!(!desks.remote.calls()[calls..].contains(&RemoteOp::Download));
    }

    #[test]
    fn drive_history_says_when_drive_could_not_be_asked() {
        let mut desks = desks();
        let ticket = desks.here.create_ticket("One").unwrap();
        let (kind, id) = (RecordKind::Ticket, ticket.id.as_str());

        // Not connected, or never uploaded: there is nothing earlier, and no failure.
        assert_eq!(
            versions(&desks.here, None, kind, id, Source::Drive).unwrap(),
            []
        );
        let binding = desks.bound.clone();
        let bound = Some(&binding);
        assert_eq!(
            versions(&desks.here, bound, kind, id, Source::Drive).unwrap(),
            []
        );

        desks.sync_here();
        desks
            .remote
            .fail(RemoteOp::Revisions, 1, RemoteError::Offline);
        let failure = versions(&desks.here, bound, kind, id, Source::Drive).unwrap_err();
        assert_eq!(
            failure.message,
            "Could not load versions from Google Drive: the storage cannot be reached"
        );
    }

    #[test]
    fn s3_history_lists_and_restores_the_objects_earlier_versions() {
        let mut desks = desks();
        let ticket = desks.there.create_ticket("One").unwrap();
        desks.remote.set_now("2026-03-01T09:00:00Z");
        desks.sync_there();
        retitle(&mut desks.there, &ticket.reference, "Two");
        desks.remote.set_now("2026-03-02T09:00:00Z");
        desks.sync_there();
        desks.sync_here();
        let bound = Some(&desks.bound);
        let (kind, id) = (RecordKind::Ticket, ticket.id.as_str());

        let list = versions(&desks.here, bound, kind, id, Source::S3).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].timestamp, "2026-03-01T09:00:00Z");
        let detail = version_detail(&desks.here, bound, kind, id, Source::S3, &list[0].id).unwrap();
        assert_eq!(
            detail.fields,
            [VersionField {
                field: "title",
                value: "One".into(),
                current: "Two".into()
            }]
        );

        restore(
            &mut desks.here,
            bound,
            kind,
            id,
            Source::S3,
            &list[0].id,
            "r",
        )
        .unwrap();
        assert_eq!(
            desks.here.show_ticket(&ticket.reference).unwrap().title,
            "One"
        );
    }

    #[test]
    fn s3_history_names_s3_when_it_could_not_be_asked() {
        let mut desks = desks();
        let ticket = desks.here.create_ticket("One").unwrap();
        let (kind, id) = (RecordKind::Ticket, ticket.id.as_str());
        desks.sync_here();
        let binding = desks.bound.clone();
        let bound = Some(&binding);

        desks
            .remote
            .fail(RemoteOp::Revisions, 1, RemoteError::Offline);
        let failure = versions(&desks.here, bound, kind, id, Source::S3).unwrap_err();
        assert_eq!(
            failure.message,
            "Could not load versions from S3: the storage cannot be reached"
        );
        desks
            .remote
            .fail(RemoteOp::Revisions, 1, RemoteError::Offline);
        let failure = version_detail(&desks.here, bound, kind, id, Source::S3, "1").unwrap_err();
        assert_eq!(
            failure.message,
            "Could not load this version from S3: the storage cannot be reached"
        );
    }

    #[test]
    fn a_conflict_inside_an_activity_names_the_activity() {
        let mut desks = desks();
        let ticket = desks.there.create_ticket("Fix login").unwrap();
        let activity = desks
            .there
            .add_activity(&ticket.reference, "Started", None)
            .unwrap();
        desks.sync_there();
        desks.sync_here();
        let brief = |brief: &str| ticketd_core::ActivityPatch {
            brief: Some(brief.into()),
            ..Default::default()
        };
        desks
            .there
            .edit_activity(&ticket.reference, &activity.id, brief("Started there"))
            .unwrap();
        desks
            .here
            .edit_activity(&ticket.reference, &activity.id, brief("Started here"))
            .unwrap();
        desks.sync_there();
        desks.sync_here();

        assert_eq!(conflicts(&desks.here).unwrap()[0].fields, ["activity"]);
        let shown = conflict(&desks.here, SyncKind::Ticket, &ticket.id, None).unwrap();
        let field = &shown.fields[0];
        // The key still resolves the conflict; the section says what it is.
        assert_eq!(field.field, format!("{}:body", activity.id));
        let section = field.section.as_ref().unwrap();
        assert_eq!(section.kind, SyncPartKind::Activity);
        assert!(section.reported_at.is_some());
        assert_eq!(
            (field.local.as_str(), field.remote.as_str()),
            ("Started here", "Started there")
        );
    }

    #[test]
    fn a_failed_sign_in_keeps_the_reason_it_failed_for() {
        let code = |kind| sign_in_failure(DriveError::new(kind, "why")).code;
        assert_eq!(code(DriveErrorKind::Unconfigured), "drive_unconfigured");
        assert_eq!(code(DriveErrorKind::Cancelled), "sign_in_cancelled");
        assert_eq!(code(DriveErrorKind::Offline), "offline");
        assert_eq!(code(DriveErrorKind::InvalidResponse), "failed");
        assert_eq!(
            sign_in_failure(DriveError::new(DriveErrorKind::Unconfigured, "why")).message,
            "why"
        );
    }

    #[test]
    fn the_binding_follows_what_the_workspace_stores() {
        // A Workspace that was never connected.
        let directory = tempfile::tempdir().unwrap();
        let fake = FakeRemote::new();
        let mut here = Workspace::open(directory.path().join("here.sqlite3")).unwrap();
        let bound = |workspace: &Workspace| {
            let fake = fake.clone();
            binding_of(workspace, move |_| Arc::new(fake)).unwrap()
        };
        assert!(bound(&here).is_none());
        here.sync_connect("connection", "mina@example.com").unwrap();
        // Signed in, but no folder chosen: nothing to sync with yet.
        assert!(bound(&here).is_none());

        let status = here.sync_upload_workspace(&fake, "Test").unwrap();
        here.set_sync_settings("Laptop", 90, AttachmentDownload::OnOpen)
            .unwrap();
        let binding = bound(&here).unwrap();
        assert_eq!(binding.folder, status.folder.unwrap().id);
        assert_eq!(binding.device, "Laptop");
        assert_eq!(binding.poll, Duration::from_secs(90));

        here.sync_disconnect().unwrap();
        assert!(bound(&here).is_none());
    }

    #[test]
    fn an_s3_binding_syncs_through_its_bucket_and_goes_with_disconnect() {
        let directory = tempfile::tempdir().unwrap();
        let fake = FakeRemote::new();
        let mut here = Workspace::open(directory.path().join("here.sqlite3")).unwrap();
        let s3 = S3Binding {
            bucket: "team-bucket".into(),
            prefix: "ticketd/".into(),
            profile: "work".into(),
            aws_cli_path: None,
        };
        let reached = |workspace: &Workspace| {
            let fake = fake.clone();
            let mut named = None;
            let bound = binding_of(workspace, |storage| {
                named = Some(match storage {
                    Storage::S3(binding) => binding.clone(),
                    Storage::Drive(_) => panic!("an S3 Workspace reached Drive"),
                });
                Arc::new(fake)
            })
            .unwrap();
            (bound, named)
        };
        // Connected to a bucket, but no folder chosen: nothing to sync with yet.
        here.sync_connect_s3(&s3, "arn:aws:iam::1:user/mina")
            .unwrap();
        assert!(reached(&here).0.is_none());

        let status = here.sync_upload_workspace(&fake, "Test").unwrap();
        let (bound, named) = reached(&here);
        assert_eq!(bound.unwrap().folder, status.folder.unwrap().id);
        assert_eq!(named, Some(s3));

        here.sync_disconnect().unwrap();
        assert!(reached(&here).0.is_none());
    }

    #[test]
    fn an_s3_workspace_uploads_downloads_and_reconnects_after_disconnect() {
        let directory = tempfile::tempdir().unwrap();
        let fake = FakeRemote::new();
        let s3 = S3Binding {
            bucket: "team-bucket".into(),
            prefix: "ticketd/".into(),
            profile: "work".into(),
            aws_cli_path: None,
        };
        let desk = |file: &str, identity: &str| {
            let mut workspace = Workspace::open(directory.path().join(file)).unwrap();
            workspace.sync_connect_s3(&s3, identity).unwrap();
            workspace
        };
        let mut there = desk("there.sqlite3", "arn:aws:iam::1:user/a");
        let ticket = there.create_ticket("Fix login").unwrap();
        there.sync_upload_workspace(&fake, "Test").unwrap();
        there.sync_now(&fake).unwrap();

        // Another desktop, signed in as someone else, takes the Workspace.
        let here = desk("here.sqlite3", "arn:aws:iam::1:user/b");
        let folder = here.sync_setup_options(&fake).unwrap().existing[0]
            .folder_id
            .clone();
        let (mut here, _) = here.sync_download_workspace(&fake, &folder).unwrap();
        here.sync_now(&fake).unwrap();
        assert_eq!(here.sync_status().unwrap().provider, SyncProvider::S3);
        assert!(
            here.export_sync_record(SyncKind::Ticket, &ticket.id)
                .is_ok()
        );

        // Disconnected, then connected to the same bucket again: back to the same folder.
        here.sync_disconnect().unwrap();
        here.sync_connect_s3(&s3, "arn:aws:iam::1:user/b").unwrap();
        let options = here.sync_setup_options(&fake).unwrap();
        assert_eq!(options.reconnect.unwrap().id, folder);
        let status = here.sync_reconnect(&fake).unwrap();
        assert_eq!(status.folder.unwrap().id, folder);
        assert!(here.sync_binding().unwrap().unwrap().s3.is_some());
    }

    #[test]
    fn settings_and_identifiers_are_checked_before_the_core_sees_them() {
        let mut desks = desks();
        let change = |name: &str, poll| SettingsChange {
            desktop_name: name.into(),
            poll_interval_secs: poll,
            attachment_download: AttachmentDownload::Automatic,
        };
        let saved = change_settings(&mut desks.here, &change("Laptop", 30)).unwrap();
        assert_eq!(
            (saved.desktop_name.as_str(), saved.poll_interval_secs),
            ("Laptop", 30)
        );
        assert!(change_settings(&mut desks.here, &change("Laptop", 29)).is_err());
        assert!(change_settings(&mut desks.here, &change(" ", 60)).is_err());
        assert!(change_settings(&mut desks.here, &change(&"n".repeat(101), 60)).is_err());

        assert!(check_folder_id("0c8f3a51-6f0e-4a0b-9d55-2f1f6f3f8a10").is_ok());
        assert!(check_folder_id("").is_err());
        assert!(check_folder_id("' or name contains '").is_err());
        assert!(check_attachment_ids(&[String::new()]).is_err());
    }

    #[test]
    fn a_desktop_the_core_could_not_name_takes_the_computers_name() {
        let mut desks = desks();
        let named = |workspace: &Workspace| workspace.sync_settings().unwrap().desktop_name;
        desks
            .here
            .set_sync_settings("This desktop", 60, AttachmentDownload::Automatic)
            .unwrap();
        name_this_desktop(&mut desks.here, || Some("Mina's MacBook\n".into())).unwrap();
        assert_eq!(named(&desks.here), "Mina's MacBook");

        // A name that is already set is left alone.
        name_this_desktop(&mut desks.here, || Some("Other".into())).unwrap();
        assert_eq!(named(&desks.here), "Mina's MacBook");
    }
}
