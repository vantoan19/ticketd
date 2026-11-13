//! What a run's Change ticket and Notify me steps do. A Change ticket step writes as
//! the Automation, so its change starts no Automation; text is stored with field
//! references and they are resolved here, when the step runs.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::automation_runs::AutomationRun;
use crate::automations::{NotifyTarget, StepAction, StepChange};
use crate::events::{Acting, WorkspaceEventType};
use crate::{Error, TicketPatch, Workspace};

/// What the field references in a step's text stand for when it runs.
#[derive(Default)]
struct Fields {
    reference: String,
    title: String,
    status: String,
    /// The tag of the event that started the run; empty when it was not about a tag.
    tag: String,
}

/// `text` with each field reference replaced by its value. Anything else in double
/// braces is not a reference and stays as written.
fn resolve(text: &str, fields: &Fields) -> String {
    [
        ("{{ticket.reference}}", &fields.reference),
        ("{{ticket.title}}", &fields.title),
        ("{{ticket.status}}", &fields.status),
        ("{{event.tag}}", &fields.tag),
    ]
    .iter()
    // Every reference at once: a title that holds "{{ticket.status}}" is not read again.
    .fold(vec![(text.to_owned(), false)], |parts, (name, value)| {
        parts
            .into_iter()
            .flat_map(|(part, resolved)| {
                if resolved {
                    return vec![(part, true)];
                }
                let mut pieces = Vec::new();
                for (index, piece) in part.split(name).enumerate() {
                    if index > 0 {
                        pieces.push(((*value).clone(), true));
                    }
                    pieces.push((piece.to_owned(), false));
                }
                pieces
            })
            .collect()
    })
    .into_iter()
    .map(|(part, _)| part)
    .collect()
}

/// A desktop notification a Notify me step asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationNotification {
    /// The Automation's name.
    pub title: String,
    /// The step's text with its fields filled in.
    pub body: String,
    /// What a click opens. A run without a ticket opens the run.
    pub opens: NotifyTarget,
    pub ticket_reference: Option<String>,
    pub automation_id: String,
    pub run_id: String,
}

impl Workspace {
    fn run_fields(&self, run: &AutomationRun) -> Result<Fields, Error> {
        let Some(ticket) = &run.ticket else {
            return Ok(Fields::default());
        };
        let ticket = self.show_ticket(&ticket.reference)?;
        let values = match run.event.kind {
            WorkspaceEventType::TicketTagAdded => run.event.current.as_ref(),
            WorkspaceEventType::TicketTagRemoved => run.event.previous.as_ref(),
            _ => None,
        };
        Ok(Fields {
            reference: ticket.reference,
            title: ticket.title,
            status: ticket.status.to_string(),
            tag: values
                .and_then(|values| values["tag"].as_str())
                .unwrap_or_default()
                .to_owned(),
        })
    }

    /// Makes the change of the Change ticket step `step_id` of a run to the run's
    /// ticket. The write is logged with actor `automation`, and one that carries
    /// attribution (a status, a posted update) is signed with the Automation's name.
    /// A change the Workspace refuses is the error.
    pub fn apply_automation_change(&mut self, run_id: &str, step_id: &str) -> Result<(), Error> {
        let run = self.automation_run(run_id)?;
        let Some(StepAction::ChangeTicket {
            change: Some(change),
            ..
        }) = run.step(step_id).map(|step| &step.action)
        else {
            return Err(Error::AutomationRun(
                "the step has no change to make".into(),
            ));
        };
        let Some(ticket) = &run.ticket else {
            return Err(Error::AutomationRun("the run has no ticket".into()));
        };
        let (reference, name) = (ticket.reference.as_str(), run.definition.name.as_str());
        let own_actor = crate::events::actor(&self.connection)?;
        crate::events::set_actor(&self.connection, Some(Acting::Automation))?;
        let changed = match change {
            StepChange::AddTag { tag } => self.add_tag(reference, tag).map(drop),
            StepChange::RemoveTag { tag } => self.remove_tag(reference, tag).map(drop),
            StepChange::SetStatus { status } => self
                .change_ticket(
                    reference,
                    TicketPatch {
                        status: Some(*status),
                        editing_agent: Some(name.to_owned()),
                        ..TicketPatch::default()
                    },
                )
                .map(drop),
            StepChange::PostUpdate { text } => self
                .run_fields(&run)
                .and_then(|fields| {
                    self.add_activity(reference, &resolve(text, &fields), Some(name))
                })
                .map(drop),
        };
        crate::events::set_actor(&self.connection, own_actor)?;
        changed
    }

    /// The notification the Notify me step `step_id` of a run shows, with the fields
    /// in its text filled in from the ticket as it is now.
    pub fn automation_notification(
        &self,
        run_id: &str,
        step_id: &str,
    ) -> Result<AutomationNotification, Error> {
        let run = self.automation_run(run_id)?;
        let Some(StepAction::Notify { text, opens, .. }) =
            run.step(step_id).map(|step| &step.action)
        else {
            return Err(Error::AutomationRun("the step notifies no one".into()));
        };
        Ok(AutomationNotification {
            title: run.definition.name.clone(),
            body: resolve(text, &self.run_fields(&run)?),
            opens: if run.ticket.is_some() {
                *opens
            } else {
                NotifyTarget::Run
            },
            ticket_reference: run.ticket.as_ref().map(|ticket| ticket.reference.clone()),
            automation_id: run.automation_id.clone(),
            run_id: run.id.clone(),
        })
    }

    /// A step's text as it would read for the ticket changed most recently, with
    /// `tag` standing for the tag from the event. `None` while there is no ticket.
    pub fn preview_automation_text(
        &self,
        text: &str,
        tag: Option<&str>,
    ) -> Result<Option<String>, Error> {
        let recent: Option<String> = self
            .connection
            .query_row(
                "SELECT reference FROM tickets WHERE trashed = 0 ORDER BY updated_at DESC, rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(reference) = recent else {
            return Ok(None);
        };
        let ticket = self.show_ticket(&reference)?;
        Ok(Some(resolve(
            text,
            &Fields {
                reference: ticket.reference,
                title: ticket.title,
                status: ticket.status.to_string(),
                tag: tag.unwrap_or_default().to_owned(),
            },
        )))
    }
}
