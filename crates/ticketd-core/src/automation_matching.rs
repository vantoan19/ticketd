//! Whether a Workspace event starts an Automation. No SQL: the caller reads the
//! ticket's facts and hands them in.

use serde_json::{Value, json};

use crate::automations::{AutomationDefinition, Condition, Trigger};
use crate::events::{WorkspaceActor, WorkspaceEvent, WorkspaceEventType};

/// The `source` of a ticket that no external tracker owns.
pub(crate) const LOCAL_SOURCE: &str = "local";

/// What the conditions test, read from the ticket as it is when the event is matched.
pub(crate) struct TicketFacts {
    pub project_id: Option<String>,
    /// The provider that owns the ticket ("github"), or `LOCAL_SOURCE`.
    pub source: String,
    pub tags: Vec<String>,
}

/// An Automation's own changes never start an Automation, which is what keeps
/// Automations from looping. Neither does a change Workspace sync applied from
/// another desktop: the actor is not synchronized, so it could be an Automation's
/// there, and the other desktop has already reacted to it. Otherwise the event
/// must match the trigger and every condition; a change a ticket source brought in
/// counts like one made here.
pub(crate) fn matches(
    definition: &AutomationDefinition,
    event: &WorkspaceEvent,
    ticket: &TicketFacts,
) -> bool {
    match event.actor {
        WorkspaceActor::Automation | WorkspaceActor::WorkspaceSync => return false,
        WorkspaceActor::Person | WorkspaceActor::Sync => {}
    }
    let is = |kind| event.kind == kind;
    let was = |field: &str| changed(&event.previous, field);
    let now = |field: &str| changed(&event.current, field);
    let triggered = match &definition.trigger {
        Some(Trigger::TicketCreated) => is(WorkspaceEventType::TicketCreated),
        Some(Trigger::TicketUpdated) => is(WorkspaceEventType::TicketUpdated),
        Some(Trigger::StatusChanged { to, from }) => {
            is(WorkspaceEventType::TicketStatusChanged)
                && to.is_some_and(|to| now("status") == Some(&json!(to)))
                && from.is_none_or(|from| was("status") == Some(&json!(from)))
        }
        Some(Trigger::TagAdded { tag }) => {
            is(WorkspaceEventType::TicketTagAdded) && now("tag") == Some(&json!(tag))
        }
        Some(Trigger::TagRemoved { tag }) => {
            is(WorkspaceEventType::TicketTagRemoved) && was("tag") == Some(&json!(tag))
        }
        Some(Trigger::ActivityCreated) => is(WorkspaceEventType::ActivityCreated),
        // Schedules and by-hand Automations do not start from the log at all.
        Some(Trigger::Schedule { .. } | Trigger::ByHand) | None => false,
    };
    triggered
        && definition
            .conditions
            .iter()
            .all(|condition| match condition {
                Condition::Project { any_of } => ticket
                    .project_id
                    .as_ref()
                    .is_some_and(|project| any_of.contains(project)),
                Condition::Source { any_of } => any_of.contains(&ticket.source),
                Condition::Tag { tag, has } => ticket.tags.contains(tag) == *has,
            })
}

/// One field of an event's previous or current values.
fn changed<'a>(values: &'a Option<Value>, field: &str) -> Option<&'a Value> {
    values.as_ref().and_then(|values| values.get(field))
}
