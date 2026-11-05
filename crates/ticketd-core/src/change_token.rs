use crate::{Error, Workspace};
use rusqlite::Connection;

/// Tables that change nothing a view shows, or change on every read or background
/// tick, so they must not move the workspace change token.
fn is_untracked(table: &str) -> bool {
    table.starts_with("sqlite_")
        || table == "workspace_changes"
        || table == "request_outcomes"
        || table == "last_backup"
        || table == "document_opens"
        // Full-text index tables are derived from the tables they index.
        || table.contains("_fts")
}

/// One counter, bumped by a trigger after every insert, update or delete of the
/// tables views show. Pollers compare it instead of refetching their data.
pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_changes (id INTEGER PRIMARY KEY CHECK (id = 1), token INTEGER NOT NULL);
         INSERT OR IGNORE INTO workspace_changes (id, token) VALUES (1, 0);",
    )?;
    let mut statement =
        connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for table in tables.iter().filter(|table| !is_untracked(table)) {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            connection.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS workspace_change_{table}_{event} AFTER {event} ON \"{table}\" BEGIN UPDATE workspace_changes SET token = token + 1 WHERE id = 1; END;"
            ))?;
        }
    }
    connection.execute_batch("PRAGMA user_version = 45;")?;
    Ok(())
}

impl Workspace {
    /// A number that changes whenever any ticket, Document, Activity, plan,
    /// relationship, inbox entry or other shown data changes, and otherwise stays put.
    /// Due reminders are delivered first so a reminder that just came due moves it.
    pub fn change_token(&self) -> Result<i64, Error> {
        self.deliver_due_reminders()?;
        Ok(self.connection.query_row(
            "SELECT token FROM workspace_changes WHERE id = 1",
            [],
            |row| row.get(0),
        )?)
    }
}
