use clap::{Parser, Subcommand};
use std::io::Read;
use ticketd_core::{NotePatch, Status, TicketPatch, Workspace};

#[derive(Parser)]
#[command(name = "ticketd", version, about = "Local ticket workspace")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a ticket with a title
    Create { title: String },
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
    },
    /// Show ticket history
    History { reference: String },
    /// Manage ticket notes
    Note {
        #[command(subcommand)]
        command: NoteCommand,
    },
    /// List tickets
    List,
    /// Show a ticket by its reference
    Show { reference: String },
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
        Command::Create { title } => serde_json::to_string(&workspace.create_ticket(&title)?)?,
        Command::Change {
            reference,
            title,
            body,
            body_file,
            status,
            agent,
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
        Command::History { reference } => {
            serde_json::to_string(&workspace.ticket_history(&reference)?)?
        }
        Command::List => serde_json::to_string(&workspace.list_tickets()?)?,
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
