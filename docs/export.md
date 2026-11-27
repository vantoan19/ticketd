# Workspace export format

## Portable Markdown with files

`ticketd export-markdown --ticket T-KQ1 --output FOLDER` exports a ticket's title,
description and direct attachments. Use `--document ID` for a saved Document, or
`--markdown-file PATH` for selected/current Markdown (`-` reads stdin). Exactly
one source is required. The standalone CLI needs no desktop process.

`FOLDER` must already exist. Each invocation creates a fresh `ticketd-export-*`
subfolder containing `content.md`, `files/` and `manifest.json`; it never
overwrites earlier exports. A failed write removes its temporary bundle. Copy
the whole subfolder when sharing, so relative file links remain usable.

The JSON result and manifest have `format_version: 1`, `status` (`complete` or
`partial`), `directory`, `markdown_path`, `manifest_path`, and `attachments`.
The CLI result gives the created directory; the portable manifest uses `.` so
its paths continue to resolve after the bundle moves.
Each attachment entry records its `uri`, nullable `attachment_id`, `display_name`,
nullable `kind` (`local_snapshot`, `external_reference`, or `uploaded_copy`), nullable
`original_filename`, and exactly one result: relative `path`,
`external_url`, or an actionable `omission`. Missing/foreign references preserve
their readable Markdown links and cause `partial`; consumers must inspect status
even when the command succeeds. Files with the same name get identity-prefixed,
portable filenames (letters and digits of any script are kept; characters that are
unsafe in a path, spaces and other punctuation become `_`, and a name over 120 bytes
is cut from the end, keeping its extension); repeated identities share copied bytes. Code examples are
left literal. No private storage locator or credential is exported.

External Drive references use their last-known validated provider viewer URL,
without download, conversion, or an offline-availability promise. A complete
export means every requested reference has a file or external link; it does not
mean every external link is accessible to the recipient. Missing local bytes
are omissions, never replaced with a different attachment's content. Files in
linked Documents stay with those Documents and are not collected recursively.
Generated autolink labels use the attachment's readable display name; authored
labels stay literal. Google Docs, Sheets and Slides remain viewer links and are
never converted into local files. Exported image syntax for a Drive reference
becomes a link to its viewer rather than an image request to an HTML page;
canonical Markdown stays unchanged. Authorization parameters in provider links
are rejected before storage and again when preparing a portable link.

Backup inspection separately reports `remote_bytes_included: false` and
`remote_access_verified: false` alongside local retained-file counts. A valid
backup guarantees its retained local bytes, while remote references retain
identity and last-known metadata only. Restore does not contact Google or
restore account credentials. If a restored file is unavailable, connect the
appropriate account and select it again in the Google Drive tab; do not replace
it silently or infer deletion from failed access. Drive upload provenance and
original-byte verification are separate from current-source references.
An uploaded copy is identified from durable upload provenance, even though its
storage kind is also external. Until downloaded bytes can be verified against
that provenance, export reports an omission and `partial`, preserving the
reference instead of treating the copy as a complete current-source link export.

Desktop ticket headers and Document readers offer **Export Markdown with files**.
The shared editor exports selected rich/source content, or its current full
Markdown when nothing is selected, without saving or changing its draft.
Source selections carry only the reference definitions they use, including when
those definitions sit outside the selected range; unrelated content is excluded.
Ordinary copy-as-Markdown keeps internal workspace links. The blocked-publication
dialog's **Export with files** shares the same workflow and never publishes.
The result dialog reports omissions and offers **Show Markdown** and **Show
manifest** in the system file manager.
Drive attachment previews offer **Export link**, using this same workflow for a
named provider link without a download or native-file conversion.

## Workspace JSON snapshot

`ticketd export` writes a UTF-8 JSON document to stdout. `ticketd export --file PATH`
writes a new file; the desktop's Settings Export page opens a native save dialog. File
exports refuse to overwrite an existing path and are published only after the
complete snapshot has been written. Errors are reported to stderr by the CLI or
in the desktop. When redirecting stdout yourself, a failed command may leave a
partial file; use `--file` for safe publication.

Chat attachment snapshots are local to the device. A complete Workspace backup preserves
the exact files alongside their queued and sent Chat messages.

The root object has integer `format_version` 3 and arrays named `projects`,
`project_checkouts`, `plans`, `plan_documents`, `ticket_documents`, `tickets`, `documents`, `document_opens`, `document_pins`, `document_tags`, `entities`, `context_mentions`, `numeric_mentions`, `activity_mentions`, `activities`, `evidence`, `ticket_history`,
`ticket_follows`, `inbox_entries`, `tags`, `ticket_tags`, `dependencies`,
`duplicate_tickets`, `ticket_parents`, `external_identities`, `external_ownership`, `source_sync`, `external_duplicate_targets`, `source_conversation`, `source_status`, `publication_attempts`, and the attachment, reminder, relationship, Chat and Automation arrays described below. Each array contains objects
with the corresponding record fields. IDs are strings; `ticket_id`, `project_id`,
`plan_id`, `child_id`, `parent_id`, `blocker_id`, and `dependent_id` refer to
IDs in the relevant array. `ticket_tags.tag_name` refers to `tags.name`.

Version 3 replaces `source_sync.external_state` and `source_sync.closure_reason`
with `state_category` and `state_name`. It drops `source_sync.discovery_matches`
and the `source_configurations` array because they describe local source connections.
Version 2 renamed notes to `activities` and efforts to `plans` and added Documents
and their related arrays.
`plan_documents` associates Plan IDs with Document IDs; `ticket_documents` associates ticket IDs with the Document IDs a person attached to the ticket's context (as opposed to Documents its description mentions); `plans.spec_document_id` selects an associated primary spec.
`document_tags.tag_name` also refers to `tags.name`; `document_pins` and
`document_opens` refer to Document IDs. The full-text index is derived from
Document titles and Markdown bodies and is not exported. Ticket `reference` is its stable Ticket reference (`T-KQ43`); `number` is only the local creation order.
Optional values are null; `trashed` and `archived` are integers 0 or 1. History
values are recorded strings, with their meaning determined by `kind`. Each
Project's `archived` value records whether it is archived. Its nullable `remote`
contains its Project remote as `host/owner/name`.
Checkout paths describe the source machine and may need adjustment on another machine.
Evidence preserves full values and optional editing-agent attribution. Follows and inbox entries use the stable `local-person` preference scope, which is not an account or editing-agent identity.
`duplicate_tickets` records `source_id`, `canonical_id`, and nullable `restore_status`; the first two refer to ticket IDs. `dependencies` pairs `blocker_id` with `dependent_id` and records when the dependency was added in `created_at`. `documents` holds each Document's `id`, `title`, `body`, `created_at`, `updated_at`, `trashed`, `originating_activity_id` (the Activity it was created from, or null) and `kept` (0 or 1; 1 keeps an Activity-originated Document visible in lists). Source connection settings, credential references, local discovery affinity and connection schedules are excluded. `external_identities` is provenance: the `provider`, stable `external_id`, `locator`, `display`, `url`, discovery `partition` (nullable for older observations), hosted `repository` (when known), cached `provider_name` and `provider_icon_svg` (when available), `origin` (`imported` or `published`) and `linked_at` of the external issue a ticket is or was. `external_ownership` holds, per `ticket_id`, the current `authority` (`external` or `local`) of those tickets and when it last changed (`changed_at`). `source_sync` holds, per `ticket_id`, the last observed external state (`state_category`, `state_name`), the source's own `external_updated_at` of that observation and `conversation_updated_at` (the issue update time its comments were last read at), `last_refreshed_at`, the last attempt (`last_attempt_at`) with its `last_error_code` and `last_error_message` when it failed, `failing_since` (when the current streak of failed attempts began), and who opened the issue at the source and when (`external_author`, `external_created_at`; null until a refresh has read them). The latest failed read of an issue's comments is tracked apart from these but is not part of the export. `source_conversation` holds the retrieved comments and timeline events of an issue, one row per entry: `ticket_id`, `kind` (`comment` or `event`), the source's stable `entry_id`, `position` (chronological order), `actor`, `event`, `state_category` for lifecycle events, and `subject`, `body`, `url`, and the source's `created_at` and `edited_at` (null when never edited). Authors are the source's identities, never editing agents. `external_duplicate_targets` records the canonical issue of an externally closed duplicate: `ticket_id`, then `provider`, `external_id`, `locator` and `display` (all four are null for an unknown target). The target's viewer URL and its last-known flag are not exported. `source_status` preserves historical provider-level runs recorded before source connections: `last_attempt_at`, `last_refreshed_at`, the current `error_code` and `error_message`, `failing_since`, `retry_after` (when a rate-limited source asked to be contacted again), and `last_checked_tickets` (how many tickets the last run checked, or null). The last run's partial-read message is not exported. `publication_attempts` records every try at publishing a local ticket: the exact `title`, `body` and `destination` sent, the known GitHub site in `destination_host` (including any confirmed nondefault port), `destination_site_unconfirmed` (1 when the hostname is only a hint for legacy recovery, or 0 otherwise), a `status` (`in_flight`, `unresolved`, `failed`, or `succeeded`), `started_at`, `lease_expires_at`, `updated_at`, `failure_code` and `failure_message`, and the created issue's `external_id`, `locator`, `display`, `url` and discovery `partition` when known. Each attempt also has its `id`, `ticket_id` and `provider`. `in_flight` and `unresolved` attempts block creating another issue for the ticket. All arrays represent the same SQLite read snapshot, including trash.

Attachment arrays record file metadata, never file bytes. `attachments` holds each file's `id`, `display_name`, `original_filename`, `size_bytes`, `kind` (`local_snapshot`, `external_reference`, or `uploaded_copy`), storage `locator` (a private workspace-relative location; ticketd never reads it from an export), `quarantined` (0 or 1), `added_at`, and `purge_state`. `ticket_attachments` pairs `ticket_id` with `attachment_id`. `drive_references` holds the Google Drive identity of a Drive-backed attachment: `attachment_id`, `connection_id`, `file_id`, and its last-known `metadata` as a JSON string; no credential is exported. `attachment_upload_settings` holds the single workspace upload size `limit_bytes` row. `attachment_upload_destination` holds the single current default destination as a JSON string in `destination` (local storage or a Drive folder). `attachment_upload_destinations` records the destination frozen for each upload operation, keyed by the caller's `request_id`, so a retry returns its original choice. `drive_upload_operations` records each Drive upload by `request_id`, `attachment_id` and a JSON `operation` describing its progress. These request IDs belong to upload operations in progress or recovery; they are not replay outcomes of ordinary writes, which stay excluded.

`ticket_reminders` records each reminder as `person` (the `local-person` scope), `ticket_id`, `due_at`, and `delivered` (0 or 1). `contextual_relationships` records `kind` (`related` or `discovered`), `source_id` and `target_id`, both ticket IDs; for `discovered` the source is the work during which the target was found.

Chat arrays are keyed by `chat_id`, which refers to `chats.id`, and ordered within a chat by `position`. `chats` holds each Chat's `id`, `title`, `harness`, `execution_folder`, `folder_managed`, `archived`, `trashed`, `queue_paused`, `muted`, `effective_settings` (a JSON string), `created_at` and `automation_run_id` (the Automation run the Chat belongs to, or null). What a person has read of a Chat is not exported, nor is the bookkeeping that credits a ticket write to the Chat, and to the sub-agent, that made it (`chat_record_writes`, `chat_step_windows`). `chat_links` attaches a Chat to the records it concerns, by `kind` and `target_id`. `chat_sessions` lists the native agent sessions a Chat used (`native_session_id`, `origin`, `started_at`). `chat_turns` records each turn's `state`, `detail`, any `problem` and `problem_resets_at`, `ending` (how the turn ended, as a key such as `completed`, `failed`, `stopped_by_person`, `stopped_by_ticketd:quit` or `contact_lost`; null on turns recorded before it existed), `native_turn_id`, and `started_at` and `ended_at`. `chat_messages` holds the transcript: `role`, `text`, `complete`, the `turn_id` it belongs to, `created_at`, `editing` (1 while the original is held for a queue edit), and `requires_link_context` (1 when the saved input needs linked-record context before dispatch). `chat_tools` records tool calls (Steps): `turn_id` (the turn it ran in, or null when no turn owns it), `sub_agent_id` (the sub-agent that ran it, or null for the Chat's main agent), `name`, `input`, `state`, `output`, and `output_truncated`. `chat_interactions` records questions and permission requests: `turn_id` and `sub_agent_id` (null as for tool calls), `kind`, `tool_id` (the tool call it concerns, or null), `native_request_id`, `prompt`, `reason`, `state`, `response`, and `asked_at` and `resolved_at`. `chat_notices` holds ticketd's own notices in the transcript (`text`, `from_harness`, `created_at`). `chat_submission_attempts` records each try at delivering a message (`message_id`, `intent`, `delivery`, `turn_id`, `detail`, `decision`, `recorded_at`). `turn_id` and `message_id` refer to `chat_turns.id` and `chat_messages.id`. `sub_agent_id` is the harness's own ID for a sub-agent, unique within its Chat; every record from before format 105 has null, the main agent. `chat_sub_agents` has one record for each sub-agent the harness started: `native_id` (the harness's ID, unique within the Chat), `parent_native_id` (the sub-agent that started it, or null when the main agent did), `tool_id` (the tool call that started it, or null), `background` (1 when it runs in the background), `payload` (a JSON string of what the harness said about it: `description`, `subagent_type`, `prompt` and `model`) and `created_at`. `chat_sub_agent_runs` has a row for each time it ran, in the Chat's history order by `position`: `sub_agent_id` (refers to `chat_sub_agents.id`), `run` (1, then 2 after a resume), `native_run_id`, the `turn_id` that was active when it began (or null), `state` (`running`, `completed`, `failed`, `stopped` or `lost`), `stopped_by` (`person`, `ticketd` or `main_agent`, for `stopped`) with `stop_reason` (ticketd's reason key), `detail` (what the harness said went wrong, for `failed`), and `started_at` and `ended_at`.

Automation arrays hold what Workspace sync also carries, plus the runs. `automations` holds each Automation's `id`, `name`, `definition` (a JSON string: trigger, conditions and steps), `trashed` (0 or 1; trashing is how an Automation is deleted) and `created_at`. `automation_agents` holds each agent's `id`, `name`, `harness`, `model`, `instructions`, the tool settings `read_files`, `edit_files`, `run_commands`, `allowed_commands` (a JSON string), `use_web` and `any_command`, `turn_limit`, `time_limit_minutes`, `trashed` and `created_at`. `automation_runs` holds each run: `id`, `automation_id`, the triggering `event_id` and `event` (a JSON string, `null` for a run a schedule or Run now started), `ticket_id`, the `definition` the run executes (a JSON string, as it was when the run started), `status`, `reason`, `attention_cleared`, `created_at`, `started_at` and `ended_at`. `automation_run_steps` records the steps a run reached, keyed by `run_id` and `position`: `step_id`, `status`, `reason`, the `chat_id` of an agent step and `started_at` and `ended_at`. Whether an Automation is on, its place in the event log and the number of runs that execute at once belong to the device and are not exported, and neither is the Workspace event log itself.

`entities` supplies typed identities for Tickets, Documents, and Plans. `context_mentions` records source and target entity IDs and a passage derived from canonical Markdown; these indexes can be rebuilt from that Markdown. `numeric_mentions` preserves references to ticket numbers before those tickets exist; `activity_mentions` indexes authored Activity briefs.

Follow and inbox records use `local-person` as a stable personal preference scope, independent of editing-agent attribution. Activity inbox entries retain the Activity ID and original brief in `from_value` and `to_value`, and `editing_agent` is descriptive attribution.

This portable data export is for inspection and transfer, not a live write
interface. Generic import is not supported. It is not a full backup: database
metadata and successful request replay outcomes are excluded. Use the backup
facility when available to preserve the entire workspace and retry guarantees.
