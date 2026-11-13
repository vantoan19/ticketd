//! Shared ticket workflows for the desktop and CLI.
pub mod agent_skills;
pub use search::TicketWithUpdate;
mod backlinks;
pub use backlinks::Backlink;
mod backup;
mod backup_archive;
mod restore;
pub use backup::BackupRecord;
mod backup_review;
pub use backup_review::{
    AttachmentBackupContent, BackupCheck, BackupInspection, SafetyBackup, SafetyBackupKind,
    WorkspaceSummary,
};
mod context;
mod context_graph;
mod device;
pub use context_graph::{
    ContextGraph, ContextGraphContinuation, ContextGraphEdge, ContextGraphNode, ContextGraphPage,
    WorkspaceGraph, WorkspaceGraphRequest,
};
mod document_links;
pub use document_links::{ContextLink, DocumentBacklink, derive_brief_heading, derive_heading};
mod documents;
pub use documents::{Document, DocumentPatch, DocumentSearchResult, DocumentSummary};
mod duplicates;
pub use duplicates::{
    DependencyChoice, DependencyDecision, DependencyEdge, DuplicateDependencyPreview,
    ReplacementIssue, ReviewMode, WaitingOutcome, WaitingTicket,
};
mod evidence;
mod export;
mod portable_export;
pub use portable_export::{
    ExportAttachment, ExportAttachmentKind, ExportStatus, MarkdownExport, MarkdownExportSource,
};
mod location;
pub use context::{ContextOptions, TicketContext};
pub use evidence::{Evidence, EvidenceInput, EvidenceKind};
pub use location::{WorkspaceFile, WorkspaceInfo, default_workspace_file, workspace_file};

mod plans;
mod retry;
pub mod source;
pub mod sync;
pub use retry::{WriteRequest, WriteResult};
mod graph;
mod hierarchy;
pub use graph::{DependencyGraph, GraphEdge, GraphNode};
mod projects;
mod relationships;
pub use relationships::RelationshipKind;
mod search;
pub use search::{Availability, TicketFilter, TicketOrder};
mod sync_files;
pub use sync_files::{MissingTarget, SyncKind, SyncPart, SyncPartKind, SyncRecord, SyncValue};
mod tags;
mod ticket_documents;
pub use plans::{Plan, PlanCounts, PlanView};

use std::{
    path::Path,
    time::{Duration, Instant},
};

use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod counts;
mod history;
pub use counts::{SidebarCounts, StatusCounts};
mod inbox;
pub use inbox::InboxEntry;
mod activities;
mod attachment_cleanup;
mod attachment_library;
pub use attachment_cleanup::AttachmentCleanupReview;
pub use attachment_cleanup::RemoteAttachmentRemoval;
mod attachment_previews;
mod attachment_retention;
pub use attachment_library::{AttachmentQuery, AttachmentSearchResult, AttachmentState};
mod attachments;
mod upload_destination;
mod versions;
pub use attachment_previews::{
    AttachmentMedia, AttachmentPreview, PreviewStatus, PreviewUsage, PreviewUse,
};
pub use upload_destination::AttachmentUploadDestination;
pub use versions::{RecordKind, Version, VersionSummary};
pub mod drive;
mod embedded_attachments;
pub use attachment_retention::{AttachmentProtection, AttachmentUsage, DraftRetention};
pub use attachments::{
    Attachment, AttachmentKind, AttachmentOpenTarget, AttachmentPurgeState,
    DEFAULT_ATTACHMENT_LIMIT,
};
mod change_token;
mod chat_suggestions;
mod chats;
pub use activities::{
    Activity, ActivityFeedEntry, ActivityPatch, LatestUpdate, ReportedUpdate, UpdateBrief,
};
pub use chat_suggestions::{ChatSuggestion, SuggestedTicket};
pub use chats::{
    CHAT_AGENT_CHANGES_LIMIT, CHAT_CHANGE_TAIL, CHAT_EFFECTIVE_SETTINGS_LIMIT, CHAT_ID_VARIABLE,
    CHAT_NOTICE_LIMIT, CHAT_RESET_TIME_MAX, CHAT_TOOL_OUTPUT_LIMIT, Chat, ChatAgentChange,
    ChatCatchUp, ChatChange, ChatDelivery, ChatDeliveryDecision, ChatHistoryPage,
    ChatInputStanding, ChatInteraction, ChatInteractionKind, ChatInteractionState, ChatItem,
    ChatLink, ChatLinkKind, ChatLinkedRecord, ChatListFilter, ChatMessage, ChatNotice,
    ChatObservation, ChatRecord, ChatRole, ChatSession, ChatSessionOrigin, ChatSnapshot,
    ChatSubmissionAttempt, ChatSubmissionIntent, ChatTool, ChatToolState, ChatTurn, ChatTurnState,
    NewChat,
};
pub use history::{HistoryEntry, Readiness, Status};
pub use projects::Project;

/// The workspace format version this application reads and writes. The next
/// format change bumps this and adds one migration step; nothing else holds the number.
pub const FORMAT_VERSION: i64 = 68;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Drive: {0}")]
    Drive(#[from] drive::DriveError),
    #[error("attachment: {0}")]
    Attachment(String),
    #[error("ticket '{0}' was changed elsewhere since it was loaded")]
    TicketChanged(String),
    #[error("document '{0}' was changed elsewhere since it was loaded")]
    DocumentChanged(String),
    #[error("document '{0}' was not found")]
    DocumentNotFound(String),
    #[error("Chat '{0}' was not found")]
    ChatNotFound(String),
    #[error("Chat '{0}' is in trash; restore it before sending")]
    ChatTrashed(String),
    #[error(
        "input '{0}' already has a submission that may have been delivered; it is not submitted again"
    )]
    ChatSubmissionUnresolved(String),
    #[error("invalid Chat record: {0}")]
    Chat(String),
    #[error("backup or restore failed: {0}")]
    Backup(String),
    #[error(
        "cannot save a complete safety copy of the current workspace: {source}. The current workspace is unchanged. Repair missing current files, or restore the complete backup separately with `ticketd restore-workspace <backup> --target <new-database-path>`; this does not switch the desktop workspace"
    )]
    SafetyCopy {
        #[source]
        source: Box<Error>,
    },
    #[error(
        "backup or restore failed: workspace is in use; close other ticketd operations and retry: {source}"
    )]
    RestoreLock {
        #[source]
        source: std::io::Error,
    },
    #[error("backup or restore failed: restore failed: {source}; safety backup: {}", safety.display())]
    Restore {
        safety: std::path::PathBuf,
        #[source]
        source: Box<Error>,
    },
    #[error("workspace migration failed: {source}; the original data remains unchanged. Backup: {}. Restore it with `ticketd restore-workspace <backup>` or use the previous application version", backup.display())]
    Migration {
        backup: std::path::PathBuf,
        #[source]
        source: Box<Error>,
    },
    #[error(
        "This workspace uses the previous Effort schema. Open it with the previous version; its data has not been changed."
    )]
    LegacyEffortWorkspace,
    #[error("request ID was already used for different content: {0}")]
    RequestConflict(String),
    #[error("request serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("batch operation {index}: {source}")]
    BatchOperation {
        index: usize,
        #[source]
        source: Box<Error>,
    },
    #[error("invalid batch: {0}")]
    InvalidBatch(String),
    #[error("plan name must not be empty")]
    EmptyPlanName,
    #[error("plan '{0}' was not found")]
    PlanNotFound(String),
    #[error(
        "checkout matches multiple projects; specify --project explicitly or remove a registration"
    )]
    AmbiguousProject,
    #[error("This folder is registered to {0}.")]
    CheckoutTaken(String),
    #[error("checkout path must be valid Unicode")]
    InvalidCheckoutPath,
    #[error("project name and path must not be empty")]
    EmptyProject,
    #[error("project '{0}' was not found")]
    ProjectNotFound(String),
    #[error("duplicate would create a cycle or self-link")]
    DuplicateCycle,
    #[error(
        "remove or review the source ticket’s blocking dependencies before marking it as a duplicate"
    )]
    DuplicateDependencies,
    #[error("choose a canonical ticket to mark a ticket as Duplicate")]
    DuplicateNeedsCanonical,
    #[error(
        "{0} is itself a duplicate of an issue that is not a known ticket (or that loops back), so it cannot be the original; choose the original ticket directly"
    )]
    DuplicateCanonicalUnresolved(String),
    #[error("a ticket cannot be related to itself")]
    RelationshipSelfLink,
    #[error("dependency review has changed; preview and choose again")]
    DependencyReviewChanged,
    #[error("the values to review changed; check them and choose again")]
    SyncReviewChanged,
    #[error(
        "this review was previewed for a different kind of review; preview again for a {0} review"
    )]
    DependencyReviewMode(duplicates::ReviewMode),
    #[error("a ticket cannot be reviewed against itself")]
    ReviewSameTicket,
    #[error("{0} cannot block itself")]
    DependencySelf(String),
    #[error("{blocker} can't block {dependent}: {detail}")]
    DependencyCycle {
        blocker: String,
        dependent: String,
        /// Says how the dependent already reaches the blocker, naming the loop once.
        detail: String,
    },
    #[error("this Plan is archived; reactivate it to change it")]
    PlanArchived,
    #[error("parent assignment would create a cycle or more than one level of subtickets")]
    InvalidHierarchy,
    #[error("tag name must not be empty")]
    EmptyTag,
    #[error("ticket '{0}' is in trash; restore it before editing")]
    Trashed(String),
    #[error("document '{0}' is in trash; restore it with `ticketd document restore {0}` first")]
    DocumentTrashed(String),
    #[error("a related ticket is missing from the workspace")]
    MissingRelatedTicket,
    #[error("ticket title must not be empty")]
    EmptyTitle,
    #[error("ticket '{0}' was not found")]
    NotFound(String),
    #[error("invalid evidence: {0}")]
    InvalidEvidence(String),
    #[error("evidence '{0}' was not found")]
    EvidenceNotFound(String),
    #[error("choose either new details or an existing Document, not both")]
    ConflictingActivitySupport,
    #[error("activity brief must not be empty")]
    EmptyActivityBrief,
    #[error("activity '{0}' was not found")]
    ActivityNotFound(String),
    #[error(
        "{reference} is owned by {provider}; edit its title and description there, and ticketd will synchronize the change"
    )]
    ExternalContent { reference: String, provider: String },
    #[error("{}", external_status_message(.reference, .provider, *.open, *.closure_unrecognized))]
    ExternalStatus {
        reference: String,
        provider: String,
        open: bool,
        /// The issue is closed for a reason ticketd does not recognize, so Done or
        /// Canceled may be chosen here.
        closure_unrecognized: bool,
    },
    #[error("{0} is not owned by an external source, so there is nothing to refresh")]
    NotSynchronized(String),
    #[error(
        "{reference} can still be read from {provider}, so ticketd cannot take ownership of it; refresh it or retry later"
    )]
    SourceAvailable { reference: String, provider: String },
    #[error(transparent)]
    Source(#[from] source::SourceError),
    #[error(transparent)]
    Publication(#[from] source::PublicationError),
    #[error("could not determine the application data directory")]
    NoDataDirectory,
    #[error("a file already exists at {}; ticketd never replaces an existing file, so choose a new name", .0.display())]
    FileExists(std::path::PathBuf),
    #[error("No folder at {0}. Choose the folder of a checkout.")]
    NoCheckoutFolder(String),
    #[error("could not access workspace directory: {0}")]
    Directory(#[from] std::io::Error),
    /// A file or folder the person named is missing or is not the kind needed.
    #[error("{0}")]
    Path(String),
    #[error("workspace database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("sync storage: {0}")]
    Remote(#[from] sync::remote::RemoteError),
    #[error("unreadable sync file: {0}")]
    SyncFile(String),
    #[error("sync: {0}")]
    Sync(String),
    #[error("workspace schema version {0} is newer than this application supports")]
    NewerSchema(i64),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    pub trashed: bool,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub body: String,
    /// Last content or organization change; unknown for legacy tickets with no dated records.
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Latest authored note, selected by the core independently of ticket history.
    #[serde(default)]
    pub latest_update: Option<ReportedUpdate>,
    pub tags: Vec<String>,
    pub plan_id: Option<String>,
    pub project_id: Option<String>,
    pub availability: Option<String>,
    pub prerequisites: Vec<relationships::Prerequisite>,
    #[serde(default)]
    pub duplicate_of: Option<String>,
    #[serde(default)]
    pub duplicates: Vec<String>,
    /// Set when this duplicate's canonical ticket has itself become a Duplicate
    /// (its source closed it as one): the ticket that is now the original, so the
    /// designation can be moved there. Never changed automatically.
    #[serde(default)]
    pub duplicate_redirect: Option<String>,
    /// The external issue this ticket is or was, with current ownership and freshness.
    #[serde(default)]
    pub source: Option<source::TicketSource>,
    /// The publication attempt that is running or whose outcome is unknown. While
    /// it is set the ticket cannot be published again.
    #[serde(default)]
    pub publication: Option<source::PublicationAttempt>,
    pub parent: Option<hierarchy::RelatedTicket>,
    pub children: Vec<hierarchy::RelatedTicket>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TicketPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    /// The title the editor last loaded or saved. When set, a title change is
    /// rejected with `TicketChanged` if the stored title has moved on, so an
    /// editor never overwrites someone else's edit. Omitted by the CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_title: Option<String>,
    /// The body the editor last loaded or saved; guards a body change like `expected_title`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_body: Option<String>,
    pub status: Option<Status>,
    pub editing_agent: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_project_patch"
    )]
    pub project_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_project_patch"
    )]
    pub plan_id: Option<Option<String>>,
}

fn deserialize_project_patch<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

fn external_status_message(
    reference: &str,
    provider: &str,
    open: bool,
    closure_unrecognized: bool,
) -> String {
    if closure_unrecognized {
        format!(
            "{reference} is closed on {provider} for a reason ticketd does not recognize; choose Done or Canceled here, or reopen it there"
        )
    } else if open {
        format!(
            "{reference} is open on {provider}; locally choose Todo, In progress or In review. Closing is done on {provider}"
        )
    } else {
        format!(
            "{reference} is closed on {provider}, so its status follows the external issue; reopen it there to change it"
        )
    }
}

/// How long an open waits for exclusive use while others merely have the
/// Workspace open: they may keep it open for as long as they run.
const OPEN_WORKSPACES_WAIT: Duration = Duration::from_secs(10);
/// How long an open waits for a migration or restore under way. Its holder is
/// at work and will finish (the lock is freed if its process dies), and a
/// migration on a busy machine has taken longer than ten seconds.
const MIGRATION_WAIT: Duration = Duration::from_secs(600);

fn wait_for_migration_lock(deadline: Instant) -> Result<(), Error> {
    if Instant::now() >= deadline {
        return Err(Error::Backup(
            "workspace is in use and cannot be migrated; close other ticketd operations and retry"
                .into(),
        ));
    }
    std::thread::sleep(Duration::from_millis(25));
    Ok(())
}

pub struct Workspace {
    connection: Connection,
    _lock: std::fs::File,
}

impl Workspace {
    pub fn open_default() -> Result<Self, Error> {
        Self::open(default_path()?)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        Self::open_within(path.as_ref(), OPEN_WORKSPACES_WAIT, MIGRATION_WAIT)
    }

    /// [`Workspace::open`] with other bounds on its two waits, so a test of
    /// which wait applies does not have to sit one out.
    #[cfg(feature = "test-lock-waits")]
    pub fn open_with_lock_waits(
        path: impl AsRef<Path>,
        open_workspaces: Duration,
        migration: Duration,
    ) -> Result<Self, Error> {
        Self::open_within(path.as_ref(), open_workspaces, migration)
    }

    fn open_within(
        path: &Path,
        open_workspaces_wait: Duration,
        migration_wait: Duration,
    ) -> Result<Self, Error> {
        use fs2::FileExt;
        let resolved = if path.exists() {
            Some(path.canonicalize()?)
        } else {
            None
        };
        let path = resolved.as_deref().unwrap_or(path);
        let migrating = Instant::now() + migration_wait;
        // Starts when exclusive use is first refused, and anew after each
        // wait for a migration: that one was not an open Workspace.
        let mut open_elsewhere: Option<Instant> = None;
        loop {
            let lock = backup::lock_file(path)?;
            if let Err(error) = FileExt::try_lock_shared(&lock) {
                if error.raw_os_error() != fs2::lock_contended_error().raw_os_error() {
                    return Err(error.into());
                }
                // Only a migration or a restore holds the lock exclusively.
                open_elsewhere = None;
                wait_for_migration_lock(migrating)?;
                continue;
            }
            if restore::pending(path) {
                drop(lock);
                let recovery_lock = backup::lock_file(path)?;
                if let Err(error) = FileExt::try_lock_exclusive(&recovery_lock) {
                    if error.raw_os_error() != fs2::lock_contended_error().raw_os_error() {
                        return Err(error.into());
                    }
                    wait_for_migration_lock(
                        *open_elsewhere
                            .get_or_insert_with(|| Instant::now() + open_workspaces_wait),
                    )?;
                    continue;
                }
                restore::recover(path)?;
                continue;
            }
            let connection = Connection::open(path)?;
            if backup::table_exists(&connection, "ticketd_backup_container")?
                || backup::table_exists(&connection, "ticketd_backup_files")?
            {
                return Err(Error::Backup("this is an attachment backup container; restore it with `ticketd restore-workspace <backup>` or Settings > Restore from backup".into()));
            }
            document_links::register_heading_function(&connection)?;
            connection.busy_timeout(Duration::from_secs(10))?;
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let legacy: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'efforts')",
                [], |row| row.get(0),
            )?;
            if legacy {
                return Err(Error::LegacyEffortWorkspace);
            }
            if version > FORMAT_VERSION {
                return Err(Error::NewerSchema(version));
            }
            if version == FORMAT_VERSION {
                connection.pragma_update(None, "foreign_keys", "ON")?;
                return Ok(Self {
                    connection,
                    _lock: lock,
                });
            }
            drop(connection);
            drop(lock);
            let lock = backup::lock_file(path)?;
            if let Err(error) = FileExt::try_lock_exclusive(&lock) {
                if error.raw_os_error() != fs2::lock_contended_error().raw_os_error() {
                    return Err(error.into());
                }
                wait_for_migration_lock(
                    *open_elsewhere.get_or_insert_with(|| Instant::now() + open_workspaces_wait),
                )?;
                continue;
            }
            let mut connection = Connection::open(path)?;
            document_links::register_heading_function(&connection)?;
            connection.busy_timeout(Duration::from_secs(10))?;
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let legacy: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'efforts')",
                [], |row| row.get(0),
            )?;
            if legacy {
                return Err(Error::LegacyEffortWorkspace);
            }
            if version > FORMAT_VERSION {
                return Err(Error::NewerSchema(version));
            }
            if version < FORMAT_VERSION {
                let backup = if version > 0 {
                    Some(Self::migration_backup(&connection, path).map_err(|source| {
                        Error::Backup(format!("cannot create a pre-migration backup for {}: {source}; check available disk space and directory permissions, then retry", path.display()))
                    })?)
                } else {
                    None
                };
                let result = Self::migrate(&mut connection, version);
                if let Err(source) = result {
                    return Err(match backup {
                        Some(backup) => Error::Migration {
                            backup,
                            source: Box::new(source),
                        },
                        None => source,
                    });
                }
            }
            // Release exclusive ownership before acquiring the lifetime shared lock,
            // then recheck: restore may have run in between.
        }
    }

    fn migrate(connection: &mut Connection, version: i64) -> Result<(), Error> {
        // Schema51 rebuilds the parent attachment table without cascading into
        // reference/retention rows. Validate all foreign keys before committing.
        connection.pragma_update(None, "foreign_keys", "OFF")?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if version == 0 {
            transaction.execute_batch("CREATE TABLE tickets (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL); PRAGMA user_version = 1;")?;
        }
        if version < 2 {
            transaction.execute_batch("ALTER TABLE tickets ADD COLUMN body TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 2;")?;
        }
        if version < 3 {
            history::migrate(&transaction)?;
        }
        if version < 4 {
            tags::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 4)?;
        }
        if version < 5 {
            activities::migrate(&transaction)?;
        }
        if version < 6 {
            relationships::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 6)?;
        }
        if version < 7 {
            projects::migrate(&transaction)?;
        }
        if version < 8 {
            plans::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 8)?;
        }
        if version < 9 {
            hierarchy::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 9)?;
        }
        if version < 10 {
            projects::migrate_checkouts(&transaction)?;
            transaction.pragma_update(None, "user_version", 10)?;
        }
        if version < 11 {
            transaction.execute_batch("ALTER TABLE tickets ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 11;")?;
        }
        if version < 12 {
            transaction.execute_batch("CREATE TABLE request_outcomes (id TEXT PRIMARY KEY, request TEXT NOT NULL, outcome TEXT NOT NULL); PRAGMA user_version = 12;")?;
        }
        if version < 13 {
            transaction.execute_batch("CREATE INDEX ticket_history_ticket_id ON ticket_history(ticket_id); PRAGMA user_version = 13;")?;
        }
        if version < 14 {
            inbox::migrate(&transaction)?;
        }
        if version < 15 {
            duplicates::migrate(&transaction)?;
        }
        if version < 16 {
            transaction.execute_batch("CREATE TABLE evidence (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), editing_agent TEXT); PRAGMA user_version = 16;")?;
        }
        if version < 17 {
            transaction.execute_batch("ALTER TABLE inbox_entries ADD COLUMN editing_agent TEXT; PRAGMA user_version = 17;")?;
        }
        if version < 18 {
            inbox::migrate_reminders(&transaction)?;
        }
        if version < 19 {
            transaction.execute_batch("CREATE TABLE contextual_relationships (kind TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES tickets(id), target_id TEXT NOT NULL REFERENCES tickets(id), PRIMARY KEY(kind, source_id, target_id)); PRAGMA user_version = 19;")?;
        }
        if version < 20 {
            transaction.execute_batch("CREATE TABLE last_backup (id INTEGER PRIMARY KEY CHECK (id = 1), path TEXT NOT NULL, completed_at TEXT NOT NULL); PRAGMA user_version = 20;")?;
        }
        if version < 21 {
            duplicates::migrate_status(&transaction)?;
        }
        if version < 22 {
            source::migrate(&transaction)?;
        }
        if version < 23 {
            source::migrate_tracking(&transaction)?;
        }
        if version < 24 {
            source::migrate_conversation(&transaction)?;
        }
        if version < 25 {
            source::migrate_freshness(&transaction)?;
        }
        if version < 26 {
            source::migrate_publication(&transaction)?;
        }
        if version < 27 {
            source::migrate_details(&transaction)?;
        }
        if version < 28 {
            activities::migrate_updates(&transaction)?;
        }
        if version < 29 {
            source::migrate_run_counts(&transaction)?;
        }
        if version < 30 {
            transaction.execute_batch("CREATE INDEX IF NOT EXISTS dependencies_dependent ON dependencies(dependent_id, blocker_id); PRAGMA user_version = 30;")?;
        }
        if version < 31 {
            documents::migrate(&transaction)?;
        }
        if version < 32 {
            transaction.execute_batch("ALTER TABLE notes RENAME TO activities; ALTER TABLE activities RENAME COLUMN content TO brief; ALTER TABLE activities RENAME COLUMN created_at TO reported_at; UPDATE inbox_entries SET kind = 'activity' WHERE kind = 'note'; CREATE INDEX IF NOT EXISTS activities_feed ON activities(ticket_id, reported_at DESC, number DESC); CREATE INDEX IF NOT EXISTS ticket_history_feed ON ticket_history(ticket_id, timestamp DESC, number DESC); PRAGMA user_version = 32;")?;
        }
        if version < 33 {
            transaction.execute_batch("CREATE INDEX IF NOT EXISTS tickets_plan_scope ON tickets(plan_id, trashed, number); PRAGMA user_version = 33;")?;
        }
        if version < 34 {
            let has_trashed: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('documents') WHERE name = 'trashed')",
                [],
                |row| row.get(0),
            )?;
            if !has_trashed {
                transaction.execute_batch("ALTER TABLE documents ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0 CHECK(trashed IN (0, 1));")?;
            }
            transaction.execute_batch("PRAGMA user_version = 34;")?;
        }
        if version < 41 {
            transaction.execute_batch(document_links::MENTION_INDEX_SCHEMA)?;
        }
        if version < 35 {
            document_links::migrate(&transaction)?;
        }
        if version < 36 {
            documents::migrate_search(&transaction)?;
        }
        if version < 37 {
            for (table, column, definition) in [
                (
                    "activities",
                    "supporting_document_id",
                    "TEXT REFERENCES documents(id)",
                ),
                (
                    "documents",
                    "originating_activity_id",
                    "TEXT REFERENCES activities(id) ON DELETE SET NULL",
                ),
            ] {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
                    [table, column],
                    |row| row.get(0),
                )?;
                if !exists {
                    transaction.execute_batch(&format!(
                        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
                    ))?;
                }
            }
            transaction.execute_batch("PRAGMA user_version = 37;")?;
        }
        if version < 38 {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('documents') WHERE name = 'kept')",
                [],
                |row| row.get(0),
            )?;
            if !exists {
                transaction.execute_batch(
                    "ALTER TABLE documents ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
            transaction.execute_batch("PRAGMA user_version = 38;")?;
        }
        if version < 39 {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('plans') WHERE name = 'spec_document_id')",
                [],
                |row| row.get(0),
            )?;
            if !exists {
                transaction.execute_batch(
                    "ALTER TABLE plans ADD COLUMN spec_document_id TEXT REFERENCES documents(id);",
                )?;
            }
            transaction.execute_batch("CREATE TABLE IF NOT EXISTS plan_documents (plan_id TEXT NOT NULL REFERENCES plans(id), document_id TEXT NOT NULL REFERENCES documents(id), PRIMARY KEY(plan_id, document_id));
                CREATE INDEX IF NOT EXISTS plan_documents_by_document ON plan_documents(document_id, plan_id);
                PRAGMA user_version = 39;")?;
        }
        if version < 40 {
            transaction.execute_batch("CREATE TABLE IF NOT EXISTS activity_mentions (activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE, target_id TEXT NOT NULL REFERENCES entities(id), passage TEXT NOT NULL, PRIMARY KEY(activity_id, target_id, passage)); CREATE INDEX IF NOT EXISTS activity_mentions_target ON activity_mentions(target_id, activity_id); CREATE INDEX IF NOT EXISTS activities_support_ticket ON activities(ticket_id, supporting_document_id, id); CREATE INDEX IF NOT EXISTS activities_support_document ON activities(supporting_document_id, ticket_id, id); PRAGMA user_version = 40;")?;
            let mut statement = transaction.prepare("SELECT id, brief FROM activities")?;
            let activities = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            for (id, brief) in activities {
                document_links::index_activity(&transaction, &id, &brief)?;
            }
        }
        if version < 41 {
            transaction.execute_batch("CREATE INDEX IF NOT EXISTS activities_ticket_identity ON activities(ticket_id, id); CREATE TRIGGER IF NOT EXISTS numeric_mentions_activity_delete AFTER DELETE ON activities BEGIN DELETE FROM numeric_mentions WHERE source_id = OLD.id AND activity = 1; END;")?;
            let mut statement = transaction.prepare("SELECT id, body, 0 FROM tickets UNION ALL SELECT id, body, 0 FROM documents UNION ALL SELECT id, brief, 1 FROM activities")?;
            let records = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            for (id, body, activity) in records {
                if activity {
                    document_links::index_activity(&transaction, &id, &body)?;
                } else {
                    document_links::index_body(&transaction, &id, &body)?;
                }
            }
            transaction.pragma_update(None, "user_version", 41)?;
        }
        if version < 42 {
            // Rebuildable, ordered projections let graph reads stop after a bounded
            // number of Activity mentions without walking unrelated Activities.
            transaction.execute_batch("                CREATE TABLE IF NOT EXISTS activity_graph_targets (ticket_id TEXT NOT NULL, activity_id TEXT NOT NULL, target_id TEXT NOT NULL, passage TEXT NOT NULL, PRIMARY KEY(ticket_id, activity_id, target_id, passage));
                INSERT OR IGNORE INTO activity_graph_numbers SELECT a.ticket_id, m.source_id, m.reference, m.passage FROM numeric_mentions m JOIN activities a ON a.id=m.source_id WHERE m.activity=1;
                INSERT OR IGNORE INTO activity_graph_targets SELECT a.ticket_id, m.activity_id, m.target_id, m.passage FROM activity_mentions m JOIN activities a ON a.id=m.activity_id;
                CREATE TRIGGER IF NOT EXISTS activity_graph_targets_insert AFTER INSERT ON activity_mentions BEGIN INSERT OR IGNORE INTO activity_graph_targets SELECT ticket_id, NEW.activity_id, NEW.target_id, NEW.passage FROM activities WHERE id=NEW.activity_id; END;
                CREATE TRIGGER IF NOT EXISTS activity_graph_targets_delete AFTER DELETE ON activity_mentions BEGIN DELETE FROM activity_graph_targets WHERE activity_id=OLD.activity_id AND target_id=OLD.target_id AND passage=OLD.passage; END;
                CREATE INDEX IF NOT EXISTS activity_graph_targets_source ON activity_graph_targets(activity_id, target_id, passage);
                CREATE INDEX IF NOT EXISTS context_mentions_reverse_full ON context_mentions(target_id, source_id, passage);
                CREATE INDEX IF NOT EXISTS activity_mentions_reverse_full ON activity_mentions(target_id, activity_id, passage);
                PRAGMA user_version=42;")?;
        }
        if version < 43 {
            let has_body_heading: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('documents') WHERE name = 'body_heading')", [], |row| row.get(0))?;
            if !has_body_heading {
                transaction.execute_batch("ALTER TABLE documents ADD COLUMN body_heading TEXT;")?;
            }
            transaction.execute_batch("UPDATE documents SET body_heading = nullif(trim(substr(ltrim(body, char(10)||char(13)||' '), 1, min(200, instr(ltrim(body, char(10)||char(13)||' ') || char(10), char(10)) - 1))), '');
                CREATE TRIGGER IF NOT EXISTS document_heading_insert AFTER INSERT ON documents BEGIN UPDATE documents SET body_heading = nullif(trim(substr(ltrim(new.body, char(10)||char(13)||' '), 1, min(200, instr(ltrim(new.body, char(10)||char(13)||' ') || char(10), char(10)) - 1))), '') WHERE id = new.id; END;
                CREATE TRIGGER IF NOT EXISTS document_heading_update AFTER UPDATE OF body ON documents BEGIN UPDATE documents SET body_heading = nullif(trim(substr(ltrim(new.body, char(10)||char(13)||' '), 1, min(200, instr(ltrim(new.body, char(10)||char(13)||' ') || char(10), char(10)) - 1))), '') WHERE id = new.id; END;")?;
            transaction.execute_batch("CREATE VIRTUAL TABLE IF NOT EXISTS ticket_graph_fts USING fts5(title, body, content='tickets', content_rowid='rowid');
                INSERT INTO ticket_graph_fts(ticket_graph_fts) VALUES ('rebuild');
                CREATE TRIGGER IF NOT EXISTS ticket_graph_fts_insert AFTER INSERT ON tickets BEGIN INSERT INTO ticket_graph_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
                CREATE TRIGGER IF NOT EXISTS ticket_graph_fts_delete AFTER DELETE ON tickets BEGIN INSERT INTO ticket_graph_fts(ticket_graph_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END;
                CREATE TRIGGER IF NOT EXISTS ticket_graph_fts_update AFTER UPDATE OF title, body ON tickets BEGIN INSERT INTO ticket_graph_fts(ticket_graph_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); INSERT INTO ticket_graph_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
                CREATE VIRTUAL TABLE IF NOT EXISTS plan_graph_fts USING fts5(name, purpose, content='plans', content_rowid='rowid');
                INSERT INTO plan_graph_fts(plan_graph_fts) VALUES ('rebuild');
                CREATE TRIGGER IF NOT EXISTS plan_graph_fts_insert AFTER INSERT ON plans BEGIN INSERT INTO plan_graph_fts(rowid, name, purpose) VALUES (new.rowid, new.name, new.purpose); END;
                CREATE TRIGGER IF NOT EXISTS plan_graph_fts_delete AFTER DELETE ON plans BEGIN INSERT INTO plan_graph_fts(plan_graph_fts, rowid, name, purpose) VALUES ('delete', old.rowid, old.name, old.purpose); END;
                CREATE TRIGGER IF NOT EXISTS plan_graph_fts_update AFTER UPDATE OF name, purpose ON plans BEGIN INSERT INTO plan_graph_fts(plan_graph_fts, rowid, name, purpose) VALUES ('delete', old.rowid, old.name, old.purpose); INSERT INTO plan_graph_fts(rowid, name, purpose) VALUES (new.rowid, new.name, new.purpose); END;
                PRAGMA user_version = 43;")?;
        }
        if version < 44 {
            // The latest Activity of a ticket is read on every refresh.
            transaction.execute_batch("CREATE INDEX IF NOT EXISTS activities_ticket_number ON activities(ticket_id, number DESC); PRAGMA user_version = 44;")?;
        }
        if version < 45 {
            change_token::migrate(&transaction)?;
        }
        if version < 46 {
            ticket_documents::migrate(&transaction)?;
        }
        if version < 47 {
            attachments::migrate(&transaction)?;
        }
        if version < 48 {
            embedded_attachments::migrate(&transaction)?;
        }
        if version < 49 {
            attachments::migrate_upload_settings(&transaction)?;
        }
        if version < 50 {
            attachment_retention::migrate(&transaction, version > 0)?;
        }
        if version < 51 {
            drive::migrate(&transaction)?;
        }
        if version < 52 {
            drive::migrate_uploads(&transaction)?;
        }
        if version < 53 {
            attachment_cleanup::migrate(&transaction)?;
        }
        if version < 54 {
            attachment_cleanup::migrate_purge(&transaction)?;
        }
        if version < 55 {
            upload_destination::migrate(&transaction)?;
        }
        if version < 56 {
            device::migrate(&transaction)?;
        }
        if version < 57 {
            versions::migrate(&transaction)?;
        }
        if version < 58 {
            sync::migrate(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 58;")?;
        }
        if version < 59 {
            sync::migrate_setup(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 59;")?;
        }
        if version < 60 {
            sync::migrate_recovery(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 60;")?;
        }
        if version < 61 {
            sync::migrate_run_token(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 61;")?;
        }
        if version < 62 {
            sync::migrate_download_attempts(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 62;")?;
        }
        if version < 63 {
            sync::migrate_file_identity(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 63;")?;
        }
        if version < 64 {
            sync::migrate_file_created(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 64;")?;
        }
        if version < 65 {
            sync::migrate_last_folder(&transaction)?;
            transaction.execute_batch("PRAGMA user_version = 65;")?;
        }
        if version < 66 {
            chats::migrate(&transaction)?;
        }
        if version < 67 {
            chats::migrate_attention(&transaction)?;
        }
        if version < 68 {
            chats::migrate_tool_start(&transaction)?;
        }
        let violations: i64 =
            transaction.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })?;
        if violations != 0 {
            return Err(Error::Attachment(
                "migration would invalidate existing references; preserved pre-migration backup"
                    .into(),
            ));
        }
        transaction.commit()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    }

    pub fn create_ticket(&mut self, title: &str) -> Result<Ticket, Error> {
        self.create_ticket_in_project(title, None)
    }

    pub fn create_ticket_in_project(
        &mut self,
        title: &str,
        project_id: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.create_ticket_in_context(title, project_id, None)
    }

    pub fn create_ticket_in_context(
        &mut self,
        title: &str,
        project_id: Option<&str>,
        plan_id: Option<&str>,
    ) -> Result<Ticket, Error> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::EmptyTitle);
        }
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        if let Some(id) = project_id {
            projects::find(&transaction, id)?;
        }
        if let Some(id) = plan_id {
            plans::ensure_active(&transaction, id)?;
        }
        let id = Uuid::new_v4().to_string();
        let reference = device::issue_reference(&transaction)?;
        transaction.execute(
            "INSERT INTO tickets (id, reference, title, status, project_id, plan_id) VALUES (?1, ?2, ?3, 'Todo', ?4, ?5)",
            params![id, reference, title, project_id, plan_id],
        )?;
        if let Some(project_id) = project_id {
            history::record(&transaction, &id, "project", "", project_id, None)?;
        }
        if let Some(plan_id) = plan_id {
            history::record(&transaction, &id, "plan", "", plan_id, None)?;
        }
        transaction.commit()?;
        self.show_ticket(&reference)
    }

    pub fn change_ticket(&mut self, reference: &str, patch: TicketPatch) -> Result<Ticket, Error> {
        let title = patch.title.as_deref().map(str::trim);
        if title == Some("") {
            return Err(Error::EmptyTitle);
        }
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let ticket = transaction
            .query_row(
                "SELECT id, reference, title, status, body, project_id, plan_id, trashed FROM tickets WHERE reference = ?1",
                [reference],
                ticket_from_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(reference.to_owned()))?;
        ensure_editable(&transaction, &ticket.id)?;
        let stale = |new: &Option<String>, expected: &Option<String>, stored: &str| {
            new.is_some()
                && expected
                    .as_deref()
                    .is_some_and(|expected| expected != stored)
        };
        if stale(&patch.title, &patch.expected_title, &ticket.title)
            || stale(&patch.body, &patch.expected_body, &ticket.body)
        {
            return Err(Error::TicketChanged(reference.to_owned()));
        }
        source::guard_change(
            &transaction,
            &ticket,
            title,
            patch.body.as_deref(),
            patch.status.unwrap_or(ticket.status),
        )?;
        if let Some(ref plan_id) = patch.plan_id {
            if let Some(id) = plan_id {
                if *plan_id == ticket.plan_id {
                    plans::get(&transaction, id)?;
                } else {
                    // Moving a ticket out of an archived Plan stays allowed; moving in is not.
                    plans::ensure_active(&transaction, id)?;
                }
            }
            if *plan_id != ticket.plan_id {
                transaction.execute(
                    "UPDATE tickets SET plan_id = ?1 WHERE id = ?2",
                    params![plan_id, ticket.id],
                )?;
                history::record(
                    &transaction,
                    &ticket.id,
                    "plan",
                    ticket.plan_id.as_deref().unwrap_or(""),
                    plan_id.as_deref().unwrap_or(""),
                    patch.editing_agent.as_deref(),
                )?;
            }
        }
        if let Some(ref project_id) = patch.project_id {
            if let Some(id) = project_id {
                projects::find(&transaction, id)?;
            }
            if *project_id != ticket.project_id {
                transaction.execute(
                    "UPDATE tickets SET project_id = ?1 WHERE id = ?2",
                    params![project_id, ticket.id],
                )?;
                history::record(
                    &transaction,
                    &ticket.id,
                    "project",
                    ticket.project_id.as_deref().unwrap_or(""),
                    project_id.as_deref().unwrap_or(""),
                    patch.editing_agent.as_deref(),
                )?;
            }
        }
        let status = patch.status.unwrap_or(ticket.status);
        if status != ticket.status {
            if status == Status::Duplicate {
                return Err(Error::DuplicateNeedsCanonical);
            }
            if ticket.status == Status::Duplicate {
                duplicates::clear(&transaction, &ticket.id, patch.editing_agent.as_deref())?;
            }
        }
        transaction.execute("UPDATE tickets SET title = COALESCE(?1, title), body = COALESCE(?2, body), status = ?3 WHERE id = ?4", params![title, patch.body, status.to_string(), ticket.id])?;
        if let Some(body) = patch.body.as_deref() {
            document_links::index_body(&transaction, &ticket.id, body)?;
        }
        if status != ticket.status {
            history::record(
                &transaction,
                &ticket.id,
                "status",
                &ticket.status.to_string(),
                &status.to_string(),
                patch.editing_agent.as_deref(),
            )?;
        }
        let mut updated = transaction.query_row(
            "SELECT id, reference, title, status, body, project_id, plan_id, trashed FROM tickets WHERE id = ?1",
            [&ticket.id],
            ticket_from_row,
        )?;
        updated.tags = tags::for_ticket(&transaction, &updated.id)?;
        relationships::populate(&transaction, &mut updated)?;
        hierarchy::populate(&transaction, &mut updated)?;
        duplicates::populate(&transaction, &mut updated)?;
        source::populate(&transaction, &mut updated)?;
        activities::populate_update(&transaction, &mut updated)?;
        transaction.commit()?;
        Ok(updated)
    }

    pub fn set_trashed(
        &mut self,
        reference: &str,
        trashed: bool,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id = relationships::id(&tx, reference)?;
        let old: bool =
            tx.query_row("SELECT trashed FROM tickets WHERE id = ?1", [&id], |row| {
                row.get(0)
            })?;
        if old != trashed {
            tx.execute(
                "UPDATE tickets SET trashed = ?1 WHERE id = ?2",
                params![trashed, id],
            )?;
            history::record(
                &tx,
                &id,
                "trash",
                if old { "trashed" } else { "active" },
                if trashed { "trashed" } else { "active" },
                agent,
            )?;
        }
        tx.commit()?;
        self.show_ticket(reference)
    }

    pub fn ticket_history(&self, reference: &str) -> Result<Vec<HistoryEntry>, Error> {
        let ticket = self.show_ticket(reference)?;
        history::read(&self.connection, &ticket.id)
    }

    pub fn add_activity(
        &mut self,
        reference: &str,
        content: &str,
        agent: Option<&str>,
    ) -> Result<Activity, Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id_ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &id_ticket)?;
        let result = activities::add(&tx, &id_ticket, content, agent)?;
        inbox::record(&tx, &id_ticket, "activity", &result.id, content, agent)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn add_activity_with_details(
        &mut self,
        reference: &str,
        brief: &str,
        agent: Option<&str>,
        details: Option<&str>,
        existing_document_id: Option<&str>,
    ) -> Result<Activity, Error> {
        // Blank details are no details: an untouched empty capture creates nothing.
        let details = details.filter(|text| !text.trim().is_empty());
        if details.is_some() && existing_document_id.is_some() {
            return Err(Error::ConflictingActivitySupport);
        }
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &ticket)?;
        let activity = activities::add(&tx, &ticket, brief, agent)?;
        let document_id = if let Some(body) = details {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO entities (id, kind) VALUES (?1, 'document')",
                [&id],
            )?;
            tx.execute(
                "INSERT INTO documents (id, body, originating_activity_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, body, activity.id],
            )?;
            document_links::index_body(&tx, &id, body)?;
            Some(id)
        } else if let Some(id) = existing_document_id {
            let trashed: Option<bool> = tx
                .query_row("SELECT trashed FROM documents WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .optional()?;
            match trashed {
                None => return Err(Error::DocumentNotFound(id.to_owned())),
                Some(true) => return Err(Error::DocumentTrashed(id.to_owned())),
                Some(false) => {}
            }
            Some(id.to_owned())
        } else {
            None
        };
        tx.execute(
            "UPDATE activities SET supporting_document_id = ?1 WHERE id = ?2",
            rusqlite::params![document_id, activity.id],
        )?;
        inbox::record(&tx, &ticket, "activity", &activity.id, brief, agent)?;
        let result = activities::get(&tx, &ticket, &activity.id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn edit_activity(
        &mut self,
        reference: &str,
        id: &str,
        patch: ActivityPatch,
    ) -> Result<Activity, Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id_ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &id_ticket)?;
        let result = activities::edit(&tx, &id_ticket, id, patch)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn delete_activity(&mut self, reference: &str, id: &str) -> Result<(), Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let id_ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &id_ticket)?;
        tx.execute("INSERT INTO document_opens (document_id) SELECT id FROM documents WHERE originating_activity_id = ?1 AND kept = 0 ON CONFLICT(document_id) DO NOTHING", [id])?;
        activities::delete(&tx, &id_ticket, id)?;
        tx.commit()?;
        Ok(())
    }
    /// Read the latest authored Activity without loading its history.
    pub fn latest_update(&self, reference: &str) -> Result<Option<LatestUpdate>, Error> {
        let id = relationships::id(&self.connection, reference)?;
        activities::latest(&self.connection, &id)
    }

    pub fn activity_feed(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ActivityFeedEntry>, Error> {
        let ticket = self.show_ticket(reference)?;
        activities::feed(&self.connection, &ticket.id, limit, offset)
    }

    pub fn activity(&self, reference: &str, id: &str) -> Result<Activity, Error> {
        let ticket = self.show_ticket(reference)?;
        activities::get(&self.connection, &ticket.id, id)
    }

    pub fn activities(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Activity>, Error> {
        let ticket = self.show_ticket(reference)?;
        activities::read(&self.connection, &ticket.id, limit, offset)
    }

    pub fn list_tickets(&self) -> Result<Vec<Ticket>, Error> {
        self.list_by_trash(false)
    }

    pub fn list_trash(&self) -> Result<Vec<Ticket>, Error> {
        self.list_by_trash(true)
    }

    fn list_by_trash(&self, trashed: bool) -> Result<Vec<Ticket>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT id, reference, title, status, body, project_id, plan_id, trashed FROM tickets WHERE trashed = ?1 ORDER BY number DESC",
        )?;
        let mut tickets = statement
            .query_map([trashed], ticket_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for ticket in &mut tickets {
            ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
            relationships::populate(&self.connection, ticket)?;
            hierarchy::populate(&self.connection, ticket)?;
            duplicates::populate(&self.connection, ticket)?;
            source::populate(&self.connection, ticket)?;
            activities::populate_update(&self.connection, ticket)?;
        }
        Ok(tickets)
    }

    pub fn show_ticket(&self, reference: &str) -> Result<Ticket, Error> {
        let ticket = self
            .connection
            .query_row(
                "SELECT id, reference, title, status, body, project_id, plan_id, trashed FROM tickets WHERE reference = ?1",
                [reference],
                ticket_from_row,
            )
            .optional()?;
        let mut ticket = ticket.ok_or_else(|| Error::NotFound(reference.to_owned()))?;
        ticket.tags = tags::for_ticket(&self.connection, &ticket.id)?;
        relationships::populate(&self.connection, &mut ticket)?;
        hierarchy::populate(&self.connection, &mut ticket)?;
        duplicates::populate(&self.connection, &mut ticket)?;
        source::populate(&self.connection, &mut ticket)?;
        activities::populate_update(&self.connection, &mut ticket)?;
        Ok(ticket)
    }
}

fn ticket_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        id: row.get(0)?,
        trashed: row.get(7)?,
        reference: row.get::<_, String>(1)?,
        title: row.get(2)?,
        status: row.get::<_, String>(3)?.parse().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        body: row.get(4)?,
        updated_at: None,
        latest_update: None,
        tags: Vec::new(),
        project_id: row.get(5)?,
        plan_id: row.get(6)?,
        availability: None,
        prerequisites: Vec::new(),
        duplicate_of: None,
        duplicates: Vec::new(),
        duplicate_redirect: None,
        source: None,
        publication: None,
        parent: None,
        children: Vec::new(),
    })
}

// All ticket mutations must check this inside the same write transaction.
pub(crate) fn ensure_editable(connection: &Connection, id: &str) -> Result<(), Error> {
    let (trashed, reference): (bool, String) = connection.query_row(
        "SELECT trashed, reference FROM tickets WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if trashed {
        return Err(Error::Trashed(reference));
    }
    Ok(())
}

// A savepoint used independently acquires the write lock before reading invariants.
fn transaction_write_lock(connection: &Connection) -> Result<(), Error> {
    connection.execute("UPDATE tickets SET number = number WHERE 0", [])?;
    Ok(())
}

mod batch;
pub use batch::{BatchOperation, TicketChange};

/// Where the default workspace lives, without creating anything.
fn default_path_unchecked() -> Result<std::path::PathBuf, Error> {
    // Development builds can exercise the desktop against a disposable workspace.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TICKETD_TEST_WORKSPACE") {
        return Ok(path.into());
    }
    let dirs = ProjectDirs::from("", "", "ticketd").ok_or(Error::NoDataDirectory)?;
    Ok(dirs.data_dir().join("workspace.sqlite3"))
}

fn default_path() -> Result<std::path::PathBuf, Error> {
    let path = default_path_unchecked()?;
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    Ok(path)
}

/// Name the file or folder a person supplied when it is missing or of the wrong
/// kind. Other I/O failures keep the generic workspace wording.
pub(crate) fn path_error(role: &str, path: &std::path::Path, error: std::io::Error) -> Error {
    let shown = if path.as_os_str().is_empty() {
        std::path::Path::new(".")
    } else {
        path
    };
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            Error::Path(format!("{role} not found: {}", shown.display()))
        }
        std::io::ErrorKind::NotADirectory => {
            Error::Path(format!("{role} is not a folder: {}", shown.display()))
        }
        _ => Error::Directory(error),
    }
}
