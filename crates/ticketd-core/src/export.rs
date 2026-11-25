use std::{io::Write, path::Path};

use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use crate::{Error, Workspace};

/// Every table the JSON export carries, with the columns it takes, in the order they
/// appear. The export fails closed: a test lists the tables and columns of a new Workspace
/// and fails unless each is here, or in `OMITTED_TABLES` or `OMITTED_COLUMNS` with a reason.
/// A format version that adds a table or column must classify it in this file.
const EXPORTED: &[(&str, &str)] = &[
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
    ("projects", "id, name, path, remote, archived"),
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
    ("dependencies", "blocker_id, dependent_id, created_at"),
    ("contextual_relationships", "kind, source_id, target_id"),
    ("ticket_parents", "child_id, parent_id"),
    (
        "external_identities",
        "ticket_id, provider, external_id, locator, display, url, origin, linked_at, partition, provider_name, provider_icon_svg, repository",
    ),
    ("external_ownership", "ticket_id, authority, changed_at"),
    (
        "source_sync",
        "ticket_id, state_category, state_name, external_updated_at, last_refreshed_at, last_attempt_at, last_error_code, last_error_message, conversation_updated_at, failing_since, external_author, external_created_at",
    ),
    (
        "external_duplicate_targets",
        "ticket_id, provider, external_id, locator, display",
    ),
    (
        "source_conversation",
        "ticket_id, kind, entry_id, position, actor, event, state_category, subject, body, url, created_at, edited_at",
    ),
    (
        "source_status",
        "provider, last_attempt_at, last_refreshed_at, error_code, error_message, failing_since, retry_after, last_checked_tickets",
    ),
    (
        "publication_attempts",
        "id, ticket_id, provider, destination, title, body, status, started_at, lease_expires_at, updated_at, failure_code, failure_message, external_id, locator, display, url, partition, destination_host, destination_site_unconfirmed",
    ),
    (
        "chats",
        "id, title, harness, execution_folder, folder_managed, archived, trashed, queue_paused, muted, effective_settings, created_at, automation_run_id",
    ),
    ("chat_links", "chat_id, kind, target_id"),
    (
        "chat_sessions",
        "id, chat_id, position, native_session_id, origin, started_at",
    ),
    (
        "chat_turns",
        "id, chat_id, position, native_turn_id, state, detail, problem, problem_resets_at, ending, started_at, ended_at",
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
        "id, chat_id, position, turn_id, name, input, state, output, output_truncated, started_at",
    ),
    (
        "chat_interactions",
        "id, chat_id, position, turn_id, kind, tool_id, native_request_id, prompt, reason, state, response, asked_at, resolved_at",
    ),
    (
        "chat_notices",
        "id, chat_id, position, text, from_harness, created_at",
    ),
    ("automations", "id, name, definition, trashed, created_at"),
    (
        "automation_agents",
        "id, name, harness, model, instructions, read_files, edit_files, run_commands, allowed_commands, use_web, turn_limit, time_limit_minutes, any_command, trashed, created_at",
    ),
    (
        "automation_runs",
        "id, automation_id, event_id, event, ticket_id, definition, status, reason, attention_cleared, created_at, started_at, ended_at",
    ),
    (
        "automation_run_steps",
        "run_id, position, step_id, status, reason, chat_id, started_at, ended_at",
    ),
];

/// Tables the export leaves out on purpose, each with the reason.
// Read by the test that keeps the export closed, and by people reviewing the format.
#[cfg_attr(not(test), allow(dead_code))]
const OMITTED_TABLES: &[(&str, &str)] = &[
    (
        "activity_graph_numbers",
        "an index derived from Activity text, rebuilt from it",
    ),
    (
        "activity_graph_targets",
        "an index derived from Activity text, rebuilt from it",
    ),
    (
        "activity_search_fts",
        "a search index derived from Activity briefs",
    ),
    (
        "attachment_draft_cutover",
        "device-local retention of recoverable drafts",
    ),
    (
        "attachment_draft_references",
        "device-local retention of recoverable drafts",
    ),
    (
        "attachment_drafts",
        "device-local retention of recoverable drafts",
    ),
    (
        "attachment_workspace",
        "the identity of this installation's attachment storage, not content",
    ),
    (
        "automation_arrivals",
        "device-local: whether Workspace sync brought an Automation here switched off",
    ),
    (
        "automation_device_state",
        "device-local: whether an Automation is on here, and its place in the event log",
    ),
    (
        "automation_settings",
        "device-local: how many runs execute at once",
    ),
    (
        "chat_changes",
        "a change feed the interface polls, not content",
    ),
    (
        "chat_record_writes",
        "bookkeeping for crediting CLI writes to Chat Turns",
    ),
    ("device", "this installation's device code and counter"),
    ("document_fts", "a search index derived from Documents"),
    (
        "embedded_attachments",
        "an index derived from the files linked in Markdown",
    ),
    ("last_backup", "device-local record of the last backup"),
    ("plan_graph_fts", "a search index derived from Plans"),
    (
        "record_versions",
        "device-local earlier versions, kept for 30 days",
    ),
    (
        "request_outcomes",
        "bookkeeping that makes a retried write return its first result",
    ),
    (
        "source_connections",
        "device-local settings and credential references",
    ),
    (
        "source_secret_references",
        "device-local references to source credentials in the operating system keychain",
    ),
    (
        "source_connection_id_reservations",
        "device-local connection IDs reserved to isolate credentials",
    ),
    (
        "source_credential_env_reservations",
        "device-local reserved credential override names",
    ),
    (
        "source_connection_status",
        "device-local refresh scheduling and coverage",
    ),
    (
        "source_connection_tickets",
        "device-local discovery affinity",
    ),
    (
        "publication_connections",
        "device-local publication connection binding",
    ),
    (
        "source_connection_removals",
        "device-local tickets paused after removing a connection",
    ),
    (
        "source_presentations",
        "device-local copies of installed ticket source descriptions",
    ),
    ("sync_attachments", "device-local Workspace sync state"),
    ("sync_capture", "device-local Workspace sync state"),
    ("sync_conflicts", "device-local Workspace sync state"),
    ("sync_dirty", "device-local Workspace sync state"),
    ("sync_files", "device-local Workspace sync state"),
    ("sync_notices", "device-local Workspace sync state"),
    ("sync_state", "device-local Workspace sync state"),
    ("ticket_graph_fts", "a search index derived from tickets"),
    ("ticket_search_fts", "a search index derived from tickets"),
    (
        "workspace_changes",
        "the counter views poll to notice a change",
    ),
    (
        "workspace_events",
        "the device-local event log Automations read; kept 90 days",
    ),
];

/// Columns of exported tables the export leaves out on purpose, each with the reason.
// Read by the test that keeps the export closed, and by people reviewing the format.
#[cfg_attr(not(test), allow(dead_code))]
const OMITTED_COLUMNS: &[(&str, &str, &str)] = &[
    (
        "source_sync",
        "discovery_matches",
        "membership depends on the local connection's settings",
    ),
    (
        "external_duplicate_targets",
        "url",
        "the target's viewer address, as documented in docs/export.md",
    ),
    (
        "external_duplicate_targets",
        "last_known",
        "its last-known flag, as documented in docs/export.md",
    ),
    (
        "source_status",
        "partial_message",
        "the last run's partial-read message, as documented in docs/export.md",
    ),
    (
        "source_status",
        "read_partitions",
        "which repositories the last runs covered; refresh bookkeeping like the partial-read message",
    ),
    (
        "source_sync",
        "conversation_error_code",
        "the latest failed read of an issue's comments, as documented in docs/export.md",
    ),
    (
        "source_sync",
        "conversation_error_message",
        "the latest failed read of an issue's comments, as documented in docs/export.md",
    ),
    (
        "chats",
        "changes_trimmed_through",
        "bookkeeping of the Chat change feed",
    ),
    (
        "chats",
        "marked_unread",
        "what this device's person has read",
    ),
    (
        "chats",
        "read_through",
        "what this device's person has read",
    ),
    (
        "chats",
        "read_through_position",
        "what this device's person has read",
    ),
    (
        "chats",
        "seen_through",
        "what this device's person has read",
    ),
    ("documents", "body_heading", "derived from the body"),
    ("documents", "kind", "always 'document'"),
];

impl Workspace {
    /// Capture all domain records from a single read snapshot.
    pub fn export(&self) -> Result<Value, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            let mut result = Map::new();
            result.insert("format_version".into(), Value::from(3));
            for &(table, columns) in EXPORTED {
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
            Ok(Value::Object(result))
        })
    }

    /// Write an export without replacing an existing destination.
    pub fn export_file(&self, path: impl AsRef<Path>) -> Result<(), Error> {
        let data = self.export()?;
        let path = path.as_ref();
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| crate::path_error("destination folder", parent, e))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{FORMAT_VERSION, Objects, scratch};

    /// The export lists what it carries and what it leaves out; a table or column that is in
    /// neither list is an oversight, found here when the format changes, not by a person
    /// whose data is missing from their export.
    #[test]
    fn every_table_and_column_of_a_workspace_is_exported_or_omitted_with_a_reason() {
        let found = Objects::read(&scratch(FORMAT_VERSION).unwrap()).unwrap();
        let mut unclassified = Vec::new();
        for table in &found.tables {
            let exported = EXPORTED.iter().find(|(name, _)| name == table);
            let omitted = OMITTED_TABLES.iter().any(|(name, _)| name == table);
            if exported.is_none() && !omitted {
                unclassified.push(format!("table {table}"));
            }
        }
        for column in &found.columns {
            let (table, name) = column.split_once('.').unwrap();
            let Some((_, taken)) = EXPORTED.iter().find(|(exported, _)| *exported == table) else {
                continue;
            };
            let taken = taken.split(", ").any(|taken| taken == name);
            let omitted = OMITTED_COLUMNS
                .iter()
                .any(|(omitted, column, _)| *omitted == table && *column == name);
            if !taken && !omitted {
                unclassified.push(format!("column {column}"));
            }
        }
        assert!(
            unclassified.is_empty(),
            "crates/ticketd-core/src/export.rs does not classify {}. Add each table to EXPORTED (with its columns) \
             or to OMITTED_TABLES with a reason, and each column of an exported table to EXPORTED or to \
             OMITTED_COLUMNS with a reason.",
            unclassified.join(", ")
        );
    }

    #[test]
    fn the_export_lists_name_only_what_a_workspace_has() {
        let found = Objects::read(&scratch(FORMAT_VERSION).unwrap()).unwrap();
        let mut stale = Vec::new();
        for (table, columns) in EXPORTED {
            if !found.tables.contains(*table) {
                stale.push(format!("exported table {table}"));
            }
            for column in columns.split(", ") {
                if !found.columns.contains(&format!("{table}.{column}")) {
                    stale.push(format!("exported column {table}.{column}"));
                }
            }
            if OMITTED_TABLES.iter().any(|(omitted, _)| omitted == table) {
                stale.push(format!("{table} is both exported and omitted"));
            }
        }
        for (table, _) in OMITTED_TABLES {
            if !found.tables.contains(*table) {
                stale.push(format!("omitted table {table}"));
            }
        }
        for (table, column, _) in OMITTED_COLUMNS {
            if !found.columns.contains(&format!("{table}.{column}")) {
                stale.push(format!("omitted column {table}.{column}"));
            }
            if EXPORTED.iter().any(|(exported, columns)| {
                exported == table && columns.split(", ").any(|c| c == *column)
            }) {
                stale.push(format!(
                    "column {table}.{column} is both exported and omitted"
                ));
            }
        }
        assert!(
            stale.is_empty(),
            "crates/ticketd-core/src/export.rs names what no Workspace has, or lists a column twice: {}",
            stale.join(", ")
        );
    }
}
