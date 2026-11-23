use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Engine, REPOSITORIES, SourceError, saved_source};
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
        provider: &str,
    ) -> Result<Vec<SourceRepositoryRoute>, Error> {
        read_scope::run(&self.connection, |connection| {
            saved_repositories(connection, provider)?
                .into_iter()
                .map(|repository| {
                    let project_remote =
                        engine.repository_for_destination(provider, &repository)?;
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
        provider: &str,
        repository: &str,
        project_id: &str,
    ) -> Result<Project, Error> {
        write_scope::run(&self.connection, |tx| {
            if !saved_repositories(tx, provider)?
                .iter()
                .any(|saved| saved == repository)
            {
                return Err(Error::SourceRepositoryNotListed(repository.to_owned()));
            }
            let remote = engine
                .repository_for_destination(provider, repository)?
                .ok_or(SourceError::Unsupported(
                    "linking a discovery repository to a project",
                ))?;
            projects::link_remote_if_unset(tx, project_id, &remote)
        })
    }
}

fn saved_repositories(connection: &Connection, provider: &str) -> Result<Vec<String>, Error> {
    let saved = saved_source(connection, provider)?;
    Ok(saved
        .as_ref()
        .and_then(|source| source.config.get(REPOSITORIES))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect())
}
