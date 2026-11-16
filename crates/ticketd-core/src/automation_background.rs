//! What keeps Automations going on this device: how many runs execute at once,
//! whether any Automation is on (the desktop stays in the tray while one is), and
//! switching one off together with its active runs. None of it synchronizes.

use rusqlite::Connection;

use crate::automation_endings::{Cause, end_each};

use crate::{Error, Workspace};

/// The most runs the setting allows. Each one is an agent process on this computer.
pub const MOST_AUTOMATION_RUNS_AT_ONCE: usize = 10;
/// How many runs execute at once until the person says otherwise.
pub const DEFAULT_AUTOMATION_RUNS_AT_ONCE: usize = 2;

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS automation_settings (id INTEGER PRIMARY KEY CHECK(id = 1), runs_at_once INTEGER NOT NULL CHECK(runs_at_once > 0));
         INSERT OR IGNORE INTO automation_settings VALUES (1, {DEFAULT_AUTOMATION_RUNS_AT_ONCE});
         PRAGMA user_version = 78;",
    ))?;
    Ok(())
}

/// Ends an Automation's Queued and Running runs for `cause`. Returns the Chats of
/// the agents that were working.
pub(crate) fn end_active_runs(
    connection: &Connection,
    automation_id: &str,
    cause: Cause,
) -> Result<Vec<String>, Error> {
    let ids = {
        let mut statement = connection.prepare(
            "SELECT id FROM automation_runs WHERE automation_id = ?1 AND status IN ('queued', 'running')",
        )?;
        statement
            .query_map([automation_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(end_each(connection, &ids, cause)?.1)
}

impl Workspace {
    /// How many Automation runs execute at once on this device. The rest wait in
    /// the queue.
    pub fn automation_runs_at_once(&self) -> Result<usize, Error> {
        Ok(self.connection.query_row(
            "SELECT runs_at_once FROM automation_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )?)
    }

    /// Applies from the next run that starts; runs already going are left alone.
    pub fn set_automation_runs_at_once(&self, runs: usize) -> Result<(), Error> {
        if !(1..=MOST_AUTOMATION_RUNS_AT_ONCE).contains(&runs) {
            return Err(Error::AutomationRun(format!(
                "runs at once must be between 1 and {MOST_AUTOMATION_RUNS_AT_ONCE}"
            )));
        }
        self.connection.execute(
            "UPDATE automation_settings SET runs_at_once = ?1 WHERE id = 1",
            [runs],
        )?;
        Ok(())
    }

    /// Whether any Automation is switched on for this device.
    pub fn any_automation_on(&self) -> Result<bool, Error> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_device_state)",
            [],
            |row| row.get(0),
        )?)
    }

    /// Switches an Automation off for this device and ends its Queued and Running
    /// runs as Needs attention, failing the step each was on: the outcome an
    /// executor reports later is refused. Returns the Chats of the agents that were
    /// working, for the host to interrupt.
    pub fn stop_and_turn_off_automation(&mut self, id: &str) -> Result<Vec<String>, Error> {
        let transaction = self.connection.savepoint()?;
        crate::transaction_write_lock(&transaction)?;
        transaction.execute(
            "DELETE FROM automation_device_state WHERE automation_id = ?1",
            [id],
        )?;
        let chats = end_active_runs(&transaction, id, Cause::TurnedOff)?;
        transaction.commit()?;
        Ok(chats)
    }
}
