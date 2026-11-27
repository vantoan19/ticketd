//! Shared ticket workflows for the desktop and CLI.
pub mod agent_skills;
pub mod harnesses;
pub use search::{MetadataSelection, TicketMetadata, TicketMetadataPage, TicketWithUpdate};
mod backlinks;
pub use backlinks::Backlink;
mod backup;
mod backup_archive;
mod restore;
pub use backup::BackupRecord;
mod backup_review;
mod restore_points;
pub use backup_review::{
    AttachmentBackupContent, BackupCheck, BackupInspection, SafetyBackup, SafetyBackupKind,
    WorkspaceSummary,
};
pub use restore_points::{RESTORE_POINTS_KEPT, RestorePoint, RestorePointKind, RestorePointList};
mod context;
mod context_graph;
mod device;
pub use context_graph::{
    ContextGraph, ContextGraphContinuation, ContextGraphEdge, ContextGraphNode, ContextGraphPage,
    WorkspaceGraph, WorkspaceGraphRequest,
};
mod document_links;
pub use document_links::{ContextLink, DocumentBacklink, derive_brief_heading, derive_heading};
mod current_work;
pub use current_work::{CurrentWork, CurrentWorkGroup, CurrentWorkPlan};
mod documents;
pub use documents::{
    Document, DocumentPatch, DocumentPlanContext, DocumentSearchResult, DocumentSummary,
    DocumentTicketContext,
};
mod duplicates;
pub use duplicates::{
    DependencyChoice, DependencyDecision, DependencyEdge, DuplicateDependencyPreview,
    ReplacementIssue, ReviewMode, WaitingOutcome, WaitingTicket,
};
mod evidence;
mod failure;
pub use failure::FailureKind;
mod export;
mod portable_export;
pub use portable_export::{
    ExportAttachment, ExportAttachmentKind, ExportStatus, MarkdownExport, MarkdownExportSource,
};
mod location;
pub use context::{ContextOptions, TicketContext};
pub use evidence::{Evidence, EvidenceInput, EvidenceKind};
pub use location::{
    WorkspaceFile, WorkspaceHealth, WorkspaceInfo, default_workspace_file, workspace_file,
    workspace_health,
};

mod plans;
mod retry;
pub mod source;
pub mod sync;
pub use retry::{WriteRequest, WriteResult};
mod graph;
mod hierarchy;
pub use graph::{DependencyGraph, GraphEdge, GraphNode};
mod project_remote;
mod projects;
mod relationships;
pub use relationships::RelationshipKind;
mod search;
pub use search::{
    ActiveTicket, Availability, PrerequisiteCounts, SourcePill, TicketFilter, TicketOrder,
    TicketRow,
};
mod sync_files;
pub use sync_files::{MissingTarget, SyncKind, SyncPart, SyncPartKind, SyncRecord, SyncValue};
mod hydrate;
mod read_scope;
mod session;
pub use session::{WorkspaceGuard, WorkspaceSession};
mod tags;
mod ticket_documents;
mod write_scope;
pub use plans::{
    Plan, PlanContext, PlanContextDependency, PlanContextDocument, PlanContextHeader,
    PlanContextTicket, PlanCounts, PlanView,
};

use std::{
    path::Path,
    time::{Duration, Instant},
};

use directories::ProjectDirs;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};

mod counts;
mod history;
mod readiness;
pub use counts::{SidebarCounts, StatusCounts};
mod inbox;
pub use inbox::{AttentionEntry, InboxAttention, InboxEntry, ReminderState, ReviewState};
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
    AttachmentMedia, AttachmentPreview, HTML_PREVIEW_BYTES, PDF_PREVIEW_BYTES, PreviewStatus,
    PreviewUsage, PreviewUse, TEXT_EXCERPT_BYTES, TEXT_TAIL_BYTES, TEXT_WHOLE_BYTES, TextExcerpt,
    TextScope,
};
pub use upload_destination::{AttachmentUploadDestination, GoogleSignIn};
pub use versions::{RecordKind, Version, VersionSummary};
pub mod drive;
mod embedded_attachments;
pub mod s3;
pub use attachment_retention::{AttachmentProtection, AttachmentUsage, DraftRetention};
pub use attachments::{
    Attachment, AttachmentKind, AttachmentOpenTarget, AttachmentPurgeState,
    DEFAULT_ATTACHMENT_LIMIT, DISPLAY_NAME_LIMIT, MAX_BACKUP_FILE_BYTES,
};
mod automation_advance;
mod automation_agents;
mod automation_background;
pub use automation_background::{DEFAULT_AUTOMATION_RUNS_AT_ONCE, MOST_AUTOMATION_RUNS_AT_ONCE};
mod automation_endings;
mod automation_examples;
mod automation_matching;
mod automation_run_machine;
mod automation_runs;
mod automation_schedule;
mod automation_steps;
mod automations;
mod change_token;
mod chat_suggestions;
mod chats;
mod events;
pub use activities::{
    Activity, ActivityFeedEntry, ActivityPatch, AgentUpdate, LatestUpdate, ReportedUpdate,
    UpdateBrief,
};
pub use automation_advance::{AgentStart, RunAction, StartedBy, TicketData};
pub use automation_agents::{
    AgentHarness, AutomationAgent, AutomationAgentSettings, AutomationAgentTools,
};
pub use automation_examples::AutomationExample;
pub use automation_run_machine::{RunEnd, StepOutcome};
pub use automation_runs::{
    AutomationRun, AutomationRunScope, AutomationRunStatus, AutomationRunStep,
    AutomationRunSummary, AutomationRunTicket, AutomationStepStatus, RunAnswer,
    RunningAutomationRuns,
};
pub use automation_steps::AutomationNotification;
pub use automations::{
    AUTOMATION_TRIGGER_ID, Automation, AutomationDefinition, AutomationProblem, Check, Condition,
    NotifyTarget, Schedule, Step, StepAction, StepChange, Trigger, Weekday,
};
pub use chat_suggestions::{ChatSuggestion, SuggestedTicket};
pub use chats::{
    AGENT_CHANGES_RECORD_NAME, CHAT_AGENT_CHANGES_LIMIT, CHAT_CHANGE_TAIL,
    CHAT_EFFECTIVE_SETTINGS_LIMIT, CHAT_ID_VARIABLE, CHAT_NOTICE_LIMIT, CHAT_RESET_TIME_MAX,
    CHAT_TOOL_OUTPUT_LIMIT, Chat, ChatAgentChange, ChatAttachment, ChatAttachmentContent,
    ChatCatchUp, ChatChange, ChatCreationReplay, ChatDelivery, ChatDeliveryDecision,
    ChatHistoryPage, ChatInputChange, ChatInputReceipt, ChatInputStanding, ChatInteraction,
    ChatInteractionKind, ChatInteractionState, ChatItem, ChatLink, ChatLinkKind, ChatLinkedRecord,
    ChatListFilter, ChatMessage, ChatMessageNote, ChatMessageNoteKind, ChatNotice, ChatObservation,
    ChatOwner, ChatPlannedWrite, ChatPlannedWriteKind, ChatQueueEdit, ChatRecord, ChatRole,
    ChatSession, ChatSessionOrigin, ChatSnapshot, ChatStartPicks, ChatSubAgent, ChatSubAgentRun,
    ChatSubAgentState, ChatSubAgentStopper, ChatSubmissionAttempt, ChatSubmissionIntent,
    ChatSummary, ChatTool, ChatToolState, ChatTurn, ChatTurnOrigin, ChatTurnReceipt,
    ChatTurnStarter, ChatTurnState, ChatWriteCredit, FolderChat, NewChat, PreparedChatInput,
    TicketWriteCredits, TicketWritingAgent, sub_agent_title,
};
pub use events::{AUTOMATION_RUN_ID_VARIABLE, WorkspaceActor, WorkspaceEvent, WorkspaceEventType};
pub use history::{HistoryEntry, Status};
pub use project_remote::{ProjectRemoteCandidate, ProjectRemoteDetection, detect_project_remote};
pub use projects::{
    CheckoutRegistration, CheckoutRemoteMismatch, Project, ProjectArchiveOutcome,
    ProjectRemoteChange,
};
pub use readiness::Readiness;

mod format;
pub use format::FORMAT_VERSION;
#[cfg(feature = "test-schema")]
pub use format::create_workspace_at_format_version;

/// What to add to "ticket ... was not found" when the text cannot be a reference.
/// Identifiers (UUIDs) are left alone: the mistake there is not the format.
fn not_found_hint(reference: &str) -> String {
    if document_links::is_ticket_reference(reference) || reference.matches('-').count() >= 4 {
        return String::new();
    }
    let upper = reference.to_ascii_uppercase();
    if upper != reference && document_links::is_ticket_reference(&upper) {
        return format!("; references are case-sensitive, did you mean '{upper}'?");
    }
    "; a reference is T-, a two-letter device code and a number, for example T-KQ12".to_owned()
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot reopen workspace at {}: {source}. Restore the workspace file or make its folder available, then retry", path.display())]
    WorkspaceUnavailable {
        path: std::path::PathBuf,
        #[source]
        source: Box<Error>,
    },
    #[error("Drive: {0}")]
    Drive(#[from] drive::DriveError),
    #[error("attachment: {0}")]
    Attachment(String),
    /// A file is larger than the workspace upload limit, in bytes.
    #[error("attachment: {}", upload_limit_message(*.limit))]
    UploadLimit { limit: u64 },
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
    #[error("request ID must not be empty")]
    EmptyRequestId,
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
    /// A failure inside a batch, worded with the batch's own `$name`s for tickets the
    /// batch created. Those tickets were never saved, so their references mean nothing to
    /// the caller. The cause is kept and decides the failure kind.
    #[error("{message}")]
    BatchNamed {
        message: String,
        #[source]
        source: Box<Error>,
    },
    #[error("invalid reminder time: {0}")]
    InvalidReminderTime(String),
    #[error("{0} has no reminder to snooze; set one first")]
    NoReminder(String),
    #[error("{reference} is already due at {current}; a snooze must move the reminder later")]
    SnoozeNotLater { reference: String, current: String },
    #[error("inbox entry {0} was not found")]
    InboxEntryNotFound(i64),
    #[error("invalid graph request: {0}")]
    InvalidGraphRequest(String),
    #[error("plan name must not be empty")]
    EmptyPlanName,
    #[error("plan name must be at most {0} characters")]
    PlanNameTooLong(usize),
    #[error("plan '{0}' was not found")]
    PlanNotFound(String),
    #[error(
        "checkout matches multiple projects ({0}); specify --project explicitly or remove a registration"
    )]
    AmbiguousProject(String),
    #[error("This folder is registered to {0}.")]
    CheckoutTaken(String),
    #[error("This folder is not registered to {0}.")]
    CheckoutNotRegistered(String),
    #[error("checkout path must be valid Unicode")]
    InvalidCheckoutPath,
    #[error("project name and path must not be empty")]
    EmptyProject,
    #[error("Enter a Project remote in host/owner/name format.")]
    InvalidProjectRemote,
    #[error(
        "Project remote {remote} belongs to {project}. Choose another remote or clear it on that project."
    )]
    ProjectRemoteTaken { remote: String, project: String },
    #[error("{0} already has a Project remote. Choose a project without one.")]
    ProjectAlreadyHasRemote(String),
    #[error("Register a checkout for {0} before linking it to a discovery repository.")]
    ProjectCheckoutRequired(String),
    #[error(
        "{0} is no longer in the saved discovery repositories. Reload the routes and choose a saved repository."
    )]
    SourceRepositoryNotListed(String),
    #[error("project '{0}' was not found")]
    ProjectNotFound(String),
    #[error("{0} is archived. Reactivate it, or choose another project.")]
    ProjectArchived(String),
    #[error("Set a Project remote on {0} before connecting its ticket source.")]
    ProjectRemoteRequired(String),
    #[error(
        "Project remote {remote} is on a different host from the {provider} source. Select a remote on the source's host to connect it."
    )]
    ProjectSourceHostMismatch { remote: String, provider: String },
    #[error(
        "Connect the {provider} ticket source with {repository} in its discovery repositories, then preview again."
    )]
    ProjectSourceNotConnected {
        provider: String,
        repository: String,
    },
    #[error("The connection preview changed. Preview again before confirming.")]
    ConnectSourceChanged,
    #[error("agent '{0}' was not found")]
    AutomationAgentNotFound(String),
    #[error("invalid agent: {0}")]
    InvalidAutomationAgent(String),
    #[error("This agent is used by {0}. Change that step first.")]
    AutomationAgentInUse(String),
    #[error("Automation '{0}' was not found")]
    AutomationNotFound(String),
    #[error("Automation run '{0}' was not found")]
    AutomationRunNotFound(String),
    #[error("Automation run: {0}")]
    AutomationRun(String),
    #[error("Its Automation was deleted, so it cannot be run again.")]
    AutomationRunAutomationDeleted,
    #[error("invalid Automation: {0}")]
    InvalidAutomation(String),
    #[error("This Automation cannot run yet. {0}.")]
    AutomationUnfinished(String),
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
    #[error(
        "a tag must be at most {max} characters and contain no commas, tabs or line breaks; shorten it or split it into separate tags"
    )]
    InvalidTag { max: usize },
    #[error("ticket '{0}' is in trash; restore it before editing")]
    Trashed(String),
    #[error("document '{0}' is in trash; restore it with `ticketd document restore {0}` first")]
    DocumentTrashed(String),
    #[error("a related ticket is missing from the workspace")]
    MissingRelatedTicket,
    #[error("ticket title must not be empty")]
    EmptyTitle,
    #[error("a ticket title must be one line; put the rest in the description")]
    TitleNotOneLine,
    #[error("a ticket title must be at most {0} characters; put the rest in the description")]
    TitleTooLong(usize),
    #[error("ticket '{0}' was not found{hint}", hint = not_found_hint(.0))]
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
        /// The issue has an unknown state category, so Done or
        /// Canceled may be chosen here.
        closure_unrecognized: bool,
    },
    #[error("{0} is not owned by an external source, so there is nothing to refresh")]
    NotSynchronized(String),
    #[error("{0} is already a local ticket, so there is nothing to take over")]
    AlreadyLocal(String),
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
    #[error("the legacy issue identifier is already used by an issue at a different site")]
    SyncFileIdentityCollision,
    #[error("sync: {0}")]
    Sync(String),
    #[error(
        "workspace schema version {0} is newer than this application supports; update ticketd to open it"
    )]
    NewerSchema(i64),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    /// Device-local insertion order, highest first in newest lists; absent in older payloads.
    #[serde(default)]
    pub local_number: Option<i64>,
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

pub(crate) fn deserialize_project_patch<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

fn upload_limit_message(limit: u64) -> String {
    let bound = if limit.is_multiple_of(1_048_576) {
        format!("{} MiB ({limit} bytes)", limit / 1_048_576)
    } else {
        format!("{limit} bytes")
    };
    if limit >= attachments::MAX_BACKUP_FILE_BYTES {
        return format!(
            "file is larger than the {bound} ticketd can keep, the most a backup can hold; choose a smaller file"
        );
    }
    format!(
        "file exceeds the workspace upload limit of {bound}; choose a smaller file, or raise the limit with `ticketd attachment limit --bytes <bytes>`"
    )
}

fn external_status_message(
    reference: &str,
    provider: &str,
    open: bool,
    closure_unrecognized: bool,
) -> String {
    if closure_unrecognized {
        format!(
            "{reference} has an unrecognized state on {provider}; choose Done or Canceled here, or check the issue there"
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
        Self::open_within(path.as_ref(), OPEN_WORKSPACES_WAIT, MIGRATION_WAIT, true)
    }

    /// Opens an initialized workspace without creating a missing database.
    /// Existing workspaces still receive the same migration and restore recovery.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref();
        Self::open_within(path, OPEN_WORKSPACES_WAIT, MIGRATION_WAIT, false).map_err(|source| {
            Error::WorkspaceUnavailable {
                path: path.to_path_buf(),
                source: Box::new(source),
            }
        })
    }

    /// [`Workspace::open`] with other bounds on its two waits, so a test of
    /// which wait applies does not have to sit one out.
    #[cfg(feature = "test-lock-waits")]
    pub fn open_with_lock_waits(
        path: impl AsRef<Path>,
        open_workspaces: Duration,
        migration: Duration,
    ) -> Result<Self, Error> {
        Self::open_within(path.as_ref(), open_workspaces, migration, true)
    }

    fn open_within(
        path: &Path,
        open_workspaces_wait: Duration,
        migration_wait: Duration,
        create: bool,
    ) -> Result<Self, Error> {
        let mut flags = OpenFlags::default();
        if !create {
            flags.remove(OpenFlags::SQLITE_OPEN_CREATE);
        }
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
        // While this open waits for exclusive use, warm sessions elsewhere are asked to
        // let go (ADR 0016).
        let mut release: Option<session::ReleaseRequest> = None;
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
            // Another process waits for warm sessions to let go; opening now would
            // hold it off.
            if release.is_none() && session::release_requested(path) {
                drop(lock);
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
                    if release.is_none() {
                        release = Some(session::ReleaseRequest::new(path)?);
                    }
                    wait_for_migration_lock(
                        *open_elsewhere
                            .get_or_insert_with(|| Instant::now() + open_workspaces_wait),
                    )?;
                    continue;
                }
                release = None;
                restore::recover(path)?;
                continue;
            }
            let connection = Connection::open_with_flags(path, flags)?;
            if backup::table_exists(&connection, "ticketd_backup_container")?
                || backup::table_exists(&connection, "ticketd_backup_files")?
            {
                return Err(Error::Backup("this is an attachment backup container; restore it with `ticketd restore-workspace <backup>` or Settings › Backups & export".into()));
            }
            session::configure(&connection)?;
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
                if release.is_none() {
                    release = Some(session::ReleaseRequest::new(path)?);
                }
                wait_for_migration_lock(
                    *open_elsewhere.get_or_insert_with(|| Instant::now() + open_workspaces_wait),
                )?;
                continue;
            }
            release = None;
            let mut connection = Connection::open_with_flags(path, flags)?;
            session::configure(&connection)?;
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
                let result = format::migrate(&mut connection, version);
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

    pub fn set_trashed(
        &mut self,
        reference: &str,
        trashed: bool,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        write_scope::run(&self.connection, |scope| {
            // Putting a ticket in Trash and restoring it are the writes a ticket in Trash allows.
            let id = scope.even_if_trashed(reference)?;
            let old: bool =
                scope.query_row("SELECT trashed FROM tickets WHERE id = ?1", [&id], |row| {
                    row.get(0)
                })?;
            if old != trashed {
                scope.execute(
                    "UPDATE tickets SET trashed = ?1 WHERE id = ?2",
                    params![trashed, id],
                )?;
                history::record(
                    scope,
                    &id,
                    "trash",
                    if old { "trashed" } else { "active" },
                    if trashed { "trashed" } else { "active" },
                    agent,
                )?;
            }
            read_ticket(scope, reference)
        })
    }

    pub fn ticket_history(&self, reference: &str) -> Result<Vec<HistoryEntry>, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            history::read(&self.connection, &ticket.id)
        })
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
        write_scope::run(&self.connection, |tx| {
            let ticket = tx.editable(reference)?;
            let activity = activities::add(tx, &ticket, brief, agent)?;
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
                document_links::index_body(tx, &id, body)?;
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
            inbox::record(tx, &ticket, "activity", &activity.id, brief, agent)?;
            activities::get(tx, &ticket, &activity.id)
        })
    }
    pub fn edit_activity(
        &mut self,
        reference: &str,
        id: &str,
        patch: ActivityPatch,
    ) -> Result<Activity, Error> {
        write_scope::run(&self.connection, |scope| {
            let id_ticket = scope.editable(reference)?;
            activities::edit(scope, &id_ticket, id, patch)
        })
    }
    pub fn delete_activity(&mut self, reference: &str, id: &str) -> Result<(), Error> {
        write_scope::run(&self.connection, |scope| {
            let id_ticket = scope.editable(reference)?;
            scope.execute("INSERT INTO document_opens (document_id) SELECT id FROM documents WHERE originating_activity_id = ?1 AND kept = 0 ON CONFLICT(document_id) DO NOTHING", [id])?;
            activities::delete(scope, &id_ticket, id)
        })
    }
    /// Read the latest authored Activity without loading its history.
    pub fn latest_update(&self, reference: &str) -> Result<Option<LatestUpdate>, Error> {
        self.read(|_| {
            let id = relationships::id(&self.connection, reference)?;
            activities::latest(&self.connection, &id)
        })
    }

    /// The first update an agent wrote anywhere in this Workspace, if any.
    pub fn first_agent_update(&self) -> Result<Option<AgentUpdate>, Error> {
        self.read(|_| activities::first_by_agent(&self.connection))
    }

    pub fn activity_feed(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ActivityFeedEntry>, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            activities::feed(&self.connection, &ticket.id, limit, offset)
        })
    }

    pub fn activity(&self, reference: &str, id: &str) -> Result<Activity, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            activities::get(&self.connection, &ticket.id, id)
        })
    }

    pub fn activities(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Activity>, Error> {
        self.read(|_| {
            let ticket = self.show_ticket(reference)?;
            activities::read(&self.connection, &ticket.id, limit, offset)
        })
    }

    pub fn list_tickets(&self) -> Result<Vec<Ticket>, Error> {
        self.list_by_trash(false)
    }

    pub fn list_trash(&self) -> Result<Vec<Ticket>, Error> {
        self.list_by_trash(true)
    }

    fn list_by_trash(&self, trashed: bool) -> Result<Vec<Ticket>, Error> {
        read_scope::run(&self.connection, |connection| {
            let mut statement = connection.prepare_cached(&format!(
                "SELECT t.id, t.reference, t.title, t.status, t.body, t.project_id, t.plan_id, t.trashed, {}, t.number AS local_number FROM tickets t WHERE +t.trashed = ?1 ORDER BY t.number DESC",
                readiness::indicator_sql("t")
            ))?;
            let mut tickets = statement
                .query_map([trashed], listed_ticket_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            hydrate::hydrate(connection, &mut tickets)?;
            Ok(tickets)
        })
    }

    pub fn show_ticket(&self, reference: &str) -> Result<Ticket, Error> {
        read_scope::run(&self.connection, |connection| {
            read_ticket(connection, reference)
        })
    }
}

/// A ticket with everything shown about it. A write calls this at the end of its scope, so
/// the result is what the write left behind.
pub(crate) fn read_ticket(connection: &Connection, reference: &str) -> Result<Ticket, Error> {
    hydrate::one(connection, reference)
}

/// A ticket from a list query that selected `readiness::indicator_sql` as its ninth
/// column, followed by `local_number`: its availability needs no query of its own.
pub(crate) fn listed_ticket_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Ticket> {
    let mut ticket = ticket_from_row(row)?;
    ticket.availability = row.get(8)?;
    Ok(ticket)
}

fn ticket_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        id: row.get(0)?,
        local_number: Some(row.get("local_number")?),
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

mod batch;
pub use batch::BatchOperation;
mod ticket_change;
pub use ticket_change::TicketChange;

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

/// Where the default workspace file is, without opening or creating anything, so a
/// failure to open it can still name the file.
pub fn default_workspace_path() -> Result<std::path::PathBuf, Error> {
    default_path_unchecked()
}

fn default_path() -> Result<std::path::PathBuf, Error> {
    let path = default_path_unchecked()?;
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    Ok(path)
}

/// Name the file or folder a person supplied when it is missing, unreadable, not
/// writable or of the wrong kind. A full disk keeps the generic workspace wording,
/// so it is still reported as a full disk.
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
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => {
            Error::Directory(error)
        }
        _ => Error::Path(format!(
            "cannot access {role} {}: {}",
            shown.display(),
            io_reason(&error)
        )),
    }
}

/// The cause of an I/O error in plain words, without the operating system's code or
/// the path some libraries append.
fn io_reason(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        std::io::ErrorKind::ReadOnlyFilesystem => "the folder is read-only".into(),
        std::io::ErrorKind::IsADirectory => "it is a folder".into(),
        _ => {
            let text = error.to_string();
            let text = text.split(" (os error").next().unwrap_or(&text);
            text.split(" at path").next().unwrap_or(text).to_lowercase()
        }
    }
}
