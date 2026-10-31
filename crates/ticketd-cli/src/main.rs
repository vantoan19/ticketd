use clap::{Parser, Subcommand};
use std::io::Read;
use ticketd_core::{BatchOperation, ContextOptions, NotePatch, Status, TicketPatch, Workspace};

#[derive(Parser)]
#[command(name = "ticketd", version, about = "Local ticket workspace")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
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
    /// Manage ticket notes
    Note {
        #[command(subcommand)]
        command: NoteCommand,
    },
    /// Add a tag (trimmed and lowercased; duplicates are ignored)
    AddTag { reference: String, tag: String },
    /// Remove a tag (trimmed and lowercased; missing memberships are ignored)
    RemoveTag { reference: String, tag: String },
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
    /// List tickets
    List {
        #[arg(long, conflicts_with = "unlinked")]
        project: Option<String>,
        #[arg(long)]
        unlinked: bool,
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
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// View a bounded dependency graph around a ticket
    Graph { reference: String },
    /// Show a ticket by its reference
    Show { reference: String },
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

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Arguments::parse();
    let mut workspace = Workspace::open_default()?;
    let output = match args.command {
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
        Command::List { project, unlinked } => {
            if let Some(ref id) = project {
                workspace.show_project(id)?;
            }
            let tickets: Vec<_> = workspace
                .list_tickets()?
                .into_iter()
                .filter(|ticket| {
                    if unlinked {
                        ticket.project_id.is_none()
                    } else if let Some(ref id) = project {
                        ticket.project_id.as_ref() == Some(id)
                    } else {
                        true
                    }
                })
                .collect();
            serde_json::to_string(&tickets)?
        }
        Command::Context {
            reference,
            project,
            effort,
            relationships,
            notes,
            offset,
        } => serde_json::to_string(&workspace.ticket_context(
            &reference,
            ContextOptions {
                project,
                effort,
                relationships,
                notes,
                offset,
            },
        )?)?,
        Command::Graph { reference } => {
            serde_json::to_string(&workspace.dependency_graph(&reference)?)?
        }
        Command::Show { reference } => serde_json::to_string(&workspace.show_ticket(&reference)?)?,
    };
    println!("{output}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}
