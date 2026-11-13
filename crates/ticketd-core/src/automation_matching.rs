//! Whether a Workspace event starts an Automation. No SQL: the caller reads the
//! ticket's facts and hands them in.

use crate::automations::{AutomationDefinition, Condition, Trigger};
use crate::events::{WorkspaceActor, WorkspaceEvent, WorkspaceEventType};

/// What the conditions test, read from the ticket as it is when the event is matched.
pub(crate) struct TicketFacts {
    pub project_id: Option<String>,
    pub tags: Vec<String>,
}

/// An Automation's own changes never start an Automation, which is what keeps
/// Automations from looping. Otherwise the event must match the trigger and every
/// condition.
pub(crate) fn matches(
    definition: &AutomationDefinition,
    event: &WorkspaceEvent,
    ticket: &TicketFacts,
) -> bool {
    if event.actor == WorkspaceActor::Automation {
        return false;
    }
    let triggered = match &definition.trigger {
        Some(Trigger::TagAdded { tag }) => {
            event.kind == WorkspaceEventType::TicketTagAdded
                && event
                    .current
                    .as_ref()
                    .and_then(|current| current["tag"].as_str())
                    == Some(tag.as_str())
        }
        // The other event triggers are matched from #392 on; schedules and by-hand
        // Automations do not start from the log at all.
        Some(
            Trigger::TicketCreated
            | Trigger::TicketUpdated
            | Trigger::StatusChanged { .. }
            | Trigger::TagRemoved { .. }
            | Trigger::ActivityCreated
            | Trigger::Schedule { .. }
            | Trigger::ByHand,
        )
        | None => false,
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
                Condition::Tag { tag, has } => ticket.tags.contains(tag) == *has,
                // Nothing can set a source condition yet (#392); until it is matched, an
                // Automation narrowed by one starts nothing rather than too much.
                Condition::Source { .. } => false,
            })
}
