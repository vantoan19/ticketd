use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{
    Error, Workspace,
    backup_review::{BackupCheck, check_backup},
};
use rusqlite::{Connection, backup::Backup};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The most recent backup that was saved and verified, whichever surface made it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupRecord {
    /// Absolute path of the backup file when it was made.
    pub path: String,
    /// UTC time the backup finished, as an RFC 3339 timestamp.
    pub completed_at: String,
}

pub(crate) fn lock_file(path: &Path) -> Result<File, Error> {
    let resolved = match path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            parent.canonicalize()?.join(
                path.file_name()
                    .ok_or_else(|| Error::Backup("invalid workspace path".into()))?,
            )
        }
        Err(error) => return Err(error.into()),
    };
    let mut name = resolved.as_os_str().to_os_string();
    name.push(".lock");
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(name)?)
}

pub(crate) fn copy(source: &Connection, destination: &mut Connection) -> Result<(), Error> {
    Backup::new(source, destination)?.run_to_completion(100, Duration::from_millis(25), None)?;
    Ok(())
}

/// Each table a ticketd workspace has, with the format version that added it.
const TABLES: [(&str, i64); 79] = [
    ("automation_arrivals", 70),
    ("automation_device_state", 69),
    ("automations", 69),
    ("automation_agents", 68),
    ("workspace_events", 67),
    ("chat_record_writes", 66),
    ("chat_notices", 66),
    ("chats", 66),
    ("chat_links", 66),
    ("chat_sessions", 66),
    ("chat_turns", 66),
    ("chat_messages", 66),
    ("chat_submission_attempts", 66),
    ("chat_tools", 66),
    ("chat_interactions", 66),
    ("chat_changes", 66),
    ("attachment_upload_destinations", 55),
    ("attachment_upload_destination", 55),
    ("drive_upload_operations", 52),
    ("drive_references", 51),
    ("attachment_draft_cutover", 50),
    ("attachment_drafts", 50),
    ("attachment_draft_references", 50),
    ("attachment_workspace", 48),
    ("embedded_attachments", 48),
    ("attachment_upload_settings", 49),
    ("attachments", 47),
    ("ticket_attachments", 47),
    ("entities", 31),
    ("documents", 31),
    ("document_opens", 31),
    ("context_mentions", 35),
    ("document_pins", 36),
    ("document_tags", 36),
    ("document_fts", 36),
    ("activity_mentions", 40),
    ("ticket_graph_fts", 43),
    ("plan_graph_fts", 43),
    ("numeric_mentions", 41),
    ("activity_graph_numbers", 42),
    ("activity_graph_targets", 42),
    ("tickets", 1),
    ("ticket_history", 3),
    ("tags", 4),
    ("ticket_tags", 4),
    ("notes", 5),
    ("dependencies", 6),
    ("contextual_relationships", 19),
    ("projects", 7),
    ("plans", 8),
    ("plan_documents", 39),
    ("ticket_parents", 9),
    ("project_checkouts", 10),
    ("request_outcomes", 12),
    ("ticket_follows", 14),
    ("inbox_entries", 14),
    ("duplicate_tickets", 15),
    ("evidence", 16),
    ("ticket_reminders", 18),
    ("last_backup", 20),
    ("source_configurations", 22),
    ("external_identities", 23),
    ("external_ownership", 23),
    ("source_sync", 23),
    ("external_duplicate_targets", 23),
    ("source_conversation", 24),
    ("source_status", 25),
    ("publication_attempts", 26),
    ("workspace_changes", 45),
    ("ticket_documents", 46),
    ("device", 56),
    ("record_versions", 57),
    ("sync_dirty", 58),
    ("sync_capture", 58),
    ("sync_files", 58),
    ("sync_conflicts", 58),
    ("sync_notices", 58),
    ("sync_state", 59),
    ("sync_attachments", 59),
];

pub(crate) fn table_exists(connection: &Connection, table: &str) -> Result<bool, Error> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )?)
}

/// The tables a workspace of this format version should have but does not.
pub(crate) fn missing_tables(
    connection: &Connection,
    version: i64,
) -> Result<Vec<&'static str>, Error> {
    let mut missing = Vec::new();
    for (table, introduced) in TABLES {
        if version >= introduced
            && !(table == "notes" && version >= 32)
            && !table_exists(connection, table)?
        {
            missing.push(table);
        }
    }
    if version >= 53 && table_exists(connection, "attachments")? {
        for (column, object) in [
            ("quarantined", "attachments.quarantined"),
            ("added_at", "attachments.added_at"),
        ] {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('attachments') WHERE name=?1)",
                [column],
                |row| row.get(0),
            )?;
            if !exists {
                missing.push(object);
            }
        }
    }
    if version >= 54 && table_exists(connection, "attachments")? {
        let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('attachments') WHERE name='purge_state')", [], |row| row.get(0))?;
        if !exists {
            missing.push("attachments.purge_state");
        }
    }
    // Context identities and derived indexes need their maintenance triggers;
    // missing triggers silently corrupt subsequent writes after a restore.
    for (trigger, introduced) in [
        ("ticket_entity_insert", 35),
        ("plan_entity_insert", 35),
        ("numeric_mentions_activity_delete", 41),
        ("activity_graph_numbers_insert", 42),
        ("activity_graph_numbers_delete", 42),
        ("activity_graph_targets_insert", 42),
        ("activity_graph_targets_delete", 42),
        ("document_heading_insert", 43),
        ("document_heading_update", 43),
        ("document_fts_insert", 36),
        ("document_fts_delete", 36),
        ("document_fts_update", 36),
        ("ticket_graph_fts_insert", 43),
        ("ticket_graph_fts_delete", 43),
        ("ticket_graph_fts_update", 43),
        ("plan_graph_fts_insert", 43),
        ("plan_graph_fts_delete", 43),
        ("plan_graph_fts_update", 43),
        ("embedded_activity_delete", 48),
        ("drive_upload_request_namespace", 52),
        ("write_drive_request_namespace", 52),
        ("record_version_ticket", 57),
        ("record_version_document", 57),
        ("workspace_event_ticket_created", 67),
        ("workspace_event_ticket_updated", 67),
        ("workspace_event_ticket_status_changed", 67),
        ("workspace_event_ticket_tag_added", 67),
        ("workspace_event_ticket_tag_removed", 67),
        ("workspace_event_activity_created", 67),
    ] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",
            [trigger],
            |row| row.get(0),
        )?;
        if version >= introduced && !exists {
            missing.push(trigger);
        }
    }
    // Without its capture triggers a restored Workspace would silently stop uploading edits.
    if version >= 58 {
        let triggers = crate::sync::captured_tables()
            .filter(|(_, since)| version >= *since)
            .flat_map(|(table, _)| {
                crate::sync::TRIGGER_EVENTS.map(|event| format!("sync_capture_{table}_{event}"))
            });
        for trigger in triggers {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",
                [trigger],
                |row| row.get(0),
            )?;
            if !exists {
                missing.push("sync capture triggers");
                break;
            }
        }
    }
    if version >= 32 && !table_exists(connection, "activities")? {
        missing.push("activities");
    }
    Ok(missing)
}

/// The marker in the file name of a copy saved before a restore replaced the workspace.
pub(crate) const SAFETY_MARKER: &str = ".safety-";
/// The marker in the file name of a copy saved before a format migration.
pub(crate) const PRE_MIGRATION_MARKER: &str = ".pre-migration-";

/// Restore accepts exactly the files that inspecting a backup calls valid.
pub(crate) fn validate(connection: &Connection) -> Result<(), Error> {
    // A backup from before Efforts became Plans gets the legacy-schema message, not a missing table.
    if table_exists(connection, "efforts")? {
        return Err(Error::LegacyEffortWorkspace);
    }
    match check_backup(connection)? {
        BackupCheck::Valid { .. } => Ok(()),
        BackupCheck::NewerFormat { backup_version, .. } => {
            Err(Error::NewerSchema(i64::from(backup_version)))
        }
        BackupCheck::NotTicketd => Err(Error::Backup("not a ticketd workspace backup".into())),
        BackupCheck::MissingTables { tables } => Err(Error::Backup(format!(
            "missing schema object {}",
            tables.join(", ")
        ))),
        BackupCheck::Damaged { reason } => Err(Error::Backup(reason)),
        BackupCheck::CurrentWorkspace => {
            Err(Error::Backup("backup is the current workspace".into()))
        }
    }
}

impl Workspace {
    /// Create a consistent backup without overwriting an existing file.
    /// Returns whether the backup was also recorded as the last backup; the
    /// backup itself is saved either way.
    pub fn backup(&self, path: impl AsRef<Path>) -> Result<bool, Error> {
        let _uploads = self.attachment_backup_lock()?;
        let path = path.as_ref();
        save_snapshot(&self.connection, &self.attachment_directory()?, path, true)?;
        // The backup is already saved and checked, so a failure to note it
        // must not discard it; the previous record simply stays.
        let recorded = path
            .canonicalize()
            .map(|absolute| absolute.display().to_string())
            .unwrap_or_else(|_| path.display().to_string());
        Ok(self
            .connection
            .execute(
                "INSERT INTO last_backup (id, path, completed_at) VALUES (1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
                 ON CONFLICT(id) DO UPDATE SET path = excluded.path, completed_at = excluded.completed_at",
                [recorded],
            )
            .is_ok())
    }

    /// The last successful backup, or `None` when none was recorded.
    pub fn last_backup(&self) -> Result<Option<BackupRecord>, Error> {
        Self::read_last_backup(&self.connection)
    }

    pub(crate) fn read_last_backup(connection: &Connection) -> Result<Option<BackupRecord>, Error> {
        match connection.query_row(
            "SELECT path, completed_at FROM last_backup WHERE id = 1",
            [],
            |row| {
                Ok(BackupRecord {
                    path: row.get(0)?,
                    completed_at: row.get(1)?,
                })
            },
        ) {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn migration_backup(
        connection: &Connection,
        workspace: &Path,
    ) -> Result<PathBuf, Error> {
        let root = crate::backup_archive::attachment_root(workspace);
        std::fs::create_dir_all(&root)?;
        let _uploads = crate::attachments::lock_uploads(&root)?;
        let mut name = workspace.as_os_str().to_os_string();
        name.push(format!("{PRE_MIGRATION_MARKER}{}.sqlite3", Uuid::new_v4()));
        let path = PathBuf::from(name);
        save_snapshot(connection, &root, &path, false)?;
        Ok(path)
    }
}

/// Publish only a fully written single-file snapshot; never clobber another file.
pub(crate) fn save_snapshot(
    source: &Connection,
    root: &Path,
    path: &Path,
    check_schema: bool,
) -> Result<(), Error> {
    if path.exists() {
        return Err(Error::FileExists(path.to_path_buf()));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent_absolute = parent
        .canonicalize()
        .map_err(|e| crate::path_error("destination folder", parent, e))?;
    if root.exists() && parent_absolute.starts_with(root.canonicalize()?) {
        return Err(Error::Backup(
            "save the backup outside managed attachment storage".into(),
        ));
    }
    let staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| crate::path_error("destination folder", parent, e))?;
    let mut destination = Connection::open(staged.path())?;
    // Byte-restoring reference writes take only the SQLite writer lock. Freeze them
    // for the snapshot/path inventory, never for hashing/copying large file bodies.
    let barrier = if let Some(path) = source.path().filter(|path| !path.is_empty()) {
        let barrier = Connection::open(path)?;
        barrier.busy_timeout(Duration::from_secs(10))?;
        barrier.execute_batch("BEGIN IMMEDIATE")?;
        Some(barrier)
    } else {
        None
    };
    copy(source, &mut destination)?;
    let files = crate::backup_archive::retained_file_inventory(root)?;
    drop(barrier);
    crate::backup_archive::pack(&destination, files)?;
    if check_schema {
        validate(&destination)?;
    }
    drop(destination);
    staged.as_file().sync_all()?;
    staged.persist_noclobber(path).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            Error::FileExists(path.to_path_buf())
        } else {
            Error::Directory(error.error)
        }
    })?;
    crate::backup_archive::sync_directory(parent)
}
