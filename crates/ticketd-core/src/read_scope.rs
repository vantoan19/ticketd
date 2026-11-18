//! The read scope: the one place that runs a Workspace read, beside the write scope.
//!
//! A read of several statements runs them in one deferred transaction. It sees one
//! snapshot, and it takes SQLite's shared lock once instead of once per statement, which
//! is most of what a statement costs outside a transaction. It never takes the write lock,
//! so it does not wait behind a writer that has not yet started to commit.
//!
//! A read inside a transaction already under way (a write reading back its result, or
//! reads combined with [`Workspace::read`]) is part of that transaction's snapshot and
//! runs as it is.

use rusqlite::Connection;

use crate::{Error, Workspace};

/// Run `read` in a read scope on `connection`.
pub(crate) fn run<T>(
    connection: &Connection,
    read: impl FnOnce(&Connection) -> Result<T, Error>,
) -> Result<T, Error> {
    if !connection.is_autocommit() {
        return read(connection);
    }
    connection.execute_batch("BEGIN DEFERRED")?;
    match read(connection) {
        Ok(value) => match connection.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                Err(error.into())
            }
        },
        Err(error) => {
            // The read's own error is the one worth reporting.
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

impl Workspace {
    /// Run several reads in one snapshot: each read inside sees the Workspace as it was
    /// when the first one began.
    pub fn read<T>(&self, read: impl FnOnce(&Workspace) -> Result<T, Error>) -> Result<T, Error> {
        run(&self.connection, |_| read(self))
    }
}
