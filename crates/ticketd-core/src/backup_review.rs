use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::{
    Error, FORMAT_VERSION, Workspace,
    backup::{PRE_MIGRATION_MARKER, SAFETY_MARKER, missing_tables, table_exists},
};

/// What a workspace holds, for comparing it with a backup before a restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    /// Latest recorded activity (ticket history, Activity, Document or evidence edit), as an
    /// RFC 3339 timestamp, or `None` when there is none yet. Edits that carry no
    /// timestamp, such as title, tags, follows and reminders, are not counted.
    pub last_change: Option<String>,
    /// Tickets outside Trash.
    pub tickets: u64,
    pub activities: u64,
    /// All Documents, including supporting details and Trash.
    pub documents: u64,
    pub evidence: u64,
    pub projects: u64,
    pub plans: u64,
}

/// The result of checking a backup file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BackupCheck {
    /// The backup can be restored.
    Valid {
        format_version: u32,
        summary: WorkspaceSummary,
    },
    /// Saved by a newer ticketd than this one.
    NewerFormat {
        backup_version: u32,
        supported_version: u32,
    },
    /// Not a ticketd workspace backup.
    NotTicketd,
    /// A ticketd backup that lacks tables its format requires.
    MissingTables { tables: Vec<String> },
    /// The file is the workspace that would be replaced.
    CurrentWorkspace,
    /// A ticketd backup that failed its integrity checks.
    Damaged { reason: String },
}

/// A backup file inspected without changing anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupInspection {
    pub path: String,
    pub check: BackupCheck,
    /// The workspace a restore would replace.
    pub current: WorkspaceSummary,
    /// Present only after all database and attachment bytes pass verification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_content: Option<AttachmentBackupContent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentBackupContent {
    pub container_version: Option<u32>,
    pub local_snapshots: u64,
    /// Includes unused files and retained quarantine; excludes recovery manifests.
    pub retained_files: u64,
    pub retained_bytes: u64,
    /// Metadata and references only; remote bytes are never implied.
    pub remote_references: u64,
    /// Backup validates local retention, never downloads provider content.
    #[serde(default)]
    pub remote_bytes_included: bool,
    /// Restoring metadata does not establish connectivity or authorization.
    #[serde(default)]
    pub remote_access_verified: bool,
}

/// Why a copy of the workspace was kept next to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyBackupKind {
    /// Saved before a restore replaced the workspace.
    Safety,
    /// Saved before a format migration changed the workspace.
    PreMigration,
}

/// A safety or pre-migration backup kept beside the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafetyBackup {
    pub path: String,
    pub kind: SafetyBackupKind,
    /// When the file was last written, as an RFC 3339 timestamp.
    pub saved_at: String,
    pub size_bytes: u64,
}

fn scalar(connection: &Connection, sql: &str) -> Result<u64, Error> {
    Ok(connection.query_row(sql, [], |row| row.get(0))?)
}

fn count(connection: &Connection, table: &str) -> Result<u64, Error> {
    if !table_exists(connection, table)? {
        return Ok(0);
    }
    scalar(connection, &format!("SELECT COUNT(*) FROM {table}"))
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, Error> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        [table, column],
        |row| row.get(0),
    )?)
}

fn summarize(connection: &Connection) -> Result<WorkspaceSummary, Error> {
    let tickets = if has_column(connection, "tickets", "trashed")? {
        scalar(connection, "SELECT COUNT(*) FROM tickets WHERE trashed = 0")?
    } else {
        count(connection, "tickets")?
    };
    let activity_table = if table_exists(connection, "activities")? {
        "activities"
    } else {
        "notes"
    };
    let mut latest: Option<String> = None;
    for (table, column) in [
        ("ticket_history", "timestamp"),
        (activity_table, "updated_at"),
        ("evidence", "updated_at"),
        ("documents", "updated_at"),
    ] {
        if !table_exists(connection, table)? {
            continue;
        }
        let value: Option<String> =
            connection.query_row(&format!("SELECT MAX({column}) FROM {table}"), [], |row| {
                row.get(0)
            })?;
        if value > latest {
            latest = value;
        }
    }
    Ok(WorkspaceSummary {
        last_change: latest,
        tickets,
        activities: count(connection, activity_table)?,
        documents: count(connection, "documents")?,
        evidence: count(connection, "evidence")?,
        projects: count(connection, "projects")?,
        plans: count(connection, "plans")?,
    })
}

/// Checks a database file. It must be a ticketd workspace before its format
/// version means anything, because many unrelated databases use `user_version`.
pub(crate) fn check_backup(connection: &Connection) -> Result<BackupCheck, Error> {
    if !table_exists(connection, "tickets")? {
        return Ok(BackupCheck::NotTicketd);
    }
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > FORMAT_VERSION {
        return Ok(BackupCheck::NewerFormat {
            backup_version: u32::try_from(version).unwrap_or(u32::MAX),
            supported_version: supported_version(),
        });
    }
    if !(1..=FORMAT_VERSION).contains(&version) {
        return Ok(BackupCheck::NotTicketd);
    }
    let missing = missing_tables(connection, version)?;
    if !missing.is_empty() {
        return Ok(BackupCheck::MissingTables {
            tables: missing.into_iter().map(str::to_owned).collect(),
        });
    }
    let integrity: String =
        connection.pragma_query_value(None, "integrity_check", |row| row.get(0))?;
    if integrity != "ok" {
        return Ok(BackupCheck::Damaged {
            reason: format!("integrity check failed: {integrity}"),
        });
    }
    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    if statement.query([])?.next()?.is_some() {
        return Ok(BackupCheck::Damaged {
            reason: "foreign key check failed".into(),
        });
    }
    if let Err(error) = crate::backup_archive::validate(connection) {
        return Ok(BackupCheck::Damaged {
            reason: error.to_string(),
        });
    }
    Ok(BackupCheck::Valid {
        format_version: u32::try_from(version).unwrap_or_default(),
        summary: summarize(connection)?,
    })
}

fn supported_version() -> u32 {
    u32::try_from(FORMAT_VERSION).unwrap_or_default()
}

impl Workspace {
    /// Check a backup file and summarize it next to this workspace, without
    /// changing either. A file that cannot be restored is a result, not an
    /// error; only an unreadable path fails.
    pub fn inspect_backup(&self, backup: impl AsRef<Path>) -> Result<BackupInspection, Error> {
        let backup = backup.as_ref();
        let current = summarize(&self.connection)?;
        let own = self
            .connection
            .path()
            .filter(|path| !path.is_empty())
            .and_then(|path| Path::new(path).canonicalize().ok());
        let is_current = match (own, backup.canonicalize()) {
            (Some(own), Ok(other)) => own == other,
            _ => false,
        };
        let mut attachment_content = None;
        let check = if is_current {
            BackupCheck::CurrentWorkspace
        } else {
            let connection = Connection::open_with_flags(
                backup,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            connection.execute_batch("BEGIN")?;
            let check = match check_backup(&connection) {
                // Text or another format entirely, so there is nothing of ours to name.
                Err(Error::Database(rusqlite::Error::SqliteFailure(failure, _)))
                    if failure.code == rusqlite::ErrorCode::NotADatabase =>
                {
                    BackupCheck::NotTicketd
                }
                // A SQLite file that cannot be read through; keep SQLite's reason.
                Err(Error::Database(rusqlite::Error::SqliteFailure(failure, message)))
                    if failure.code == rusqlite::ErrorCode::DatabaseCorrupt =>
                {
                    BackupCheck::Damaged {
                        reason: message.unwrap_or_else(|| failure.to_string()),
                    }
                }
                other => other?,
            };
            if matches!(check, BackupCheck::Valid { .. }) {
                attachment_content = Some(crate::backup_archive::content(&connection)?);
            }
            check
        };
        Ok(BackupInspection {
            path: backup.display().to_string(),
            check,
            current,
            attachment_content,
        })
    }

    /// The safety and pre-migration backups kept beside this workspace, newest first.
    pub fn safety_backups(&self) -> Result<Vec<SafetyBackup>, Error> {
        let Some(workspace) = self
            .connection
            .path()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
        else {
            return Ok(Vec::new());
        };
        let (Some(directory), Some(name)) = (workspace.parent(), workspace.file_name()) else {
            return Ok(Vec::new());
        };
        let name = name.to_string_lossy().into_owned();
        let mut found = Vec::new();
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let file = entry.file_name().to_string_lossy().into_owned();
            let Some(rest) = file.strip_prefix(&name) else {
                continue;
            };
            let kind = if rest.starts_with(SAFETY_MARKER) {
                SafetyBackupKind::Safety
            } else if rest.starts_with(PRE_MIGRATION_MARKER) {
                SafetyBackupKind::PreMigration
            } else {
                continue;
            };
            if !rest.ends_with(".sqlite3") {
                continue;
            }
            let metadata = entry.metadata()?;
            if !metadata.is_file() {
                continue;
            }
            let seconds = metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs());
            let saved_at = i64::try_from(seconds)
                .ok()
                .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
                .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                .unwrap_or_default();
            found.push(SafetyBackup {
                path: entry.path().display().to_string(),
                kind,
                saved_at,
                size_bytes: metadata.len(),
            });
        }
        found.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then(a.path.cmp(&b.path)));
        Ok(found)
    }
}
