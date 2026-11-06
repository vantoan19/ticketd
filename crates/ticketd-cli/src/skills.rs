use std::io::Write;
use std::path::{Path, PathBuf};

const DISCOVERY_SKILL: &str = include_str!("../../../skills/ticketd/SKILL.md");

#[derive(clap::Subcommand)]
pub enum Command {
    /// List bundled guide names and descriptions as JSON
    List,
    /// Print one guide from this executable; defaults to core (see skills list)
    Get {
        /// Guide name returned by skills list
        #[arg(default_value = "core")]
        name: String,
    },
    /// Install or refresh SKILL.md in an explicit skill directory
    Install {
        /// Destination containing SKILL.md, e.g. .agents/skills/ticketd or .claude/skills/ticketd
        directory: PathBuf,
        /// Replace a differing SKILL.md after reviewing it; other files are preserved
        #[arg(long)]
        replace: bool,
    },
}

struct Guide {
    name: &'static str,
    description: &'static str,
    content: &'static str,
}

const GUIDES: &[Guide] = &[
    Guide {
        name: "core",
        description: "Executable discovery, workspace scope, output, and guide selection",
        content: include_str!("../skill-data/core.md"),
    },
    Guide {
        name: "tickets",
        description: "Tickets, projects, relationships, status, tags, and evidence",
        content: include_str!("../skill-data/tickets.md"),
    },
    Guide {
        name: "context",
        description: "Bounded context, Documents, Activities, Plans, and graphs",
        content: include_str!("../skill-data/context.md"),
    },
    Guide {
        name: "writes",
        description: "JSON writes, retry IDs, edit conflicts, and atomic ticket batches",
        content: include_str!("../skill-data/writes.md"),
    },
    Guide {
        name: "sources",
        description: "External ownership, source configuration, publication, and recovery",
        content: include_str!("../skill-data/sources.md"),
    },
    Guide {
        name: "workspace",
        description: "Workspace location, backups, export, and personal state",
        content: include_str!("../skill-data/workspace.md"),
    },
];

pub fn run(command: Command, output: &mut impl Write) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        Command::List => {
            let guides: Vec<_> = GUIDES
                .iter()
                .map(|guide| {
                    serde_json::json!({ "name": guide.name, "description": guide.description })
                })
                .collect();
            writeln!(
                output,
                "{}",
                serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "guides": guides })
            )?;
        }
        Command::Get { name } => {
            let guide = GUIDES
                .iter()
                .find(|guide| guide.name == name)
                .ok_or_else(|| {
                    format!(
                        "unknown guide '{name}'; use `ticketd skills list` to see available guides"
                    )
                })?;
            writeln!(
                output,
                "ticketd CLI version: {}\n",
                env!("CARGO_PKG_VERSION")
            )?;
            write!(output, "{}", guide.content)?;
        }
        Command::Install { directory, replace } => {
            let path = directory.join("SKILL.md");
            install(&directory, &path, replace)
                .map_err(|error| format!("cannot install {}: {error}", path.display()))?;
            writeln!(output, "Installed {}", path.display())?;
        }
    }
    Ok(())
}

fn install(directory: &Path, path: &Path, replace: bool) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};

    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(Error::other(
                    "SKILL.md must be a regular file, not a directory or link",
                ));
            }
            if std::fs::read(path)? == DISCOVERY_SKILL.as_bytes() {
                return Ok(());
            }
            if !replace {
                return Err(Error::new(
                    ErrorKind::AlreadyExists,
                    "SKILL.md differs from the bundled skill; review it, then use --replace to overwrite it",
                ));
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    std::fs::create_dir_all(directory)?;
    // Stage beside the destination so a failed write never leaves a partial skill.
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    staged.write_all(DISCOVERY_SKILL.as_bytes())?;
    staged.flush()?;
    if replace {
        staged.persist(path).map_err(|error| error.error)?;
    } else {
        staged
            .persist_noclobber(path)
            .map_err(|error| error.error)?;
    }
    Ok(())
}
