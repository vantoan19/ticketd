# Sync file format

Workspace sync writes every ticket, Document, Plan and project as one Markdown file. This page is the convention for those files. The converter is `crates/ticketd-core/src/sync_files.rs`; it reads and writes files as text and knows nothing about where they are stored.

## Files

| Record   | Path                |
| -------- | ------------------- |
| Ticket   | `tickets/<id>.md`   |
| Document | `documents/<id>.md` |
| Plan     | `plans/<id>.md`     |
| Project  | `projects/<id>.md`  |

`<id>` is the record's GUID, which is its identity. The path of a record never changes.

A file is a YAML header between two `---` lines, then the record's Markdown text:

```markdown
---
# synced from: Studio desktop
kind: ticket
id: "3f2c9a1e-5b7d-4c1a-9e2f-0a1b2c3d4e5f"
ref: "T-KQ43"
title: "Fix login"
status: "In progress"
parent: "8d1f6c2e-0b9a-4f3d-8c7e-6a5b4c3d2e1f" # T-KQ7
blocked_by:
  - "c4a7e9b2-3d1f-4a6b-9c8d-7e6f5a4b3c2d" # T-MW12
blocked_since:
  - "c4a7e9b2-3d1f-4a6b-9c8d-7e6f5a4b3c2d 2026-11-10T16:05:00.000Z"
tags:
  - "backend"
  - "urgent"
trashed: false
following: true
---

Users are logged out after 5 minutes.
<!-- ticketd:activity -->

---

id: "0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b"
reported_at: "2026-11-11T09:30:00.000Z"
updated_at: "2026-11-11T09:30:00.000Z"
agent: "codex"
---

Reproduced with an expired session cookie.
```

## What ticketd writes

The same record always produces the same bytes, so a file changes only when its record does.

- Fields appear in the order of the tables below. A field with no value is left out, except that a true-or-false field is always written.
- Every text value is a double-quoted YAML string on one line. Lists are written one item per line, sorted.
- Times are RFC 3339 instants.
- A file written to storage also carries comments for readers: `# synced from:` with the name of the desktop that wrote it, and the Ticket reference beside each ticket GUID. Comments are never read back as data; the GUID alone identifies a record.
- The text after the header is the record's Markdown followed by one line break.
- A text line that starts with `<!-- ticketd:` is written with a leading backslash, and one leading backslash is removed when reading, so text can never be mistaken for a section marker.
- Lines end with a line feed. Line breaks inside the Markdown text are kept as they are.

## What ticketd accepts

A file edited by hand may use ordinary YAML: unquoted text, `[a, b]` lists, comments, and `~` or an empty value for "no value". Text that YAML would read as a number, `true`, `false` or `null` must be quoted. A file is rejected as a whole, with the reason, when:

- it does not start with a header, or the header is not valid YAML;
- `kind` or `id` is missing, or an id is not a lowercase GUID;
- a required field is missing, a field is unknown, or a value has the wrong form;
- a ticket names itself in a relationship.

A rejected file changes nothing in the Workspace.

## Relationships

Every relationship is written in exactly one file, as the GUID of the other record.

| Relationship                | Written in                                         |
| --------------------------- | -------------------------------------------------- |
| Dependency                  | The blocked ticket: `blocked_by`                   |
| Subticket                   | The child: `parent`                                |
| Duplicate                   | The duplicate: `duplicate_of`                      |
| Related                     | The ticket whose id sorts first: `related`         |
| Discovered                  | The ticket the work was done on: `discovered`      |
| Project and Plan membership | The ticket: `project`, `plan`                      |
| Linked Documents            | The ticket or Plan: `documents`; the Plan's `spec` |
| Attachments                 | The ticket: `attachments`                          |
| Tags                        | The tagged ticket or Document: `tags`              |
| Supporting Document         | The Activity: `document`                           |
| Originating Activity        | The Document: `origin_activity`                    |

A file may arrive before a record it names. The relationship is then left out and reported; applying the same file again after the other record arrives completes it. Mentions and links inside Markdown text resolve once their target is present.
`blocked_since` orders dependencies the same way on every device. When changes from different devices together make a dependency loop, every device removes the dependency in the loop that began last; equal times fall back to the GUIDs. A dependency added by hand without a time counts as the earliest.

## Fields

### Ticket

| Field               | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `ref`               | Required. The Ticket reference; it never changes.                    |
| `title`             | Required, not blank.                                                 |
| `status`            | Required: Todo, In progress, In review, Done, Canceled or Duplicate. |
| `project`, `plan`   | GUID of the project and of the Plan.                                 |
| `parent`            | GUID of the parent ticket.                                           |
| `blocked_by`        | GUIDs of the tickets that block this one.                            |
| `blocked_since`     | One `<GUID> <time>` item per blocking ticket: when it began to block. |
| `related`           | GUIDs of related tickets whose id sorts after this ticket's.         |
| `discovered`        | GUIDs of tickets discovered while working on this one.               |
| `duplicate_of`      | GUID of the canonical ticket.                                        |
| `duplicate_restore` | The status the ticket returns to when it stops being a duplicate.    |
| `tags`              | Lowercase tag names.                                                 |
| `documents`         | GUIDs of linked Documents.                                           |
| `attachments`       | GUIDs of attached files.                                             |
| `trashed`           | Whether the ticket is in Trash.                                      |
| `following`         | Whether the person follows the ticket.                               |
| `reminder`          | When the Ticket reminder is due.                                     |
| `source_*`          | External-source provenance; see below.                               |

The text after the header is the description. Activities and Implementation evidence follow as sections, oldest first.

An externally sourced ticket carries `source_provider`, `source_external_id`, `source_locator`, `source_display`, `source_url`, `source_origin` (imported or published), `source_linked_at`, `source_authority` (external or local), `source_authority_changed_at`, `source_state` (open or closed) and, when known, `source_closure_reason` and `source_updated_at`. They are present together or not at all.

### Activity section

Starts with the line `<!-- ticketd:activity -->`, then its own header and the brief as Markdown.

| Field         | Value                            |
| ------------- | -------------------------------- |
| `id`          | Required. The Activity's GUID.   |
| `reported_at` | Required.                        |
| `updated_at`  | Required.                        |
| `agent`       | The editing agent.               |
| `document`    | GUID of the supporting Document. |

### Implementation evidence section

Starts with the line `<!-- ticketd:evidence -->`, then a header only.

| Field                      | Value                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| `id`                       | Required. The evidence's GUID.                                    |
| `kind`                     | Required: pull_request, commit, branch, worktree or verification. |
| `name`, `value`            | Required, not blank.                                              |
| `created_at`, `updated_at` | Required.                                                         |
| `agent`                    | The editing agent.                                                |

### Document

| Field             | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| `title`           | The explicit title, when the Document has one.               |
| `created_at`      | Required.                                                    |
| `tags`            | Lowercase tag names.                                         |
| `origin_activity` | GUID of the Activity whose details created the Document.     |
| `trashed`         | Whether the Document is in Trash.                            |
| `kept`            | Whether Activity details were kept as a standalone Document. |
| `pinned`          | Whether the Document is pinned.                              |

The text after the header is the Document body.

### Plan

| Field       | Value                             |
| ----------- | --------------------------------- |
| `name`      | Required, not blank.              |
| `archived`  | Whether the Plan is archived.     |
| `spec`      | GUID of the Plan's spec Document. |
| `documents` | GUIDs of the Plan's Documents.    |

The text after the header is the Plan's purpose.

### Project

| Field  | Value                |
| ------ | -------------------- |
| `name` | Required, not blank. |

A project file has no text after its header.

## What stays on the device

These are never written to a sync file: checkout folders of a project, Attention inbox entries and their read state, recently opened Documents, credentials, source connection settings, the conversation and refresh state fetched from an external source, publication attempts, automatic history entries, the time a ticket or Document last changed, and tags no record uses.

A project that arrives from another device has no checkout folder until one is registered on this device.
