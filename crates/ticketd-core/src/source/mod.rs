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
    CONTRACT_VERSION, Capability, ConnectionCheck, ConnectionInfo, Connector, ConnectorDescriptor,
    Conversation, DerivedConfiguration, DestinationRules, DestinationValidation, DiscoveryPage,
    DiscoveryRequest, ErrorClass, ExternalComment, ExternalEvent, ExternalEventKind,
    ExternalIdentity, ExternalIssue, ExternalRef, ExternalState, Publication,
    PublicationCandidates, PublicationSearch, PublishRequest, SkippedPartition, SourceError,
    StateCategory, Surface,
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
    ChoiceOption, ConfigSchema, ConfigValues, FieldIssue, FieldKind, FieldPattern, OptionSource,
    SchemaField, ValueFormat,
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
    pub id: String,
    pub name: String,
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
        if table == "source_configurations" && !crate::backup::table_exists(connection, table)? {
            continue;
        }
        crate::format::add_column_if_missing(connection, table, column, definition)?;
    }
    Ok(())
}

/// Device-local connection settings, affinity and connection-specific refresh state.
pub(crate) fn migrate_connections(connection: &Connection) -> Result<(), Error> {
    if crate::backup::table_exists(connection, "source_connections")? {
        return Ok(());
    }
    connection.execute_batch(
        "CREATE TABLE source_connections (
             id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, site TEXT NOT NULL,
             configuration TEXT NOT NULL, account TEXT NOT NULL, account_key TEXT NOT NULL,
             contract_version INTEGER NOT NULL, saved_at TEXT NOT NULL, derived_configuration TEXT,
             revision TEXT NOT NULL, derived_checked_at TEXT,
             UNIQUE(provider, site, account_key)
         );
         CREATE TABLE source_connection_status (
             connection_id TEXT PRIMARY KEY REFERENCES source_connections(id) ON DELETE CASCADE,
             last_attempt_at TEXT, last_refreshed_at TEXT, error_code TEXT, error_message TEXT,
             failing_since TEXT, retry_after TEXT, partial_message TEXT, last_checked_tickets INTEGER,
             read_partitions TEXT
         );
         CREATE TABLE source_connection_tickets (
             ticket_id TEXT PRIMARY KEY REFERENCES external_identities(ticket_id) ON DELETE CASCADE,
             connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE
         );
         CREATE INDEX source_connection_tickets_by_connection ON source_connection_tickets(connection_id);
         CREATE TABLE publication_connections (
             attempt_id TEXT PRIMARY KEY REFERENCES publication_attempts(id) ON DELETE CASCADE,
             connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE
         );",
    )?;
    let mut old = connection.prepare(
        "SELECT provider FROM source_configurations ORDER BY provider <> 'github', provider",
    )?;
    let providers = old
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(old);
    for provider in providers {
        let id = next_connection_id(connection, &provider)?;
        let name = provider_display_name(connection, &provider)?;
        connection.execute(
            "INSERT INTO source_connections
                (id, name, provider, site, configuration, account, account_key,
                 contract_version, saved_at, derived_configuration, revision, derived_checked_at)
             SELECT ?2, ?3, provider, '', configuration, account,
                 CASE WHEN provider = 'github' THEN lower(account) ELSE account END,
                 contract_version, saved_at, derived_configuration, revision, derived_checked_at
             FROM source_configurations WHERE provider = ?1",
            params![provider, id, name],
        )?;
        connection.execute(
            "INSERT INTO source_connection_status
             SELECT ?2, last_attempt_at, last_refreshed_at, error_code, error_message,
                    failing_since, retry_after, partial_message, last_checked_tickets, read_partitions
             FROM source_status WHERE provider = ?1",
            params![provider, id],
        )?;
        connection.execute(
            "INSERT INTO source_connection_tickets
             SELECT ticket_id, ?2 FROM external_identities WHERE provider = ?1",
            params![provider, id],
        )?;
        connection.execute(
            "INSERT INTO publication_connections
             SELECT a.id, ?2 FROM publication_attempts a
             JOIN source_configurations c ON c.provider = a.provider
             WHERE a.provider = ?1 AND a.status IN ('in_flight', 'unresolved')
               AND julianday(c.saved_at) <= julianday(a.started_at)",
            params![provider, id],
        )?;
    }
    connection.execute_batch("DROP TABLE source_configurations")?;
    for table in [
        "source_connections",
        "source_connection_status",
        "source_connection_tickets",
    ] {
        crate::change_token::track(connection, table)?;
    }
    Ok(())
}

/// Format version 88: preserve the last typed observation and source label
/// independently of the local ticket's status and workflow history.
pub(crate) fn migrate_state_categories(connection: &rusqlite::Connection) -> Result<(), Error> {
    let legacy: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('source_sync') WHERE name = 'external_state')",
        [],
        |row| row.get(0),
    )?;
    if !legacy {
        return Ok(());
    }
    connection.execute_batch(
        "ALTER TABLE source_sync ADD COLUMN state_category TEXT NOT NULL DEFAULT 'unknown'
             CHECK (state_category IN ('open', 'completed', 'not_planned', 'duplicate', 'unknown'));
         ALTER TABLE source_sync ADD COLUMN state_name TEXT;
         UPDATE source_sync SET state_category = CASE
             WHEN external_state = 'open' THEN 'open'
             WHEN closure_reason IN ('completed', 'not_planned', 'duplicate') THEN closure_reason
             ELSE 'unknown' END,
             state_name = CASE (SELECT provider FROM external_identities i WHERE i.ticket_id = source_sync.ticket_id)
                 WHEN 'github' THEN CASE external_state WHEN 'open' THEN 'Open' ELSE 'Closed' END
             END;
         ALTER TABLE source_sync DROP COLUMN closure_reason;
         ALTER TABLE source_sync DROP COLUMN external_state;",
    )?;
    let legacy: Vec<(String, String)> = connection
        .prepare("SELECT ticket_id, locator FROM external_identities WHERE provider = 'github' AND partition IS NULL")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, locator) in legacy {
        if let Some(partition) = github::legacy_reference_partition("github", &locator) {
            connection.execute(
                "UPDATE external_identities SET partition = ?2 WHERE ticket_id = ?1",
                rusqlite::params![id, partition],
            )?;
        }
    }
    conversation::migrate_state_categories(connection)
}

/// Older Workspace sync files carry the locator but no part. GitHub was the
/// only source that could create them and its locator names the repository.
pub(crate) fn legacy_reference_partition(provider: &str, locator: &str) -> Option<String> {
    github::legacy_reference_partition(provider, locator)
}

/// Convert the state tuple saved before typed categories and display names.
pub(crate) fn legacy_state(provider: &str, state: &str, reason: Option<&str>) -> ExternalState {
    let category = if state == "open" {
        StateCategory::Open
    } else {
        StateCategory::from_closure(reason)
    };
    ExternalState {
        category,
        name: github::legacy_state_name(provider, state).map(str::to_owned),
    }
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
    /// Reads the device-local settings for one connection.
    pub fn saved_source(&self, id: &str) -> Result<Option<SavedSource>, Error> {
        Ok(configured_source(&self.connection, id)?.map(|source| source.saved))
    }

    pub fn saved_sources(&self) -> Result<Vec<SavedSource>, Error> {
        Ok(configured_sources(&self.connection)?
            .into_iter()
            .map(|source| source.saved)
            .collect())
    }

    pub fn source_connection(&self, id: &str) -> Result<SavedSource, Error> {
        self.saved_source(id)?.ok_or_else(|| unknown_connection(id))
    }

    /// The ID an add operation will use unless another connection is added first.
    pub fn test_source_connection(
        &self,
        engine: &Engine,
        id: &str,
    ) -> Result<ConnectionInfo, Error> {
        let saved =
            configured_source(&self.connection, id)?.ok_or_else(|| unknown_connection(id))?;
        let engine = engine.for_connection(&saved.saved.provider, id, &saved.saved.config);
        Ok(saved.check(&engine)?.connection)
    }

    pub fn next_source_connection_id(&self, provider: &str) -> Result<String, Error> {
        next_connection_id(&self.connection, provider)
    }

    pub fn rename_source(&mut self, id: &str, name: &str) -> Result<SavedSource, Error> {
        let name = connection_name(name)?;
        crate::write_scope::run(&self.connection, |transaction| {
            if transaction.execute(
                "UPDATE source_connections SET name = ?2 WHERE id = ?1",
                params![id, name],
            )? == 0
            {
                return Err(unknown_connection(id));
            }
            configured_source(transaction, id)?
                .map(|source| source.saved)
                .ok_or_else(|| unknown_connection(id))
        })
    }

    /// Previews discovery against the workspace's stable external identities.
    /// Retained identities and trashed tickets are already here as well.
    pub fn preview_source(
        &self,
        engine: &Engine,
        provider: &str,
        raw: &ConfigValues,
    ) -> Result<DiscoveryPreview, Error> {
        let config = engine.validate_configuration(provider, raw)?;
        self.preview_source_with_config(engine, provider, &config)
            .map(|(preview, _, _)| preview)
    }

    fn preview_source_with_config(
        &self,
        engine: &Engine,
        provider: &str,
        config: &ConfigValues,
    ) -> Result<(DiscoveryPreview, DerivedConfiguration, ConnectionInfo), Error> {
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

    /// Validates and saves a new connection, without importing its issues.
    pub fn add_source_connection(
        &mut self,
        engine: &Engine,
        provider: &str,
        expected_id: Option<&str>,
        name: Option<&str>,
        raw: &ConfigValues,
    ) -> Result<SaveOutcome, Error> {
        let id = self.next_source_connection_id(provider)?;
        if expected_id.is_some_and(|expected| expected != id) {
            return Err(connection_id_changed());
        }
        let default_name = engine.descriptor(provider)?.name;
        let name = connection_name(name.unwrap_or(&default_name))?;
        self.write_source(engine, &id, Some((provider, name)), raw)
    }

    pub fn update_source_connection(
        &mut self,
        engine: &Engine,
        id: &str,
        raw: &ConfigValues,
    ) -> Result<SaveOutcome, Error> {
        self.write_source(engine, id, None, raw)
    }

    /// Saves the existing connection, or creates the first one for this provider.
    pub fn save_source(
        &mut self,
        engine: &Engine,
        id: &str,
        raw: &ConfigValues,
    ) -> Result<SaveOutcome, Error> {
        if self.saved_source(id)?.is_some() {
            self.update_source_connection(engine, id, raw)
        } else {
            self.add_source_connection(engine, id, None, None, raw)
        }
    }

    fn write_source(
        &mut self,
        engine: &Engine,
        id: &str,
        add: Option<(&str, &str)>,
        raw: &ConfigValues,
    ) -> Result<SaveOutcome, Error> {
        let previous = configured_source(&self.connection, id)?;
        let provider = match add {
            Some((provider, _)) => provider,
            None => {
                &previous
                    .as_ref()
                    .ok_or_else(|| unknown_connection(id))?
                    .saved
                    .provider
            }
        };
        let engine = engine.for_connection(provider, id, raw);
        if add.is_none()
            && let Some(previous) = &previous
        {
            previous.verify_effective_site(&engine)?;
        }
        let config = engine.validate_configuration(provider, raw)?;
        let (preview, derived, verified) =
            self.preview_source_with_config(&engine, provider, &config)?;
        let configuration = serde_json::to_string(&config)?;
        let derived_configuration = serde_json::to_string(&derived)?;
        let revision = uuid::Uuid::new_v4().to_string();
        let description = serde_json::to_string(&engine.description(provider)?)?;
        let account_key = account_key(provider, &verified.account);
        crate::write_scope::run(&self.connection, |transaction| {
            if let Some((_, name)) = add {
                if next_connection_id(transaction, provider)? != id {
                    return Err(connection_id_changed());
                }
                let duplicate: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM source_connections WHERE provider = ?1 AND site = ?2 AND account_key = ?3)",
                    params![provider, verified.site, account_key], |row| row.get(0),
                )?;
                if duplicate {
                    return Err(SourceError::InvalidConfiguration(vec![FieldIssue::for_form(
                        format!("{} is already connected to this site", verified.account),
                    )])
                    .into());
                }
                transaction.execute(
                    "INSERT INTO source_connections
                        (id, name, provider, site, configuration, account, account_key, contract_version, saved_at, derived_configuration, revision)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?9, ?10)",
                    params![id, name, provider, verified.site, configuration, verified.account, account_key, CONTRACT_VERSION, derived_configuration, revision],
                )?;
            } else {
                let current =
                    configured_source(transaction, id)?.ok_or_else(|| unknown_connection(id))?;
                if previous
                    .as_ref()
                    .is_none_or(|previous| previous.revision != current.revision)
                {
                    return Err(SourceError::InvalidConfiguration(vec![FieldIssue::for_form(
                        "this connection changed while it was being checked; load it again",
                    )])
                    .into());
                }
                current.verify_account(&verified)?;
                if current.saved.config != config || !same_discovery(&current.derived, &derived) {
                    clear_discovery_matches(transaction, &current)?;
                }
                transaction.execute(
                    "UPDATE source_connections SET configuration = ?2, account = ?3, contract_version = ?4,
                         saved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), derived_configuration = ?5,
                         revision = ?6, derived_checked_at = NULL WHERE id = ?1",
                    params![id, configuration, verified.account, CONTRACT_VERSION, derived_configuration, revision],
                )?;
            }
            transaction.execute(
                "INSERT INTO source_presentations (provider, description) VALUES (?1, ?2) ON CONFLICT(provider) DO UPDATE SET description = excluded.description",
                params![provider, description],
            )?;
            let source = configured_source(transaction, id)?
                .ok_or_else(|| unknown_connection(id))?
                .saved;
            Ok(SaveOutcome { source, preview })
        })
    }
}

fn connection_name(name: &str) -> Result<&str, Error> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(
            SourceError::InvalidConfiguration(vec![FieldIssue::for_field(
                "name",
                "must be one line of 1 to 100 characters",
            )])
            .into(),
        );
    }
    Ok(name)
}

fn unknown_connection(id: &str) -> Error {
    SourceError::InvalidConfiguration(vec![FieldIssue::for_field(
        "connection",
        format!("no saved source connection named {id}"),
    )])
    .into()
}

fn connection_id_changed() -> Error {
    SourceError::InvalidConfiguration(vec![FieldIssue::for_form(
        "another connection was added while this one was being set up; start again",
    )])
    .into()
}

fn next_connection_id(connection: &Connection, provider: &str) -> Result<String, Error> {
    let slug: String = provider
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug
        .split('-')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let prefix = if slug.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) {
        slug
    } else {
        format!("source-{slug}").trim_end_matches('-').to_owned()
    };
    let mut statement = connection.prepare("SELECT id FROM source_connections")?;
    let used = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    for number in 1.. {
        let id = if number == 1 {
            prefix.clone()
        } else {
            format!("{prefix}-{number}")
        };
        if !used.contains(&id)
            && !matches!(
                id.as_str(),
                "add"
                    | "list"
                    | "show"
                    | "test"
                    | "options"
                    | "preview"
                    | "save"
                    | "configure"
                    | "rename"
                    | "remove"
                    | "status"
                    | "refresh"
                    | "take-ownership"
                    | "publish"
                    | "resolve"
                    | "extension"
                    | "help"
            )
        {
            return Ok(id);
        }
    }
    Err(Error::NotFound("an unused source connection ID".into()))
}

fn account_key(provider: &str, account: &str) -> String {
    if provider == "github" {
        account.to_ascii_lowercase()
    } else {
        account.to_owned()
    }
}

// The public settings omit device-local check answers and the compare-and-write revision.
#[derive(Clone)]
struct ConfiguredSource {
    saved: SavedSource,
    derived: DerivedConfiguration,
    revision: String,
    site: String,
}

impl ConfiguredSource {
    fn verify_effective_site(&self, engine: &Engine) -> Result<(), SourceError> {
        if engine
            .effective_site(&self.saved.provider)?
            .is_some_and(|site| site != self.site)
        {
            return Err(SourceError::InvalidConfiguration(vec![
                FieldIssue::for_field(
                    "site",
                    format!(
                        "the provider's current site differs from the site saved for {}",
                        self.saved.name
                    ),
                ),
            ]));
        }
        Ok(())
    }

    fn check(&self, engine: &Engine) -> Result<ConnectionCheck, SourceError> {
        self.verify_effective_site(engine)?;
        let checked = engine.check(&self.saved.provider, &self.saved.config)?;
        self.verify_account(&checked.connection)?;
        Ok(checked)
    }

    fn verify_account(&self, actual: &ConnectionInfo) -> Result<(), SourceError> {
        let provider = &self.saved.provider;
        if actual.site == self.site
            && account_key(provider, &actual.account) == account_key(provider, &self.saved.account)
        {
            return Ok(());
        }
        Err(SourceError::Unauthenticated(format!(
            "sign in as {} at the site saved for {}",
            self.saved.account, self.saved.name
        )))
    }
}

const CONFIGURED_SOURCE: &str = "SELECT id, name, provider, configuration, account, saved_at, derived_configuration, revision, site
     FROM source_connections WHERE (?1 IS NULL OR id = ?1) ORDER BY rowid";

fn configured_source(connection: &Connection, id: &str) -> Result<Option<ConfiguredSource>, Error> {
    let mut statement = connection.prepare_cached(CONFIGURED_SOURCE)?;
    let mut rows = statement.query([id])?;
    rows.next()?.map(configured_row).transpose()
}

fn configured_sources(connection: &Connection) -> Result<Vec<ConfiguredSource>, Error> {
    let mut statement = connection.prepare_cached(CONFIGURED_SOURCE)?;
    let mut rows = statement.query([None::<&str>])?;
    let mut sources = Vec::new();
    while let Some(row) = rows.next()? {
        sources.push(configured_row(row)?);
    }
    Ok(sources)
}

fn configured_row(row: &rusqlite::Row<'_>) -> Result<ConfiguredSource, Error> {
    let config: String = row.get(3)?;
    let saved = SavedSource {
        id: row.get(0)?,
        name: row.get(1)?,
        provider: row.get(2)?,
        config: serde_json::from_str(&config)?,
        account: row.get(4)?,
        saved_at: row.get(5)?,
    };
    let raw: Option<String> = row.get(6)?;
    let derived = match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => {
            github::legacy_derived_configuration(&saved.provider, &saved.config).unwrap_or_default()
        }
    };
    Ok(ConfiguredSource {
        saved,
        derived,
        revision: row.get(7)?,
        site: row.get(8)?,
    })
}

fn same_discovery(previous: &DerivedConfiguration, current: &DerivedConfiguration) -> bool {
    previous.partitions == current.partitions && previous.discovery_scope == current.discovery_scope
}

fn clear_discovery_matches(
    connection: &Connection,
    source: &ConfiguredSource,
) -> Result<(), Error> {
    for ticket in tracking::tracked(connection, None)? {
        if selected_connection(
            connection,
            &ticket.ticket_id,
            &ticket.provider,
            &ticket.partition,
        )?
        .as_deref()
            == Some(&source.saved.id)
        {
            connection.execute(
                "UPDATE source_sync SET discovery_matches = NULL WHERE ticket_id = ?1",
                [ticket.ticket_id],
            )?;
        }
    }
    Ok(())
}

fn select_connection<'a>(
    sources: &'a [ConfiguredSource],
    affinity: Option<&str>,
    provider: &str,
    part: &str,
) -> Option<&'a ConfiguredSource> {
    affinity
        .and_then(|id| {
            sources
                .iter()
                .find(|source| source.saved.id == id && source.saved.provider == provider)
        })
        .or_else(|| {
            sources.iter().find(|source| {
                source.saved.provider == provider
                    && source
                        .derived
                        .partitions
                        .iter()
                        .any(|partition| partition == part)
            })
        })
}

fn selected_connection(
    connection: &Connection,
    ticket_id: &str,
    provider: &str,
    part: &str,
) -> Result<Option<String>, Error> {
    let affinity: Option<String> = connection
        .query_row(
            "SELECT connection_id FROM source_connection_tickets WHERE ticket_id = ?1",
            [ticket_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(select_connection(
        &configured_sources(connection)?,
        affinity.as_deref(),
        provider,
        part,
    )
    .map(|source| source.saved.id.clone()))
}

fn bind_ticket(connection: &Connection, ticket_id: &str, id: &str) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO source_connection_tickets (ticket_id, connection_id) VALUES (?1, ?2) ON CONFLICT(ticket_id) DO NOTHING",
        params![ticket_id, id],
    )?;
    Ok(())
}

/// Erases device-local routing from a staged copy, including the SQLite pages
/// which could otherwise retain deleted credential references.
pub(crate) fn forget_connections(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("PRAGMA secure_delete = ON")?;
    if crate::backup::table_exists(connection, "source_connections")? {
        connection.execute_batch(
            "DELETE FROM publication_connections;
             DELETE FROM source_connection_tickets;
             DELETE FROM source_connection_status;
             DELETE FROM source_connections;",
        )?;
    } else if crate::backup::table_exists(connection, "source_configurations")? {
        connection.execute_batch("DELETE FROM source_configurations")?;
    }
    for (table, column) in [
        ("source_sync", "discovery_matches"),
        ("source_status", "read_partitions"),
    ] {
        let has_column: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if has_column {
            connection.execute_batch(&format!(
                "UPDATE {table} SET {column} = NULL WHERE {column} IS NOT NULL"
            ))?;
        }
    }
    connection.execute_batch("VACUUM")?;
    Ok(())
}

/// Keeps this device's settings when a portable copy replaces its ticket data.
pub(crate) fn retain_connections(
    restored: &mut Connection,
    current: &Connection,
) -> Result<(), Error> {
    if !crate::backup::table_exists(current, "source_connections")? {
        if !crate::backup::table_exists(current, "source_configurations")?
            || !current.query_row(
                "SELECT EXISTS(SELECT 1 FROM source_configurations)",
                [],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Ok(());
        }
        let mut upgraded = Connection::open_in_memory()?;
        crate::backup::copy(current, &mut upgraded)?;
        let version = upgraded.pragma_query_value(None, "user_version", |row| row.get(0))?;
        crate::format::migrate(&mut upgraded, version)?;
        return retain_connections(restored, &upgraded);
    }
    let has_connections: bool = current.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_connections)",
        [],
        |row| row.get(0),
    )?;
    if !has_connections {
        return Ok(());
    }
    if !crate::backup::table_exists(restored, "source_connections")? {
        let version = restored.pragma_query_value(None, "user_version", |row| row.get(0))?;
        crate::format::migrate(restored, version)?;
    }
    let mut statement = current.prepare(
        "SELECT id, name, provider, site, configuration, account, account_key,
                contract_version, saved_at, derived_configuration, revision, derived_checked_at
         FROM source_connections ORDER BY rowid",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let values = (0..12)
            .map(|index| row.get::<_, rusqlite::types::Value>(index))
            .collect::<Result<Vec<_>, _>>()?;
        restored.execute(
            "INSERT INTO source_connections
                 (id, name, provider, site, configuration, account, account_key,
                  contract_version, saved_at, derived_configuration, revision, derived_checked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params_from_iter(values),
        )?;
    }
    let mut bindings = current.prepare(
        "SELECT p.attempt_id, p.connection_id, a.provider, a.destination, a.started_at, a.title, a.body
         FROM publication_connections p JOIN publication_attempts a ON p.attempt_id = a.id",
    )?;
    let mut rows = bindings.query([])?;
    while let Some(row) = rows.next()? {
        let values = (0..7)
            .map(|index| row.get::<_, rusqlite::types::Value>(index))
            .collect::<Result<Vec<_>, _>>()?;
        restored.execute(
            "INSERT INTO publication_connections
             SELECT id, ?2 FROM publication_attempts WHERE id = ?1 AND provider = ?3 AND destination = ?4 AND started_at = ?5 AND title = ?6 AND body = ?7",
            rusqlite::params_from_iter(values),
        )?;
    }
    Ok(())
}
