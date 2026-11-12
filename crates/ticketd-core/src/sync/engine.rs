//! The sync run: download files changed elsewhere, merge them with what this
//! device holds against the last-synced copy, and upload what changed here.
//!
//! Nothing here deletes a record, and a failing storage call ends the run with
//! everything still marked for the next one.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Cursor,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    RecordKind,
    capture::mark_dirty,
    merge::{BlockedBy, loop_edges, merge},
    remote::{RemoteError, RemoteFile, RemoteKey, RemoteKind, RemoteStorage},
};
use crate::{
    Error, SyncKind, SyncPart, SyncRecord, SyncValue, Workspace,
    sync_files::{MAX_FILE_BYTES, find_record, from_newer_version, resolve_ticket_references},
};

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/// The header comment naming the desktop that wrote a file.
const DEVICE_LINE: &str = "# synced from: ";

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(&format!(
        "-- The last-synced copy of each file. `wanted` and `applied` are set while a
         -- relationship of the record waits for a record that has not arrived.
         CREATE TABLE IF NOT EXISTS sync_files (kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT, content TEXT, wanted TEXT, applied TEXT, PRIMARY KEY(kind, id));
         CREATE TABLE IF NOT EXISTS sync_conflicts (kind TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL, base TEXT, remote TEXT, remote_device TEXT, detected_at TEXT NOT NULL DEFAULT ({NOW}), read INTEGER NOT NULL DEFAULT 0, remote_changed_at TEXT, PRIMARY KEY(kind, id, field));
         CREATE TABLE IF NOT EXISTS sync_notices (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL DEFAULT ({NOW}), read INTEGER NOT NULL DEFAULT 0, notice TEXT NOT NULL, cause TEXT NOT NULL UNIQUE);"
    ))?;
    // `remote_changed_at` is here for a Workspace that made the table before it had one.
    for (table, column) in [
        ("dependencies", "created_at"),
        ("sync_conflicts", "remote_changed_at"),
    ] {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !present {
            connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT;"))?;
        }
    }
    // The time orders dependencies the same way on every device. An applied
    // file sets it from the file; one made here gets this device's clock.
    connection.execute_batch(&format!(
        "CREATE TRIGGER IF NOT EXISTS sync_dependency_time AFTER INSERT ON dependencies WHEN NEW.created_at IS NULL BEGIN
            UPDATE dependencies SET created_at = {NOW} WHERE blocker_id = NEW.blocker_id AND dependent_id = NEW.dependent_id;
         END;"
    ))?;
    Ok(())
}

/// What one sync run did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncReport {
    /// Files written to the storage.
    pub uploaded: usize,
    /// Files changed elsewhere that were merged into this Workspace.
    pub downloaded: usize,
    /// Fields newly waiting for review.
    pub conflicts: usize,
    /// Files skipped as unreadable, each with a notice.
    pub skipped: usize,
    /// Records still waiting to upload after the run.
    pub pending: usize,
}

/// One field of a record that this device and another changed differently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConflictField {
    /// A header field name or `body`; `<section GUID>:<field>` inside an
    /// Activity or Implementation evidence section.
    pub field: String,
    pub base: Option<SyncValue>,
    /// The value this Workspace holds now.
    pub local: Option<SyncValue>,
    pub remote: Option<SyncValue>,
    /// The desktop the remote value came from, when its file names one.
    pub remote_device: Option<String>,
    /// When this device last changed the field. Known for the `title`, `body`,
    /// `status` and `trashed` of a ticket or Document, while version history keeps it.
    pub local_changed_at: Option<String>,
    /// When the storage received the file holding the remote value, if it could say.
    pub remote_changed_at: Option<String>,
    pub detected_at: String,
}

/// A record that needs review, with every field still in conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConflict {
    pub kind: SyncKind,
    pub id: String,
    /// The Ticket reference; `None` for other kinds.
    pub reference: Option<String>,
    pub title: String,
    pub detected_at: String,
    pub read: bool,
    pub fields: Vec<SyncConflictField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncChoice {
    Local,
    Remote,
    Edited(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncResolution {
    pub field: String,
    pub choice: SyncChoice,
}

/// Something sync did that needs no decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncNoticeKind {
    /// A dependency that closed a loop was removed from `reference`.
    DependencyRemoved {
        ticket_id: String,
        reference: String,
        title: String,
        /// Always `blocked_by`: the notice is about the blocked ticket.
        relation: String,
        /// The Ticket reference of the ticket that no longer blocks it.
        other: String,
    },
    /// A parent link that closed a loop was removed from the child `reference`.
    ParentRemoved {
        ticket_id: String,
        reference: String,
        title: String,
        other: String,
    },
    /// A file in the storage could not be used and was left alone.
    UnreadableFile { path: String, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncNotice {
    pub id: String,
    pub timestamp: String,
    pub read: bool,
    #[serde(flatten)]
    pub notice: SyncNoticeKind,
}

fn remote_kind(kind: SyncKind) -> RemoteKind {
    match kind {
        SyncKind::Project => RemoteKind::Project,
        SyncKind::Document => RemoteKind::Document,
        SyncKind::Plan => RemoteKind::Plan,
        SyncKind::Ticket => RemoteKind::Ticket,
    }
}

pub(super) fn dirty_kind(kind: SyncKind) -> RecordKind {
    match kind {
        SyncKind::Project => RecordKind::Project,
        SyncKind::Document => RecordKind::Document,
        SyncKind::Plan => RecordKind::Plan,
        SyncKind::Ticket => RecordKind::Ticket,
    }
}

/// The kind as the sync tables spell it, which is also how the storage does.
fn name(kind: SyncKind) -> &'static str {
    kind.name()
}

/// What this device remembers of one record's file.
#[derive(Default)]
struct Stored {
    /// The storage's identity of the file that version belongs to.
    file: Option<String>,
    /// When the storage made that file.
    file_created: Option<String>,
    /// The remote version last merged or written.
    version: Option<String>,
    /// The file as last synced: the base of the next merge.
    base: Option<SyncRecord>,
    /// The record this device should hold, kept while part of it could not be
    /// applied because a record it names has not arrived.
    wanted: Option<SyncRecord>,
    /// What the Workspace held right after that partial apply.
    applied: Option<SyncRecord>,
    /// The file in the storage is one only a newer ticketd reads: it is not
    /// replaced from here.
    newer: bool,
}

fn stored(connection: &Connection, kind: SyncKind, id: &str) -> Result<Stored, Error> {
    let row: Option<([Option<String>; 6], bool)> = connection
        .query_row(
            "SELECT version, content, wanted, applied, file, file_created, newer FROM sync_files WHERE kind = ?1 AND id = ?2",
            params![name(kind), id],
            |row| {
                Ok((
                    [
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ],
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some(([version, base, wanted, applied, file, file_created], newer)) = row else {
        return Ok(Stored::default());
    };
    // A copy this version cannot read is no copy: the record is then merged as
    // one that never synced, where a differing value goes to review instead of
    // being taken or sent silently.
    let parse = |text: Option<String>| text.and_then(|text| SyncRecord::parse(&text).ok());
    Ok(Stored {
        file,
        file_created,
        version,
        base: parse(base),
        wanted: parse(wanted),
        applied: parse(applied),
        newer,
    })
}

fn store(connection: &Connection, kind: SyncKind, id: &str, stored: &Stored) -> Result<(), Error> {
    let text = |record: &Option<SyncRecord>| record.as_ref().map(SyncRecord::to_markdown);
    connection.execute(
        "INSERT INTO sync_files (kind, id, version, content, wanted, applied, newer, file, file_created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(kind, id) DO UPDATE SET version = excluded.version, content = excluded.content, wanted = excluded.wanted, applied = excluded.applied, newer = excluded.newer, file = excluded.file, file_created = excluded.file_created",
        params![name(kind), id, stored.version, text(&stored.base), text(&stored.wanted), text(&stored.applied), stored.newer, stored.file, stored.file_created],
    )?;
    Ok(())
}

/// Views poll the change token; conflicts and notices are part of what they show.
pub(super) fn touch(connection: &Connection) -> Result<(), Error> {
    connection.execute("UPDATE workspace_changes SET token = token + 1", [])?;
    Ok(())
}

pub(super) fn notify(
    connection: &Connection,
    cause: &str,
    notice: &SyncNoticeKind,
) -> Result<(), Error> {
    notify_once(connection, cause, notice, false).map(|_| ())
}

/// Record a notice unless its cause already has one; says whether it was new.
fn notify_once(
    connection: &Connection,
    cause: &str,
    notice: &SyncNoticeKind,
    read: bool,
) -> Result<bool, Error> {
    let notice =
        serde_json::to_string(notice).map_err(|error| Error::SyncFile(error.to_string()))?;
    // One notice per cause, however many runs meet it again.
    let recorded = connection.execute(
        "INSERT OR IGNORE INTO sync_notices (id, notice, cause, read) VALUES (?1, ?2, ?3, ?4)",
        params![format!("notice-{}", Uuid::new_v4()), notice, cause, read],
    )?;
    if recorded > 0 {
        touch(connection)?;
    }
    Ok(recorded > 0)
}

/// The ticket of this Workspace, other than `record`, that holds the external
/// source identity `record` carries.
fn source_holder(connection: &Connection, record: &SyncRecord) -> Result<Option<String>, Error> {
    let field = |name: &str| match record.fields.get(name) {
        Some(SyncValue::Text(text)) => Some(text.as_str()),
        _ => None,
    };
    let (Some(provider), Some(external)) = (field("source_provider"), field("source_external_id"))
    else {
        return Ok(None);
    };
    Ok(connection
        .query_row(
            "SELECT ticket_id FROM external_identities WHERE provider = ?1 AND external_id = ?2 AND ticket_id != ?3",
            params![provider, external, record.id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Take the source fields off a ticket and make it a Duplicate of `canonical`,
/// the ticket that keeps the source. A ticket that already is a Duplicate
/// stays the duplicate it was.
fn duplicate_without_source(record: &mut SyncRecord, canonical: &str) {
    let fields = &mut record.fields;
    fields.retain(|name, _| !name.starts_with("source_"));
    let duplicate = SyncValue::Text("Duplicate".into());
    if fields.get("status") == Some(&duplicate) {
        return;
    }
    if let Some(status) = fields.insert("status".into(), duplicate) {
        fields.insert("duplicate_restore".into(), status);
    }
    fields.insert("duplicate_of".into(), SyncValue::Text(canonical.into()));
}

/// The two relationships sync removes to break a loop, as the ticket file
/// fields that carry the removals to every desktop.
const REMOVED: [(&str, &str); 2] = [
    ("blocked_by_removed", "dependency"),
    ("parent_removed", "parent"),
];

/// The removals this desktop has recorded for a ticket, as the items of its
/// file's `blocked_by_removed` and `parent_removed` fields: the other ticket's
/// GUID, followed by the time the dependency was made when it has one.
pub(crate) fn removed_by_sync(
    connection: &Connection,
    ticket: &str,
) -> Result<[(&'static str, BTreeSet<String>); 2], Error> {
    let mut found = REMOVED.map(|(field, _)| (field, BTreeSet::new()));
    let mut statement =
        connection.prepare_cached("SELECT cause FROM sync_notices WHERE cause LIKE ?1")?;
    for ((_, items), (_, cause)) in found.iter_mut().zip(REMOVED) {
        let prefix = format!("{cause}:{ticket}:");
        let causes = statement.query_map([format!("{prefix}%")], |row| row.get::<_, String>(0))?;
        for cause in causes {
            // `<other GUID>` or `<other GUID>:<time>`; a GUID holds no colon.
            let cause = cause?;
            let rest = cause.strip_prefix(&prefix).unwrap_or_default();
            let (other, time) = rest.split_once(':').unwrap_or((rest, ""));
            items.insert(format!("{other} {time}").trim_end().to_owned());
        }
    }
    Ok(found)
}

/// Record that sync removed a relationship of `ticket` to break a loop: one
/// notice and one history entry on each of the two tickets, once per desktop
/// however often and from wherever the removal is learned. `false` when one of
/// the tickets is not in this Workspace yet.
fn note_removed(
    connection: &Connection,
    field: &str,
    ticket: &str,
    item: &str,
    read: bool,
) -> Result<bool, Error> {
    let (other_id, time) = item.split_once(' ').unwrap_or((item, ""));
    let named = |id: &str| -> Result<Option<(String, String)>, Error> {
        Ok(connection
            .query_row(
                "SELECT reference, title FROM tickets WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    };
    let (Some((reference, title)), Some((other, _))) = (named(ticket)?, named(other_id)?) else {
        return Ok(false);
    };
    let dependency = field == "blocked_by_removed";
    let (cause, kind, relations, notice) = if dependency {
        (
            format!("dependency:{ticket}:{other_id}:{time}"),
            "sync_dependency_removed",
            ["blocked_by", "blocks"],
            SyncNoticeKind::DependencyRemoved {
                ticket_id: ticket.to_owned(),
                reference: reference.clone(),
                title,
                relation: "blocked_by".into(),
                other: other.clone(),
            },
        )
    } else {
        (
            format!("parent:{ticket}:{other_id}"),
            "sync_parent_removed",
            ["parent", "child"],
            SyncNoticeKind::ParentRemoved {
                ticket_id: ticket.to_owned(),
                reference: reference.clone(),
                title,
                other: other.clone(),
            },
        )
    };
    if notify_once(connection, &cause, &notice, read)? {
        for (ticket, other, relation) in [
            (ticket, &other, relations[0]),
            (other_id, &reference, relations[1]),
        ] {
            connection.execute(
                "INSERT INTO ticket_history (ticket_id, kind, from_value, to_value) VALUES (?1, ?2, ?3, ?4)",
                params![ticket, kind, other, relation],
            )?;
        }
    }
    Ok(true)
}

/// Record the removals a ticket's file carries. `false` while one of them
/// names a ticket that has not arrived.
fn note_removals(connection: &Connection, record: &SyncRecord, read: bool) -> Result<bool, Error> {
    let mut all = true;
    for (field, _) in REMOVED {
        if let Some(SyncValue::Set(items)) = record.fields.get(field) {
            for item in items {
                all &= note_removed(connection, field, &record.id, item, read)?;
            }
        }
    }
    Ok(all)
}

/// The source fields describe one refresh from the tracker and go together.
/// When both sides refreshed, the later `source_updated_at` wins as a whole:
/// mixing two refreshes field by field, or asking a person, helps nobody.
fn settle_source(
    base: Option<&SyncRecord>,
    local: &SyncRecord,
    remote: &SyncRecord,
    merged: &mut super::merge::Merged,
) {
    let group = |record: &SyncRecord| -> BTreeMap<String, SyncValue> {
        let source = record.fields.iter();
        source
            .filter(|(name, _)| name.starts_with("source_"))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    };
    let (ours, theirs) = (group(local), group(remote));
    let before = base.map(group).unwrap_or_default();
    if ours == theirs || ours == before || theirs == before {
        return;
    }
    // Equal times fall back to the values, so both devices pick the same side.
    let age = |group: &BTreeMap<String, SyncValue>| {
        let time = match group.get("source_updated_at") {
            Some(SyncValue::Text(time)) => chrono::DateTime::parse_from_rfc3339(time).ok(),
            _ => None,
        };
        (time, group.clone())
    };
    let later = if age(&theirs) > age(&ours) {
        theirs
    } else {
        ours
    };
    merged.fields.retain(|name, _| !name.starts_with("source_"));
    merged.fields.extend(later);
    merged
        .conflicts
        .retain(|conflict| !conflict.field.starts_with("source_"));
}

/// Merge two versions of a record against their last-synced copy. Sections are
/// matched by GUID; one removed on a side that the other side changed is kept.
/// Conflicts keep the local value and name sections as `<GUID>:<field>`.
fn merge_records(
    base: Option<&SyncRecord>,
    local: &SyncRecord,
    remote: &SyncRecord,
) -> (SyncRecord, Vec<super::merge::Conflict>) {
    let empty = BTreeMap::new();
    let top = merge(
        base.map_or(&empty, |base| &base.fields),
        &local.fields,
        &remote.fields,
    );
    let mut top = top;
    settle_source(base, local, remote, &mut top);
    let mut conflicts = top.conflicts;
    let part = |record: Option<&'_ SyncRecord>, id: &str| {
        record.and_then(|record| record.parts.iter().find(|part| part.id == id).cloned())
    };
    let ids: BTreeSet<&String> = local
        .parts
        .iter()
        .chain(&remote.parts)
        .map(|part| &part.id)
        .collect();
    let mut parts = Vec::new();
    for id in ids {
        let (b, l, r) = (
            part(base, id),
            part(Some(local), id),
            part(Some(remote), id),
        );
        let kept = match (b, l, r) {
            (b, Some(l), Some(r)) => {
                let mut merged = merge(
                    b.as_ref().map_or(&empty, |b| &b.fields),
                    &l.fields,
                    &r.fields,
                );
                for conflict in merged.conflicts {
                    // Any edit moves the time, so two edits always differ here; the
                    // later time describes the merged section.
                    if conflict.field == "updated_at" {
                        if conflict.remote > conflict.local {
                            merged
                                .fields
                                .extend(conflict.remote.map(|later| (conflict.field, later)));
                        }
                    } else {
                        conflicts.push(super::merge::Conflict {
                            field: format!("{id}:{}", conflict.field),
                            ..conflict
                        });
                    }
                }
                Some(SyncPart {
                    fields: merged.fields,
                    ..l
                })
            }
            // Removed on one side: gone, unless the other side changed it meanwhile.
            (Some(b), Some(changed), None) | (Some(b), None, Some(changed)) => {
                (changed != b).then_some(changed)
            }
            (None, Some(added), None) | (None, None, Some(added)) => Some(added),
            (_, None, None) => None,
        };
        parts.extend(kept);
    }
    parts.sort_by(|a, b| a.order().cmp(&b.order()));
    let merged = SyncRecord {
        kind: local.kind,
        id: local.id.clone(),
        fields: top.fields,
        parts,
    };
    (merged, conflicts)
}

/// The record this device means to hold: what the Workspace holds, plus any
/// relationship still waiting for its target.
fn local_view(
    connection: &Connection,
    kind: SyncKind,
    id: &str,
    stored: &Stored,
) -> Result<Option<SyncRecord>, Error> {
    let Some(local) = find_record(connection, kind, id)? else {
        return Ok(None);
    };
    Ok(Some(match (&stored.applied, &stored.wanted) {
        (Some(applied), Some(wanted)) => merge_records(Some(applied), &local, wanted).0,
        _ => local,
    }))
}

fn value_at<'a>(record: &'a SyncRecord, field: &str) -> Option<&'a SyncValue> {
    match field.split_once(':') {
        Some((part, field)) => record
            .parts
            .iter()
            .find(|candidate| candidate.id == part)?
            .fields
            .get(field),
        None => record.fields.get(field),
    }
}

fn set_at(record: &mut SyncRecord, field: &str, value: Option<SyncValue>) {
    let (fields, field) = match field.split_once(':') {
        Some((part, field)) => {
            match record
                .parts
                .iter_mut()
                .find(|candidate| candidate.id == part)
            {
                Some(part) => (&mut part.fields, field),
                None => return,
            }
        }
        None => (&mut record.fields, field),
    };
    match value {
        Some(value) => fields.insert(field.to_owned(), value),
        None => fields.remove(field),
    };
}

fn json<T: Serialize>(value: &T) -> Result<String, Error> {
    serde_json::to_string(value).map_err(|error| Error::SyncFile(error.to_string()))
}

fn from_json(text: Option<String>) -> Result<Option<SyncValue>, Error> {
    match text {
        Some(text) => {
            serde_json::from_str(&text).map_err(|error| Error::SyncFile(error.to_string()))
        }
        None => Ok(None),
    }
}

/// The desktop a file says it was written by.
fn device_of(file: &str) -> Option<String> {
    file.lines()
        .skip(1)
        .take_while(|line| line.trim_end() != "---")
        .find_map(|line| line.strip_prefix(DEVICE_LINE))
        .map(|device| device.trim().to_owned())
        .filter(|device| !device.is_empty())
}

fn with_device(file: &str, device: &str) -> String {
    let device: String = device.chars().filter(|c| !c.is_control()).collect();
    match file.split_once('\n') {
        Some((first, rest)) if !device.trim().is_empty() => {
            format!("{first}\n{DEVICE_LINE}{}\n{rest}", device.trim())
        }
        _ => file.to_owned(),
    }
}

/// A failure that condemns one file, not the run: the file is skipped with a notice.
fn is_file_fault(error: &Error) -> bool {
    match error {
        Error::SyncFile(_) => true,
        Error::Database(rusqlite::Error::SqliteFailure(failure, _)) => {
            failure.code == rusqlite::ErrorCode::ConstraintViolation
        }
        _ => false,
    }
}

/// Whether another file than the one last synced still shares its history. One
/// made later does: a desktop wrote it from the same content after the first
/// went missing, so the copy kept here remains the base of the merge. One made
/// earlier is an old file that came back, and a time that cannot be read
/// proves nothing: its content is merged as a record that never synced, so a
/// value that differs waits for review instead of replacing a newer edit.
fn made_no_earlier(created: &str, known: Option<&str>) -> bool {
    let time = |text: &str| chrono::DateTime::parse_from_rfc3339(text).ok();
    match (time(created), known.and_then(time)) {
        (Some(created), Some(known)) => created >= known,
        _ => false,
    }
}

/// The text of a version another device wrote between this device's last sync
/// and its update, when the storage accepted the update anyway. Drive checks
/// the expected version just before it uploads, so a write landing in between
/// is replaced as the current version and only its revision remains.
fn replaced_revision(
    remote: &dyn RemoteStorage,
    folder: &str,
    key: &RemoteKey,
    expected: &str,
    written: &str,
) -> Result<Option<String>, Error> {
    let revisions = match remote.revisions(folder, key) {
        Ok(revisions) => revisions,
        Err(RemoteError::NotFound) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let before = revisions
        .iter()
        .position(|revision| revision.version == written)
        .and_then(|ours| ours.checked_sub(1))
        .map(|index| revisions[index].version.as_str());
    let fits = |version: &str| {
        revisions
            .iter()
            .any(|revision| revision.version == version && revision.size <= MAX_FILE_BYTES)
    };
    let Some(before) = before.filter(|before| *before != expected && fits(before)) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    match remote.download(folder, key, before, &mut bytes) {
        Ok(()) => Ok(String::from_utf8(bytes).ok()),
        Err(RemoteError::NotFound) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

impl Workspace {
    /// One sync run against the Workspace folder `folder` of `remote`, as the
    /// desktop named `device`. Safe to repeat and to interrupt: a storage
    /// failure returns the error with every unsent change still pending.
    pub fn sync(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        device: &str,
    ) -> Result<SyncReport, Error> {
        let listing = remote.list(folder)?;
        self.sync_listed(remote, folder, device, listing)
    }

    /// A sync run over a listing of the folder that the caller already holds.
    pub(super) fn sync_listed(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        device: &str,
        listing: Vec<RemoteFile>,
    ) -> Result<SyncReport, Error> {
        let mut report = SyncReport::default();
        let arrived = self.download(remote, folder, listing, &mut report)?;
        self.withdraw_agreed_conflicts()?;
        self.retry_waiting(&arrived)?;
        self.drop_loops()?;
        self.upload(remote, folder, device, &mut report)?;
        report.pending = self.dirty_records()?.len();
        Ok(report)
    }

    fn download(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        listing: Vec<RemoteFile>,
        report: &mut SyncReport,
    ) -> Result<BTreeSet<String>, Error> {
        // The records this run brought to this desktop for the first time.
        let mut arrived = BTreeSet::new();
        self.restore_unlisted(&listing)?;
        let mut files: Vec<(SyncKind, RemoteFile)> = listing
            .into_iter()
            .filter_map(|file| Some((SyncKind::parse(file.key.kind.as_str())?, file)))
            .collect();
        // Projects, Documents and Plans first, so most relationships find their target.
        files.sort_by(|a, b| (a.0, &a.1.key.id).cmp(&(b.0, &b.1.key.id)));
        for (kind, file) in files {
            let id = file.key.id.as_str();
            let seen: Option<String> = self
                .connection
                .query_row(
                    "SELECT version FROM sync_files WHERE kind = ?1 AND id = ?2",
                    params![name(kind), id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            if seen.as_deref() == Some(&file.version) {
                continue;
            }
            if file.size > MAX_FILE_BYTES {
                report.skipped += 1;
                let reason = format!(
                    "the file is larger than {} MiB, the most a record's file may be",
                    MAX_FILE_BYTES / (1024 * 1024)
                );
                self.skip(kind, &file, &Error::SyncFile(reason), false)?;
                continue;
            }
            let mut bytes = Vec::new();
            match remote.download(folder, &file.key, &file.version, &mut bytes) {
                Ok(()) => {}
                // Replaced since the listing; the next run sees the newer version.
                Err(RemoteError::NotFound) => continue,
                Err(error) => return Err(error.into()),
            }
            let text = String::from_utf8(bytes);
            let merged = match &text {
                Ok(text) => self.merge_incoming(kind, id, &file, text, &mut arrived),
                Err(_) => Err(Error::SyncFile("the file is not UTF-8 text".into())),
            };
            match merged {
                Ok(conflicts) => {
                    report.downloaded += 1;
                    report.conflicts += conflicts;
                    if conflicts > 0 {
                        self.time_conflicts(remote, folder, kind, &file)?;
                    }
                }
                Err(error) if is_file_fault(&error) => {
                    report.skipped += 1;
                    let newer = matches!(error, Error::SyncFile(_))
                        && text.as_deref().is_ok_and(from_newer_version);
                    self.skip(kind, &file, &error, newer)?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(arrived)
    }

    /// Withdraw the fields in review that an edit on this device has since
    /// given the other value: nothing is left to decide.
    fn withdraw_agreed_conflicts(&mut self) -> Result<(), Error> {
        let mut withdrawn = false;
        for conflict in self.sync_conflicts()? {
            for field in conflict
                .fields
                .iter()
                .filter(|field| field.local == field.remote)
            {
                self.connection.execute(
                    "DELETE FROM sync_conflicts WHERE kind = ?1 AND id = ?2 AND field = ?3",
                    params![name(conflict.kind), conflict.id, field.field],
                )?;
                withdrawn = true;
            }
        }
        if withdrawn {
            touch(&self.connection)?;
        }
        Ok(())
    }

    /// Mark for upload every record whose synced file the listing does not
    /// hold. A missing file is never a deletion: if it is really gone the
    /// upload puts it back, and if the listing only left it out the write
    /// finds the file there and changes nothing.
    fn restore_unlisted(&mut self, listing: &[RemoteFile]) -> Result<(), Error> {
        let listed: BTreeSet<(&str, &str)> = listing
            .iter()
            .map(|file| (file.key.kind.as_str(), file.key.id.as_str()))
            .collect();
        let mut statement = self
            .connection
            .prepare("SELECT kind, id FROM sync_files WHERE version IS NOT NULL OR newer")?;
        let synced = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (kind, id) in synced {
            let Some(kind) = SyncKind::parse(&kind) else {
                continue;
            };
            if listed.contains(&(name(kind), id.as_str())) {
                continue;
            }
            // Without a version the upload creates the file, and a later
            // listing that holds it again is merged against the kept copy. A
            // file that was held back as one from a newer ticketd is gone too.
            self.connection.execute(
                "UPDATE sync_files SET version = NULL, newer = 0 WHERE kind = ?1 AND id = ?2",
                params![name(kind), id],
            )?;
            mark_dirty(&self.connection, dirty_kind(kind), &id)?;
        }
        Ok(())
    }

    /// Note when the storage received the version the new conflicts came from.
    /// The time is for display only, so a storage that cannot give it now is
    /// not asked again and does not fail the run.
    fn time_conflicts(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        kind: SyncKind,
        file: &RemoteFile,
    ) -> Result<(), Error> {
        let modified = remote.revisions(folder, &file.key).ok().and_then(|all| {
            all.into_iter()
                .find(|revision| revision.version == file.version)
                .map(|revision| revision.modified)
        });
        self.connection.execute(
            "UPDATE sync_conflicts SET remote_changed_at = ?3 WHERE kind = ?1 AND id = ?2 AND remote_changed_at IS NULL",
            params![name(kind), file.key.id, modified],
        )?;
        Ok(())
    }

    /// Leave an unusable file alone and say so once. Its version is remembered so
    /// it is not read again, and a later local change replaces it.
    ///
    /// A file only a `newer` ticketd reads is different: it is never replaced
    /// from here, and it is read again on every run, so the run after this
    /// desktop is updated takes it.
    // ponytail: one download per such file per run; remember the version and
    // re-read after an update of the app if a folder ever holds many of them.
    fn skip(
        &mut self,
        kind: SyncKind,
        file: &RemoteFile,
        error: &Error,
        newer: bool,
    ) -> Result<(), Error> {
        let id = file.key.id.as_str();
        let transaction = self.connection.savepoint()?;
        let mut seen = stored(&transaction, kind, id)?;
        seen.newer = newer;
        if !newer {
            // Which file was last synced stays as it was: nothing of this one
            // was merged, so once corrected it is still compared with that one.
            seen.version = Some(file.version.clone());
        }
        store(&transaction, kind, id, &seen)?;
        let reason = match error {
            Error::SyncFile(reason) => reason.clone(),
            error => error.to_string(),
        };
        notify(
            &transaction,
            &format!("unreadable:{}:{id}:{}", name(kind), file.version),
            &SyncNoticeKind::UnreadableFile {
                path: format!("{}/{}", kind.table(), file.name),
                reason,
            },
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Merge one downloaded file into the Workspace and remember it as the
    /// last-synced copy. Returns how many fields newly need review.
    fn merge_incoming(
        &mut self,
        kind: SyncKind,
        id: &str,
        from: &RemoteFile,
        file: &str,
        arrived: &mut BTreeSet<String>,
    ) -> Result<usize, Error> {
        let mut remote = SyncRecord::parse(file)?;
        if remote.kind != kind || remote.id != id {
            return Err(Error::SyncFile(
                "the file's kind and id do not match where it is stored".into(),
            ));
        }
        let device = device_of(file);
        self.applying_incoming(device.as_deref(), |workspace| {
            // A hand edit may name a ticket by its reference; records hold GUIDs.
            resolve_ticket_references(&workspace.connection, &mut remote)?;
            let mut stored = stored(&workspace.connection, kind, id)?;
            stored.newer = false;
            if stored.file.as_deref().is_some_and(|known| known != from.file_id)
                && !made_no_earlier(&from.created, stored.file_created.as_deref())
            {
                stored.base = None;
            }
            let (merged, conflicts) = match local_view(&workspace.connection, kind, id, &stored)? {
                Some(local) => merge_records(stored.base.as_ref(), &local, &remote),
                None => {
                    arrived.insert(id.to_owned());
                    (remote.clone(), Vec::new())
                }
            };
            // Two desktops can each import the same external issue before they
            // sync, as two tickets. Only one ticket may hold a source identity:
            // the lower GUID keeps it on every desktop, and the other becomes a
            // Duplicate of it without the source.
            let mut merged = merged;
            let mut demoted = None;
            if let Some(holder) = source_holder(&workspace.connection, &merged)? {
                if holder.as_str() < id {
                    duplicate_without_source(&mut merged, &holder);
                } else if let Some(mut other) =
                    find_record(&workspace.connection, SyncKind::Ticket, &holder)?
                {
                    // It gives the identity up before the incoming ticket takes it.
                    other
                        .fields
                        .retain(|name, _| !name.starts_with("source_"));
                    workspace.apply_sync_record(&other)?;
                    duplicate_without_source(&mut other, id);
                    demoted = Some(other);
                }
            }
            let missing = workspace.apply_sync_record(&merged)?;
            if let Some(other) = demoted {
                workspace.apply_sync_record(&other)?;
                mark_dirty(&workspace.connection, RecordKind::Ticket, &other.id)?;
            }
            let connection = &workspace.connection;
            // A removal that came with a record new to this desktop is old news
            // here: it is recorded as read.
            let noted = note_removals(connection, &merged, arrived.contains(id))?;
            (stored.wanted, stored.applied) = if missing.is_empty() && noted {
                (None, None)
            } else {
                (Some(merged.clone()), find_record(connection, kind, id)?)
            };
            // A field already in review is settled when the other side changed it
            // again without a new conflict, or when it now holds the other value.
            let mut waiting = connection
                .prepare("SELECT field, remote FROM sync_conflicts WHERE kind = ?1 AND id = ?2")?;
            let waiting = waiting
                .query_map(params![name(kind), id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut withdrawn = false;
            for (field, other) in waiting {
                if conflicts.iter().any(|conflict| conflict.field == field) {
                    continue;
                }
                let moved = stored
                    .base
                    .as_ref()
                    .is_some_and(|base| value_at(base, &field) != value_at(&remote, &field));
                if moved || value_at(&merged, &field) == from_json(other)?.as_ref() {
                    connection.execute(
                        "DELETE FROM sync_conflicts WHERE kind = ?1 AND id = ?2 AND field = ?3",
                        params![name(kind), id, field],
                    )?;
                    withdrawn = true;
                }
            }
            stored.version = Some(from.version.clone());
            stored.file = Some(from.file_id.clone());
            stored.file_created = Some(from.created.clone());
            // What local changes remain shows as a difference from the remote copy.
            if merged != remote {
                mark_dirty(connection, dirty_kind(kind), id)?;
            }
            stored.base = Some(remote);
            store(connection, kind, id, &stored)?;
            for conflict in &conflicts {
                connection.execute(
                    &format!(
                        "INSERT INTO sync_conflicts (kind, id, field, base, remote, remote_device) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(kind, id, field) DO UPDATE SET base = excluded.base, remote = excluded.remote, remote_device = excluded.remote_device, remote_changed_at = NULL, detected_at = {NOW}, read = 0"
                    ),
                    params![
                        name(kind),
                        id,
                        conflict.field,
                        conflict.base.as_ref().map(json).transpose()?,
                        conflict.remote.as_ref().map(json).transpose()?,
                        device
                    ],
                )?;
            }
            if withdrawn || !conflicts.is_empty() {
                touch(connection)?;
            }
            Ok(conflicts.len())
        })
    }

    /// Apply again the records whose relationships waited for a record to arrive.
    // ponytail: every waiting record is re-applied on every run; an Attachment link
    // waits until Attachment rows sync. Index the awaited ids if this gets slow.
    fn retry_waiting(&mut self, arrived: &BTreeSet<String>) -> Result<(), Error> {
        let mut statement = self.connection.prepare(
            "SELECT kind, id FROM sync_files WHERE wanted IS NOT NULL ORDER BY kind, id",
        )?;
        let waiting = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (kind, id) in waiting {
            let Some(kind) = SyncKind::parse(&kind) else {
                continue;
            };
            self.applying_incoming(None, |workspace| {
                let mut stored = stored(&workspace.connection, kind, &id)?;
                let Some(wanted) = local_view(&workspace.connection, kind, &id, &stored)? else {
                    return Ok(());
                };
                let missing = workspace.apply_sync_record(&wanted)?;
                let noted = note_removals(&workspace.connection, &wanted, arrived.contains(&id))?;
                (stored.wanted, stored.applied) = if missing.is_empty() && noted {
                    (None, None)
                } else {
                    let applied = find_record(&workspace.connection, kind, &id)?;
                    (Some(wanted), applied)
                };
                store(&workspace.connection, kind, &id, &stored)
            })?;
        }
        Ok(())
    }

    /// Remove the later edge of every dependency or parent loop that merging made.
    /// The removal is an ordinary change, so it uploads; every device holding the
    /// same edges removes the same ones.
    fn drop_loops(&mut self) -> Result<(), Error> {
        let transaction = self.connection.savepoint()?;
        let edges = |sql: &str| -> Result<Vec<BlockedBy>, Error> {
            let mut statement = transaction.prepare(sql)?;
            let edges = statement
                .query_map([], |row| {
                    Ok(BlockedBy {
                        blocked: row.get(0)?,
                        blocker: row.get(1)?,
                        order: row.get(2)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(edges)
        };
        // The notice is also what the ticket's file carries the removal in, so
        // a desktop that only receives the repaired file records it as well.
        let dependencies =
            edges("SELECT dependent_id, blocker_id, COALESCE(created_at, '') FROM dependencies")?;
        for edge in loop_edges(&dependencies) {
            transaction.execute(
                "DELETE FROM dependencies WHERE dependent_id = ?1 AND blocker_id = ?2",
                params![edge.blocked, edge.blocker],
            )?;
            let item = format!("{} {}", edge.blocker, edge.order);
            note_removed(
                &transaction,
                "blocked_by_removed",
                &edge.blocked,
                item.trim_end(),
                false,
            )?;
        }
        // A parent link carries no time; the GUIDs alone order the links of a loop.
        let parents = edges("SELECT child_id, parent_id, '' FROM ticket_parents")?;
        for edge in loop_edges(&parents) {
            transaction.execute(
                "DELETE FROM ticket_parents WHERE child_id = ?1",
                [&edge.blocked],
            )?;
            note_removed(
                &transaction,
                "parent_removed",
                &edge.blocked,
                &edge.blocker,
                false,
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn upload(
        &mut self,
        remote: &dyn RemoteStorage,
        folder: &str,
        device: &str,
        report: &mut SyncReport,
    ) -> Result<(), Error> {
        // A record that never synced uploads even if it predates change capture.
        for kind in SyncKind::ALL {
            let mut statement = self.connection.prepare(&format!(
                "SELECT id FROM {} WHERE id NOT IN (SELECT id FROM sync_files WHERE kind = ?1) AND id NOT IN (SELECT id FROM sync_dirty WHERE kind = ?1)",
                kind.table()
            ))?;
            let unsynced = statement
                .query_map([name(kind)], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            for id in unsynced {
                mark_dirty(&self.connection, dirty_kind(kind), &id)?;
            }
        }
        for dirty in self.dirty_records()? {
            let Some(kind) = SyncKind::ALL
                .into_iter()
                .find(|kind| dirty_kind(*kind) == dirty.kind)
            else {
                // Attachment files are synced separately.
                continue;
            };
            let mut stored = stored(&self.connection, kind, &dirty.id)?;
            if stored.newer {
                // Stays pending until this desktop can read what is there.
                continue;
            }
            let Some(local) = local_view(&self.connection, kind, &dirty.id, &stored)? else {
                self.clear_dirty(&dirty)?;
                continue;
            };
            // Marks over-report; only a real difference is worth a write. A file
            // that is gone from the storage (no version) is always written.
            if stored.version.is_some() && stored.base.as_ref() == Some(&local) {
                self.clear_dirty(&dirty)?;
                continue;
            }
            let text = with_device(&self.sync_file_text(&local)?, device);
            let key = RemoteKey::new(remote_kind(kind), dirty.id.clone());
            let write = |expected: Option<&str>| {
                remote.write(
                    folder,
                    &key,
                    &local.display_name(),
                    expected,
                    &mut Cursor::new(text.as_bytes()),
                )
            };
            let written = match write(stored.version.as_deref()) {
                // The file is gone from the storage: put it back.
                Err(RemoteError::PreconditionFailed { current: None }) => write(None),
                result => result,
            };
            match written {
                Ok(file) => {
                    let replaced = match stored.version.as_deref() {
                        Some(expected) if expected != file.version => {
                            replaced_revision(remote, folder, &key, expected, &file.version)?
                        }
                        _ => None,
                    };
                    if let Some(text) = replaced {
                        // Merged against the copy both changes started from, which is
                        // still the stored one. An unreadable revision is left alone.
                        match self.merge_incoming(
                            kind,
                            &dirty.id,
                            &file,
                            &text,
                            &mut BTreeSet::new(),
                        ) {
                            Ok(conflicts) => {
                                report.downloaded += 1;
                                report.conflicts += conflicts;
                            }
                            Err(error) if is_file_fault(&error) => {}
                            Err(error) => return Err(error),
                        }
                        // The storage holds what was just written; whatever the merge
                        // added differs from it and uploads on the next run.
                        let mut merged = self::stored(&self.connection, kind, &dirty.id)?;
                        merged.version = Some(file.version);
                        merged.file = Some(file.file_id);
                        merged.file_created = Some(file.created);
                        merged.base = Some(local);
                        store(&self.connection, kind, &dirty.id, &merged)?;
                        mark_dirty(&self.connection, dirty.kind, &dirty.id)?;
                        report.uploaded += 1;
                        continue;
                    }
                    stored.version = Some(file.version);
                    stored.file = Some(file.file_id);
                    stored.file_created = Some(file.created);
                    stored.base = Some(local);
                    store(&self.connection, kind, &dirty.id, &stored)?;
                    // False when the record changed during the upload: it stays pending.
                    self.clear_dirty(&dirty)?;
                    report.uploaded += 1;
                }
                // Changed elsewhere since the download: the next run merges it first.
                Err(RemoteError::PreconditionFailed { .. }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// The records that need review, most recently detected first.
    pub fn sync_conflicts(&self) -> Result<Vec<SyncConflict>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT kind, id FROM sync_conflicts GROUP BY kind, id ORDER BY MAX(detected_at) DESC, id",
        )?;
        let records = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut conflicts = Vec::new();
        for (kind, id) in records {
            if let Some(kind) = SyncKind::parse(&kind) {
                conflicts.push(self.sync_conflict(kind, &id)?);
            }
        }
        Ok(conflicts)
    }

    /// One record's conflicting fields with both values, for the comparison.
    pub fn sync_conflict(&self, kind: SyncKind, id: &str) -> Result<SyncConflict, Error> {
        let record = self.export_sync_record(kind, id)?;
        let mut statement = self.connection.prepare(
            "SELECT field, base, remote, remote_device, detected_at, read, remote_changed_at FROM sync_conflicts WHERE kind = ?1 AND id = ?2 ORDER BY field",
        )?;
        let rows = statement
            .query_map(params![name(kind), id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.is_empty() {
            return Err(Error::NotFound(format!("conflict on {} {id}", name(kind))));
        }
        let read = rows.iter().all(|row| row.5);
        let detected_at = rows
            .iter()
            .map(|row| row.4.clone())
            .max()
            .unwrap_or_default();
        let mut fields = Vec::new();
        for (field, base, remote, remote_device, detected_at, _, remote_changed_at) in rows {
            // Version history is the only record of when a field changed here.
            let local_changed_at = self.connection.query_row(
                "SELECT MAX(replaced_at) FROM record_versions WHERE kind = ?1 AND record_id = ?2 AND device IS NULL AND instr(' ' || changed || ' ', ' ' || ?3 || ' ') > 0",
                params![name(kind), id, field],
                |row| row.get(0),
            )?;
            fields.push(SyncConflictField {
                local: value_at(&record, &field).cloned(),
                local_changed_at,
                remote_changed_at,
                field,
                base: from_json(base)?,
                remote: from_json(remote)?,
                remote_device,
                detected_at,
            });
        }
        let text = |field: &str| match record.fields.get(field) {
            Some(SyncValue::Text(text)) => Some(text.clone()),
            _ => None,
        };
        Ok(SyncConflict {
            kind,
            id: id.to_owned(),
            reference: text("ref"),
            title: text("title").or_else(|| text("name")).unwrap_or_default(),
            detected_at,
            read,
            fields,
        })
    }

    /// Settle conflicting fields of a record: keep the local value, take the
    /// remote one, or save an edited value. The result is an ordinary change
    /// that uploads on the next run; fields not named stay in review.
    pub fn resolve_sync_conflict(
        &mut self,
        kind: SyncKind,
        id: &str,
        resolutions: &[SyncResolution],
    ) -> Result<(), Error> {
        let conflict = self.sync_conflict(kind, id)?;
        let mut stored = stored(&self.connection, kind, id)?;
        let mut record = local_view(&self.connection, kind, id, &stored)?
            .ok_or_else(|| Error::NotFound(format!("{} {id}", name(kind))))?;
        for resolution in resolutions {
            let field = conflict
                .fields
                .iter()
                .find(|field| field.field == resolution.field)
                .ok_or_else(|| {
                    Error::NotFound(format!("conflict on field '{}'", resolution.field))
                })?;
            match &resolution.choice {
                SyncChoice::Local => {}
                SyncChoice::Remote => set_at(&mut record, &field.field, field.remote.clone()),
                SyncChoice::Edited(value) => {
                    set_at(
                        &mut record,
                        &field.field,
                        Some(SyncValue::Text(value.clone())),
                    );
                }
            }
        }
        let missing = self.apply_sync_record(&record)?;
        if !missing.is_empty() || stored.wanted.is_some() {
            // A chosen value that names a record which has not arrived is kept
            // and applied when the record does, and uploads as chosen meanwhile.
            (stored.wanted, stored.applied) = if missing.is_empty() {
                (None, None)
            } else {
                (Some(record), find_record(&self.connection, kind, id)?)
            };
            store(&self.connection, kind, id, &stored)?;
            mark_dirty(&self.connection, dirty_kind(kind), id)?;
        }
        for resolution in resolutions {
            self.connection.execute(
                "DELETE FROM sync_conflicts WHERE kind = ?1 AND id = ?2 AND field = ?3",
                params![name(kind), id, resolution.field],
            )?;
        }
        touch(&self.connection)
    }

    /// What sync did that needs no decision, newest first.
    pub fn sync_notices(&self) -> Result<Vec<SyncNotice>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT id, timestamp, read, notice FROM sync_notices ORDER BY timestamp DESC, rowid DESC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, timestamp, read, notice)| {
                Ok(SyncNotice {
                    id,
                    timestamp,
                    read,
                    notice: serde_json::from_str(&notice)
                        .map_err(|error| Error::SyncFile(error.to_string()))?,
                })
            })
            .collect()
    }

    /// Mark notices (by notice id) and records in review (by GUID) read or unread.
    /// Read state stays on this device.
    pub fn set_sync_read(&mut self, ids: &[String], read: bool) -> Result<(), Error> {
        for id in ids {
            self.connection.execute(
                "UPDATE sync_notices SET read = ?2 WHERE id = ?1",
                params![id, read],
            )?;
            self.connection.execute(
                "UPDATE sync_conflicts SET read = ?2 WHERE id = ?1",
                params![id, read],
            )?;
        }
        touch(&self.connection)
    }
}
