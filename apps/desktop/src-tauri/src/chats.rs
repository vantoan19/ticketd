//! The desktop's Chat service: one `ChatHost` for the life of the app, the requests the
//! Chat screens make of it, and the feed each open Chat view follows.
//!
//! Requests are validated here and carried out by the core and the host; this module
//! decides nothing about dispatch. It has no Tauri dependency so it can be tested with
//! the fake adapter; `chat_commands` exposes it over the bridge.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ticketd_chat_host::{
    Activity, ChatHost, ChatLive, ChatProblem, ChatUpdate, ContextSource, Harness, HarnessAdapter,
    HostError, Inspection, InteractionAnswer, InteractionKind, LoginState, ProblemKind,
    QuestionAnswer, REGISTRATIONS, ResumeMode, SendMode, SettingKey, StartSettings, StopReason,
    Subscription, TurnEnding, UnconfirmedCleanup, WorkspaceOpener,
};
use ticketd_core::harnesses::ResumePolicy;
use ticketd_core::{
    BackupCheck, Chat, ChatAgentChange, ChatAttachmentContent, ChatCreationReplay, ChatDelivery,
    ChatInputStanding, ChatItem, ChatLink, ChatLinkKind, ChatListFilter, ChatMessage,
    ChatQueueEdit, ChatRecord, ChatRole, ChatStartPicks, ChatSubmissionIntent, ChatTurnState,
    MAX_BACKUP_FILE_BYTES, NewChat, Project, Workspace, WorkspaceGuard,
};
use tokio::sync::{oneshot, watch};

use crate::chat_reports::{self, HarnessOptionsView, SettingChangeView};
use crate::chat_view::HarnessFound;
use crate::chat_view::{
    self, ChatState, FreshHistory, Item, LinkedRecord, ProjectRef, Queued, Summary, Surroundings,
    Tracker, harness_name,
};
use crate::folder_probe;
use ticketd_chat_host::attention::Rank;
use ticketd_chat_host::conditions::{ChatProblemKind, HarnessState, HarnessWord};

/// History read to build a list row. A Chat's latest outcome is near its end.
const SUMMARY_ITEMS: usize = 50;
// ponytail: "the whole conversation" and lookups by message id read at most this many
// items; page through `chat_history` when a Chat outgrows it.
const HISTORY_ITEMS: usize = 10_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_LAST_MESSAGES: usize = 200;
const RESTORING_WORKSPACE: &str =
    "The workspace is being restored from a backup. Try again when it has finished.";

/// A refused request. `stale` means the request, turn or runtime it named is no longer
/// current; the message is shown to the person as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatFailure {
    pub code: &'static str,
    pub message: String,
}

fn failed(message: impl Into<String>) -> ChatFailure {
    ChatFailure {
        code: "failed",
        message: message.into(),
    }
}

fn stale(message: impl Into<String>) -> ChatFailure {
    ChatFailure {
        code: "stale",
        message: message.into(),
    }
}

impl From<ticketd_core::Error> for ChatFailure {
    fn from(error: ticketd_core::Error) -> Self {
        if matches!(error, ticketd_core::Error::ProjectArchived(_)) {
            return Self {
                code: error.kind().code(),
                message: error.to_string(),
            };
        }
        failed(error.to_string())
    }
}

impl From<HostError> for ChatFailure {
    fn from(error: HostError) -> Self {
        match error {
            HostError::InteractionExpired => stale(error.to_string()),
            HostError::Core(error) => error.into(),
            other => failed(other.to_string()),
        }
    }
}

type Outcome<T> = Result<T, ChatFailure>;

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    name: String,
    data_url: String,
}

#[derive(Serialize)]
pub struct QueuedDraft {
    text: String,
    attachments: Vec<AttachmentInput>,
}

/// Work nothing waits on, such as marking a Chat seen while a view opens: a failure
/// does not stop the caller, and it is written to the log rather than lost. The failure's
/// text is left out: it can carry the Harness's own words.
pub fn log_failure<T>(chat_id: Option<&str>, what: &str, result: Outcome<T>) {
    if let Err(failure) = result {
        tracing::warn!(
            chat_id,
            action = what,
            error_kind = failure.code,
            "a Chat action could not be done"
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Ticket,
    Document,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkRef {
    pub kind: LinkKind,
    pub id: String,
}

impl From<LinkRef> for ChatLink {
    fn from(link: LinkRef) -> Self {
        Self {
            kind: match link.kind {
                LinkKind::Ticket => ChatLinkKind::Ticket,
                LinkKind::Document => ChatLinkKind::Document,
                LinkKind::Project => ChatLinkKind::Project,
            },
            id: link.id,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEditSave {
    command_id: String,
    message_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct QueueEditStatus {
    saved: Vec<String>,
    removed: Vec<String>,
}

fn queue_edit_save_id(command_id: &str) -> Outcome<String> {
    let id = uuid::Uuid::parse_str(command_id)
        .map_err(|_| failed("the edit command id must be a UUID"))?;
    Ok(format!("{id}:queue-edit-save"))
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewChatInput {
    /// A UUID the interface makes once per New Chat attempt and repeats on a retry, so
    /// a retry finds the Chat and the message the first try saved.
    pub command_id: String,
    pub harness_id: String,
    /// `None` asks for a managed folder.
    pub folder: Option<String>,
    pub links: Vec<LinkRef>,
    pub message: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
    /// New Chat's picks: option ids the harness listed. Unset keeps its own setting.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permission: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Answer {
    Choice { option_id: String },
    Text { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UncertainDecision {
    Resend,
    Discard,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HistorySelection {
    None,
    LastResponse,
    LastMessages { count: usize },
    All,
    Picked { ids: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retention {
    Archive,
    Unarchive,
    Trash,
    Restore,
}

/// A Chat that was created. `send_error` says why its first message was not saved. The
/// Chat exists either way: the interface opens it with the unsent draft in its composer
/// and makes a new `command_id` for whatever New Chat is asked for next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Created {
    pub chat_id: String,
    pub send_error: Option<String>,
}

/// A restore that replaced the workspace. `warning` says what could not be confirmed
/// around it; the data is the backup's either way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Restored {
    /// The safety copy of the workspace as it was before.
    pub safety_path: String,
    pub warning: Option<String>,
}

/// What a restore reports. `restored` is the safety copy, or why nothing was replaced:
/// only that is a failure. An unconfirmed stop or a failed check of the restored Chats
/// happened around a restore that did take place, so they are warnings on a success.
fn restore_outcome(
    restored: Result<PathBuf, String>,
    reconciled: Outcome<()>,
    unconfirmed: usize,
) -> Result<Restored, String> {
    let safety = restored?;
    let unchecked = reconciled.err().map(|failure| {
        format!(
            "Its Chats could not be checked ({}); restart ticketd before using Chat.",
            failure.message
        )
    });
    let unstopped = (unconfirmed > 0).then(|| {
        format!(
            "Stopping {unconfirmed} Chat(s) could not be confirmed; a harness process may still be running."
        )
    });
    let warnings: Vec<String> = unchecked.into_iter().chain(unstopped).collect();
    Ok(Restored {
        safety_path: safety.display().to_string(),
        warning: Some(warnings.join(" ")).filter(|warning| !warning.is_empty()),
    })
}

/// Why `backup` cannot replace the workspace, in the words the restore review uses.
/// `Ok` also when the workspace cannot be opened to inspect it: a restore is how a
/// damaged workspace is replaced, and the restore checks the backup itself.
fn restorable(open: &WorkspaceOpener, backup: &Path) -> Result<(), String> {
    if !backup.is_file() {
        return Err("That backup file wasn't found.".to_owned());
    }
    let Ok(inspection) = open().and_then(|workspace| workspace.inspect_backup(backup)) else {
        return Ok(());
    };
    match refusal(inspection.check) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

/// Why a backup that was inspected cannot be restored, or `None` when it can.
fn refusal(check: BackupCheck) -> Option<String> {
    Some(match check {
        BackupCheck::Valid { .. } => return None,
        BackupCheck::NewerFormat {
            backup_version,
            supported_version,
        } => format!(
            "This backup can't be restored by this version. It was saved by a newer ticketd (workspace format {backup_version}; this app reads up to {supported_version})."
        ),
        BackupCheck::NotTicketd => "This isn't a ticketd backup.".to_owned(),
        // What is missing is tables, columns, triggers and unique indexes alike.
        BackupCheck::MissingTables { tables } => {
            format!(
                "This backup is incomplete. It is missing: {}.",
                tables.join(", ")
            )
        }
        BackupCheck::CurrentWorkspace => "This is the current workspace.".to_owned(),
        BackupCheck::Damaged { reason } => {
            format!("This backup is damaged. It failed ticketd's checks: {reason}.")
        }
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Overview {
    /// Chats waiting for the person (a request, uncertain delivery, an unseen failure),
    /// muted ones included: the sidebar count.
    pub needs_you: usize,
    /// Chats with an unseen outcome that does not wait for the person.
    pub unread: usize,
    /// Waiting Chats that are not muted: the app-icon count.
    pub app_icon: usize,
    pub working: usize,
}

/// What turning Chat off, quitting or closing would stop: Chats with work in progress
/// or a request waiting, and runs that are going. A run's own Chat is counted as its
/// run, not as a Chat, since it is not in the Chat list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Stopping {
    pub chats: usize,
    pub runs: usize,
}

impl Stopping {
    pub fn any(self) -> bool {
        self.chats + self.runs > 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessStatus {
    pub mark_id: &'static str,
    pub id: &'static str,
    pub name: &'static str,
    pub status: HarnessState,
    /// Chats can be started on it.
    pub usable: bool,
    /// What New Chat and the header say beside it when it is not ready.
    pub word: Option<HarnessWord>,
    /// What New Chat's notice tells when it is not ready.
    pub problem: Option<chat_view::Problem>,
    pub message: Option<String>,
    pub command: Option<String>,
    pub help_url: Option<String>,
    /// The executable that was found.
    pub path: Option<String>,
    /// The version number it reported ("2.1.322"), when it was found and said one.
    pub version: Option<String>,
}

#[derive(Serialize)]
pub struct HarnessInfo {
    id: &'static str,
    name: &'static str,
    mark_id: &'static str,
    editing_agent_aliases: &'static [&'static str],
    unattended: Option<ticketd_core::harnesses::UnattendedCapabilities>,
    permissions: &'static [ticketd_core::harnesses::PermissionChoice],
}

impl From<Harness> for HarnessInfo {
    fn from(descriptor: Harness) -> Self {
        use ticketd_core::harnesses::UnattendedSupport;
        let unattended = match descriptor.unattended {
            UnattendedSupport::Supported(reach) => Some(reach),
            UnattendedSupport::Unsupported { .. } => None,
        };
        Self {
            id: descriptor.key.as_str(),
            name: descriptor.name,
            mark_id: descriptor.mark_id,
            editing_agent_aliases: descriptor.editing_agent_aliases,
            unattended,
            permissions: descriptor.permissions,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub chat: ChatState,
    pub items: Vec<Item>,
    /// Changes on the view's feed are numbered from here, one apart.
    pub cursor: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Opened {
    /// Names the feed, to close it.
    pub subscription: u64,
    pub snapshot: Snapshot,
}

/// Takes one change for the view; false once the view is gone.
pub type Sink = Arc<dyn Fn(Value) -> bool + Send + Sync>;

fn text_argument(text: &str, what: &str) -> Outcome<()> {
    if text.trim().is_empty() {
        return Err(failed(format!("{what} must not be empty")));
    }
    text_byte_limit(text, what)
}

fn text_byte_limit(text: &str, what: &str) -> Outcome<()> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(failed(format!("{what} is too long")));
    }
    Ok(())
}

/// An absolute path to a folder that exists.
fn folder_argument(path: &str) -> Outcome<String> {
    let folder = Path::new(path);
    if !folder.is_absolute() {
        return Err(failed("the folder must be a full path"));
    }
    if !folder.is_dir() {
        return Err(failed(format!("'{path}' is not a folder that exists")));
    }
    Ok(path.to_owned())
}

fn managed_chat_folders(workspace: &Workspace) -> Outcome<PathBuf> {
    Ok(PathBuf::from(format!(
        "{}.chats",
        workspace.workspace_info()?.path
    )))
}

/// The number in a harness's version output ("codex-cli 0.150.0", "2.1.322 (Claude Code)"),
/// which names the tool itself; the whole text when no number is found.
fn version_number(output: &str) -> &str {
    output
        .split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or(output)
}

fn harness_status(descriptor: Harness, inspection: Inspection) -> HarnessStatus {
    let id = descriptor.key.as_str();
    let name = descriptor.name;
    let found = |executable: &PathBuf, version: &Option<String>| {
        format!(
            "{name} {} at {}",
            version.as_deref().unwrap_or("(unknown version)"),
            executable.display()
        )
    };
    let sign_in = Some(descriptor.sign_in_command.to_owned());
    let (status, message, command) = match &inspection {
        Inspection::Installed {
            executable,
            version,
            login,
            ..
        } => match login {
            LoginState::SignedIn => (HarnessState::Ready, found(executable, version), None),
            // Usable, but never shown as plain ready: the person sees how it bills
            // before the first message goes out.
            LoginState::NonSubscription => (
                HarnessState::NotSubscription,
                format!(
                    "{}. It is signed in with an API key or cloud provider, not a subscription; {name} bills usage there.",
                    found(executable, version)
                ),
                sign_in,
            ),
            LoginState::SignedOut => (
                HarnessState::NotSignedIn,
                found(executable, version),
                sign_in,
            ),
            // Not every harness can be asked; it says so itself when a Chat starts.
            LoginState::Unknown => (
                HarnessState::SignInUnknown,
                format!(
                    "{}. ticketd cannot check whether it is signed in; {name} reports that when a Chat starts.",
                    found(executable, version)
                ),
                sign_in,
            ),
        },
        Inspection::Incompatible {
            executable,
            version,
            requirement,
        } => (
            HarnessState::Incompatible,
            format!(
                "Found {name} {} at `{}`. ticketd needs {requirement}.",
                version
                    .as_deref()
                    .map_or("(unknown version)", version_number),
                executable.display()
            ),
            None,
        ),
        Inspection::NotInstalled => (
            HarnessState::NotInstalled,
            format!("{name} was not found"),
            sign_in,
        ),
        Inspection::ProbeFailed { reason } => (HarnessState::Unknown, reason.clone(), None),
    };
    let found = HarnessFound {
        message: Some(message),
        command,
        // Shown where the person has something to install or update.
        help_url: matches!(
            status,
            HarnessState::NotInstalled | HarnessState::Incompatible
        )
        .then(|| descriptor.help_url.to_owned()),
        path: match &inspection {
            Inspection::Installed { executable, .. }
            | Inspection::Incompatible { executable, .. } => Some(executable.display().to_string()),
            Inspection::NotInstalled | Inspection::ProbeFailed { .. } => None,
        },
    };
    HarnessStatus {
        mark_id: descriptor.mark_id,
        id,
        name,
        status,
        usable: status.usable(),
        word: status.word(),
        problem: status
            .problem_kind()
            .map(|kind| chat_view::Problem::for_harness(name, kind, &found)),
        message: found.message,
        command: found.command,
        help_url: found.help_url,
        path: found.path,
        version: match &inspection {
            Inspection::Installed { version, .. } | Inspection::Incompatible { version, .. } => {
                version
                    .as_deref()
                    .map(|text| version_number(text).to_owned())
            }
            Inspection::NotInstalled | Inspection::ProbeFailed { .. } => None,
        },
    }
}

/// A ticket status as the interface names it.
fn status_name(status: impl Serialize) -> Result<String, ticketd_core::Error> {
    Ok(match serde_json::to_value(status)? {
        Value::String(name) => name,
        other => other.to_string(),
    })
}

/// Says, for each change a receipt names, whether its record is now in the trash or
/// gone, so the row names it instead of linking it. Other items pass unchanged.
fn with_gone(workspace: &Workspace, item: Item) -> Item {
    let Item::Records {
        id,
        at,
        changes,
        net,
        turn_id,
        ..
    } = item
    else {
        return item;
    };
    let gone_of = |changes: &[ChatAgentChange]| {
        changes
            .iter()
            .map(|change| {
                let trashed = match change {
                    ChatAgentChange::Status { reference, .. }
                    | ChatAgentChange::Update { reference, .. } => workspace
                        .show_ticket(reference)
                        .map(|ticket| ticket.trashed),
                };
                match trashed {
                    Ok(true) => Some("trashed"),
                    Ok(false) => None,
                    Err(ticketd_core::Error::NotFound(_)) => Some("deleted"),
                    // Not readable now: shown as it was, linked.
                    Err(_) => None,
                }
            })
            .collect()
    };
    Item::Records {
        id,
        at,
        gone: gone_of(&changes),
        net_gone: gone_of(&net),
        changes,
        net,
        turn_id,
    }
}

fn project_title(project: &Project) -> String {
    if project.archived {
        format!("{} (archived)", project.name)
    } else {
        project.name.clone()
    }
}

fn links(workspace: &Workspace, chat_id: &str) -> Result<Vec<LinkedRecord>, ticketd_core::Error> {
    let mut links = Vec::new();
    for record in workspace.chat_linked_records(chat_id)? {
        links.push(match (record.kind, record.reference) {
            (ChatLinkKind::Ticket, Some(reference)) => LinkedRecord::Ticket {
                status: status_name(workspace.show_ticket(&reference)?.status)?,
                id: record.id,
                reference,
                title: record.title,
            },
            // A ticket always has a reference; without one there is nothing to open.
            (ChatLinkKind::Ticket, None) => continue,
            (ChatLinkKind::Document, _) => LinkedRecord::Document {
                id: record.id,
                title: record.title,
            },
            (ChatLinkKind::Project, _) => {
                let project = workspace.show_project(&record.id)?;
                LinkedRecord::Project {
                    id: record.id,
                    title: project_title(&project),
                    archived: project.archived,
                }
            }
        });
    }
    Ok(links)
}

/// A file or folder offered by the composer's `@` menu, relative to the Chat's folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderFile {
    /// With `/` separators on every platform, as the composer inserts it.
    pub path: String,
    pub folder: bool,
}

/// Folders a mention never needs: version control, dependencies and build output.
const SKIPPED_FOLDERS: [&str; 6] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    "vendor",
];
/// Bounds one search, so a home folder answers as quickly as a repository.
const FILES_VISITED: usize = 20_000;
const FILES_FOUND: usize = 20;

/// Files and folders under `root` whose path contains `query` (case-insensitive),
/// shallowest first, then by path. Hidden entries and `SKIPPED_FOLDERS` are left out.
pub fn folder_files(root: &Path, query: &str) -> Vec<FolderFile> {
    let needle = query.trim().to_lowercase();
    let mut found = Vec::new();
    let mut visited = 0;
    let mut level = vec![PathBuf::new()];
    while !level.is_empty() && visited < FILES_VISITED {
        let mut next = Vec::new();
        let mut matches = Vec::new();
        for relative in level {
            let Ok(entries) = std::fs::read_dir(root.join(&relative)) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                let name = entry.file_name().to_string_lossy().into_owned();
                let folder = entry.file_type().is_ok_and(|kind| kind.is_dir());
                if name.starts_with('.') || (folder && SKIPPED_FOLDERS.contains(&name.as_str())) {
                    continue;
                }
                let path = relative.join(&name);
                let shown = path
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                if shown.to_lowercase().contains(&needle) {
                    matches.push(FolderFile {
                        path: shown,
                        folder,
                    });
                }
                if folder {
                    next.push(path);
                }
            }
        }
        matches.sort_by(|a, b| a.path.cmp(&b.path));
        found.extend(matches);
        if found.len() >= FILES_FOUND {
            break;
        }
        next.sort();
        level = next;
    }
    found.truncate(FILES_FOUND);
    found
}

/// Every Chat outside the trash, read once per request for what Chats share.
fn folder_users(workspace: &Workspace) -> Result<Vec<Chat>, ticketd_core::Error> {
    let mut chats = workspace.list_chats(ChatListFilter::Active)?;
    chats.extend(workspace.list_chats(ChatListFilter::Archived)?);
    Ok(chats)
}

fn surroundings(
    workspace: &Workspace,
    chat: &Chat,
    folder_users: &[Chat],
    checked_turn: Option<String>,
    live: &ChatLive,
    missing_folders: &Mutex<HashSet<String>>,
) -> Result<Surroundings, ticketd_core::Error> {
    let folder_missing = !Path::new(&chat.execution_folder).is_dir();
    note_folder(missing_folders, &chat.id, folder_missing);
    let shared_with = folder_users
        .iter()
        .filter(|other| other.id != chat.id && other.execution_folder == chat.execution_folder)
        .map(|other| chat_view::SharedChat {
            id: other.id.clone(),
            title: other.title.clone().unwrap_or("Untitled Chat".to_owned()),
            retention: chat_view::retention(other),
        })
        .collect();
    let links = links(workspace, &chat.id)?;
    let first_line = if chat_view::title_may_be_cut(chat) {
        workspace
            .chat_first_input_text(&chat.id)?
            .and_then(|text| chat_view::first_line_of(&text))
    } else {
        None
    };
    let trashed_links = workspace
        .chat_linked_records(&chat.id)?
        .into_iter()
        .filter(|record| record.trashed)
        .map(|record| record.id)
        .collect();
    Ok(Surroundings {
        trashed_links,
        checked_turn,
        folder_missing,
        shared_with,
        first_line,
        project: chat_project(chat, &workspace.list_projects()?),
        branch: None,
        links,
        // Input the host holds to send is being sent, not in the person's queue.
        queue: workspace
            .chat_queue(&chat.id)?
            .into_iter()
            .filter(|message| {
                message.standing_while(live.sending.contains(&message.id))
                    == ChatInputStanding::Queued
            })
            .map(|message| Queued {
                refused_steer: message
                    .attempts
                    .last()
                    .filter(|attempt| {
                        attempt.intent == ChatSubmissionIntent::Steer
                            && matches!(
                                attempt.delivery,
                                ChatDelivery::Rejected | ChatDelivery::NotDelivered
                            )
                    })
                    .map(|attempt| {
                        attempt
                            .detail
                            .clone()
                            .unwrap_or("the harness did not take it".to_owned())
                    }),
                id: message.id,
                text: message.text,
                editing: message.editing,
                attachments: message.attachments,
            })
            .collect(),
    })
}

/// The Project whose folder (any checkout) holds `folder`, else the first linked one.
fn chat_project(chat: &Chat, projects: &[Project]) -> Option<ProjectRef> {
    Project::for_folder(projects, Path::new(&chat.execution_folder))
        .or_else(|| {
            chat.links
                .iter()
                .filter(|link| link.kind == ChatLinkKind::Project)
                .find_map(|link| projects.iter().find(|project| project.id == link.id))
        })
        .map(|project| ProjectRef {
            id: project.id.clone(),
            title: project_title(project),
        })
}

fn refresh_project_surroundings(around: &mut Surroundings, chat: &Chat, projects: &[Project]) {
    around.project = chat_project(chat, projects);
    for link in &mut around.links {
        if let LinkedRecord::Project {
            id,
            title,
            archived,
        } = link
            && let Some(project) = projects.iter().find(|project| project.id == *id)
        {
            *title = project_title(project);
            *archived = project.archived;
        }
    }
}

/// Remembers whether a Chat was last shown with its folder missing; returns whether
/// that changed.
fn note_folder(missing_folders: &Mutex<HashSet<String>>, chat_id: &str, missing: bool) -> bool {
    let mut missing_folders = lock(missing_folders);
    if missing {
        missing_folders.insert(chat_id.to_owned())
    } else {
        missing_folders.remove(chat_id)
    }
}

/// A stored time's date as "Nov 13, 2026". Stored times are UTC, so near midnight it
/// can be the neighbouring day.
fn shown_date(at: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mut parts = at.get(..10).unwrap_or_default().split('-');
    let (Some(year), Some(month), Some(day)) = (parts.next(), parts.next(), parts.next()) else {
        return at.to_owned();
    };
    let month = month
        .parse::<usize>()
        .ok()
        .and_then(|month| MONTHS.get(month.checked_sub(1)?));
    match (month, day.parse::<u32>()) {
        (Some(month), Ok(day)) => format!("{month} {day}, {year}"),
        _ => at.to_owned(),
    }
}

fn messages(workspace: &Workspace, chat_id: &str) -> Result<Vec<ChatMessage>, ticketd_core::Error> {
    let snapshot = workspace.chat_snapshot(chat_id, HISTORY_ITEMS)?;
    Ok(snapshot
        .items
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Message(message) => Some(message),
            _ => None,
        })
        .collect())
}

/// One open view's feed, so it can be closed or told to read a new snapshot.
struct Feed {
    chat_id: String,
    /// Dropped to end the feed.
    _end: oneshot::Sender<()>,
}

/// What a view's feed remembers between updates.
struct View {
    chat: Chat,
    live: ChatLive,
    tracker: Tracker,
    state: ChatState,
    sequence: u64,
    /// The item last sent under each id, so an unchanged one is not sent again.
    sent: HashMap<String, Value>,
    /// What the workspace said around the Chat, until the Chat's own records or
    /// state move; `None` reads it again.
    around: Option<Surroundings>,
}

/// The overview's rows as last built, kept between wakes.
#[derive(Default)]
struct BuiltRows {
    /// The change sequence they were built at.
    sequence: i64,
    projects: Arc<Vec<Project>>,
    rows: HashMap<String, BuiltRow>,
}

/// One Chat's row, with the live state and check it was built with.
struct BuiltRow {
    live: ChatLive,
    checked: Option<String>,
    summary: Summary,
}

#[derive(Default)]
struct RestoreState {
    replacing: bool,
    generation: u64,
}

pub struct Chats {
    open_workspace: WorkspaceOpener,
    adapters: Vec<Arc<dyn HarnessAdapter>>,
    /// Why a harness has no adapter in this run, by harness id.
    unavailable: Vec<(&'static str, String)>,
    context: Option<ContextSource>,
    /// The Experimental switch. The interface keeps the person's choice and tells the
    /// backend at startup; until then Chat is off and nothing can run.
    enabled: AtomicBool,
    /// Serializes the start of replacement with admission and the New Chat save.
    restore_state: Mutex<RestoreState>,
    restore_owner: tokio::sync::Mutex<()>,
    host: Mutex<Option<ChatHost>>,
    /// Per Chat, the failed turn after which "Check again" found the harness usable.
    // ponytail: kept for this run of ticketd only; after a restart the last turn's
    // failure is told again, as past. Store it if that proves annoying.
    checked: Mutex<HashMap<String, String>>,
    feeds: Mutex<HashMap<u64, Feed>>,
    next_feed: AtomicU64,
    fresh: Mutex<HashMap<String, FreshHistory>>,
    /// Chats last shown with their folder missing, so a check can tell what changed.
    missing_folders: Mutex<HashSet<String>>,
    /// The main window has focus: an open Chat is in view only while it does.
    focused: AtomicBool,
    /// Settings > Chat > Notify me about Chats. The interface keeps the choice.
    notify: AtomicBool,
    /// What each harness offered when last asked, with the version it was asked at:
    /// probing starts a harness process, so it is repeated only for a new version.
    options: Mutex<HashMap<&'static str, (Option<String>, HarnessOptionsView)>>,
    /// The version each harness reported at its last check.
    versions: Mutex<HashMap<&'static str, Option<String>>>,
    built_rows: Mutex<BuiltRows>,
    projects: watch::Sender<Arc<Vec<Project>>>,
    /// How often this service borrowed the workspace, for tests that bound it.
    #[cfg(test)]
    workspace_uses: AtomicU64,
    /// How many list rows were built from history.
    #[cfg(test)]
    rows_built: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct RestoreAdmission<'a>(&'a Chats);

impl Drop for RestoreAdmission<'_> {
    fn drop(&mut self) {
        let mut restore = lock(&self.0.restore_state);
        if let Some(host) = self.0.started_host() {
            host.finish_restore();
        }
        restore.replacing = false;
    }
}

impl Chats {
    pub fn new(
        open_workspace: WorkspaceOpener,
        adapters: Vec<Arc<dyn HarnessAdapter>>,
        unavailable: Vec<(&'static str, String)>,
        context: Option<ContextSource>,
    ) -> Arc<Self> {
        Arc::new(Self {
            open_workspace,
            adapters,
            unavailable,
            context,
            enabled: AtomicBool::new(false),
            restore_state: Mutex::default(),
            restore_owner: tokio::sync::Mutex::new(()),
            host: Mutex::new(None),
            checked: Mutex::new(HashMap::new()),
            feeds: Mutex::new(HashMap::new()),
            next_feed: AtomicU64::new(1),
            fresh: Mutex::new(HashMap::new()),
            missing_folders: Mutex::new(HashSet::new()),
            focused: AtomicBool::new(true),
            notify: AtomicBool::new(true),
            options: Mutex::new(HashMap::new()),
            versions: Mutex::new(HashMap::new()),
            built_rows: Mutex::default(),
            projects: watch::channel(Arc::new(Vec::new())).0,
            #[cfg(test)]
            workspace_uses: AtomicU64::new(0),
            #[cfg(test)]
            rows_built: AtomicU64::new(0),
        })
    }

    /// Why Chats cannot run on this harness here. One harness being unavailable never
    /// stops the others.
    fn unavailable(&self, harness: &str) -> String {
        let reason = self.unavailable.iter().find(|(id, _)| *id == harness);
        reason.map_or_else(
            || {
                format!(
                    "{} is not available in this build of ticketd.",
                    harness_name(harness)
                )
            },
            |(_, reason)| reason.clone(),
        )
    }

    fn workspace(&self) -> Outcome<WorkspaceGuard> {
        #[cfg(test)]
        self.workspace_uses.fetch_add(1, Ordering::SeqCst);
        Ok((self.open_workspace)()?)
    }

    /// The one host of this process, started the first time Chat is used while it is on.
    /// Must be called inside the async runtime: the host starts its tasks on it.
    fn host(&self) -> Outcome<ChatHost> {
        if !self.enabled() {
            return Err(failed("Chat is turned off in Settings > Experimental."));
        }
        self.started_or_start().map_err(|error| match error {
            HostError::Restoring => failed(RESTORING_WORKSPACE),
            error => error.into(),
        })
    }

    /// The one host, started if it has not been yet.
    fn started_or_start(&self) -> Result<ChatHost, HostError> {
        let restore = lock(&self.restore_state);
        if restore.replacing {
            return Err(HostError::Restoring);
        }
        let mut host = lock(&self.host);
        if let Some(host) = host.as_ref() {
            return Ok(host.clone());
        }
        let started = ChatHost::with_context(
            self.open_workspace.clone(),
            self.adapters.clone(),
            self.context.clone(),
        )?;
        *host = Some(started.clone());
        Ok(started)
    }

    /// The host for Automation runs, or why nothing may run: Chat is off
    /// (`HostError::TurnedOff`), a backup is being restored (`HostError::Restoring`), or
    /// the host could not start. A run whose agent cannot start says which.
    pub fn automation_host(&self) -> Result<ChatHost, HostError> {
        if !self.enabled() {
            return Err(HostError::TurnedOff);
        }
        self.started_or_start()
    }

    /// Starts the host if Chat is on, so its change signal can be watched.
    pub fn start(&self) -> Outcome<()> {
        self.host().map(|_| ())
    }

    /// Hold through a New Chat's write, so a restore cannot start across the check.
    fn new_chat_save_fence(&self, generation: u64) -> Outcome<MutexGuard<'_, RestoreState>> {
        let restore = lock(&self.restore_state);
        if restore.generation != generation {
            return Err(stale(
                "The workspace changed while preparing this Chat. Try again.",
            ));
        }
        if restore.replacing {
            return Err(failed(RESTORING_WORKSPACE));
        }
        Ok(restore)
    }

    /// Moves whenever any Chat record was written or live state changed; cheap to read.
    pub fn digest(&self) -> Option<(i64, Vec<(String, ChatLive)>)> {
        let host = self.started_host()?;
        let sequence = self.workspace().ok()?.chat_change_sequence().ok()?;
        let mut live: Vec<_> = host.live().into_iter().collect();
        live.sort_by(|a, b| a.0.cmp(&b.0));
        Some((sequence, live))
    }

    fn started_host(&self) -> Option<ChatHost> {
        lock(&self.host).clone()
    }

    fn live(&self, chat_id: &str) -> ChatLive {
        self.started_host()
            .and_then(|host| host.live().remove(chat_id))
            .unwrap_or_else(ChatLive::idle)
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Turning Chat off stops every running Chat first; the interface has already asked.
    /// Returns the Chats whose harness could not be confirmed stopped.
    pub async fn set_enabled(&self, enabled: bool) -> Vec<UnconfirmedCleanup> {
        self.enabled.store(enabled, Ordering::SeqCst);
        match self.started_host() {
            // The host refuses on every clone of it, including one a command took
            // while Chat was still on.
            Some(host) if !enabled => host.turn_off().await,
            Some(host) => {
                host.turn_on();
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    /// Chats with work in progress or a request waiting, which Quit or closing would affect.
    pub fn working(&self) -> usize {
        let live = self.started_host().map(|host| host.live());
        live.into_iter()
            .flat_map(HashMap::into_values)
            .filter(|live| live.activity != Activity::Idle)
            .count()
    }

    /// What turning Chat off or quitting would stop now. With Chat off nothing runs.
    /// Runs are read from the Workspace, so one between agents counts too; when it
    /// cannot be read, every live Chat counts as a Chat rather than nothing at all.
    pub fn stopping(&self) -> Stopping {
        if !self.enabled() {
            return Stopping::default();
        }
        let mut live = self
            .started_host()
            .map(|host| host.live())
            .unwrap_or_default();
        live.retain(|_, live| live.activity != Activity::Idle);
        let going = self
            .workspace()
            .ok()
            .and_then(|workspace| workspace.running_automation_runs().ok())
            .unwrap_or_default();
        for chat_id in &going.chat_ids {
            live.remove(chat_id);
        }
        Stopping {
            chats: live.len(),
            runs: going.runs,
        }
    }

    /// Whether any Automation is on for this device. One that is keeps ticketd in the
    /// tray when the window closes, since Automations run only in this process.
    pub fn automations_on(&self) -> bool {
        self.workspace()
            .is_ok_and(|workspace| workspace.any_automation_on().unwrap_or(false))
    }

    /// Stops running Chats and refuses requests from existing clones of the host.
    async fn stop_for_restore(&self) -> Result<Vec<UnconfirmedCleanup>, UnconfirmedCleanup> {
        match self.started_host() {
            Some(host) => host.begin_restore().await,
            None => Ok(Vec::new()),
        }
    }

    /// Reconcile work with no runtime behind it. The installed queues were paused
    /// in the staged database before replacement.
    fn reconcile_restored_workspace(&self) -> Outcome<()> {
        let reconciled = self.workspace().and_then(|mut workspace| {
            let restored = TurnEnding::StoppedByTicketd(StopReason::Restore);
            workspace.mark_chat_contact_lost(
                None,
                &restored.detail().unwrap_or_default(),
                &restored.key(),
            )?;
            Ok(())
        });
        // Views read a new snapshot: their cursors belong to the replaced records.
        lock(&self.feeds).clear();
        lock(&self.checked).clear();
        *lock(&self.built_rows) = BuiltRows::default();
        reconciled
    }

    /// Replaces the workspace with a backup through `replace`, which returns the safety
    /// copy. The backup is checked first, so one that cannot be restored stops nothing;
    /// then running Chats are stopped and nothing restored is run.
    pub async fn restore(
        self: &Arc<Self>,
        backup: PathBuf,
        replace: impl FnOnce(PathBuf) -> Result<PathBuf, String> + Send + 'static,
    ) -> Result<Restored, String> {
        let chats = self.clone();
        // A cancelled caller cannot abandon a replacement already running on a blocking thread.
        tokio::spawn(async move {
            let _owner = chats.restore_owner.try_lock().map_err(|_| {
                "A workspace restore is already in progress. Try again when it has finished."
                    .to_owned()
            })?;
            let open = chats.open_workspace.clone();
            let checked = backup.clone();
            let check = tokio::task::spawn_blocking(move || restorable(&open, &checked)).await;
            // If the check did not run, replacement still checks the backup.
            if let Ok(result) = check {
                result?;
            }
            lock(&chats.restore_state).replacing = true;
            let _admission = RestoreAdmission(&chats);
            let unconfirmed = chats.stop_for_restore().await.map_err(|blocked| {
                format!(
                    "The workspace could not be restored because {}.",
                    blocked.reason,
                )
            })?;
            lock(&chats.restore_state).generation += 1;
            let restored = tokio::task::spawn_blocking(move || replace(backup))
                .await
                .map_err(|error| error.to_string())
                .and_then(|restored| restored);
            let reconciled = chats.reconcile_restored_workspace();
            restore_outcome(restored, reconciled, unconfirmed.len())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// Stops app-owned execution with bounded cleanup. The host accepts nothing afterwards.
    pub async fn quit(&self) -> Vec<UnconfirmedCleanup> {
        match self.started_host() {
            Some(host) => host.quit().await,
            None => Vec::new(),
        }
    }

    #[cfg(windows)]
    pub fn cancel_quit(&self) {
        if let Some(host) = self.started_host() {
            host.cancel_quit();
        }
    }

    /// Refreshes only Project data on a Workspace wake. Open Chat views follow this separately.
    pub fn refresh_projects(&self) -> Outcome<bool> {
        let projects = self.workspace()?.list_projects()?;
        Ok(self.projects.send_if_modified(|previous| {
            if **previous == projects {
                return false;
            }
            *previous = Arc::new(projects);
            true
        }))
    }

    /// Moves when any Chat may have changed; `None` until the host has started.
    pub fn changed(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        self.started_host().map(|host| host.changed())
    }

    /// "active", "archived" or "trashed", to open the Chat under the right list.
    pub fn chat_retention(&self, chat_id: &str) -> Outcome<&'static str> {
        let chat = self.workspace()?.chat(chat_id)?;
        Ok(if chat.trashed {
            "trashed"
        } else if chat.archived {
            "archived"
        } else {
            "active"
        })
    }

    /// Chats open in a view while the window has focus. A visible list row is not a view.
    pub fn in_view(&self) -> HashSet<String> {
        if !self.focused.load(Ordering::SeqCst) {
            return HashSet::new();
        }
        lock(&self.feeds)
            .values()
            .map(|feed| feed.chat_id.clone())
            .collect()
    }

    /// The window gained or lost focus. Regaining it marks the open Chats seen and
    /// reads them again, so a branch switched outside ticketd shows.
    pub async fn set_focused(&self, focused: bool) {
        self.focused.store(focused, Ordering::SeqCst);
        if focused {
            for chat_id in self.in_view() {
                log_failure(
                    Some(&chat_id),
                    "mark the Chat seen",
                    self.mark_seen(&chat_id).await,
                );
                log_failure(
                    Some(&chat_id),
                    "read the Chat again",
                    self.reread(&chat_id).await,
                );
            }
        }
    }

    /// Tells the Chat's views to read its state again.
    async fn reread(&self, chat_id: &str) -> Outcome<()> {
        Ok(self.host()?.notify_changed(chat_id).await?)
    }

    pub fn notifies(&self) -> bool {
        self.notify.load(Ordering::SeqCst)
    }

    pub fn set_notify(&self, notify: bool) {
        self.notify.store(notify, Ordering::SeqCst);
    }

    /// The person saw the Chat's outcome. Rows and counts follow when that changed.
    async fn mark_seen(&self, chat_id: &str) -> Outcome<()> {
        let host = self.host()?;
        let mut workspace = self.workspace()?;
        let seen = |chat: &Chat| (chat.seen_through, chat.marked_unread);
        let before = seen(&workspace.chat(chat_id)?);
        if seen(&workspace.mark_chat_seen(chat_id)?) != before {
            drop(workspace);
            host.notify_changed(chat_id).await?;
        }
        Ok(())
    }

    /// Mark as read: clears an unseen outcome, never a live request.
    pub async fn mark_read(&self, chat_id: &str) -> Outcome<()> {
        self.mark_seen(chat_id).await
    }

    /// Mark as unread: the last turn reads as unseen until the Chat is next opened.
    pub async fn mark_unread(&self, chat_id: &str) -> Outcome<()> {
        let host = self.host()?;
        self.workspace()?.mark_chat_unread(chat_id)?;
        Ok(host.notify_changed(chat_id).await?)
    }

    /// The person had the transcript in view through `item_id`, a transcript item. It
    /// is kept with the Chat so the New marker is placed after it the next time the
    /// Chat opens, also after ticketd restarts. Nothing is announced.
    pub fn read_through(&self, chat_id: &str, item_id: &str) -> Outcome<()> {
        // A turn's timing item is named after its turn.
        let record = item_id.strip_prefix("turn:").unwrap_or(item_id);
        self.workspace()?.mark_chat_read_through(chat_id, record)?;
        Ok(())
    }

    pub async fn set_muted(&self, chat_id: &str, muted: bool) -> Outcome<()> {
        let host = self.host()?;
        self.workspace()?.set_chat_muted(chat_id, muted)?;
        Ok(host.notify_changed(chat_id).await?)
    }

    fn summaries(&self, filter: ChatListFilter) -> Outcome<Vec<Summary>> {
        let workspace = self.workspace()?;
        let live = self.started_host().map(|host| host.live());
        // ponytail: one bounded history read per Chat; add a core summary query when a
        // workspace holds enough Chats for the list to feel slow.
        let folder_users = folder_users(&workspace)?;
        let mut summaries = Vec::new();
        for chat in workspace.list_chats(filter)? {
            let live = live
                .as_ref()
                .and_then(|live| live.get(&chat.id).cloned())
                .unwrap_or_else(ChatLive::idle);
            summaries.push(self.summary(&workspace, &chat, &folder_users, &live)?);
        }
        Ok(summaries)
    }

    /// One Chat's list row, read from its latest history.
    fn summary(
        &self,
        workspace: &Workspace,
        chat: &Chat,
        folder_users: &[Chat],
        live: &ChatLive,
    ) -> Outcome<Summary> {
        #[cfg(test)]
        self.rows_built.fetch_add(1, Ordering::SeqCst);
        let items = workspace.chat_snapshot(&chat.id, SUMMARY_ITEMS)?.items;
        let mut tracker = Tracker::from_items(&items);
        // A long turn's own record can lie outside the window; the row still says it.
        if let Some(turn) = workspace.chat_latest_turn(&chat.id)? {
            tracker.note(&ChatItem::Turn(turn));
        }
        Ok(chat_view::summary(
            chat,
            live,
            &tracker,
            &surroundings(
                workspace,
                chat,
                folder_users,
                self.checked(&chat.id),
                live,
                &self.missing_folders,
            )?,
        ))
    }

    /// The counts, the rows outside the trash, and the trashed rows. Only the Chats
    /// written since the last call, or whose live state moved, are read again; the
    /// others keep the row built before. A list row may lag a change outside its Chat,
    /// such as a linked ticket's status, until its Chat next changes.
    pub fn overview_digest(&self) -> Outcome<(Overview, Vec<Summary>, Vec<Summary>)> {
        let workspace = self.workspace()?;
        let live = self
            .started_host()
            .map(|host| host.live())
            .unwrap_or_default();
        let mut built = lock(&self.built_rows);
        let projects = self.projects.borrow().clone();
        let projects_changed = !Arc::ptr_eq(&built.projects, &projects);
        // Read first: a write after it is caught by the next call.
        let sequence = workspace.chat_change_sequence()?;
        let changed: HashSet<String> = workspace
            .chats_changed_since(built.sequence)?
            .into_iter()
            .map(|(chat_id, _)| chat_id)
            .collect();
        let users = folder_users(&workspace)?;
        let trashed = workspace.list_chats(ChatListFilter::Trashed)?;
        let mut kept = HashMap::new();
        let mut row = |chat: &Chat| -> Outcome<Summary> {
            let live = live.get(&chat.id).cloned().unwrap_or_else(ChatLive::idle);
            let checked = self.checked(&chat.id);
            let summary = match built.rows.remove(&chat.id) {
                Some(mut row)
                    if !changed.contains(&chat.id)
                        && row.live == live
                        && row.checked == checked =>
                {
                    if projects_changed {
                        row.summary.project = chat_project(chat, &projects);
                    }
                    row.summary
                }
                _ => self.summary(&workspace, chat, &users, &live)?,
            };
            kept.insert(
                chat.id.clone(),
                BuiltRow {
                    live,
                    checked,
                    summary: summary.clone(),
                },
            );
            Ok(summary)
        };
        let rows = users.iter().map(&mut row).collect::<Outcome<Vec<_>>>()?;
        let trashed = trashed.iter().map(&mut row).collect::<Outcome<Vec<_>>>()?;
        *built = BuiltRows {
            sequence,
            projects,
            rows: kept,
        };
        Ok((overview_of(&rows), rows, trashed))
    }

    pub fn list(&self, scope: ChatListFilter) -> Outcome<Vec<Summary>> {
        self.host()?;
        let mut rows = self.summaries(scope)?;
        // An archived Chat that asks the person something shows in Active until answered.
        if scope == ChatListFilter::Active {
            let asking = self.summaries(ChatListFilter::Archived)?.into_iter();
            rows.extend(
                asking.filter(|row| matches!(row.status.rank, Rank::Approval | Rank::Question)),
            );
        }
        Ok(rows)
    }

    pub fn overview(&self) -> Outcome<Overview> {
        if !self.enabled() {
            return Ok(Overview::default());
        }
        Ok(self.overview_digest()?.0)
    }

    /// Probes installation and sign-in again on every call.
    pub async fn harnesses(&self) -> Outcome<Vec<HarnessStatus>> {
        let host = self.host()?;
        let mut probes = tokio::task::JoinSet::new();
        for (index, descriptor) in self.catalog().into_iter().enumerate() {
            let host = host.clone();
            probes.spawn(async move {
                (
                    index,
                    descriptor,
                    host.inspect(descriptor.key.as_str()).await,
                )
            });
        }
        let mut statuses = Vec::new();
        while let Some(result) = probes.join_next().await {
            let (index, descriptor, inspected) =
                result.map_err(|error| failed(error.to_string()))?;
            let id = descriptor.key.as_str();
            let name = descriptor.name;
            let status = match inspected {
                Ok(inspection) => {
                    let status = harness_status(descriptor, inspection);
                    lock(&self.versions).insert(id, status.version.clone());
                    status
                }
                Err(_) => {
                    let reason = self.unavailable(id);
                    HarnessStatus {
                        mark_id: descriptor.mark_id,
                        id,
                        name,
                        status: HarnessState::Unavailable,
                        usable: false,
                        word: HarnessState::Unavailable.word(),
                        problem: Some(chat_view::Problem::for_harness(
                            name,
                            ChatProblemKind::Unavailable,
                            &HarnessFound {
                                message: Some(reason.clone()),
                                command: None,
                                help_url: None,
                                path: None,
                            },
                        )),
                        message: Some(reason),
                        command: None,
                        help_url: None,
                        path: None,
                        version: None,
                    }
                }
            };
            statuses.push((index, status));
        }
        statuses.sort_unstable_by_key(|(index, _)| *index);
        Ok(statuses.into_iter().map(|(_, status)| status).collect())
    }

    fn catalog(&self) -> Vec<Harness> {
        let mut descriptors: Vec<_> = REGISTRATIONS.iter().map(|entry| entry.descriptor).collect();
        for descriptor in self.adapters.iter().map(|adapter| adapter.harness()) {
            if !descriptors.iter().any(|entry| entry.key == descriptor.key) {
                descriptors.push(descriptor);
            }
        }
        descriptors
    }

    pub fn harness_catalog(&self) -> Vec<HarnessInfo> {
        self.catalog().into_iter().map(HarnessInfo::from).collect()
    }

    /// What the installed harness offers before a session: its models with their
    /// efforts and its permission modes, as it reported them. Asked once per
    /// version the last check found; nothing is sent to a model.
    pub async fn options(&self, harness_id: &str) -> Outcome<HarnessOptionsView> {
        let host = self.host()?;
        let descriptor = self
            .catalog()
            .into_iter()
            .find(|descriptor| descriptor.key.as_str() == harness_id)
            .ok_or_else(|| failed(self.unavailable(harness_id)))?;
        let id = descriptor.key.as_str();
        let name = descriptor.name;
        let version = lock(&self.versions).get(id).cloned().flatten();
        if let Some((asked_at, view)) = lock(&self.options).get(id)
            && *asked_at == version
        {
            return Ok(view.clone());
        }
        let reported = host.options(id).await.map_err(ChatFailure::from)?;
        let view = chat_reports::options_view(id, name, reported);
        // A failed probe is asked again next time rather than remembered.
        if view.unavailable.is_none() {
            lock(&self.options).insert(id, (version, view.clone()));
        }
        Ok(view)
    }

    pub async fn skills(
        &self,
        harness_id: &str,
        folder: Option<&str>,
    ) -> Outcome<Vec<ticketd_chat_host::HarnessSkill>> {
        let host = self.host()?;
        let folder = if let Some(folder) = folder {
            PathBuf::from(folder_argument(folder)?)
        } else {
            let workspace = self.workspace()?;
            let folder = managed_chat_folders(&workspace)?;
            std::fs::create_dir_all(&folder).map_err(|error| {
                failed(format!("could not prepare the scratch folder: {error}"))
            })?;
            folder
        };
        host.skills(harness_id, &folder).await?.map_err(failed)
    }

    /// The Project whose checkout holds `path`, for New Chat's folder button.
    pub fn folder_project(&self, path: &str) -> Outcome<Option<ProjectRef>> {
        Ok(self
            .workspace()?
            .project_for_folder(Path::new(path))?
            .map(|project| ProjectRef {
                id: project.id,
                title: project.name,
            }))
    }

    /// How many Chats outside the trash already use the folder.
    pub fn folder_use(&self, path: &str) -> Outcome<usize> {
        let workspace = self.workspace()?;
        let mut count = 0;
        for filter in [ChatListFilter::Active, ChatListFilter::Archived] {
            let chats = workspace.list_chats(filter)?;
            count += chats
                .iter()
                .filter(|chat| chat.execution_folder == path)
                .count();
        }
        Ok(count)
    }

    /// Creates a Chat and sends its first message. Repeating `command_id` finds the Chat
    /// and the message an earlier try saved instead of making them again.
    pub async fn create(&self, input: NewChatInput) -> Outcome<Created> {
        let generation = lock(&self.restore_state).generation;
        let host = self.host()?;
        let command_id = uuid::Uuid::parse_str(&input.command_id)
            .map_err(|_| failed("the request id must be a UUID"))?
            .to_string();
        let create = format!("{command_id}:chat");
        let first = format!("{command_id}:first");
        let picks = StartSettings {
            model: input.model,
            effort: input.effort,
            permission: input.permission,
            ..StartSettings::default()
        };
        let requested = ChatStartPicks {
            model: picks.model.as_deref(),
            effort: picks.effort.as_deref(),
            permission: picks.permission.as_deref(),
        };
        let (new_chat, attachments, legacy_saved) = {
            let workspace = self.workspace()?;
            // Beside the Workspace, one folder per Chat, named by the request.
            let execution_folder = match &input.folder {
                Some(path) => path.clone(),
                None => managed_chat_folders(&workspace)?
                    .join(&command_id)
                    .to_string_lossy()
                    .into_owned(),
            };
            let attachment_title = input.attachments.first().map(|file| file.name.clone());
            let has_receipt = workspace.has_chat_creation_receipt(&create)?;
            let new_limit = (!has_receipt && !input.attachments.is_empty())
                .then(|| workspace.attachment_upload_limit())
                .transpose()?;
            let attachments = Self::decode_message_attachments(
                &input.message,
                input.attachments,
                new_limit.unwrap_or(MAX_BACKUP_FILE_BYTES),
            )?;
            let first_line = chat_view::first_line_of(&input.message).or(attachment_title);
            let previous_title = first_line
                .as_ref()
                .map(|line| line.chars().take(80).collect());
            let mut new_chat = NewChat {
                title: first_line
                    .as_deref()
                    .map(|line| chat_view::cut_at_word(line, chat_view::TITLE_LIMIT)),
                harness: input.harness_id.clone(),
                execution_folder,
                folder_managed: input.folder.is_none(),
                links: input.links.into_iter().map(ChatLink::from).collect(),
            };
            let receipt = if has_receipt {
                let replay = |chat: &NewChat| {
                    workspace.replay_chat_creation(
                        &create,
                        chat,
                        requested,
                        &input.message,
                        &attachments,
                    )
                };
                match replay(&new_chat) {
                    Err(ticketd_core::Error::RequestConflict(_))
                        if new_chat.title != previous_title =>
                    {
                        // Earlier receipts include the title cut at the character limit.
                        new_chat.title = previous_title;
                        replay(&new_chat)?
                    }
                    result => result?,
                }
            } else {
                None
            };
            let mut legacy_saved = None;
            if let Some(receipt) = receipt {
                let (chat, exact) = match receipt {
                    ChatCreationReplay::Exact(chat) => (chat, true),
                    ChatCreationReplay::Legacy(chat) => (chat, false),
                };
                if workspace
                    .replay_chat_input_replacing(
                        &first,
                        &chat.id,
                        &input.message,
                        &attachments,
                        &[],
                    )?
                    .is_some()
                {
                    let created = Created {
                        chat_id: chat.id,
                        send_error: None,
                    };
                    if exact || picks.is_empty() {
                        let _fence = self.new_chat_save_fence(generation)?;
                        return Ok(created);
                    }
                    legacy_saved = Some(created);
                }
            }
            if legacy_saved.is_none() && new_limit.is_none() && !attachments.is_empty() {
                let limit = workspace.attachment_upload_limit()?;
                if attachments
                    .iter()
                    .any(|file| file.bytes().len() as u64 > limit)
                {
                    return Err(ticketd_core::Error::UploadLimit { limit }.into());
                }
            }
            if legacy_saved.is_none() && !new_chat.folder_managed {
                folder_argument(&new_chat.execution_folder)?;
            }
            (new_chat, attachments, legacy_saved)
        };
        if legacy_saved.is_none() {
            let served = |adapter: &Arc<dyn HarnessAdapter>| adapter.harness().key.as_str();
            if !self.adapters.iter().any(|a| served(a) == input.harness_id) {
                return Err(failed(self.unavailable(&input.harness_id)));
            }
            host.check_attachment_input(&input.harness_id, &attachments)?;
        }
        if !picks.is_empty() {
            // Only what the harness offered and allows.
            let offered = self.options(&input.harness_id).await?;
            if let Some(reason) = offered.refusal(
                picks.model.as_deref(),
                picks.effort.as_deref(),
                picks.permission.as_deref(),
            ) {
                return Err(failed(format!(
                    "{} can't start with that: {reason}",
                    harness_name(&input.harness_id)
                )));
            }
        }
        let chat = {
            let _fence = self.new_chat_save_fence(generation)?;
            if let Some(created) = legacy_saved {
                return Ok(created);
            }
            // The Chat is stored first: a request the core refuses leaves no folder behind.
            self.workspace()?.create_chat_for_first_message(
                &create,
                new_chat,
                requested,
                &input.message,
                &attachments,
            )?
        };
        let created = |send_error| Created {
            chat_id: chat.id.clone(),
            send_error,
        };
        if chat.folder_managed
            && let Err(error) = std::fs::create_dir_all(&chat.execution_folder)
        {
            // The Chat stays readable and offers "pick another folder".
            return Ok(created(Some(format!(
                "could not create the Chat's folder {}: {error}",
                chat.execution_folder
            ))));
        }
        if !picks.is_empty() {
            host.start_with(&chat.id, picks)
                .await
                .map_err(ChatFailure::from)?;
        }
        let sent = host.send_with_attachments(
            &chat.id,
            Some(&first),
            &input.message,
            SendMode::Auto,
            attachments,
        );
        Ok(created(
            sent.await
                .err()
                .map(|error| ChatFailure::from(error).message),
        ))
    }

    fn fresh(&self, chat_id: &str) -> Option<FreshHistory> {
        lock(&self.fresh).get(chat_id).copied()
    }

    fn checked(&self, chat_id: &str) -> Option<String> {
        lock(&self.checked).get(chat_id).cloned()
    }

    /// The workspace for one update: borrowed on first need, then shared by the rest.
    fn lend<'a>(&self, lent: &'a mut Option<WorkspaceGuard>) -> Outcome<&'a Workspace> {
        Ok(match lent {
            Some(workspace) => workspace,
            None => lent.insert(self.workspace()?),
        })
    }

    fn state(&self, view: &mut View, lent: &mut Option<WorkspaceGuard>) -> Outcome<ChatState> {
        let around = match view.around.take() {
            Some(around) => around,
            None => {
                let workspace = self.lend(lent)?;
                let mut around = surroundings(
                    workspace,
                    &view.chat,
                    &folder_users(workspace)?,
                    self.checked(&view.chat.id),
                    &view.live,
                    &self.missing_folders,
                )?;
                // Read again with the surroundings, so a branch switched outside shows
                // by the turn's end.
                around.branch = folder_probe::branch(Path::new(&view.chat.execution_folder));
                around
            }
        };
        let state = chat_view::chat_state(&view.chat, &view.live, &view.tracker, &around);
        view.around = Some(around);
        Ok(state)
    }

    /// Attaches a view: a snapshot now, then every change after it through `sink`,
    /// numbered one apart from the snapshot's cursor. Attaching starts no harness.
    pub async fn open(self: &Arc<Self>, chat_id: &str, sink: Sink) -> Outcome<Opened> {
        let host = self.host()?;
        // Opening a Chat any way marks it seen. A view keeps working if that fails.
        log_failure(
            Some(chat_id),
            "mark the Chat seen",
            self.mark_seen(chat_id).await,
        );
        let projects = self.projects.subscribe();
        let (attached, subscription) = host.attach(chat_id).await?;
        let workspace = self.workspace()?;
        let tracker = Tracker::from_items(&attached.snapshot.items);
        let chat = attached.snapshot.chat;
        let mut around = surroundings(
            &workspace,
            &chat,
            &folder_users(&workspace)?,
            self.checked(chat_id),
            &attached.live,
            &self.missing_folders,
        )?;
        around.branch = folder_probe::branch(Path::new(&chat.execution_folder));
        let state = chat_view::chat_state(&chat, &attached.live, &tracker, &around);
        let fresh = self.fresh(chat_id);
        let items: Vec<Item> = attached
            .snapshot
            .items
            .iter()
            .flat_map(|item| chat_view::items(item, &chat, &attached.live, fresh, &tracker))
            .map(|item| with_gone(&workspace, item))
            .collect();
        let sent = items
            .iter()
            .filter_map(|item| {
                let item = serde_json::to_value(item).ok()?;
                Some((item["id"].as_str()?.to_owned(), item))
            })
            .collect();
        let view = View {
            chat,
            live: attached.live,
            tracker,
            state: state.clone(),
            sequence: 0,
            sent,
            around: Some(around),
        };
        let id = self.next_feed.fetch_add(1, Ordering::SeqCst);
        let (resync, resynced) = oneshot::channel();
        lock(&self.feeds).insert(
            id,
            Feed {
                chat_id: chat_id.to_owned(),
                _end: resync,
            },
        );
        let chats = self.clone();
        tokio::spawn(async move {
            chats
                .feed(view, subscription, projects, resynced, sink)
                .await;
            lock(&chats.feeds).remove(&id);
        });
        Ok(Opened {
            subscription: id,
            snapshot: Snapshot {
                chat: state,
                items,
                cursor: 0,
            },
        })
    }

    /// Detaches a view. The Chat's work continues.
    pub fn close(&self, subscription: u64) {
        // Dropping the sender ends the feed, which drops the host subscription.
        lock(&self.feeds).remove(&subscription);
    }

    /// Tells every view of the Chat to read a new snapshot, after a change the feed
    /// cannot express, such as a row that no longer exists.
    fn resync(&self, chat_id: &str) {
        lock(&self.feeds).retain(|_, feed| feed.chat_id != chat_id);
    }

    async fn feed(
        &self,
        mut view: View,
        mut subscription: Subscription,
        mut projects: watch::Receiver<Arc<Vec<Project>>>,
        mut resynced: oneshot::Receiver<()>,
        sink: Sink,
    ) {
        let number = |view: &mut View, mut change: Value| {
            view.sequence += 1;
            change["seq"] = json!(view.sequence);
            change
        };
        loop {
            enum Update {
                Chat(Option<ChatUpdate>),
                Projects,
            }
            let update = tokio::select! {
                update = subscription.next() => Update::Chat(update),
                Ok(()) = projects.changed() => Update::Projects,
                // Closed by the view (nobody is listening) or asked to resync.
                _ = &mut resynced => Update::Chat(None),
            };
            let mut ended = false;
            let records = match update {
                Update::Projects => {
                    let projects = projects.borrow_and_update().clone();
                    if let Some(around) = &mut view.around {
                        refresh_project_surroundings(around, &view.chat, &projects);
                    }
                    Vec::new()
                }
                Update::Chat(Some(ChatUpdate::Changes(changes))) => {
                    let active = view.chat.active_turn.as_ref().map(|turn| turn.id.clone());
                    let mut records = Vec::new();
                    for change in changes {
                        match change.record {
                            ChatRecord::Chat(chat) => {
                                view.chat = chat;
                                view.around = None;
                            }
                            ChatRecord::Item(item) => {
                                // A turn starting or ending changes no Chat record, so the
                                // Chat's active turn is followed from the turn itself.
                                if let ChatItem::Turn(turn) = &item {
                                    ended |= turn.state != ChatTurnState::Active;
                                    let ends_active = view.chat.active_turn.as_ref().map(|t| &t.id)
                                        == Some(&turn.id);
                                    if turn.state == ChatTurnState::Active {
                                        view.chat.active_turn = Some(turn.clone());
                                    } else if ends_active {
                                        view.chat.active_turn = None;
                                    }
                                }
                                // A tool call leaves the surroundings as they were; input,
                                // turns and the rest can move the queue or the branch.
                                if !matches!(item, ChatItem::Tool(_)) {
                                    view.around = None;
                                }
                                view.tracker.note(&item);
                                records.push(item);
                            }
                        }
                    }
                    // A turn that ended changes how its unfinished responses read.
                    if active != view.chat.active_turn.as_ref().map(|turn| turn.id.clone()) {
                        records.extend(view.tracker.dependents());
                    }
                    // A decided approval is told on the step it was asked for.
                    records.extend(view.tracker.refolded());
                    records
                }
                Update::Chat(Some(ChatUpdate::Text {
                    message_id,
                    turn_id,
                    delta,
                })) => {
                    // The view's text grows past what was last sent for it.
                    view.sent.remove(&message_id);
                    let change = if view.tracker.streaming(&message_id, &turn_id) {
                        let item = Item::Response {
                            id: message_id,
                            at: String::new(),
                            text: delta,
                            state: "streaming",
                            turn_id: Some(turn_id),
                        };
                        json!({ "kind": "item", "item": item })
                    } else {
                        json!({ "kind": "text", "item_id": message_id, "text": delta })
                    };
                    let change = number(&mut view, change);
                    if !sink(change) {
                        return;
                    }
                    continue;
                }
                Update::Chat(Some(ChatUpdate::Live(live))) => {
                    let before = std::mem::replace(&mut view.live, *live);
                    // Codex reports its context after every model call, stamped with the
                    // time; nothing the records show depends on it.
                    let context_only = before != view.live
                        && ChatLive {
                            context: before.context.clone(),
                            ..view.live.clone()
                        } == before;
                    if context_only {
                        Vec::new()
                    } else {
                        // Live state the same as before is a request to read again.
                        view.around = None;
                        // Whether a stored request can still be answered is live state.
                        let mut records = view.tracker.dependents();
                        // Input the host began or stopped holding to send reads differently.
                        let (held_before, sending) = (&before.sending, &view.live.sending);
                        let moved: Vec<&String> = held_before
                            .iter()
                            .filter(|id| !sending.contains(id))
                            .chain(sending.iter().filter(|id| !held_before.contains(id)))
                            .collect();
                        if !moved.is_empty() {
                            let Ok(stored) = self
                                .workspace()
                                .and_then(|workspace| Ok(messages(&workspace, &view.chat.id)?))
                            else {
                                break;
                            };
                            let moved: Vec<ChatMessage> = stored
                                .into_iter()
                                .filter(|message| moved.contains(&&message.id))
                                .collect();
                            // Back in the queue, it has no row; a change cannot remove one.
                            if moved.iter().any(|message| {
                                !sending.contains(&message.id)
                                    && message.standing() == ChatInputStanding::Queued
                            }) {
                                break;
                            }
                            records.extend(moved.into_iter().map(ChatItem::Message));
                        }
                        records
                    }
                }
                Update::Chat(Some(ChatUpdate::Resync) | None) => break,
            };
            // A turn that ends while its Chat is in view is seen.
            if ended && self.focused.load(Ordering::SeqCst) {
                log_failure(
                    Some(&view.chat.id),
                    "mark the Chat seen",
                    self.mark_seen(&view.chat.id).await,
                );
            }
            // At most one workspace use per update, and only when something needs it.
            let mut lent = None;
            let mut batch = Vec::new();
            let fresh = self.fresh(&view.chat.id);
            for record in records {
                let tracker = &view.tracker;
                for item in chat_view::items(&record, &view.chat, &view.live, fresh, tracker) {
                    let item = match &item {
                        Item::Records { .. } => match self.lend(&mut lent) {
                            Ok(workspace) => with_gone(workspace, item),
                            Err(_) => item,
                        },
                        _ => item,
                    };
                    let Ok(item) = serde_json::to_value(&item) else {
                        continue;
                    };
                    let Some(id) = item["id"].as_str().map(str::to_owned) else {
                        continue;
                    };
                    // An item the view already has as it is now is not sent again.
                    if view.sent.get(&id) == Some(&item) {
                        continue;
                    }
                    view.sent.insert(id, item.clone());
                    batch.push(number(&mut view, json!({ "kind": "item", "item": item })));
                }
            }
            // If the workspace cannot be read the view keeps what it shows; the next
            // change tries again.
            if let Ok(state) = self.state(&mut view, &mut lent)
                && state != view.state
            {
                view.state = state;
                let change = json!({ "kind": "chat", "chat": view.state });
                batch.push(number(&mut view, change));
            }
            drop(lent);
            // An update's changes arrive together, so the view draws once for them.
            if !batch.is_empty() && !sink(Value::Array(batch)) {
                return;
            }
        }
        let change = number(&mut view, json!({ "kind": "resync" }));
        sink(change);
    }

    pub async fn send(&self, chat_id: &str, text: &str, mode: SendMode) -> Outcome<()> {
        text_argument(text, "The message")?;
        self.host()?.send(chat_id, None, text, mode).await?;
        Ok(())
    }

    fn decode_message_attachments(
        text: &str,
        files: Vec<AttachmentInput>,
        limit: u64,
    ) -> Outcome<Vec<ChatAttachmentContent>> {
        if files.is_empty() {
            text_argument(text, "The message")?;
            return Ok(Vec::new());
        }
        text_byte_limit(text, "The message")?;
        files
            .into_iter()
            .map(|file| {
                ChatAttachmentContent::from_data_url(&file.name, &file.data_url, limit)
                    .map_err(ChatFailure::from)
            })
            .collect()
    }

    /// Saves a message or queued edit with the records it mentions or quotes, so the
    /// harness is told about the links with this message (spec 21.4).
    pub async fn send_linking(
        &self,
        chat_id: &str,
        text: &str,
        mode: SendMode,
        links: &[LinkRef],
        files: Vec<AttachmentInput>,
        queue_edit: Option<QueueEditSave>,
    ) -> Outcome<()> {
        let host = self.host()?;
        let links: Vec<_> = links.iter().cloned().map(ChatLink::from).collect();
        if let Some(edit) = queue_edit {
            if edit.message_ids.is_empty() {
                return Err(failed("choose a queued message to edit"));
            }
            let command_id = queue_edit_save_id(&edit.command_id)?;
            let edit = ChatQueueEdit {
                replaces: edit.message_ids,
                links,
            };
            // A saved edit can replay after the current upload limit changed.
            // Core checks that limit in the transaction for a new edit.
            let attachments = Self::decode_message_attachments(text, files, MAX_BACKUP_FILE_BYTES)?;
            {
                let workspace = self.workspace()?;
                if workspace.chat_queue_edit_saved(chat_id, &command_id)?
                    && workspace
                        .replay_chat_input_with_edit(
                            &command_id,
                            chat_id,
                            text,
                            &attachments,
                            Some(&edit),
                        )?
                        .is_some()
                {
                    self.resync(chat_id);
                    return Ok(());
                }
            }
            host.send_with_edit(
                chat_id,
                Some(&command_id),
                text,
                mode,
                attachments,
                Some(edit),
            )
            .await?;
            self.resync(chat_id);
            return Ok(());
        }

        let limit = if files.is_empty() {
            0
        } else {
            self.workspace()?.attachment_upload_limit()?
        };
        let attachments = Self::decode_message_attachments(text, files, limit)?;
        if attachments.is_empty() && links.is_empty() {
            return self.send(chat_id, text, mode).await;
        }
        host.send_linking(chat_id, text, mode, attachments, links)
            .await?;
        Ok(())
    }

    pub fn export_attachment(&self, chat_id: &str, id: &str, destination: &Path) -> Outcome<()> {
        self.host()?;
        self.workspace()?
            .export_chat_attachment(chat_id, id, destination)?;
        Ok(())
    }

    pub fn capture_attachment(&self, file: AttachmentInput) -> Outcome<String> {
        let limit = self.workspace()?.attachment_upload_limit()?;
        let content = ChatAttachmentContent::from_data_url(&file.name, &file.data_url, limit)
            .map_err(|error| ChatFailure {
                code: "invalid_attachment",
                message: error.to_string(),
            })?;
        Ok(content.media_type().to_owned())
    }

    /// What the composer's `@` menu offers from a Chat's folder.
    pub fn files(&self, path: &str, query: &str) -> Outcome<Vec<FolderFile>> {
        self.host()?;
        let folder = folder_argument(path)?;
        Ok(folder_files(Path::new(&folder), query))
    }

    /// The Chats outside the trash linked to one record, for the record's own page.
    pub fn linked_to(&self, link: &LinkRef) -> Outcome<Vec<Summary>> {
        self.host()?;
        let link = ChatLink::from(link.clone());
        let workspace = self.workspace()?;
        let mut ids = HashSet::new();
        for filter in [ChatListFilter::Active, ChatListFilter::Archived] {
            for chat in workspace.list_chats(filter)? {
                if chat
                    .links
                    .iter()
                    .any(|old| old.kind == link.kind && old.id == link.id)
                {
                    ids.insert(chat.id);
                }
            }
        }
        let mut rows = self.summaries(ChatListFilter::Active)?;
        rows.extend(self.summaries(ChatListFilter::Archived)?);
        rows.retain(|row| ids.contains(&row.id));
        Ok(rows)
    }

    pub async fn remove_queued(&self, chat_id: &str, message_id: &str) -> Outcome<()> {
        let host = self.host()?;
        self.workspace()?.withdraw_chat_input(chat_id, message_id)?;
        host.notify_changed(chat_id).await?;
        // A withdrawn message that was tried before has a transcript row to remove.
        self.resync(chat_id);
        Ok(())
    }

    pub async fn edit_queued(&self, chat_id: &str, message_id: &str) -> Outcome<QueuedDraft> {
        let (text, attachments) = self.host()?.prepare_queue_edit(chat_id, message_id).await?;
        Ok(QueuedDraft {
            text,
            attachments: attachments
                .into_iter()
                .map(|file| AttachmentInput {
                    name: file.name().to_owned(),
                    data_url: file.data_url(),
                })
                .collect(),
        })
    }

    pub async fn confirm_queue_edit(
        &self,
        chat_id: &str,
        message_id: &str,
        transfer_id: &str,
    ) -> Outcome<bool> {
        let transfer_id = uuid::Uuid::parse_str(transfer_id)
            .map_err(|_| failed("the transfer id must be a UUID"))?;
        let held = self
            .host()?
            .confirm_queue_edit(chat_id, message_id, &format!("{transfer_id}:queue-edit"))
            .await?;
        if held {
            self.resync(chat_id);
        }
        Ok(held)
    }

    pub fn check_queue_edits(
        &self,
        chat_id: &str,
        saves: Vec<String>,
        removals: Vec<String>,
    ) -> Outcome<QueueEditStatus> {
        self.host()?;
        let saves = saves
            .into_iter()
            .map(|id| queue_edit_save_id(&id).map(|key| (id, key)))
            .collect::<Outcome<Vec<_>>>()?;
        let result = self.workspace()?.read(|workspace| {
            let mut saved = Vec::new();
            for (id, key) in saves {
                if workspace.chat_queue_edit_saved(chat_id, &key)? {
                    saved.push(id);
                }
            }
            let removed = if removals.is_empty() {
                removals
            } else {
                let queue = workspace.chat_queue(chat_id)?;
                removals
                    .into_iter()
                    .filter(|id| {
                        !queue
                            .iter()
                            .any(|message| &message.id == id && message.editing)
                    })
                    .collect()
            };
            Ok(QueueEditStatus { saved, removed })
        })?;
        Ok(result)
    }

    pub async fn resume_queue(&self, chat_id: &str) -> Outcome<()> {
        Ok(self.host()?.resume_queue(chat_id).await?)
    }

    /// Sends one queued message now, alone; see `ChatHost::send_queued_now`.
    pub async fn send_queued_now(&self, chat_id: &str, message_id: &str) -> Outcome<()> {
        Ok(self.host()?.send_queued_now(chat_id, message_id).await?)
    }

    pub async fn stop(&self, chat_id: &str) -> Outcome<()> {
        Ok(self.host()?.stop(chat_id).await?)
    }

    /// Answers a request only while the host holds it as live.
    pub async fn answer(&self, chat_id: &str, request_id: &str, answer: Answer) -> Outcome<()> {
        let host = self.host()?;
        let live = self.live(chat_id);
        let Some(request) = live
            .interactions
            .iter()
            .find(|request| request.interaction_id == request_id)
        else {
            return Err(stale(HostError::InteractionExpired.to_string()));
        };
        let answer = match (&request.kind, answer) {
            (InteractionKind::Approval { decisions, .. }, Answer::Choice { option_id }) => {
                let decision = chat_view::approval_decision(&option_id)
                    .filter(|decision| decisions.contains(decision))
                    .ok_or_else(|| failed("that choice was not offered for this request"))?;
                InteractionAnswer::Approval(decision)
            }
            (InteractionKind::NativeApproval { options, .. }, Answer::Choice { option_id }) => {
                if !options.iter().any(|option| option.id == option_id) {
                    return Err(failed("that choice was not offered for this request"));
                }
                InteractionAnswer::NativeApproval(option_id)
            }
            (
                InteractionKind::Approval { .. } | InteractionKind::NativeApproval { .. },
                Answer::Text { .. },
            ) => {
                return Err(failed("an approval request takes one of its choices"));
            }
            (InteractionKind::Question { questions }, Answer::Choice { option_id }) => {
                let [question] = questions.as_slice() else {
                    return Err(failed("that choice was not offered for this request"));
                };
                if !question.options.contains(&option_id) {
                    return Err(failed("that choice was not offered for this request"));
                }
                InteractionAnswer::Answers(vec![QuestionAnswer {
                    question_id: question.id.clone(),
                    values: vec![option_id],
                }])
            }
            (InteractionKind::Question { questions }, Answer::Text { text }) => {
                text_argument(&text, "The answer")?;
                InteractionAnswer::Answers(
                    questions
                        .iter()
                        .map(|question| QuestionAnswer {
                            question_id: question.id.clone(),
                            values: vec![text.clone()],
                        })
                        .collect(),
                )
            }
        };
        Ok(host.respond(chat_id, request_id, answer).await?)
    }

    /// The person's decision about a submission that may or may not have arrived.
    /// Nothing is resent unless they ask for it here.
    pub async fn resolve_uncertain(
        &self,
        chat_id: &str,
        message_id: &str,
        decision: UncertainDecision,
    ) -> Outcome<()> {
        let host = self.host()?;
        let mut workspace = self.workspace()?;
        messages(&workspace, chat_id)?
            .into_iter()
            .find(|message| message.id == message_id && message.awaits_decision())
            .ok_or_else(|| stale("this message is no longer waiting for your decision"))?;
        // Either way the message and its uncertain attempt stay as they were observed;
        // the decision is recorded beside them.
        match decision {
            UncertainDecision::Discard => {
                workspace.discard_uncertain_chat_submission(chat_id, message_id)?;
                Ok(host.notify_changed(chat_id).await?)
            }
            // A new submission of this message alone; the rest of the queue waits.
            UncertainDecision::Resend => Ok(host.resend(chat_id, message_id).await?),
        }
    }

    /// Looks at every Chat's folder again (the window regained focus, or "Check again").
    /// A folder that went missing or came back since a view last showed it is logged as
    /// a Chat change, so open views and the list follow without anything else changing.
    pub async fn recheck_folders(&self) -> Outcome<()> {
        let Some(host) = self.started_host() else {
            return Ok(());
        };
        let mut workspace = self.workspace()?;
        let mut changed = Vec::new();
        for chat in folder_users(&workspace)? {
            let missing = !Path::new(&chat.execution_folder).is_dir();
            if note_folder(&self.missing_folders, &chat.id, missing) {
                workspace.mark_chat_changed(&chat.id)?;
                changed.push(chat.id);
            }
        }
        drop(workspace);
        for chat_id in changed {
            host.notify_changed(&chat_id).await?;
        }
        Ok(())
    }

    /// Probes the Chat's harness again. When it is not usable, says why. When it is:
    /// a Chat stopped by a failed start tries that start again, and a failure of the
    /// last turn stops being told as a problem, since what the probe can see is in
    /// order. No input is sent by this.
    pub async fn check_again(&self, chat_id: &str) -> Outcome<()> {
        let host = self.host()?;
        self.recheck_folders().await?;
        let workspace = self.workspace()?;
        let chat = workspace.chat(chat_id)?;
        if !Path::new(&chat.execution_folder).is_dir() {
            return Err(failed("The folder is still missing.".to_owned()));
        }
        let items = workspace.chat_snapshot(chat_id, SUMMARY_ITEMS)?.items;
        // The row reads the last turn on its own too, so this must see what the row sees.
        let latest_turn = workspace.chat_latest_turn(chat_id)?;
        drop(workspace);
        let descriptor = self
            .catalog()
            .into_iter()
            .find(|descriptor| descriptor.key.as_str() == chat.harness)
            .ok_or_else(|| failed(format!("unknown harness '{}'", chat.harness)))?;
        let status = harness_status(descriptor, host.inspect(descriptor.key.as_str()).await?);
        if !status.usable {
            return Err(failed(status.message.unwrap_or_default()));
        }
        if matches!(
            self.live(chat_id).problem,
            Some(ChatProblem::OpenFailed { .. })
        ) {
            host.resume(chat_id, ResumeMode::Native).await?;
        }
        let mut tracker = Tracker::from_items(&items);
        if let Some(turn) = latest_turn {
            tracker.note(&ChatItem::Turn(turn));
        }
        if let Some(turn) = tracker.failed_turn() {
            // A sign-in the probe cannot see is not shown to be in order by it.
            let signed_out = matches!(
                TurnEnding::of(turn),
                Some(TurnEnding::Failed {
                    kind: ProblemKind::LoginRequired,
                    ..
                })
            );
            if signed_out && status.status == HarnessState::SignInUnknown {
                return Err(failed(status.message.unwrap_or_default()));
            }
            lock(&self.checked).insert(chat_id.to_owned(), turn.id.clone());
            // No record changed, so the views are told to read the Chat again.
            self.resync(chat_id);
        }
        Ok(host.notify_changed(chat_id).await?)
    }

    /// "Pick another folder": the Chat keeps its history and runs there from now on.
    pub async fn set_folder(&self, chat_id: &str, path: &str) -> Outcome<()> {
        let host = self.host()?;
        let folder = folder_argument(path)?;
        self.workspace()?
            .set_chat_execution_folder(chat_id, &folder, false)?;
        Ok(host.notify_changed(chat_id).await?)
    }

    pub async fn set_retention(&self, chat_id: &str, retention: Retention) -> Outcome<()> {
        let host = self.host()?;
        match retention {
            Retention::Archive | Retention::Unarchive => {
                self.workspace()?
                    .set_chat_archived(chat_id, retention == Retention::Archive)?;
            }
            Retention::Restore => {
                self.workspace()?.set_chat_trashed(chat_id, false)?;
            }
            Retention::Trash => {
                return match host.trash(chat_id).await? {
                    None => Ok(()),
                    Some(reason) => Err(failed(format!(
                        "The Chat is in the trash, but stopping its harness was not confirmed: {reason}"
                    ))),
                };
            }
        }
        Ok(host.notify_changed(chat_id).await?)
    }

    /// Records to link for `query`; with nothing typed, the recently updated ones.
    pub fn search_records(&self, query: &str) -> Outcome<Vec<LinkedRecord>> {
        let query = query.trim();
        if query.len() > 200 {
            return Ok(Vec::new());
        }
        let workspace = self.workspace()?;
        if query.is_empty() {
            let mut found = Vec::new();
            for ticket in workspace.active_tickets(4)? {
                found.push(LinkedRecord::Ticket {
                    status: status_name(ticket.status)?,
                    id: ticket.id,
                    reference: ticket.reference,
                    title: ticket.title,
                });
            }
            found.extend(
                workspace
                    .recent_documents_page(2, 0)?
                    .into_iter()
                    .map(|document| LinkedRecord::Document {
                        id: document.id,
                        title: document.heading,
                    }),
            );
            return Ok(found);
        }
        let tickets = workspace.search_tickets(query, None, false, 8, 0)?;
        let documents = workspace.search_documents(query, None, 8, 0)?;
        let mut found = Vec::new();
        for ticket in tickets {
            found.push(LinkedRecord::Ticket {
                status: status_name(ticket.status)?,
                id: ticket.id,
                reference: ticket.reference,
                title: ticket.title,
            });
        }
        found.extend(
            documents
                .into_iter()
                .map(|document| LinkedRecord::Document {
                    id: document.id,
                    title: document.heading,
                }),
        );
        // Projects are few and have no search index: match their names here.
        let needle = query.to_lowercase();
        let projects = workspace.list_projects()?;
        let matching = || {
            projects
                .iter()
                .filter(|project| project.name.to_lowercase().contains(&needle))
        };
        let record = |project: &ticketd_core::Project| LinkedRecord::Project {
            id: project.id.clone(),
            title: project.name.clone(),
            archived: project.archived,
        };
        found.extend(
            matching()
                .filter(|project| !project.archived)
                .take(8)
                .map(record),
        );
        // Offer no assignment for an archived match. Its name explains an empty search.
        if found.is_empty() {
            found.extend(matching().find(|project| project.archived).map(record));
        }
        Ok(found)
    }

    pub async fn set_link(&self, chat_id: &str, link: LinkRef, present: bool) -> Outcome<()> {
        let host = self.host()?;
        self.workspace()?
            .set_chat_link(chat_id, link.into(), present)?;
        // A running session is told with its next message.
        Ok(host.links_changed(chat_id).await?)
    }

    /// Continues the same Chat in a fresh harness session, optionally with selected
    /// history. Nothing is re-sent, and uncertain submissions stay as they are.
    pub async fn resume(&self, chat_id: &str, selection: HistorySelection) -> Outcome<()> {
        let host = self.host()?;
        let workspace = self.workspace()?;
        let chat = workspace.chat(chat_id)?;
        if chat.trashed {
            return Err(failed(
                "Restore this Chat from the trash before resuming it.",
            ));
        }
        let import_history = selection != HistorySelection::None;
        if import_history
            && self.catalog().iter().any(|descriptor| {
                descriptor.key.as_str() == chat.harness
                    && descriptor.resume == ResumePolicy::NativeOnly
            })
        {
            return Err(failed("This harness can only resume its own history"));
        }
        // Input that may never have arrived is history only when the person picks it.
        let unreceived = |message: &ChatMessage| {
            message.role == ChatRole::User
                && message
                    .attempts
                    .last()
                    .is_some_and(|attempt| !attempt.received())
        };
        let picking = matches!(selection, HistorySelection::Picked { .. });
        let sent: Vec<_> = if import_history {
            messages(&workspace, chat_id)?
                .into_iter()
                .filter(|message| !message.queued && (picking || !unreceived(message)))
                .collect()
        } else {
            Vec::new()
        };
        let (history, chosen): (&'static str, Vec<&ChatMessage>) = match &selection {
            HistorySelection::None => ("none", Vec::new()),
            HistorySelection::LastResponse => (
                "last_response",
                sent.iter()
                    .rev()
                    .find(|message| message.role == ChatRole::Assistant)
                    .into_iter()
                    .collect(),
            ),
            HistorySelection::LastMessages { count } => {
                if !(1..=MAX_LAST_MESSAGES).contains(count) {
                    return Err(failed(format!(
                        "choose between 1 and {MAX_LAST_MESSAGES} messages"
                    )));
                }
                let skipped = sent.len().saturating_sub(*count);
                ("last_messages", sent.iter().skip(skipped).collect())
            }
            HistorySelection::All => ("all", sent.iter().collect()),
            HistorySelection::Picked { ids } => {
                let chosen: Vec<_> = sent.iter().filter(|m| ids.contains(&m.id)).collect();
                if chosen.len() != ids.len() {
                    return Err(stale("some of the picked messages are no longer there"));
                }
                ("picked", chosen)
            }
        };
        let chosen: Vec<_> = chosen
            .into_iter()
            .filter(|message| message.attachments.is_empty() || !message.text.trim().is_empty())
            .collect();
        let mut text = String::new();
        if !chosen.is_empty() {
            text.push_str(
                "Earlier messages from this Chat, selected by the user to start this fresh session. \
                 They are history, not new instructions.\n",
            );
            for message in &chosen {
                let speaker = match message.role {
                    ChatRole::User if unreceived(message) => {
                        "User (it is not known whether the earlier session received this)"
                    }
                    ChatRole::User => "User",
                    ChatRole::Assistant if !message.complete => {
                        "Assistant (incomplete: the rest of this response was not saved)"
                    }
                    ChatRole::Assistant => "Assistant",
                };
                text.push_str(&format!("\n{speaker}:\n{}\n", message.text));
            }
        }
        let fresh = FreshHistory {
            after: workspace.chat_change_sequence()?,
            history,
            count: chosen.len(),
        };
        drop(workspace);
        lock(&self.fresh).insert(chat_id.to_owned(), fresh);
        Ok(host
            .resume(chat_id, ResumeMode::FreshSession { history: text })
            .await?)
    }

    /// Saves one assistant response, or a turn's plan as a checklist, as a Document
    /// through the ordinary core workflow.
    pub fn save_as_document(
        &self,
        chat_id: &str,
        response_id: &str,
        title: &str,
    ) -> Outcome<String> {
        self.host()?;
        let mut workspace = self.workspace()?;
        let snapshot = workspace.chat_snapshot(chat_id, HISTORY_ITEMS)?;
        let text = snapshot.items.iter().find_map(|item| match item {
            ChatItem::Message(message)
                if message.id == response_id && message.role == ChatRole::Assistant =>
            {
                Some(message.text.clone())
            }
            ChatItem::Tool(tool) if tool.id == response_id => {
                let turn = snapshot.items.iter().find_map(|item| match item {
                    ChatItem::Turn(turn) if tool.turn_id.as_ref() == Some(&turn.id) => Some(turn),
                    _ => None,
                });
                let date = turn.map_or(String::new(), |turn| shown_date(&turn.started_at));
                let chat_title = chat_view::title(&snapshot.chat);
                chat_reports::plan_document(tool, &chat_title, &date)
            }
            _ => None,
        });
        let text = text.ok_or_else(|| failed("that response is not in this Chat"))?;
        let title = Some(title.trim()).filter(|title| !title.is_empty());
        Ok(workspace.create_document(title, &text)?.id)
    }

    /// Asks the live session to use `value` for `setting` from its next turn, and says
    /// where the change stands.
    pub async fn change_setting(
        &self,
        chat_id: &str,
        setting: SettingKey,
        value: &str,
    ) -> Outcome<SettingChangeView> {
        let state = self.host()?.change_setting(chat_id, setting, value).await?;
        Ok(chat_reports::change_view(value, &state))
    }

    /// The Chat's execution folder, to open in the file manager, when it exists.
    pub fn folder(&self, chat_id: &str) -> Outcome<PathBuf> {
        let path = PathBuf::from(self.workspace()?.chat(chat_id)?.execution_folder);
        if !path.is_dir() {
            return Err(failed("The folder is no longer on this computer."));
        }
        Ok(path)
    }

    /// New Chat's suggestions for `folder` (`None`: a folder ticketd keeps), skipping
    /// the tickets the person already linked and those a working Chat is linked to.
    pub fn suggestions(
        &self,
        folder: Option<&str>,
        linked: &[String],
    ) -> Outcome<Vec<chat_view::Suggestion>> {
        let workspace = self.workspace()?;
        let mut skip: HashSet<String> = linked.iter().cloned().collect();
        if let Some(host) = self.started_host() {
            for (chat_id, live) in host.live() {
                if live.activity == Activity::Idle {
                    continue;
                }
                let Ok(chat) = workspace.chat(&chat_id) else {
                    continue;
                };
                skip.extend(
                    chat.links
                        .into_iter()
                        .filter(|link| link.kind == ChatLinkKind::Ticket)
                        .map(|link| link.id),
                );
            }
        }
        Ok(workspace
            .chat_suggestions(folder.map(Path::new), skip)?
            .into_iter()
            .map(chat_view::Suggestion::from)
            .collect())
    }

    /// The whole output of one of the Chat's steps; views carry only its last lines.
    pub fn step_output(&self, chat_id: &str, tool_id: &str) -> Outcome<Option<String>> {
        Ok(self.workspace()?.chat_tool_output(chat_id, tool_id)?)
    }

    /// A file in the Chat's folder, for the system to open: one a step named
    /// (relative to the folder) or one a turn reported changing (absolute). A path
    /// that resolves outside the folder, through `..` or a link, is refused; a file
    /// that is no longer there fails as `gone`.
    pub fn file_in_folder(&self, chat_id: &str, path: &str) -> Outcome<PathBuf> {
        let chat = self.workspace()?.chat(chat_id)?;
        file_in(Path::new(&chat.execution_folder), path)
    }
}

/// Extensions the system runs, rather than shows, when such a file is opened.
const RUNNABLE: [&str; 17] = [
    "app",
    "applescript",
    "bat",
    "cmd",
    "com",
    "command",
    "exe",
    "jar",
    "msi",
    "pkg",
    "ps1",
    "py",
    "rb",
    "scpt",
    "sh",
    "tool",
    "vbs",
];

/// Opening the file would run it: a program or script. Such a file is shown in its
/// folder instead, so a click on a file name never starts something.
pub fn runs_when_opened(path: &Path) -> bool {
    let named = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| RUNNABLE.contains(&extension.to_ascii_lowercase().as_str()));
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    };
    #[cfg(not(unix))]
    let executable = false;
    named || executable
}

/// `path` inside `folder`, resolved through links.
fn file_in(folder: &Path, path: &str) -> Outcome<PathBuf> {
    let outside = || failed("that file is outside the Chat's folder");
    let candidate = folder.join(path);
    let name = candidate.file_name().map_or_else(
        || path.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let gone = || ChatFailure {
        code: "gone",
        message: format!("{name} is no longer in this folder."),
    };
    if let (Ok(root), Ok(file)) = (folder.canonicalize(), candidate.canonicalize()) {
        if !file.starts_with(&root) {
            return Err(outside());
        }
        return if file.is_file() {
            Ok(file)
        } else {
            Err(gone())
        };
    }
    // Nothing is there to resolve: refuse what names a place outside the folder
    // as written, and call the rest gone.
    let climbs = Path::new(path)
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir));
    if climbs || !candidate.starts_with(folder) {
        return Err(outside());
    }
    Err(gone())
}

/// The counts the sidebar and the app icon show, from the rows outside the trash.
pub fn overview_of(rows: &[Summary]) -> Overview {
    let mut overview = Overview::default();
    for row in rows {
        let needs_you = row.status.rank.needs_you();
        overview.needs_you += usize::from(needs_you);
        overview.app_icon += usize::from(needs_you && !row.muted);
        overview.unread += usize::from(row.status.unread());
        overview.working += usize::from(matches!(row.activity, "working" | "waiting"));
    }
    overview
}

/// What closing the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// As before Chat existed: the window closes and the app exits.
    Exit,
    /// The window is hidden; Chats and Automations keep running in this process.
    KeepRunning,
}

/// ticketd stays for a Chat that is working, a run that is going, and an Automation
/// that is on, which may start a run at any time. With Chat off none of them runs.
pub fn close_action(enabled: bool, stopping: Stopping, automations_on: bool) -> CloseAction {
    if enabled && (stopping.any() || automations_on) {
        CloseAction::KeepRunning
    } else {
        CloseAction::Exit
    }
}

/// What a request to quit does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAction {
    /// Ask the person first: this would be stopped.
    Confirm(Stopping),
    /// Stop app-owned execution, then exit.
    Quit,
}

pub fn quit_action(stopping: Stopping, confirmed: bool) -> QuitAction {
    if stopping.any() && !confirmed {
        QuitAction::Confirm(stopping)
    } else {
        QuitAction::Quit
    }
}

/// The tray icon's tooltip while the window is hidden. A Chat that needs the person
/// (an approval or question, a failure, uncertain delivery) is named before work.
pub fn tray_tooltip(overview: &Overview) -> String {
    match (overview.needs_you, overview.working) {
        (0, 0) => "ticketd is running in the background".to_owned(),
        (0, _) => "ticketd: Chats are still working".to_owned(),
        (1, _) => "ticketd: 1 Chat needs you".to_owned(),
        (needs_you, _) => format!("ticketd: {needs_you} Chats need you"),
    }
}

#[cfg(test)]
#[path = "chats_tests.rs"]
mod tests;
