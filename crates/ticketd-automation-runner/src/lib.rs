//! The Automation runner: the loop that makes Automations happen. Each tick matches
//! new Workspace events into Queued runs and starts queued runs up to the limit; a
//! started run executes its steps one at a time, handing each outcome to the core's
//! run state machine, which says what comes next.
//!
//! The core owns every rule and record; the Chat host runs agents. This crate only
//! connects them, and depends on nothing else, so it runs without the desktop.

mod first_message;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ticketd_chat_host::{ChatHost, TurnEnd, Unattended, WorkspaceOpener};
use ticketd_core::{
    AutomationAgent, AutomationNotification, AutomationRun, ChatLink, ChatLinkKind, Error, NewChat,
    RunAction, StepAction, StepOutcome,
};

pub use first_message::first_message;

/// Why runs left Running by an earlier process ended.
const RESTARTED: &str = "ticketd closed while this run was going.";

/// Where the ticketd CLI is, so an agent can be allowed to run it whatever else it
/// may do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TicketdCli {
    /// The executable, when one was found.
    pub executable: Option<PathBuf>,
    /// The folders it writes to: the one holding the Workspace.
    pub folders: Vec<PathBuf>,
}

/// Shows a desktop notification, or says why it could not. The host supplies it: the
/// runner knows what to say, not how a desktop shows it.
pub type Notifier = Arc<dyn Fn(AutomationNotification) -> Result<(), String> + Send + Sync>;

#[derive(Clone)]
pub struct Runner {
    inner: Arc<Inner>,
}

struct Inner {
    open_workspace: WorkspaceOpener,
    host: ChatHost,
    cli: TicketdCli,
    notifier: Notifier,
}

impl Runner {
    /// Runs left Running by a process that is gone have nothing behind them, so they
    /// end as Needs attention before anything new starts. Nothing retries by itself.
    pub fn new(
        open_workspace: WorkspaceOpener,
        host: ChatHost,
        cli: TicketdCli,
        notifier: Notifier,
    ) -> Result<Self, Error> {
        open_workspace()?.end_running_automation_runs(RESTARTED)?;
        Ok(Self {
            inner: Arc::new(Inner {
                open_workspace,
                host,
                cli,
                notifier,
            }),
        })
    }

    /// One pass of the loop: queue a run for each new matching event, then start
    /// queued runs up to the limit. Started runs execute on tasks of their own, so
    /// this returns at once; it must be called inside a Tokio runtime.
    pub fn tick(&self) -> Result<(), Error> {
        (self.inner.open_workspace)()?.queue_automation_runs()?;
        self.start_queued()
    }

    fn start_queued(&self) -> Result<(), Error> {
        // Read each time, so a change in Settings counts from the next run.
        let mut workspace = (self.inner.open_workspace)()?;
        let started = workspace.start_automation_runs(workspace.automation_runs_at_once()?)?;
        drop(workspace);
        for run in started {
            let runner = self.clone();
            tokio::spawn(async move {
                // ponytail: a storage failure mid-run has nowhere to be shown; the run
                // stays Running until the next start ends it as Needs attention.
                let _ = runner.execute(&run).await;
                // A slot is free: the next queued run need not wait for the timer.
                let _ = runner.start_queued();
            });
        }
        Ok(())
    }

    /// Executes a started run to its end: the core says which step is next, this
    /// runs it and reports how it ended.
    async fn execute(&self, run: &AutomationRun) -> Result<(), Error> {
        let mut outcome = None;
        loop {
            let action = (self.inner.open_workspace)()?.advance_automation_run(&run.id, outcome)?;
            let step_id = match action {
                RunAction::RunStep { step_id } => step_id,
                RunAction::End(_) => return Ok(()),
            };
            outcome = Some(match self.run_step(run, &step_id).await {
                Ok(outcome) => outcome,
                // A step the core refused has failed; the reason is the core's.
                Err(error) => StepOutcome::Failed {
                    reason: error.to_string(),
                },
            });
        }
    }

    async fn run_step(&self, run: &AutomationRun, step_id: &str) -> Result<StepOutcome, Error> {
        let failed = |reason: &str| {
            Ok(StepOutcome::Failed {
                reason: reason.to_owned(),
            })
        };
        let Some(step) = run.step(step_id) else {
            return failed("This step is no longer part of the run.");
        };
        match &step.action {
            StepAction::RunAgent {
                agent_id: Some(agent_id),
                execution_folder: Some(folder),
                ..
            } => self.run_agent(run, step_id, agent_id, folder).await,
            StepAction::RunAgent { .. } => failed("This step has no agent or no folder."),
            // A change the core refuses is the step's failure, in the core's words.
            StepAction::ChangeTicket { .. } => (self.inner.open_workspace)()?
                .apply_automation_change(&run.id, step_id)
                .map(|()| StepOutcome::Completed),
            StepAction::Notify { .. } => {
                let notification =
                    (self.inner.open_workspace)()?.automation_notification(&run.id, step_id)?;
                match (self.inner.notifier)(notification) {
                    Ok(()) => Ok(StepOutcome::Completed),
                    Err(reason) => {
                        failed(&format!("The notification could not be shown. {reason}"))
                    }
                }
            }
            StepAction::If { .. } => failed("This kind of step cannot run yet."),
        }
    }

    /// Runs the step's agent as a Chat in the step's folder: linked to the ticket,
    /// owned by the run, with no approval prompts and only the agent's tools.
    async fn run_agent(
        &self,
        run: &AutomationRun,
        step_id: &str,
        agent_id: &str,
        folder: &str,
    ) -> Result<StepOutcome, Error> {
        let mut workspace = (self.inner.open_workspace)()?;
        let agent = match workspace.automation_agent(agent_id) {
            Ok(agent) => agent,
            Err(Error::AutomationAgentNotFound(_)) => {
                return Ok(StepOutcome::Failed {
                    reason: "The agent this step runs was deleted.".to_owned(),
                });
            }
            Err(error) => return Err(error),
        };
        let name = &run.definition.name;
        let (title, links) = match &run.ticket {
            Some(ticket) => (
                format!("{name}: {} {}", ticket.reference, ticket.title),
                vec![ChatLink {
                    kind: ChatLinkKind::Ticket,
                    id: ticket.id.clone(),
                }],
            ),
            None => (name.clone(), Vec::new()),
        };
        let chat = workspace.create_automation_run_chat(
            &run.id,
            step_id,
            NewChat {
                title: Some(title),
                harness: agent.settings.harness.as_str().to_owned(),
                execution_folder: folder.to_owned(),
                folder_managed: false,
                links,
            },
        )?;
        drop(workspace);
        let settings = &agent.settings;
        let unattended = Unattended {
            run_id: run.id.clone(),
            model: settings.model.clone(),
            tools: settings.tools.clone(),
            turn_limit: settings.turn_limit,
            ticketd_cli: self.inner.cli.executable.clone(),
            ticketd_folders: self.inner.cli.folders.clone(),
        };
        let time_limit = Duration::from_secs(u64::from(settings.time_limit_minutes) * 60);
        let message = first_message(&settings.instructions, run);
        let ended = self
            .inner
            .host
            .run_unattended(&chat.id, &message, unattended, time_limit)
            .await;
        Ok(match ended {
            Ok(TurnEnd::Finished) => StepOutcome::Completed,
            Ok(end) => StepOutcome::Failed {
                reason: failure_reason(&end, &agent),
            },
            Err(error) => StepOutcome::Failed {
                reason: format!("The agent could not be started. {error}"),
            },
        })
    }
}

/// "Stop it and turn off": switches an Automation off on this device, ends its
/// active runs as Needs attention and interrupts the agents they were running. The
/// core refuses whatever those turns report afterwards, so nothing waits for them.
pub async fn stop_and_turn_off(
    open_workspace: &WorkspaceOpener,
    host: &ChatHost,
    automation_id: &str,
) -> Result<(), Error> {
    let chats = open_workspace()?.stop_and_turn_off_automation(automation_id)?;
    for chat_id in chats {
        // ponytail: an interrupt that fails leaves the agent to its turn and time
        // limits; the run has ended either way.
        let _ = host.stop(&chat_id).await;
    }
    Ok(())
}

/// Why the step failed, in plain words for the person.
fn failure_reason(end: &TurnEnd, agent: &AutomationAgent) -> String {
    let with = |sentence: &str, detail: &str| {
        if detail.trim().is_empty() {
            sentence.to_owned()
        } else {
            format!("{sentence} {}", detail.trim())
        }
    };
    let settings = &agent.settings;
    match end {
        TurnEnd::Finished => String::new(),
        TurnEnd::TurnLimitReached => format!(
            "The agent reached its limit of {} turns before finishing.",
            settings.turn_limit
        ),
        TurnEnd::TimeLimitReached => format!(
            "The agent was still working after its limit of {} minutes and was stopped.",
            settings.time_limit_minutes
        ),
        TurnEnd::ToolDenied { detail } => with(
            "The agent needed something it is not allowed to do.",
            detail,
        ),
        TurnEnd::Crashed { detail } => with("The agent's process stopped unexpectedly.", detail),
        TurnEnd::Failed { detail } => with("The agent could not finish.", detail),
    }
}
