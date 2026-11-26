use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::{
    Error, FORMAT_VERSION, Workspace,
    backup::{PRE_MIGRATION_MARKER, SAFETY_MARKER, missing_objects, table_exists},
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

impl BackupCheck {
    /// Why this backup cannot be restored, in one sentence, or `None` when it can. Inspecting
    /// and restoring a backup word the same failure the same way.
    pub fn refusal(&self) -> Option<String> {
        Some(match self {
            Self::Valid { .. } => return None,
            Self::NewerFormat { backup_version, .. } => {
                Error::NewerSchema(i64::from(*backup_version)).to_string()
            }
            Self::NotTicketd => "this file is not a ticketd backup".into(),
            Self::MissingTables { tables } => {
                let shown = tables
                    .iter()
                    .take(5)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                let more = tables.len().saturating_sub(5);
                let more = if more > 0 {
                    format!(" and {more} more")
                } else {
                    String::new()
                };
                format!(
                    "this backup lacks parts its format requires ({shown}{more}); choose another backup"
                )
            }
            Self::CurrentWorkspace => {
                "this file is the current workspace, not a backup; choose a backup file".into()
            }
            Self::Damaged { reason } => format!("this backup is damaged: {reason}"),
        })
    }
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

/// Whether a check holds a file to the schema objects of its format version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ladder {
    /// Every table, column, trigger and unique index of the version must be there: what a
    /// backup needs before it may replace a Workspace.
    Required,
    /// Only integrity, foreign keys and attachments are checked. Making a backup of the
    /// live Workspace uses this: a Workspace that earlier builds left without an object is
    /// still worth saving, and inspecting or restoring the copy reports what is missing.
    Unchecked,
}

/// Checks a database file. It must be a ticketd workspace before its format
/// version means anything, because many unrelated databases use `user_version`.
///
/// A file SQLite cannot read through is a result, never a raw SQLite error: text or
/// another format is `NotTicketd`, and a cut-short, corrupted or unreadable schema
/// (for example a damaged full-text index) is `Damaged`.
pub(crate) fn check_backup(connection: &Connection, ladder: Ladder) -> Result<BackupCheck, Error> {
    use rusqlite::ErrorCode::{
        DatabaseBusy, DatabaseCorrupt, DatabaseLocked, DiskFull, NotADatabase,
        OperationInterrupted, OutOfMemory, PermissionDenied, ReadOnly, SystemIoFailure,
    };
    match check_backup_file(connection, ladder) {
        Err(Error::Database(rusqlite::Error::SqliteFailure(failure, message))) => {
            match failure.code {
                NotADatabase => Ok(BackupCheck::NotTicketd),
                DatabaseCorrupt | SystemIoFailure => Ok(BackupCheck::Damaged {
                    reason: "the file is cut short or corrupted".into(),
                }),
                DatabaseBusy | DatabaseLocked | DiskFull | OutOfMemory | OperationInterrupted
                | PermissionDenied | ReadOnly => Err(Error::Database(
                    rusqlite::Error::SqliteFailure(failure, message),
                )),
                _ => Ok(BackupCheck::Damaged {
                    reason: format!(
                        "its schema could not be read ({})",
                        first_line(&message.unwrap_or_else(|| failure.to_string()))
                    ),
                }),
            }
        }
        other => other,
    }
}

/// The first line of a SQLite message, bounded so a report stays short.
fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    let mut shown: String = line.chars().take(120).collect();
    if line.chars().count() > 120 {
        shown.push('…');
    }
    shown
}

/// SQLite lists every problem it finds, sometimes hundreds: name the first and count the rest.
fn integrity_summary(report: &str) -> String {
    let mut problems = report
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("***"));
    let first = problems.next().map(first_line).unwrap_or_default();
    let more = problems.count();
    if more == 0 {
        format!("it failed the database integrity check ({first})")
    } else {
        format!("it failed the database integrity check ({first}, and {more} more problems)")
    }
}

fn check_backup_file(connection: &Connection, ladder: Ladder) -> Result<BackupCheck, Error> {
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
    if ladder == Ladder::Required {
        let missing = missing_objects(connection, version)?;
        // Preview formats 101–103 have the next rung's Chat storage and no Document
        // summaries. Verify the complete preview schema before step 104 fills the gap.
        let complete_preview = (101..=103).contains(&version)
            && missing == ["documents.summary"]
            && missing_objects(connection, version + 1)? == ["documents.summary"];
        if !missing.is_empty() && !complete_preview {
            return Ok(BackupCheck::MissingTables { tables: missing });
        }
    }
    let integrity: String =
        connection.pragma_query_value(None, "integrity_check", |row| row.get(0))?;
    if integrity != "ok" {
        return Ok(BackupCheck::Damaged {
            reason: integrity_summary(&integrity),
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
            reason: match error {
                Error::Backup(reason) => reason,
                // SQLite failed while reading the packaged bytes back.
                _ => "its attachment bytes could not be read to the end; the file may be cut short or corrupted".into(),
            },
        });
    }
    Ok(BackupCheck::Valid {
        format_version: u32::try_from(version).unwrap_or_default(),
        summary: summarize(connection)?,
    })
}

/// The backup path must name a readable file; restore and inspection say so alike.
pub(crate) fn require_backup_file(path: &Path) -> Result<(), Error> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(Error::Backup(format!(
            "backup is a folder, not a file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(Error::Backup(format!(
            "backup file not found: {}",
            path.display()
        ))),
        Err(error) => Err(crate::path_error("backup file", path, error)),
    }
}

/// A backup opened read-only inside one snapshot, so the check and a restore see the same bytes.
pub(crate) fn open_backup(path: &Path) -> Result<Connection, Error> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| match error {
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::CannotOpen =>
        {
            Error::Path(format!(
                "cannot open backup file {}; check that you can read it",
                path.display()
            ))
        }
        other => other.into(),
    })?;
    crate::session::configure(&connection)?;
    connection.execute_batch("BEGIN")?;
    Ok(connection)
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
            require_backup_file(backup)?;
            let connection = open_backup(backup)?;
            let check = check_backup(&connection, Ladder::Required)?;
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
