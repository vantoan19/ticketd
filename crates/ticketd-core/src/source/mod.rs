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

mod contract;
mod conversation;
mod engine;
mod freshness;
mod github;
mod publication;
mod schedule;
mod schema;
mod takeover;
mod tracking;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use contract::{
    CONTRACT_VERSION, Capability, ClosureReason, ConnectionInfo, Connector, ConnectorDescriptor,
    Conversation, DiscoveryPage, DiscoveryRequest, ExternalComment, ExternalEvent,
    ExternalEventKind, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState,
    PublicationCandidates, PublicationSearch, PublishRequest, SkippedPartition, SourceError,
};
pub use conversation::ConversationEntry;
pub use engine::{DiscoveryPreview, DiscoverySummary, Engine, PreviewIssue};
pub use freshness::{SourceHealth, SourceStatus, SourceUnavailable};
pub use publication::{
    ActionKind, AttemptState, CandidateReason, ContentDifference, Eligibility, IneligibleReason,
    PublicationAttachmentLink, PublicationAttempt, PublicationCandidate, PublicationError,
    PublicationLocalData, PublicationPreview, PublicationReview, PublishOptions, PublishOutcome,
    PublishedIssue, Resolution, ResolutionAction, ResolveOptions,
};
pub use schedule::{Clock, RefreshCoordinator, RefreshPolicy, Run, Skip, SystemClock};
pub use schema::{
    ChoiceOption, ConfigSchema, ConfigValues, FieldIssue, FieldKind, OptionSource, SchemaField,
    ValueFormat,
};
pub(crate) use tracking::duplicate_target;
pub use tracking::{
    DuplicateTarget, FailureScope, Origin, Ownership, RefreshFailure, RefreshOptions,
    RefreshReport, SourceCounts, SourceFailure, SourceFilter, TargetProblem, TicketSource,
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

pub(crate) use conversation::present as conversation_entries;

/// Step 25: failure streaks and per-source status.
pub(crate) fn migrate_freshness(connection: &rusqlite::Connection) -> Result<(), Error> {
    freshness::migrate(connection)
}

/// Step 29: preserve the count belonging to the last accepted provider run.
pub(crate) fn migrate_run_counts(connection: &rusqlite::Connection) -> Result<(), Error> {
    freshness::migrate_run_counts(connection)
}

/// Step 26: publication attempts.
pub(crate) fn migrate_publication(connection: &rusqlite::Connection) -> Result<(), Error> {
    publication::migrate(connection)
}

/// How a provider and one of its issues are named for people: the provider's
/// display name, where the issue lives and its short number. The locator is the
/// connector's own, so the splitting belongs with the connector's module.
pub(crate) fn display_parts(
    provider: &str,
    locator: &str,
    display: &str,
) -> (String, String, String) {
    match provider {
        github::PROVIDER => {
            let (place, number) = locator
                .rsplit_once('#')
                .map_or((locator, ""), |(place, number)| (place, number));
            (
                github::DISPLAY_NAME.to_owned(),
                place.to_owned(),
                if number.is_empty() {
                    String::new()
                } else {
                    format!("#{number}")
                },
            )
        }
        other => (other.to_owned(), String::new(), display.to_owned()),
    }
}

/// What a person calls a provider: its display name where it has one.
pub(crate) fn provider_display_name(provider: &str) -> String {
    display_parts(provider, "", "").0
}

/// The effective "now" of a write: the caller's RFC 3339 time when given, else the
/// database clock. Every source workflow reads time through this one function.
pub(crate) fn clock(connection: &rusqlite::Connection, now: Option<&str>) -> Result<String, Error> {
    Ok(match now {
        Some(now) => now.to_owned(),
        None => connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })?,
    })
}

/// Step 27: conversation read failures kept apart from refresh failures, the
/// skipped-repository note of a source run, and the link and certainty of an
/// external duplicate target. Each column is added only when missing, so a
/// workspace reopened after its tables were rebuilt still migrates.
pub(crate) fn migrate_details(connection: &rusqlite::Connection) -> Result<(), Error> {
    for (table, column, definition) in [
        ("source_sync", "conversation_error_code", "TEXT"),
        ("source_sync", "conversation_error_message", "TEXT"),
        ("source_status", "partial_message", "TEXT"),
        ("external_duplicate_targets", "url", "TEXT"),
        (
            "external_duplicate_targets",
            "last_known",
            "INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !present {
            connection.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    connection.execute_batch("PRAGMA user_version = 27;")?;
    Ok(())
}

pub(crate) use tracking::{closure_held, guard_change, guard_duplicate, held_sql};

/// Fills the ticket's external side and any blocking publication attempt.
pub(crate) fn populate(
    connection: &rusqlite::Connection,
    ticket: &mut crate::Ticket,
) -> Result<(), Error> {
    tracking::populate(connection, ticket)?;
    publication::populate(connection, ticket)
}

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

    /// Previews discovery against the workspace's stable external identities.
    /// Retained identities and trashed tickets are already here as well.
    pub fn preview_source(
        &self,
        engine: &Engine,
        provider: &str,
        raw: &ConfigValues,
    ) -> Result<DiscoveryPreview, Error> {
        let mut statement = self.connection.prepare("SELECT i.external_id, t.reference FROM external_identities i JOIN tickets t ON t.id = i.ticket_id WHERE i.provider = ?1")?;
        let known = statement
            .query_map([provider], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        Ok(engine.preview_with(provider, raw, |identity| known.get(&identity.id).cloned())?)
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
        let preview = self.preview_source(engine, provider, &config)?;
        let configuration = serde_json::to_string(&config)?;
        let transaction = self.connection.savepoint()?;
        transaction_write_lock(&transaction)?;
        let previous: Option<String> = transaction
            .query_row(
                "SELECT configuration FROM source_configurations WHERE provider = ?1",
                [provider],
                |row| row.get(0),
            )
            .optional()?;
        let previous = previous
            .map(|raw| serde_json::from_str::<ConfigValues>(&raw))
            .transpose()?;
        if previous.as_ref() != Some(&config) {
            transaction.execute("UPDATE source_sync SET discovery_matches = NULL WHERE ticket_id IN (SELECT i.ticket_id FROM external_identities i JOIN external_ownership o ON o.ticket_id = i.ticket_id WHERE i.provider = ?1 AND o.authority = 'external')", [provider])?;
        }
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
