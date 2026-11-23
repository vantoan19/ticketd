//! The evidence a Step reader sees and the actions it returns for Chat views.

use ticketd_core::ChatToolState;

use crate::step_kind::{self, Kind, Variant};

/// Evidence as the Workspace keeps it. Reading this never starts a harness.
#[derive(Debug, Clone, Copy)]
pub struct ToolEvidence<'a> {
    pub name: &'a str,
    pub input: &'a str,
    pub output: Option<&'a str>,
    pub state: ChatToolState,
    pub working_directory: &'a str,
}

pub type StepReader = for<'a> fn(ToolEvidence<'a>) -> Vec<ToolStep>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolStep {
    pub action: StepAction,
    pub command: Option<CommandEvidence>,
    pub outcome: Option<StepOutcomeOverride>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepAction {
    Read(ReadAction),
    Search {
        targets: Vec<SearchTarget>,
        no_matches: bool,
    },
    Edit {
        targets: FileTargets,
        counts: LineCounts,
    },
    Create {
        targets: FileTargets,
        counts: LineCounts,
    },
    Delete {
        paths: Vec<String>,
    },
    Run(RunAction),
    Web(WebAction),
    Other {
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadAction {
    Files(Vec<ReadTarget>),
    List(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadTarget {
    pub path: String,
    /// First and last line, inclusive.
    pub lines: Option<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchTarget {
    pub query: String,
    pub scope: Option<SearchScope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchScope {
    Path(String),
    Pattern(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileTargets {
    Paths(Vec<String>),
    /// A harness's own plan, normally worded without its path.
    Plan {
        path: String,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LineCounts {
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunAction {
    Command,
    Script { interpreters: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebAction {
    Search { query: String },
    Fetch { url: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandEvidence {
    /// The command as supplied by the harness, including any shell wrapper.
    pub exact: String,
    /// The command without wrappers and, where classification found it, setup.
    pub display: String,
    pub working_directory: Option<String>,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub timed_out: bool,
    /// The argument lists, when the command only calls ticketd.
    pub ticketd_calls: Option<Vec<Vec<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcomeOverride {
    Completed,
    Declined,
}

impl From<StepAction> for ToolStep {
    fn from(action: StepAction) -> Self {
        Self {
            action,
            command: None,
            outcome: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct CommandFacts<'a> {
    pub working_directory: Option<&'a str>,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub timed_out: bool,
}

/// An already extracted command has the same meaning in any harness.
pub(crate) fn shell_step(
    evidence: ToolEvidence<'_>,
    command: &str,
    facts: CommandFacts<'_>,
) -> ToolStep {
    let shell = step_kind::shell(command);
    let working_directory = match (facts.working_directory, shell.folder) {
        (_, Some(cd)) if cd.starts_with(['/', '~']) => Some(cd),
        (Some(cwd), Some(cd)) => Some(format!("{}/{cd}", cwd.trim_end_matches('/'))),
        (cwd, cd) => cd.or(cwd.map(str::to_owned)),
    };
    let ticketd_calls = step_kind::ticketd_calls(command);
    let search = shell.kind == Kind::Search;
    // grep and rg exit 1 when they find nothing.
    let no_match_exit = search && facts.exit_code == Some(1);
    let outcome = (no_match_exit && evidence.state == ChatToolState::Failed)
        .then_some(StepOutcomeOverride::Completed);
    let completed = evidence.state == ChatToolState::Completed || outcome.is_some();
    let no_matches = completed
        && (no_match_exit
            || evidence
                .output
                .is_none_or(|output| output.trim().is_empty()));
    let action = if ticketd_calls.is_some() {
        StepAction::Run(RunAction::Command)
    } else {
        match shell.kind {
            Kind::Read if shell.variant == Some(Variant::List) => {
                StepAction::Read(ReadAction::List(
                    shell
                        .targets
                        .into_iter()
                        .map(|target| target.text)
                        .collect(),
                ))
            }
            Kind::Read => StepAction::Read(ReadAction::Files(
                shell
                    .targets
                    .into_iter()
                    .map(|target| ReadTarget {
                        path: target.text,
                        lines: target.lines,
                    })
                    .collect(),
            )),
            Kind::Search => StepAction::Search {
                targets: shell
                    .targets
                    .into_iter()
                    .map(|target| SearchTarget {
                        query: target.text,
                        scope: target.scope.map(SearchScope::Path),
                    })
                    .collect(),
                no_matches,
            },
            Kind::Edit => StepAction::Edit {
                targets: FileTargets::Paths(
                    shell
                        .targets
                        .into_iter()
                        .map(|target| target.text)
                        .collect(),
                ),
                counts: LineCounts::default(),
            },
            Kind::Delete => StepAction::Delete {
                paths: shell
                    .targets
                    .into_iter()
                    .map(|target| target.text)
                    .collect(),
            },
            Kind::Run if shell.variant == Some(Variant::Script) => {
                StepAction::Run(RunAction::Script {
                    interpreters: shell
                        .targets
                        .into_iter()
                        .map(|target| target.text)
                        .collect(),
                })
            }
            Kind::Run => StepAction::Run(RunAction::Command),
        }
    };
    let display = if ticketd_calls.is_some() {
        step_kind::unwrapped(command)
    } else {
        shell.command
    };
    ToolStep {
        action,
        command: Some(CommandEvidence {
            exact: command.to_owned(),
            display,
            working_directory,
            exit_code: facts.exit_code,
            duration_ms: facts.duration_ms,
            timed_out: facts.timed_out,
            ticketd_calls,
        }),
        outcome,
    }
}
