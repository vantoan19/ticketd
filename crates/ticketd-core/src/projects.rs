use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Workspace};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL); ALTER TABLE tickets ADD COLUMN project_id TEXT REFERENCES projects(id); CREATE INDEX tickets_project_id ON tickets(project_id); PRAGMA user_version = 6;")?;
    Ok(())
}

impl Workspace {
    pub fn create_project(&mut self, name: &str, path: &str) -> Result<Project, Error> {
        let (name, path) = validate(name, path)?;
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            path: path.to_owned(),
        };
        self.connection.execute(
            "INSERT INTO projects (id, name, path) VALUES (?1, ?2, ?3)",
            params![project.id, project.name, project.path],
        )?;
        Ok(project)
    }

    pub fn edit_project(&mut self, id: &str, name: &str, path: &str) -> Result<Project, Error> {
        let (name, path) = validate(name, path)?;
        if self.connection.execute(
            "UPDATE projects SET name = ?1, path = ?2 WHERE id = ?3",
            params![name, path, id],
        )? == 0
        {
            return Err(Error::ProjectNotFound(id.to_owned()));
        }
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
        Ok(rows)
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
    })
}

pub(crate) fn find(connection: &Connection, id: &str) -> Result<Project, Error> {
    connection
        .query_row(
            "SELECT id, name, path FROM projects WHERE id = ?1",
            [id],
            row,
        )
        .optional()?
        .ok_or_else(|| Error::ProjectNotFound(id.to_owned()))
}
