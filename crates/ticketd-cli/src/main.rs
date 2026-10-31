use clap::{Args, Parser, Subcommand, ValueEnum};
use std::io::{Read, Write};
use ticketd_core::{
    Availability, BatchOperation, ContextOptions, EvidenceInput, EvidenceKind, NotePatch, Status,
    TicketFilter, TicketPatch, Workspace, WriteRequest,
};

#[derive(Parser)]
#[command(name = "ticketd", version, about = "Local ticket workspace")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum ReminderCommand {
    Show { reference: String },
    Set { reference: String, due_at: String },
    Snooze { reference: String, due_at: String },
    Dismiss { reference: String },
}

#[derive(Subcommand)]
enum Command {
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
    /// Restore a workspace backup after closing other ticketd operations
    RestoreWorkspace { path: String },
    /// Export a portable JSON snapshot to stdout or a new file
    Export {
        #[arg(long)]
        file: Option<String>,
    },
    /// Execute a JSON write request from a file or stdin; retain its result for safe retries
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
    /// Manage ticket notes
    Note {
        #[command(subcommand)]
        command: NoteCommand,
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
    PreviewDuplicate { source: String, canonical: String },
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
    /// Manage Efforts
    Effort {
        #[command(subcommand)]
        command: EffortCommand,
    },
    /// List tickets with combined filters
    List {
        #[command(flatten)]
        filters: FindArgs,
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
        effort: bool,
        #[arg(long)]
        relationships: bool,
        #[arg(long)]
        notes: bool,
        #[arg(long)]
        evidence: bool,
        #[arg(long)]
        backlinks: bool,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// Search saved ticket content (literal, ASCII case-insensitive substring)
    Search {
        query: String,
        #[command(flatten)]
        filters: FindArgs,
    },
    /// View a bounded dependency graph around a ticket
    Graph { reference: String },
    /// Print the workspace path and format version as JSON
    Workspace,
    /// Show a ticket by its reference
    Show { reference: String },
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
    effort: Option<String>,
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
    #[arg(long, default_value_t = 50)]
    limit: u32,
    #[arg(long, default_value_t = 0)]
    offset: u32,
}
impl FindArgs {
    fn filter(self, query: String) -> TicketFilter {
        TicketFilter {
            query,
            project: self.project,
            unlinked: self.unlinked,
            effort: self.effort,
            status: self.status,
            tags: self.tag,
            availability: self.availability.map(|a| match a {
                AvailabilityArg::Ready => Availability::Ready,
                AvailabilityArg::Blocked => Availability::Blocked,
            }),
            family: self.family,
            limit: self.limit,
            offset: self.offset,
        }
    }
}

#[derive(Subcommand)]
enum EffortCommand {
    Create {
        name: String,
    },
    List {
        #[arg(long)]
        all: bool,
    },
    Show {
        id: String,
    },
    Rename {
        id: String,
        name: String,
    },
    Archive {
        id: String,
    },
    Reactivate {
        id: String,
    },
    Add {
        id: String,
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
    Remove {
        reference: String,
        #[arg(long)]
        agent: Option<String>,
    },
}
#[derive(Subcommand)]
enum ProjectCommand {
    Create {
        name: String,
        path: String,
    },
    Edit {
        id: String,
        name: String,
        path: String,
    },
    Show {
        id: String,
    },
    List,
    Register {
        id: String,
        path: String,
    },
    Unregister {
        id: String,
        path: String,
    },
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
    Add {
        reference: String,
        #[command(flatten)]
        fields: EvidenceFields,
    },
    Edit {
        reference: String,
        id: String,
        #[command(flatten)]
        fields: EvidenceFields,
    },
    Delete {
        reference: String,
        id: String,
    },
    List {
        reference: String,
        #[arg(long, default_value_t = 50)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
}
#[derive(Subcommand)]
enum NoteCommand {
    /// Append a note, reading --file - from stdin
    Add {
        reference: String,
        #[arg(long, conflicts_with = "file")]
        content: Option<String>,
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Edit supplied fields of a note
    Edit {
        reference: String,
        id: String,
        #[arg(long, conflicts_with = "file")]
        content: Option<String>,
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Delete a note
    Delete { reference: String, id: String },
    /// Read notes in insertion order
    List {
        reference: String,
        #[arg(long, default_value_t = 50)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
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

fn run(output: &mut impl Write) -> Result<(), Box<dyn std::error::Error>> {
    let args = Arguments::parse();
    if let Command::RestoreWorkspace { path } = &args.command {
        let safety = match std::env::var_os("TICKETD_TEST_WORKSPACE") {
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
    // Integration tests run the real executable against a private database on every OS.
    // ProjectDirs on Windows uses known folders and ignores HOME and XDG_DATA_HOME.
    let mut workspace = match std::env::var_os("TICKETD_TEST_WORKSPACE") {
        Some(path) => Workspace::open(path)?,
        None => Workspace::open_default()?,
    };
    let text = match args.command {
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
        Command::Create { title, project } => {
            let inferred = if project.is_none() {
                workspace.resolve_project(&std::env::current_dir()?)?
            } else {
                None
            };
            let project = project
                .as_deref()
                .or_else(|| inferred.as_ref().map(|p| p.id.as_str()));
            serde_json::to_string(&workspace.create_ticket_in_project(&title, project)?)?
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
                    effort_id: None,
                    project_id: if clear_project {
                        Some(None)
                    } else {
                        project.map(Some)
                    },
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
        Command::Note { command } => match command {
            NoteCommand::Add {
                reference,
                content,
                file,
                agent,
            } => {
                let content = read_content(content, file)?.ok_or("provide --content or --file")?;
                serde_json::to_string(&workspace.add_note(
                    &reference,
                    &content,
                    agent.as_deref(),
                )?)?
            }
            NoteCommand::Edit {
                reference,
                id,
                content,
                file,
                agent,
            } => serde_json::to_string(&workspace.edit_note(
                &reference,
                &id,
                NotePatch {
                    content: read_content(content, file)?,
                    editing_agent: agent,
                },
            )?)?,
            NoteCommand::Delete { reference, id } => {
                workspace.delete_note(&reference, &id)?;
                "null".into()
            }
            NoteCommand::List {
                reference,
                limit,
                offset,
            } => serde_json::to_string(&workspace.notes(&reference, limit, offset)?)?,
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
        Command::PreviewDuplicate { source, canonical } => {
            serde_json::to_string(&workspace.preview_duplicate_dependencies(&source, &canonical)?)?
        }
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
        Command::Effort { command } => match command {
            EffortCommand::Create { name } => {
                serde_json::to_string(&workspace.create_effort(&name)?)?
            }
            EffortCommand::List { all } => serde_json::to_string(&workspace.list_efforts(all)?)?,
            EffortCommand::Show { id } => serde_json::to_string(&workspace.show_effort(&id)?)?,
            EffortCommand::Rename { id, name } => {
                serde_json::to_string(&workspace.change_effort(&id, Some(&name), None)?)?
            }
            EffortCommand::Archive { id } => {
                serde_json::to_string(&workspace.change_effort(&id, None, Some(true))?)?
            }
            EffortCommand::Reactivate { id } => {
                serde_json::to_string(&workspace.change_effort(&id, None, Some(false))?)?
            }
            EffortCommand::Add {
                id,
                reference,
                agent,
            } => serde_json::to_string(&workspace.set_effort(
                &reference,
                Some(&id),
                agent.as_deref(),
            )?)?,
            EffortCommand::Remove { reference, agent } => {
                serde_json::to_string(&workspace.set_effort(&reference, None, agent.as_deref())?)?
            }
        },
        Command::List { filters } => {
            serde_json::to_string(&workspace.find_tickets(&filters.filter(String::new()))?)?
        }
        Command::Search { query, filters } => {
            serde_json::to_string(&workspace.find_tickets(&filters.filter(query))?)?
        }
        Command::Backlinks {
            reference,
            limit,
            offset,
        } => serde_json::to_string(&workspace.backlinks(&reference, limit, offset)?)?,
        Command::Context {
            reference,
            project,
            effort,
            relationships,
            notes,
            evidence,
            backlinks,
            offset,
        } => serde_json::to_string(&workspace.ticket_context(
            &reference,
            ContextOptions {
                project,
                effort,
                relationships,
                notes,
                evidence,
                backlinks,
                offset,
            },
        )?)?,

        Command::Graph { reference } => {
            serde_json::to_string(&workspace.dependency_graph(&reference)?)?
        }
        Command::Workspace => {
            let info = workspace.workspace_info()?;
            serde_json::to_string(&serde_json::json!({
                "path": info.path,
                "format_version": info.format_version,
            }))?
        }
        Command::Show { reference } => serde_json::to_string(&workspace.show_ticket(&reference)?)?,
    };
    writeln!(output, "{text}")?;
    Ok(())
}

fn main() {
    if let Err(error) = run(&mut std::io::stdout().lock()) {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
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
