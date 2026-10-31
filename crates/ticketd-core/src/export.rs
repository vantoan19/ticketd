use std::{io::Write, path::Path};

use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use crate::{Error, Workspace};

impl Workspace {
    /// Capture all domain records from a single read snapshot.
    pub fn export(&self) -> Result<Value, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let mut result = Map::new();
        result.insert("format_version".into(), Value::from(1));
        for (table, columns) in [
            ("projects", "id, name, path"),
            ("project_checkouts", "project_id, path"),
            ("efforts", "id, name, archived"),
            (
                "tickets",
                "number, id, title, status, body, project_id, effort_id, trashed",
            ),
            (
                "notes",
                "number, id, ticket_id, content, created_at, updated_at, editing_agent",
            ),
            (
                "ticket_history",
                "number, ticket_id, kind, from_value, to_value, timestamp, editing_agent",
            ),
            (
                "evidence",
                "number, id, ticket_id, kind, name, value, created_at, updated_at, editing_agent",
            ),
            ("ticket_follows", "person, ticket_id"),
            ("ticket_reminders", "person, ticket_id, due_at, delivered"),
            (
                "inbox_entries",
                "id, person, ticket_id, kind, from_value, to_value, timestamp, read",
            ),
            ("tags", "name"),
            ("ticket_tags", "ticket_id, tag_name"),
            (
                "duplicate_tickets",
                "source_id, canonical_id, restore_status",
            ),
            ("dependencies", "blocker_id, dependent_id"),
            ("ticket_parents", "child_id, parent_id"),
        ] {
            let mut statement =
                tx.prepare(&format!("SELECT {columns} FROM {table} ORDER BY rowid"))?;
            let names: Vec<String> = statement
                .column_names()
                .iter()
                .map(|s| (*s).into())
                .collect();
            let rows = statement
                .query_map([], |row| {
                    let mut object = Map::new();
                    for (index, name) in names.iter().enumerate() {
                        let value = match row.get_ref(index)? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(value) => Value::from(value),
                            ValueRef::Real(value) => Value::from(value),
                            ValueRef::Text(value) => Value::String(
                                std::str::from_utf8(value)
                                    .map_err(|e| {
                                        rusqlite::Error::FromSqlConversionFailure(
                                            index,
                                            rusqlite::types::Type::Text,
                                            Box::new(e),
                                        )
                                    })?
                                    .to_owned(),
                            ),
                            ValueRef::Blob(_) => {
                                return Err(rusqlite::Error::InvalidColumnType(
                                    index,
                                    name.clone(),
                                    rusqlite::types::Type::Blob,
                                ));
                            }
                        };
                        object.insert(name.clone(), value);
                    }
                    Ok(Value::Object(object))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            result.insert(table.into(), Value::Array(rows));
        }
        tx.commit()?;
        Ok(Value::Object(result))
    }

    /// Write an export without replacing an existing destination.
    pub fn export_file(&self, path: impl AsRef<Path>) -> Result<(), Error> {
        let data = self.export()?;
        let path = path.as_ref();
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temp, &data).map_err(std::io::Error::other)?;
        writeln!(temp)?;
        temp.as_file().sync_all()?;
        temp.persist_noclobber(path).map_err(|error| error.error)?;
        Ok(())
    }
}
