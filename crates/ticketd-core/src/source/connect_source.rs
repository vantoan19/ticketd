use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    Engine, SavedSource, SourceError, persist_source, provider_display_name, saved_source,
};
use crate::{Error, Workspace, projects, read_scope, ticket_change, write_scope};

const REPOSITORIES: &str = "repositories";

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
    saved: Option<SavedSource>,
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
                .map(|source| (&source.config, &source.account)),
            ConnectSourceAction::AlreadyListed | ConnectSourceAction::NotConnected => None,
        };
        let reviewed = (
            &self.project_id,
            &self.project_remote,
            &self.provider,
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

impl Workspace {
    /// Reads the exact connection and backfill effect from one local snapshot.
    /// This never contacts the provider.
    pub fn preview_connect_source(
        &self,
        engine: &Engine,
        provider: &str,
        project_id: &str,
    ) -> Result<ConnectSourcePreview, Error> {
        let effect = self.connect_source_effect(engine, provider, project_id)?;
        let fingerprint = effect.fingerprint()?;
        Ok(ConnectSourcePreview {
            project_id: effect.project_id,
            project_remote: effect.project_remote,
            provider: effect.provider,
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
        provider: &str,
        project_id: &str,
        expected_fingerprint: &str,
    ) -> Result<Option<ConnectSourceMatchCount>, Error> {
        let effect = self.connect_source_effect(engine, provider, project_id)?;
        effect.check(expected_fingerprint)?;
        if effect.action != ConnectSourceAction::AddRepository {
            return Ok(None);
        }
        let mut config = effect.saved.ok_or(Error::ConnectSourceChanged)?.config;
        config.insert(
            REPOSITORIES.into(),
            Value::Array(vec![Value::String(effect.repository)]),
        );
        let preview = engine.preview(provider, &config)?;
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
        provider: &str,
        project_id: &str,
        expected_fingerprint: &str,
    ) -> Result<ConnectSourceOutcome, Error> {
        let initial = self.connect_source_effect(engine, provider, project_id)?;
        initial.check(expected_fingerprint)?;
        let validated = match initial.action {
            ConnectSourceAction::NotConnected => {
                return Err(Error::ProjectSourceNotConnected {
                    provider: provider_display_name(provider),
                    repository: initial.repository,
                });
            }
            ConnectSourceAction::AddRepository => {
                let mut config = initial.saved.ok_or(Error::ConnectSourceChanged)?.config;
                config
                    .get_mut(REPOSITORIES)
                    .and_then(Value::as_array_mut)
                    .ok_or(SourceError::Unsupported(
                        "configuring discovery repositories",
                    ))?
                    .push(Value::String(initial.repository));
                let (config, preview) = self.prepare_source_save(engine, provider, &config)?;
                Some((config, preview.account))
            }
            ConnectSourceAction::AlreadyListed => None,
        };

        write_scope::run(&self.connection, |transaction| {
            let current = match read_effect(transaction, engine, provider, project_id) {
                Err(
                    Error::ProjectNotFound(_)
                    | Error::ProjectRemoteRequired(_)
                    | Error::ProjectSourceHostMismatch { .. },
                ) => {
                    return Err(Error::ConnectSourceChanged);
                }
                result => result?,
            };
            current.check(expected_fingerprint)?;
            if let Some((config, account)) = &validated {
                persist_source(transaction, provider, config, account)?;
            }
            for ticket in &current.tickets {
                ticket_change::set_project(transaction, &ticket.id, None, Some(project_id), None)?;
            }
            Ok(ConnectSourceOutcome {
                repository_added: validated.is_some(),
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
        provider: &str,
        project_id: &str,
    ) -> Result<Effect, Error> {
        read_scope::run(&self.connection, |connection| {
            read_effect(connection, engine, provider, project_id)
        })
    }
}

fn read_effect(
    connection: &Connection,
    engine: &Engine,
    provider: &str,
    project_id: &str,
) -> Result<Effect, Error> {
    let project = projects::find(connection, project_id)?;
    let remote = project
        .remote
        .ok_or(Error::ProjectRemoteRequired(project.name))?;
    let (_, repository) = remote.split_once('/').ok_or(Error::InvalidProjectRemote)?;
    if !engine
        .repository_for_destination(provider, repository)?
        .is_some_and(|configured| configured.eq_ignore_ascii_case(&remote))
    {
        return Err(Error::ProjectSourceHostMismatch {
            remote,
            provider: provider_display_name(provider),
        });
    }
    let saved = saved_source(connection, provider)?;
    let action = if let Some(source) = &saved {
        let mut listed = false;
        let repositories = source
            .config
            .get(REPOSITORIES)
            .and_then(Value::as_array)
            .ok_or(SourceError::Unsupported(
                "configuring discovery repositories",
            ))?;
        for destination in repositories.iter().filter_map(Value::as_str) {
            if engine
                .repository_for_destination(provider, destination)?
                .is_some_and(|configured| configured.eq_ignore_ascii_case(&remote))
            {
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
    let mut statement = connection.prepare(
        "SELECT t.id, t.reference, i.external_id
         FROM external_identities i
         JOIN external_ownership o ON o.ticket_id = i.ticket_id
         JOIN tickets t ON t.id = i.ticket_id
         WHERE i.provider = ?1 AND i.repository = ?2
           AND o.authority = 'external' AND t.trashed = 0 AND t.project_id IS NULL
         ORDER BY t.reference, t.id",
    )?;
    let tickets = statement
        .query_map(params![provider, remote], |row| {
            Ok(EligibleTicket {
                id: row.get(0)?,
                reference: row.get(1)?,
                external_id: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Effect {
        project_id: project.id,
        repository: repository.to_owned(),
        project_remote: remote,
        provider: provider.to_owned(),
        saved,
        action,
        tickets,
    })
}
