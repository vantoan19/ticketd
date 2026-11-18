//! The Automation runner: the loop that makes Automations happen. Each tick matches
//! new Workspace events into Queued runs and starts queued runs up to the limit; a
//! started run is executed by asking the core what to do next and reporting how it
//! went. The core runs the steps that are its own (Change ticket, If) and every
//! ending; this runs only what needs a process: an agent's turn and a notification.
//!
//! The core owns every rule and record; the Chat host runs agents. This crate only
//! connects them, and depends on nothing else, so it runs without the desktop.

mod first_message;

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tracing::Instrument;

use ticketd_chat_host::{ChatHost, HostError, StopReason, TurnEnd, Unattended, WorkspaceOpener};
use ticketd_core::{
    AgentStart, Automation, AutomationAgent, AutomationNotification, AutomationRun, Error,
    RunAction, StepOutcome, Workspace,
};

use first_message::first_message;

/// Why runs left Running by an earlier process ended.
const RESTARTED: &str = "ticketd closed while this run was going.";
/// Why a run found Running that this runner is not executing ended: a restored
/// backup brought it back, or its executor could not record how it ended.
const ABANDONED: &str = "This run was still marked as going, but nothing was running it.";
/// Why a run ended when ticketd closed its agent's harness (#387 M17).
fn agent_stopped(reason: Option<StopReason>) -> &'static str {
    match reason {
        Some(StopReason::Quit) => "ticketd quit while this run was going.",
        Some(StopReason::TurnedOff) => "Chat was turned off while this run was going.",
        Some(StopReason::Restore) => "A backup was restored while this run was going.",
        // Reasons that end a run's agent by other means, which end the run themselves or
        // are not known: the general words.
        Some(
            StopReason::TakenOver
            | StopReason::TimeLimit
            | StopReason::RunEnded
            | StopReason::Trashed
            | StopReason::ExplicitResume
            | StopReason::StorageFailed,
        )
        | None => "ticketd stopped this run's agent before it finished.",
    }
}

/// How executing one step ended, for the loop that executes the run.
enum Ran {
    Step(StepOutcome),
    /// The person took the run over: it has ended, and its Chat is theirs.
    TakenOver,
    /// ticketd closed the agent's harness, or would not start it, so the run
    /// cannot go on.
    AgentStopped(Option<StopReason>),
    /// Storage failed starting or following the agent, so what happened to it is
    /// unknown. Not the step's failure: no failure path follows it. The words say why.
    StorageFailed(String),
}

/// The Chat host, while there is one to run agents on. The host answers why not
/// while nothing may run: Chat is off (`HostError::TurnedOff`), a backup is being
/// restored (`HostError::Restoring`), or it could not start. A run whose agent cannot
/// start for that reason ends saying so. Asked each time it is needed, so the runner
/// follows Chat being switched off and on.
pub type HostSource = Arc<dyn Fn() -> Result<ChatHost, HostError> + Send + Sync>;

/// Shows a desktop notification, or says why it could not. The host supplies it: the
/// runner knows what to say, not how a desktop shows it.
pub type Notifier = Arc<dyn Fn(AutomationNotification) -> Result<(), String> + Send + Sync>;

#[derive(Clone)]
pub struct Runner {
    inner: Arc<Inner>,
}

struct Inner {
    open_workspace: WorkspaceOpener,
    host: HostSource,
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
        host: HostSource,
        notifier: Notifier,
    ) -> Result<Self, Error> {
        open_workspace()?.end_running_automation_runs(&[], RESTARTED)?;
        Ok(Self {
            inner: Arc::new(Inner {
                open_workspace,
                host,
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
    /// A pass is one use of the Workspace. It returns whether anything needs the
    /// runner (an Automation is on, or a run is Queued or Running); when nothing
    /// does, the pass ends after that one read and the host may wait longer.
    ///
    /// Every part is tried, so one that fails does not hold up the others; the
    /// first failure is returned for the host to report.
    pub fn tick(&self) -> Result<bool, Error> {
        // Chat off or a restore under way: nothing is matched, and each cursor holds.
        if (self.inner.host)().is_err() {
            return Ok(false);
        }
        let mut workspace = (self.inner.open_workspace)()?;
        if !workspace.automations_need_the_runner()? {
            return Ok(false);
        }
        // Only a pass with work to look at is a span: an idle one would log every few seconds.
        let _pass = tracing::info_span!("automation_pass").entered();
        let recovered = self.recover(&mut workspace);
        let deleted = self.end_deleted(&mut workspace);
        let queued = queue(&mut workspace);
        let started = self.start_queued_in(&mut workspace);
        recovered
            .and(deleted)
            .and(queued)
            .and(started)
            .map(|()| true)
    }

    /// Ends the runs of Automations deleted on another desktop and brought here by
    /// Workspace sync, as deleting one here does: its Queued runs never start, and
    /// the agents of its Running runs are closed.
    fn end_deleted(&self, workspace: &mut Workspace) -> Result<(), Error> {
        let chats = workspace.end_runs_of_deleted_automations()?;
        if !chats.is_empty() {
            let runner = self.clone();
            tokio::spawn(async move { runner.interrupt(&chats).await });
        }
        Ok(())
    }

    /// Ends every Running run this runner is not executing as Needs attention.
    fn recover(&self, workspace: &mut Workspace) -> Result<(), Error> {
        // Held across the write, so a run `start_queued` is starting is either not
        // Running yet or already listed.
        let going = self.going();
        let ids: Vec<String> = going.iter().cloned().collect();
        workspace.end_running_automation_runs(&ids, ABANDONED)?;
        Ok(())
    }

    /// Starts queued runs up to the limit, and none while Chat is not served (off,
    /// quitting, restoring): they wait until it is again (#387 M3).
    fn start_queued(&self) -> Result<(), Error> {
        let mut workspace = (self.inner.open_workspace)()?;
        self.start_queued_in(&mut workspace)
    }

    fn start_queued_in(&self, workspace: &mut Workspace) -> Result<(), Error> {
        match (self.inner.host)() {
            Ok(host) if host.serving().is_ok() => {}
            _ => return Ok(()),
        }
        let started = {
            let mut going = self.going();
            // Read each time, so a change in Settings counts from the next run.
            let at_once = workspace.automation_runs_at_once()?;
            let started = workspace.start_automation_runs(at_once)?;
            going.extend(started.iter().map(|run| run.id.clone()));
            started
        };
        for run in started {
            let runner = self.clone();
            // A root span: the run outlives the pass that started it, and the pass's own
            // duration must not wait for it.
            let span =
                tracing::info_span!(parent: None, "automation_run", automation_run_id = %run.id);
            tokio::spawn(async move {
                async {
                    let _going = Going(&runner, &run.id);
                    if let Err(reason) = runner.execute(&run).await {
                        runner.abandon(&run.id, &reason);
                    }
                }
                .instrument(span)
                .await;
                // A slot is free: the next queued run need not wait for the timer.
                if let Err(error) = runner.start_queued() {
                    tracing::warn!(
                        error_kind = error.kind().code(),
                        %error,
                        "queued Automation runs could not be started"
                    );
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
            // The run stopped before it finished, which is work that stopped. The reason is
            // words for the person and can carry a Harness's text, so only the run is
            // logged.
            Ok(true) => tracing::error!(automation_run_id = run_id, "Automation run abandoned"),
            Ok(false) => {}
            // The next pass finds it Running with nothing behind it and ends it.
            Err(error) => tracing::warn!(
                automation_run_id = run_id,
                error_kind = error.kind().code(),
                %error,
                "Automation run could not be ended"
            ),
        }
    }

    /// Executes a started run to its end: the core says what to do next, this does
    /// it and reports how it went. The error is why the run cannot go on, in words
    /// for the person: the core could not keep the run's record, which is not any
    /// step's failure, so no failure path follows it.
    async fn execute(&self, run: &AutomationRun) -> Result<(), String> {
        let lost = |error: Error| format!("ticketd could not keep this run's record. {error}");
        let mut outcome = None;
        loop {
            let action = (self.inner.open_workspace)()
                .and_then(|mut workspace| workspace.advance_automation_run(&run.id, outcome))
                .map_err(lost)?;
            outcome = Some(match action {
                RunAction::RunAgent(start) => match self.run_agent(&run.id, &start).await {
                    Ran::Step(outcome) => outcome,
                    Ran::TakenOver => return Ok(()),
                    Ran::AgentStopped(reason) => return Err(agent_stopped(reason).to_owned()),
                    Ran::StorageFailed(why) => return Err(why),
                },
                RunAction::Notify { notification, .. } => self.notify(notification),
                // Ended, here or elsewhere (the person stopped it or took it over):
                // nothing more is left to do for it.
                RunAction::End(_) | RunAction::Ended => return Ok(()),
            });
        }
    }

    fn notify(&self, notification: AutomationNotification) -> StepOutcome {
        match (self.inner.notifier)(notification) {
            Ok(()) => StepOutcome::Completed,
            Err(reason) => StepOutcome::Failed {
                reason: format!("The notification could not be shown. {reason}"),
            },
        }
    }

    /// Runs the step's agent in its Chat, which the core made: with no approval
    /// prompts and only the agent's tools.
    async fn run_agent(&self, run_id: &str, start: &AgentStart) -> Ran {
        let agent = &start.agent;
        let settings = &agent.settings;
        let unattended = Unattended {
            run_id: run_id.to_owned(),
            model: settings.model.clone(),
            tools: settings.tools.clone(),
            turn_limit: settings.turn_limit,
        };
        let time_limit = Duration::from_secs(u64::from(settings.time_limit_minutes) * 60);
        let message = first_message(&settings.instructions, &start.started_by);
        // Chat went off, or a restore began, between the pass that started the run and
        // its agent: the run says which.
        let host = match (self.inner.host)() {
            Ok(host) => host,
            Err(why) => return Ran::AgentStopped(StopReason::of(&why)),
        };
        let ended = host
            .run_unattended(&start.chat_id, &message, unattended, time_limit)
            .await;
        match ended {
            Ok(TurnEnd::Finished) => Ran::Step(StepOutcome::Completed),
            Ok(TurnEnd::TakenOver) => Ran::TakenOver,
            Ok(TurnEnd::Stopped(reason)) => Ran::AgentStopped(reason),
            Ok(
                end @ (TurnEnd::TurnLimitReached
                | TurnEnd::TimeLimitReached
                | TurnEnd::ToolDenied { .. }
                | TurnEnd::CommandsUnavailable { .. }
                | TurnEnd::Crashed { .. }
                | TurnEnd::Failed { .. }),
            ) => Ran::Step(StepOutcome::Failed {
                reason: failure_reason(&end, agent),
            }),
            // Chat went off, ticketd quit or a restore began between the pass
            // that started the run and its agent (#387 M3).
            Err(error) => match StopReason::of(&error) {
                Some(reason) => Ran::AgentStopped(Some(reason)),
                // The Workspace could not be read or written: the run's record is in
                // doubt, not the agent's work, so the step's failure path must not run.
                None if matches!(error, HostError::StorageFailed(_)) => {
                    Ran::StorageFailed(format!(
                        "ticketd could not keep this run's record. {}",
                        sentence(&error.to_string())
                    ))
                }
                None => Ran::Step(StepOutcome::Failed {
                    reason: format!(
                        "The agent could not be started. {}",
                        sentence(&error.to_string())
                    ),
                }),
            },
        }
    }
}

impl Runner {
    /// The person's Stop of a Queued or Running run: it ends as Needs attention, and
    /// the agent it had working is closed. The core ends the run and says which agents
    /// were working in one transaction, so an agent started meanwhile is closed too;
    /// the outcome its turn reports afterwards is refused, so nothing waits for it.
    /// With Chat off there is no agent to close, and only the record changes.
    pub async fn stop_run(&self, run_id: &str) -> Result<AutomationRun, Error> {
        let (run, chats) = (self.inner.open_workspace)()?.stop_automation_run(run_id)?;
        self.interrupt(&chats).await;
        Ok(run)
    }

    /// Deletes an Automation: its Queued and Running runs end as Needs attention,
    /// already answered, and the agents they had working are closed.
    pub async fn delete_automation(&self, automation_id: &str) -> Result<(), Error> {
        let chats = (self.inner.open_workspace)()?.delete_automation(automation_id)?;
        self.interrupt(&chats).await;
        Ok(())
    }

    /// "Stop it and turn off": switches an Automation off on this device, ends its
    /// active runs as Needs attention and closes the agents they had working. Returns
    /// the Automation as it is then.
    pub async fn stop_and_turn_off(&self, automation_id: &str) -> Result<Automation, Error> {
        let chats = (self.inner.open_workspace)()?.stop_and_turn_off_automation(automation_id)?;
        self.interrupt(&chats).await;
        (self.inner.open_workspace)()?.automation(automation_id)
    }

    /// Closes the agents working in `chats`, whose runs have just ended. A harness
    /// that cannot be confirmed closed is reported and left to its turn and time
    /// limits; the run has ended either way.
    async fn interrupt(&self, chats: &[String]) {
        if chats.is_empty() {
            return;
        }
        // Chat off: turning it off already stopped every agent.
        let Ok(host) = (self.inner.host)() else {
            return;
        };
        for unconfirmed in host.end_run_agents(chats).await {
            // Why it could not be confirmed can carry the Harness's own output.
            tracing::warn!(
                chat_id = unconfirmed.chat_id,
                "the agent in a Chat may still be running"
            );
        }
    }
}

fn queue(workspace: &mut Workspace) -> Result<(), Error> {
    let matched = workspace.queue_automation_runs().map(drop);
    let scheduled = workspace.queue_scheduled_automation_runs(None).map(drop);
    matched.and(scheduled)
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
