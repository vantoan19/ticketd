//! How an Automation run ends. Every way a run can leave Queued or Running goes
//! through `end`, so the rules live once: from which statuses a cause may end a run,
//! what happens to the step it was on, whether it asks for the person or is already
//! answered, and which Chats had agents working. `end` writes in the caller's
//! transaction.

use rusqlite::{Connection, params};

use crate::Error;
use crate::automation_run_machine::RunEnd;
use crate::automation_runs::{AutomationRunStatus, DISMISSED, NOW, announce, named};

/// Why a run the person stopped needs attention, and why its step did not finish.
const STOPPED: &str = "You stopped this run.";
/// Why the step a run was on did not finish when the person took its Chat over.
const TAKEN_OVER: &str = "You took this run over.";
/// Why a run ended when its Automation was switched off with "Stop it and turn off".
const TURNED_OFF: &str = "You stopped this run when you turned the Automation off.";
/// Why a run ended when its Automation was deleted.
const DELETED: &str = "You deleted this Automation.";

/// Why a run ends.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Cause<'a> {
    /// The steps ran out of path: every step on it ran, or a step failed with no
    /// failure path. The step it was on is already recorded.
    Path(&'a RunEnd),
    /// The person stopped it.
    Stopped,
    /// The person switched its Automation off with "Stop it and turn off".
    TurnedOff,
    /// The person deleted its Automation.
    Deleted,
    /// Nothing is executing it, or its executor cannot go on, for this reason: a
    /// process that is gone, a restored backup, bookkeeping that failed, an agent
    /// ticketd closed.
    Abandoned(&'a str),
    /// The person replied in or stopped the Chat of one of its steps.
    TakenOver,
}

/// What happens to the step a run was on.
enum StepFate {
    /// It is already recorded.
    Recorded,
    /// It failed, for this reason.
    Fails(String),
}

/// Whether a run that ended asks for the person.
enum Reaction {
    /// It needs them until they act on it, and its ticket's inbox says so.
    Announce,
    /// They asked for this: nothing is left for them to do.
    Answered,
    /// It asks for nothing.
    Quiet,
}

/// What a cause does to a run.
struct Ending {
    status: AutomationRunStatus,
    reason: Option<String>,
    step: StepFate,
    reaction: Reaction,
}

/// The ending of a run that is `status`, or `None` when the cause cannot end it.
fn decide(status: AutomationRunStatus, cause: Cause) -> Option<Ending> {
    use AutomationRunStatus::{Completed, NeedsAttention, Queued, Running, TakenOver};
    // Ends as Needs attention; the step fails for the reason the run does.
    let needs_attention = |reason: &str, reaction| Ending {
        status: NeedsAttention,
        reason: Some(reason.to_owned()),
        step: StepFate::Fails(reason.to_owned()),
        reaction,
    };
    match (cause, status) {
        (Cause::Path(RunEnd::Completed), Running) => Some(Ending {
            status: Completed,
            reason: None,
            step: StepFate::Recorded,
            reaction: Reaction::Quiet,
        }),
        (Cause::Path(RunEnd::NeedsAttention { reason }), Running) => Some(Ending {
            step: StepFate::Recorded,
            ..needs_attention(reason, Reaction::Announce)
        }),
        (Cause::Stopped, Queued | Running) => Some(needs_attention(STOPPED, Reaction::Announce)),
        (Cause::TurnedOff, Queued | Running) => {
            Some(needs_attention(TURNED_OFF, Reaction::Announce))
        }
        (Cause::Deleted, Queued | Running) => Some(needs_attention(DELETED, Reaction::Answered)),
        (Cause::Abandoned(reason), Running) => Some(needs_attention(reason, Reaction::Announce)),
        // A Completed run stays Completed when the person replies in its Chat, and
        // the Chat of one already taken over is no longer the run's.
        (Cause::TakenOver, Running | NeedsAttention) => Some(Ending {
            status: TakenOver,
            reason: None,
            step: StepFate::Fails(TAKEN_OVER.to_owned()),
            reaction: Reaction::Answered,
        }),
        // Every other pair ends nothing. Listed, not a catch-all, so a new cause or
        // status must be decided here.
        (Cause::Path(_), Queued | Completed | NeedsAttention | TakenOver)
        | (
            Cause::Stopped | Cause::TurnedOff | Cause::Deleted,
            Completed | NeedsAttention | TakenOver,
        )
        | (Cause::Abandoned(_), Queued | Completed | NeedsAttention | TakenOver)
        | (Cause::TakenOver, Queued | Completed | TakenOver) => None,
    }
}

/// What ending a run did.
pub(crate) struct Ended {
    /// The Chats of the agents that were working in it, for the host to interrupt.
    pub chats: Vec<String>,
}

/// What ending runs asks of the rest of the Workspace, gathered so that ending many
/// runs does it once: the inbox is scanned for every run that needs the person, not
/// once per run, and the answered runs are updated together.
#[derive(Default)]
struct Reactions {
    /// Some run that ended needs the person, so the inbox says so.
    announce: bool,
    /// Runs that ended already answered.
    answered: Vec<String>,
}

impl Reactions {
    fn add(&mut self, run_id: &str, reaction: Reaction) {
        match reaction {
            Reaction::Announce => self.announce = true,
            Reaction::Answered => self.answered.push(run_id.to_owned()),
            Reaction::Quiet => {}
        }
    }

    fn apply(self, connection: &Connection) -> Result<(), Error> {
        if self.announce {
            announce(connection)?;
        }
        if !self.answered.is_empty() {
            let ids = serde_json::to_string(&self.answered)?;
            connection.execute(
                "UPDATE automation_runs SET attention_cleared = ?2 WHERE attention_cleared = 0 AND id IN (SELECT value FROM json_each(?1))",
                params![ids, DISMISSED],
            )?;
            connection.execute(
                "UPDATE inbox_entries SET read = 1 WHERE kind = 'automation_run' AND read = 0 AND from_value IN (SELECT value FROM json_each(?1))",
                [ids],
            )?;
        }
        Ok(())
    }
}

/// Ends the run `run_id` for `cause`, or returns `None` and changes nothing when the
/// cause cannot end a run in its status.
pub(crate) fn end(
    connection: &Connection,
    run_id: &str,
    cause: Cause,
) -> Result<Option<Ended>, Error> {
    let mut reactions = Reactions::default();
    let ended = end_without_reacting(connection, run_id, cause, &mut reactions)?;
    reactions.apply(connection)?;
    Ok(ended)
}

/// Ends the run, leaving what it asks of the rest of the Workspace in `reactions`.
fn end_without_reacting(
    connection: &Connection,
    run_id: &str,
    cause: Cause,
    reactions: &mut Reactions,
) -> Result<Option<Ended>, Error> {
    let status: String = connection
        .query_row(
            "SELECT status FROM automation_runs WHERE id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Error::AutomationRunNotFound(run_id.to_owned()),
            error => error.into(),
        })?;
    let Some(ending) = decide(named(status)?, cause) else {
        return Ok(None);
    };
    let chats = {
        let mut statement = connection.prepare(
            "SELECT chat_id FROM automation_run_steps WHERE run_id = ?1 AND status = 'running' AND chat_id IS NOT NULL",
        )?;
        statement
            .query_map([run_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?
    };
    if let StepFate::Fails(reason) = &ending.step {
        connection.execute(
            &format!("UPDATE automation_run_steps SET status = 'failed', reason = ?2, ended_at = {NOW} WHERE run_id = ?1 AND status = 'running'"),
            params![run_id, reason],
        )?;
    }
    // A run the person took over from Needs attention keeps the time it ended.
    let ended_at = match cause {
        Cause::TakenOver => format!("COALESCE(ended_at, {NOW})"),
        Cause::Path(_)
        | Cause::Stopped
        | Cause::TurnedOff
        | Cause::Deleted
        | Cause::Abandoned(_) => NOW.to_owned(),
    };
    connection.execute(
        &format!("UPDATE automation_runs SET status = ?2, reason = ?3, ended_at = {ended_at} WHERE id = ?1"),
        params![run_id, ending.status.as_str(), ending.reason],
    )?;
    reactions.add(run_id, ending.reaction);
    Ok(Some(Ended { chats }))
}

/// Ends each of the runs `ids` for `cause` that it can end. Returns how many ended
/// and the Chats of the agents that were working in them. What the runs ask of the
/// rest of the Workspace (the inbox, the answered runs) is done once, after them all,
/// so ending many runs does not scan the Workspace for each one.
pub(crate) fn end_each(
    connection: &Connection,
    ids: &[String],
    cause: Cause,
) -> Result<(usize, Vec<String>), Error> {
    let mut count = 0;
    let mut chats = Vec::new();
    let mut reactions = Reactions::default();
    for id in ids {
        if let Some(ended) = end_without_reacting(connection, id, cause, &mut reactions)? {
            count += 1;
            chats.extend(ended.chats);
        }
    }
    reactions.apply(connection)?;
    Ok((count, chats))
}
