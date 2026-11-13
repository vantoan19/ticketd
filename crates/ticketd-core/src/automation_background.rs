//! What keeps Automations going on this device: how many runs execute at once,
//! whether any Automation is on (the desktop stays in the tray while one is), and
//! switching one off together with its active runs. None of it synchronizes.

use rusqlite::{Connection, params};

use crate::{Error, Workspace};

/// The most runs the setting allows. Each one is an agent process on this computer.
const MOST_RUNS_AT_ONCE: usize = 10;
/// Why a run ended when its Automation was switched off with "Stop it and turn off".
const TURNED_OFF: &str = "You stopped this run when you turned the Automation off.";
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS automation_settings (id INTEGER PRIMARY KEY CHECK(id = 1), runs_at_once INTEGER NOT NULL CHECK(runs_at_once > 0));
         INSERT OR IGNORE INTO automation_settings VALUES (1, 2);
         PRAGMA user_version = 72;",
    )?;
    Ok(())
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
        if !(1..=MOST_RUNS_AT_ONCE).contains(&runs) {
            return Err(Error::AutomationRun(format!(
                "runs at once must be between 1 and {MOST_RUNS_AT_ONCE}"
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
        const ACTIVE: &str = "SELECT id FROM automation_runs WHERE automation_id = ?1 AND status IN ('queued', 'running')";
        let chats = {
            let mut statement = transaction.prepare(&format!(
                "SELECT chat_id FROM automation_run_steps WHERE status = 'running' AND chat_id IS NOT NULL AND run_id IN ({ACTIVE})"
            ))?;
            statement
                .query_map([id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?
        };
        // Steps first: afterwards the runs are no longer active to find them by.
        transaction.execute(
            &format!("UPDATE automation_run_steps SET status = 'failed', reason = ?2, ended_at = {NOW} WHERE status = 'running' AND run_id IN ({ACTIVE})"),
            params![id, TURNED_OFF],
        )?;
        transaction.execute(
            &format!("UPDATE automation_runs SET status = 'needs_attention', reason = ?2, ended_at = {NOW} WHERE automation_id = ?1 AND status IN ('queued', 'running')"),
            params![id, TURNED_OFF],
        )?;
        transaction.commit()?;
        Ok(chats)
    }
}
