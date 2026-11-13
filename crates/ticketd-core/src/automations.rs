//! Automations: a trigger, conditions and a tree of steps, stored as one record.
//! Whether an Automation is on, and where it has read the Workspace event log to,
//! belong to this device and live beside the record, not in it.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Status, Workspace};

/// The version of the stored definition's shape. A later shape bumps it and
/// converts older records when it reads them.
const SCHEMA_VERSION: u32 = 1;

/// The `step_id` of a problem with the trigger, which is a card but not a step.
pub const AUTOMATION_TRIGGER_ID: &str = "trigger";

/// Everything a person sets on an Automation. It is the synchronized part.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationDefinition {
    pub name: String,
    /// `None` until the person chooses what starts it.
    pub trigger: Option<Trigger>,
    /// Narrow the trigger; every one must match.
    #[serde(default)]
    pub conditions: Vec<Condition>,
    /// The steps in the order they run.
    #[serde(default)]
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    TicketCreated,
    TicketUpdated,
    /// `to` is required to switch on; `from` narrows it when set.
    StatusChanged {
        to: Option<Status>,
        from: Option<Status>,
    },
    TagAdded {
        tag: String,
    },
    TagRemoved {
        tag: String,
    },
    /// An authored update is posted on a ticket.
    ActivityCreated,
    Schedule {
        schedule: Schedule,
    },
    ByHand,
}

impl Trigger {
    /// Schedule and by-hand Automations run without a ticket.
    fn has_ticket(&self) -> bool {
        !matches!(self, Self::Schedule { .. } | Self::ByHand)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    EveryHours {
        hours: u32,
    },
    /// `time` is a local time of day, "HH:MM".
    Weekly {
        time: String,
        weekdays: Vec<Weekday>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Condition {
    /// The ticket's project is one of these project ids.
    Project { any_of: Vec<String> },
    /// The ticket's source is one of these.
    Source { any_of: Vec<String> },
    /// The ticket has, or does not have, this tag.
    Tag { tag: String, has: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    /// Stable for the life of the step, so a run can say which step it is on.
    pub id: String,
    #[serde(flatten)]
    pub action: StepAction,
}

/// What a step does. The three that can fail may carry a failure path, which runs
/// to its end in place of the rest of the flow; an If has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepAction {
    RunAgent {
        /// An Automation agent's id.
        agent_id: Option<String>,
        execution_folder: Option<String>,
        #[serde(default)]
        on_failure: Option<Vec<Step>>,
    },
    ChangeTicket {
        change: Option<StepChange>,
        #[serde(default)]
        on_failure: Option<Vec<Step>>,
    },
    /// `text` may hold field references such as `{{ticket.title}}`, kept as
    /// written and resolved when the step runs.
    Notify {
        text: String,
        opens: NotifyTarget,
        #[serde(default)]
        on_failure: Option<Vec<Step>>,
    },
    /// Every check must pass, against the ticket as it is when the step runs.
    If {
        checks: Vec<Check>,
        yes: Vec<Step>,
        no: Vec<Step>,
    },
}

impl StepAction {
    fn label(&self) -> &'static str {
        match self {
            Self::RunAgent { .. } => "Run agent",
            Self::ChangeTicket { .. } => "Change ticket",
            Self::Notify { .. } => "Notify me",
            Self::If { .. } => "If",
        }
    }

    /// The lists of steps under this one, in the order they run.
    pub(crate) fn paths(&self) -> Vec<&Vec<Step>> {
        match self {
            Self::RunAgent { on_failure, .. }
            | Self::ChangeTicket { on_failure, .. }
            | Self::Notify { on_failure, .. } => on_failure.iter().collect(),
            Self::If { yes, no, .. } => vec![yes, no],
        }
    }

    fn paths_mut(&mut self) -> Vec<&mut Vec<Step>> {
        match self {
            Self::RunAgent { on_failure, .. }
            | Self::ChangeTicket { on_failure, .. }
            | Self::Notify { on_failure, .. } => on_failure.iter_mut().collect(),
            Self::If { yes, no, .. } => vec![yes, no],
        }
    }
}

/// What a Change ticket step does to the ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum StepChange {
    AddTag { tag: String },
    RemoveTag { tag: String },
    SetStatus { status: Status },
    PostUpdate { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyTarget {
    Ticket,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Check {
    Tag {
        tag: String,
        has: bool,
    },
    Status {
        status: Status,
        is: bool,
    },
    /// `None` is "No project".
    Project {
        project_id: Option<String>,
        is: bool,
    },
}

/// Why an Automation cannot be switched on yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationProblem {
    /// The step that is unfinished, `AUTOMATION_TRIGGER_ID` for the trigger, or
    /// `None` when the Automation as a whole is (it has no steps).
    pub step_id: Option<String>,
    /// What it needs, as shown on its card.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    #[serde(flatten)]
    pub definition: AutomationDefinition,
    /// Whether it is on for this device.
    pub enabled: bool,
    /// Empty when it can be switched on. In the order the steps run.
    pub problems: Vec<AutomationProblem>,
}

/// The definition as stored, apart from the name, which has its own column.
#[derive(Serialize, Deserialize)]
struct Stored {
    schema_version: u32,
    trigger: Option<Trigger>,
    conditions: Vec<Condition>,
    steps: Vec<Step>,
}

/// `trashed` is the delete, as for agents: a record that will synchronize is hidden
/// rather than removed. `automation_device_state` is this device's part and will
/// not synchronize: a row means the Automation is on here, reading the Workspace
/// event log after `cursor`.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, trashed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
         CREATE TABLE IF NOT EXISTS automation_device_state (automation_id TEXT PRIMARY KEY REFERENCES automations(id), cursor INTEGER NOT NULL);",
    )?;
    // Views refresh on the change token, so a change made elsewhere shows up.
    crate::change_token::track(connection, "automations")?;
    crate::change_token::track(connection, "automation_device_state")?;
    connection.execute_batch("PRAGMA user_version = 69;")?;
    Ok(())
}

fn blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// What stops this definition from being switched on. `agents` holds the ids of
/// the Automation agents that exist.
fn problems(definition: &AutomationDefinition, agents: &HashSet<String>) -> Vec<AutomationProblem> {
    let mut found = Vec::new();
    let trigger_needs = match &definition.trigger {
        None => Some("Choose what starts it"),
        Some(Trigger::TagAdded { tag } | Trigger::TagRemoved { tag }) if blank(tag) => {
            Some("Needs a tag")
        }
        Some(Trigger::StatusChanged { to: None, .. }) => Some("Needs a status"),
        Some(Trigger::Schedule { schedule }) => match schedule {
            Schedule::EveryHours { hours: 0 } => Some("Needs a number of hours"),
            Schedule::Weekly { time, weekdays } if blank(time) || weekdays.is_empty() => {
                Some("Needs a time and a weekday")
            }
            Schedule::EveryHours { .. } | Schedule::Weekly { .. } => None,
        },
        Some(_) => None,
    };
    if let Some(message) = trigger_needs {
        found.push(AutomationProblem {
            step_id: Some(AUTOMATION_TRIGGER_ID.to_owned()),
            message: message.to_owned(),
        });
    }
    if definition.steps.is_empty() {
        found.push(AutomationProblem {
            step_id: None,
            message: "Add a step".to_owned(),
        });
    }
    let has_ticket = definition.trigger.as_ref().is_none_or(Trigger::has_ticket);
    step_problems(&definition.steps, has_ticket, agents, &mut found);
    found
}

fn step_problems(
    steps: &[Step],
    has_ticket: bool,
    agents: &HashSet<String>,
    found: &mut Vec<AutomationProblem>,
) {
    for step in steps {
        if let Some(message) = step_needs(&step.action, has_ticket, agents) {
            found.push(AutomationProblem {
                step_id: Some(step.id.clone()),
                message: message.to_owned(),
            });
        }
        for path in step.action.paths() {
            step_problems(path, has_ticket, agents, found);
        }
    }
}

fn step_needs(
    action: &StepAction,
    has_ticket: bool,
    agents: &HashSet<String>,
) -> Option<&'static str> {
    let tag_needed = |tag: &str| blank(tag).then_some("Needs a tag");
    match action {
        StepAction::RunAgent {
            agent_id,
            execution_folder,
            ..
        } => {
            let agent = agent_id.as_ref().is_some_and(|id| agents.contains(id));
            let folder = execution_folder.as_ref().is_some_and(|path| !blank(path));
            match (agent, folder) {
                (false, false) => Some("Needs an agent and a folder"),
                (false, true) => Some("Needs an agent"),
                (true, false) => Some("Needs a folder"),
                (true, true) => None,
            }
        }
        StepAction::ChangeTicket { .. } | StepAction::If { .. } if !has_ticket => {
            Some("Needs a ticket, and this Automation does not start from one")
        }
        StepAction::ChangeTicket { change, .. } => match change {
            None => Some("Needs a change"),
            Some(StepChange::AddTag { tag } | StepChange::RemoveTag { tag }) => tag_needed(tag),
            Some(StepChange::PostUpdate { text }) => blank(text).then_some("Needs text"),
            Some(StepChange::SetStatus { .. }) => None,
        },
        StepAction::Notify { text, .. } => blank(text).then_some("Needs a message"),
        StepAction::If { checks, .. } => {
            if checks.is_empty() {
                return Some("Needs a check");
            }
            checks.iter().find_map(|check| match check {
                Check::Tag { tag, .. } => tag_needed(tag),
                Check::Status { .. } | Check::Project { .. } => None,
            })
        }
    }
}

fn find_step<'a>(steps: &'a [Step], id: &str) -> Option<&'a Step> {
    steps.iter().find_map(|step| {
        if step.id == id {
            return Some(step);
        }
        step.action
            .paths()
            .into_iter()
            .find_map(|path| find_step(path, id))
    })
}

/// The first problem as a sentence that names its step.
fn reason(definition: &AutomationDefinition, problem: &AutomationProblem) -> String {
    let label = match problem.step_id.as_deref() {
        None => return problem.message.clone(),
        Some(AUTOMATION_TRIGGER_ID) => "Trigger",
        Some(id) => find_step(&definition.steps, id).map_or("Step", |step| step.action.label()),
    };
    let mut message = problem.message.chars();
    let first = message.next().map(|c| c.to_lowercase().to_string());
    format!("{label}: {}{}", first.unwrap_or_default(), message.as_str())
}

fn uses_agent(steps: &[Step], agent: &str) -> bool {
    steps.iter().any(|step| {
        matches!(&step.action, StepAction::RunAgent { agent_id: Some(id), .. } if id == agent)
            || step
                .action
                .paths()
                .into_iter()
                .any(|path| uses_agent(path, agent))
    })
}

fn tidy_steps(steps: &mut [Step], seen: &mut HashSet<String>) -> Result<(), Error> {
    let tidy_tag = |tag: &mut String| *tag = tag.trim().to_lowercase();
    for step in steps {
        if step.id.trim().is_empty() {
            step.id = Uuid::new_v4().to_string();
        }
        if !seen.insert(step.id.clone()) || step.id == AUTOMATION_TRIGGER_ID {
            return Err(Error::InvalidAutomation(format!(
                "two steps share the id '{}'",
                step.id
            )));
        }
        match &mut step.action {
            StepAction::ChangeTicket {
                change: Some(StepChange::AddTag { tag } | StepChange::RemoveTag { tag }),
                ..
            } => tidy_tag(tag),
            StepAction::If { checks, .. } => {
                for check in checks {
                    if let Check::Tag { tag, .. } = check {
                        tidy_tag(tag);
                    }
                }
            }
            StepAction::RunAgent { .. }
            | StepAction::ChangeTicket { .. }
            | StepAction::Notify { .. } => {}
        }
        for path in step.action.paths_mut() {
            tidy_steps(path, seen)?;
        }
    }
    Ok(())
}

/// The definition as it is stored: the name trimmed, tags named the way tickets
/// store them, and every step with an id of its own.
fn tidied(mut definition: AutomationDefinition) -> Result<AutomationDefinition, Error> {
    definition.name = definition.name.trim().to_owned();
    if let Some(Trigger::TagAdded { tag } | Trigger::TagRemoved { tag }) = &mut definition.trigger {
        *tag = tag.trim().to_lowercase();
    }
    for condition in &mut definition.conditions {
        if let Condition::Tag { tag, .. } = condition {
            *tag = tag.trim().to_lowercase();
        }
    }
    tidy_steps(&mut definition.steps, &mut HashSet::new())?;
    Ok(definition)
}

fn encode(definition: &AutomationDefinition) -> Result<String, Error> {
    serde_json::to_string(&Stored {
        schema_version: SCHEMA_VERSION,
        trigger: definition.trigger.clone(),
        conditions: definition.conditions.clone(),
        steps: definition.steps.clone(),
    })
    .map_err(|error| Error::InvalidAutomation(error.to_string()))
}

fn decode(name: String, stored: &str) -> Result<AutomationDefinition, Error> {
    let stored: Stored = serde_json::from_str(stored)
        .map_err(|error| Error::InvalidAutomation(error.to_string()))?;
    if stored.schema_version > SCHEMA_VERSION {
        return Err(Error::InvalidAutomation(format!(
            "'{name}' was made by a newer ticketd"
        )));
    }
    Ok(AutomationDefinition {
        name,
        trigger: stored.trigger,
        conditions: stored.conditions,
        steps: stored.steps,
    })
}

fn agent_ids(connection: &Connection) -> Result<HashSet<String>, Error> {
    let mut statement = connection.prepare("SELECT id FROM automation_agents WHERE trashed = 0")?;
    Ok(statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

/// The Automations that are not deleted, newest first, or only the one with `id`.
fn load(connection: &Connection, id: Option<&str>) -> Result<Vec<Automation>, Error> {
    let agents = agent_ids(connection)?;
    let mut statement = connection.prepare(
        "SELECT a.id, a.name, a.definition, d.automation_id IS NOT NULL FROM automations a LEFT JOIN automation_device_state d ON d.automation_id = a.id WHERE a.trashed = 0 AND (?1 IS NULL OR a.id = ?1) ORDER BY a.rowid DESC",
    )?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, name, stored, enabled)| {
            let definition = decode(name, &stored)?;
            Ok(Automation {
                id,
                problems: problems(&definition, &agents),
                definition,
                enabled,
            })
        })
        .collect()
}

pub(crate) fn one(connection: &Connection, id: &str) -> Result<Automation, Error> {
    load(connection, Some(id))?
        .pop()
        .ok_or_else(|| Error::AutomationNotFound(id.to_owned()))
}

/// The names of the Automations with a step that runs this agent, newest first.
pub(crate) fn using_agent(connection: &Connection, agent: &str) -> Result<Vec<String>, Error> {
    Ok(load(connection, None)?
        .into_iter()
        .filter(|automation| uses_agent(&automation.definition.steps, agent))
        .map(|automation| automation.definition.name)
        .collect())
}

impl Workspace {
    /// A new Automation is off on every device until it is switched on there.
    pub fn create_automation(
        &mut self,
        definition: AutomationDefinition,
    ) -> Result<Automation, Error> {
        let definition = tidied(definition)?;
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO automations (id, name, definition) VALUES (?1, ?2, ?3)",
            params![id, definition.name, encode(&definition)?],
        )?;
        one(&self.connection, &id)
    }

    /// Replaces the whole definition. An edit that leaves something unfinished
    /// switches the Automation off here, so one that is on can always run.
    pub fn update_automation(
        &mut self,
        id: &str,
        definition: AutomationDefinition,
    ) -> Result<Automation, Error> {
        let definition = tidied(definition)?;
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let changed = transaction.execute(
            "UPDATE automations SET name = ?2, definition = ?3 WHERE id = ?1 AND trashed = 0",
            params![id, definition.name, encode(&definition)?],
        )?;
        if changed == 0 {
            return Err(Error::AutomationNotFound(id.to_owned()));
        }
        let mut automation = one(&transaction, id)?;
        if automation.enabled && !automation.problems.is_empty() {
            transaction.execute(
                "DELETE FROM automation_device_state WHERE automation_id = ?1",
                [id],
            )?;
            automation.enabled = false;
        }
        transaction.commit()?;
        Ok(automation)
    }

    /// A deleted Automation is also off.
    pub fn delete_automation(&mut self, id: &str) -> Result<(), Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let changed = transaction.execute(
            "UPDATE automations SET trashed = 1 WHERE id = ?1 AND trashed = 0",
            [id],
        )?;
        if changed == 0 {
            return Err(Error::AutomationNotFound(id.to_owned()));
        }
        transaction.execute(
            "DELETE FROM automation_device_state WHERE automation_id = ?1",
            [id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn automation(&self, id: &str) -> Result<Automation, Error> {
        one(&self.connection, id)
    }

    /// The Automations that are not deleted, newest first.
    pub fn automations(&self) -> Result<Vec<Automation>, Error> {
        load(&self.connection, None)
    }

    /// Switches an Automation on or off for this device. Switching on is refused
    /// while anything is unfinished, and starts from the Workspace events logged so
    /// far: what happened while it was off never starts a run.
    pub fn set_automation_enabled(&mut self, id: &str, enabled: bool) -> Result<Automation, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        let mut automation = one(&transaction, id)?;
        if enabled {
            if let Some(problem) = automation.problems.first() {
                return Err(Error::AutomationUnfinished(reason(
                    &automation.definition,
                    problem,
                )));
            }
            // Already on keeps its place in the log.
            transaction.execute(
                "INSERT OR IGNORE INTO automation_device_state (automation_id, cursor) VALUES (?1, ?2)",
                params![id, crate::events::head(&transaction)?],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM automation_device_state WHERE automation_id = ?1",
                [id],
            )?;
        }
        transaction.commit()?;
        automation.enabled = enabled;
        Ok(automation)
    }

    /// The id of the last Workspace event this Automation has read on this device,
    /// or `None` while it is off here.
    pub fn automation_cursor(&self, id: &str) -> Result<Option<i64>, Error> {
        Ok(self
            .connection
            .query_row(
                "SELECT cursor FROM automation_device_state WHERE automation_id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// The names of the Automations with a step that runs this agent, newest first.
    pub fn automations_using_agent(&self, agent_id: &str) -> Result<Vec<String>, Error> {
        using_agent(&self.connection, agent_id)
    }
}
