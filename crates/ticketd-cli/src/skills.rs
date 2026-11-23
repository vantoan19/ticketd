use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

use ticketd_core::agent_skills::{self, InstallError, InstallOutcome};
use ticketd_core::harnesses::{HARNESS_DESCRIPTORS, HarnessDescriptor, find_descriptor};

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
    /// Install or update SKILL.md for coding agents (per user) or in an explicit skill directory
    #[command(group = clap::ArgGroup::new("target").required(true))]
    Install {
        /// Destination containing SKILL.md, e.g. .agents/skills/ticketd or .claude/skills/ticketd
        #[arg(group = "target")]
        directory: Option<PathBuf>,
        #[arg(
            long,
            value_delimiter = ',',
            group = "target",
            help = install_harness_help(HARNESS_DESCRIPTORS),
        )]
        harness: Vec<String>,
        /// Replace an edited or foreign SKILL.md after reviewing it; it is saved as a backup first
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
    Guide {
        name: "chat",
        description: "Working from a ticketd Chat: read linked records first, write progress back",
        content: include_str!("../skill-data/chat.md"),
    },
];

fn harness_choices(harnesses: &[&HarnessDescriptor]) -> String {
    harnesses
        .iter()
        .map(|descriptor| descriptor.key.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn install_harness_help(harnesses: &[&HarnessDescriptor]) -> String {
    format!(
        "Install into these harnesses' per-user skill folders: {}",
        harness_choices(harnesses)
    )
}

fn skill_directories(
    ids: &[String],
    harnesses: &[&HarnessDescriptor],
    home: &Path,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<Vec<PathBuf>, String> {
    ids.iter()
        .map(|id| {
            find_descriptor(harnesses, id)
                .map(|descriptor| descriptor.skill_directory(home, &env))
                .ok_or_else(|| {
                    format!(
                        "unknown harness '{id}'; choose from {}",
                        harness_choices(harnesses)
                    )
                })
        })
        .collect()
}

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
        Command::Install {
            directory,
            harness,
            replace,
        } => {
            let directories = match directory {
                Some(directory) => vec![directory],
                None => {
                    let home = agent_skills::user_home()?;
                    skill_directories(&harness, HARNESS_DESCRIPTORS, &home, |name| {
                        std::env::var_os(name)
                    })?
                }
            };
            // Install every target before reporting a failure, so one conflict
            // does not leave the other agents without the skill.
            let mut failed = Vec::new();
            for directory in directories {
                let path = directory.join("SKILL.md");
                match agent_skills::install_skill(&directory, replace) {
                    Ok(outcome) => {
                        let message = match outcome {
                            InstallOutcome::Unchanged => "Up to date".to_owned(),
                            InstallOutcome::Installed => "Installed".to_owned(),
                            InstallOutcome::Updated => "Updated".to_owned(),
                            InstallOutcome::Replaced { backup } => {
                                format!("Replaced (previous copy saved as {})", backup.display())
                            }
                        };
                        writeln!(output, "{message}: {}", path.display())?;
                    }
                    Err(error) => {
                        let hint = if matches!(error, InstallError::Conflict(_)) {
                            " (use --replace)"
                        } else {
                            ""
                        };
                        failed.push(format!("cannot install {}: {error}{hint}", path.display()));
                    }
                }
            }
            if !failed.is_empty() {
                return Err(failed.join("\n").into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ticketd_core::harnesses::{CLAUDE_CODE, HarnessDescriptor, SkillLocation};

    #[test]
    #[allow(clippy::unwrap_used)]
    fn install_offers_another_harness_and_uses_its_skill_folder() {
        let descriptor = HarnessDescriptor {
            key: "sample-agent".parse().unwrap(),
            name: "Sample agent",
            skills: SkillLocation::UserHome(".sample/support/skills"),
            ..CLAUDE_CODE.clone()
        };
        let harnesses = [&CLAUDE_CODE, &descriptor];
        assert!(install_harness_help(&harnesses).contains("claude-code, sample-agent"));

        let home = tempfile::tempdir().unwrap();
        let directories =
            skill_directories(&["sample-agent".into()], &harnesses, home.path(), |_| None).unwrap();
        assert_eq!(
            directories,
            [home
                .path()
                .join(Path::new(".sample/support/skills/ticketd"))]
        );
    }
}
