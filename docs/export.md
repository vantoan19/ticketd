# Workspace export format

`ticketd export` writes a UTF-8 JSON document to stdout. `ticketd export --file PATH`
writes a new file; the desktop's Settings Export card opens a native save dialog. File
exports refuse to overwrite an existing path and are published only after the
complete snapshot has been written. Errors are reported to stderr by the CLI or
in the desktop. When redirecting stdout yourself, a failed command may leave a
partial file; use `--file` for safe publication.

The root object has integer `format_version` 1 and arrays named `projects`,
`project_checkouts`, `efforts`, `tickets`, `notes`, `evidence`, `ticket_history`,
`ticket_follows`, `inbox_entries`, `tags`, `ticket_tags`, `dependencies`,
`duplicate_tickets`, `ticket_parents`, and `source_configurations`. Each array contains objects
with the corresponding record fields. IDs are strings; `ticket_id`, `project_id`,
`effort_id`, `child_id`, `parent_id`, `blocker_id`, and `dependent_id` refer to
IDs in the relevant array. `ticket_tags.tag_name` refers to `tags.name`. Ticket
`number` forms its stable reference as `T-` followed by the decimal number.
Optional values are null; `trashed` and `archived` are integers 0 or 1. History
values are recorded strings, with their meaning determined by `kind`. Checkout
paths describe the source machine and may need adjustment on another machine.
Evidence preserves full values and optional editing-agent attribution. Follows and inbox entries use the stable `local-person` preference scope, which is not an account or editing-agent identity.
`duplicate_tickets` records `source_id`, `canonical_id`, and nullable `restore_status`; the first two refer to ticket IDs. `source_configurations` holds each saved ticket-source configuration as a JSON string in `configuration` (repositories and filters only, never a credential), with the `provider`, the `account` it was validated as, and `saved_at`. All arrays represent the same SQLite read snapshot, including trash.

Follow and inbox records use `local-person` as a stable personal preference scope, independent of editing-agent attribution. Note inbox entries retain the note ID and original content in `from_value` and `to_value`, and `editing_agent` is descriptive attribution.

This portable data export is for inspection and transfer, not a live write
interface. Generic import is not supported. It is not a full backup: database
metadata and successful request replay outcomes are excluded. Use the backup
facility when available to preserve the entire workspace and retry guarantees.
