//! Taking ownership of an unavailable external ticket.
//!
//! Ownership is `external_ownership.authority`; provenance is
//! `external_identities`. Taking ownership flips authority to `local` and
//! touches nothing else: the identity row stays (so discovery matches the
//! issue to this ticket instead of importing another, and ignores it), the
//! last synchronized content, status, relationships and local work stay, and
//! the failure columns of `source_sync` are cleared because the record is no
//! longer synchronized. Every refresh path re-reads authority inside its own
//! write, so a refresh that was already in flight cannot undo the decision.
//! No code path turns a `local` row back into `external` for an existing
//! identity: reconnecting needs an explicit action that does not exist yet.

use super::tracking::{Authority, authority, availability_projection};
use crate::{Error, Ticket, Workspace, history, write_scope};

impl Workspace {
    /// Makes an externally owned ticket whose source is unavailable locally
    /// owned, in one atomic write. A ticket that is already local is returned
    /// unchanged, so a repeated request is harmless.
    pub fn take_ownership(
        &mut self,
        reference: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        write_scope::run(&self.connection, |transaction| {
            let id = transaction.editable(reference)?;
            let linked: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM external_identities WHERE ticket_id = ?1)",
                [&id],
                |row| row.get(0),
            )?;
            if !linked {
                return Err(Error::AlreadyLocal(reference.to_owned()));
            }
            if let Authority::External { provider, .. } = authority(transaction, &id)? {
                let unavailable = availability_projection(transaction, &id)?
                    .is_some_and(|value| value.unavailable.is_some());
                if !unavailable {
                    return Err(Error::SourceAvailable {
                        reference: reference.to_owned(),
                        provider: super::provider_display_name(transaction, &provider)?,
                    });
                }
                transaction.execute(
                    "UPDATE external_ownership SET authority = 'local', \
                 changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ticket_id = ?1",
                    [&id],
                )?;
                transaction.execute(
                "UPDATE source_sync SET last_error_code = NULL, last_error_message = NULL, failing_since = NULL \
                 WHERE ticket_id = ?1",
                [&id],
            )?;
                transaction.execute(
                    "DELETE FROM source_connection_removals WHERE ticket_id = ?1",
                    [&id],
                )?;
                history::record(transaction, &id, "ownership", &provider, "local", agent)?;
            }
            crate::read_ticket(transaction, reference)
        })
    }
}
