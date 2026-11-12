use std::{io::Write, path::Path};

use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use crate::{Error, Workspace};

impl Workspace {
    /// Capture all domain records from a single read snapshot.
    pub fn export(&self) -> Result<Value, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let mut result = Map::new();
        result.insert("format_version".into(), Value::from(2));
        for (table, columns) in [
            ("attachment_upload_destination", "id, destination"),
            ("attachment_upload_destinations", "request_id, destination"),
            (
                "drive_upload_operations",
                "request_id, attachment_id, operation",
            ),
            ("attachment_upload_settings", "id, limit_bytes"),
            (
                "attachments",
                "id, display_name, original_filename, size_bytes, kind, locator, quarantined, added_at, purge_state",
            ),
            ("ticket_attachments", "ticket_id, attachment_id"),
            (
                "drive_references",
                "attachment_id, connection_id, file_id, metadata",
            ),
            ("entities", "id, kind"),
            (
                "documents",
                "id, title, body, created_at, updated_at, trashed, originating_activity_id, kept",
            ),
            ("context_mentions", "source_id, target_id, passage"),
            (
                "numeric_mentions",
                "source_id, activity, reference, passage",
            ),
            ("activity_mentions", "activity_id, target_id, passage"),
            ("document_opens", "sequence, document_id"),
            ("document_pins", "document_id"),
            ("document_tags", "document_id, tag_name"),
            ("projects", "id, name, path"),
            ("project_checkouts", "project_id, path"),
            ("plans", "id, name, archived, purpose, spec_document_id"),
            ("plan_documents", "plan_id, document_id"),
            ("ticket_documents", "ticket_id, document_id"),
            (
                "tickets",
                "number, id, reference, title, status, body, project_id, plan_id, trashed, updated_at",
            ),
            (
                "activities",
                "number, id, ticket_id, brief, reported_at, updated_at, editing_agent, supporting_document_id",
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
            (
                "chats",
                "id, title, harness, execution_folder, folder_managed, archived, trashed, queue_paused, effective_settings, created_at",
            ),
            ("chat_links", "chat_id, kind, target_id"),
            (
                "chat_sessions",
                "id, chat_id, position, native_session_id, origin, started_at",
            ),
            (
                "chat_turns",
                "id, chat_id, position, native_turn_id, state, detail, problem, problem_resets_at, started_at, ended_at",
            ),
            (
                "chat_messages",
                "id, chat_id, position, role, text, complete, turn_id, created_at",
            ),
            (
                "chat_submission_attempts",
                "id, chat_id, message_id, intent, delivery, turn_id, detail, decision, recorded_at",
            ),
            (
                "chat_tools",
                "id, chat_id, position, turn_id, name, input, state, output, output_truncated",
            ),
            (
                "chat_interactions",
                "id, chat_id, position, turn_id, kind, native_request_id, prompt, reason, state, response",
            ),
            ("chat_notices", "id, chat_id, position, text, created_at"),
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
