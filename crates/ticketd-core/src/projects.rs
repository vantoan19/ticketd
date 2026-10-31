use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Workspace};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub paths: Vec<String>,
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL); ALTER TABLE tickets ADD COLUMN project_id TEXT REFERENCES projects(id); CREATE INDEX tickets_project_id ON tickets(project_id); PRAGMA user_version = 7;")?;
    Ok(())
}

pub(crate) fn migrate_checkouts(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE project_checkouts (project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, PRIMARY KEY(project_id, path)); INSERT INTO project_checkouts SELECT id, path FROM projects;")?;
    Ok(())
}

impl Workspace {
    pub fn register_checkout(&mut self, id: &str, path: &str) -> Result<Project, Error> {
        find(&self.connection, id)?;
        let path = normalize(path)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO project_checkouts (project_id, path) VALUES (?1, ?2)",
            params![id, path],
        )?;
        self.show_project(id)
    }

    pub fn remove_checkout(&mut self, id: &str, path: &str) -> Result<Project, Error> {
        find(&self.connection, id)?;
        self.connection.execute(
            "DELETE FROM project_checkouts WHERE project_id = ?1 AND path = ?2",
            params![id, path],
        )?;
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
            _ => Err(Error::AmbiguousProject),
        }
    }

    pub fn create_project(&mut self, name: &str, path: &str) -> Result<Project, Error> {
        let (name, path) = validate(name, path)?;
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            path: path.to_owned(),
            paths: vec![path.to_owned()],
        };
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO projects (id, name, path) VALUES (?1, ?2, ?3)",
            params![project.id, project.name, project.path],
        )?;
        tx.execute(
            "INSERT INTO project_checkouts (project_id, path) VALUES (?1, ?2)",
            params![project.id, project.path],
        )?;
        tx.commit()?;
        Ok(project)
    }

    pub fn edit_project(&mut self, id: &str, name: &str, path: &str) -> Result<Project, Error> {
        let (name, path) = validate(name, path)?;
        let old = self.show_project(id)?;
        let tx = self.connection.transaction()?;
        if tx.execute(
            "UPDATE projects SET name = ?1, path = ?2 WHERE id = ?3",
            params![name, path, id],
        )? == 0
        {
            return Err(Error::ProjectNotFound(id.to_owned()));
        }
        if old.path != path {
            tx.execute(
                "DELETE FROM project_checkouts WHERE project_id = ?1 AND path = ?2",
                params![id, old.path],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO project_checkouts (project_id, path) VALUES (?1, ?2)",
                params![id, path],
            )?;
        }
        tx.commit()?;
        self.show_project(id)
    }

    pub fn show_project(&self, id: &str) -> Result<Project, Error> {
        find(&self.connection, id)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, Error> {
        let mut statement = self
            .connection
            .prepare("SELECT id, name, path FROM projects ORDER BY name, id")?;
        let rows = statement
            .query_map([], row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|mut project| {
                project.paths = paths(&self.connection, &project.id)?;
                Ok(project)
            })
            .collect()
    }
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
    })
}

pub(crate) fn find(connection: &Connection, id: &str) -> Result<Project, Error> {
    let mut project = connection
        .query_row(
            "SELECT id, name, path FROM projects WHERE id = ?1",
            [id],
            row,
        )
        .optional()?
        .ok_or_else(|| Error::ProjectNotFound(id.to_owned()))?;
    project.paths = paths(connection, id)?;
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
    let path = std::fs::canonicalize(path)?;
    path.to_str()
        .map(str::to_owned)
        .ok_or(Error::InvalidCheckoutPath)
}
