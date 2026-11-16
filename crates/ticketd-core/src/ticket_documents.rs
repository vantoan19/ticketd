//! Explicit ticket-to-Document references: the Documents a person attached to a ticket's
//! context without writing them into its description.

use rusqlite::{Connection, params};

use crate::{Error, Ticket, Workspace};

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS ticket_documents (ticket_id TEXT NOT NULL REFERENCES tickets(id), document_id TEXT NOT NULL REFERENCES documents(id), PRIMARY KEY(ticket_id, document_id));
         CREATE INDEX IF NOT EXISTS ticket_documents_by_document ON ticket_documents(document_id, ticket_id);",
    )?;
    // Re-create the change token triggers so the new table moves the token.
    crate::change_token::migrate(tx)?;
    tx.execute_batch("PRAGMA user_version = 46;")?;
    Ok(())
}

impl Workspace {
    /// Add (`present`) or remove an explicit reference from a ticket to a Document.
    /// Adding is idempotent; removing a reference that is not there is not an error.
    /// A Document mentioned in the ticket's description stays mentioned.
    pub fn set_ticket_document(
        &mut self,
        reference: &str,
        document_id: &str,
        present: bool,
    ) -> Result<Ticket, Error> {
        crate::write_scope::run(&self.connection, |tx| {
            // Detaching a Document is allowed from a ticket in Trash; attaching one is not.
            let ticket_id = if present {
                tx.editable(reference)?
            } else {
                tx.even_if_trashed(reference)?
            };
            if present {
                let trashed: Option<bool> = rusqlite::OptionalExtension::optional(tx.query_row(
                    "SELECT trashed FROM documents WHERE id = ?1",
                    [document_id],
                    |row| row.get(0),
                ))?;
                match trashed {
                    None => return Err(Error::NotFound(document_id.to_owned())),
                    Some(true) => return Err(Error::DocumentTrashed(document_id.to_owned())),
                    Some(false) => {}
                }
                tx.execute(
                "INSERT OR IGNORE INTO ticket_documents(ticket_id, document_id) VALUES (?1, ?2)",
                params![ticket_id, document_id],
            )?;
                // Attaching Activity details is a decision to keep them as a Document.
                tx.execute("UPDATE documents SET kept = 1 WHERE id = ?1", [document_id])?;
            } else {
                tx.execute(
                    "DELETE FROM ticket_documents WHERE ticket_id = ?1 AND document_id = ?2",
                    params![ticket_id, document_id],
                )?;
            }
            crate::read_ticket(tx, reference)
        })
    }
}
