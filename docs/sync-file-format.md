# Sync file format

Workspace sync writes every ticket, Document, Plan, project, Automation and Automation agent as one Markdown file. This page is the convention for those files. The converter is `crates/ticketd-core/src/sync_files.rs`; it reads and writes files as text and knows nothing about where they are stored.

## Files

| Record           | Folder               | File name                                             |
| ---------------- | -------------------- | ----------------------------------------------------- |
| Ticket           | `tickets/`           | The Ticket reference and title: `T-KQ43 Fix login.md` |
| Document         | `documents/`         | The title, or `Untitled.md`                           |
| Plan             | `plans/`             | The name                                              |
| Project          | `projects/`          | The name                                              |
| Automation       | `automations/`       | The name, or `Untitled.md`                            |
| Automation agent | `automation_agents/` | The name, or `Untitled.md`                            |

The file name is a readable label. Characters a file system or a Drive listing would not show as typed (`/ \ : * ? " < > |` and control characters) are dropped, each run of them and of spaces becomes one space, and a name longer than 80 characters is cut at a word and ends with `…`. It changes when the title does, may repeat, and is never used to find a record. A record's identity is its GUID, which never changes: it is the `id` field of the header, and ticketd also sets it as a property on the Drive file, which is how a file is found. A file that has no such property, such as one created by hand in the folder, is not a record.

A file is a YAML header between two `---` lines, then the record's Markdown text:

<!-- prettier-ignore -->
```markdown
---
# synced from: Studio desktop
kind: ticket
format: 1
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

- `kind` comes first, then `format`, then `id`. A ticket with an external source uses format 3. A Document with a `summary` uses format 4, so a ticketd that does not know the field leaves its file alone. Other records use format 1.
- Fields appear in the order of the tables below. A field with no value is left out, except that a true-or-false field is always written.
- Every text value is a double-quoted YAML string on one line. A whole number is written bare. Lists are written one item per line, sorted.
- Times are RFC 3339 instants.
- A file written to storage also carries comments for readers: `# synced from:` with the name of the desktop that wrote it, and the Ticket reference beside each ticket GUID. Comments are never read back as data; the GUID alone identifies a record.
- The text after the header is the record's Markdown followed by one line break.
- A text line that starts with `<!-- ticketd:` is written with a leading backslash, and one leading backslash is removed when reading, so text can never be mistaken for a section marker.
- Lines end with a line feed. Line breaks inside the Markdown text are kept as they are.

## What ticketd accepts

A file edited by hand may use ordinary YAML: unquoted text, `[a, b]` lists, comments, and `~` or an empty value for "no value". Text that YAML would read as a number, `true`, `false` or `null` must be quoted. Two spellings are accepted on input and written back in ticketd's own form:

- A relationship to a ticket (`parent`, `blocked_by`, `related`, `discovered`, `duplicate_of`) may name it by its Ticket reference instead of its GUID: `blocked_by: [T-3F12]`. The reference is resolved in the Workspace that reads the file. A reference no ticket there holds is kept as written and waits like a record that has not arrived.
- A status may differ in letter case and use `-` or `_` for the space: `status: in-progress`.

`format` may be left out, which means 1.

A file is rejected as a whole, with the reason, when:

- it does not start with a header, or the header is not valid YAML;
- `kind` or `id` is missing, or an id is not a lowercase GUID;
- a required field is missing, a field is unknown, or a value has the wrong form;
- `format` is higher than this version reads;
- a ticket names itself in a relationship;
- it is larger than 8 MiB, in which case it is not downloaded at all, or a header line is indented or nested more than 64 columns deep.

A desktop does not write a file larger than 8 MiB either: the record stays on that desktop with a Needs attention notice naming it, and uploads once it is short enough. The device list and the Attachment list are not read when they are larger than that; the run stops and names the file.

A rejected file changes nothing in the Workspace, and the desktop records a Needs attention notice that names the file and the reason. The next change made to that record in ticketd replaces the file. The notice goes once the file reads again; on the desktop that replaced it, the notice instead stays in the Inbox as already read and no longer counts towards Needs attention. It says the file could not be read, why, and that the earlier file is in Drive's version history, since nothing else records what the replaced file held. There is one exception: a file with a higher `format` was written by a newer ticketd and is never replaced by a desktop that cannot read it. Changes made to that record on such a desktop wait, and its sync status stays Needs attention, until it runs a ticketd that reads the file or the file is corrected; the file is read again each time the app starts. The format number is the only mark of a newer ticketd: an unknown field or section marker in a format this version reads is rejected like any other mistake and replaced by the next change. A ticketd version that adds a field or a section marker therefore raises `format`; a test in `sync_files.rs` pins the fields and markers of the current number. A new kind of record in a folder of its own does not raise it: a ticketd from before that kind does not look in the folder, so it never reads such a file. Automations and Automation agents joined format 1 this way. A field added to a kind of file that no released ticketd has written does not raise it either, since no ticketd that cannot read the field has ever written that file; `any_command` joined the Automation agent file this way. A new form of value in an existing field (such as the `<GUID> <n>` item of `parent_removed`) is rejected by older versions in the same way and also requires raising `format`; the test does not pin value forms, so nothing fails to remind of it.

When a file uses a legacy GitHub issue ID already held by an issue at a different site, ticketd leaves the file and the Workspace record in place. Local changes to that record wait until the file is corrected or removed.

A file that disappears from the folder is not a deletion. The next sync run of a desktop that had synced it writes it again. The file a desktop then finds is another Drive file than the one it last synced, made later, and is merged against the last-synced copy like any change. Only a file made earlier than the one last synced (an old file restored from Drive's trash), or one whose creation time cannot be compared, is taken to share no history: every field whose value differs goes to Needs review and nothing is replaced silently.

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
`blocked_since` orders dependencies the same way on every device. When changes from different devices together make a dependency loop, every device removes the dependency in the loop that began last; equal times fall back to the GUIDs. A dependency added by hand without a time counts as the earliest. A loop of parents is broken the same way, by the GUIDs alone.

The ticket that lost the relationship lists it in `blocked_by_removed` or `parent_removed`, as the other ticket's GUID followed by the time of the dependency when it has one. A parent link that is made again on purpose and removed again is listed once more, as the GUID followed by the number of that removal (`<GUID> 2`), so it is a removal of its own; a dependency made again has a new time. A desktop records a notice and an Activity entry for each item once, whether it removed the relationship itself or received the file; items are never taken out again. A removal that arrives together with a ticket new to that desktop is recorded as already read.

## Fields

### Ticket

| Field                | Value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `ref`                | Required. The Ticket reference; it never changes.                     |
| `title`              | Required, not blank.                                                  |
| `status`             | Required: Todo, In progress, In review, Done, Canceled or Duplicate.  |
| `project`, `plan`    | GUID of the project and of the Plan.                                  |
| `parent`             | GUID of the parent ticket.                                            |
| `blocked_by`         | GUIDs of the tickets that block this one.                             |
| `blocked_since`      | One `<GUID> <time>` item per blocking ticket: when it began to block. |
| `blocked_by_removed` | Dependencies sync removed to break a loop; see Relationships.         |
| `parent_removed`     | A parent sync removed to break a loop; see Relationships.             |
| `related`            | GUIDs of related tickets whose id sorts after this ticket's.          |
| `discovered`         | GUIDs of tickets discovered while working on this one.                |
| `duplicate_of`       | GUID of the canonical ticket.                                         |
| `duplicate_restore`  | The status the ticket returns to when it stops being a duplicate.     |
| `tags`               | Lowercase tag names.                                                  |
| `documents`          | GUIDs of linked Documents.                                            |
| `attachments`        | GUIDs of attached files.                                              |
| `trashed`            | Whether the ticket is in Trash.                                       |
| `following`          | Whether the person follows the ticket.                                |
| `reminder`           | When the Ticket reminder is due.                                      |
| `source_*`           | External-source provenance; see below.                                |

The text after the header is the description. Activities and Implementation evidence follow as sections, oldest first.

An externally sourced ticket carries `source_provider`, `source_external_id`, `source_locator`, `source_display`, `source_url`, `source_origin` (imported or published), `source_linked_at`, `source_authority` (external or local), `source_authority_changed_at` and `source_state_category` (open, completed, not_planned, duplicate or unknown). The observed state can also carry `source_state_name` (the tracker’s display label), `source_updated_at` and `source_partition` (the provider-defined part, such as a GitHub repository). The identity and observation travel between devices. Connection settings, IDs and removal state stay on each device.

When the ticket has cached provider details, it includes the optional
`source_provider_name` and `source_provider_icon_svg` fields. The desktop displays
the mark as an image and uses the provider name when it has no covering local connection.

Formats 1 and 2 use `source_state` (open or closed) and optional `source_closure_reason`. A reader converts a closed issue whose reason is absent or marked unknown to the unknown category. For GitHub it recovers the display label from the state and derives the repository from the saved URL and locator. Older clients leave files with newer formats untouched.

Public GitHub issue IDs are numeric. Formats 2 and 3 carry GitHub Enterprise issue IDs as `@<host>:<id>` and unverified GitHub issue IDs as `@:<id>`. When reading a legacy numeric ID, ticketd verifies the host from the saved issue URL and locator. Missing or ambiguous host evidence leaves the ID unverified.

Format 3 includes a nondefault Enterprise port in the ID as `@<host>:<port>:<id>`. When a saved issue URL and locator establish the port, ticketd also qualifies earlier hostname-only IDs on read.

When two desktops observe different IDs for an already-linked GitHub issue, the latest issue update timestamp determines which identity the ticket keeps. This covers host verification and repository transfers. Equal timestamps are ordered by the field values. Concurrent links to different issues keep the lower provider and ID pair in text order. The winning issue ID, location, and associated observation travel together.

Confirming the host or following a transfer preserves the receiving desktop's pause
after a connection was removed and the issue conversation already cached there.

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

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| `title`           | The explicit title, when the Document has one.                |
| `summary`         | The author's one-line summary (format 4); left out when none. |
| `created_at`      | Required.                                                     |
| `tags`            | Lowercase tag names.                                          |
| `origin_activity` | GUID of the Activity whose details created the Document.      |
| `trashed`         | Whether the Document is in Trash.                             |
| `kept`            | Whether Activity details were kept as a standalone Document.  |
| `pinned`          | Whether the Document is pinned.                               |

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

### Automation agent

| Field                                                 | Value                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                | The agent's name.                                                                                                            |
| `harness`                                             | Required: claude-code or codex.                                                                                              |
| `model`                                               | The model; left out for the harness's own default.                                                                           |
| `turn_limit`, `time_limit_minutes`                    | Required. Whole numbers of at least 1.                                                                                       |
| `read_files`, `edit_files`, `run_commands`, `use_web` | What the agent may do.                                                                                                       |
| `any_command`                                         | With `run_commands`, any command may run. Left out or false: only the listed ones.                                           |
| `allowed_commands`                                    | With `run_commands`, and without `any_command`, the only commands allowed; none listed allows none. Their order is not kept. |
| `trashed`                                             | Whether the agent was deleted.                                                                                               |

The text after the header is the agent's instructions. Codex requires `any_command: true` when `run_commands` is on.
When both desktops edit the command policy and disagree about the harness or command switches,
Workspace sync keeps the local policy and offers each desktop's whole policy in review.
With the same harness and switches, allowlist edits merge as a set.

### Automation

| Field     | Value                               |
| --------- | ----------------------------------- |
| `name`    | The Automation's name.              |
| `trashed` | Whether the Automation was deleted. |

The text after the header is one `json` code block holding the trigger, the conditions and the steps. Steps nest (an If has a Yes and a No list, and a step may have a failure list), which a header's flat fields cannot hold, and each step names its agent by GUID:

<!-- prettier-ignore -->
``````text
---
kind: automation
format: 1
id: "5a1d7c3e-9b2f-4e6a-8c0d-1f2e3a4b5c6d"
name: "Triage new bugs"
trashed: false
---
```json
{
  "schema_version": 1,
  "trigger": {
    "kind": "tag_added",
    "tag": "bug"
  },
  "conditions": [],
  "steps": [
    {
      "id": "0c9b8a7d-6e5f-4d3c-8b2a-1f0e9d8c7b6a",
      "kind": "run_agent",
      "agent_id": "7e6d5c4b-3a2f-4b1c-9d0e-8f7a6b5c4d3e",
      "execution_folder": "C:\\code\\web-app",
      "on_failure": null
    }
  ]
}
```
``````

The block is one field. A change to it on one desktop replaces it on the others, and a change on two desktops goes to Needs review as a whole: the review takes one desktop's trigger and steps or the other's, and does not combine them. A block that is not a definition as ticketd writes one (JSON of this shape, every step with an id of its own, tags in lowercase) rejects the file. `schema_version` is the shape of the block; a higher one than this version reads rejects the file too.

Deleting an Automation or an agent sets `trashed`; the file stays, as sync deletes none. An agent can be deleted on one desktop while another desktop adds a step that runs it. Both changes are kept: the step then has no agent, and the Automation cannot be switched on until the step is given one.

## What stays on the device

These are never written to a sync file: checkout folders of a project, Attention inbox entries and their read state, recently opened Documents, credentials, source connection settings, the conversation and refresh state fetched from an external source, publication attempts, automatic history entries, the time a ticket or Document last changed, tags no record uses, whether an Automation is on, how far it has read the Workspace event log, Workspace events, and Automation runs.

A project that arrives from another device has no checkout folder until one is registered on this device. An Automation that arrives from another device is off until it is switched on on this device, whatever it is on the device it came from. One that is on here and arrives changed so that a step is unfinished, or deleted, is switched off here.

## Files that are not records

Beside the record folders, a Workspace folder holds:

- `devices.json`: the device registry. Each desktop that joined the folder is listed under its device id with its name, its two-letter device code, the time it last uploaded a change and `run`, a random token it replaces on its first run after each launch of the app (a desktop that finds a token there it did not write is a copy of that Workspace file and joins as a new desktop). `retired` lists the codes a desktop of the folder held and gave up. A desktop joining with a code that is listed either way takes a new one.
- `attachments.json`: one entry per managed Attachment with its display name, file name, size, SHA-256 and the storage version of its bytes. A desktop lists an Attachment from this entry before it has the bytes, and checks the bytes against it after downloading them.
- `attachments/`: the bytes of each managed Attachment as one file, written once and never changed. They are uploaded before any record that names the Attachment.

Every desktop writes the two JSON files. A desktop whose write meets a newer file reads it and adds its own entries again, and each sync run puts back an entry of its own that is missing. Editing these files by hand is not supported: an entry that does not validate is ignored.

Both carry `format`, the number of their format (1; a file without it is format 1). Entries and fields this version does not know are written back as they were read. A file with a higher `format` is not rewritten: the sync run stops with a Needs attention state that asks to update ticketd on that desktop.

The folder is identified by the Workspace's own identity, which every desktop that downloads the Workspace takes over, so an Attachment link in a description (`ticketd://attachment/<Workspace>/<Attachment>`) means the same on each of them. Attachments that only reference a file elsewhere are not synced.
