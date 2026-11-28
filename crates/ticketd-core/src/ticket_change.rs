//! The ticket change: the one place that decides what changing a ticket means.
//!
//! A ticket is changed through many entry points: [`Workspace::change_ticket`] for content,
//! status and placement; `add_tag`, `set_parent`, `add_dependency` and `set_plan` for one
//! thing each; the combined [`TicketChange`] of `apply_ticket_change`; a batch of them; and
//! the replayable `WriteRequest` that names each. They all do the same work in the same
//! order, and this module is where that order and the rules in it live:
//!
//! 1. the write scope resolves the Ticket reference and refuses a ticket in Trash;
//! 2. the ticket's own rules: a stale editor save, the external owner of its content, an
//!    archived Project or Plan, entering and leaving Duplicate;
//! 3. history and the inbox entry it makes;
//! 4. one read back of the changed ticket, however many steps the change had.
//!
//! The steps of a change are functions of a [`WriteScope`], so a combined change or a batch
//! makes all of its steps in one scope and reads each ticket once. The rules of the
//! relationship graphs (a dependency cycle, a valid hierarchy) stay with their graphs in
//! `relationships.rs` and `hierarchy.rs`; the entry points reach them from here.
//!
//! One thing still depends on the entry point, and is named by [`Mode`]: what leaving
//! Duplicate means.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::write_scope::{self, WriteScope};
use crate::{
    Activity, Error, Status, Ticket, TicketPatch, Workspace, activities, device, document_links,
    duplicates, hierarchy, history, inbox, plans, projects, read_ticket, relationships, source,
    tags,
};

/// A cohesive change applies each supplied edit in the order documented here.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TicketChange {
    #[serde(flatten)]
    pub patch: TicketPatch,
    #[serde(default)]
    pub activities: Vec<String>,
    #[serde(default)]
    pub add_tags: Vec<String>,
    #[serde(default)]
    pub remove_tags: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::deserialize_project_patch"
    )]
    pub parent: Option<Option<String>>,
    #[serde(default)]
    pub add_blockers: Vec<String>,
    #[serde(default)]
    pub remove_blockers: Vec<String>,
}

/// Whether a change is made on its own or as one of many in a batch.
///
/// Leaving Duplicate would drop which ticket the ticket duplicates. A change made on its
/// own is a deliberate act on one ticket, so it clears the link. A change in bulk is one
/// of a plan nobody is watching, so it is refused and the person removes the link first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// `change_ticket`, and everything built on it: clears the duplicate link.
    Single,
    /// A batch, and so the combined single-ticket change: refuses.
    Bulk,
}

/// How long a batch may take. It is one of the bounds on a request that came with batches
/// (`docs/cli.md`: size, operations, individual edits and time), so that a plan nobody is
/// watching cannot run without end; a batch that runs past it rolls back instead of
/// committing part of a plan. It is checked between operations, so one slow operation can
/// still overrun it. It is not derived from the connection's busy timeout, which also
/// happens to be 10 seconds: a batch holds the Workspace's write lock until it ends, so a
/// long one makes other writers wait, but this limit does not promise they stay under it.
const BATCH_TIME_LIMIT: Duration = Duration::from_secs(10);

/// The time a batch may take.
pub(crate) struct Deadline(Instant);

impl Deadline {
    pub(crate) fn from_now() -> Self {
        Self(Instant::now())
    }

    pub(crate) fn check(&self) -> Result<(), Error> {
        if self.0.elapsed() > BATCH_TIME_LIMIT {
            return Err(Error::InvalidBatch("time limit exceeded".into()));
        }
        Ok(())
    }
}

/// The tickets a batch has created so far, by the local name that later operations use
/// as `$name`.
pub(crate) type Names = HashMap<String, String>;

/// A reference as written in a batch: `$name` is a ticket created earlier in it.
pub(crate) fn resolve(names: &Names, reference: &str) -> Result<String, Error> {
    match reference.strip_prefix('$') {
        Some(name) => names
            .get(name)
            .cloned()
            .ok_or_else(|| Error::InvalidBatch(format!("unknown local name '{name}'"))),
        None => Ok(reference.into()),
    }
}

/// Make a change in one write scope and read `reference` back once at the end.
pub(crate) fn commit(
    connection: &Connection,
    reference: &str,
    change: impl FnOnce(&WriteScope<'_>) -> Result<(), Error>,
) -> Result<Ticket, Error> {
    write_scope::run(connection, |scope| {
        change(scope)?;
        read_ticket(scope, reference)
    })
}

/// The longest title a new or changed ticket may have. Titles already stored stay valid.
pub(crate) const MAX_TITLE: usize = 1000;

/// The trimmed title. A write checks this before it enters the write scope, so a bad
/// title is refused at once instead of after waiting for another writer's lock. A title
/// is one non-empty line of at most [`MAX_TITLE`] characters.
fn non_empty_title(title: &str) -> Result<&str, Error> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::EmptyTitle);
    }
    if title.contains(['\n', '\r']) {
        return Err(Error::TitleNotOneLine);
    }
    if title.chars().count() > MAX_TITLE {
        return Err(Error::TitleTooLong(MAX_TITLE));
    }
    Ok(title)
}

/// A title taken from another system, made to fit the rules above instead of refused:
/// line breaks (and the space around them) become one space, and a title over
/// [`MAX_TITLE`] characters is cut there. An import must not fail over how the provider
/// wrote a title; the full title stays at the provider. Blank stays blank, so the caller
/// can fall back to something else.
pub(crate) fn imported_title(title: &str) -> String {
    let mut one_line = String::with_capacity(title.len());
    for (index, line) in title
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .enumerate()
    {
        if index > 0 {
            one_line.push(' ');
        }
        one_line.push_str(line);
    }
    one_line
        .chars()
        .take(MAX_TITLE)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// A new ticket, in a project and a Plan if given, read back.
pub(crate) fn create(
    scope: &WriteScope<'_>,
    title: &str,
    project_id: Option<&str>,
    plan_id: Option<&str>,
) -> Result<Ticket, Error> {
    let title = non_empty_title(title)?;
    if let Some(id) = project_id {
        projects::ensure_active(scope, id)?;
    }
    if let Some(id) = plan_id {
        plans::ensure_active(scope, id)?;
    }
    let id = Uuid::new_v4().to_string();
    let reference = device::issue_reference(scope)?;
    scope.execute(
        "INSERT INTO tickets (id, reference, title, status, project_id, plan_id) VALUES (?1, ?2, ?3, 'Todo', ?4, ?5)",
        params![id, reference, title, project_id, plan_id],
    )?;
    if let Some(project_id) = project_id {
        history::record(scope, &id, "project", "", project_id, None)?;
    }
    if let Some(plan_id) = plan_id {
        history::record(scope, &id, "plan", "", plan_id, None)?;
    }
    read_ticket(scope, &reference)
}

/// Change a ticket's content, status, project or Plan.
pub(crate) fn edit(
    scope: &WriteScope<'_>,
    reference: &str,
    patch: &TicketPatch,
    mode: Mode,
) -> Result<(), Error> {
    if mode == Mode::Bulk {
        refuse_leaving_duplicate(scope, reference, patch.status)?;
    }
    let title = patch.title.as_deref().map(non_empty_title).transpose()?;
    let ticket = scope.editable_ticket(reference)?;
    let stale = |new: &Option<String>, expected: &Option<String>, stored: &str| {
        new.is_some()
            && expected
                .as_deref()
                .is_some_and(|expected| expected != stored)
    };
    // An editor that sends the values it loaded is refused when someone else has since
    // changed them (ADR 0015). A caller that omits them overwrites.
    if stale(&patch.title, &patch.expected_title, &ticket.title)
        || (patch.status.is_some()
            && patch
                .expected_status
                .is_some_and(|expected| expected != ticket.status))
        || stale(&patch.body, &patch.expected_body, &ticket.body)
    {
        return Err(Error::TicketChanged(reference.to_owned()));
    }
    source::guard_change(
        scope,
        &ticket,
        title,
        patch.body.as_deref(),
        patch.status.unwrap_or(ticket.status),
    )?;
    if let Some(ref plan_id) = patch.plan_id {
        if let Some(id) = plan_id {
            if *plan_id == ticket.plan_id {
                plans::get(scope, id)?;
            } else {
                // Moving a ticket out of an archived Plan stays allowed; moving in is not.
                plans::ensure_active(scope, id)?;
            }
        }
        if *plan_id != ticket.plan_id {
            scope.execute(
                "UPDATE tickets SET plan_id = ?1 WHERE id = ?2",
                params![plan_id, ticket.id],
            )?;
            history::record(
                scope,
                &ticket.id,
                "plan",
                ticket.plan_id.as_deref().unwrap_or(""),
                plan_id.as_deref().unwrap_or(""),
                patch.editing_agent.as_deref(),
            )?;
        }
    }
    if let Some(ref project_id) = patch.project_id {
        set_project(
            scope,
            &ticket.id,
            ticket.project_id.as_deref(),
            project_id.as_deref(),
            patch.editing_agent.as_deref(),
        )?;
    }
    let status = patch.status.unwrap_or(ticket.status);
    if status != ticket.status {
        if status == Status::Duplicate {
            return Err(Error::DuplicateNeedsCanonical);
        }
        if ticket.status == Status::Duplicate {
            // Only a change on its own gets here: a bulk one was refused above.
            duplicates::clear(scope, &ticket.id, patch.editing_agent.as_deref())?;
        }
    }
    scope.execute(
        "UPDATE tickets SET title = COALESCE(?1, title), body = COALESCE(?2, body), status = ?3 WHERE id = ?4",
        params![title, patch.body, status.to_string(), ticket.id],
    )?;
    if let Some(body) = patch.body.as_deref() {
        document_links::index_body(scope, &ticket.id, body)?;
    }
    if status != ticket.status {
        history::record(
            scope,
            &ticket.id,
            "status",
            &ticket.status.to_string(),
            &status.to_string(),
            patch.editing_agent.as_deref(),
        )?;
    }
    Ok(())
}

/// Validates a new project assignment and records the membership change.
pub(crate) fn set_project(
    scope: &WriteScope<'_>,
    ticket_id: &str,
    current: Option<&str>,
    project_id: Option<&str>,
    agent: Option<&str>,
) -> Result<(), Error> {
    if project_id != current {
        if let Some(id) = project_id {
            projects::ensure_active(scope, id)?;
        }
        scope.execute(
            "UPDATE tickets SET project_id = ?1 WHERE id = ?2",
            params![project_id, ticket_id],
        )?;
        history::record(
            scope,
            ticket_id,
            "project",
            current.unwrap_or(""),
            project_id.unwrap_or(""),
            agent,
        )?;
    }
    Ok(())
}

/// The refusal that makes a bulk change differ from one on its own. It comes before every
/// other rule, so a Duplicate is told to lose its link first whatever else is wrong.
fn refuse_leaving_duplicate(
    scope: &WriteScope<'_>,
    reference: &str,
    status: Option<Status>,
) -> Result<(), Error> {
    let Some(status) = status else {
        return Ok(());
    };
    let current = scope.ticket_even_if_trashed(reference)?;
    if current.status == Status::Duplicate && status != current.status {
        let duplicate_of = read_ticket(scope, reference)?.duplicate_of;
        return Err(Error::InvalidBatch(format!(
            "{reference} is a duplicate{}; open it and remove the duplicate link before changing its status",
            duplicate_of
                .map(|of| format!(" of {of}"))
                .unwrap_or_default()
        )));
    }
    Ok(())
}

/// Post an update on a ticket and tell the inbox.
pub(crate) fn post_update(
    scope: &WriteScope<'_>,
    reference: &str,
    content: &str,
    agent: Option<&str>,
) -> Result<Activity, Error> {
    let ticket_id = scope.editable(reference)?;
    let activity = activities::add(scope, &ticket_id, content, agent)?;
    inbox::record(scope, &ticket_id, "activity", &activity.id, content, agent)?;
    Ok(activity)
}

/// Make every edit of a combined change to `reference`, in this order: the patch, updates,
/// tags added then removed, the parent, blockers removed then added. Then read the ticket
/// back once. A change that is part of a batch is made in bulk.
pub(crate) fn apply(
    scope: &WriteScope<'_>,
    reference: &str,
    change: TicketChange,
    names: &Names,
    deadline: &Deadline,
) -> Result<Ticket, Error> {
    let agent = change.patch.editing_agent.as_deref();
    edit(scope, reference, &change.patch, Mode::Bulk)?;
    for note in &change.activities {
        deadline.check()?;
        post_update(scope, reference, note, agent)?;
    }
    for tag in &change.add_tags {
        deadline.check()?;
        tags::add(scope, reference, tag, agent)?;
    }
    for tag in &change.remove_tags {
        deadline.check()?;
        tags::remove(scope, reference, tag, agent)?;
    }
    if let Some(parent) = &change.parent {
        let parent = parent
            .as_deref()
            .map(|parent| resolve(names, parent))
            .transpose()?;
        hierarchy::set_parent(scope, reference, parent.as_deref(), agent)?;
    }
    for blocker in &change.remove_blockers {
        deadline.check()?;
        relationships::remove_dependency(scope, &resolve(names, blocker)?, reference, agent)?;
    }
    for blocker in &change.add_blockers {
        deadline.check()?;
        relationships::add_dependency(scope, &resolve(names, blocker)?, reference, agent)?;
    }
    read_ticket(scope, reference)
}

impl Workspace {
    /// Change one ticket with every edit of a [`TicketChange`], atomically. It is a batch
    /// of one: it has a batch's limits and refuses to leave Duplicate.
    pub fn apply_ticket_change(
        &mut self,
        reference: &str,
        change: TicketChange,
    ) -> Result<Ticket, Error> {
        let mut result = self.apply_batch(vec![crate::BatchOperation::Change {
            ticket: reference.into(),
            change: Box::new(change),
        }])?;
        result
            .pop()
            .ok_or_else(|| Error::InvalidBatch("missing result".into()))
    }

    pub fn create_ticket(&mut self, title: &str) -> Result<Ticket, Error> {
        self.create_ticket_in_project(title, None)
    }

    pub fn create_ticket_in_project(
        &mut self,
        title: &str,
        project_id: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.create_ticket_in_context(title, project_id, None)
    }

    pub fn create_ticket_in_context(
        &mut self,
        title: &str,
        project_id: Option<&str>,
        plan_id: Option<&str>,
    ) -> Result<Ticket, Error> {
        non_empty_title(title)?;
        write_scope::run(&self.connection, |scope| {
            create(scope, title, project_id, plan_id)
        })
    }

    /// Change a ticket on its own. Leaving Duplicate clears the duplicate link.
    pub fn change_ticket(&mut self, reference: &str, patch: TicketPatch) -> Result<Ticket, Error> {
        patch.title.as_deref().map(non_empty_title).transpose()?;
        commit(&self.connection, reference, |scope| {
            edit(scope, reference, &patch, Mode::Single)
        })
    }

    pub fn add_activity(
        &mut self,
        reference: &str,
        content: &str,
        agent: Option<&str>,
    ) -> Result<Activity, Error> {
        write_scope::run(&self.connection, |scope| {
            post_update(scope, reference, content, agent)
        })
    }
}
