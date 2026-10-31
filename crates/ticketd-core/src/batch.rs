use crate::{Error, Ticket, TicketPatch, Workspace};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// A cohesive change applies each supplied edit in the order documented here.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TicketChange {
    #[serde(flatten)]
    pub patch: TicketPatch,
    #[serde(default)]
    pub notes: Vec<String>,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchOperation {
    Create {
        name: String,
        title: String,
        project_id: Option<String>,
    },
    Change {
        ticket: String,
        change: Box<TicketChange>,
    },
}

impl Workspace {
    /// Apply a plan atomically. References prefixed with `$` refer to earlier creates.
    pub fn apply_batch(&mut self, operations: Vec<BatchOperation>) -> Result<Vec<Ticket>, Error> {
        if operations.is_empty()
            || operations.len() > 100
            || serde_json::to_vec(&operations)
                .map_err(|e| Error::InvalidBatch(e.to_string()))?
                .len()
                > 1_048_576
        {
            return Err(Error::InvalidBatch(
                "supply 1 to 100 operations totaling at most 1 MiB".into(),
            ));
        }
        let edits: usize = operations
            .iter()
            .map(|operation| match operation {
                BatchOperation::Create { .. } => 1,
                BatchOperation::Change { change, .. } => {
                    1 + change.notes.len()
                        + change.add_tags.len()
                        + change.remove_tags.len()
                        + change.add_blockers.len()
                        + change.remove_blockers.len()
                }
            })
            .sum();
        if edits > 1000 {
            return Err(Error::InvalidBatch(
                "at most 1000 individual edits are allowed".into(),
            ));
        }
        self.connection.execute_batch("SAVEPOINT batch")?;
        if let Err(error) = crate::transaction_write_lock(&self.connection) {
            let _ = self.connection.execute_batch("ROLLBACK TO batch; RELEASE batch");
            return Err(error);
        }
        let result = self.apply_batch_inner(operations);
        match result {
            Ok(tickets) => {
                if let Err(error) = self.connection.execute_batch("RELEASE batch") {
                    let _ = self
                        .connection
                        .execute_batch("ROLLBACK TO batch; RELEASE batch");
                    return Err(error.into());
                }
                Ok(tickets)
            }
            Err(error) => {
                self.connection
                    .execute_batch("ROLLBACK TO batch; RELEASE batch")?;
                Err(error)
            }
        }
    }

    fn apply_batch_inner(&mut self, operations: Vec<BatchOperation>) -> Result<Vec<Ticket>, Error> {
        let started = Instant::now();
        let mut names = HashMap::new();
        let mut results = Vec::new();
        for (index, operation) in operations.into_iter().enumerate() {
            let result = (|| {
                if started.elapsed() > Duration::from_secs(10) {
                    return Err(Error::InvalidBatch("time limit exceeded".into()));
                }
                match operation {
                    BatchOperation::Create {
                        name,
                        title,
                        project_id,
                    } => {
                        if name.is_empty() || name.starts_with('$') || names.contains_key(&name) {
                            return Err(Error::InvalidBatch(format!(
                                "invalid or duplicate local name '{name}'"
                            )));
                        }
                        let ticket =
                            self.create_ticket_in_project(&title, project_id.as_deref())?;
                        names.insert(name, ticket.reference.clone());
                        Ok(ticket)
                    }
                    BatchOperation::Change { ticket, change } => {
                        let reference = resolve(&names, &ticket)?;
                        self.apply_change_inner(&reference, *change, &names, started)
                    }
                }
            })();
            results.push(result.map_err(|source| Error::BatchOperation {
                index,
                source: Box::new(source),
            })?);
        }
        Ok(results)
    }

    pub fn apply_ticket_change(
        &mut self,
        reference: &str,
        change: TicketChange,
    ) -> Result<Ticket, Error> {
        let mut result = self.apply_batch(vec![BatchOperation::Change {
            ticket: reference.into(),
            change: Box::new(change),
        }])?;
        result
            .pop()
            .ok_or_else(|| Error::InvalidBatch("missing result".into()))
    }

    fn apply_change_inner(
        &mut self,
        reference: &str,
        change: TicketChange,
        names: &HashMap<String, String>,
        started: Instant,
    ) -> Result<Ticket, Error> {
        let agent = change.patch.editing_agent.clone();
        self.change_ticket(reference, change.patch)?;
        for note in change.notes {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(Error::InvalidBatch("time limit exceeded".into()));
            }
            self.add_note(reference, &note, agent.as_deref())?;
        }
        for tag in change.add_tags {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(Error::InvalidBatch("time limit exceeded".into()));
            }
            self.add_tag(reference, &tag)?;
        }
        for tag in change.remove_tags {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(Error::InvalidBatch("time limit exceeded".into()));
            }
            self.remove_tag(reference, &tag)?;
        }
        if let Some(parent) = change.parent {
            let parent = parent.map(|p| resolve(names, &p)).transpose()?;
            self.set_parent(reference, parent.as_deref(), agent.as_deref())?;
        }
        for blocker in change.remove_blockers {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(Error::InvalidBatch("time limit exceeded".into()));
            }
            self.remove_dependency(&resolve(names, &blocker)?, reference, agent.as_deref())?;
        }
        for blocker in change.add_blockers {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(Error::InvalidBatch("time limit exceeded".into()));
            }
            self.add_dependency(&resolve(names, &blocker)?, reference, agent.as_deref())?;
        }
        self.show_ticket(reference)
    }
}
fn resolve(names: &HashMap<String, String>, reference: &str) -> Result<String, Error> {
    match reference.strip_prefix('$') {
        Some(name) => names
            .get(name)
            .cloned()
            .ok_or_else(|| Error::InvalidBatch(format!("unknown local name '{name}'"))),
        None => Ok(reference.into()),
    }
}
