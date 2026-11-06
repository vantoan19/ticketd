use clap::{Args, Parser, Subcommand, ValueEnum};
use std::io::{Read, Write};
use ticketd_core::{
    ActivityPatch, Availability, BatchOperation, ContextOptions, DocumentPatch, EvidenceInput,
    EvidenceKind, Status, TicketFilter, TicketPatch, Workspace, WriteRequest, WriteResult,
};

#[derive(Parser)]
#[command(name = "ticketd", version, about = "Local ticket workspace")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
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
    /// Read or change the workspace's per-file upload limit (default 100 MiB); existing snapshots stay unchanged
    Limit {
        /// Positive byte bound, enforced while copying actual bytes
        #[arg(long)]
        bytes: Option<u64>,
    },
    /// Store an immutable local snapshot; --request-id makes a lost response safe to retry
    Add {
        path: String,
        #[arg(long)]
        ticket: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// List direct ticket attachments, or all workspace uploads including unused files
    List {
        #[arg(long)]
        ticket: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Inspect a workspace attachment by stable ID
    Inspect { id: String },
    /// Last-known Drive metadata and opaque connection handle; no network needed
    DriveInfo { id: String },
    /// Reference an already-authorized Drive file using the shared OS credential store
    DriveAdd {
        connection: String,
        file_id: String,
        #[arg(long)]
        resource_key: Option<String>,
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Resolve current Drive metadata without downloading or converting content
    DriveResolve { id: String },
    /// Print the workspace-scoped URI to use in canonical Markdown links
    Uri { id: String },
    /// Reuse an existing attachment on another ticket
    Link { id: String, ticket: String },
    /// Remove only this ticket's association, retaining the snapshot and all other uses
    Detach { id: String, ticket: String },
    /// Copy stored bytes to a new file without overwriting an existing destination
    Export { id: String, path: String },
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
        #[arg(long)]
        title: Option<String>,
        /// The Markdown body
        #[arg(long, conflicts_with = "body_file")]
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
        #[arg(long, default_value_t = 50)]
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
        #[arg(long, default_value_t = 50)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// List pinned Documents
    Pins {
        #[arg(long, default_value_t = 50)]
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
        #[arg(long, default_value_t = 0)]
        offset: usize,
        #[arg(long, default_value_t = 4096)]
        limit: usize,
    },
    /// List trashed Documents
    TrashList {
        #[arg(long, default_value_t = 50)]
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
        #[arg(long, conflicts_with = "clear_title")]
        title: Option<String>,
        /// Remove the title so the heading comes from the body
        #[arg(long)]
        clear_title: bool,
        /// Replace the Markdown body
        #[arg(long, conflicts_with = "body_file")]
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
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Save a consistent workspace backup to a new file
    Backup { path: String },
    /// Review backup integrity and retained local bytes as JSON without restoring
    InspectBackup { path: String },
    /// Restore a workspace backup after closing other ticketd operations
    RestoreWorkspace {
        path: String,
        /// Recover into this database path instead of replacing the current workspace; does not switch the desktop workspace
        #[arg(long)]
        target: Option<String>,
    },
    /// Export a portable JSON snapshot to stdout or a new file
    Export {
        #[arg(long)]
        file: Option<String>,
    },
    /// Execute a JSON write request (file or - for stdin); prints {"kind","value"}. With --request-id, a retry returns the first result. Other commands print the bare object; `activity add/edit` and `document create/change` also accept --request-id with the same replay behavior
    Write {
        file: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Apply a JSON array of operations from a file or - for stdin
    Batch { file: String },
    /// Manage repository projects
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    /// Create a ticket with a title
    Create {
        title: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        plan: Option<String>,
    },
    /// Patch ticket content; use --body-file - to read stdin
    Change {
        reference: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long, conflicts_with = "body_file")]
        body: Option<String>,
        #[arg(long)]
        body_file: Option<String>,
        #[arg(long)]
        status: Option<Status>,
        #[arg(long)]
        agent: Option<String>,
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
    AddTag { reference: String, tag: String },
    /// Remove a tag (trimmed and lowercased; missing memberships are ignored)
    RemoveTag { reference: String, tag: String },
    /// Mark a ticket as a duplicate of a canonical ticket
    MarkDuplicate {
        source: String,
        canonical: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Preview dependencies before marking a duplicate
    PreviewDuplicate {
        source: String,
        canonical: String,
        /// Judge readiness as a separate dependency review, which does not cancel the source
        #[arg(long)]
        separate: bool,
    },
    /// Remove a duplicate designation
    RemoveDuplicate {
        source: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Add a contextual relationship (kind: related or discovered; source is the work being done)
    AddRelationship {
        source: String,
        target: String,
        kind: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Remove a contextual relationship
    RemoveRelationship {
        source: String,
        target: String,
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
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Retrieve bounded context; select related scopes explicitly
    Context {
        reference: String,
        #[arg(long)]
        project: bool,
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
        /// Refresh only this externally owned ticket, for example T-12
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Make an unavailable externally owned ticket local: keeps its content and work, stops synchronizing it
    TakeOwnership {
        /// The ticket, for example T-12
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Publish a local Todo, In progress or In review ticket as one ordinary issue.
    /// Use --preview first: it prints exactly what would be sent and sends nothing
    Publish {
        /// The local ticket to publish, for example T-12
        ticket: String,
        #[arg(long, default_value = "github")]
        provider: String,
        /// Where to create the issue, for example owner/name; optional when only
        /// one repository is configured
        #[arg(long)]
        destination: Option<String>,
        /// Print the title, description, destination and eligibility; create nothing
        #[arg(long)]
        preview: bool,
        /// The `fingerprint` printed by --preview. When given, nothing is sent if the
        /// title, description or destination changed since
        #[arg(long)]
        expect: Option<String>,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Settle a publication whose outcome is unknown, without risking a second issue.
    /// With no flag it prints what is known and unknown and searches the destination
    /// for the issue that may have been created; it changes nothing
    Resolve {
        /// The ticket with the unresolved publication, for example T-12
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
    #[arg(long, conflicts_with = "unlinked")]
    project: Option<String>,
    #[arg(long)]
    unlinked: bool,
    #[arg(long)]
    plan: Option<String>,
    #[arg(long)]
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
    #[arg(long, default_value_t = 50)]
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
    Create { name: String, path: String },
    /// Change a project's name and path
    Edit {
        id: String,
        name: String,
        path: String,
    },
    /// Show a project
    Show { id: String },
    /// List projects
    List,
    /// Register another checkout path for a project
    Register { id: String, path: String },
    /// Remove a registered checkout path from a project
    Unregister { id: String, path: String },
}

#[derive(Clone, ValueEnum)]
enum EvidenceType {
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
    #[arg(long, value_enum)]
    kind: EvidenceType,
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
        #[arg(long, default_value_t = 50)]
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
        #[arg(long, conflicts_with = "file")]
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
        #[arg(long, conflicts_with = "file")]
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
        #[arg(long, default_value_t = 50)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
}
/// The value of a write result without its `{"kind","value"}` wrapper, so a
/// retried command prints the same object as the first run.
fn bare(result: WriteResult) -> Result<String, Box<dyn std::error::Error>> {
    let wrapped = serde_json::to_value(&result)?;
    Ok(wrapped
        .get("value")
        .map_or_else(|| wrapped.to_string(), ToString::to_string))
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
        Some(path) => Some(std::fs::read_to_string(path)?),
        None => content,
    })
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
        "reference" => "The ticket reference, for example T-12",
        "ticket" => "The ticket reference, for example T-12",
        "agent" => "Name of the agent making this change, recorded in history and the feed",
        "offset" => "Skip this many results (for paging)",
        "limit" => "Return at most this many results",
        "title" => "The title",
        "name" => "The name",
        "path" => "A path",
        "target" => "The ticket, Plan or Document to link to",
        "query" => "Text to search for",
        "tag" => "A tag name",
        "remove" => "Remove instead of add",
        "project" => "Restrict to a project ID",
        "plan" => "Restrict to a Plan ID",
        "kind" => "The kind",
        "document_id" => "The Document ID",
        "include_support" => "Include activity-details Documents that were not kept",
        "canonical" => "The canonical (original) ticket reference",
        "blocker" => "The ticket that blocks",
        "dependent" => "The ticket that waits",
        "status" => "A ticket status",
        "parent" => "The parent ticket reference",
        "purpose" => "The Plan's purpose text",
        "due_at" => "RFC 3339 time with an offset, for example 2026-01-31T09:00:00-05:00",
        "file" => "A JSON file (- reads stdin)",
        "request_id" => {
            "Makes retries safe: repeating this ID with the same input returns the first result instead of writing again"
        }
        "body" => "The Markdown description",
        "body_file" => "Read the description from a file (- reads stdin)",
        "clear_project" => "Unlink the ticket from its project",
        "value" => "The URL, reference, path or verification result",
        "source" => "The ticket that is the source of the change, for example T-12",
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

fn run(output: &mut impl Write) -> Result<(), Box<dyn std::error::Error>> {
    use clap::{CommandFactory, FromArgMatches};
    let args = Arguments::from_arg_matches(&describe(Arguments::command(), &[]).get_matches())
        .unwrap_or_else(|error| error.exit());
    if let Command::RestoreWorkspace { path, target } = &args.command {
        let destination = target
            .as_ref()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("TICKETD_TEST_WORKSPACE").map(std::path::PathBuf::from));
        let safety = match destination {
            Some(workspace) => Workspace::restore(workspace, path)?,
            None => Workspace::restore_default(path)?,
        };
        writeln!(
            output,
            "Restored workspace. Safety backup: {}",
            safety.display()
        )?;
        return Ok(());
    }
    // A status probe reads the file as it is. Opening the workspace would create
    // a missing one or migrate an older one past the version the desktop app supports.
    if matches!(args.command, Command::Workspace) {
        let file = match std::env::var_os("TICKETD_TEST_WORKSPACE") {
            Some(workspace) => ticketd_core::workspace_file(workspace)?,
            None => ticketd_core::default_workspace_file()?,
        };
        writeln!(
            output,
            "{}",
            serde_json::to_string(&serde_json::json!({
                "path": file.path,
                "format_version": file.format_version,
                "supported_format_version": ticketd_core::FORMAT_VERSION,
            }))?
        )?;
        return Ok(());
    }
    // Integration tests run the real executable against a private database on every OS.
    // ProjectDirs on Windows uses known folders and ignores HOME and XDG_DATA_HOME.
    let mut workspace = match std::env::var_os("TICKETD_TEST_WORKSPACE") {
        Some(path) => Workspace::open(path)?,
        None => Workspace::open_default()?,
    };
    let text = match args.command {
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
                "ok".into()
            }
            DocumentCommand::Tags { id } => serde_json::to_string(&workspace.document_tags(&id)?)?,
            DocumentCommand::Tag { id, tag, remove } => {
                workspace.set_document_tag(&id, &tag, !remove)?;
                "ok".into()
            }
            DocumentCommand::Read { id, offset, limit } => {
                let document = workspace.show_document(&id)?;
                let limit = limit.clamp(1, 65536);
                let mut chars = document.body.chars().skip(offset);
                let body: String = chars.by_ref().take(limit).collect();
                let next_offset = chars.next().map(|_| offset + body.chars().count());
                let fetch = next_offset.map(|next| {
                    format!("ticketd document read {id} --offset {next} --limit {limit}")
                });
                serde_json::to_string(
                    &serde_json::json!({"id": document.id, "title": document.title, "created_at": document.created_at, "updated_at": document.updated_at, "trashed": document.trashed, "body": body, "offset": offset, "next_offset": next_offset, "truncated": next_offset.is_some(), "fetch": fetch}),
                )?
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
                let patch = DocumentPatch {
                    title: if clear_title {
                        Some(None)
                    } else {
                        title.map(Some)
                    },
                    body: read_content(body, body_file)?,
                    expected_updated_at: None,
                };
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
            ReminderCommand::Show { reference } => match workspace.reminder(&reference)? {
                Some(value) => {
                    let instant = chrono::DateTime::parse_from_rfc3339(&value)?;
                    format!(
                        "{} (UTC: {})",
                        instant
                            .with_timezone(&chrono::Local)
                            .format("%Y-%m-%d %H:%M:%S %:z"),
                        value
                    )
                }
                None => "No reminder".into(),
            },
            ReminderCommand::Set { reference, due_at }
            | ReminderCommand::Snooze { reference, due_at } => {
                workspace.set_reminder(&reference, Some(&due_at))?;
                "Reminder scheduled".into()
            }
            ReminderCommand::Dismiss { reference } => {
                workspace.set_reminder(&reference, None)?;
                "Reminder dismissed".into()
            }
        },
        Command::Inbox { limit, offset } => {
            serde_json::to_string(&workspace.inbox(limit, offset)?)?
        }
        Command::Backup { path } => {
            workspace.backup(&path)?;
            format!("Backup saved: {path}")
        }
        Command::InspectBackup { path } => serde_json::to_string(&workspace.inspect_backup(path)?)?,
        Command::RestoreWorkspace { .. } => return Err("restore was not performed".into()),
        Command::Export { file } => {
            if let Some(path) = file {
                workspace.export_file(path)?;
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
                Box::new(std::fs::File::open(file)?)
            };
            let mut bytes = Vec::new();
            reader.take(1_048_577).read_to_end(&mut bytes)?;
            if bytes.len() > 1_048_576 {
                return Err("batch exceeds 1 MiB".into());
            }
            let operations: Vec<BatchOperation> = serde_json::from_slice(&bytes)?;
            serde_json::to_string(&workspace.apply_batch(operations)?)?
        }
        Command::Project { command } => match command {
            ProjectCommand::Create { name, path } => {
                serde_json::to_string(&workspace.create_project(&name, &path)?)?
            }
            ProjectCommand::Edit { id, name, path } => {
                serde_json::to_string(&workspace.edit_project(&id, &name, &path)?)?
            }
            ProjectCommand::Show { id } => serde_json::to_string(&workspace.show_project(&id)?)?,
            ProjectCommand::Register { id, path } => {
                serde_json::to_string(&workspace.register_checkout(&id, &path)?)?
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
                Some(path) => Some(std::fs::read_to_string(path)?),
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
                "null".into()
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
                let brief = read_content(brief, file)?.ok_or("provide --brief or --file")?;
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
                    brief: read_content(brief, file)?,
                    editing_agent: agent,
                };
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
                "null".into()
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
        Command::AddTag { reference, tag } => {
            serde_json::to_string(&workspace.add_tag(&reference, &tag)?)?
        }
        Command::RemoveTag { reference, tag } => {
            serde_json::to_string(&workspace.remove_tag(&reference, &tag)?)?
        }
        Command::MarkDuplicate {
            source,
            canonical,
            agent,
        } => serde_json::to_string(&workspace.mark_duplicate(
            &source,
            &canonical,
            agent.as_deref(),
        )?)?,
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
                serde_json::to_string(&workspace.find_tickets_with_updates(&filter)?)?
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
                serde_json::to_string(&workspace.find_tickets_with_updates(&filter)?)?
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
                        TOKEN_HINT
                    } else {
                        ""
                    }
                )
                .into());
            }
            return Ok(());
        }
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
                    issue,
                    attach,
                    not_created,
                    no_search,
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
        let mut values = match read_content(None, settings.config_file)? {
            Some(text) => match serde_json::from_str(&text)? {
                serde_json::Value::Object(values) => values,
                _ => return Err("the configuration file must hold a JSON object".into()),
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
                sources.push(serde_json::json!({ "connector": descriptor, "saved": saved }));
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
        | SourceCommand::Publish { .. }
        | SourceCommand::Resolve { .. } => unreachable_refresh()?,
    })
}

fn unreachable_refresh() -> Result<String, Box<dyn std::error::Error>> {
    Err("refresh and publish are handled before source configuration commands".into())
}

/// The command line's own way to sign in; the desktop app's guidance leaves it out.
const TOKEN_HINT: &str =
    " From a script, set TICKETD_GITHUB_TOKEN to a token that can read and create issues instead.";

fn main() {
    if let Err(error) = run(&mut std::io::stdout().lock()) {
        use ticketd_core::source::SourceError;
        let unauthenticated = match error.downcast_ref::<ticketd_core::Error>() {
            Some(ticketd_core::Error::Source(SourceError::Unauthenticated(_))) => true,
            _ => matches!(
                error.downcast_ref::<SourceError>(),
                Some(SourceError::Unauthenticated(_))
            ),
        };
        let hint = if unauthenticated { TOKEN_HINT } else { "" };
        eprintln!("error: {error}{hint}");
        std::process::exit(1);
    }
}

fn attachment_command(
    workspace: &mut Workspace,
    command: AttachmentCommand,
) -> Result<String, Box<dyn std::error::Error>> {
    Ok(match command {
        AttachmentCommand::Limit { bytes } => {
            if let Some(bytes) = bytes {
                workspace.set_attachment_upload_limit(bytes)?;
            }
            serde_json::to_string(
                &serde_json::json!({ "limit_bytes": workspace.attachment_upload_limit()?, "default_bytes": ticketd_core::DEFAULT_ATTACHMENT_LIMIT }),
            )?
        }
        AttachmentCommand::Add {
            path,
            ticket,
            name,
            request_id,
        } => {
            let result = workspace.write(
                request_id.as_deref(),
                WriteRequest::ImportAttachment {
                    source: path,
                    display_name: name,
                },
            )?;
            let WriteResult::Attachment(file) = result else {
                return Err("unexpected attachment result".into());
            };
            if let Some(ticket) = ticket {
                workspace.set_ticket_attachment(&ticket, &file.id, true).map_err(|error| {
                    format!("snapshot stored as {}; ticket association failed: {error}. Reuse it with `ticketd attachment link {} {ticket}`", file.id, file.id)
                })?;
            }
            serde_json::to_string(&file)?
        }
        AttachmentCommand::List {
            ticket,
            limit,
            offset,
        } => serde_json::to_string(&match ticket {
            Some(ticket) => workspace.ticket_attachments(&ticket)?,
            None => workspace.attachments(limit, offset)?,
        })?,
        AttachmentCommand::Inspect { id } => serde_json::to_string(&workspace.attachment(&id)?)?,
        AttachmentCommand::DriveInfo { id } => {
            serde_json::to_string(&workspace.drive_reference(&id)?)?
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
        AttachmentCommand::DriveResolve { id } => {
            let reference = workspace.drive_reference(&id)?;
            let transport = ticketd_core::drive::GoogleTransport::default();
            let provider = ticketd_core::drive::GoogleDrive::new(
                &reference.connection_id,
                &ticketd_core::drive::PlatformCredentialStore,
                &transport,
            );
            serde_json::to_string(&workspace.resolve_drive_reference(&id, &provider)?)?
        }
        AttachmentCommand::Uri { id } => serde_json::to_string(&workspace.attachment_uri(&id)?)?,
        AttachmentCommand::Link { id, ticket } => {
            serde_json::to_string(&workspace.set_ticket_attachment(&ticket, &id, true)?)?
        }
        AttachmentCommand::Detach { id, ticket } => {
            serde_json::to_string(&workspace.set_ticket_attachment(&ticket, &id, false)?)?
        }
        AttachmentCommand::Export { id, path } => {
            workspace.export_attachment(&id, &path)?;
            serde_json::to_string(&serde_json::json!({ "id": id, "path": path }))?
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
