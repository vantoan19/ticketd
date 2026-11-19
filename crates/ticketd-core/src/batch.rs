use crate::ticket_change::{self, Deadline, Names};
use crate::write_scope;
use crate::{Error, Ticket, TicketChange, Workspace};
use serde::{Deserialize, Serialize};

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
        self.apply_batch_following(operations, false)
    }

    /// Apply a plan atomically and, when `follow_created` is set, make the local person
    /// follow every ticket the plan creates in the same write. Following starts after the
    /// plan's own edits, so setting up a new ticket does not fill the inbox.
    pub fn apply_batch_following(
        &mut self,
        operations: Vec<BatchOperation>,
        follow_created: bool,
    ) -> Result<Vec<Ticket>, Error> {
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
                    1 + change.activities.len()
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
        write_scope::run(&self.connection, |scope| {
            let deadline = Deadline::from_now();
            let mut names = Names::new();
            let mut results = Vec::new();
            let mut created = Vec::new();
            for (index, operation) in operations.into_iter().enumerate() {
                let result = (|| {
                    deadline.check()?;
                    match operation {
                        BatchOperation::Create {
                            name,
                            title,
                            project_id,
                        } => {
                            if name.is_empty() || name.starts_with('$') || names.contains_key(&name)
                            {
                                return Err(Error::InvalidBatch(format!(
                                    "invalid or duplicate local name '{name}'"
                                )));
                            }
                            let ticket =
                                ticket_change::create(scope, &title, project_id.as_deref(), None)?;
                            names.insert(name, ticket.reference.clone());
                            created.push(ticket.id.clone());
                            Ok(ticket)
                        }
                        BatchOperation::Change { ticket, change } => {
                            let reference = ticket_change::resolve(&names, &ticket)?;
                            ticket_change::apply(scope, &reference, *change, &names, &deadline)
                        }
                    }
                })();
                results.push(result.map_err(|source| Error::BatchOperation {
                    index,
                    source: Box::new(name_created(source, &names)),
                })?);
            }
            if follow_created {
                for id in created {
                    crate::inbox::follow(scope, &id)?;
                }
            }
            Ok(results)
        })
    }
}

/// Reword a failure so tickets the batch created are called by the caller's `$name`.
/// They exist only inside the batch, so their references (which the next create reuses)
/// would send the caller looking for tickets that were never saved. Tickets that existed
/// before the batch keep their references. The original error stays as the cause.
fn name_created(error: Error, names: &Names) -> Error {
    let message = error.to_string();
    let named = rename_references(&message, names);
    if named == message {
        return error;
    }
    Error::BatchNamed {
        message: named,
        source: Box::new(error),
    }
}

/// Replace each whole reference token in `text` that a batch name stands for. A reference
/// is only replaced as a whole word, so `T-NH2` never matches inside `T-NH23`.
fn rename_references(text: &str, names: &Names) -> String {
    let is_word = |c: char| c.is_alphanumeric() || c == '-' || c == '_' || c == '$';
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        match names.iter().find(|(_, reference)| **reference == *word) {
            Some((name, _)) => {
                out.push('$');
                out.push_str(name);
            }
            None => out.push_str(word),
        }
        word.clear();
    };
    for c in text.chars() {
        if is_word(c) {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}
