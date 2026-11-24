use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    ConfiguredSource, Engine, REPOSITORIES, SourceError, configured_source, unknown_connection,
};
use crate::{Error, Project, Workspace, projects, read_scope, write_scope};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRepositoryProject {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRepositoryRoute {
    /// The repository as it appears in the saved discovery configuration.
    pub repository: String,
    /// The connector's canonical Project remote, when it can identify the repository.
    pub project_remote: Option<String>,
    pub project: Option<SourceRepositoryProject>,
}

impl Workspace {
    /// Reads the persisted discovery repositories and their current routes offline.
    pub fn source_repository_routes(
        &self,
        engine: &Engine,
        connection_id: &str,
    ) -> Result<Vec<SourceRepositoryRoute>, Error> {
        read_scope::run(&self.connection, |connection| {
            let Some(source) = configured_source(connection, connection_id)? else {
                return Ok(Vec::new());
            };
            let scoped = source.bind(engine);
            let available = match source.verify_effective_site(&scoped) {
                Ok(()) => true,
                Err(SourceError::UnknownProvider(_)) => false,
                Err(error) => return Err(error.into()),
            };
            saved_repositories(&source)
                .into_iter()
                .map(|repository| {
                    let project_remote = if available {
                        scoped.repository_for_destination(&source.saved.provider, &repository)?
                    } else {
                        None
                    };
                    let project = match &project_remote {
                        Some(remote) => projects::find_by_remote(connection, remote)?,
                        None => None,
                    }
                    .map(|project| SourceRepositoryProject {
                        id: project.id,
                        name: project.name,
                    });
                    Ok(SourceRepositoryRoute {
                        repository,
                        project_remote,
                        project,
                    })
                })
                .collect()
        })
    }

    /// Sets only the Project remote, provided the repository is still saved and the
    /// project still has no remote. Backfill is reviewed and confirmed separately.
    pub fn link_source_repository_project(
        &mut self,
        engine: &Engine,
        connection_id: &str,
        repository: &str,
        project_id: &str,
    ) -> Result<Project, Error> {
        write_scope::run(&self.connection, |tx| {
            let remote = saved_repository_remote(tx, engine, connection_id, repository)?;
            projects::link_remote_if_unset(tx, project_id, &remote)
        })
    }

    /// Creates a project and its first checkout for a still-saved discovery repository.
    pub fn create_source_repository_project(
        &mut self,
        engine: &Engine,
        connection_id: &str,
        repository: &str,
        name: &str,
        path: &str,
    ) -> Result<Project, Error> {
        let mut project = projects::prepare_create(name, path)?;
        write_scope::run(&self.connection, |tx| {
            let remote = saved_repository_remote(tx, engine, connection_id, repository)?;
            project.remote = Some(
                crate::project_remote::normalize_project_remote(&remote)
                    .ok_or(Error::InvalidProjectRemote)?,
            );
            projects::insert(tx, project)
        })
    }
}

fn saved_repository_remote(
    connection: &Connection,
    engine: &Engine,
    connection_id: &str,
    repository: &str,
) -> Result<String, Error> {
    let source = configured_source(connection, connection_id)?
        .ok_or_else(|| unknown_connection(connection_id))?;
    if !saved_repositories(&source)
        .iter()
        .any(|saved| saved == repository)
    {
        return Err(Error::SourceRepositoryNotListed(repository.to_owned()));
    }
    let scoped = source.bind(engine);
    source.verify_effective_site(&scoped)?;
    scoped
        .repository_for_destination(&source.saved.provider, repository)?
        .ok_or_else(|| {
            SourceError::Unsupported("linking a discovery repository to a project").into()
        })
}

fn saved_repositories(source: &ConfiguredSource) -> Vec<String> {
    source
        .saved
        .config
        .get(REPOSITORIES)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
