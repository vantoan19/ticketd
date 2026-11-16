//! The device code and counter that make Ticket references unique across the desktops
//! sharing a Workspace: `T-` + two uppercase letters + this device's counter (`T-KQ43`).
//! The reference is a stored label; a ticket's GUID stays its identity.
use rusqlite::Connection;
use uuid::Uuid;

use crate::{Error, Workspace};

fn random_code() -> String {
    // The first two bytes of a version 4 UUID are entirely random.
    Uuid::new_v4().as_bytes()[..2]
        .iter()
        .map(|byte| char::from(b'A' + byte % 26))
        .collect()
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    // Automated tests fix the code so the references they assert are stable. Only the
    // crates' dev-dependencies turn this feature on, so no built application has it.
    let code = if cfg!(feature = "test-device-code") {
        "KQ".to_owned()
    } else {
        random_code()
    };
    let has_column = |table: &str, column: &str| {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get::<_, bool>(0),
        )
    };
    // A mention index keyed by the old numeric reference cannot hold a device reference.
    // Old numeric mentions are not carried over: no released Workspace has any.
    if has_column("numeric_mentions", "number")? {
        tx.execute_batch("DROP TABLE numeric_mentions; DROP TABLE activity_graph_numbers;")?;
        tx.execute_batch(crate::document_links::MENTION_INDEX_SCHEMA)?;
    }
    // Tests re-run this step on a current Workspace by rewinding its format version.
    if !has_column("tickets", "reference")? {
        tx.execute_batch(
            "CREATE TABLE device (id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, issued INTEGER NOT NULL);
            ALTER TABLE tickets ADD COLUMN reference TEXT NOT NULL DEFAULT '';",
        )?;
        tx.execute(
            "INSERT INTO device (id, code, issued) SELECT 1, ?1, COALESCE(MAX(number), 0) FROM tickets",
            [&code],
        )?;
        tx.execute(
            "UPDATE tickets SET reference = 'T-' || ?1 || number",
            [&code],
        )?;
        tx.execute_batch("CREATE UNIQUE INDEX tickets_reference ON tickets(reference);")?;
    }
    Ok(())
}

/// The reference for a ticket being created. Call inside the transaction that inserts it.
pub(crate) fn issue_reference(tx: &Connection) -> Result<String, Error> {
    Ok(tx.query_row(
        "UPDATE device SET issued = issued + 1 RETURNING 'T-' || code || issued",
        [],
        |row| row.get(0),
    )?)
}

/// Replace the device code with one this Workspace has never used. The counter carries on,
/// so a reference issued under an earlier code is never issued again.
pub(crate) fn renew_code(connection: &Connection) -> Result<String, Error> {
    loop {
        let code = random_code();
        let used: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM device WHERE code = ?1) OR EXISTS(SELECT 1 FROM tickets WHERE reference GLOB 'T-' || ?1 || '[0-9]*')",
            [&code],
            |row| row.get(0),
        )?;
        if !used {
            connection.execute("UPDATE device SET code = ?1", [&code])?;
            return Ok(code);
        }
    }
}

impl Workspace {
    /// The two-letter code in the references of tickets created on this device.
    pub fn device_code(&self) -> Result<String, Error> {
        Ok(self
            .connection
            .query_row("SELECT code FROM device", [], |row| row.get(0))?)
    }

    /// Give this Workspace a fresh device code, for a copy that now lives on another device
    /// or whose code another device already holds. Issued references do not change.
    pub fn renew_device_code(&mut self) -> Result<String, Error> {
        renew_code(&self.connection)
    }
}
