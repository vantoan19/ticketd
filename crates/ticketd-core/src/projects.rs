use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::project_remote::normalize_project_remote;
use crate::{Error, Workspace, detect_project_remote};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectRemoteChange<'a> {
    Keep,
    Set(&'a str),
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckoutRegistration {
    pub project: Project,
    pub warning: Option<CheckoutRemoteMismatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckoutRemoteMismatch {
    pub project_remote: String,
    pub checkout_remote: String,
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL); ALTER TABLE tickets ADD COLUMN project_id TEXT REFERENCES projects(id); CREATE INDEX tickets_project_id ON tickets(project_id);")?;
    Ok(())
}

pub(crate) fn migrate_checkouts(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE project_checkouts (project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, PRIMARY KEY(project_id, path)); INSERT INTO project_checkouts SELECT id, path FROM projects;")?;
    Ok(())
}

pub(crate) fn migrate_remote(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch(
        "ALTER TABLE projects ADD COLUMN remote TEXT COLLATE NOCASE;
         CREATE UNIQUE INDEX projects_remote ON projects(remote) WHERE remote IS NOT NULL;",
    )?;
    Ok(())
}

impl Workspace {
    pub fn register_checkout(&mut self, id: &str, path: &str) -> Result<Project, Error> {
        self.register_normalized_checkout(id, &normalize(path)?)
    }

    pub fn register_checkout_with_warning(
        &mut self,
        id: &str,
        path: &str,
    ) -> Result<CheckoutRegistration, Error> {
        let path = normalize(path)?;
        let project = self.register_normalized_checkout(id, &path)?;
        let warning = project.remote.as_ref().and_then(|project_remote| {
            let checkout_remote = detect_project_remote(Path::new(&path)).suggested?;
            (!project_remote.eq_ignore_ascii_case(&checkout_remote)).then(|| {
                CheckoutRemoteMismatch {
                    project_remote: project_remote.clone(),
                    checkout_remote,
                }
            })
        });
        Ok(CheckoutRegistration { project, warning })
    }

    fn register_normalized_checkout(&mut self, id: &str, path: &str) -> Result<Project, Error> {
        crate::write_scope::run(&self.connection, |tx| {
            let project = find(tx, id)?;
            ensure_path_free(tx, path, id)?;
            tx.execute(
                "INSERT OR IGNORE INTO project_checkouts (project_id, path) VALUES (?1, ?2)",
                params![id, path],
            )?;
            // The first checkout registered after the last was removed becomes primary.
            if project.path.is_empty() {
                tx.execute(
                    "UPDATE projects SET path = ?1 WHERE id = ?2",
                    params![path, id],
                )?;
            }
            find(tx, id)
        })
    }

    pub fn remove_checkout(&mut self, id: &str, path: &str) -> Result<Project, Error> {
        let tx = self.connection.savepoint()?;
        crate::write_scope::lock(&tx)?;
        let project = find(&tx, id)?;
        // The folder may be gone already, which is why it is being unregistered.
        let normalized = normalize(path).unwrap_or_else(|_| path.trim().to_owned());
        let removed = tx.execute(
            "DELETE FROM project_checkouts WHERE project_id = ?1 AND path = ?2",
            params![id, normalized],
        )?;
        // A stale primary path that an older version left behind counts as registered:
        // unregistering it clears it below.
        if removed == 0 && project.path != normalized {
            return Err(Error::CheckoutNotRegistered(project.name));
        }
        // `path` names the primary checkout and must stay one of `paths`: move it to a
        // remaining checkout, or clear it when the last one is gone.
        let remaining = paths(&tx, id)?;
        if !remaining.contains(&project.path) {
            let next = remaining.into_iter().next().unwrap_or_default();
            tx.execute(
                "UPDATE projects SET path = ?1 WHERE id = ?2",
                params![next, id],
            )?;
        }
        tx.commit()?;
        self.show_project(id)
    }

    pub fn resolve_project(&self, directory: &std::path::Path) -> Result<Option<Project>, Error> {
        let directory = std::fs::canonicalize(directory)?;
        let mut matches = Vec::new();
        for project in self.list_projects()? {
            if project.paths.iter().any(|path| {
                std::fs::canonicalize(path).is_ok_and(|root| directory.starts_with(root))
            }) {
                matches.push(project);
            }
        }
        match matches.len() {
            0 => Ok(None),
            1 => Ok(matches.pop()),
            _ => Err(Error::AmbiguousProject(
                matches
                    .iter()
                    .map(|project| format!("{} ({})", project.name, project.id))
                    .collect::<Vec<_>>()
                    .join(", "),
            )),
        }
    }

    pub fn create_project(&mut self, name: &str, path: &str) -> Result<Project, Error> {
        self.create_project_with_remote(name, path, None)
    }

    pub fn create_project_with_remote(
        &mut self,
        name: &str,
        path: &str,
        remote: Option<&str>,
    ) -> Result<Project, Error> {
        let (name, path) = validate(name, path)?;
        let remote = remote.map(validate_remote).transpose()?;
        let normalized = normalize(path)?;
        let path = normalized.as_str();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            path: path.to_owned(),
            paths: vec![path.to_owned()],
            remote,
        };
        crate::write_scope::run(&self.connection, |tx| {
            ensure_path_free(tx, path, &project.id)?;
            if let Some(remote) = &project.remote {
                ensure_remote_free(tx, remote, &project.id)?;
            }
            tx.execute(
                "INSERT INTO projects (id, name, path, remote) VALUES (?1, ?2, ?3, ?4)",
                params![project.id, project.name, project.path, project.remote],
            )?;
            tx.execute(
                "INSERT INTO project_checkouts (project_id, path) VALUES (?1, ?2)",
                params![project.id, project.path],
            )?;
            Ok(project)
        })
    }

    pub fn edit_project(&mut self, id: &str, name: &str, path: &str) -> Result<Project, Error> {
        self.edit_project_with_remote(id, name, path, ProjectRemoteChange::Keep)
    }

    pub fn edit_project_with_remote(
        &mut self,
        id: &str,
        name: &str,
        path: &str,
        remote: ProjectRemoteChange<'_>,
    ) -> Result<Project, Error> {
        let (name, path) = (name.trim(), path.trim());
        if name.is_empty() {
            return Err(Error::EmptyProject);
        }
        crate::write_scope::run(&self.connection, |tx| {
            let old = find(tx, id)?;
            // Moving the checkout needs a folder that exists. Sending the path back
            // unchanged is a rename: it must still work after the folder was moved away.
            let target = match normalize(path) {
                Ok(path) => Some(path),
                Err(_) if path.is_empty() && old.path.is_empty() => None,
                Err(Error::NoCheckoutFolder(_)) if !path.is_empty() && path == old.path => None,
                Err(Error::NoCheckoutFolder(_)) if path.is_empty() => {
                    return Err(Error::EmptyProject);
                }
                Err(error) => return Err(error),
            };
            if let Some(path) = &target {
                ensure_path_free(tx, path, id)?;
            }
            let remote = match remote {
                ProjectRemoteChange::Keep => old.remote,
                ProjectRemoteChange::Set(remote) => {
                    let remote = validate_remote(remote)?;
                    ensure_remote_free(tx, &remote, id)?;
                    Some(remote)
                }
                ProjectRemoteChange::Clear => None,
            };
            tx.execute(
                "UPDATE projects SET name = ?1, remote = ?2 WHERE id = ?3",
                params![name, remote, id],
            )?;
            if let Some(path) = target {
                tx.execute(
                    "UPDATE projects SET path = ?1 WHERE id = ?2",
                    params![path, id],
                )?;
                if old.path != path {
                    tx.execute(
                        "DELETE FROM project_checkouts WHERE project_id = ?1 AND path = ?2",
                        params![id, old.path],
                    )?;
                }
                // Also when the path is unchanged: a path an older version left behind after
                // its checkout was unregistered is registered again by naming it.
                tx.execute(
                    "INSERT OR IGNORE INTO project_checkouts (project_id, path) VALUES (?1, ?2)",
                    params![id, path],
                )?;
            }
            self.show_project(id)
        })
    }

    pub fn show_project(&self, id: &str) -> Result<Project, Error> {
        find(&self.connection, id)
    }

    /// The Project one of whose checkouts holds `folder`. Checkout paths are stored
    /// canonical, so the folder is resolved first when it exists.
    pub fn project_for_folder(&self, folder: &std::path::Path) -> Result<Option<Project>, Error> {
        let folder = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
        Ok(self.list_projects()?.into_iter().find(|project| {
            std::iter::once(&project.path)
                .chain(&project.paths)
                .any(|path| !path.is_empty() && folder.starts_with(path))
        }))
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, Error> {
        self.read(|_| {
            let mut statement = self
                .connection
                .prepare("SELECT id, name, path, remote FROM projects ORDER BY name, id")?;
            let rows = statement
                .query_map([], row)?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|mut project| {
                    project.paths = paths(&self.connection, &project.id)?;
                    Ok(project)
                })
                .collect()
        })
    }
}

/// Reject a checkout folder already registered to another Project. Checked in code,
/// not by a UNIQUE index, so existing workspaces that already hold duplicates still open.
fn ensure_path_free(connection: &Connection, path: &str, project_id: &str) -> Result<(), Error> {
    let owner: Option<String> = connection
        .query_row(
            "SELECT p.name FROM project_checkouts c JOIN projects p ON p.id = c.project_id WHERE c.path = ?1 AND c.project_id <> ?2 ORDER BY p.name LIMIT 1",
            params![path, project_id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        Some(name) => Err(Error::CheckoutTaken(name)),
        None => Ok(()),
    }
}

fn ensure_remote_free(
    connection: &Connection,
    remote: &str,
    project_id: &str,
) -> Result<(), Error> {
    if let Some(project) = find_by_remote(connection, remote)?
        && project.id != project_id
    {
        return Err(Error::ProjectRemoteTaken {
            remote: remote.to_owned(),
            project: project.name,
        });
    }
    Ok(())
}

fn validate_remote(remote: &str) -> Result<String, Error> {
    normalize_project_remote(remote).ok_or(Error::InvalidProjectRemote)
}

fn validate<'a>(name: &'a str, path: &'a str) -> Result<(&'a str, &'a str), Error> {
    let (name, path) = (name.trim(), path.trim());
    if name.is_empty() || path.is_empty() {
        return Err(Error::EmptyProject);
    }
    Ok((name, path))
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        paths: Vec::new(),
        remote: row.get(3)?,
    })
}

pub(crate) fn find(connection: &Connection, id: &str) -> Result<Project, Error> {
    let mut project = connection
        .query_row(
            "SELECT id, name, path, remote FROM projects WHERE id = ?1",
            [id],
            row,
        )
        .optional()?
        .ok_or_else(|| Error::ProjectNotFound(id.to_owned()))?;
    project.paths = paths(connection, id)?;
    Ok(project)
}

pub(crate) fn find_by_remote(
    connection: &Connection,
    remote: &str,
) -> Result<Option<Project>, Error> {
    let mut project = connection
        .query_row(
            "SELECT id, name, path, remote FROM projects WHERE remote = ?1",
            [remote],
            row,
        )
        .optional()?;
    if let Some(project) = &mut project {
        project.paths = paths(connection, &project.id)?;
    }
    Ok(project)
}

fn paths(connection: &Connection, id: &str) -> Result<Vec<String>, Error> {
    let mut statement = connection
        .prepare("SELECT path FROM project_checkouts WHERE project_id = ?1 ORDER BY path")?;
    Ok(statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn normalize(path: &str) -> Result<String, Error> {
    let canonical = match std::fs::canonicalize(path) {
        Ok(canonical) if canonical.is_dir() => canonical,
        // A file is not the folder of a checkout.
        Ok(_) => return Err(Error::NoCheckoutFolder(path.to_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::NoCheckoutFolder(path.to_owned()));
        }
        Err(error) => return Err(error.into()),
    };
    canonical
        .to_str()
        .map(str::to_owned)
        .ok_or(Error::InvalidCheckoutPath)
}
