//! The Automation runner: the loop that makes Automations happen. Each tick matches
//! new Workspace events into Queued runs and starts queued runs up to the limit; a
//! started run executes its steps one at a time, handing each outcome to the core's
//! run state machine, which says what comes next.
//!
//! The core owns every rule and record; the Chat host runs agents. This crate only
//! connects them, and depends on nothing else, so it runs without the desktop.

mod first_message;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ticketd_chat_host::{ChatHost, StopCause, TurnEnd, Unattended, WorkspaceOpener};
use ticketd_core::{
    AutomationAgent, AutomationNotification, AutomationRun, ChatLink, ChatLinkKind, Error, NewChat,
    RunAction, StepAction, StepOutcome,
};

pub use first_message::first_message;

/// Why runs left Running by an earlier process ended.
const RESTARTED: &str = "ticketd closed while this run was going.";
/// Why a run found Running that this runner is not executing ended: a restored
/// backup brought it back, or its executor could not record how it ended.
const ABANDONED: &str = "This run was still marked as going, but nothing was running it.";
/// Why a run ended when ticketd closed its agent's harness (#387 M17).
fn agent_stopped(cause: StopCause) -> &'static str {
    match cause {
        StopCause::Quit => "ticketd quit while this run was going.",
        StopCause::TurnedOff => "Chat was turned off while this run was going.",
        StopCause::Restore => "A backup was restored while this run was going.",
        StopCause::Unknown => "ticketd stopped this run's agent before it finished.",
    }
}

/// How executing one step ended, for the loop that executes the run.
enum Ran {
    Step(StepOutcome),
    /// The person took the run over: it has ended, and its Chat is theirs.
    TakenOver,
    /// ticketd closed the agent's harness, or would not start it, so the run
    /// cannot go on.
    AgentStopped(StopCause),
}

/// What an agent needs kept open so it can always run the ticketd CLI, whatever
/// else it may do. The host puts the CLI itself on the agent's `PATH`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TicketdCli {
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
    /// The runs this runner is executing. A run that is Running in the Workspace
    /// and not here has nothing behind it.
    going: Mutex<HashSet<String>>,
}

/// Takes a run out of the runs being executed when its task ends, however it ends.
struct Going<'a>(&'a Runner, &'a str);

impl Drop for Going<'_> {
    fn drop(&mut self) {
        self.0.going().remove(self.1);
    }
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
        open_workspace()?.end_running_automation_runs(&[], RESTARTED)?;
        Ok(Self {
            inner: Arc::new(Inner {
                open_workspace,
                host,
                cli,
                notifier,
                going: Mutex::new(HashSet::new()),
            }),
        })
    }

    fn going(&self) -> MutexGuard<'_, HashSet<String>> {
        self.inner
            .going
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// One pass of the loop: end the runs left Running with nothing behind them
    /// (after a restored backup, or bookkeeping that failed), queue a run for each
    /// new matching event and each schedule that has come due, then start queued
    /// runs up to the limit. The first pass after a start is what fires a schedule
    /// missed while ticketd was not running. Started runs execute on tasks of their
    /// own, so this returns at once; it must be called inside a Tokio runtime.
    ///
    /// Every part is tried, so one that fails does not hold up the others; the
    /// first failure is returned for the host to report.
    pub fn tick(&self) -> Result<(), Error> {
        let recovered = self.recover();
        let queued = self.queue();
        let started = self.start_queued();
        recovered.and(queued).and(started)
    }

    /// Ends every Running run this runner is not executing as Needs attention.
    fn recover(&self) -> Result<(), Error> {
        // Held across the write, so a run `start_queued` is starting is either not
        // Running yet or already listed.
        let going = self.going();
        let ids: Vec<String> = going.iter().cloned().collect();
        (self.inner.open_workspace)()?.end_running_automation_runs(&ids, ABANDONED)?;
        Ok(())
    }

    fn queue(&self) -> Result<(), Error> {
        let mut workspace = (self.inner.open_workspace)()?;
        let matched = workspace.queue_automation_runs().map(drop);
        let scheduled = workspace.queue_scheduled_automation_runs(None).map(drop);
        matched.and(scheduled)
    }

    /// Starts queued runs up to the limit, and none while Chat is not served (off,
    /// quitting, restoring): they wait until it is again (#387 M3).
    fn start_queued(&self) -> Result<(), Error> {
        if self.inner.host.serving().is_err() {
            return Ok(());
        }
        let started = {
            let mut going = self.going();
            // Read each time, so a change in Settings counts from the next run.
            let mut workspace = (self.inner.open_workspace)()?;
            let started = workspace.start_automation_runs(workspace.automation_runs_at_once()?)?;
            going.extend(started.iter().map(|run| run.id.clone()));
            started
        };
        for run in started {
            let runner = self.clone();
            tokio::spawn(async move {
                {
                    let _going = Going(&runner, &run.id);
                    if let Err(reason) = runner.execute(&run).await {
                        runner.abandon(&run.id, &reason);
                    }
                }
                // A slot is free: the next queued run need not wait for the timer.
                if let Err(error) = runner.start_queued() {
                    eprintln!("ticketd: queued Automation runs could not be started: {error}");
                }
            });
        }
        Ok(())
    }

    /// A run this runner cannot go on with ends as Needs attention with `reason`,
    /// so it never stays Running with nothing behind it. One that has already
    /// ended, because the person stopped it or took it over, is left as it ended.
    fn abandon(&self, run_id: &str, reason: &str) {
        let ended = (self.inner.open_workspace)()
            .and_then(|mut workspace| workspace.fail_automation_run(run_id, reason));
        match ended {
            Ok(true) => eprintln!("ticketd: Automation run {run_id} ended: {reason}"),
            Ok(false) => {}
            // The next pass finds it Running with nothing behind it and ends it.
            Err(error) => {
                eprintln!("ticketd: Automation run {run_id} could not be ended ({reason}): {error}")
            }
        }
    }

    /// Executes a started run to its end: the core says which step is next, this
    /// runs it and reports how it ended. The error is why the run cannot go on, in
    /// words for the person.
    async fn execute(&self, run: &AutomationRun) -> Result<(), String> {
        let lost = |error: Error| format!("ticketd could not keep this run's record. {error}");
        let mut outcome = None;
        loop {
            let action = (self.inner.open_workspace)()
                .and_then(|mut workspace| workspace.advance_automation_run(&run.id, outcome))
                .map_err(lost)?;
            let step_id = match action {
                RunAction::RunStep { step_id } => step_id,
                RunAction::End(_) => return Ok(()),
            };
            outcome = Some(match self.run_step(run, &step_id).await {
                Ok(Ran::Step(outcome)) => outcome,
                Ok(Ran::TakenOver) => return Ok(()),
                Ok(Ran::AgentStopped(cause)) => return Err(agent_stopped(cause).to_owned()),
                // A step the core refused has failed; the reason is the core's.
                Err(error) => StepOutcome::Failed {
                    reason: error.to_string(),
                },
            });
        }
    }

    async fn run_step(&self, run: &AutomationRun, step_id: &str) -> Result<Ran, Error> {
        let failed = |reason: &str| {
            Ok(Ran::Step(StepOutcome::Failed {
                reason: reason.to_owned(),
            }))
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
                .map(|()| Ran::Step(StepOutcome::Completed)),
            StepAction::Notify { .. } => {
                let notification =
                    (self.inner.open_workspace)()?.automation_notification(&run.id, step_id)?;
                match (self.inner.notifier)(notification) {
                    Ok(()) => Ok(Ran::Step(StepOutcome::Completed)),
                    Err(reason) => {
                        failed(&format!("The notification could not be shown. {reason}"))
                    }
                }
            }
            // The core reads the ticket now, so the answer follows what earlier steps did.
            StepAction::If { .. } => (self.inner.open_workspace)()?
                .automation_if_passes(&run.id, step_id)
                .map(|yes| Ran::Step(StepOutcome::Branched { yes })),
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
    ) -> Result<Ran, Error> {
        let mut workspace = (self.inner.open_workspace)()?;
        let agent = match workspace.automation_agent(agent_id) {
            Ok(agent) => agent,
            Err(Error::AutomationAgentNotFound(_)) => {
                return Ok(Ran::Step(StepOutcome::Failed {
                    reason: "The agent this step runs was deleted.".to_owned(),
                }));
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
        // Checked here, not left to the harness, which words a missing folder as
        // anything from a missing folder to a wrong binary (#387 3C1).
        if let Some(reason) = unusable_folder(folder) {
            return Ok(Ran::Step(StepOutcome::Failed { reason }));
        }
        let settings = &agent.settings;
        let unattended = Unattended {
            run_id: run.id.clone(),
            model: settings.model.clone(),
            tools: settings.tools.clone(),
            turn_limit: settings.turn_limit,
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
            Ok(TurnEnd::Finished) => Ran::Step(StepOutcome::Completed),
            Ok(TurnEnd::TakenOver) => Ran::TakenOver,
            Ok(TurnEnd::Stopped(cause)) => Ran::AgentStopped(cause),
            Ok(
                end @ (TurnEnd::TurnLimitReached
                | TurnEnd::TimeLimitReached
                | TurnEnd::ToolDenied { .. }
                | TurnEnd::CommandsUnavailable { .. }
                | TurnEnd::Crashed { .. }
                | TurnEnd::Failed { .. }),
            ) => Ran::Step(StepOutcome::Failed {
                reason: failure_reason(&end, &agent),
            }),
            // Chat went off, ticketd quit or a restore began between the pass
            // that started the run and its agent (#387 M3).
            Err(error) => match StopCause::of(&error) {
                Some(cause) => Ran::AgentStopped(cause),
                None => Ran::Step(StepOutcome::Failed {
                    reason: format!(
                        "The agent could not be started. {}",
                        sentence(&error.to_string())
                    ),
                }),
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

/// Why the step's folder cannot be an agent's working directory, if it cannot.
/// Control characters in the path are shown as spaces.
fn unusable_folder(folder: &str) -> Option<String> {
    let shown: String = folder
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let path = Path::new(folder);
    if !path.is_absolute() || folder.chars().any(char::is_control) {
        return Some(format!(
            "The step's folder isn't a full path to a folder: {}.",
            shown.trim()
        ));
    }
    match std::fs::metadata(path) {
        Ok(found) if found.is_dir() => None,
        Ok(_) => Some(format!("The step's folder is a file, not a folder: {shown}.")),
        Err(_) => Some(format!("The step's folder doesn't exist: {shown}.")),
    }
}

/// `text` trimmed and ending as a sentence: a full stop is added unless it already
/// ends with one, a question or exclamation mark, or a closing quote after one.
fn sentence(text: &str) -> String {
    let text = text.trim();
    let ends = text.trim_end_matches(['"', '\'', ')', '`', '\u{201d}']);
    if text.is_empty() || ends.ends_with(['.', '!', '?']) {
        text.to_owned()
    } else {
        format!("{text}.")
    }
}

/// "1 turn", "40 turns".
fn counted(count: u32, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

/// Why the step failed, in plain words for the person.
fn failure_reason(end: &TurnEnd, agent: &AutomationAgent) -> String {
    let with = |first: &str, detail: &str| {
        if detail.trim().is_empty() {
            first.to_owned()
        } else {
            format!("{first} {}", sentence(detail))
        }
    };
    let settings = &agent.settings;
    match end {
        // Not failures: the caller handles them before asking for a reason.
        TurnEnd::Finished | TurnEnd::TakenOver | TurnEnd::Stopped(_) => String::new(),
        TurnEnd::TurnLimitReached => format!(
            "The agent reached its limit of {} before finishing.",
            counted(settings.turn_limit, "turn")
        ),
        TurnEnd::TimeLimitReached => format!(
            "The agent was still working after its limit of {} and was stopped.",
            counted(settings.time_limit_minutes, "minute")
        ),
        TurnEnd::ToolDenied { detail } => with(
            "The agent needed something it is not allowed to do.",
            detail,
        ),
        TurnEnd::CommandsUnavailable { detail } => {
            with("The agent could not run commands.", detail)
        }
        TurnEnd::Crashed { detail } => with("The agent's process stopped unexpectedly.", detail),
        TurnEnd::Failed { detail } => with("The agent could not finish.", detail),
    }
}

#[cfg(test)]
mod tests {
    /// L27: a limit of 1 reads "1 turn", not "1 turns".
    #[test]
    fn a_limit_is_counted_in_the_singular_only_when_it_is_one() {
        assert_eq!(super::counted(1, "turn"), "1 turn");
        assert_eq!(super::counted(1, "minute"), "1 minute");
        assert_eq!(super::counted(40, "turn"), "40 turns");
    }

    /// M17: a detail from elsewhere ends the reason as a sentence, once.
    #[test]
    fn a_detail_ends_as_a_sentence() {
        use super::sentence;
        assert_eq!(sentence("Chat is turned off"), "Chat is turned off.");
        assert_eq!(sentence(" Done. "), "Done.");
        assert_eq!(sentence("Denied `ls`?"), "Denied `ls`?");
        assert_eq!(sentence("It said \"no.\""), "It said \"no.\"");
        assert_eq!(sentence(""), "");
    }
}
