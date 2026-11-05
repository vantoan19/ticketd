# Workspace export format

`ticketd export` writes a UTF-8 JSON document to stdout. `ticketd export --file PATH`
writes a new file; the desktop's Settings Export card opens a native save dialog. File
exports refuse to overwrite an existing path and are published only after the
complete snapshot has been written. Errors are reported to stderr by the CLI or
in the desktop. When redirecting stdout yourself, a failed command may leave a
partial file; use `--file` for safe publication.

The root object has integer `format_version` 2 and arrays named `projects`,
`project_checkouts`, `plans`, `plan_documents`, `tickets`, `documents`, `document_opens`, `document_pins`, `document_tags`, `entities`, `context_mentions`, `numeric_mentions`, `activity_mentions`, `activities`, `evidence`, `ticket_history`,
`ticket_follows`, `inbox_entries`, `tags`, `ticket_tags`, `dependencies`,
`duplicate_tickets`, `ticket_parents`, `source_configurations`, `external_identities`, `external_ownership`, `source_sync`, `external_duplicate_targets`, `source_conversation`, `source_status`, and `publication_attempts`. Version 2 renamed notes to `activities` and efforts to `plans`, and added Documents and their related arrays; version 1 exports are not compatible. Each array contains objects
with the corresponding record fields. IDs are strings; `ticket_id`, `project_id`,
`plan_id`, `child_id`, `parent_id`, `blocker_id`, and `dependent_id` refer to
IDs in the relevant array. `ticket_tags.tag_name` refers to `tags.name`.
`plan_documents` associates Plan IDs with Document IDs; `plans.spec_document_id` selects an associated primary spec.
`document_tags.tag_name` also refers to `tags.name`; `document_pins` and
`document_opens` refer to Document IDs. The full-text index is derived from
Document titles and Markdown bodies and is not exported. Ticket `number` forms its stable reference as `T-` followed by the decimal number.
Optional values are null; `trashed` and `archived` are integers 0 or 1. History
values are recorded strings, with their meaning determined by `kind`. Checkout
paths describe the source machine and may need adjustment on another machine.
Evidence preserves full values and optional editing-agent attribution. Follows and inbox entries use the stable `local-person` preference scope, which is not an account or editing-agent identity.
`duplicate_tickets` records `source_id`, `canonical_id`, and nullable `restore_status`; the first two refer to ticket IDs. `source_configurations` holds each saved ticket-source configuration as a JSON string in `configuration` (repositories and filters only, never a credential), with the `provider`, the `account` it was validated as, and `saved_at`. `external_identities` is provenance: the `provider`, stable `external_id`, `locator`, `display`, `url`, `origin` (`imported` or `published`) and `linked_at` of the external issue a ticket is or was. `external_ownership` holds the current `authority` (`external` or `local`) of those tickets. `source_sync` holds the last observed external state (`external_state`, `closure_reason`), the source's own `external_updated_at` of that observation and `conversation_updated_at` (the issue update time its comments were last read at), `last_refreshed_at`, the last failed attempt, `failing_since` (when the current streak of failed attempts began), and `conversation_error_code` and `conversation_error_message` (the latest failed read of the issue's comments, kept apart from the ticket's own failures). `source_conversation` holds the retrieved comments and timeline events of an issue, one row per entry: `ticket_id`, `kind` (`comment` or `event`), the source's stable `entry_id`, `position` (chronological order), `actor`, `event` and `subject` for events, `body`, `url`, and the source's `created_at` and `edited_at` (null when never edited). Authors are the source's identities, never editing agents. `external_duplicate_targets` records the canonical issue of an externally closed duplicate (both identity columns are null for an unknown target), with its `locator`, `display`, the `url` where it can be opened, and `last_known` (1 when the source no longer supplies the target and it is the last one it named). `source_status` holds each source's last run: `last_attempt_at`, `last_refreshed_at`, the current `error_code` and `error_message`, `failing_since`, `retry_after` (when a rate-limited source asked to be contacted again), and `partial_message` (the discovery rules the last run could not read while it read the rest). `publication_attempts` records every try at publishing a local ticket: the exact `title`, `body` and `destination` sent, a `status` (`in_flight`, `unresolved`, `failed`, or `succeeded`), `started_at`, `lease_expires_at`, the failure code and message, and the created issue's `external_id`, `locator`, `display` and `url` when known. `in_flight` and `unresolved` attempts block creating another issue for the ticket. All arrays represent the same SQLite read snapshot, including trash.

`entities` supplies typed identities for Tickets, Documents, and Plans. `context_mentions` records source and target entity IDs and a passage derived from canonical Markdown; these indexes can be rebuilt from that Markdown. `numeric_mentions` preserves references to ticket numbers before those tickets exist; `activity_mentions` indexes authored Activity briefs.

Follow and inbox records use `local-person` as a stable personal preference scope, independent of editing-agent attribution. Activity inbox entries retain the Activity ID and original brief in `from_value` and `to_value`, and `editing_agent` is descriptive attribution.

This portable data export is for inspection and transfer, not a live write
interface. Generic import is not supported. It is not a full backup: database
metadata and successful request replay outcomes are excluded. Use the backup
facility when available to preserve the entire workspace and retry guarantees.
