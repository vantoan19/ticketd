//! Automation runs: one record per firing of an Automation, local to this device.
//! This module queues runs from the Workspace event log, starts them in event order
//! and records what `automation_run_machine` decides after each step.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::automation_matching::{LOCAL_SOURCE, TicketFacts, matches};
use crate::automation_run_machine::{RunAction, RunEnd, StepOutcome, next_action};
use crate::automations::{AutomationDefinition, Step};
use crate::chats::{Chat, NewChat};
use crate::events::WorkspaceEvent;
use crate::{Error, Workspace};

const RETENTION_DAYS: i64 = 90;
/// Events read from the log per query while matching.
const EVENT_BATCH: u32 = 500;
/// Why a run the person stopped needs attention, and why its step did not finish.
const STOPPED: &str = "You stopped this run.";
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Queued,
    Running,
    Completed,
    NeedsAttention,
    /// The person replied in, or stopped, the run's Chat.
    TakenOver,
}

impl AutomationRunStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::NeedsAttention => "needs_attention",
            Self::TakenOver => "taken_over",
        }
    }
}

/// The status of a step a run reached. A step with no record was not reached: it is
/// Waiting while the run is active and Not run once it has ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationStepStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationRunStep {
    pub step_id: String,
    pub status: AutomationStepStatus,
    /// Why it failed, in plain words.
    pub reason: Option<String>,
    /// The Chat of a Run agent step.
    pub chat_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

/// The ticket a run acts on, as it is called now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationRunTicket {
    pub id: String,
    pub reference: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    /// The Workspace event that started it.
    pub event: WorkspaceEvent,
    pub ticket: Option<AutomationRunTicket>,
    /// The Automation as it was when the run was created. The run executes this, so
    /// a later edit never changes a run.
    pub definition: AutomationDefinition,
    pub status: AutomationRunStatus,
    /// Why it needs attention.
    pub reason: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    /// The steps reached so far, in the order they ran.
    pub steps: Vec<AutomationRunStep>,
}

impl AutomationRun {
    /// The step with `id` in the definition the run executes, at any depth.
    pub fn step(&self, id: &str) -> Option<&Step> {
        crate::automations::find_step(&self.definition.steps, id)
    }
}

/// `ticket_id` is nullable for the runs a schedule or "Run now" will start. The
/// partial index is the rule that a ticket has one active run per Automation.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id), event_id INTEGER NOT NULL, event TEXT NOT NULL, ticket_id TEXT REFERENCES tickets(id), definition TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT ({NOW}), started_at TEXT, ended_at TEXT);
         CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_active ON automation_runs(automation_id, ticket_id) WHERE status IN ('queued', 'running');
         CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs(automation_id);
         CREATE TABLE IF NOT EXISTS automation_run_steps (run_id TEXT NOT NULL REFERENCES automation_runs(id), position INTEGER NOT NULL, step_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, chat_id TEXT, started_at TEXT NOT NULL DEFAULT ({NOW}), ended_at TEXT, PRIMARY KEY(run_id, position));"
    ))?;
    let owned: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chats') WHERE name = 'automation_run_id')",
        [],
        |row| row.get(0),
    )?;
    if !owned {
        connection.execute_batch("ALTER TABLE chats ADD COLUMN automation_run_id TEXT;")?;
    }
    // Views refresh on the change token, so a run that starts or ends shows up.
    crate::change_token::track(connection, "automation_runs")?;
    crate::change_token::track(connection, "automation_run_steps")?;
    connection.execute_batch("PRAGMA user_version = 71;")?;
    Ok(())
}

fn named<T: serde::de::DeserializeOwned>(text: String) -> Result<T, Error> {
    Ok(serde_json::from_value(serde_json::Value::String(text))?)
}

fn read(connection: &Connection, filter: &str, value: &str) -> Result<Vec<AutomationRun>, Error> {
    let mut statement = connection.prepare(&format!(
        "SELECT r.id, r.automation_id, r.event, r.definition, r.status, r.reason, r.created_at, r.started_at, r.ended_at, t.id, t.reference, t.title
         FROM automation_runs r LEFT JOIN tickets t ON t.id = r.ticket_id WHERE {filter} ORDER BY r.rowid DESC"
    ))?;
    let rows = statement
        .query_map([value], |row| {
            let ticket = match row.get::<_, Option<String>>(9)? {
                Some(id) => Some(AutomationRunTicket {
                    id,
                    reference: row.get(10)?,
                    title: row.get(11)?,
                }),
                None => None,
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                ticket,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut steps = connection.prepare(
        "SELECT step_id, status, reason, chat_id, started_at, ended_at FROM automation_run_steps WHERE run_id = ?1 ORDER BY position",
    )?;
    rows.into_iter()
        .map(
            |(
                id,
                automation_id,
                event,
                definition,
                status,
                reason,
                created,
                started,
                ended,
                ticket,
            )| {
                let reached = steps
                    .query_map([&id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(AutomationRun {
                    steps: reached
                        .into_iter()
                        .map(|(step_id, status, reason, chat_id, started_at, ended_at)| {
                            Ok(AutomationRunStep {
                                step_id,
                                status: named(status)?,
                                reason,
                                chat_id,
                                started_at,
                                ended_at,
                            })
                        })
                        .collect::<Result<_, Error>>()?,
                    id,
                    automation_id,
                    event: serde_json::from_str(&event)?,
                    ticket,
                    definition: serde_json::from_str(&definition)?,
                    status: named(status)?,
                    reason,
                    created_at: created,
                    started_at: started,
                    ended_at: ended,
                })
            },
        )
        .collect()
}

fn one(connection: &Connection, id: &str) -> Result<AutomationRun, Error> {
    read(connection, "r.id = ?1", id)?
        .pop()
        .ok_or_else(|| Error::AutomationRunNotFound(id.to_owned()))
}

fn facts(connection: &Connection, ticket_id: &str) -> Result<TicketFacts, Error> {
    let project_id = connection
        .query_row(
            "SELECT project_id FROM tickets WHERE id = ?1",
            [ticket_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let mut statement =
        connection.prepare("SELECT tag_name FROM ticket_tags WHERE ticket_id = ?1")?;
    let tags = statement
        .query_map([ticket_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    // The same rule as the ticket list's source filter: a ticket whose ownership was
    // taken back is local.
    let source = connection
        .query_row(
            "SELECT i.provider FROM external_ownership o JOIN external_identities i ON i.ticket_id = o.ticket_id
             WHERE o.ticket_id = ?1 AND o.authority = 'external'",
            [ticket_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| LOCAL_SOURCE.to_owned());
    Ok(TicketFacts {
        project_id,
        source,
        tags,
    })
}

/// Removes finished runs created more than 90 days before `now`, with the Chats they
/// still own. A Chat the person took over is no longer owned and stays.
pub(crate) fn expire(connection: &Connection, now: &str) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS expired_runs (id TEXT PRIMARY KEY); DELETE FROM expired_runs;",
    )?;
    connection.execute(
        "INSERT INTO expired_runs SELECT id FROM automation_runs
         WHERE status NOT IN ('queued', 'running') AND julianday(created_at) < julianday(?1) - ?2",
        params![now, RETENTION_DAYS],
    )?;
    crate::chats::delete_where(
        connection,
        "automation_run_id IN (SELECT id FROM expired_runs)",
    )?;
    connection.execute_batch(
        "DELETE FROM automation_run_steps WHERE run_id IN (SELECT id FROM expired_runs);
         DELETE FROM automation_runs WHERE id IN (SELECT id FROM expired_runs);
         DELETE FROM expired_runs;",
    )?;
    Ok(())
}

impl Workspace {
    /// Reads the Workspace events after each switched-on Automation's cursor, in
    /// order, creates a Queued run for each one that matches, and moves the cursor
    /// past what it read: an event is matched once, whenever it was logged. A ticket
    /// that already has an active run of the Automation gets no second one. Returns
    /// how many runs were created.
    pub fn queue_automation_runs(&mut self) -> Result<usize, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let cursors = {
            let mut statement =
                transaction.prepare("SELECT automation_id, cursor FROM automation_device_state")?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut created = 0;
        for (automation_id, mut cursor) in cursors {
            let definition = match crate::automations::one(&transaction, &automation_id) {
                Ok(automation) => automation.definition,
                // A definition this build cannot read (made by a newer ticketd) is
                // left where it is, cursor and all, and the others still run.
                Err(Error::InvalidAutomation(_)) => continue,
                Err(error) => return Err(error),
            };
            let snapshot = serde_json::to_string(&definition)?;
            loop {
                let events = crate::events::after(&transaction, cursor, EVENT_BATCH)?;
                let Some(last) = events.last() else { break };
                cursor = last.id;
                for event in &events {
                    if !matches(&definition, event, &facts(&transaction, &event.ticket_id)?) {
                        continue;
                    }
                    // The active-run index refuses a second run for the ticket.
                    created += transaction.execute(
                        "INSERT OR IGNORE INTO automation_runs (id, automation_id, event_id, event, ticket_id, definition, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued')",
                        params![
                            Uuid::new_v4().to_string(),
                            automation_id,
                            event.id,
                            serde_json::to_string(event)?,
                            event.ticket_id,
                            snapshot
                        ],
                    )?;
                }
            }
            transaction.execute(
                "UPDATE automation_device_state SET cursor = ?2 WHERE automation_id = ?1 AND cursor <> ?2",
                params![automation_id, cursor],
            )?;
        }
        transaction.commit()?;
        Ok(created)
    }

    /// Moves Queued runs to Running, oldest triggering event first, until `limit`
    /// runs are Running. Returns the ones it started.
    pub fn start_automation_runs(&mut self, limit: usize) -> Result<Vec<AutomationRun>, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let running: usize = transaction.query_row(
            "SELECT COUNT(*) FROM automation_runs WHERE status = 'running'",
            [],
            |row| row.get(0),
        )?;
        let ids = {
            let mut statement = transaction.prepare(
                "SELECT id FROM automation_runs WHERE status = 'queued' ORDER BY event_id, rowid LIMIT ?1",
            )?;
            statement
                .query_map([limit.saturating_sub(running)], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut started = Vec::new();
        for id in ids {
            transaction.execute(
                &format!("UPDATE automation_runs SET status = 'running', started_at = {NOW} WHERE id = ?1"),
                [&id],
            )?;
            started.push(one(&transaction, &id)?);
        }
        transaction.commit()?;
        Ok(started)
    }

    /// Records how the step a Running run was on ended (`None` to begin the run) and
    /// returns what the run does next: the step is marked, and either the next step
    /// is marked Running or the run ends.
    pub fn advance_automation_run(
        &mut self,
        run_id: &str,
        outcome: Option<StepOutcome>,
    ) -> Result<RunAction, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let run = one(&transaction, run_id)?;
        if run.status != AutomationRunStatus::Running {
            return Err(Error::AutomationRun("the run is not running".into()));
        }
        let current = run
            .steps
            .iter()
            .find(|step| step.status == AutomationStepStatus::Running);
        let finished = match (current, &outcome) {
            (Some(step), Some(outcome)) => Some((step.step_id.as_str(), outcome)),
            (None, None) => None,
            (Some(_), None) => return Err(Error::AutomationRun("the run has begun".into())),
            (None, Some(_)) => return Err(Error::AutomationRun("the run is on no step".into())),
        };
        if let Some((step_id, outcome)) = finished {
            let (status, reason) = match outcome {
                StepOutcome::Completed | StepOutcome::Branched { .. } => ("completed", None),
                StepOutcome::Failed { reason } => ("failed", Some(reason)),
            };
            transaction.execute(
                &format!("UPDATE automation_run_steps SET status = ?3, reason = ?4, ended_at = {NOW} WHERE run_id = ?1 AND step_id = ?2 AND status = 'running'"),
                params![run_id, step_id, status, reason],
            )?;
        }
        let action = next_action(&run.definition.steps, finished);
        match &action {
            RunAction::RunStep { step_id } => {
                transaction.execute(
                    "INSERT INTO automation_run_steps (run_id, position, step_id, status) VALUES (?1, ?2, ?3, 'running')",
                    params![run_id, run.steps.len(), step_id],
                )?;
            }
            RunAction::End(end) => {
                let (status, reason) = match end {
                    RunEnd::Completed => (AutomationRunStatus::Completed, None),
                    RunEnd::NeedsAttention { reason } => {
                        (AutomationRunStatus::NeedsAttention, Some(reason))
                    }
                };
                transaction.execute(
                    &format!("UPDATE automation_runs SET status = ?2, reason = ?3, ended_at = {NOW} WHERE id = ?1"),
                    params![run_id, status.as_str(), reason],
                )?;
            }
        }
        transaction.commit()?;
        Ok(action)
    }

    /// Creates the Chat of the Run agent step a run is on. The Chat is owned by the
    /// run, which keeps it out of the Chat list. Repeating the call returns the
    /// first Chat.
    pub fn create_automation_run_chat(
        &mut self,
        run_id: &str,
        step_id: &str,
        chat: NewChat,
    ) -> Result<Chat, Error> {
        let chat = self.create_chat(Some(&format!("{run_id}:{step_id}:chat")), chat)?;
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        transaction.execute(
            "UPDATE chats SET automation_run_id = ?2 WHERE id = ?1",
            params![chat.id, run_id],
        )?;
        let changed = transaction.execute(
            "UPDATE automation_run_steps SET chat_id = ?3 WHERE run_id = ?1 AND step_id = ?2 AND status = 'running'",
            params![run_id, step_id, chat.id],
        )?;
        if changed == 0 {
            return Err(Error::AutomationRun("the run is not on that step".into()));
        }
        transaction.commit()?;
        Ok(chat)
    }

    /// Ends every Running run as Needs attention with `reason`, failing the step it
    /// was on. For a host that starts with runs left over from a process that is
    /// gone: nothing is behind them, and nothing retries by itself.
    pub fn end_running_automation_runs(&mut self, reason: &str) -> Result<usize, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        transaction.execute(
            &format!("UPDATE automation_run_steps SET status = 'failed', reason = ?1, ended_at = {NOW} WHERE status = 'running'"),
            [reason],
        )?;
        let ended = transaction.execute(
            &format!("UPDATE automation_runs SET status = 'needs_attention', reason = ?1, ended_at = {NOW} WHERE status = 'running'"),
            [reason],
        )?;
        transaction.commit()?;
        Ok(ended)
    }

    /// Ends a Queued or Running run as Needs attention because the person stopped
    /// it. The step it was on is marked Failed and nothing after it runs, its
    /// failure path included: the outcome its executor reports later is refused.
    pub fn stop_automation_run(&mut self, run_id: &str) -> Result<AutomationRun, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let ended = transaction.execute(
            &format!("UPDATE automation_runs SET status = 'needs_attention', reason = ?2, ended_at = {NOW} WHERE id = ?1 AND status IN ('queued', 'running')"),
            params![run_id, STOPPED],
        )?;
        if ended == 0 {
            // Says so when there is no such run.
            one(&transaction, run_id)?;
            return Err(Error::AutomationRun("the run has already ended".into()));
        }
        transaction.execute(
            &format!("UPDATE automation_run_steps SET status = 'failed', reason = ?2, ended_at = {NOW} WHERE run_id = ?1 AND status = 'running'"),
            params![run_id, STOPPED],
        )?;
        let run = one(&transaction, run_id)?;
        transaction.commit()?;
        Ok(run)
    }

    /// Queues a new run for the Workspace event that started a finished run. It
    /// begins at the first step of the Automation as it is now, so a fix made since
    /// counts; the finished run stays as it ended. Refused while the ticket has an
    /// active run of the Automation.
    pub fn run_automation_again(&mut self, run_id: &str) -> Result<AutomationRun, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let run = one(&transaction, run_id)?;
        if matches!(
            run.status,
            AutomationRunStatus::Queued | AutomationRunStatus::Running
        ) {
            return Err(Error::AutomationRun("the run has not ended yet".into()));
        }
        let definition = crate::automations::one(&transaction, &run.automation_id)?.definition;
        let id = Uuid::new_v4().to_string();
        // The active-run index refuses a second run for the ticket.
        let created = transaction.execute(
            "INSERT OR IGNORE INTO automation_runs (id, automation_id, event_id, event, ticket_id, definition, status)
             SELECT ?2, automation_id, event_id, event, ticket_id, ?3, 'queued' FROM automation_runs WHERE id = ?1",
            params![run_id, id, serde_json::to_string(&definition)?],
        )?;
        if created == 0 {
            return Err(Error::AutomationRun(
                "a run of this Automation is already going for the ticket".into(),
            ));
        }
        let again = one(&transaction, &id)?;
        transaction.commit()?;
        Ok(again)
    }

    pub fn automation_run(&self, id: &str) -> Result<AutomationRun, Error> {
        one(&self.connection, id)
    }

    /// An Automation's runs, newest first.
    // ponytail: unpaged; the 90-day retention bounds it. Page it when one Automation
    // makes thousands of runs in that time.
    pub fn automation_runs(&self, automation_id: &str) -> Result<Vec<AutomationRun>, Error> {
        read(&self.connection, "r.automation_id = ?1", automation_id)
    }
}
