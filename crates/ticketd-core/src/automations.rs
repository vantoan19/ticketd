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

/// The longest name an Automation may have, in characters. The Rename dialog
/// (`AutomationEditor.tsx`) stops at the same length.
pub const AUTOMATION_NAME_LIMIT: usize = 120;
/// The most hours an "Every N hours" schedule may wait, a week; longer schedules
/// use weekdays. The trigger panel (`TriggerPanel.tsx`) offers the same range.
pub const MOST_SCHEDULE_HOURS: u32 = 168;

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
    pub fn has_ticket(&self) -> bool {
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
    /// `None` until a status is chosen.
    Status {
        #[serde(default)]
        status: Option<Status>,
        is: bool,
    },
    /// Absent until a project is chosen; `Some(None)` is "No project".
    Project {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::deserialize_project_patch"
        )]
        project_id: Option<Option<String>>,
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
    /// It came from another device through Workspace sync and has not been
    /// switched on here since.
    pub arrived_off: bool,
    /// Empty when it can be switched on. In the order the steps run.
    pub problems: Vec<AutomationProblem>,
    /// Whether its runs act on a ticket. One started by a schedule or by hand has
    /// none: its conditions are kept but not asked, and it takes no ticket step.
    pub has_ticket: bool,
}

impl Automation {
    /// Whether it may be on: nothing is unfinished, and something other than the
    /// person starts it.
    fn can_be_on(&self) -> bool {
        self.problems.is_empty() && self.definition.trigger != Some(Trigger::ByHand)
    }
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
    Ok(())
}

/// Format version 76: Automations and agents synchronize. A row of
/// `automation_arrivals` marks an Automation that Workspace sync brought to this
/// device and that has not been switched on here since. Like on/off, it belongs
/// to the device and does not synchronize.
pub(crate) fn migrate_sync(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS automation_arrivals (automation_id TEXT PRIMARY KEY REFERENCES automations(id));",
    )?;
    crate::change_token::track(connection, "automation_arrivals")?;
    // Automations and agents join the tables whose changes are captured.
    crate::sync::migrate_capture(connection)?;
    Ok(())
}

/// Format version 80: where a schedule counts from on this device. `schedule_from`
/// is the local time a schedule that is on last fired, or was first looked at; it
/// is NULL until then, and again after the trigger changes.
pub(crate) fn migrate_schedule(connection: &Connection) -> Result<(), Error> {
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('automation_device_state') WHERE name = 'schedule_from')",
        [],
        |row| row.get(0),
    )?;
    if !present {
        connection
            .execute_batch("ALTER TABLE automation_device_state ADD COLUMN schedule_from TEXT;")?;
    }
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
            Schedule::Weekly { time, weekdays }
                if crate::automation_schedule::time_of_day(time).is_none()
                    || weekdays.is_empty() =>
            {
                Some("Needs a time and a weekday")
            }
            Schedule::EveryHours { .. } | Schedule::Weekly { .. } => None,
        },
        Some(_) => None,
    };
    // Conditions are part of the trigger's card, so the first one without a value is
    // what the trigger needs once it is itself set up.
    let condition_needs = |condition: &Condition| match condition {
        Condition::Project { any_of } if any_of.is_empty() => Some("A condition needs a project"),
        Condition::Source { any_of } if any_of.is_empty() => Some("A condition needs a source"),
        Condition::Tag { tag, .. } if blank(tag) => Some("A condition needs a tag"),
        Condition::Project { .. } | Condition::Source { .. } | Condition::Tag { .. } => None,
    };
    let has_ticket = definition.trigger.as_ref().is_none_or(Trigger::has_ticket);
    // Conditions are about a ticket. An Automation that starts without one keeps
    // them, for when its trigger changes back, and is not held up by them.
    let trigger_needs = trigger_needs.or_else(|| {
        has_ticket
            .then(|| definition.conditions.iter().find_map(condition_needs))
            .flatten()
    });
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
                Check::Status { status: None, .. } => Some("Needs a status"),
                Check::Project {
                    project_id: None, ..
                } => Some("Needs a project"),
                Check::Status { .. } | Check::Project { .. } => None,
            })
        }
    }
}

pub(crate) fn find_step<'a>(steps: &'a [Step], id: &str) -> Option<&'a Step> {
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
pub(crate) fn reason(definition: &AutomationDefinition, problem: &AutomationProblem) -> String {
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
    if definition.name.chars().count() > AUTOMATION_NAME_LIMIT {
        return Err(Error::InvalidAutomation(format!(
            "a name can be at most {AUTOMATION_NAME_LIMIT} characters"
        )));
    }
    if let Some(Trigger::Schedule {
        schedule: Schedule::EveryHours { hours },
    }) = &definition.trigger
        && *hours > MOST_SCHEDULE_HOURS
    {
        return Err(Error::InvalidAutomation(format!(
            "a schedule can repeat at most every {MOST_SCHEDULE_HOURS} hours (a week)"
        )));
    }
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
        "SELECT a.id, a.name, a.definition, d.automation_id IS NOT NULL, EXISTS(SELECT 1 FROM automation_arrivals WHERE automation_id = a.id) FROM automations a LEFT JOIN automation_device_state d ON d.automation_id = a.id WHERE a.trashed = 0 AND (?1 IS NULL OR a.id = ?1) ORDER BY a.rowid DESC",
    )?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, name, stored, enabled, arrived)| {
            let definition = decode(name, &stored)?;
            Ok(Automation {
                id,
                problems: problems(&definition, &agents),
                has_ticket: definition.trigger.as_ref().is_none_or(Trigger::has_ticket),
                enabled,
                // A by-hand Automation is never on, here or anywhere.
                arrived_off: arrived && !enabled && definition.trigger != Some(Trigger::ByHand),
                definition,
            })
        })
        .collect()
}

const FENCE: &str = "```";

/// A stored definition as the text of its sync file: indented JSON in a fenced
/// block, so the file reads as Markdown and the steps can be followed by eye.
pub(crate) fn file_body(stored: &str) -> Result<String, Error> {
    let invalid = |error: serde_json::Error| Error::InvalidAutomation(error.to_string());
    let stored: Stored = serde_json::from_str(stored).map_err(invalid)?;
    let json = serde_json::to_string_pretty(&stored).map_err(invalid)?;
    Ok(format!("{FENCE}json\n{json}\n{FENCE}"))
}

/// The definition to store from the text of a sync file. The text must hold a
/// definition as ticketd stores one: an id made up on arrival for a step
/// without one would differ on every device.
pub(crate) fn from_file_body(body: &str) -> Result<String, Error> {
    let bad = |reason: String| Error::SyncFile(format!("the steps of an automation: {reason}"));
    let json = body
        .trim()
        .strip_prefix("```json")
        .and_then(|rest| rest.strip_suffix(FENCE))
        .ok_or_else(|| bad("they must be one ```json block".into()))?;
    let stored: Stored = serde_json::from_str(json).map_err(|error| bad(error.to_string()))?;
    if stored.schema_version > SCHEMA_VERSION {
        return Err(bad(
            "a newer ticketd wrote them; update ticketd on this desktop to read them".into(),
        ));
    }
    let definition = AutomationDefinition {
        name: String::new(),
        trigger: stored.trigger,
        conditions: stored.conditions,
        steps: stored.steps,
    };
    let tidy = tidied(definition.clone()).map_err(|error| bad(error.to_string()))?;
    if tidy != definition {
        return Err(bad(
            "every step needs an id, and tags are written in lowercase without spaces around them"
                .into(),
        ));
    }
    encode(&definition)
}

/// Before Workspace sync replaces an Automation's definition with `stored`: a
/// schedule counts again from a change to what starts the Automation, as it does
/// after such an edit on this device, so an old count never fires the new
/// schedule at once. A definition that cannot be read counts as changed.
pub(crate) fn restart_schedule_if_trigger_changes(
    connection: &Connection,
    id: &str,
    stored: &str,
) -> Result<(), Error> {
    let trigger = |stored: &str| {
        serde_json::from_str::<Stored>(stored)
            .ok()
            .map(|stored| stored.trigger)
    };
    let before: Option<String> = connection
        .query_row(
            "SELECT definition FROM automations WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let kept = match (before.as_deref().and_then(trigger), trigger(stored)) {
        (Some(before), Some(after)) => before == after,
        (None, _) | (_, None) => false,
    };
    if !kept {
        connection.execute(
            "UPDATE automation_device_state SET schedule_from = NULL WHERE automation_id = ?1",
            [id],
        )?;
    }
    Ok(())
}

/// A record that Workspace sync brought to this device for the first time, before
/// its fields are written: it is off here until the person switches it on.
pub(crate) fn create_arrived(connection: &Connection, id: &str) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO automations (id, name, definition) VALUES (?1, '', ?2)",
        params![id, encode(&AutomationDefinition::default())?],
    )?;
    connection.execute(
        "INSERT INTO automation_arrivals (automation_id) VALUES (?1)",
        [id],
    )?;
    Ok(())
}

/// After Workspace sync changed an Automation or an agent: an Automation that is
/// on here and was deleted, or can no longer run as it now is, goes off here, as
/// it does after such an edit on this device.
pub(crate) fn switch_off_unfinished(connection: &Connection) -> Result<(), Error> {
    connection.execute(
        "DELETE FROM automation_device_state WHERE automation_id IN (SELECT id FROM automations WHERE trashed = 1)",
        [],
    )?;
    for automation in load(connection, None)? {
        if automation.enabled && !automation.can_be_on() {
            connection.execute(
                "DELETE FROM automation_device_state WHERE automation_id = ?1",
                [&automation.id],
            )?;
        }
    }
    Ok(())
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

/// The name for a copy of `name`: its own " copy" or " copy N" ending dropped, then
/// the first of " copy", " copy 2", … that no Automation in `taken` has, shortened
/// to fit the name limit.
fn copy_name(name: &str, taken: &HashSet<String>) -> String {
    let base = match name.rsplit_once(" copy") {
        Some((base, "")) => base,
        Some((base, number))
            if number
                .strip_prefix(' ')
                .is_some_and(|n| n.parse::<u32>().is_ok()) =>
        {
            base
        }
        _ => name,
    };
    let mut n = 1;
    loop {
        let ending = if n == 1 {
            " copy".to_owned()
        } else {
            format!(" copy {n}")
        };
        let room = AUTOMATION_NAME_LIMIT.saturating_sub(ending.chars().count());
        let candidate = format!(
            "{}{ending}",
            base.chars().take(room).collect::<String>().trim_end()
        );
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
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

    /// A new Automation with the same trigger, conditions and steps, named as a
    /// copy: "Triage copy", then "Triage copy 2", also when a copy is copied. Like
    /// any new Automation it is off, whatever the original is.
    pub fn duplicate_automation(&mut self, id: &str) -> Result<Automation, Error> {
        let mut definition = one(&self.connection, id)?.definition;
        if !definition.name.is_empty() {
            let taken: HashSet<String> = load(&self.connection, None)?
                .into_iter()
                .map(|automation| automation.definition.name)
                .collect();
            definition.name = copy_name(&definition.name, &taken);
        }
        // Step ids only have to be unique within one Automation, so the copy keeps them.
        self.create_automation(definition)
    }

    /// Replaces the whole definition. An edit that leaves something unfinished, or
    /// makes the Automation one that is run by hand, switches it off here, so one
    /// that is on can always run.
    pub fn update_automation(
        &mut self,
        id: &str,
        definition: AutomationDefinition,
    ) -> Result<Automation, Error> {
        self.store_automation(id, definition, true)
    }

    /// Saves an edit the person is still making, such as a field being typed in.
    /// It is stored like any edit unless that would switch the Automation off
    /// here: a field emptied on the way to another value must not stop an
    /// Automation that is on. Then nothing is stored and the Automation is
    /// returned as it is; `update_automation` stores the edit, and switches the
    /// Automation off if it is still unfinished, once the person has made it.
    pub fn draft_automation(
        &mut self,
        id: &str,
        definition: AutomationDefinition,
    ) -> Result<Automation, Error> {
        self.store_automation(id, definition, false)
    }

    fn store_automation(
        &mut self,
        id: &str,
        definition: AutomationDefinition,
        may_switch_off: bool,
    ) -> Result<Automation, Error> {
        let definition = tidied(definition)?;
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        // A schedule counts again from a change to what starts the Automation, so
        // an old count never fires the new schedule at once. One that could not be
        // read before counts as changed.
        let trigger_kept = one(&transaction, id)
            .is_ok_and(|before| before.definition.trigger == definition.trigger);
        if !trigger_kept {
            transaction.execute(
                "UPDATE automation_device_state SET schedule_from = NULL WHERE automation_id = ?1",
                [id],
            )?;
        }
        let changed = transaction.execute(
            "UPDATE automations SET name = ?2, definition = ?3 WHERE id = ?1 AND trashed = 0",
            params![id, definition.name, encode(&definition)?],
        )?;
        if changed == 0 {
            return Err(Error::AutomationNotFound(id.to_owned()));
        }
        let mut automation = one(&transaction, id)?;
        if automation.enabled && !automation.can_be_on() {
            if !may_switch_off {
                // Dropping the savepoint leaves the Automation as it was stored.
                drop(transaction);
                return one(&self.connection, id);
            }
            transaction.execute(
                "DELETE FROM automation_device_state WHERE automation_id = ?1",
                [id],
            )?;
            automation.enabled = false;
        }
        transaction.commit()?;
        Ok(automation)
    }

    /// A deleted Automation is also off, and its Queued and Running runs end: it
    /// "will no longer run". They end as Needs attention with the reason, already
    /// answered, since the person asked for this and has nothing left to do.
    /// Returns the Chats of the agents that were working, for the host to interrupt.
    pub fn delete_automation(&mut self, id: &str) -> Result<Vec<String>, Error> {
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
        let chats = crate::automation_background::end_active_runs(
            &transaction,
            id,
            crate::automation_endings::Cause::Deleted,
        )?;
        transaction.commit()?;
        Ok(chats)
    }

    pub fn automation(&self, id: &str) -> Result<Automation, Error> {
        one(&self.connection, id)
    }

    /// The Automations that are not deleted, newest first.
    pub fn automations(&self) -> Result<Vec<Automation>, Error> {
        load(&self.connection, None)
    }

    /// Switches an Automation on or off for this device. Switching on is refused
    /// while anything is unfinished and for one that is run by hand, and starts from the Workspace events logged so
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
            if automation.definition.trigger == Some(Trigger::ByHand) {
                return Err(Error::InvalidAutomation(
                    "an Automation you run by hand is not switched on; use Run now".into(),
                ));
            }
            // Already on keeps its place in the log.
            transaction.execute(
                "INSERT OR IGNORE INTO automation_device_state (automation_id, cursor) VALUES (?1, ?2)",
                params![id, crate::events::head(&transaction)?],
            )?;
            transaction.execute(
                "DELETE FROM automation_arrivals WHERE automation_id = ?1",
                [id],
            )?;
            automation.arrived_off = false;
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
