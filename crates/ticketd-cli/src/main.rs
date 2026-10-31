use clap::{Parser, Subcommand};
use ticketd_core::Workspace;

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
