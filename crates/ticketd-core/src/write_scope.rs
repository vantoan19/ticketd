//! The write scope: the one place that orders a Workspace write.
//!
//! A write that touches a ticket does the same things in the same order:
//!
//! 1. open a savepoint and take the write lock, so everything after reads what it will write;
//! 2. resolve the Ticket reference and check the ticket is editable (not in Trash);
//! 3. apply the operation's own rule;
//! 4. record history;
//! 5. fold the Workspace events of tickets the write created into one `ticket.created`;
//! 6. read the result back.
//!
//! [`run`] and [`Workspace::in_write_scope`] own steps 1 and 5 and the commit or rollback
//! around them; [`WriteScope`] answers step 2. An operation states only steps 3, 4 and 6.
//! A scope nests: a write that calls other writes (a batch, a ticket created from a
//! Document) runs them inside its own scope, and the outermost one has the last word on
//! the events.

use std::ops::Deref;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use crate::{Error, Ticket, Workspace, events, relationships, ticket_from_row};

/// A locked, open transaction in which a write reads and changes the Workspace. It derefs
/// to the connection for the operation's own queries.
pub(crate) struct WriteScope<'a> {
    connection: &'a Connection,
}

impl Deref for WriteScope<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.connection
    }
}

impl<'a> WriteScope<'a> {
    /// The scope of a write already in progress on `connection`.
    pub(crate) fn of(connection: &'a Connection) -> Self {
        Self { connection }
    }

    /// The id of the ticket to change. The ticket must exist and not be in Trash.
    pub(crate) fn editable(&self, reference: &str) -> Result<String, Error> {
        let id = relationships::id(self.connection, reference)?;
        ensure_editable(self.connection, &id)?;
        Ok(id)
    }

    /// The ticket to change, without its relationships. It must exist and not be in Trash.
    pub(crate) fn editable_ticket(&self, reference: &str) -> Result<Ticket, Error> {
        let ticket = self.ticket_even_if_trashed(reference)?;
        ensure_editable(self.connection, &ticket.id)?;
        Ok(ticket)
    }

    /// The id of a ticket that may be in Trash. Only a write that the Workspace allows on
    /// a ticket in Trash asks for this: restoring it, or detaching it from a visible
    /// ticket.
    pub(crate) fn even_if_trashed(&self, reference: &str) -> Result<String, Error> {
        relationships::id(self.connection, reference)
    }

    /// The ticket, without its relationships, whether or not it is in Trash. For a rule that
    /// must be answered before the ticket is checked for editability.
    pub(crate) fn ticket_even_if_trashed(&self, reference: &str) -> Result<Ticket, Error> {
        use rusqlite::OptionalExtension;
        self.connection
            .query_row(
                "SELECT id, reference, title, status, body, project_id, plan_id, trashed, number AS local_number FROM tickets WHERE reference = ?1",
                [reference],
                ticket_from_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(reference.to_owned()))
    }

    /// Refuse a ticket in Trash, for an id already resolved.
    pub(crate) fn ensure_editable(&self, id: &str) -> Result<(), Error> {
        ensure_editable(self.connection, id)
    }

    /// Detaching two tickets from each other is allowed while either one is visible:
    /// refuse only when both are in Trash, naming the second.
    pub(crate) fn ensure_either_editable(&self, first: &str, second: &str) -> Result<(), Error> {
        let first_trashed: bool = self.connection.query_row(
            "SELECT trashed FROM tickets WHERE id = ?1",
            [first],
            |row| row.get(0),
        )?;
        ensure_editable(self.connection, if first_trashed { second } else { first })
    }
}

/// Refuse a ticket in Trash. Every ticket mutation checks this inside its write scope.
pub(crate) fn ensure_editable(connection: &Connection, id: &str) -> Result<(), Error> {
    let (trashed, reference): (bool, String) = connection.query_row(
        "SELECT trashed, reference FROM tickets WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if trashed {
        return Err(Error::Trashed(reference));
    }
    Ok(())
}

/// Take the write lock before reading any invariant the write depends on. A savepoint
/// that is not yet inside a write transaction only begins one deferred; touching a table
/// without changing a row upgrades it to the write lock.
pub(crate) fn lock(connection: &Connection) -> Result<(), Error> {
    connection.execute("UPDATE tickets SET number = number WHERE 0", [])?;
    Ok(())
}

/// A savepoint that has been opened and locked.
struct Open {
    name: String,
    /// The Workspace event head when the scope opened: events after it are this write's.
    head: i64,
}

fn enter(connection: &Connection) -> Result<Open, Error> {
    static SCOPES: AtomicU64 = AtomicU64::new(0);
    let name = format!("write_scope_{}", SCOPES.fetch_add(1, Ordering::Relaxed));
    // rusqlite's savepoint guard borrows the connection mutably, which would keep a write
    // from calling other writes; a named savepoint nests however deeply they do.
    connection.execute_batch(&format!("SAVEPOINT {name}"))?;
    let open = Open { name, head: 0 };
    match lock(connection).and_then(|()| events::head(connection)) {
        Ok(head) => Ok(Open { head, ..open }),
        Err(error) => {
            roll_back(connection, &open);
            Err(error)
        }
    }
}

fn roll_back(connection: &Connection, open: &Open) {
    let name = &open.name;
    // The error that sent the write here is the one worth reporting.
    let _ = connection.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
}

fn leave<T>(connection: &Connection, open: Open, result: Result<T, Error>) -> Result<T, Error> {
    // A write may create a ticket and then fill it in; it counts as one creation.
    let result = result.and_then(|value| {
        events::fold_into_creation(connection, open.head)?;
        Ok(value)
    });
    match result {
        Ok(value) => {
            if let Err(error) = connection.execute_batch(&format!("RELEASE {}", open.name)) {
                roll_back(connection, &open);
                return Err(error.into());
            }
            Ok(value)
        }
        Err(error) => {
            roll_back(connection, &open);
            Err(error)
        }
    }
}

/// Run `operation` in a write scope on `connection`: committed (released into the
/// enclosing transaction, if any) when it returns `Ok`, rolled back when it returns `Err`.
pub(crate) fn run<T>(
    connection: &Connection,
    operation: impl FnOnce(&WriteScope<'_>) -> Result<T, Error>,
) -> Result<T, Error> {
    let open = enter(connection)?;
    let result = operation(&WriteScope::of(connection));
    leave(connection, open, result)
}

impl Workspace {
    /// Like [`run`], for a write that calls other Workspace writes and so needs the whole
    /// Workspace rather than the connection.
    pub(crate) fn in_write_scope<T>(
        &mut self,
        operation: impl FnOnce(&mut Workspace) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let open = enter(&self.connection)?;
        let result = operation(self);
        leave(&self.connection, open, result)
    }
}
