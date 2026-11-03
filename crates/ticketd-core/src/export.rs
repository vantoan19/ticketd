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
            ("entities", "id, kind"),
            (
                "documents",
                "id, title, body, created_at, updated_at, trashed",
            ),
            ("document_opens", "sequence, document_id"),
            ("document_pins", "document_id"),
            ("document_tags", "document_id, tag_name"),
            ("projects", "id, name, path"),
            ("project_checkouts", "project_id, path"),
            ("plans", "id, name, archived, purpose"),
            (
                "tickets",
                "number, id, title, status, body, project_id, plan_id, trashed, updated_at",
            ),
            (
                "activities",
                "number, id, ticket_id, brief, reported_at, updated_at, editing_agent",
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
                "id, person, ticket_id, kind, from_value, to_value, timestamp, read, editing_agent",
            ),
            ("tags", "name"),
            ("ticket_tags", "ticket_id, tag_name"),
            (
                "duplicate_tickets",
                "source_id, canonical_id, restore_status",
            ),
            ("dependencies", "blocker_id, dependent_id"),
            ("contextual_relationships", "kind, source_id, target_id"),
            ("ticket_parents", "child_id, parent_id"),
            (
                "source_configurations",
                "provider, configuration, account, contract_version, saved_at",
            ),
            (
                "external_identities",
                "ticket_id, provider, external_id, locator, display, url, origin, linked_at",
            ),
            ("external_ownership", "ticket_id, authority, changed_at"),
            (
                "source_sync",
                "ticket_id, external_state, closure_reason, external_updated_at, last_refreshed_at, last_attempt_at, last_error_code, last_error_message, conversation_updated_at, failing_since, discovery_matches",
            ),
            (
                "external_duplicate_targets",
                "ticket_id, provider, external_id, locator, display",
            ),
            (
                "source_conversation",
                "ticket_id, kind, entry_id, position, actor, event, subject, body, url, created_at, edited_at",
            ),
            (
                "source_status",
                "provider, last_attempt_at, last_refreshed_at, error_code, error_message, failing_since, retry_after, last_checked_tickets",
            ),
            (
                "publication_attempts",
                "id, ticket_id, provider, destination, title, body, status, started_at, lease_expires_at, updated_at, failure_code, failure_message, external_id, locator, display, url",
            ),
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
        temp.persist_noclobber(path)
            .map_err(|error| match error.error.kind() {
                std::io::ErrorKind::AlreadyExists => Error::FileExists(path.to_path_buf()),
                _ => error.error.into(),
            })?;
        Ok(())
    }
}
