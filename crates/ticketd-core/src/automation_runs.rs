//! Automation runs: one record per firing of an Automation, local to this device.
//! This module queues runs from the Workspace event log and starts them in event
//! order; `automation_advance` moves a started run along, and `automation_endings`
//! decides how it ends.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::automation_endings::{Cause, end, end_each};
use crate::automation_matching::{LOCAL_SOURCE, TicketFacts, matches};
use crate::automation_schedule::due;
use crate::automations::{AutomationDefinition, Step, Trigger};
use crate::events::WorkspaceEvent;
use crate::{Error, Workspace};

const RETENTION_DAYS: i64 = 90;
/// Events read from the log per query while matching.
const EVENT_BATCH: u32 = 500;
pub(crate) const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/// A run needs the person from when it ends as Needs attention until they run it
/// again, take it over or dismiss it. Opening it changes nothing.
pub(crate) const NEEDS_YOU: &str = "status = 'needs_attention' AND attention_cleared = 0";
/// `attention_cleared` says how the person answered: 1 for anything but running it
/// again (and for every answer stored before the two were told apart), 2 for that.
pub(crate) const DISMISSED: i64 = 1;
const RAN_AGAIN: i64 = 2;

/// How the person answered a run that needed attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunAnswer {
    Dismissed,
    RanAgain,
}

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
    pub(crate) fn as_str(self) -> &'static str {
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
    /// The run still owns that Chat, which keeps it out of the Chat list. It becomes
    /// an ordinary Chat when the person replies in it or stops it.
    pub chat_owned: bool,
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
    /// The Automation as it is called now, deleted or not.
    pub automation_name: String,
    /// The Workspace event that started it. `None` when a schedule or Run now did:
    /// nothing happened to a ticket, and the run has no ticket either.
    pub event: Option<WorkspaceEvent>,
    pub ticket: Option<AutomationRunTicket>,
    /// The Automation as it was when the run was created. The run executes this, so
    /// a later edit never changes a run.
    pub definition: AutomationDefinition,
    pub status: AutomationRunStatus,
    /// Why it needs attention.
    pub reason: Option<String>,
    /// It ended as Needs attention and the person has not yet run it again, taken
    /// it over or dismissed it.
    pub needs_you: bool,
    /// How the person answered it, once a Needs attention run no longer needs them.
    #[serde(default)]
    pub answer: Option<RunAnswer>,
    /// Its Automation has been deleted since, so it cannot be run again.
    #[serde(default)]
    pub automation_deleted: bool,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    /// The steps reached so far, in the order they ran.
    pub steps: Vec<AutomationRunStep>,
}

/// A run as a list shows it: no definition, event or steps. The run view reads the
/// whole run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AutomationRunSummary {
    pub id: String,
    pub automation_id: String,
    /// The Automation as it is called now.
    pub automation_name: String,
    pub status: AutomationRunStatus,
    /// Why it needs attention.
    pub reason: Option<String>,
    /// It needs attention and the person has not yet acted on it.
    pub needs_you: bool,
    /// How the person answered it, once it no longer needs them.
    pub answer: Option<RunAnswer>,
    /// Its Automation was deleted: it cannot be run again.
    pub automation_deleted: bool,
    pub ticket: Option<AutomationRunTicket>,
    pub created_at: String,
}

impl From<AutomationRun> for AutomationRunSummary {
    fn from(run: AutomationRun) -> Self {
        Self {
            id: run.id,
            automation_id: run.automation_id,
            automation_name: run.automation_name,
            status: run.status,
            reason: run.reason,
            needs_you: run.needs_you,
            answer: run.answer,
            automation_deleted: run.automation_deleted,
            ticket: run.ticket,
            created_at: run.created_at,
        }
    }
}

/// Whose runs a run list shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomationRunScope {
    All,
    Automation(String),
    /// The runs that acted on the ticket with this reference.
    Ticket(String),
}

/// The runs going now and the Chats their agents work in: what quitting would stop.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunningAutomationRuns {
    pub runs: usize,
    pub chat_ids: Vec<String>,
}

impl AutomationRun {
    /// The step with `id` in the definition the run executes, at any depth.
    pub fn step(&self, id: &str) -> Option<&Step> {
        crate::automations::find_step(&self.definition.steps, id)
    }
}

/// `ticket_id` is NULL, and `event` the JSON `null`, for the runs a schedule or
/// "Run now" starts. The partial index is the rule that a ticket has one active run
/// per Automation; `queue_without_ticket` keeps the same rule for those runs, which
/// the index cannot (to SQLite, one NULL differs from another).
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
    Ok(())
}

/// Adds what records that the person answered a run that needed attention.
pub(crate) fn migrate_attention(connection: &Connection) -> Result<(), Error> {
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('automation_runs') WHERE name = 'attention_cleared')",
        [],
        |row| row.get(0),
    )?;
    if !present {
        connection.execute_batch(
            "ALTER TABLE automation_runs ADD COLUMN attention_cleared INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

/// Adds an Attention inbox entry, on its ticket, for each run that needs the person
/// and has none yet. Called wherever a run ends as Needs attention.
pub(crate) fn announce(connection: &Connection) -> Result<(), Error> {
    connection.execute(
        &format!(
            "INSERT INTO inbox_entries (person, ticket_id, kind, from_value, to_value, editing_agent)
             SELECT ?1, r.ticket_id, 'automation_run', r.id, COALESCE(r.reason, ''), NULLIF(TRIM(json_extract(r.definition, '$.name')), '')
             FROM automation_runs r WHERE r.{NEEDS_YOU} AND r.ticket_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM inbox_entries i WHERE i.kind = 'automation_run' AND i.from_value = r.id)"
        ),
        [crate::inbox::LOCAL_PERSON],
    )?;
    Ok(())
}

/// The person acted on a run that needed attention: it stops asking, and its inbox
/// entry is answered.
fn answer(connection: &Connection, run_id: &str, how: i64) -> Result<(), Error> {
    connection.execute(
        "UPDATE automation_runs SET attention_cleared = ?2 WHERE id = ?1 AND status = 'needs_attention' AND attention_cleared = 0",
        params![run_id, how],
    )?;
    connection.execute(
        "UPDATE inbox_entries SET read = 1 WHERE kind = 'automation_run' AND from_value = ?1 AND read = 0",
        [run_id],
    )?;
    Ok(())
}

pub(crate) fn named<T: serde::de::DeserializeOwned>(text: String) -> Result<T, Error> {
    Ok(serde_json::from_value(serde_json::Value::String(text))?)
}

fn read(connection: &Connection, filter: &str, value: &str) -> Result<Vec<AutomationRun>, Error> {
    let mut statement = connection.prepare(&format!(
        "SELECT r.id, r.automation_id, r.event, r.definition, r.status, r.reason, r.created_at, r.started_at, r.ended_at, t.id, t.reference, t.title, r.{NEEDS_YOU}, a.name,
           CASE WHEN r.status = 'needs_attention' THEN r.attention_cleared ELSE 0 END, a.trashed
         FROM automation_runs r JOIN automations a ON a.id = r.automation_id LEFT JOIN tickets t ON t.id = r.ticket_id WHERE {filter} ORDER BY r.rowid DESC"
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
                row.get::<_, bool>(12)?,
                row.get::<_, String>(13)?,
                match row.get::<_, i64>(14)? {
                    0 => None,
                    RAN_AGAIN => Some(RunAnswer::RanAgain),
                    _ => Some(RunAnswer::Dismissed),
                },
                row.get::<_, bool>(15)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut steps = connection.prepare(
        "SELECT step_id, status, reason, chat_id, started_at, ended_at, EXISTS(SELECT 1 FROM chats WHERE chats.id = chat_id AND automation_run_id IS NOT NULL) FROM automation_run_steps WHERE run_id = ?1 ORDER BY position",
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
                needs_you,
                automation_name,
                answer,
                automation_deleted,
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
                            row.get::<_, bool>(6)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(AutomationRun {
                    steps: reached
                        .into_iter()
                        .map(
                            |(
                                step_id,
                                status,
                                reason,
                                chat_id,
                                started_at,
                                ended_at,
                                chat_owned,
                            )| {
                                Ok(AutomationRunStep {
                                    step_id,
                                    status: named(status)?,
                                    reason,
                                    chat_id,
                                    chat_owned,
                                    started_at,
                                    ended_at,
                                })
                            },
                        )
                        .collect::<Result<_, Error>>()?,
                    id,
                    automation_id,
                    automation_name,
                    event: serde_json::from_str(&event)?,
                    ticket,
                    definition: serde_json::from_str(&definition)?,
                    status: named(status)?,
                    reason,
                    needs_you,
                    answer,
                    automation_deleted,
                    created_at: created,
                    started_at: started,
                    ended_at: ended,
                })
            },
        )
        .collect()
}

pub(crate) fn one(connection: &Connection, id: &str) -> Result<AutomationRun, Error> {
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

const ACTIVE_WITHOUT_TICKET: &str = "SELECT 1 FROM automation_runs WHERE automation_id = ?2 AND ticket_id IS NULL AND status IN ('queued', 'running')";

/// Queues a run that has no ticket and no event, for a schedule or Run now, unless
/// the Automation already has one going. It takes its place in the queue after the
/// events logged so far. Returns the run's id when it was created.
fn queue_without_ticket(
    connection: &Connection,
    automation_id: &str,
    definition: &AutomationDefinition,
) -> Result<Option<String>, Error> {
    let id = Uuid::new_v4().to_string();
    let created = connection.execute(
        &format!(
            "INSERT INTO automation_runs (id, automation_id, event_id, event, definition, status)
             SELECT ?1, ?2, ?3, 'null', ?4, 'queued' WHERE NOT EXISTS ({ACTIVE_WITHOUT_TICKET})"
        ),
        params![
            id,
            automation_id,
            crate::events::head(connection)?,
            serde_json::to_string(definition)?
        ],
    )?;
    Ok((created > 0).then_some(id))
}

/// How the local time is written where a schedule counts from.
const LOCAL_TIME: &str = "%Y-%m-%dT%H:%M:%S";

/// Removes finished runs created more than 90 days before `now`, with the Chats they
/// still own. A Chat the person took over is no longer owned and stays.
pub(crate) fn expire(connection: &Connection, now: &str) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS expired_runs (id TEXT PRIMARY KEY); DELETE FROM expired_runs;",
    )?;
    connection.execute(
        "INSERT INTO expired_runs SELECT id FROM automation_runs
         WHERE status NOT IN ('queued', 'running') AND created_at < ?1",
        [crate::events::cutoff(connection, now, RETENTION_DAYS)?],
    )?;
    crate::chats::delete_where(
        connection,
        "automation_run_id IN (SELECT id FROM expired_runs)",
    )?;
    connection.execute_batch(
        "DELETE FROM inbox_entries WHERE kind = 'automation_run' AND from_value IN (SELECT id FROM expired_runs);
         DELETE FROM automation_run_steps WHERE run_id IN (SELECT id FROM expired_runs);
         DELETE FROM automation_runs WHERE id IN (SELECT id FROM expired_runs);
         DELETE FROM expired_runs;",
    )?;
    Ok(())
}

/// The ids of the Running runs that are not one of `going`.
fn running_but_not(connection: &Connection, going: &[String]) -> Result<Vec<String>, Error> {
    let going = serde_json::to_string(going)?;
    let mut statement = connection.prepare(
        "SELECT id FROM automation_runs WHERE status = 'running' AND id NOT IN (SELECT value FROM json_each(?1))",
    )?;
    Ok(statement
        .query_map([going], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

/// Whether some switched-on schedule is due at `now` or is seen for the first time, so
/// that `queue_scheduled_automation_runs` has something to write. Read only; the write
/// decides again under the lock.
fn schedules_to_update(connection: &Connection, now: chrono::NaiveDateTime) -> Result<bool, Error> {
    let on = {
        let mut statement = connection
            .prepare("SELECT automation_id, schedule_from FROM automation_device_state")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (automation_id, since) in on {
        let definition = match crate::automations::one(connection, &automation_id) {
            Ok(automation) => automation.definition,
            Err(Error::InvalidAutomation(_)) => continue,
            Err(error) => return Err(error),
        };
        let Some(Trigger::Schedule { schedule }) = &definition.trigger else {
            continue;
        };
        let since =
            since.and_then(|since| chrono::NaiveDateTime::parse_from_str(&since, LOCAL_TIME).ok());
        if since.is_none_or(|since| due(schedule, since, now)) {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Workspace {
    /// Reads the Workspace events after each switched-on Automation's cursor, in
    /// order, creates a Queued run for each one that matches, and moves the cursor
    /// past what it read: an event is matched once, whenever it was logged. A ticket
    /// that already has an active run of the Automation gets no second one. Returns
    /// how many runs were created.
    pub fn queue_automation_runs(&mut self) -> Result<usize, Error> {
        // The runner asks every few seconds: with no event past the cursor of an
        // Automation this build can read there is nothing to write, and the write lock
        // stays free for everyone else. One a newer ticketd wrote keeps its cursor (see
        // below), so its waiting events would otherwise take the lock on every pass.
        let waiting: Vec<String> = {
            let mut statement = self.connection.prepare(
                "SELECT s.automation_id FROM automation_device_state s WHERE EXISTS (SELECT 1 FROM workspace_events e WHERE e.id > s.cursor)",
            )?;
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?
        };
        let mut readable_waiting = false;
        for automation_id in &waiting {
            match crate::automations::one(&self.connection, automation_id) {
                Ok(_) => {
                    readable_waiting = true;
                    break;
                }
                Err(Error::InvalidAutomation(_)) => {}
                Err(error) => return Err(error),
            }
        }
        if !readable_waiting {
            return Ok(0);
        }
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
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

    /// Queues a run for each switched-on Automation whose schedule has come due at
    /// `now`, the computer's local time ("2026-11-16T09:00:00"; `None` reads the
    /// clock). A schedule that came due several times since it was last looked at,
    /// because ticketd was not running, starts one run. One that comes due while
    /// its last run is still going starts none. A schedule counts from when it was
    /// first seen on, so switching one on never fires it at once. Returns how many
    /// runs were created.
    pub fn queue_scheduled_automation_runs(&mut self, now: Option<&str>) -> Result<usize, Error> {
        let now = match now {
            Some(now) => chrono::NaiveDateTime::parse_from_str(now, LOCAL_TIME)
                .map_err(|error| Error::AutomationRun(format!("'{now}' is not a time: {error}")))?,
            None => chrono::Local::now().naive_local(),
        };
        // As for events: nothing due and nothing first seen takes no write lock.
        if !schedules_to_update(&self.connection, now)? {
            return Ok(0);
        }
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let on = {
            let mut statement = transaction
                .prepare("SELECT automation_id, schedule_from FROM automation_device_state")?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut created = 0;
        for (automation_id, since) in on {
            let definition = match crate::automations::one(&transaction, &automation_id) {
                Ok(automation) => automation.definition,
                // As in matching: one this build cannot read is left alone.
                Err(Error::InvalidAutomation(_)) => continue,
                Err(error) => return Err(error),
            };
            let Some(Trigger::Schedule { schedule }) = &definition.trigger else {
                continue;
            };
            let since = since
                .and_then(|since| chrono::NaiveDateTime::parse_from_str(&since, LOCAL_TIME).ok());
            // Seen on for the first time: it counts from now.
            let fires = since.is_some_and(|since| due(schedule, since, now));
            if since.is_some() && !fires {
                continue;
            }
            if fires && queue_without_ticket(&transaction, &automation_id, &definition)?.is_some() {
                created += 1;
            }
            transaction.execute(
                "UPDATE automation_device_state SET schedule_from = ?2 WHERE automation_id = ?1",
                params![automation_id, now.format(LOCAL_TIME).to_string()],
            )?;
        }
        transaction.commit()?;
        Ok(created)
    }

    /// "Run now": queues a run of an Automation that is run by hand. Refused while
    /// anything in it is unfinished, and while a run of it is already going.
    pub fn run_automation_now(&mut self, automation_id: &str) -> Result<AutomationRun, Error> {
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let automation = crate::automations::one(&transaction, automation_id)?;
        if automation.definition.trigger != Some(Trigger::ByHand) {
            return Err(Error::AutomationRun(
                "only an Automation you run by hand has Run now".into(),
            ));
        }
        if let Some(problem) = automation.problems.first() {
            return Err(Error::AutomationUnfinished(crate::automations::reason(
                &automation.definition,
                problem,
            )));
        }
        let Some(id) = queue_without_ticket(&transaction, automation_id, &automation.definition)?
        else {
            return Err(Error::AutomationRun(
                "a run of this Automation is already going".into(),
            ));
        };
        let run = one(&transaction, &id)?;
        transaction.commit()?;
        Ok(run)
    }

    /// Moves Queued runs to Running, oldest triggering event first, until `limit`
    /// runs are Running. Returns the ones it started. The runs of a deleted
    /// Automation never start.
    pub fn start_automation_runs(&mut self, limit: usize) -> Result<Vec<AutomationRun>, Error> {
        // Read first: with every slot taken or nothing queued, nothing is written.
        let running: usize = self.connection.query_row(
            "SELECT COUNT(*) FROM automation_runs WHERE status = 'running'",
            [],
            |row| row.get(0),
        )?;
        let queued: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.status = 'queued' AND a.trashed = 0)",
            [],
            |row| row.get(0),
        )?;
        if running >= limit || !queued {
            return Ok(Vec::new());
        }
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let running: usize = transaction.query_row(
            "SELECT COUNT(*) FROM automation_runs WHERE status = 'running'",
            [],
            |row| row.get(0),
        )?;
        let ids = {
            let mut statement = transaction.prepare(
                "SELECT r.id FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.status = 'queued' AND a.trashed = 0 ORDER BY r.event_id, r.rowid LIMIT ?1",
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

    /// Ends every Running run that is not one of `going` as Needs attention with
    /// `reason`, failing the step it was on. For a host whose own runs are `going`:
    /// a run left Running by a process that is gone, or brought back by a restored
    /// backup, has nothing behind it, and nothing retries by itself.
    pub fn end_running_automation_runs(
        &mut self,
        going: &[String],
        reason: &str,
    ) -> Result<usize, Error> {
        // Read first: the runner looks every few seconds, and finds nothing nearly always.
        if running_but_not(&self.connection, going)?.is_empty() {
            return Ok(0);
        }
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let ids = running_but_not(&transaction, going)?;
        let (ended, _) = end_each(&transaction, &ids, Cause::Abandoned(reason))?;
        transaction.commit()?;
        Ok(ended)
    }

    /// Ends one Running run as Needs attention with `reason`, failing the step it
    /// was on, for an executor that cannot go on with it. Returns whether it did:
    /// a run that has already ended (stopped, taken over) stays as it ended.
    pub fn fail_automation_run(&mut self, run_id: &str, reason: &str) -> Result<bool, Error> {
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let ended = match end(&transaction, run_id, Cause::Abandoned(reason)) {
            Ok(ended) => ended.is_some(),
            // Removed meanwhile: there is nothing to end.
            Err(Error::AutomationRunNotFound(_)) => false,
            Err(error) => return Err(error),
        };
        transaction.commit()?;
        Ok(ended)
    }

    /// Ends a Queued or Running run as Needs attention because the person stopped
    /// it. The step it was on is marked Failed and nothing after it runs, its
    /// failure path included: the outcome its executor reports later is refused.
    /// Also returns the Chats of the agents that were working, read in the same
    /// transaction that ends the run, for the host to interrupt. A run that has
    /// already ended (it finished as the person pressed Stop, or a restart ended it)
    /// is returned as it ended, with no Chats: that is not an error.
    pub fn stop_automation_run(
        &mut self,
        run_id: &str,
    ) -> Result<(AutomationRun, Vec<String>), Error> {
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let chats = end(&transaction, run_id, Cause::Stopped)?
            .map(|ended| ended.chats)
            .unwrap_or_default();
        let run = one(&transaction, run_id)?;
        transaction.commit()?;
        Ok((run, chats))
    }

    /// Queues a new run for the Workspace event that started a finished run. It
    /// begins at the first step of the Automation as it is now, so a fix made since
    /// counts; the finished run stays as it ended, and no longer needs the person.
    /// Refused while anything in the Automation is unfinished, and while the ticket
    /// has an active run of it.
    pub fn run_automation_again(&mut self, run_id: &str) -> Result<AutomationRun, Error> {
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let run = one(&transaction, run_id)?;
        if matches!(
            run.status,
            AutomationRunStatus::Queued | AutomationRunStatus::Running
        ) {
            return Err(Error::AutomationRun("the run has not ended yet".into()));
        }
        if run.automation_deleted {
            return Err(Error::AutomationRunAutomationDeleted);
        }
        let automation = crate::automations::one(&transaction, &run.automation_id)?;
        // As for Run now and switching on: one that is unfinished cannot run.
        if let Some(problem) = automation.problems.first() {
            return Err(Error::AutomationUnfinished(crate::automations::reason(
                &automation.definition,
                problem,
            )));
        }
        let definition = automation.definition;
        let id = if run.ticket.is_some() {
            let id = Uuid::new_v4().to_string();
            // The active-run index refuses a second run for the ticket.
            let created = transaction.execute(
                "INSERT OR IGNORE INTO automation_runs (id, automation_id, event_id, event, ticket_id, definition, status)
                 SELECT ?2, automation_id, event_id, event, ticket_id, ?3, 'queued' FROM automation_runs WHERE id = ?1",
                params![run_id, id, serde_json::to_string(&definition)?],
            )?;
            (created > 0).then_some(id)
        } else {
            queue_without_ticket(&transaction, &run.automation_id, &definition)?
        };
        let Some(id) = id else {
            return Err(Error::AutomationRun(
                "a run of this Automation is already going".into(),
            ));
        };
        answer(&transaction, run_id, RAN_AGAIN)?;
        let again = one(&transaction, &id)?;
        transaction.commit()?;
        Ok(again)
    }

    /// The person has seen that a run needs attention and wants nothing more from
    /// it. The run stays as it ended.
    pub fn dismiss_automation_run(&mut self, run_id: &str) -> Result<AutomationRun, Error> {
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        answer(&transaction, run_id, DISMISSED)?;
        let run = one(&transaction, run_id)?;
        transaction.commit()?;
        Ok(run)
    }

    /// The person replied in (`replied`) or stopped a Chat. When a run owns the
    /// Chat, it becomes an ordinary Chat in the Chat list, and a run that was going
    /// or needed attention ends as Taken over: the step it was on ends there and
    /// nothing after it runs. Stopping takes over only a run that is going, because
    /// nothing is going in the Chat of one that ended. Returns the run, or `None`
    /// when there was nothing to take over.
    pub fn take_over_automation_run(
        &mut self,
        chat_id: &str,
        replied: bool,
    ) -> Result<Option<AutomationRun>, Error> {
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let owner: Option<String> = transaction
            .query_row(
                "SELECT automation_run_id FROM chats WHERE id = ?1",
                [chat_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(run_id) = owner else {
            return Ok(None);
        };
        let status = one(&transaction, &run_id)?.status;
        if !replied && status != AutomationRunStatus::Running {
            return Ok(None);
        }
        transaction.execute(
            "UPDATE chats SET automation_run_id = NULL WHERE id = ?1",
            [chat_id],
        )?;
        // The Chat list follows the Chat log. A view of the run follows the change
        // token, which Chat tables leave alone, and for a Completed run nothing
        // else here moves it (#387 3B2).
        crate::chats::log(&transaction, chat_id, "chat", chat_id)?;
        transaction.execute(
            "UPDATE workspace_changes SET token = token + 1 WHERE id = 1",
            [],
        )?;
        end(&transaction, &run_id, Cause::TakenOver)?;
        let run = one(&transaction, &run_id)?;
        transaction.commit()?;
        Ok(Some(run))
    }

    /// The run the person took over by replying in or stopping this Chat, which
    /// was one of its steps'. `None` for any other Chat.
    pub fn automation_run_taken_over_in(
        &self,
        chat_id: &str,
    ) -> Result<Option<AutomationRun>, Error> {
        let run: Option<String> = self
            .connection
            .query_row(
                "SELECT run_id FROM automation_run_steps JOIN automation_runs ON automation_runs.id = run_id WHERE chat_id = ?1 AND automation_runs.status = 'taken_over' LIMIT 1",
                [chat_id],
                |row| row.get(0),
            )
            .optional()?;
        run.map(|id| one(&self.connection, &id)).transpose()
    }

    /// Whether an agent step of a run ever ran in this Chat, so its harness session
    /// began unattended. True also once the person took the Chat over, from a run
    /// that had ended or not.
    pub fn chat_ran_an_automation_agent(&self, chat_id: &str) -> Result<bool, Error> {
        Ok(self.connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM automation_run_steps WHERE chat_id = ?1)",
            [chat_id],
            |row| row.get(0),
        )?)
    }

    pub fn automation_run(&self, id: &str) -> Result<AutomationRun, Error> {
        self.read(|_| one(&self.connection, id))
    }

    /// An Automation's runs, newest first.
    // ponytail: unpaged; the 90-day retention bounds it. Page it when one Automation
    // makes thousands of runs in that time.
    pub fn automation_runs(&self, automation_id: &str) -> Result<Vec<AutomationRun>, Error> {
        self.read(|_| read(&self.connection, "r.automation_id = ?1", automation_id))
    }

    /// The runs of every Automation, newest first.
    // ponytail: unpaged like the list above; the same retention bounds it.
    pub fn all_automation_runs(&self) -> Result<Vec<AutomationRun>, Error> {
        self.read(|_| {
            // `read` filters on one value; this filter passes every run.
            read(&self.connection, "?1 = ''", "")
        })
    }

    /// A page of the runs in `scope`, newest first, as a run list shows them: one query,
    /// with no definition or steps read.
    pub fn automation_run_summaries(
        &self,
        scope: &AutomationRunScope,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<AutomationRunSummary>, Error> {
        let (filter, value) = match scope {
            AutomationRunScope::All => ("?1 = ''", ""),
            AutomationRunScope::Automation(id) => ("r.automation_id = ?1", id.as_str()),
            AutomationRunScope::Ticket(reference) => (
                "r.ticket_id = (SELECT id FROM tickets WHERE reference = ?1)",
                reference.as_str(),
            ),
        };
        let mut statement = self.connection.prepare_cached(&format!(
            "SELECT r.id, r.automation_id, a.name, r.status, r.reason, r.{NEEDS_YOU},
               CASE WHEN r.status = 'needs_attention' THEN r.attention_cleared ELSE 0 END, a.trashed,
               t.id, t.reference, t.title, r.created_at
             FROM automation_runs r JOIN automations a ON a.id = r.automation_id LEFT JOIN tickets t ON t.id = r.ticket_id
             WHERE {filter} ORDER BY r.rowid DESC LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = statement
            .query_map(params![value, limit, offset], |row| {
                let ticket = match row.get::<_, Option<String>>(8)? {
                    Some(id) => Some(AutomationRunTicket {
                        id,
                        reference: row.get(9)?,
                        title: row.get(10)?,
                    }),
                    None => None,
                };
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, bool>(7)?,
                    ticket,
                    row.get::<_, String>(11)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(
                    id,
                    automation_id,
                    automation_name,
                    status,
                    reason,
                    needs_you,
                    answer,
                    automation_deleted,
                    ticket,
                    created_at,
                )| {
                    Ok(AutomationRunSummary {
                        id,
                        automation_id,
                        automation_name,
                        status: named(status)?,
                        reason,
                        needs_you,
                        answer: match answer {
                            0 => None,
                            RAN_AGAIN => Some(RunAnswer::RanAgain),
                            _ => Some(RunAnswer::Dismissed),
                        },
                        automation_deleted,
                        ticket,
                        created_at,
                    })
                },
            )
            .collect()
    }

    /// The runs going now and the Chats their agent steps work in.
    pub fn running_automation_runs(&self) -> Result<RunningAutomationRuns, Error> {
        let mut statement = self.connection.prepare_cached(
            "SELECT r.id, s.chat_id FROM automation_runs r
               LEFT JOIN automation_run_steps s ON s.run_id = r.id AND s.chat_id IS NOT NULL
              WHERE r.status = 'running' ORDER BY r.rowid DESC, s.position",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut runs = std::collections::HashSet::new();
        let mut chat_ids = Vec::new();
        for (run, chat) in rows {
            runs.insert(run);
            chat_ids.extend(chat);
        }
        Ok(RunningAutomationRuns {
            runs: runs.len(),
            chat_ids,
        })
    }

    /// The runs that acted on a ticket, newest first.
    pub fn ticket_automation_runs(&self, reference: &str) -> Result<Vec<AutomationRun>, Error> {
        self.read(|_| {
            read(
                &self.connection,
                "r.ticket_id = (SELECT id FROM tickets WHERE reference = ?1)",
                reference,
            )
        })
    }
}
