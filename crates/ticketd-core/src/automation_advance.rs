//! Advancing a run: the one call an executor makes to move a Running run along.
//! The executor reports how the step the run was on ended (nothing, to begin), and
//! the core records it and decides what comes next. Change ticket and If steps are
//! the core's own work, so they run here, in the transaction that records the
//! step before them; what comes back is only what the core cannot do itself: an
//! agent to run in its Chat, a notification to show, or the end of the run.
//!
//! The write lock taken at the start is what keeps the run Running and on its step
//! for every effect below: a Stop, a take-over, turning the Automation off or
//! deleting it waits for it, and then finds the step finished.

use std::fmt;
use std::path::Path;

use rusqlite::params;

use crate::automation_agents::AutomationAgent;
use crate::automation_endings::{Cause, end};
use crate::automation_run_machine::{Next, RunEnd, StepOutcome, next_action};
use crate::automation_runs::{AutomationRun, AutomationRunStatus, AutomationStepStatus, NOW, one};
use crate::automation_steps::AutomationNotification;
use crate::automations::{StepAction, Trigger};
use crate::chats::{ChatLink, ChatLinkKind, NewChat, create_chat_in};
use crate::events::{WorkspaceEvent, WorkspaceEventType};
use crate::{Error, Workspace};

/// What an executor does next for a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunAction {
    /// Run this agent step in its Chat, which is made and belongs to the run.
    RunAgent(AgentStart),
    /// Show this notification for the Notify me step the run is on.
    Notify {
        step_id: String,
        notification: AutomationNotification,
    },
    /// The run has ended.
    End(RunEnd),
    /// The run had already ended when this was asked: it was stopped, taken over,
    /// switched off or deleted meanwhile. Nothing was recorded and nothing is left
    /// to do for it.
    Ended,
}

/// What an executor needs to run a Run agent step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStart {
    pub step_id: String,
    /// The Chat the agent works in, in the step's folder, linked to the ticket and
    /// owned by the run, which keeps it out of the Chat list.
    pub chat_id: String,
    pub agent: AutomationAgent,
    pub started_by: StartedBy,
}

/// What started a run, for the first message of its agent's Chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartedBy {
    /// A change to this ticket.
    Ticket { reference: String, data: TicketData },
    /// The Automation's schedule. No ticket started it.
    Schedule,
    /// The person pressed Run now. No ticket started it.
    ByHand,
    /// A ticket started it, and the run no longer says which.
    UnnamedTicket,
}

/// The ticket's own words: its title and what changed. Other people wrote them, so
/// they are data and never instructions. They can be read only as one line each that
/// cannot close the block they are placed in, so no message can carry them raw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketData {
    title: String,
    changed: String,
}

impl TicketData {
    fn new(title: &str, changed: &str) -> Self {
        Self {
            title: fence(title),
            changed: fence(changed),
        }
    }
}

impl fmt::Display for TicketData {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Title: {}\nWhat changed: {}",
            self.title, self.changed
        )
    }
}

/// Text as one line that cannot close the block it sits in.
fn fence(text: &str) -> String {
    text.replace('<', "&lt;")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn changed(event: &WorkspaceEvent) -> String {
    let field = |name: &str| event.current.as_ref().and_then(|v| v[name].as_str());
    let previous = |name: &str| event.previous.as_ref().and_then(|v| v[name].as_str());
    match event.kind {
        WorkspaceEventType::TicketCreated => "The ticket was created.".to_owned(),
        WorkspaceEventType::TicketUpdated => "The ticket was edited.".to_owned(),
        WorkspaceEventType::TicketStatusChanged => format!(
            "Status changed from {} to {}",
            previous("status").unwrap_or("unknown"),
            field("status").unwrap_or("unknown")
        ),
        WorkspaceEventType::TicketTagAdded => {
            format!("Tag added: {}", field("tag").unwrap_or_default())
        }
        WorkspaceEventType::TicketTagRemoved => {
            format!("Tag removed: {}", previous("tag").unwrap_or_default())
        }
        WorkspaceEventType::ActivityCreated => "An update was posted on the ticket.".to_owned(),
    }
}

fn started_by(run: &AutomationRun) -> StartedBy {
    let (Some(ticket), Some(event)) = (&run.ticket, &run.event) else {
        return match run.definition.trigger {
            Some(Trigger::Schedule { .. }) => StartedBy::Schedule,
            Some(Trigger::ByHand) => StartedBy::ByHand,
            // A ticket started it, and the run no longer says which.
            Some(
                Trigger::TicketCreated
                | Trigger::TicketUpdated
                | Trigger::StatusChanged { .. }
                | Trigger::TagAdded { .. }
                | Trigger::TagRemoved { .. }
                | Trigger::ActivityCreated,
            )
            | None => StartedBy::UnnamedTicket,
        };
    };
    StartedBy::Ticket {
        reference: ticket.reference.clone(),
        data: TicketData::new(&ticket.title, &changed(event)),
    }
}

/// Why the step's folder cannot be an agent's working directory, if it cannot.
/// Checked here, not left to the harness, which words a missing folder as anything
/// from a missing folder to a wrong binary (#387 3C1). Control characters in the
/// path are shown as spaces.
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
        Ok(_) => Some(format!(
            "The step's folder is a file, not a folder: {shown}."
        )),
        Err(_) => Some(format!("The step's folder doesn't exist: {shown}.")),
    }
}

/// Whether `error` says storage failed, rather than that the Workspace refused what
/// a step asked. A refusal is the step's failure; storage failing is not the step's.
fn storage_failed(error: &Error) -> bool {
    matches!(error, Error::Database(_) | Error::Directory(_))
}

/// How starting a step went.
enum Started {
    /// The core did the step's work itself, or could not: it ended this way.
    Finished(StepOutcome),
    /// The step waits for its executor.
    Handed(Box<RunAction>),
}

impl Workspace {
    /// Records how the step a Running run was on ended (`None` to begin the run) and
    /// returns what its executor does next. The step is marked; Change ticket and If
    /// steps that come next run inside this call, each recorded as it ends; and
    /// either an agent step or a Notify me step is marked Running and handed back,
    /// or the run ends. A step the Workspace refuses fails, in the Workspace's words;
    /// storage failing is the error, with nothing recorded, and not any step's
    /// failure. A run that has already ended is `RunAction::Ended`.
    pub fn advance_automation_run(
        &mut self,
        run_id: &str,
        outcome: Option<StepOutcome>,
    ) -> Result<RunAction, Error> {
        self.connection
            .execute_batch("SAVEPOINT advance_automation_run")?;
        let advanced = crate::transaction_write_lock(&self.connection)
            .and_then(|()| self.advance_inside(run_id, outcome));
        match advanced {
            Ok(action) => {
                if let Err(error) = self
                    .connection
                    .execute_batch("RELEASE advance_automation_run")
                {
                    let _ = self.connection.execute_batch(
                        "ROLLBACK TO advance_automation_run; RELEASE advance_automation_run",
                    );
                    return Err(error.into());
                }
                Ok(action)
            }
            Err(error) => {
                self.connection.execute_batch(
                    "ROLLBACK TO advance_automation_run; RELEASE advance_automation_run",
                )?;
                Err(error)
            }
        }
    }

    fn advance_inside(
        &mut self,
        run_id: &str,
        outcome: Option<StepOutcome>,
    ) -> Result<RunAction, Error> {
        let run = one(&self.connection, run_id)?;
        match run.status {
            AutomationRunStatus::Running => {}
            AutomationRunStatus::Completed
            | AutomationRunStatus::NeedsAttention
            | AutomationRunStatus::TakenOver => return Ok(RunAction::Ended),
            AutomationRunStatus::Queued => {
                return Err(Error::AutomationRun("the run is not running".into()));
            }
        }
        let current = run
            .steps
            .iter()
            .find(|step| step.status == AutomationStepStatus::Running)
            .map(|step| step.step_id.clone());
        let mut finished = match (current, outcome) {
            (Some(step_id), Some(outcome)) => Some((step_id, outcome)),
            (None, None) => None,
            (Some(_), None) => return Err(Error::AutomationRun("the run has begun".into())),
            (None, Some(_)) => return Err(Error::AutomationRun("the run is on no step".into())),
        };
        loop {
            if let Some((step_id, outcome)) = &finished {
                let (status, reason) = match outcome {
                    StepOutcome::Completed | StepOutcome::Branched { .. } => ("completed", None),
                    StepOutcome::Failed { reason } => ("failed", Some(reason)),
                };
                self.connection.execute(
                    &format!("UPDATE automation_run_steps SET status = ?3, reason = ?4, ended_at = {NOW} WHERE run_id = ?1 AND step_id = ?2 AND status = 'running'"),
                    params![run_id, step_id, status, reason],
                )?;
            }
            let next = next_action(
                &run.definition.steps,
                finished
                    .as_ref()
                    .map(|(step_id, outcome)| (step_id.as_str(), outcome)),
            );
            let step_id = match next {
                Next::End(run_end) => {
                    end(&self.connection, run_id, Cause::Path(&run_end))?;
                    return Ok(RunAction::End(run_end));
                }
                Next::Step(step_id) => step_id,
            };
            self.connection.execute(
                "INSERT INTO automation_run_steps (run_id, position, step_id, status) VALUES (?1, (SELECT COUNT(*) FROM automation_run_steps WHERE run_id = ?1), ?2, 'running')",
                params![run_id, step_id],
            )?;
            match self.start_step(&run, &step_id)? {
                Started::Finished(outcome) => finished = Some((step_id, outcome)),
                Started::Handed(action) => return Ok(*action),
            }
        }
    }

    /// Starts the step `step_id`, which the run has just been marked as on.
    fn start_step(&mut self, run: &AutomationRun, step_id: &str) -> Result<Started, Error> {
        let failed = |reason: &str| {
            Ok(Started::Finished(StepOutcome::Failed {
                reason: reason.to_owned(),
            }))
        };
        // A refusal is the step's failure, in the Workspace's words.
        let refusal = |result: Result<StepOutcome, Error>| match result {
            Ok(outcome) => Ok(Started::Finished(outcome)),
            Err(error) if storage_failed(&error) => Err(error),
            Err(error) => failed(&error.to_string()),
        };
        let Some(step) = run.step(step_id) else {
            return failed("This step is no longer part of the run.");
        };
        match &step.action {
            StepAction::RunAgent {
                agent_id: Some(agent_id),
                execution_folder: Some(folder),
                ..
            } => self.start_agent(run, step_id, agent_id, folder),
            StepAction::RunAgent { .. } => failed("This step has no agent or no folder."),
            StepAction::ChangeTicket { .. } => refusal(
                self.apply_change(run, step)
                    .map(|()| StepOutcome::Completed),
            ),
            // Read now, so the answer follows what earlier steps did.
            StepAction::If { .. } => refusal(
                self.if_passes(run, step)
                    .map(|yes| StepOutcome::Branched { yes }),
            ),
            StepAction::Notify { .. } => match self.notification(run, step) {
                Ok(notification) => Ok(Started::Handed(Box::new(RunAction::Notify {
                    step_id: step_id.to_owned(),
                    notification,
                }))),
                Err(error) => refusal(Err(error)),
            },
        }
    }

    /// Makes the Chat of a Run agent step: in the step's folder, linked to the
    /// ticket, owned by the run and using the agent's harness.
    fn start_agent(
        &mut self,
        run: &AutomationRun,
        step_id: &str,
        agent_id: &str,
        folder: &str,
    ) -> Result<Started, Error> {
        let failed = |reason: String| Ok(Started::Finished(StepOutcome::Failed { reason }));
        let agent = match self.automation_agent(agent_id) {
            Ok(agent) => agent,
            Err(Error::AutomationAgentNotFound(_)) => {
                return failed("The agent this step runs was deleted.".to_owned());
            }
            Err(error) => return Err(error),
        };
        // Before the Chat, so a step that cannot run leaves none behind.
        if let Some(reason) = unusable_folder(folder) {
            return failed(reason);
        }
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
        let chat = create_chat_in(
            &self.connection,
            Some(&format!("{}:{step_id}:chat", run.id)),
            NewChat {
                title: Some(title),
                harness: agent.settings.harness.as_str().to_owned(),
                execution_folder: folder.to_owned(),
                folder_managed: false,
                links,
            },
        )?;
        self.connection.execute(
            "UPDATE chats SET automation_run_id = ?2 WHERE id = ?1",
            params![chat.id, run.id],
        )?;
        let changed = self.connection.execute(
            "UPDATE automation_run_steps SET chat_id = ?3 WHERE run_id = ?1 AND step_id = ?2 AND status = 'running'",
            params![run.id, step_id, chat.id],
        )?;
        if changed == 0 {
            return Err(Error::AutomationRun("the run is not on that step".into()));
        }
        Ok(Started::Handed(Box::new(RunAction::RunAgent(AgentStart {
            step_id: step_id.to_owned(),
            chat_id: chat.id,
            agent,
            started_by: started_by(run),
        }))))
    }
}
