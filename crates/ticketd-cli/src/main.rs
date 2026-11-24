use clap::{Args, Parser, Subcommand, ValueEnum};
use std::io::{Read, Write};
use ticketd_core::{
    ActivityPatch, Availability, BatchOperation, ContextOptions, DocumentPatch, EvidenceInput,
    EvidenceKind, ProjectRemoteChange, Status, TicketFilter, TicketPatch, Workspace, WriteRequest,
    WriteResult,
};

mod output;
mod skills;

use output::{bare, ok};

#[derive(Parser)]
#[command(name = "ticketd", version, about = "Local ticket workspace")]
struct Arguments {
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Subcommand)]
enum CliCommand {
    /// Read bundled CLI guides or install the agent discovery skill (no workspace access)
    Skills {
        #[command(subcommand)]
        command: skills::Command,
    },
    #[command(flatten)]
    Workspace(Command),
}

#[derive(Subcommand)]
enum ReminderCommand {
    /// Show when a ticket's reminder is due
    Show { reference: String },
    /// Set a reminder (due time must be RFC 3339 with an offset)
    Set { reference: String, due_at: String },
    /// Move a reminder to a later time
    Snooze { reference: String, due_at: String },
    /// Remove a ticket's reminder
    Dismiss { reference: String },
}

#[derive(Subcommand)]
enum AttachmentCommand {
    /// Remove an unused remote record from ticketd; the file remains in Drive
    RemoveFromTicketd {
        id: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Permanently delete quarantined local bytes; identity remains unavailable. Never deletes remote files.
    Purge {
        id: String,
        /// Required acknowledgement: this cannot be undone except by restoring an older complete backup
        #[arg(long, required = true)]
        confirm: bool,
    },
    /// Review unused local storage and protected references; never moves or deletes files
    CleanupReview {
        id: Option<String>,
        /// Return at most this many results (0-1000)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(0..=1000))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Reclaim local storage by reversible quarantine after rechecking all protections
    Quarantine {
        id: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Restore quarantined local bytes under their original attachment identity
    Restore {
        id: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Search filenames and available metadata with usage context, recent first
    Search {
        /// Only files whose name or available metadata contains this text; omit to list all
        #[arg(default_value = "")]
        search: String,
        /// Which files to include
        #[arg(long, value_enum, default_value_t = AttachmentStateArg::All)]
        state: AttachmentStateArg,
        /// Prioritize related files without flattening Document ownership
        #[arg(long)]
        related_ticket: Option<String>,
        /// Return at most this many results (0-1000)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(0..=1000))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Change the display name only; authored labels and original bytes stay unchanged
    Rename {
        id: String,
        /// The new name to show for the file
        display_name: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Read or change the workspace's per-file upload limit (default 100 MiB); existing snapshots stay unchanged
    Limit {
        /// Positive byte bound, enforced while copying actual bytes; at most 999000000, the largest file a backup can hold
        #[arg(long)]
        bytes: Option<u64>,
    },
    /// Read or change the default for new uploads; never moves existing files
    Destination {
        /// Store new uploads in the workspace
        #[arg(long, conflicts_with = "drive")]
        local: bool,
        /// Upload new files to a Google Drive folder; needs --connection and --folder
        #[arg(long, requires_all = ["connection", "folder"])]
        drive: bool,
        /// The Drive connection handle (see `attachment drive-info`)
        #[arg(long, requires = "drive")]
        connection: Option<String>,
        /// The Drive folder ID to upload into
        #[arg(long, requires = "drive")]
        folder: Option<String>,
        /// The folder's resource key, when Drive requires one for a link-shared folder
        #[arg(long, requires = "drive")]
        resource_key: Option<String>,
    },
    /// Upload using the workspace default; retry keeps its original destination
    Add {
        /// The file to upload
        path: String,
        #[arg(long)]
        ticket: Option<String>,
        /// Display name for the file (default: its file name)
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        request_id: Option<String>,
        /// Explicit local upload without changing the workspace preference
        #[arg(long)]
        local: bool,
    },
    /// List direct ticket attachments, or all workspace uploads including unused files
    List {
        #[arg(long)]
        ticket: Option<String>,
        /// Return at most this many results (0-1000)
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(0..=1000))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Inspect a workspace attachment by stable ID
    Inspect { id: String },
    /// Last-known Drive metadata and opaque connection handle; no network needed
    DriveInfo { id: String },
    /// Compare current metadata with uploaded-copy provenance; never downloads bytes
    DriveCopyStatus { id: String },
    /// Upload a new blob copy to an explicitly authorized writable Drive folder
    DriveUpload {
        /// The file to upload
        path: String,
        /// The Drive connection handle (see `attachment drive-info`)
        #[arg(long)]
        connection: String,
        /// The Drive folder ID to upload into
        #[arg(long)]
        folder: String,
        /// The folder's resource key, when Drive requires one for a link-shared folder
        #[arg(long)]
        resource_key: Option<String>,
        /// Names this upload so a retry reconciles it instead of uploading twice (check it with `attachment drive-upload-status`)
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        ticket: Option<String>,
    },
    /// List pending, uncertain and completed uploads without network access
    DriveUploads,
    /// Inspect an operation; --check reconciles the same remote ID without uploading
    DriveUploadStatus {
        /// The request ID given to `attachment drive-upload` (see `attachment drive-uploads`)
        request_id: String,
        /// Reconcile with Drive (needs the network)
        #[arg(long)]
        check: bool,
    },
    /// Reference an already-authorized Drive file using the shared OS credential store
    DriveAdd {
        /// The Drive connection handle (see `attachment drive-info`)
        connection: String,
        /// The Drive file ID
        file_id: String,
        #[arg(long)]
        resource_key: Option<String>,
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Resolve current Drive metadata without downloading or converting content
    DriveResolve { id: String },
    /// Check current access, returning typed recovery status and last-known metadata
    DriveStatus { id: String },
    /// Reconnect and authorize the original file in system-browser Picker (open the printed URL)
    DriveAuthorize { id: String },
    /// Explain saved, Trash, draft and Undo protections (eligibility is advisory)
    Usage { id: String },
    /// Finish legacy draft migration only after importing/reviewing every desktop profile
    CompleteDraftMigration {
        /// Required acknowledgement that every desktop profile's drafts were imported or reviewed
        #[arg(long, required = true)]
        all_profiles_reviewed: bool,
    },
    /// Inspect private recovery payloads, including preserved drafts from other profiles
    RecoveryDrafts,
    /// Discard one reviewed recovery payload/protection, retaining attachment bytes
    ReleaseRecovery {
        /// The owner of the recovery payload (see `attachment recovery-drafts`)
        owner: String,
        /// The payload's revision, as listed by `attachment recovery-drafts`
        #[arg(long)]
        revision: i64,
        /// Required acknowledgement that this recovery payload is discarded
        #[arg(long, required = true)]
        discard_recovery: bool,
    },
    /// Print the workspace-scoped URI to use in canonical Markdown links
    Uri { id: String },
    /// Reuse an existing attachment on another ticket
    Link { id: String, ticket: String },
    /// Remove only this ticket's association, retaining the snapshot and all other uses
    Detach { id: String, ticket: String },
    /// Copy stored bytes to a new file without overwriting an existing destination
    Export {
        id: String,
        /// The new file to copy the bytes to; it must not exist
        path: String,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum AttachmentStateArg {
    All,
    InUse,
    Unused,
    Quarantined,
}

#[derive(Subcommand)]
enum DocumentCommand {
    /// List what an item (Document, ticket or Plan ID) links to: its outgoing references
    References {
        id: String,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// List everything that links to an item, of any kind (ticket, Plan or Document)
    Incoming {
        id: String,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Print the Markdown link text for a ticket, Plan or Document, to paste into a body
    Link { target: String },
    /// Attach a Document to a ticket's context without editing its description
    LinkTicket {
        id: String,
        ticket: String,
        /// Makes retries safe: repeating this ID with the same input returns the first result instead of writing again
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Remove a Document attached with link-ticket (mentions in the description stay)
    UnlinkTicket {
        id: String,
        ticket: String,
        /// Makes retries safe: repeating this ID with the same input returns the first result instead of writing again
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Create a ticket from a Document and link them
    CreateTicket { id: String, title: String },
    /// List only tickets that mention a Document, with passages
    Backlinks {
        id: String,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Create a Document (JSON result includes its id)
    Create {
        /// Optional title; without one the first line of the body is its heading
        #[arg(long, allow_hyphen_values = true)]
        title: Option<String>,
        /// The Markdown body
        #[arg(long, conflicts_with = "body_file", allow_hyphen_values = true)]
        body: Option<String>,
        /// Read the Markdown body from a file (- reads stdin)
        #[arg(long)]
        body_file: Option<String>,
        /// Makes retries safe: repeating this ID with the same input returns the first result instead of writing again
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Show a Document with its full body
    Show { id: String },
    /// Show a Document and record that it was opened
    Open { id: String },
    /// Keep an activity-details Document so it appears in the default Documents list
    Keep { id: String },
    /// List recently opened or changed Documents
    Recent {
        #[arg(long)]
        include_support: bool,
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Search Document titles and bodies
    Search {
        query: String,
        #[arg(long)]
        tag: Option<String>,
        #[arg(long)]
        include_support: bool,
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// List pinned Documents
    Pins {
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Pin a Document (or unpin with --remove)
    Pin {
        id: String,
        #[arg(long)]
        remove: bool,
    },
    /// List a Document's tags
    Tags { id: String },
    /// Add a tag to a Document (or remove with --remove)
    Tag {
        id: String,
        tag: String,
        #[arg(long)]
        remove: bool,
    },
    /// Read a bounded page of Document body text (character offsets)
    Read {
        id: String,
        /// Characters to skip (for paging)
        #[arg(long, default_value_t = 0)]
        offset: usize,
        /// Characters to return (1-65536)
        #[arg(long, default_value_t = 4096, value_parser = clap::value_parser!(u32).range(1..=65536))]
        limit: u32,
    },
    /// List trashed Documents
    TrashList {
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Move a Document to trash
    Trash { id: String },
    /// Restore a Document from trash
    Restore { id: String },
    /// Change a Document's title or body (supply only what changes)
    Change {
        id: String,
        /// Set the title
        #[arg(long, conflicts_with = "clear_title", allow_hyphen_values = true)]
        title: Option<String>,
        /// Remove the title so the heading comes from the body
        #[arg(long)]
        clear_title: bool,
        /// Replace the Markdown body
        #[arg(long, conflicts_with = "body_file", allow_hyphen_values = true)]
        body: Option<String>,
        /// Replace the body with a file's contents (- reads stdin)
        #[arg(long)]
        body_file: Option<String>,
        /// Makes retries safe: repeating this ID with the same input returns the first result instead of writing again
        #[arg(long)]
        request_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum Command {
    /// Manage workspace file snapshots without the desktop running
    Attachment {
        #[command(subcommand)]
        command: AttachmentCommand,
    },
    /// Capture and read Documents
    Document {
        #[command(subcommand)]
        command: DocumentCommand,
    },
    /// Manage a personal ticket reminder (times require an RFC 3339 offset)
    Reminder {
        #[command(subcommand)]
        command: ReminderCommand,
    },
    /// List personal inbox entries (newest first)
    Inbox {
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Save a consistent workspace backup to a new file
    Backup {
        /// The new file to save the backup to; it must not exist
        path: String,
    },
    /// Review backup integrity and retained local bytes as JSON without restoring; exits with an error when the backup cannot be restored
    InspectBackup {
        /// The backup file to review
        path: String,
    },
    /// Restore a workspace backup after closing other ticketd operations
    RestoreWorkspace {
        /// The backup file to restore
        path: String,
        /// Recover into this database path instead of replacing the current workspace; does not switch the desktop workspace
        #[arg(long)]
        target: Option<String>,
    },
    /// Export a portable JSON snapshot to stdout or a new file
    Export {
        /// Write the snapshot to this new file instead of stdout (- also means stdout)
        #[arg(long)]
        file: Option<String>,
    },
    /// Export portable Markdown, referenced files and manifest into a fresh folder; inspect JSON status for omissions
    #[command(group(clap::ArgGroup::new("content").required(true).multiple(false).args(["ticket", "document", "markdown_file"])))]
    ExportMarkdown {
        /// Export this ticket (reference) with its Activities
        #[arg(long)]
        ticket: Option<String>,
        /// Export this Document by ID
        #[arg(long)]
        document: Option<String>,
        /// Export selected/current Markdown from a file (- reads stdin)
        #[arg(long)]
        markdown_file: Option<String>,
        /// Existing parent folder; a new ticketd-export-* directory is created
        #[arg(long)]
        output: String,
    },
    /// Execute a JSON write request (file or - for stdin); prints {"kind","value"}. With --request-id, a retry returns the first result. Other commands print the bare object; `activity add/edit` and `document create/change` also accept --request-id with the same replay behavior
    Write {
        /// The JSON request file (- reads stdin)
        file: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Apply a JSON array of operations from a file or - for stdin
    #[command(after_help = BATCH_HELP)]
    Batch {
        /// The JSON file of operations (- reads stdin)
        file: String,
    },
    /// Manage repository projects
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    /// Create a ticket with a title
    Create {
        title: String,
        /// Link the new ticket to this project ID, overriding the one inferred from the current folder
        #[arg(long)]
        project: Option<String>,
        /// Add the new ticket to this Plan ID
        #[arg(long)]
        plan: Option<String>,
    },
    /// Patch ticket content; use --body-file - to read stdin
    Change {
        reference: String,
        #[arg(long, allow_hyphen_values = true)]
        title: Option<String>,
        #[arg(long, conflicts_with = "body_file", allow_hyphen_values = true)]
        body: Option<String>,
        #[arg(long)]
        body_file: Option<String>,
        #[arg(long, value_parser = parse_status)]
        status: Option<Status>,
        #[arg(long)]
        agent: Option<String>,
        /// Link the ticket to this project ID
        #[arg(long, conflicts_with = "clear_project")]
        project: Option<String>,
        #[arg(long)]
        clear_project: bool,
    },
    /// List trashed tickets
    TrashList,
    /// Move a ticket to trash
    Trash {
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Restore a ticket from trash
    Restore {
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Show ticket history
    History { reference: String },
    /// Manage implementation evidence
    Evidence {
        #[command(subcommand)]
        command: EvidenceCommand,
    },
    /// Manage ticket activities
    Activity {
        #[command(subcommand)]
        command: ActivityCommand,
    },
    /// Add a tag (trimmed and lowercased; duplicates are ignored)
    AddTag {
        reference: String,
        tag: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Remove a tag (trimmed and lowercased; missing memberships are ignored)
    RemoveTag {
        reference: String,
        tag: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Mark a ticket as a duplicate of a canonical ticket; one with blocking dependencies needs the reviewed path (see preview-duplicate)
    MarkDuplicate {
        /// The duplicate ticket to close, for example T-KQ12
        source: String,
        canonical: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Preview dependencies before marking a duplicate; apply your decisions with `ticketd write` and a mark_duplicate_reviewed request (docs/cli.md#duplicates)
    PreviewDuplicate {
        /// The duplicate ticket that would be closed, for example T-KQ12
        source: String,
        canonical: String,
        /// Judge readiness as a separate dependency review, which does not cancel the source
        #[arg(long)]
        separate: bool,
    },
    /// Remove a duplicate designation
    RemoveDuplicate {
        /// The duplicate ticket to reopen, for example T-KQ12
        source: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Add a contextual relationship (kind: related or discovered; source is the work being done)
    AddRelationship {
        /// The ticket whose work led to the link, for example T-KQ12
        source: String,
        /// The ticket it connects to
        target: String,
        /// related or discovered (discovered: the target was found while working on the source)
        kind: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Remove a contextual relationship
    RemoveRelationship {
        /// The ticket the link starts from, for example T-KQ12
        source: String,
        /// The ticket it connects to
        target: String,
        /// related or discovered
        kind: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Add a directed blocking dependency
    AddDependency {
        blocker: String,
        dependent: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Remove a directed blocking dependency
    RemoveDependency {
        blocker: String,
        dependent: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Assign or remove a parent (omit --parent to remove)
    SetParent {
        reference: String,
        #[arg(long)]
        parent: Option<String>,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Manage Plans
    Plan {
        #[command(subcommand)]
        command: PlanCommand,
    },
    /// List tickets with combined filters
    List {
        #[command(flatten)]
        filters: FindArgs,
        #[arg(long)]
        latest_update: bool,
    },
    /// List incoming ticket references with passage context
    Backlinks {
        reference: String,
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Retrieve bounded context; select related scopes explicitly
    Context {
        reference: String,
        /// Include the linked project
        #[arg(long)]
        project: bool,
        /// Include the Plan
        #[arg(long)]
        plan: bool,
        #[arg(long)]
        relationships: bool,
        #[arg(long)]
        activities: bool,
        #[arg(long)]
        latest_update: bool,
        #[arg(long)]
        evidence: bool,
        #[arg(long)]
        backlinks: bool,
        /// The Documents attached to the ticket with `document link-ticket`
        #[arg(long)]
        documents: bool,
        /// The source's comments and events (read-only; authors are the source's, not editing agents)
        #[arg(long)]
        conversation: bool,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Search saved ticket content (literal, ASCII case-insensitive substring)
    Search {
        query: String,
        #[command(flatten)]
        filters: FindArgs,
        #[arg(long)]
        latest_update: bool,
    },
    /// View a bounded dependency graph around a ticket
    Graph {
        #[arg(required_unless_present_any = ["plan", "workspace"], conflicts_with_all = ["plan", "workspace"])]
        reference: Option<String>,
        #[arg(long)]
        plan: Option<String>,
        /// Browse a bounded page of workspace context
        #[arg(long, requires = "context", conflicts_with = "plan")]
        workspace: bool,
        #[arg(long, requires = "workspace")]
        search: Option<String>,
        /// Only items of this kind (for example ticket, plan or document)
        #[arg(long, requires = "workspace")]
        kind: Option<String>,
        #[arg(long, requires = "workspace")]
        tag: Option<String>,
        #[arg(long, requires = "workspace")]
        relationship: Option<String>,
        #[arg(long, requires = "workspace")]
        cursor: Option<String>,
        #[arg(long, requires = "workspace", default_value_t = 3)]
        adjacency_limit: usize,
        /// Show contextual connections rather than dependencies
        #[arg(long, conflicts_with = "plan")]
        context: bool,
        /// Include generated Activity details
        #[arg(long, requires = "context")]
        include_details: bool,
        /// Expand connections around a previously visible item (repeatable)
        #[arg(long, requires = "context")]
        expand: Vec<String>,
        /// Continue a group using its JSON page request (repeatable)
        #[arg(long, requires = "context")]
        page: Vec<String>,
    },
    /// Print the workspace path and format versions as JSON, without creating or migrating it
    Workspace,
    /// Show a ticket by its reference
    Show { reference: String },
    /// Connect and configure ticket sources such as GitHub
    Source {
        #[command(subcommand)]
        command: SourceCommand,
    },
}

/// Settings given on the command line: schema fields as `key=value` (repeat a
/// key or separate values with commas to fill a list) and an optional JSON file.
#[derive(Args, Default)]
struct SourceSettings {
    /// A source setting, for example repositories=owner/name or assignee=octocat
    #[arg(long = "set", value_name = "KEY=VALUE")]
    set: Vec<String>,
    /// A JSON object of settings from a file or - for stdin; --set values win
    #[arg(long)]
    config_file: Option<String>,
}

#[derive(Subcommand)]
enum SourceCommand {
    /// List available sources with their settings schema and saved configuration
    List,
    /// Show a source's saved configuration
    Show { provider: String },
    /// Verify credentials and permissions and name the account in use
    Test { provider: String },
    /// Suggest values for a setting that offers them (such as repositories)
    Options {
        provider: String,
        field: String,
        #[arg(long, default_value = "")]
        query: String,
        #[command(flatten)]
        settings: SourceSettings,
    },
    /// Preview the issues discovery would match; imports and saves nothing
    Preview {
        provider: String,
        #[command(flatten)]
        settings: SourceSettings,
    },
    /// Validate, preview, and save a source's discovery configuration; imports nothing
    Save {
        provider: String,
        #[command(flatten)]
        settings: SourceSettings,
    },
    /// Show each source's last refresh, current failure, and how many tickets are unavailable
    Status,
    /// Import matching issues and refresh every externally owned ticket now, or one ticket
    Refresh {
        /// Refresh only this externally owned ticket, for example T-KQ12
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Make an unavailable externally owned ticket local: keeps its content and work, stops synchronizing it
    TakeOwnership {
        /// The ticket, for example T-KQ12
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Verify the original GitHub host of a legacy ticket using its full issue URL
    ReconcileGithub {
        /// The legacy ticket, for example T-KQ12
        reference: String,
        /// The original issue URL on the GitHub host configured for this command
        #[arg(long)]
        issue: String,
    },
    /// Publish a local Todo, In progress or In review ticket as one ordinary issue.
    /// Use --preview first: it prints exactly what would be sent and sends nothing
    Publish {
        /// The local ticket to publish, for example T-KQ12
        ticket: String,
        #[arg(long, default_value = "github")]
        provider: String,
        /// Where to create the issue, for example owner/name. Defaults to the
        /// ticket's Project remote when listed by the source, or to the only
        /// listed repository. A configured list limits where issues can be sent
        #[arg(long)]
        destination: Option<String>,
        /// Print the title, description, destination and eligibility; create nothing
        #[arg(long)]
        preview: bool,
        /// The fingerprint printed by --preview. Required to use a Project remote
        /// as the default. Refuses publication if the previewed issue changed
        #[arg(long)]
        expect: Option<String>,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Settle a publication whose outcome is unknown, without risking a second issue.
    /// With no flag it prints what is known and unknown and searches the destination
    /// for the issue that may have been created; it changes nothing
    Resolve {
        /// The ticket with the unresolved publication, for example T-KQ12
        ticket: String,
        /// The issue that was created: a number, owner/name#number or a link in the
        /// destination. GitHub verifies it before it is attached
        #[arg(long, conflicts_with = "not_created")]
        issue: Option<String>,
        /// Attach the issue the attempt already recorded, when it recorded one
        #[arg(long, conflicts_with = "not_created")]
        attach: bool,
        /// Confirm nothing was created. Accepted only when GitHub's recent issues in the
        /// destination are read completely and none matches; otherwise it stays unresolved
        #[arg(long)]
        not_created: bool,
        /// With no other flag, skip the search of the destination (no network)
        #[arg(long)]
        no_search: bool,
        /// Record the independently verified host of a legacy attempt without looking up an issue
        #[arg(long, conflicts_with_all = ["issue", "attach", "not_created", "no_search", "accept_different", "agent"])]
        confirm_host: Option<String>,
        /// Attach an issue whose title or description differs from what was sent. Its text
        /// then replaces the ticket's, and the ticket's own text is kept as a note
        #[arg(long)]
        accept_different: bool,
        #[arg(long)]
        agent: Option<String>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum AvailabilityArg {
    Ready,
    Blocked,
}

#[derive(Args)]
struct FindArgs {
    /// Only tickets linked to this project ID
    #[arg(long, conflicts_with = "unlinked")]
    project: Option<String>,
    #[arg(long)]
    unlinked: bool,
    /// Only tickets in this Plan ID
    #[arg(long)]
    plan: Option<String>,
    #[arg(long, value_parser = parse_status)]
    status: Option<Status>,
    /// Require every supplied tag (AND); repeat --tag for multiple tags
    #[arg(long)]
    tag: Vec<String>,
    #[arg(long, value_enum)]
    availability: Option<AvailabilityArg>,
    /// Include the named parent ticket and its subtickets
    #[arg(long)]
    family: Option<String>,
    /// Only tickets owned by a source (for example github) or only local ones (local)
    #[arg(long)]
    source: Option<String>,
    /// Return at most this many results (1-100)
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
    limit: u32,
    #[arg(long, default_value_t = 0)]
    offset: u32,
}
impl FindArgs {
    fn filter(self, query: String) -> Result<TicketFilter, Box<dyn std::error::Error>> {
        // A source that does not exist would silently list nothing: say so instead.
        if let Some(source) = self.source.as_deref().filter(|source| *source != "local") {
            let known: Vec<String> = ticketd_core::source::Engine::builtin()
                .connectors()
                .into_iter()
                .map(|connector| connector.provider)
                .collect();
            if !known.iter().any(|provider| provider == source) {
                return Err(format!(
                    "unknown source '{source}'; choose local or one of: {}",
                    known.join(", ")
                )
                .into());
            }
        }
        Ok(TicketFilter {
            query,
            project: self.project,
            unlinked: self.unlinked,
            plan: self.plan,
            status: self.status,
            tags: self.tag,
            availability: self.availability.map(|a| match a {
                AvailabilityArg::Ready => Availability::Ready,
                AvailabilityArg::Blocked => Availability::Blocked,
            }),
            family: self.family,
            source: self.source.map(|source| {
                if source == "local" {
                    ticketd_core::source::SourceFilter::Local
                } else {
                    ticketd_core::source::SourceFilter::Provider(source)
                }
            }),
            limit: self.limit,
            offset: self.offset,
            ..TicketFilter::default()
        })
    }
}

#[derive(Subcommand)]
enum PlanCommand {
    /// Show a Plan's spec and supporting Documents (add --bodies for their text)
    Context {
        id: String,
        #[arg(long)]
        bodies: bool,
    },
    /// Add a supporting Document to a Plan (or remove with --remove)
    Document {
        id: String,
        document_id: String,
        #[arg(long)]
        remove: bool,
    },
    /// Designate a Plan's primary spec Document, or clear it by omitting the ID
    Spec {
        id: String,
        document_id: Option<String>,
    },
    /// Create a Plan
    Create { name: String },
    /// List Plans (--all includes archived ones)
    List {
        #[arg(long)]
        all: bool,
    },
    /// Show a Plan with its tickets
    Show { id: String },
    /// Rename a Plan
    Rename { id: String, name: String },
    /// Set a Plan's purpose text
    Purpose { id: String, purpose: String },
    /// Archive a Plan
    Archive { id: String },
    /// Make an archived Plan active again
    Reactivate { id: String },
    /// Add a ticket to a Plan
    Add {
        id: String,
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Remove a ticket from its Plan
    Remove {
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
}
#[derive(Subcommand)]
enum ProjectCommand {
    /// Create a project for a repository path
    Create {
        /// The project's name
        name: String,
        /// The repository folder
        path: String,
        /// Use this Project remote (host/owner/name)
        #[arg(long, conflicts_with = "no_remote")]
        remote: Option<String>,
        /// Skip Git remote detection
        #[arg(long)]
        no_remote: bool,
    },
    /// Change a project's name, path, or Project remote
    Edit {
        id: String,
        /// The project's new name
        name: String,
        /// The repository folder
        path: String,
        /// Set the Project remote (host/owner/name)
        #[arg(long, conflicts_with = "clear_remote")]
        remote: Option<String>,
        /// Clear the Project remote
        #[arg(long)]
        clear_remote: bool,
    },
    /// Show a project
    Show { id: String },
    /// Add the Project remote to GitHub discovery and link its existing unlinked tickets
    ConnectSource {
        /// The project's ID
        project: String,
        /// Show the local effect and fingerprint without contacting GitHub
        #[arg(long)]
        preview: bool,
        /// Apply the effect from the reviewed preview
        #[arg(long, required_unless_present = "preview", conflicts_with = "preview")]
        expect: Option<String>,
    },
    /// List projects
    List,
    /// Register another checkout path for a project
    Register {
        id: String,
        /// The checkout folder to register
        path: String,
    },
    /// Remove a registered checkout path from a project
    Unregister {
        id: String,
        /// The registered checkout folder to remove
        path: String,
    },
}

#[derive(Clone, ValueEnum)]
enum EvidenceType {
    // Output spells it `pull_request`; accept that spelling on input too.
    #[value(alias = "pull_request")]
    PullRequest,
    Commit,
    Branch,
    Worktree,
    Verification,
}
impl From<EvidenceType> for EvidenceKind {
    fn from(value: EvidenceType) -> Self {
        match value {
            EvidenceType::PullRequest => Self::PullRequest,
            EvidenceType::Commit => Self::Commit,
            EvidenceType::Branch => Self::Branch,
            EvidenceType::Worktree => Self::Worktree,
            EvidenceType::Verification => Self::Verification,
        }
    }
}
#[derive(Args)]
struct EvidenceFields {
    /// What the evidence is
    #[arg(long, value_enum)]
    kind: EvidenceType,
    /// A short label, for example the PR title or check name
    #[arg(long)]
    name: String,
    #[arg(long)]
    value: String,
    #[arg(long)]
    agent: Option<String>,
}
impl From<EvidenceFields> for EvidenceInput {
    fn from(fields: EvidenceFields) -> Self {
        Self {
            kind: fields.kind.into(),
            name: fields.name,
            value: fields.value,
            editing_agent: fields.agent,
        }
    }
}
#[derive(Subcommand)]
enum EvidenceCommand {
    /// Record evidence (PR, commit, branch, worktree or verification) on a ticket
    Add {
        reference: String,
        #[command(flatten)]
        fields: EvidenceFields,
    },
    /// Replace an evidence item's fields
    Edit {
        reference: String,
        id: String,
        #[command(flatten)]
        fields: EvidenceFields,
    },
    /// Delete an evidence item
    Delete { reference: String, id: String },
    /// List a ticket's evidence
    List {
        reference: String,
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
}
#[derive(Subcommand)]
enum ActivityCommand {
    /// Append an activity, reading --file - from stdin
    Add {
        reference: String,
        /// The brief: a short update that reads on its own. It is Markdown, so write \* and \_ (or wrap in backticks) to keep a literal * or _
        #[arg(long, conflicts_with = "file", allow_hyphen_values = true)]
        brief: Option<String>,
        /// Read the brief from a file (- reads stdin). The text is Markdown: escape \* and \_ (or use backticks) to keep them literal
        #[arg(long, visible_alias = "brief-file")]
        file: Option<String>,
        /// Name of the agent posting this activity, shown beside it
        #[arg(long)]
        agent: Option<String>,
        /// A file holding the activity details; they are saved as a new Document linked to the activity (- reads stdin)
        #[arg(long, conflicts_with = "document")]
        details_file: Option<String>,
        /// The ID of an existing Document to attach as the activity's details
        #[arg(long)]
        document: Option<String>,
        /// Makes retries safe: repeating this ID with the same input returns the first result instead of writing again
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Edit supplied fields of an activity
    Edit {
        reference: String,
        id: String,
        /// The new brief text; it replaces the stored brief. It is Markdown, so write \* and \_ (or wrap in backticks) to keep a literal * or _
        #[arg(long, conflicts_with = "file", allow_hyphen_values = true)]
        brief: Option<String>,
        /// Read the new brief from a file (- reads stdin). The text is Markdown: escape \* and \_ (or use backticks) to keep them literal
        #[arg(long, visible_alias = "brief-file")]
        file: Option<String>,
        /// Name of the agent making this edit, shown beside the activity
        #[arg(long)]
        agent: Option<String>,
        /// Makes retries safe: repeating this ID with the same input returns the first result instead of writing again
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Delete an activity
    Delete { reference: String, id: String },
    /// Read an exact authored activity
    Show { reference: String, id: String },
    /// Read the activity feed, newest first
    List {
        reference: String,
        /// Return at most this many results (1-100)
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
}
/// The reminder a ticket has now, as `reminder show` prints it.
fn reminder_of(
    workspace: &Workspace,
    reference: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let reference = workspace.show_ticket(reference)?.reference;
    let due_at = workspace.reminder(&reference)?;
    Ok(serde_json::to_string(&output::Reminder {
        reference,
        due_at,
    })?)
}
/// Rows of `list` or `search --latest-update`.
fn update_rows(
    rows: &[ticketd_core::TicketWithUpdate],
) -> Result<String, Box<dyn std::error::Error>> {
    let rows: Vec<_> = rows.iter().map(output::UpdateRow).collect();
    Ok(serde_json::to_string(&rows)?)
}
/// Read a text file, naming it in the error: the operating system's message alone
/// ("No such file or directory") does not say which of several files failed.
fn read_text_file(path: &str) -> Result<String, Box<dyn std::error::Error>> {
    std::fs::read_to_string(path).map_err(|error| format!("cannot read {path}: {error}").into())
}
fn read_content(
    content: Option<String>,
    file: Option<String>,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    Ok(match file {
        Some(path) if path == "-" => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            Some(text)
        }
        Some(path) => Some(read_text_file(&path)?),
        None => content,
    })
}
/// An Activity brief read from a file or stdin, without the newline that ends the
/// file, so it matches the same text given with `--brief` or in a write request.
fn read_brief(
    brief: Option<String>,
    file: Option<String>,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let from_file = file.is_some();
    Ok(read_content(brief, file)?.map(|text| {
        if from_file {
            text.trim_end_matches(['\n', '\r']).to_owned()
        } else {
            text
        }
    }))
}

/// Parse a ticket status. The canonical spelling ("In progress") is what the app
/// shows; the lowercase and hyphenated forms agents naturally type are accepted too.
fn parse_status(value: &str) -> Result<Status, String> {
    let normalized = value.trim().replace(['-', '_'], " ").to_lowercase();
    const ALL: [Status; 6] = [
        Status::Todo,
        Status::InProgress,
        Status::InReview,
        Status::Done,
        Status::Canceled,
        Status::Duplicate,
    ];
    ALL.into_iter()
        .find(|status| status.to_string().to_lowercase() == normalized)
        .ok_or_else(|| {
            let valid: Vec<String> = ALL.iter().map(Status::to_string).collect();
            format!(
                "'{value}' is not a status; choose one of: {}",
                valid.join(", ")
            )
        })
}

const BATCH_HELP: &str = "Each operation is a JSON object with an \"operation\" field:\n  \
{\"operation\":\"create\",\"name\":\"parent\",\"title\":\"...\"}   `name` and `title` are required; `project_id` is optional\n  \
{\"operation\":\"change\",\"ticket\":\"$parent\",\"change\":{...}}   `$name` refers to an earlier create\n\
A failure names the zero-based operation index and nothing is applied.";

/// Parse a batch plan one operation at a time so a malformed operation is reported
/// by its index instead of a line and column of the whole document.
fn parse_batch(bytes: &[u8]) -> Result<Vec<BatchOperation>, Box<dyn std::error::Error>> {
    let values: Vec<serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|error| format!("a batch is a JSON array of operations: {error}"))?;
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            serde_json::from_value(value).map_err(|error| {
                let hint = if error.to_string().starts_with("missing field `name`") {
                    " (a create needs a `name` that later operations can use as $name)"
                } else {
                    ""
                };
                format!("batch operation {index}: {error}{hint}").into()
            })
        })
        .collect()
}

/// Help for arguments that share a meaning everywhere; `parents` is the command
/// path so an `id` reads as a Document, Plan, project or activity ID.
fn argument_help(parents: &[String], id: &str) -> Option<&'static str> {
    let group = parents.get(1).map(String::as_str).unwrap_or("");
    Some(match id {
        "id" => match group {
            "attachment" => "The Attachment ID (see `attachment list`)",
            "document" => "The Document ID (see `document recent` or `document search`)",
            "plan" => "The Plan ID (see `plan list`)",
            "project" => "The project ID (see `project list`)",
            "activity" => "The activity ID (see `activity list`)",
            "evidence" => "The evidence ID (see `evidence list`)",
            _ => "The ID",
        },
        "reference" => "The ticket reference, for example T-KQ12",
        "ticket" => "The ticket reference, for example T-KQ12",
        "agent" => "Name of the agent making this change, recorded in history and the feed",
        "offset" => "Skip this many results (for paging)",
        "limit" => "Return at most this many results",
        "title" => "The title",
        "name" => "The name",
        "path" => "A path",
        "target" => "The ticket, Plan or Document to link to",
        "query" => "Text to search for",
        "tag" => "A tag name, for example needs-review",
        "remove" => "Remove instead of add",
        "project" => "A project ID (see `project list`)",
        "plan" => "A Plan ID (see `plan list`)",
        "kind" => "The kind",
        "document_id" => "The Document ID",
        "include_support" => "Include activity-details Documents that were not kept",
        "canonical" => "The canonical (original) ticket reference",
        "blocker" => "The ticket that blocks",
        "dependent" => "The ticket that waits",
        "status" => "A ticket status: Todo, In progress, In review, Done, Canceled or Duplicate",
        "parent" => "The parent ticket reference",
        "purpose" => "The Plan's purpose text",
        "due_at" => "RFC 3339 time with an offset, for example 2026-01-31T09:00:00-05:00",
        "file" => "A file (- reads stdin)",
        "request_id" => {
            "Makes retries safe: repeating this ID with the same input returns the first result instead of writing again"
        }
        "body" => "The Markdown description",
        "body_file" => "Read the description from a file (- reads stdin)",
        "clear_project" => "Unlink the ticket from its project",
        "value" => "The URL, reference, path or verification result",
        "source" => "The source ticket, for example T-KQ12",
        "bodies" => "Include the Documents' text, not only their titles",
        "all" => "Include archived Plans",
        "unlinked" => "Only tickets without a project",
        "availability" => "Only ready or blocked tickets",
        "latest_update" => "Include each ticket's latest update (bounded)",
        "relationships" => "Include relationships",
        "activities" => "Include activities",
        "evidence" => "Include evidence",
        "backlinks" => "Include incoming references",
        "provider" => "The source provider, for example github",
        "field" => "The setting to suggest values for",
        "search" => "Only items whose title or text contains this",
        "relationship" => "Only this kind of relationship",
        "cursor" => "Continue a previous page using its cursor",
        "adjacency_limit" => "Most neighbors to show around each item",
        "context" => "Show contextual connections rather than dependencies",
        "include_details" => "Include generated Activity details",
        "expand" => "Expand connections around a previously visible item (repeatable)",
        "page" => "Continue a group using its JSON page request (repeatable)",
        "workspace" => "Browse the whole workspace rather than one ticket or Plan",
        _ => return None,
    })
}
fn describe(command: clap::Command, parents: &[String]) -> clap::Command {
    let mut path = parents.to_vec();
    path.push(command.get_name().to_owned());
    let named = path.clone();
    command
        .mut_args(move |arg| {
            if arg.get_help().is_none()
                && !matches!(arg.get_id().as_str(), "help" | "version")
                && let Some(text) = argument_help(&named, arg.get_id().as_str())
            {
                return arg.help(text);
            }
            arg
        })
        .mut_subcommands(move |child| describe(child, &path))
}

/// Who ran this command, when a Chat's harness or an Automation run did: the IDs it put in
/// the environment. Read once at startup; blank values count as missing.
struct Origin {
    chat_id: Option<String>,
    automation_run_id: Option<String>,
}

impl Origin {
    fn from_environment() -> Self {
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|id| id.trim().to_owned())
                .filter(|id| !id.is_empty())
        };
        Self {
            chat_id: read(ticketd_core::CHAT_ID_VARIABLE),
            automation_run_id: read(ticketd_core::AUTOMATION_RUN_ID_VARIABLE),
        }
    }
}

fn run(output: &mut impl Write, origin: &Origin) -> Result<(), Box<dyn std::error::Error>> {
    use clap::{CommandFactory, FromArgMatches};
    let args = Arguments::from_arg_matches(&describe(Arguments::command(), &[]).get_matches())
        .unwrap_or_else(|error| error.exit());
    let command = match args.command {
        CliCommand::Skills { command } => return skills::run(command, output),
        CliCommand::Workspace(command) => command,
    };
    if let Command::RestoreWorkspace { path, target } = &command {
        let destination = target
            .as_ref()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("TICKETD_TEST_WORKSPACE").map(std::path::PathBuf::from));
        let restored = match &destination {
            Some(workspace) => ticketd_core::workspace_file(workspace)?,
            None => ticketd_core::default_workspace_file()?,
        };
        let safety = match destination {
            Some(workspace) => Workspace::restore(workspace, path)?,
            None => Workspace::restore_default(path)?,
        };
        writeln!(
            output,
            "{}",
            serde_json::to_string(&output::Restored {
                restored: restored.path,
                safety_backup: safety,
            })?
        )?;
        return Ok(());
    }
    // A status probe reads the file as it is. Opening the workspace would create
    // a missing one or migrate an older one past the version the desktop app supports.
    if matches!(command, Command::Workspace) {
        let file = match std::env::var_os("TICKETD_TEST_WORKSPACE") {
            Some(workspace) => ticketd_core::workspace_file(workspace)?,
            None => ticketd_core::default_workspace_file()?,
        };
        writeln!(
            output,
            "{}",
            serde_json::to_string(&output::WorkspaceStatus {
                path: file.path,
                format_version: file.format_version,
                supported_format_version: ticketd_core::FORMAT_VERSION,
            })?
        )?;
        return Ok(());
    }
    // Integration tests run the real executable against a private database on every OS.
    // ProjectDirs on Windows uses known folders and ignores HOME and XDG_DATA_HOME.
    let mut workspace = match std::env::var_os("TICKETD_TEST_WORKSPACE") {
        Some(path) => Workspace::open(path)?,
        None => Workspace::open_default()?,
    };
    tracing::debug!("workspace opened");
    // Run by a Chat's harness: what this command writes is credited to that Chat.
    if let Some(chat) = &origin.chat_id {
        workspace.act_for_chat(chat)?;
    }
    // Run inside an Automation run: what this command writes cannot trigger Automations.
    if origin.automation_run_id.is_some() {
        workspace.act_for_automation()?;
    }
    let text = match command {
        Command::Attachment { command } => attachment_command(&mut workspace, command)?,
        Command::Document { command } => match command {
            DocumentCommand::References { id, offset } => {
                serde_json::to_string(&workspace.context_links(&id, 100, offset)?)?
            }
            DocumentCommand::Incoming { id, offset } => {
                serde_json::to_string(&workspace.context_backlinks(&id, 100, offset)?)?
            }
            DocumentCommand::Link { target } => workspace.context_link_markdown(&target)?,
            DocumentCommand::LinkTicket {
                id,
                ticket,
                request_id,
            } => bare(workspace.write(
                request_id.as_deref(),
                WriteRequest::SetTicketDocument {
                    reference: ticket,
                    document_id: id,
                    present: true,
                },
            )?)?,
            DocumentCommand::UnlinkTicket {
                id,
                ticket,
                request_id,
            } => bare(workspace.write(
                request_id.as_deref(),
                WriteRequest::SetTicketDocument {
                    reference: ticket,
                    document_id: id,
                    present: false,
                },
            )?)?,
            DocumentCommand::CreateTicket { id, title } => {
                serde_json::to_string(&workspace.create_ticket_from_document(&id, &title)?)?
            }
            DocumentCommand::Backlinks { id, offset } => {
                serde_json::to_string(&workspace.document_backlinks(&id, 100, offset)?)?
            }
            DocumentCommand::Create {
                title,
                body,
                body_file,
                request_id,
            } => {
                if title
                    .as_deref()
                    .is_some_and(|title| title.trim().is_empty())
                {
                    return Err("document title must not be empty; omit --title to use the first line of the body".into());
                }
                let body = read_content(body, body_file)?.unwrap_or_default();
                match request_id {
                    None => {
                        serde_json::to_string(&workspace.create_document(title.as_deref(), &body)?)?
                    }
                    Some(id) => bare(
                        workspace.write(Some(&id), WriteRequest::CreateDocument { title, body })?,
                    )?,
                }
            }
            DocumentCommand::Show { id } => serde_json::to_string(&workspace.show_document(&id)?)?,
            DocumentCommand::Open { id } => serde_json::to_string(&workspace.open_document(&id)?)?,
            DocumentCommand::Keep { id } => {
                bare(workspace.write(None, WriteRequest::KeepDocument { id })?)?
            }
            DocumentCommand::Recent {
                limit,
                offset,
                include_support,
            } => serde_json::to_string(&workspace.recent_documents_including_support(
                limit,
                offset,
                include_support,
            )?)?,
            DocumentCommand::Search {
                query,
                tag,
                include_support,
                limit,
                offset,
            } => serde_json::to_string(&workspace.search_documents_including_support(
                &query,
                tag.as_deref(),
                limit,
                offset,
                include_support,
            )?)?,
            DocumentCommand::Pins { limit, offset } => {
                serde_json::to_string(&workspace.pinned_documents(limit, offset)?)?
            }
            DocumentCommand::Pin { id, remove } => {
                workspace.set_document_pin(&id, !remove)?;
                ok()
            }
            DocumentCommand::Tags { id } => serde_json::to_string(&workspace.document_tags(&id)?)?,
            DocumentCommand::Tag { id, tag, remove } => {
                workspace.set_document_tag(&id, &tag, !remove)?;
                ok()
            }
            DocumentCommand::Read { id, offset, limit } => {
                let document = workspace.show_document(&id)?;
                let limit = usize::try_from(limit)?;
                let mut chars = document.body.chars().skip(offset);
                let body: String = chars.by_ref().take(limit).collect();
                let next_offset = chars.next().map(|_| offset + body.chars().count());
                let fetch = next_offset.map(|next| {
                    format!("ticketd document read {id} --offset {next} --limit {limit}")
                });
                serde_json::to_string(&output::DocumentSlice {
                    id: &document.id,
                    title: &document.title,
                    created_at: &document.created_at,
                    updated_at: &document.updated_at,
                    trashed: document.trashed,
                    body: &body,
                    offset,
                    next_offset,
                    truncated: next_offset.is_some(),
                    fetch,
                })?
            }
            DocumentCommand::TrashList { limit, offset } => {
                serde_json::to_string(&workspace.trashed_documents_page(limit, offset)?)?
            }
            DocumentCommand::Trash { id } => {
                bare(workspace.write(None, WriteRequest::TrashDocument { id })?)?
            }
            DocumentCommand::Restore { id } => {
                bare(workspace.write(None, WriteRequest::RestoreDocument { id })?)?
            }
            DocumentCommand::Change {
                id,
                title,
                clear_title,
                body,
                body_file,
                request_id,
            } => {
                if title
                    .as_deref()
                    .is_some_and(|title| title.trim().is_empty())
                {
                    return Err(
                        "document title must not be empty; use --clear-title to remove it".into(),
                    );
                }
                let patch = DocumentPatch {
                    title: if clear_title {
                        Some(None)
                    } else {
                        title.map(Some)
                    },
                    body: read_content(body, body_file)?,
                    expected_updated_at: None,
                };
                if patch.title.is_none() && patch.body.is_none() {
                    return Err("provide --title, --clear-title, --body or --body-file".into());
                }
                match request_id {
                    None => serde_json::to_string(&workspace.change_document(&id, patch)?)?,
                    Some(request) => bare(
                        workspace
                            .write(Some(&request), WriteRequest::ChangeDocument { id, patch })?,
                    )?,
                }
            }
        },
        Command::Reminder { command } => match command {
            ReminderCommand::Show { reference } => reminder_of(&workspace, &reference)?,
            ReminderCommand::Set { reference, due_at } => {
                workspace.set_reminder(&reference, Some(&due_at))?;
                reminder_of(&workspace, &reference)?
            }
            ReminderCommand::Snooze { reference, due_at } => {
                workspace.snooze_reminder(&reference, &due_at)?;
                reminder_of(&workspace, &reference)?
            }
            ReminderCommand::Dismiss { reference } => {
                let dismissed = workspace.dismiss_reminder(&reference)?;
                serde_json::to_string(&output::Dismissed { dismissed })?
            }
        },
        Command::Inbox { limit, offset } => {
            // The CLI has no reminder poll: reminders due by now arrive before the read.
            workspace.deliver_due_reminders()?;
            serde_json::to_string(&workspace.inbox(limit, offset)?)?
        }
        Command::Backup { path } => {
            workspace.backup(&path)?;
            serde_json::to_string(&output::BackupSaved { path })?
        }
        Command::InspectBackup { path } => {
            let inspection = workspace.inspect_backup(path)?;
            let text = serde_json::to_string(&inspection)?;
            // The report is printed either way; a backup that cannot be restored also fails.
            if let Some(refusal) = inspection.check.refusal() {
                writeln!(output, "{text}")?;
                return Err(refusal.into());
            }
            text
        }
        Command::RestoreWorkspace { .. } => return Err("restore was not performed".into()),
        Command::ExportMarkdown {
            ticket,
            document,
            markdown_file,
            output,
        } => {
            let source = match (ticket, document, markdown_file) {
                (Some(reference), None, None) => {
                    ticketd_core::MarkdownExportSource::Ticket { reference }
                }
                (None, Some(id), None) => ticketd_core::MarkdownExportSource::Document { id },
                (None, None, Some(path)) => {
                    let body = if path == "-" {
                        let mut body = String::new();
                        std::io::stdin().read_to_string(&mut body)?;
                        body
                    } else {
                        std::fs::read_to_string(&path).map_err(|error| {
                            if error.kind() == std::io::ErrorKind::NotFound {
                                format!("file not found: {path}")
                            } else {
                                format!("could not read {path}: {error}")
                            }
                        })?
                    };
                    ticketd_core::MarkdownExportSource::Markdown { body }
                }
                _ => {
                    return Err(
                        "select exactly one of --ticket, --document or --markdown-file".into(),
                    );
                }
            };
            serde_json::to_string_pretty(&workspace.export_markdown_with_files(source, output)?)?
        }
        Command::Export { file } => {
            if let Some(path) = file.filter(|path| path != "-") {
                workspace.export_file(path)?;
                writeln!(output, "{}", ok())?;
                return Ok(());
            }
            serde_json::to_string_pretty(&workspace.export()?)?
        }
        Command::Write { file, request_id } => {
            let input = read_content(None, Some(file))?.ok_or("missing request")?;
            let request: WriteRequest = serde_json::from_str(&input)?;
            serde_json::to_string(&workspace.write(request_id.as_deref(), request)?)?
        }
        Command::Batch { file } => {
            let reader: Box<dyn Read> = if file == "-" {
                Box::new(std::io::stdin())
            } else {
                Box::new(
                    std::fs::File::open(&file)
                        .map_err(|error| format!("cannot read {file}: {error}"))?,
                )
            };
            let mut bytes = Vec::new();
            reader
                .take(1_048_577)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("cannot read {file}: {error}"))?;
            if bytes.len() > 1_048_576 {
                return Err("batch exceeds 1 MiB".into());
            }
            let operations = parse_batch(&bytes)?;
            serde_json::to_string(&workspace.apply_batch(operations)?)?
        }
        Command::Project { command } => match command {
            ProjectCommand::Create {
                name,
                path,
                remote,
                no_remote,
            } => {
                let remote = remote.or_else(|| {
                    if no_remote {
                        return None;
                    }
                    ticketd_core::detect_project_remote(std::path::Path::new(path.trim())).suggested
                });
                let project = workspace.create_project_with_remote(
                    &name,
                    &path,
                    remote.as_deref(),
                )?;
                if project.remote.is_some() {
                    eprintln!(
                        "hint: Preview connecting this project with `ticketd project connect-source {} --preview`.",
                        project.id
                    );
                }
                serde_json::to_string(&project)?
            }
            ProjectCommand::Edit {
                id,
                name,
                path,
                remote,
                clear_remote,
            } => {
                let remote = match remote.as_deref() {
                    Some(remote) => ProjectRemoteChange::Set(remote),
                    None if clear_remote => ProjectRemoteChange::Clear,
                    None => ProjectRemoteChange::Keep,
                };
                serde_json::to_string(&workspace.edit_project_with_remote(&id, &name, &path, remote)?)?
            }
            ProjectCommand::Show { id } => serde_json::to_string(&workspace.show_project(&id)?)?,
            ProjectCommand::ConnectSource {
                project,
                preview,
                expect,
            } => {
                let engine = ticketd_core::source::Engine::builtin();
                if preview {
                    serde_json::to_string(&workspace.preview_connect_source(
                        &engine, "github", &project,
                    )?)?
                } else {
                    let fingerprint = expect.as_deref().ok_or("supply --expect FINGERPRINT or --preview")?;
                    serde_json::to_string(&workspace.connect_source(
                        &engine, "github", &project, fingerprint,
                    )?)?
                }
            }
            ProjectCommand::Register { id, path } => {
                let registration = workspace.register_checkout_with_warning(&id, &path)?;
                if let Some(warning) = registration.warning {
                    eprintln!(
                        "warning: The checkout's detected remote {} differs from the Project remote {}.",
                        warning.checkout_remote, warning.project_remote
                    );
                }
                serde_json::to_string(&registration.project)?
            }
            ProjectCommand::Unregister { id, path } => {
                serde_json::to_string(&workspace.remove_checkout(&id, &path)?)?
            }
            ProjectCommand::List => serde_json::to_string(&workspace.list_projects()?)?,
        },
        Command::Create {
            title,
            project,
            plan,
        } => {
            let inferred = if project.is_none() {
                workspace.resolve_project(&std::env::current_dir()?)?
            } else {
                None
            };
            let project = project
                .as_deref()
                .or_else(|| inferred.as_ref().map(|p| p.id.as_str()));
            serde_json::to_string(&workspace.create_ticket_in_context(
                &title,
                project,
                plan.as_deref(),
            )?)?
        }
        Command::Change {
            reference,
            title,
            body,
            body_file,
            status,
            agent,
            project,
            clear_project,
        } => {
            let body = match body_file {
                Some(path) if path == "-" => {
                    let mut content = String::new();
                    std::io::stdin().read_to_string(&mut content)?;
                    Some(content)
                }
                Some(path) => Some(read_text_file(&path)?),
                None => body,
            };
            serde_json::to_string(&workspace.change_ticket(
                &reference,
                TicketPatch {
                    title,
                    body,
                    status,
                    editing_agent: agent,
                    plan_id: None,
                    project_id: if clear_project {
                        Some(None)
                    } else {
                        project.map(Some)
                    },
                    // The CLI never guards on a base revision: its change always applies.
                    ..TicketPatch::default()
                },
            )?)?
        }
        Command::Evidence { command } => match command {
            EvidenceCommand::Add { reference, fields } => {
                serde_json::to_string(&workspace.add_evidence(&reference, fields.into())?)?
            }
            EvidenceCommand::Edit {
                reference,
                id,
                fields,
            } => {
                serde_json::to_string(&workspace.edit_evidence(&reference, &id, fields.into())?)?
            }
            EvidenceCommand::Delete { reference, id } => {
                workspace.delete_evidence(&reference, &id)?;
                ok()
            }
            EvidenceCommand::List {
                reference,
                limit,
                offset,
            } => serde_json::to_string(&workspace.evidence(&reference, limit, offset)?)?,
        },
        Command::Activity { command } => match command {
            ActivityCommand::Add {
                reference,
                brief,
                file,
                agent,
                details_file,
                document,
                request_id,
            } => {
                if file.as_deref() == Some("-") && details_file.as_deref() == Some("-") {
                    return Err("brief and details cannot both read from stdin".into());
                }
                let brief = read_brief(brief, file)?.ok_or("provide --brief or --file")?;
                let details = read_content(None, details_file)?;
                if request_id.is_some() {
                    bare(workspace.write(
                        request_id.as_deref(),
                        WriteRequest::AddActivityWithDetails {
                            reference,
                            brief,
                            agent,
                            details,
                            existing_document_id: document,
                        },
                    )?)?
                } else {
                    serde_json::to_string(&workspace.add_activity_with_details(
                        &reference,
                        &brief,
                        agent.as_deref(),
                        details.as_deref(),
                        document.as_deref(),
                    )?)?
                }
            }
            ActivityCommand::Edit {
                reference,
                id,
                brief,
                file,
                agent,
                request_id,
            } => {
                let patch = ActivityPatch {
                    brief: read_brief(brief, file)?,
                    editing_agent: agent,
                };
                if patch.brief.is_none() && patch.editing_agent.is_none() {
                    return Err("provide --brief or --file (or --agent) to change".into());
                }
                if request_id.is_some() {
                    bare(workspace.write(
                        request_id.as_deref(),
                        WriteRequest::EditActivity {
                            reference,
                            id,
                            patch,
                        },
                    )?)?
                } else {
                    serde_json::to_string(&workspace.edit_activity(&reference, &id, patch)?)?
                }
            }
            ActivityCommand::Delete { reference, id } => {
                workspace.delete_activity(&reference, &id)?;
                ok()
            }
            ActivityCommand::Show { reference, id } => {
                serde_json::to_string(&workspace.activity(&reference, &id)?)?
            }
            ActivityCommand::List {
                reference,
                limit,
                offset,
            } => serde_json::to_string(&workspace.activity_feed(&reference, limit, offset)?)?,
        },
        Command::TrashList => serde_json::to_string(&workspace.list_trash()?)?,
        Command::Trash { reference, agent } => {
            serde_json::to_string(&workspace.set_trashed(&reference, true, agent.as_deref())?)?
        }
        Command::Restore { reference, agent } => {
            serde_json::to_string(&workspace.set_trashed(&reference, false, agent.as_deref())?)?
        }
        Command::History { reference } => {
            serde_json::to_string(&workspace.ticket_history(&reference)?)?
        }
        Command::AddTag {
            reference,
            tag,
            agent,
        } => serde_json::to_string(&workspace.add_tag_as(&reference, &tag, agent.as_deref())?)?,
        Command::RemoveTag {
            reference,
            tag,
            agent,
        } => {
            serde_json::to_string(&workspace.remove_tag_as(&reference, &tag, agent.as_deref())?)?
        }
        Command::MarkDuplicate {
            source,
            canonical,
            agent,
        } => serde_json::to_string(
            &workspace
                .mark_duplicate(&source, &canonical, agent.as_deref())
                .map_err(|error| match error {
                    ticketd_core::Error::DuplicateDependencies => format!(
                        "{error}; run `ticketd preview-duplicate {source} {canonical}`, then apply the reviewed decisions with `ticketd write` (mark_duplicate_reviewed, see docs/cli.md#duplicates)"
                    ),
                    other => other.to_string(),
                })?,
        )?,
        Command::PreviewDuplicate {
            source,
            canonical,
            separate,
        } => serde_json::to_string(&if separate {
            workspace.preview_dependency_move(&source, &canonical)?
        } else {
            workspace.preview_duplicate_dependencies(&source, &canonical)?
        })?,
        Command::RemoveDuplicate { source, agent } => {
            serde_json::to_string(&workspace.remove_duplicate(&source, agent.as_deref())?)?
        }
        Command::AddRelationship {
            source,
            target,
            kind,
            agent,
        } => {
            let kind = parse_relationship_kind(&kind)?;
            serde_json::to_string(&workspace.add_contextual_relationship(
                &source,
                &target,
                kind,
                agent.as_deref(),
            )?)?
        }
        Command::RemoveRelationship {
            source,
            target,
            kind,
            agent,
        } => {
            let kind = parse_relationship_kind(&kind)?;
            serde_json::to_string(&workspace.remove_contextual_relationship(
                &source,
                &target,
                kind,
                agent.as_deref(),
            )?)?
        }
        Command::AddDependency {
            blocker,
            dependent,
            agent,
        } => serde_json::to_string(&workspace.add_dependency(
            &blocker,
            &dependent,
            agent.as_deref(),
        )?)?,
        Command::RemoveDependency {
            blocker,
            dependent,
            agent,
        } => serde_json::to_string(&workspace.remove_dependency(
            &blocker,
            &dependent,
            agent.as_deref(),
        )?)?,
        Command::SetParent {
            reference,
            parent,
            agent,
        } => serde_json::to_string(&workspace.set_parent(
            &reference,
            parent.as_deref(),
            agent.as_deref(),
        )?)?,
        Command::Plan { command } => match command {
            PlanCommand::Context { id, bodies } => {
                serde_json::to_string(&workspace.plan_context(&id, bodies)?)?
            }
            PlanCommand::Document {
                id,
                document_id,
                remove,
            } => {
                serde_json::to_string(&workspace.set_plan_document(&id, &document_id, !remove)?)?
            }
            PlanCommand::Spec { id, document_id } => {
                serde_json::to_string(&workspace.set_plan_spec(&id, document_id.as_deref())?)?
            }
            PlanCommand::Create { name } => serde_json::to_string(&workspace.create_plan(&name)?)?,
            PlanCommand::List { all } => serde_json::to_string(&workspace.list_plans(all)?)?,
            PlanCommand::Show { id } => serde_json::to_string(&workspace.show_plan(&id)?)?,
            PlanCommand::Rename { id, name } => {
                serde_json::to_string(&workspace.change_plan(&id, Some(&name), None)?)?
            }
            PlanCommand::Purpose { id, purpose } => {
                serde_json::to_string(&workspace.set_plan_purpose(&id, &purpose)?)?
            }
            PlanCommand::Archive { id } => {
                serde_json::to_string(&workspace.change_plan(&id, None, Some(true))?)?
            }
            PlanCommand::Reactivate { id } => {
                serde_json::to_string(&workspace.change_plan(&id, None, Some(false))?)?
            }
            PlanCommand::Add {
                id,
                reference,
                agent,
            } => serde_json::to_string(&workspace.set_plan(
                &reference,
                Some(&id),
                agent.as_deref(),
            )?)?,
            PlanCommand::Remove { reference, agent } => {
                serde_json::to_string(&workspace.set_plan(&reference, None, agent.as_deref())?)?
            }
        },
        Command::List {
            filters,
            latest_update,
        } => {
            let filter = filters.filter(String::new())?;
            if latest_update {
                update_rows(&workspace.find_tickets_with_updates(&filter)?)?
            } else {
                serde_json::to_string(&workspace.find_tickets(&filter)?)?
            }
        }
        Command::Search {
            query,
            filters,
            latest_update,
        } => {
            let filter = filters.filter(query)?;
            if latest_update {
                update_rows(&workspace.find_tickets_with_updates(&filter)?)?
            } else {
                serde_json::to_string(&workspace.find_tickets(&filter)?)?
            }
        }
        Command::Backlinks {
            reference,
            limit,
            offset,
        } => serde_json::to_string(&workspace.backlinks(&reference, limit, offset)?)?,
        Command::Context {
            reference,
            project,
            plan,
            relationships,
            activities,
            latest_update,
            evidence,
            backlinks,
            documents,
            conversation,
            offset,
        } => serde_json::to_string(&workspace.ticket_context(
            &reference,
            ContextOptions {
                project,
                plan,
                relationships,
                activities,
                latest_update,
                evidence,
                backlinks,
                documents,
                conversation,
                offset,
            },
        )?)?,

        Command::Graph {
            reference,
            plan,
            context,
            include_details,
            workspace: workspace_scope,
            search,
            kind,
            tag,
            relationship,
            cursor,
            adjacency_limit,
            expand,
            page,
        } => {
            if workspace_scope {
                serde_json::to_string(&workspace.workspace_graph(
                    &ticketd_core::WorkspaceGraphRequest {
                        cursor,
                        search,
                        kind,
                        tag,
                        relationship,
                        include_details,
                        adjacency_limit,
                        ..Default::default()
                    },
                )?)?
            } else if context {
                let pages = page
                    .iter()
                    .map(|value| serde_json::from_str(value))
                    .collect::<Result<Vec<ticketd_core::ContextGraphPage>, _>>()?;
                serde_json::to_string(&workspace.context_graph_with_pages(
                    reference.as_deref().unwrap_or_default(),
                    include_details,
                    &expand,
                    &pages,
                )?)?
            } else if let Some(plan) = plan {
                serde_json::to_string(&workspace.plan_dependency_graph(&plan)?)?
            } else {
                serde_json::to_string(
                    &workspace.dependency_graph(reference.as_deref().unwrap_or_default())?,
                )?
            }
        }
        Command::Workspace => return Err("workspace status was not printed".into()),
        Command::Show { reference } => serde_json::to_string(&workspace.show_ticket(&reference)?)?,
        Command::Source {
            command: SourceCommand::Refresh { ticket },
        } => {
            let report = workspace.refresh_sources(
                &ticketd_core::source::Engine::builtin(),
                &ticketd_core::source::RefreshOptions { ticket, now: None },
            )?;
            // The report is always printed; a failed refresh also fails the command so
            // scripts and agents notice that the saved content is not current.
            writeln!(output, "{}", serde_json::to_string(&report)?)?;
            if let Some(failure) = report.failures.first() {
                return Err(format!(
                    "refresh failed for {} ({}): {}{}",
                    failure.reference.as_deref().unwrap_or(&failure.provider),
                    failure.code,
                    failure.message,
                    if failure.code == "unauthenticated" {
                        format!(" {}", token_hint())
                    } else {
                        String::new()
                    }
                )
                .into());
            }
            return Ok(());
        }
        Command::Source {
            command: SourceCommand::ReconcileGithub { reference, issue },
        } => serde_json::to_string(&workspace.reconcile_github_issue(
            &ticketd_core::source::Engine::builtin(),
            &reference,
            &issue,
        )?)?,
        Command::Source {
            command:
                SourceCommand::Publish {
                    ticket,
                    provider,
                    destination,
                    preview,
                    expect,
                    agent,
                },
        } => {
            let engine = ticketd_core::source::Engine::builtin();
            if preview {
                serde_json::to_string(&workspace.preview_publication(
                    &engine,
                    &ticket,
                    &provider,
                    destination.as_deref(),
                )?)?
            } else {
                let result = workspace.publish_ticket(
                    &engine,
                    &ticket,
                    &ticketd_core::source::PublishOptions {
                        provider: provider.clone(),
                        destination,
                        now: None,
                        expected_fingerprint: expect,
                        agent,
                    },
                );
                if let Err(ticketd_core::Error::Publication(error)) = &result {
                    // The attempt this command made is printed so a script or agent
                    // can see what was recorded, even though the command fails.
                    if !matches!(
                        error,
                        ticketd_core::source::PublicationError::Ineligible { .. }
                    ) && let Some(attempt) = workspace.publication_attempts(&ticket)?.first()
                    {
                        writeln!(output, "{}", serde_json::to_string(attempt)?)?;
                    }
                    return Err(match error {
                        ticketd_core::source::PublicationError::Ineligible {
                            reason: ticketd_core::source::IneligibleReason::SourceNotConnected,
                            ..
                        } => format!(
                            "{error}; from the command line, run `ticketd source save {provider} --set repositories=owner/name`"
                        ),
                        ticketd_core::source::PublicationError::Unresolved { .. } => format!(
                            "{error}. Do not publish {ticket} again by hand; run `ticketd source resolve {ticket}` to review the open attempt and settle it"
                        ),
                        _ => error.to_string(),
                    }
                    .into());
                }
                serde_json::to_string(&result?)?
            }
        }
        Command::Source {
            command:
                SourceCommand::Resolve {
                    ticket,
                    confirm_host: Some(host),
                    ..
                },
        } => serde_json::to_string(&workspace.confirm_publication_host(
            &ticketd_core::source::Engine::builtin(),
            &ticket,
            &host,
        )?)?,
        Command::Source {
            command:
                SourceCommand::Resolve {
                    ticket,
                    issue,
                    attach,
                    not_created,
                    no_search,
                    confirm_host: None,
                    accept_different,
                    agent,
                },
        } => {
            use ticketd_core::source::{PublicationError, Resolution, ResolveOptions};
            let engine = ticketd_core::source::Engine::builtin();
            let resolution = if not_created {
                Some(Resolution::NotCreated)
            } else if attach || issue.is_some() {
                Some(Resolution::Attach { issue })
            } else {
                None
            };
            match resolution {
                None => serde_json::to_string(
                    &workspace.review_publication(&engine, &ticket, !no_search)?,
                )?,
                Some(resolution) => {
                    let result = workspace.resolve_publication(
                        &engine,
                        &ticket,
                        &ResolveOptions {
                            resolution,
                            now: None,
                            agent,
                            accept_different_content: accept_different,
                        },
                    );
                    if let Err(ticketd_core::Error::Publication(error)) = &result {
                        // Whatever happened, print the attempt as it stands so a script
                        // or agent sees that it is still unresolved (or was settled).
                        if !matches!(error, PublicationError::NothingToResolve { .. })
                            && let Some(attempt) = workspace.publication_attempts(&ticket)?.first()
                        {
                            writeln!(output, "{}", serde_json::to_string(attempt)?)?;
                        }
                        return Err(match error {
                            PublicationError::DifferentContent { .. } => format!(
                                "{error}. Run the command again with --accept-different to attach it anyway"
                            ),
                            PublicationError::Unverified { .. }
                            | PublicationError::Candidates { .. }
                            | PublicationError::Mismatch { .. } => format!(
                                "{error}. Run `ticketd source resolve {ticket}` to review what is known"
                            ),
                            _ => error.to_string(),
                        }
                        .into());
                    }
                    serde_json::to_string(&result?)?
                }
            }
        }
        Command::Source { command } => source_command(&mut workspace, command)?,
    };
    writeln!(output, "{text}")?;
    Ok(())
}

fn source_command(
    workspace: &mut Workspace,
    command: SourceCommand,
) -> Result<String, Box<dyn std::error::Error>> {
    use ticketd_core::source::{ConfigValues, Engine, SourceError};
    let engine = Engine::builtin();
    // Settings given on the command line, or else the saved configuration.
    let resolve = |workspace: &Workspace,
                   provider: &str,
                   settings: SourceSettings|
     -> Result<ConfigValues, Box<dyn std::error::Error>> {
        let given = !settings.set.is_empty() || settings.config_file.is_some();
        if !given {
            return Ok(workspace
                .saved_source(provider)?
                .map(|saved| saved.config)
                .unwrap_or_default());
        }
        let schema = engine.descriptor(provider)?.schema;
        // Name the file in every failure, so a script knows which option caused it.
        let file = settings.config_file.clone().unwrap_or_default();
        let name = if file == "-" { "standard input" } else { &file };
        let text = match read_content(None, settings.config_file) {
            Ok(text) => text,
            Err(error) => {
                return Err(format!("could not read the --config-file {name}: {error}").into());
            }
        };
        let mut values = match text {
            Some(text) => match serde_json::from_str(&text) {
                Ok(serde_json::Value::Object(values)) => values,
                Ok(_) => {
                    return Err(format!(
                        "the --config-file {name} must hold a JSON object of settings"
                    )
                    .into());
                }
                Err(error) => {
                    return Err(
                        format!("the --config-file {name} is not valid JSON: {error}").into(),
                    );
                }
            },
            None => ConfigValues::new(),
        };
        values.extend(
            schema
                .values_from_assignments(&settings.set)
                .map_err(SourceError::InvalidConfiguration)?,
        );
        Ok(values)
    };
    Ok(match command {
        SourceCommand::List => {
            let mut sources = Vec::new();
            for descriptor in engine.connectors() {
                let saved = workspace.saved_source(&descriptor.provider)?;
                sources.push(output::SourceListing {
                    connector: descriptor,
                    saved,
                });
            }
            serde_json::to_string(&sources)?
        }
        SourceCommand::Show { provider } => {
            engine.descriptor(&provider)?;
            serde_json::to_string(&workspace.saved_source(&provider)?)?
        }
        SourceCommand::Test { provider } => {
            let values = workspace
                .saved_source(&provider)?
                .map(|saved| saved.config)
                .unwrap_or_default();
            serde_json::to_string(&engine.check_connection(&provider, &values)?)?
        }
        SourceCommand::Options {
            provider,
            field,
            query,
            settings,
        } => {
            let values = resolve(workspace, &provider, settings)?;
            serde_json::to_string(&engine.options(&provider, &field, &query, &values)?)?
        }
        SourceCommand::Preview { provider, settings } => {
            let values = resolve(workspace, &provider, settings)?;
            serde_json::to_string(&workspace.preview_source(&engine, &provider, &values)?)?
        }
        SourceCommand::Save { provider, settings } => {
            let values = resolve(workspace, &provider, settings)?;
            serde_json::to_string(&workspace.save_source(&engine, &provider, &values)?)?
        }
        SourceCommand::Status => serde_json::to_string(&workspace.source_statuses()?)?,
        SourceCommand::TakeOwnership { reference, agent } => {
            serde_json::to_string(&workspace.take_ownership(&reference, agent.as_deref())?)?
        }
        SourceCommand::Refresh { .. }
        | SourceCommand::ReconcileGithub { .. }
        | SourceCommand::Publish { .. }
        | SourceCommand::Resolve { .. } => unreachable_refresh()?,
    })
}

fn unreachable_refresh() -> Result<String, Box<dyn std::error::Error>> {
    Err("refresh and publish are handled before source configuration commands".into())
}

/// The command line's own way to sign in; the desktop app has its own guidance.
fn token_hint() -> &'static str {
    ticketd_core::source::SourceError::sign_in_hint(ticketd_core::source::Surface::Terminal)
}

fn main() {
    ticketd_diagnostics::init_cli();
    let origin = Origin::from_environment();
    let correlation = ticketd_diagnostics::cli_span(
        origin.chat_id.as_deref(),
        origin.automation_run_id.as_deref(),
    );
    let _correlation = correlation.enter();
    if let Err(error) = run(&mut std::io::stdout().lock(), &origin) {
        // The `error:` line below is the command's answer to the person or agent that ran
        // it. This is the diagnostic record of the same failure, for `TICKETD_LOG=debug`.
        tracing::debug!(
            error_kind = error
                .downcast_ref::<ticketd_core::Error>()
                .map_or("other", |error| error.kind().code()),
            "command failed"
        );
        use ticketd_core::source::SourceError;
        let unauthenticated = match error.downcast_ref::<ticketd_core::Error>() {
            Some(ticketd_core::Error::Source(SourceError::Unauthenticated(_))) => true,
            _ => matches!(
                error.downcast_ref::<SourceError>(),
                Some(SourceError::Unauthenticated(_))
            ),
        };
        if unauthenticated {
            eprintln!("error: {error} {}", token_hint());
        } else {
            eprintln!("error: {error}");
        }
        std::process::exit(1);
    }
}

fn attachment_command(
    workspace: &mut Workspace,
    command: AttachmentCommand,
) -> Result<String, Box<dyn std::error::Error>> {
    let status_only = matches!(&command, AttachmentCommand::DriveStatus { .. });
    Ok(match command {
        AttachmentCommand::Purge { id, confirm: _ } => {
            serde_json::to_string(&workspace.purge_attachment(&id)?)?
        }
        AttachmentCommand::RemoveFromTicketd { id, request_id } => match workspace.write(
            request_id.as_deref(),
            WriteRequest::RemoveRemoteAttachment { id },
        )? {
            WriteResult::RemoteAttachmentRemoved(result) => serde_json::to_string(&result)?,
            _ => return Err("Unexpected remote removal result".into()),
        },
        AttachmentCommand::CleanupReview { id, limit, offset } => match id {
            Some(id) => serde_json::to_string(&workspace.attachment_cleanup_review(&id)?)?,
            None => serde_json::to_string(&workspace.attachment_cleanup_reviews(limit, offset)?)?,
        },
        AttachmentCommand::Quarantine { id, request_id } => match workspace.write(
            request_id.as_deref(),
            WriteRequest::QuarantineAttachment { id },
        )? {
            WriteResult::Attachment(file) => serde_json::to_string(&file)?,
            _ => return Err("unexpected quarantine result".into()),
        },
        AttachmentCommand::Restore { id, request_id } => match workspace.write(
            request_id.as_deref(),
            WriteRequest::RestoreAttachment { id },
        )? {
            WriteResult::Attachment(file) => serde_json::to_string(&file)?,
            _ => return Err("unexpected restore result".into()),
        },
        AttachmentCommand::Search {
            search,
            state,
            related_ticket,
            limit,
            offset,
        } => serde_json::to_string(&workspace.search_attachments(
            &ticketd_core::AttachmentQuery {
                search,
                state: match state {
                    AttachmentStateArg::All => ticketd_core::AttachmentState::All,
                    AttachmentStateArg::InUse => ticketd_core::AttachmentState::InUse,
                    AttachmentStateArg::Unused => ticketd_core::AttachmentState::Unused,
                    AttachmentStateArg::Quarantined => ticketd_core::AttachmentState::Quarantined,
                },
                ticket: related_ticket,
                limit,
                offset,
            },
        )?)?,
        AttachmentCommand::Rename {
            id,
            display_name,
            request_id,
        } => match workspace.write(
            request_id.as_deref(),
            WriteRequest::RenameAttachment { id, display_name },
        )? {
            WriteResult::Attachment(file) => serde_json::to_string(&file)?,
            _ => return Err("unexpected attachment rename result".into()),
        },
        AttachmentCommand::Limit { bytes } => {
            if let Some(bytes) = bytes {
                workspace.set_attachment_upload_limit(bytes)?;
            }
            serde_json::to_string(&output::AttachmentLimit {
                limit_bytes: workspace.attachment_upload_limit()?,
                default_bytes: ticketd_core::DEFAULT_ATTACHMENT_LIMIT,
            })?
        }
        AttachmentCommand::Destination {
            local,
            drive,
            connection,
            folder,
            resource_key,
        } => {
            let saved = if local {
                workspace.set_local_upload_destination()?
            } else if drive {
                let connection = connection.ok_or("--drive requires --connection")?;
                let destination = ticketd_core::drive::DriveUploadDestination {
                    connection_id: connection.clone(),
                    folder_id: folder.ok_or("--drive requires --folder")?,
                    resource_key,
                };
                let transport = ticketd_core::drive::GoogleTransport::default();
                let provider = ticketd_core::drive::GoogleDrive::new(
                    &connection,
                    &ticketd_core::drive::PlatformCredentialStore,
                    &transport,
                );
                workspace.set_drive_upload_destination(&destination, &provider)?
            } else {
                workspace.attachment_upload_destination()?
            };
            serde_json::to_string(&saved)?
        }
        AttachmentCommand::Add {
            path,
            ticket,
            name,
            request_id,
            local,
        } => {
            let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let destination = workspace.begin_attachment_upload(
                &request_id,
                local.then_some(ticketd_core::AttachmentUploadDestination::Local),
            )?;
            let file = match destination {
                ticketd_core::AttachmentUploadDestination::Local => {
                    let result = workspace.write(
                        Some(&request_id),
                        WriteRequest::ImportAttachment {
                            source: path,
                            display_name: name.clone(),
                        },
                    )?;
                    let WriteResult::Attachment(file) = result else {
                        return Err("unexpected attachment result".into());
                    };
                    file
                }
                ticketd_core::AttachmentUploadDestination::GoogleDrive { destination, .. } => {
                    let transport = ticketd_core::drive::GoogleTransport::default();
                    let provider = ticketd_core::drive::GoogleDrive::new(
                        &destination.connection_id,
                        &ticketd_core::drive::PlatformCredentialStore,
                        &transport,
                    );
                    let file = workspace.upload_drive_file(
                        &request_id,
                        &path,
                        &destination,
                        &provider,
                        |_, _| true,
                    ).map_err(|error| format!("Upload request {request_id} did not finish: {error}. Retry the same file with `attachment add --request-id {request_id}`; its original destination is retained. Use a new request ID for an explicit alternative."))?;
                    if let Some(display_name) = name {
                        match workspace.write(
                            Some(&format!("upload-name:{request_id}")),
                            WriteRequest::RenameAttachment {
                                id: file.id.clone(),
                                display_name,
                            },
                        )? {
                            WriteResult::Attachment(file) => file,
                            _ => return Err("unexpected attachment rename result".into()),
                        }
                    } else {
                        file
                    }
                }
            };
            if let Some(ticket) = ticket {
                workspace.set_ticket_attachment(&ticket, &file.id, true).map_err(|error| {
                    format!("attachment stored as {}; ticket association failed: {error}. Reuse it with `ticketd attachment link {} {ticket}`", file.id, file.id)
                })?;
            }
            serde_json::to_string(&file)?
        }
        AttachmentCommand::List {
            ticket,
            limit,
            offset,
        } => serde_json::to_string(&match ticket {
            Some(ticket) => workspace
                .ticket_attachments(&ticket)?
                .into_iter()
                .skip(offset as usize)
                .take(limit.min(1000) as usize)
                .collect(),
            None => workspace.attachments(limit, offset)?,
        })?,
        AttachmentCommand::Inspect { id } => serde_json::to_string(&workspace.attachment(&id)?)?,
        AttachmentCommand::DriveInfo { id } => {
            serde_json::to_string(&workspace.drive_reference(&id)?)?
        }
        AttachmentCommand::DriveUploads => serde_json::to_string(&workspace.drive_uploads()?)?,
        AttachmentCommand::DriveUploadStatus { request_id, check } => {
            let operation = workspace.drive_upload(&request_id)?;
            if check {
                let transport = ticketd_core::drive::GoogleTransport::default();
                let provider = ticketd_core::drive::GoogleDrive::new(
                    &operation.request.destination.connection_id,
                    &ticketd_core::drive::PlatformCredentialStore,
                    &transport,
                );
                serde_json::to_string(&workspace.check_drive_upload(&request_id, &provider)?)?
            } else {
                serde_json::to_string(&operation)?
            }
        }
        AttachmentCommand::DriveUpload {
            path,
            connection,
            folder,
            resource_key,
            request_id,
            ticket,
        } => {
            let transport = ticketd_core::drive::GoogleTransport::default();
            let provider = ticketd_core::drive::GoogleDrive::new(
                &connection,
                &ticketd_core::drive::PlatformCredentialStore,
                &transport,
            );
            let destination = ticketd_core::drive::DriveUploadDestination {
                connection_id: connection.clone(),
                folder_id: folder,
                resource_key,
            };
            let file = workspace.upload_drive_file(
                &request_id,
                &path,
                &destination,
                &provider,
                |_, _| true,
            )?;
            if let Some(ticket) = ticket {
                workspace.set_ticket_attachment(&ticket,&file.id,true).map_err(|error|format!("Uploaded copy saved as {}; association failed: {error}; the remote file remains in Drive. Reuse with ticketd attachment link {} {ticket}",file.id,file.id))?;
            }
            serde_json::to_string(&file)?
        }
        AttachmentCommand::DriveAdd {
            connection,
            file_id,
            resource_key,
            ticket,
        } => {
            let transport = ticketd_core::drive::GoogleTransport::default();
            let provider = ticketd_core::drive::GoogleDrive::new(
                &connection,
                &ticketd_core::drive::PlatformCredentialStore,
                &transport,
            );
            let file = workspace.reference_drive_file(
                &connection,
                &file_id,
                resource_key.as_deref(),
                &provider,
            )?;
            if let Some(ticket) = ticket {
                workspace.set_ticket_attachment(&ticket, &file.id, true).map_err(|error| format!("Drive reference saved as {}; association failed: {error}; reuse with `ticketd attachment link {} {ticket}`", file.id, file.id))?;
            }
            serde_json::to_string(&file)?
        }
        AttachmentCommand::DriveAuthorize { id } => {
            let session = workspace.begin_drive_reference_recovery(
                &id,
                ticketd_core::drive::DesktopOAuthClient::from_environment()?,
                std::time::Duration::from_secs(180),
            )?;
            let reference = workspace.drive_reference(&id)?;
            eprintln!(
                "Open this URL in your system browser, reconnect with the original Google account, and select only {} (file ID {}). No sharing changes will be made:\n{}",
                reference.metadata.name,
                reference.metadata.id,
                session.authorization_url()
            );
            let transport = ticketd_core::drive::GoogleTransport::default();
            let selection = session.finish(
                &transport,
                &ticketd_core::drive::PlatformCredentialStore,
                &std::sync::atomic::AtomicBool::new(false),
            )?;
            let provider = ticketd_core::drive::GoogleDrive::new(
                &selection.connection_id,
                &ticketd_core::drive::PlatformCredentialStore,
                &transport,
            );
            serde_json::to_string(&workspace.recover_drive_reference(&id, &selection, &provider)?)?
        }
        AttachmentCommand::DriveResolve { id } | AttachmentCommand::DriveStatus { id } => {
            let reference = workspace.drive_reference(&id)?;
            let transport = ticketd_core::drive::GoogleTransport::default();
            let provider = ticketd_core::drive::GoogleDrive::new(
                &reference.connection_id,
                &ticketd_core::drive::PlatformCredentialStore,
                &transport,
            );
            let access = workspace.check_drive_reference(&id, &provider)?;
            if status_only {
                serde_json::to_string(&access)?
            } else {
                if let Some(error) = access.failure {
                    return Err(format!("{}; retry: ticketd attachment drive-resolve {id}; reconnect/authorize this file: ticketd attachment drive-authorize {id}; open {} in Drive to review availability or request access from its owner; no sharing changes are made", serde_json::to_string(&error)?, access.reference.metadata.web_url).into());
                }
                serde_json::to_string(&access.reference)?
            }
        }
        AttachmentCommand::DriveCopyStatus { id } => {
            let transport = ticketd_core::drive::GoogleTransport::default();
            let provider = ticketd_core::drive::GoogleDriveCopies::new(
                &ticketd_core::drive::PlatformCredentialStore,
                &transport,
            );
            serde_json::to_string(&workspace.inspect_drive_uploaded_copy(&id, &provider)?)?
        }
        AttachmentCommand::Usage { id } => {
            serde_json::to_string(&workspace.attachment_usage(&id)?)?
        }
        AttachmentCommand::CompleteDraftMigration {
            all_profiles_reviewed: _,
        } => {
            workspace.complete_draft_cutover()?;
            serde_json::to_string(&output::DraftMigration {
                legacy_drafts_pending: false,
            })?
        }
        AttachmentCommand::RecoveryDrafts => serde_json::to_string(&workspace.draft_retentions()?)?,
        AttachmentCommand::ReleaseRecovery {
            owner,
            revision,
            discard_recovery: _,
        } => serde_json::to_string(&workspace.release_draft(&owner, revision)?)?,
        AttachmentCommand::Uri { id } => serde_json::to_string(&workspace.attachment_uri(&id)?)?,
        AttachmentCommand::Link { id, ticket } => {
            serde_json::to_string(&workspace.set_ticket_attachment(&ticket, &id, true)?)?
        }
        AttachmentCommand::Detach { id, ticket } => {
            serde_json::to_string(&workspace.set_ticket_attachment(&ticket, &id, false)?)?
        }
        AttachmentCommand::Export { id, path } => {
            workspace.export_attachment(&id, &path)?;
            serde_json::to_string(&output::ExportedAttachment {
                id: &id,
                path: &path,
            })?
        }
    })
}

fn parse_relationship_kind(
    value: &str,
) -> Result<ticketd_core::RelationshipKind, Box<dyn std::error::Error>> {
    match value {
        "related" => Ok(ticketd_core::RelationshipKind::Related),
        "discovered" => Ok(ticketd_core::RelationshipKind::Discovered),
        _ => Err("relationship kind must be related or discovered".into()),
    }
}
