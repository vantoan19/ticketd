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

#[cfg(test)]
mod conformance;
mod contract;
mod conversation;
mod engine;
mod freshness;
mod github;
mod presentation;
mod publication;
mod schedule;
mod schema;
mod takeover;
mod tracking;

use std::borrow::Cow;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use contract::{
    CONTRACT_VERSION, Capability, ClosureReason, ConnectionCheck, ConnectionInfo, Connector,
    ConnectorDescriptor, Conversation, DerivedConfiguration, DestinationRules,
    DestinationValidation, DiscoveryPage, DiscoveryRequest, ErrorClass, ExternalComment,
    ExternalEvent, ExternalEventKind, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState,
    Publication, PublicationCandidates, PublicationSearch, PublishRequest, SkippedPartition,
    SourceError, Surface,
};
pub use conversation::ConversationEntry;
pub use engine::{DiscoveryPreview, DiscoverySummary, Engine, PreviewIssue};
pub use freshness::{SourceHealth, SourceStatus, SourceUnavailable};
pub use presentation::{
    FieldPresentation, IssueName, PullRequestLink, SignInGuidance, SourceDescription,
    SourcePresentation, SummaryPart, TargetPresentation,
};
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
    RefreshReport, SourceAvailability, SourceCounts, SourceFailure, SourceFilter, TargetProblem,
    TicketSource,
};

use crate::{Error, Workspace};

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
        "CREATE TABLE source_configurations (provider TEXT PRIMARY KEY, configuration TEXT NOT NULL, account TEXT NOT NULL, contract_version INTEGER NOT NULL, saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));",
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

/// Format version 85: who opened each tracked issue at the source, and when.
pub(crate) fn migrate_issue_opening(connection: &rusqlite::Connection) -> Result<(), Error> {
    tracking::migrate_issue_opening(connection)
}

/// Format version 82: the parts of each source that have been read.
pub(crate) fn migrate_read_partitions(connection: &rusqlite::Connection) -> Result<(), Error> {
    freshness::migrate_read_partitions(connection)
}

/// Step 29: preserve the count belonging to the last accepted provider run.
pub(crate) fn migrate_run_counts(connection: &rusqlite::Connection) -> Result<(), Error> {
    freshness::migrate_run_counts(connection)
}

/// Step 26: publication attempts.
pub(crate) fn migrate_publication(connection: &rusqlite::Connection) -> Result<(), Error> {
    publication::migrate(connection)
}

/// Format version 86: device-local presentation cached from registered sources.
pub(crate) fn migrate_presentations(connection: &rusqlite::Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS source_presentations (provider TEXT PRIMARY KEY, description TEXT NOT NULL);",
    )?;
    Ok(())
}

/// Format version 87: derived answers from source connection checks and the
/// part carried in each observed issue reference.
pub(crate) fn migrate_contract_data(connection: &Connection) -> Result<(), Error> {
    for (table, column, definition) in [
        ("source_configurations", "derived_configuration", "TEXT"),
        (
            "source_configurations",
            "revision",
            "TEXT NOT NULL DEFAULT ''",
        ),
        ("source_configurations", "derived_checked_at", "TEXT"),
        ("external_identities", "partition", "TEXT"),
        ("publication_attempts", "partition", "TEXT"),
    ] {
        crate::format::add_column_if_missing(connection, table, column, definition)?;
    }
    Ok(())
}

/// Older Workspace sync files carry the locator but no part. GitHub was the
/// only source that could create them and its locator names the repository.
pub(crate) fn legacy_reference_partition(provider: &str, locator: &str) -> String {
    github::legacy_reference_partition(provider, locator).unwrap_or_default()
}

/// Describes a provider from the device-local cache, or its built-in
/// registration when the cache has never been filled.
pub(crate) fn cached_description(
    connection: &rusqlite::Connection,
    provider: &str,
) -> Result<Option<Cow<'static, SourceDescription>>, Error> {
    let raw: Option<String> = connection
        .prepare_cached("SELECT description FROM source_presentations WHERE provider = ?1")?
        .query_row([provider], |row| row.get(0))
        .optional()?;
    match raw {
        Some(raw) => Ok(Some(Cow::Owned(serde_json::from_str(&raw)?))),
        None => Ok(Engine::builtin_description(provider).map(Cow::Borrowed)),
    }
}

pub(crate) fn display_parts(
    description: Option<&SourceDescription>,
    provider: &str,
    locator: &str,
    display: &str,
) -> (String, String, String, String) {
    let Some(description) = description else {
        return (
            provider.to_owned(),
            String::new(),
            display.to_owned(),
            String::new(),
        );
    };
    let naming = &description.presentation.issue_name;
    let (place, number) = naming.parts(locator, display);
    let place_label = naming.place_label(&place);
    (
        description.descriptor.name.clone(),
        place,
        number,
        place_label,
    )
}

/// What a person calls a provider: its display name where it has one.
pub(crate) fn provider_display_name(
    connection: &rusqlite::Connection,
    provider: &str,
) -> Result<String, Error> {
    Ok(cached_description(connection, provider)?.map_or_else(
        || provider.to_owned(),
        |description| description.descriptor.name.clone(),
    ))
}

/// The effective "now" of a write: the caller's RFC 3339 time when given, else the
/// database clock. Every source workflow reads time through this one function.
pub(crate) fn clock(connection: &rusqlite::Connection, now: Option<&str>) -> Result<String, Error> {
    Ok(match now {
        Some(now) => now.to_owned(),
        None => connection
            .prepare_cached("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')")?
            .query_row([], |row| row.get(0))?,
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
    Ok(())
}

pub(crate) use tracking::{availability_projection, guard_change, guard_duplicate, held_sql};

/// Fills the external side of a ticket that has one.
pub(crate) fn populate_tracking(
    connection: &rusqlite::Connection,
    ticket: &mut crate::Ticket,
) -> Result<(), Error> {
    tracking::populate(connection, ticket)
}

/// Fills the publication attempt that blocks publishing a ticket, if any.
pub(crate) fn populate_publication(
    connection: &rusqlite::Connection,
    ticket: &mut crate::Ticket,
) -> Result<(), Error> {
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
        let config = engine.validate(provider, raw)?;
        self.preview_source_with_config(engine, provider, &config)
            .map(|(preview, _)| preview)
    }

    fn preview_source_with_config(
        &self,
        engine: &Engine,
        provider: &str,
        config: &ConfigValues,
    ) -> Result<(DiscoveryPreview, DerivedConfiguration), Error> {
        let mut statement = self.connection.prepare("SELECT i.external_id, t.reference FROM external_identities i JOIN tickets t ON t.id = i.ticket_id WHERE i.provider = ?1")?;
        let known = statement
            .query_map([provider], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        Ok(engine.preview_with(provider, config, |identity| {
            known.get(&identity.id).cloned()
        })?)
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
        let (preview, derived) = self.preview_source_with_config(engine, provider, &config)?;
        let configuration = serde_json::to_string(&config)?;
        let derived_configuration = serde_json::to_string(&derived)?;
        let revision = uuid::Uuid::new_v4().to_string();
        let description = serde_json::to_string(&engine.description(provider)?)?;
        crate::write_scope::run(&self.connection, |transaction| {
            let previous = configured_source(transaction, provider)?;
            if previous.is_none_or(|previous| {
                previous.saved.config != config || !same_discovery(&previous.derived, &derived)
            }) {
                clear_discovery_matches(transaction, provider)?;
            }
            transaction.execute(
            "INSERT INTO source_configurations (provider, configuration, account, contract_version, derived_configuration, revision) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(provider) DO UPDATE SET configuration = excluded.configuration, \
             account = excluded.account, contract_version = excluded.contract_version, saved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
             derived_configuration = excluded.derived_configuration, revision = excluded.revision, derived_checked_at = NULL",
            params![provider, configuration, preview.account, CONTRACT_VERSION, derived_configuration, revision],
        )?;
            transaction.execute(
                "INSERT INTO source_presentations (provider, description) VALUES (?1, ?2) ON CONFLICT(provider) DO UPDATE SET description = excluded.description",
                params![provider, description],
            )?;
            let row = transaction.query_row(
            "SELECT provider, configuration, account, saved_at FROM source_configurations WHERE provider = ?1",
            [provider],
            row_parts,
        )?;
            Ok(SaveOutcome {
                source: into_saved(row)?,
                preview,
            })
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

// The public source settings omit these device-local answers and the revision
// protecting writes that took a network round trip.
struct ConfiguredSource {
    saved: SavedSource,
    derived: DerivedConfiguration,
    revision: String,
}

type SavedRow = (String, String, String, String);

const CONFIGURED_SOURCE: &str = "SELECT provider, configuration, account, saved_at, derived_configuration, revision \
     FROM source_configurations WHERE (?1 IS NULL OR provider = ?1) ORDER BY provider";

fn configured_source(
    connection: &Connection,
    provider: &str,
) -> Result<Option<ConfiguredSource>, Error> {
    connection
        .query_row(CONFIGURED_SOURCE, [provider], configured_row)
        .optional()?
        .map(into_configured)
        .transpose()
}

fn configured_sources(connection: &Connection) -> Result<Vec<ConfiguredSource>, Error> {
    let mut statement = connection.prepare(CONFIGURED_SOURCE)?;
    let rows = statement.query_map([None::<&str>], configured_row)?;
    rows.map(|row| into_configured(row?)).collect()
}

fn configured_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(SavedRow, Option<String>, String)> {
    Ok((row_parts(row)?, row.get(4)?, row.get(5)?))
}

fn into_configured(
    (row, raw, revision): (SavedRow, Option<String>, String),
) -> Result<ConfiguredSource, Error> {
    let saved = into_saved(row)?;
    let derived = match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        // GitHub's rules were calculated locally before format 87. Preserve
        // offline previews until a successful check can save the cached data.
        None => {
            github::legacy_derived_configuration(&saved.provider, &saved.config).unwrap_or_default()
        }
    };
    Ok(ConfiguredSource {
        saved,
        derived,
        revision,
    })
}

fn same_discovery(previous: &DerivedConfiguration, current: &DerivedConfiguration) -> bool {
    previous.partitions == current.partitions && previous.discovery_scope == current.discovery_scope
}

fn clear_discovery_matches(connection: &Connection, provider: &str) -> Result<(), Error> {
    connection.execute(
        "UPDATE source_sync SET discovery_matches = NULL WHERE ticket_id IN \
         (SELECT i.ticket_id FROM external_identities i JOIN external_ownership o ON o.ticket_id = i.ticket_id \
          WHERE i.provider = ?1 AND o.authority = 'external')",
        [provider],
    )?;
    Ok(())
}
