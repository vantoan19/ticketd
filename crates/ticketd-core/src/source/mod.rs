//! Ticket sources: the connector contract, the engine that runs connectors,
//! and the persisted source configuration.
//!
//! Layering, outermost last:
//! - [`contract`]: provider-neutral types and the [`Connector`] trait.
//! - [`schema`]: configuration fields, selectors and validation.
//! - [`engine`]: runs connectors, pages, bounds and de-duplicates.
//! - [`github`]: the built-in connector and its HTTP transport.
//! - this module: `Workspace` workflows that persist configuration. They call
//!   the engine first and write in one short transaction afterwards, so no
//!   network I/O ever happens while the database is locked.

pub mod contract;
mod conversation;
pub mod engine;
pub mod github;
pub mod schema;
mod tracking;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use contract::{
    CONTRACT_VERSION, Capability, ClosureReason, ConnectionInfo, Connector, ConnectorDescriptor,
    Conversation, DiscoveryPage, DiscoveryRequest, ExternalComment, ExternalEvent,
    ExternalEventKind, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState, PublishRequest,
    SourceError,
};
pub use conversation::ConversationEntry;
pub use engine::{DiscoveryPreview, DiscoverySummary, Engine, PreviewIssue};
pub use schema::{
    ChoiceOption, ConfigSchema, ConfigValues, FieldIssue, FieldKind, OptionSource, SchemaField,
    ValueFormat,
};
pub(crate) use tracking::duplicate_target;
pub use tracking::{
    DuplicateTarget, Origin, Ownership, RefreshFailure, RefreshOptions, RefreshReport,
    SourceCounts, SourceFailure, SourceFilter, TargetProblem, TicketSource,
};

use crate::{Error, Workspace, transaction_write_lock};

/// A source's validated configuration as saved in the workspace.
///
/// Saving a source records only how to discover issues. It does not import
/// tickets and holds no credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedSource {
    pub provider: String,
    pub config: ConfigValues,
    /// The account the connection was validated as when the configuration was saved.
    pub account: String,
    pub saved_at: String,
}

/// The result of saving: what was stored and the discovery preview it was
/// validated against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveOutcome {
    pub source: SavedSource,
    pub preview: DiscoveryPreview,
}

pub(crate) fn migrate(connection: &rusqlite::Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE source_configurations (provider TEXT PRIMARY KEY, configuration TEXT NOT NULL, account TEXT NOT NULL, contract_version INTEGER NOT NULL, saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))); PRAGMA user_version = 22;",
    )?;
    Ok(())
}

/// Step 23: external identity, ownership and synchronization state.
pub(crate) fn migrate_tracking(connection: &rusqlite::Connection) -> Result<(), Error> {
    tracking::migrate(connection)
}

/// Step 24: retrieved source comments and timeline events.
pub(crate) fn migrate_conversation(connection: &rusqlite::Connection) -> Result<(), Error> {
    conversation::migrate(connection)
}

pub(crate) use conversation::load as conversation_entries;
pub(crate) use tracking::{guard_change, guard_duplicate, populate};

impl Workspace {
    /// The saved configuration for `provider`, if one was saved.
    pub fn saved_source(&self, provider: &str) -> Result<Option<SavedSource>, Error> {
        let row = self
            .connection
            .query_row(
                "SELECT provider, configuration, account, saved_at FROM source_configurations WHERE provider = ?1",
                [provider],
                row_parts,
            )
            .optional()?;
        row.map(into_saved).transpose()
    }

    pub fn saved_sources(&self) -> Result<Vec<SavedSource>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT provider, configuration, account, saved_at FROM source_configurations ORDER BY provider",
        )?;
        let rows = statement
            .query_map([], row_parts)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(into_saved).collect()
    }

    /// Validates `raw`, previews discovery against the provider, and only then
    /// saves the configuration. A configuration that cannot be validated or
    /// previewed (bad fields, failed credentials, provider outage) is not
    /// saved, and an existing saved configuration is left untouched. An empty
    /// preview is valid and saves.
    pub fn save_source(
        &mut self,
        engine: &Engine,
        provider: &str,
        raw: &ConfigValues,
    ) -> Result<SaveOutcome, Error> {
        let config = engine.validate(provider, raw)?;
        let preview = engine.preview(provider, &config)?;
        let configuration = serde_json::to_string(&config)?;
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        transaction.execute(
            "INSERT INTO source_configurations (provider, configuration, account, contract_version) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(provider) DO UPDATE SET configuration = excluded.configuration, account = excluded.account, contract_version = excluded.contract_version, saved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![provider, configuration, preview.account, CONTRACT_VERSION],
        )?;
        let row = transaction.query_row(
            "SELECT provider, configuration, account, saved_at FROM source_configurations WHERE provider = ?1",
            [provider],
            row_parts,
        )?;
        transaction.commit()?;
        Ok(SaveOutcome {
            source: into_saved(row)?,
            preview,
        })
    }
}

fn row_parts(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String, String)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

fn into_saved(
    (provider, configuration, account, saved_at): (String, String, String, String),
) -> Result<SavedSource, Error> {
    Ok(SavedSource {
        provider,
        config: serde_json::from_str(&configuration)?,
        account,
        saved_at,
    })
}
