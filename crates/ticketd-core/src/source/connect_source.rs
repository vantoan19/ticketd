use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    ConfigValues, ConfiguredSource, ConnectionInfo, DerivedConfiguration, Engine, REPOSITORIES,
    SourceError, clear_source_auth_error, configured_source, configured_sources,
    provider_display_name, update_saved_configuration,
};
use crate::{Error, Workspace, projects, read_scope, ticket_change, write_scope};

use super::github_integration::{self, GITHUB_INTEGRATION, GithubRepositoryRule};

// Connection IDs are environment-safe, so this form cannot select a saved ID.
const UNCONFIGURED_PROVIDER: &str = "provider:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectSourceAction {
    NotConnected,
    AddRepository,
    AlreadyListed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectSourcePreview {
    pub project_id: String,
    pub project_remote: String,
    pub provider: String,
    pub connection_id: Option<String>,
    /// The repository in the provider's discovery settings.
    pub repository: String,
    pub source: ConnectSourceAction,
    /// References of the stored tickets this confirmation would link.
    pub tickets: Vec<String>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectSourceOutcome {
    pub repository_added: bool,
    pub linked_tickets: Vec<String>,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectSourceMatchCount {
    pub matched: usize,
    /// When false, the preview stopped at the provider scan limit.
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSourceCandidate {
    /// The source to pass to Project preview and confirmation.
    pub source: String,
    pub provider: String,
    pub connection_id: Option<String>,
    pub name: String,
}

#[derive(Serialize)]
struct EligibleTicket {
    id: String,
    reference: String,
    external_id: String,
}

struct Effect {
    project_id: String,
    project_remote: String,
    repository: String,
    provider: String,
    saved: Option<ConfiguredSource>,
    action: ConnectSourceAction,
    tickets: Vec<EligibleTicket>,
}

impl Effect {
    fn fingerprint(&self) -> Result<String, Error> {
        // Only an addition depends on the rest of the source's rules. Saving
        // identical settings again has no effect on what was reviewed.
        let configuration = match self.action {
            ConnectSourceAction::AddRepository => self
                .saved
                .as_ref()
                .map(|source| (&source.saved.config, &source.site, &source.account_key)),
            ConnectSourceAction::AlreadyListed | ConnectSourceAction::NotConnected => None,
        };
        let reviewed = (
            &self.project_id,
            &self.project_remote,
            &self.provider,
            self.saved
                .as_ref()
                .filter(|source| !github_integration::is_integration_target(source))
                .map(|source| &source.saved.id),
            self.action,
            configuration,
            &self.tickets,
        );
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&reviewed)?)
        ))
    }

    fn check(&self, expected: &str) -> Result<(), Error> {
        if self.fingerprint()? != expected {
            return Err(Error::ConnectSourceChanged);
        }
        Ok(())
    }
}

struct DiscoveryUpdate {
    config: ConfigValues,
    derived: DerivedConfiguration,
    verified: ConnectionInfo,
    revision: String,
}

impl Workspace {
    /// Lists connections that can route the Project remote, using local settings.
    /// If none match, offers compatible providers for a first connection.
    pub fn project_source_candidates(
        &self,
        engine: &Engine,
        project_id: &str,
    ) -> Result<Vec<ProjectSourceCandidate>, Error> {
        read_scope::run(&self.connection, |connection| {
            let (_, remote) = project_remote(connection, project_id)?;
            let repository = remote_repository(&remote)?;
            let mut candidates = Vec::new();
            for source in configured_sources(connection)? {
                let saved = &source.saved;
                if engine.descriptor(&saved.provider).is_err() {
                    continue;
                }
                let scoped = source.bind(engine);
                if source.verify_effective_site(&scoped).is_ok()
                    && matches_remote(&scoped, &saved.provider, repository, &remote)?
                {
                    let saved = source.saved;
                    candidates.push(ProjectSourceCandidate {
                        source: saved.id.clone(),
                        provider: saved.provider,
                        connection_id: Some(saved.id),
                        name: saved.name,
                    });
                }
            }
            if engine.descriptor(GITHUB_INTEGRATION).is_ok()
                && !candidates
                    .iter()
                    .any(|candidate| candidate.provider == GITHUB_INTEGRATION)
            {
                candidates.push(ProjectSourceCandidate {
                    source: GITHUB_INTEGRATION.into(),
                    provider: GITHUB_INTEGRATION.into(),
                    connection_id: None,
                    name: "GitHub".into(),
                });
            }
            if candidates.is_empty() {
                for description in engine.descriptions() {
                    let descriptor = description.descriptor;
                    if descriptor.schema.field(REPOSITORIES).is_some()
                        && matches_remote(engine, &descriptor.provider, repository, &remote)?
                    {
                        candidates.push(ProjectSourceCandidate {
                            source: format!("{UNCONFIGURED_PROVIDER}{}", descriptor.provider),
                            provider: descriptor.provider,
                            connection_id: None,
                            name: descriptor.name,
                        });
                    }
                }
            }
            Ok(candidates)
        })
    }

    /// Reads the exact connection and backfill effect from one local snapshot.
    /// This never contacts the provider.
    pub fn preview_connect_source(
        &self,
        engine: &Engine,
        source: &str,
        project_id: &str,
    ) -> Result<ConnectSourcePreview, Error> {
        let effect = self.connect_source_effect(engine, source, project_id)?;
        let fingerprint = effect.fingerprint()?;
        Ok(ConnectSourcePreview {
            project_id: effect.project_id,
            project_remote: effect.project_remote,
            provider: effect.provider,
            connection_id: effect
                .saved
                .filter(|source| !github_integration::is_integration_target(source))
                .map(|source| source.saved.id),
            repository: effect.repository,
            source: effect.action,
            tickets: effect
                .tickets
                .into_iter()
                .map(|ticket| ticket.reference)
                .collect(),
            fingerprint,
        })
    }

    /// Gets a bounded live discovery count for the repository being added,
    /// using the reviewed settings' filters. This count is separate from the
    /// offline effect and never changes what a confirmation applies.
    pub fn connect_source_match_count(
        &self,
        engine: &Engine,
        source: &str,
        project_id: &str,
        expected_fingerprint: &str,
    ) -> Result<Option<ConnectSourceMatchCount>, Error> {
        let effect = self.connect_source_effect(engine, source, project_id)?;
        effect.check(expected_fingerprint)?;
        if effect.action != ConnectSourceAction::AddRepository {
            return Ok(None);
        }
        let saved = effect.saved.ok_or(Error::ConnectSourceChanged)?;
        if github_integration::is_integration_target(&saved) {
            let preview = self.preview_github_repository(
                engine,
                GithubRepositoryRule {
                    repository: effect.project_remote,
                    assignee: None,
                    labels: Vec::new(),
                },
            )?;
            return Ok(Some(ConnectSourceMatchCount {
                matched: preview.matched,
                complete: preview.complete,
            }));
        }
        let scoped = saved.bind(engine);
        saved.verify_effective_site(&scoped)?;
        let scoped = scoped.with_workflow_credentials(&effect.provider, &saved.saved.config)?;
        let config = only_repository(saved.saved.config.clone(), effect.repository);
        let config = scoped.validate_configuration(&effect.provider, &config)?;
        let (preview, _, verified) = self.preview_source_with_config(
            &scoped,
            &effect.provider,
            &saved.account_check_configuration(&config),
        )?;
        saved.verify_account(&verified)?;
        Ok(Some(ConnectSourceMatchCount {
            matched: preview.matched,
            complete: preview.complete,
        }))
    }

    /// Adds a discovery repository when needed and links the reviewed tickets.
    /// Network validation runs before the write lock. Both changes commit together
    /// only if the same effect is still current after validation.
    pub fn connect_source(
        &mut self,
        engine: &Engine,
        source: &str,
        project_id: &str,
        expected_fingerprint: &str,
    ) -> Result<ConnectSourceOutcome, Error> {
        let initial = self.connect_source_effect(engine, source, project_id)?;
        initial.check(expected_fingerprint)?;
        let github_rule = (initial.action == ConnectSourceAction::AddRepository
            && initial
                .saved
                .as_ref()
                .is_some_and(github_integration::is_integration_target))
        .then(|| GithubRepositoryRule {
            repository: initial.project_remote.to_ascii_lowercase(),
            assignee: None,
            labels: Vec::new(),
        });
        if let Some(rule) = &github_rule {
            self.preview_github_repository(engine, rule.clone())?;
        }
        let validated = match initial.action {
            ConnectSourceAction::NotConnected => {
                return Err(Error::ProjectSourceNotConnected {
                    provider: provider_display_name(&self.connection, &initial.provider)?,
                    repository: initial.repository,
                });
            }
            ConnectSourceAction::AddRepository if github_rule.is_some() => None,
            ConnectSourceAction::AddRepository => {
                let saved = initial.saved.ok_or(Error::ConnectSourceChanged)?;
                let scoped = saved.bind(engine);
                saved.verify_effective_site(&scoped)?;
                let scoped =
                    scoped.with_workflow_credentials(&initial.provider, &saved.saved.config)?;
                let mut config = saved.saved.config.clone();
                config
                    .get_mut(REPOSITORIES)
                    .and_then(Value::as_array_mut)
                    .ok_or(SourceError::Unsupported(
                        "configuring discovery repositories",
                    ))?
                    .push(Value::String(initial.repository.clone()));
                let config = scoped.validate_configuration(&initial.provider, &config)?;
                let (preview, derived, verified) = self.preview_source_with_config(
                    &scoped,
                    &initial.provider,
                    &saved.account_check_configuration(&config),
                )?;
                saved.verify_account(&verified)?;
                if !preview.complete {
                    // Earlier repositories can fill the bounded preview before it reads this one.
                    let additional = only_repository(config.clone(), initial.repository);
                    let (_, _, checked) = self.preview_source_with_config(
                        &scoped,
                        &initial.provider,
                        &saved.account_check_configuration(&additional),
                    )?;
                    saved.verify_account(&checked)?;
                }
                Some(DiscoveryUpdate {
                    config,
                    derived,
                    verified,
                    revision: saved.revision,
                })
            }
            ConnectSourceAction::AlreadyListed => None,
        };

        write_scope::run(&self.connection, |transaction| {
            let current = match read_effect(transaction, engine, source, project_id) {
                Err(
                    Error::ProjectNotFound(_)
                    | Error::ProjectRemoteRequired(_)
                    | Error::ProjectSourceHostMismatch { .. }
                    | Error::Source(SourceError::UnknownProvider(_)),
                ) => {
                    return Err(Error::ConnectSourceChanged);
                }
                result => result?,
            };
            current.check(expected_fingerprint)?;
            if let Some(update) = &validated {
                let saved = current.saved.as_ref().ok_or(Error::ConnectSourceChanged)?;
                if saved.revision != update.revision {
                    return Err(Error::ConnectSourceChanged);
                }
                update_saved_configuration(
                    transaction,
                    saved,
                    &update.config,
                    &update.derived,
                    &update.verified,
                )?;
                clear_source_auth_error(transaction, &saved.saved.id)?;
            }
            if let Some(rule) = &github_rule {
                if transaction.query_row("SELECT EXISTS(SELECT 1 FROM github_legacy_repository_rules WHERE repository = ?1 AND resolved = 0)",
                    [&rule.repository], |row| row.get::<_, bool>(0))? {
                    return Err(SourceError::InvalidConfiguration(vec![super::FieldIssue::for_field(
                        "repository", "review and save the repository's previous GitHub filters before backfilling",
                    )]).into());
                }
                github_integration::save_rule(transaction, rule)?;
            }
            for ticket in &current.tickets {
                ticket_change::set_project(transaction, &ticket.id, None, Some(project_id), None)?;
            }
            Ok(ConnectSourceOutcome {
                repository_added: validated.is_some() || github_rule.is_some(),
                linked_tickets: current
                    .tickets
                    .into_iter()
                    .map(|ticket| ticket.reference)
                    .collect(),
            })
        })
    }

    fn connect_source_effect(
        &self,
        engine: &Engine,
        source: &str,
        project_id: &str,
    ) -> Result<Effect, Error> {
        read_scope::run(&self.connection, |connection| {
            read_effect(connection, engine, source, project_id)
        })
    }
}

fn only_repository(mut config: ConfigValues, repository: String) -> ConfigValues {
    config.insert(
        REPOSITORIES.into(),
        Value::Array(vec![Value::String(repository)]),
    );
    config
}

fn project_remote(connection: &Connection, project_id: &str) -> Result<(String, String), Error> {
    let project = projects::ensure_active(connection, project_id)?;
    let remote = project
        .remote
        .ok_or(Error::ProjectRemoteRequired(project.name))?;
    Ok((project.id, remote))
}

fn remote_repository(remote: &str) -> Result<&str, Error> {
    remote
        .split_once('/')
        .map(|(_, repository)| repository)
        .ok_or(Error::InvalidProjectRemote)
}

fn matches_remote(
    engine: &Engine,
    provider: &str,
    repository: &str,
    remote: &str,
) -> Result<bool, Error> {
    Ok(engine
        .repository_for_destination(provider, repository)?
        .is_some_and(|configured| configured.eq_ignore_ascii_case(remote)))
}

fn read_effect(
    connection: &Connection,
    engine: &Engine,
    source: &str,
    project_id: &str,
) -> Result<Effect, Error> {
    let (project_id, remote) = project_remote(connection, project_id)?;
    let repository = remote_repository(&remote)?;
    let (mut saved, provider) = if let Some(provider) = source.strip_prefix(UNCONFIGURED_PROVIDER) {
        (None, provider)
    } else {
        let saved = configured_source(connection, source)?;
        (saved, source)
    };
    if provider == GITHUB_INTEGRATION && saved.is_none() {
        let (host, _) = remote.split_once('/').ok_or(Error::InvalidProjectRemote)?;
        let mut statement = connection.prepare(
            "SELECT host FROM github_repository_rules
             WHERE repository = ?1 COLLATE NOCASE OR repository LIKE ?2 COLLATE NOCASE",
        )?;
        let with_port = format!("{host}:%/{repository}");
        let sites = statement
            .query_map(params![remote, with_port], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let site = match sites.as_slice() {
            [] => host,
            [site] => site,
            _ => {
                return Err(
                    SourceError::InvalidConfiguration(vec![super::FieldIssue::for_field(
                        "repository",
                        "this Project remote has more than one saved GitHub site",
                    )])
                    .into(),
                );
            }
        };
        let repositories = if sites.is_empty() {
            Vec::new()
        } else {
            vec![repository.to_owned()]
        };
        saved = Some(github_integration::workflow_target(
            connection,
            site,
            Some(&project_id),
            &repositories,
        )?);
    }
    let provider = saved
        .as_ref()
        .map_or(provider, |source| &source.saved.provider);
    let scoped = saved.as_ref().map(|source| source.bind(engine));
    let scoped = scoped.as_ref().unwrap_or(engine);
    if saved
        .as_ref()
        .is_some_and(|source| source.verify_effective_site(scoped).is_err())
        || !matches_remote(scoped, provider, repository, &remote)?
    {
        return Err(Error::ProjectSourceHostMismatch {
            remote,
            provider: provider_display_name(connection, provider)?,
        });
    }
    let action = if let Some(source) = &saved {
        let mut listed = false;
        let repositories = source
            .saved
            .config
            .get(REPOSITORIES)
            .and_then(Value::as_array)
            .ok_or(SourceError::Unsupported(
                "configuring discovery repositories",
            ))?;
        for destination in repositories.iter().filter_map(Value::as_str) {
            if matches_remote(scoped, provider, destination, &remote)? {
                listed = true;
                break;
            }
        }
        if listed {
            ConnectSourceAction::AlreadyListed
        } else {
            ConnectSourceAction::AddRepository
        }
    } else {
        ConnectSourceAction::NotConnected
    };
    let github_site = if provider == super::github::PROVIDER {
        scoped.issue_site(provider)?
    } else {
        None
    };
    let mut statement = connection.prepare(
        "SELECT t.id, t.reference, i.external_id, i.locator, i.url
         FROM external_identities i
         JOIN external_ownership o ON o.ticket_id = i.ticket_id
         JOIN tickets t ON t.id = i.ticket_id
         WHERE i.provider = ?1 AND i.repository = ?2
           AND o.authority = 'external' AND t.trashed = 0 AND t.project_id IS NULL
         ORDER BY t.reference, t.id",
    )?;
    let mut rows = statement.query(params![provider, remote])?;
    let mut tickets = Vec::new();
    while let Some(row) = rows.next()? {
        let external_id: String = row.get(2)?;
        if provider == super::github::PROVIDER {
            // The Project remote omits the port. The selected connection
            // supplies the site boundary for backfill.
            let Some(site) = github_site
                .filter(|site| super::github::issue_id_site(&external_id) == Some(*site))
            else {
                continue;
            };
            if site != "github.com" && super::github::site_host(site) == site {
                // Older Enterprise IDs omitted even nondefault ports. Require
                // a corroborating URL before treating a bare hostname as exact.
                let locator: String = row.get(3)?;
                let url: String = row.get(4)?;
                if super::github::issue_site_from_url(&locator, &url).as_deref() != Some(site) {
                    continue;
                }
            }
        }
        tickets.push(EligibleTicket {
            id: row.get(0)?,
            reference: row.get(1)?,
            external_id,
        });
    }
    Ok(Effect {
        project_id,
        repository: repository.to_owned(),
        project_remote: remote,
        provider: provider.to_owned(),
        saved,
        action,
        tickets,
    })
}
