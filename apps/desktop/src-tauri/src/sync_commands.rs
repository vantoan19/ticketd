//! Commands for reviewing what sync did: records that need review, notices,
//! History and the exit flush. The core holds the rules; this file validates
//! what the interface sends and words the core's values for display.

use std::{sync::Arc, time::Instant};

use serde::{Deserialize, Serialize};
use ticketd_core::{
    DocumentPatch, Error, RecordKind, Status, SyncKind, SyncRecord, SyncValue, TicketPatch,
    Workspace, WriteRequest,
    sync::{
        DirtyRecord, SyncChoice, SyncConflict, SyncNotice, SyncResolution,
        remote::{RemoteError, RemoteKey, RemoteKind},
    },
};

use super::{BridgeFailure, open_workspace};
use crate::sync_scheduler::{Binding, EXIT_LIMIT, Scheduler};

/// The one scheduler of this process and the instant its time counts from.
pub struct SyncHost {
    pub scheduler: Arc<Scheduler>,
    pub started: Instant,
}

/// What this Workspace syncs with: the scheduler and every command here ask
/// this one function. Nothing connects a Workspace to a Drive folder yet, so
/// it has no connection to report.
pub fn binding() -> Result<Option<Binding>, Error> {
    Ok(None)
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

#[derive(Debug, Serialize)]
pub struct ConflictField {
    field: String,
    local: String,
    local_changed_at: Option<String>,
    remote: String,
    remote_changed_at: Option<String>,
    remote_device: String,
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

fn conflicts(workspace: &Workspace) -> Result<Vec<ConflictSummary>, Error> {
    Ok(workspace
        .sync_conflicts()?
        .into_iter()
        .map(|conflict| ConflictSummary {
            kind: conflict.kind,
            id: conflict.id,
            reference: conflict.reference,
            title: conflict.title,
            fields: conflict.fields.into_iter().map(|f| f.field).collect(),
            detected_at: conflict.detected_at,
            read: conflict.read,
        })
        .collect())
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
                local: display(workspace, field.local.as_ref()),
                remote: display(workspace, field.remote.as_ref()),
                local_changed_at: field.local_changed_at,
                remote_changed_at: field.remote_changed_at,
                remote_device: field
                    .remote_device
                    .unwrap_or_else(|| "Another desktop".into()),
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
                (Choice::Edited, Some(value))
                    if resolution.field == "body" || resolution.field.ends_with(":body") =>
                {
                    SyncChoice::Edited(value)
                }
                (Choice::Edited, _) => return rejected("only the text can be edited"),
            };
            Ok(SyncResolution {
                field: resolution.field,
                choice,
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
    let conflicts = workspace.sync_conflicts()?;
    let notices = workspace.sync_notices()?;
    let unread = conflicts.iter().filter(|conflict| !conflict.read).count()
        + notices.iter().filter(|notice| !notice.read).count();
    Ok(u32::try_from(unread).unwrap_or(u32::MAX))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Local,
    Drive,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct VersionEntry {
    id: String,
    timestamp: String,
    device: Option<String>,
    changed: Vec<String>,
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
    if source == Source::Drive {
        // Without sync there is simply nothing earlier.
        let Some(bound) = bound else {
            return Ok(Vec::new());
        };
        let mut revisions = match bound.remote.revisions(&bound.folder, &remote_key(kind, id)) {
            Ok(revisions) => revisions,
            // Never uploaded: Drive has no versions of it.
            Err(RemoteError::NotFound) => return Ok(Vec::new()),
            Err(error) => {
                return rejected(&format!(
                    "Could not load versions from Google Drive: {error}"
                ));
            }
        };
        // Oldest first, ending with the version this desktop already holds.
        revisions.pop();
        revisions.reverse();
        // ponytail: who wrote a revision and what it changed would cost a download
        // each; fetch them if the Drive list needs more than times.
        return Ok(revisions
            .into_iter()
            .map(|revision| VersionEntry {
                id: revision.version,
                timestamp: revision.modified,
                device: None,
                changed: Vec::new(),
            })
            .collect());
    }
    let reference = match kind {
        RecordKind::Ticket => text(&record, "ref"),
        RecordKind::Document => id.to_owned(),
    };
    let saved = workspace.versions(kind, &reference)?;
    // The core says when and how each version was replaced. The list shows when
    // and how it came to be, which is what replaced the version before it.
    Ok(saved
        .iter()
        .enumerate()
        .map(|(index, version)| match saved.get(index + 1) {
            Some(made_by) => VersionEntry {
                id: version.id.to_string(),
                timestamp: made_by.replaced_at.clone(),
                device: made_by.device.clone(),
                changed: made_by.changed.clone(),
            },
            // The oldest kept version: no earlier change is known. A Document
            // knows when it was created; a ticket only when this version ended.
            None => VersionEntry {
                id: version.id.to_string(),
                timestamp: Some(text(&record, "created_at"))
                    .filter(|created| !created.is_empty())
                    .unwrap_or_else(|| version.replaced_at.clone()),
                device: None,
                changed: vec!["created".into()],
            },
        })
        .collect())
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
            Ok(Content {
                title: saved.title.unwrap_or_default(),
                status: saved.status.map(|status| status.to_string()),
                body: saved.body,
            })
        }
        Source::Drive => {
            let Some(bound) = bound else {
                return rejected("Sync is not connected");
            };
            if version.is_empty() || version.len() > 256 {
                return missing();
            }
            let mut bytes = Vec::new();
            bound
                .remote
                .download(&bound.folder, &remote_key(kind, id), version, &mut bytes)
                .map_err(|error| {
                    BridgeFailure::plain(&format!(
                        "Could not load this version from Google Drive: {error}"
                    ))
                })?;
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
        fields: earlier
            .fields()
            .into_iter()
            .zip(current.fields())
            .filter(|(earlier, current)| earlier.1 != current.1)
            .map(|((field, value), (_, current))| VersionField {
                field,
                value,
                current,
            })
            .collect(),
    })
}

/// Writes an earlier version's title, text and status as an ordinary edit, so
/// what it replaces becomes a version too. Trash is left as it is.
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
    let request = match kind {
        RecordKind::Ticket => WriteRequest::ChangeTicket {
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
        RecordKind::Document => WriteRequest::ChangeDocument {
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

/// One record or file that has not reached Drive.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PendingItem {
    kind: ticketd_core::sync::RecordKind,
    id: String,
    reference: Option<String>,
    title: String,
}

/// Names the records waiting to upload. One that no longer exists is left out.
pub fn pending_items(workspace: &Workspace, pending: Vec<DirtyRecord>) -> Vec<PendingItem> {
    use ticketd_core::sync::RecordKind as Dirty;
    pending
        .into_iter()
        .filter_map(|dirty| {
            let kind = match dirty.kind {
                Dirty::Ticket => SyncKind::Ticket,
                Dirty::Document => SyncKind::Document,
                Dirty::Plan => SyncKind::Plan,
                Dirty::Project => SyncKind::Project,
                Dirty::Attachment => {
                    let file = workspace.attachment(&dirty.id).ok()?;
                    return Some(PendingItem {
                        kind: dirty.kind,
                        id: dirty.id,
                        reference: None,
                        title: file.display_name,
                    });
                }
            };
            let record = workspace.export_sync_record(kind, &dirty.id).ok()?;
            let reference = Some(text(&record, "ref")).filter(|reference| !reference.is_empty());
            let title = [text(&record, "title"), text(&record, "name")]
                .into_iter()
                .find(|title| !title.is_empty())
                .unwrap_or_else(|| "Untitled".into());
            Some(PendingItem {
                kind: dirty.kind,
                id: dirty.id,
                reference,
                title,
            })
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct ExitReport {
    pending: Vec<PendingItem>,
}

#[tauri::command]
pub fn sync_conflicts() -> Outcome<Vec<ConflictSummary>> {
    Ok(conflicts(&open_workspace()?)?)
}

#[tauri::command]
pub fn sync_conflict(
    host: tauri::State<'_, SyncHost>,
    kind: SyncKind,
    id: String,
) -> Outcome<Conflict> {
    let bound = host.scheduler.binding()?;
    Ok(conflict(&open_workspace()?, kind, &id, bound.as_ref())?)
}

#[tauri::command]
pub fn resolve_sync_conflict(
    kind: SyncKind,
    id: String,
    resolutions: Vec<Resolution>,
    request_id: String,
) -> Outcome<()> {
    resolve(&mut open_workspace()?, kind, id, resolutions, &request_id)
}

#[tauri::command]
pub fn sync_notices() -> Outcome<Vec<SyncNotice>> {
    Ok(open_workspace()?.sync_notices()?)
}

#[tauri::command]
pub fn set_sync_read(ids: Vec<String>, read: bool) -> Outcome<()> {
    if ids.len() > 1000 || ids.iter().any(|id| id.is_empty() || id.len() > 128) {
        return rejected("invalid Inbox entries");
    }
    Ok(open_workspace()?.set_sync_read(&ids, read)?)
}

// History reads Drive when asked to, so these run off the UI thread.
#[tauri::command(async)]
pub fn record_versions(
    host: tauri::State<'_, SyncHost>,
    kind: RecordKind,
    id: String,
    source: Source,
) -> Outcome<Vec<VersionEntry>> {
    let bound = host.scheduler.binding()?;
    versions(&open_workspace()?, bound.as_ref(), kind, &id, source)
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
        &open_workspace()?,
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
        &mut open_workspace()?,
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
    let left = host.scheduler.flush(host.started.elapsed(), EXIT_LIMIT)?;
    Ok(ExitReport {
        pending: pending_items(&open_workspace()?, left),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Setup that fails must fail the test.
mod tests {
    use super::*;
    use std::{io::Cursor, time::Duration};
    use ticketd_core::sync::{
        SyncNoticeKind,
        remote::{FakeRemote, RemoteOp, RemoteStorage},
    };

    const FOLDER: &str = "workspace";

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
            self.there.sync(&self.remote, FOLDER, "Desk A").unwrap();
        }
        fn sync_here(&mut self) {
            self.here.sync(&self.remote, FOLDER, "Desk B").unwrap();
        }
    }

    fn desks() -> Desks {
        let directory = tempfile::tempdir().unwrap();
        let remote = FakeRemote::new();
        remote.ensure_folder(FOLDER, "Test").unwrap();
        let there = Workspace::open(directory.path().join("there.sqlite3")).unwrap();
        let mut here = Workspace::open(directory.path().join("here.sqlite3")).unwrap();
        here.renew_device_code().unwrap();
        let bound = Binding {
            folder: FOLDER.into(),
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
        let web = desks.there.create_project("Web", "/work/web").unwrap();
        let api = desks.there.create_project("API", "/work/api").unwrap();
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

    fn choose(field: &str, choice: Choice, value: Option<&str>) -> Resolution {
        Resolution {
            field: field.into(),
            choice,
            value: value.map(str::to_owned),
        }
    }

    #[test]
    fn resolving_applies_the_choices_once_per_request() {
        let mut desks = desks();
        let id = conflicted(&mut desks);
        let choices = || {
            vec![
                choose("status", Choice::Remote, None),
                choose("project", Choice::Local, None),
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
                FOLDER,
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
        // Newest first: "Two" was made by the retitle, "One" by creating the ticket.
        assert_eq!(changed, ["title", "created"]);

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
    fn pending_uploads_are_named_for_the_exit_report() {
        let mut desks = desks();
        let ticket = desks.here.create_ticket("Fix login").unwrap();
        desks.here.create_document(None, "Notes").unwrap();
        let pending = desks.here.dirty_records().unwrap();
        let named: Vec<_> = pending_items(&desks.here, pending)
            .into_iter()
            .map(|item| (item.reference, item.title))
            .collect();
        assert_eq!(
            named,
            [
                (Some(ticket.reference), "Fix login".to_owned()),
                (None, "Untitled".to_owned())
            ]
        );
    }
}
