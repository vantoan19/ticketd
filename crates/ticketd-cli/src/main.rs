use clap::{Parser, Subcommand};
use std::io::Read;
use ticketd_core::{Status, TicketPatch, Workspace};

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
    /// List tickets
    List,
    /// Show a ticket by its reference
    Show { reference: String },
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
