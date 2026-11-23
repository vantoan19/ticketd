# ticketd product description

This document describes what ticketd does today, for contributors.
[GLOSSARY.md](../GLOSSARY.md) defines the terms used here, [architecture](architecture.md)
describes how the behavior is built (a Tauri desktop and a Rust CLI over one shared
core and local SQLite, with no daemon), and the ADRs in `docs/adr` record the
decisions behind it. The [contribution guide](../CONTRIBUTING.md#choose-a-starting-point) explains how to report bugs and propose changes.

## Purpose

ticketd is a local ticket workspace: a desktop application for people and a fast
command line for agents, sharing the same work and context. It is the system of
record for locally owned tickets and a working surface for tickets that an external
tracker owns. People capture and organize work, write context, and visualize Plans
in the desktop application; agents create tickets, report progress, and retrieve
bounded context through the CLI. Coding agents keep their own reasoning, skills, and
tool loops, whether the person runs them in an external harness or in a native Chat.

ticketd does not replace coding harnesses, IDEs, or execution environments, and it
does not schedule agents or summarize, prioritize, or decompose tickets by itself.

## Principles

- **The user stays in control.** Tickets express intent, scope, and expected
  outcomes. People and agents manage statuses themselves, including completion, and
  review is optional. Recording work needs only a title.
- **Fit existing workflows.** The CLI is the agent interface; MCP is not required.
  The CLI bundles version-matched guidance (`ticketd skills get`) and can install a
  portable discovery skill (`ticketd skills install`). Guidance teaches commands,
  data semantics, and recovery, not how to write tickets or run development.
- **Shared core.** The desktop and the CLI call the same core for business rules,
  context queries, and consistent writes. ticketd never owns provider credentials or
  replaces a harness's sign-in.

## Updates

The desktop checks GitHub for newer stable releases and verifies downloads before
offering to install them on a restart you confirm. On macOS and Windows, a verified
update also installs when you quit ticketd, unless it changes the workspace format. In **Settings → About**, you
can turn off scheduled checks or check on demand. The CLI bundled with the
desktop updates with it. Standalone CLI copies are updated by hand.
See [in-app updates](install.md#in-app-updates).

## Product model

### Workspace, projects, and Plans

- One local Workspace contains projects, Plans, tickets, Documents, Activities,
  Chats, and their shared tag vocabulary. It lives in the operating system's
  application-data directory, outside repository checkouts. `ticketd workspace`
  prints its path and format versions.
- A **Project** represents one repository, not a grouping of work. Its explicit
  identity survives repository moves and renames, and several local checkouts may
  refer to it. Registered checkout paths locate projects without implying Git
  integration. A ticket optionally links to one project ("No project" is valid).
- **Project context** is local to each UI or CLI interaction. An explicit selection
  takes precedence; the CLI otherwise infers the project from a registered checkout
  that contains the current directory. With neither, new tickets stay unlinked.
- A **Plan** is a named grouping of tickets pursuing a shared objective, potentially
  spanning projects. A ticket optionally belongs to one Plan. A Plan needs only a
  name and may have a short purpose, one spec Document, and supporting Documents.
- A Plan is Active or explicitly Archived. Archiving hides it from active Plan views;
  its tickets remain searchable and editable with statuses and relationships
  unchanged. Reactivation is supported. Archiving is never automatic, and linking,
  hierarchy, and dependencies never add a ticket to a Plan.
- Plan progress is a count by status of all non-trashed member tickets, parents and
  subtickets equally. It is not a completion percentage. Canceled and Duplicate stay
  visible as their own counts.

### Tickets

- There is one work-item type: **ticket**. Tags such as bug, research, or feature
  provide categories; there is no mandatory issue-type system. Tags come from a
  shared Workspace vocabulary and are independent of other relationships.
- Only the title is mandatory; project and Plan links are optional. A ticket
  describes an intended outcome, even when it has subtickets.
- A **Ticket reference** is short and unique across the Workspace: `T-`, the
  creating installation's two-letter device code, and that device's counter, for
  example `T-KQ43`. A reference never changes, including when project or Plan links
  change. A plain number such as `T-42` is not a reference. The one exception to
  uniqueness is a Workspace file copied by hand, until sync detects the copy
  ([ADR 0011](adr/0011-markdown-file-sync-through-google-drive.md#identity)).
- Descriptions are Markdown with checklists. Checklist items have no independent
  status or dependencies, and unchecked items do not prevent Done. Acceptance
  criteria are written in the body; there is no separate field.
- **Activities** are timestamped, editable, deletable updates with a required
  human-readable brief and an optional supporting Document. The editing agent is
  recorded when supplied; ticketd stores no human names. Attribution is descriptive,
  not verified identity or authorization.
- **Ticket history** is automatic and separate from authored Activities. It records
  status, relationship, project and Plan membership, and trash and restore changes.

### Hierarchy

- A ticket may have one level of subtickets; a subticket cannot have its own.
- Hierarchy and dependencies are separate relationships. Neither creates the other.
- Parents and subtickets are ordinary rows in the same flat list; users need not
  expand a parent to find its subtickets. A subticket shows its parent link, and
  lists can filter to a parent and its subtickets (`--family` in the CLI).
- Parent and subtickets may link to different projects and Plans, and nothing
  cascades: a parent may be Done with open children, and completing children does not
  complete the parent.

### Dependencies

- `A blocks B` is the same as `B is blocked by A`. Dependencies are added and
  removed from the UI and the CLI and may connect tickets across projects.
- Self-dependencies, cycles, and duplicate edges are rejected, consistently under
  concurrent writes.
- Readiness guides selection; unresolved dependencies never prevent starting or
  completing work. Dependencies remain after completion, so readiness is recalculated
  if a prerequisite reopens.

### Status and derived availability

| Stored status | Meaning                                            |
| ------------- | -------------------------------------------------- |
| Todo          | Work has not started                               |
| In progress   | Work is underway                                   |
| In review     | Implementation is finished; review is pending      |
| Done          | Work is complete and no further review is required |
| Canceled      | Work will not continue                             |
| Duplicate     | The same outcome is represented by another ticket  |

People and agents move locally owned tickets between these statuses directly.
Review may be skipped. Transitions are recorded in history and never change related
tickets. Marking a ticket Duplicate follows [Duplicates](#duplicates).

**Ready** and **Blocked** are derived, never stored:

- Ready is a Todo ticket outside the trash with no unresolved blocking dependency.
- Blocked is a Todo ticket outside the trash with an unresolved blocking dependency.
- In progress, In review, Done, Canceled, and Duplicate tickets have neither
  indicator, and neither does a trashed ticket, whatever its status. Their
  dependency lists still show unresolved prerequisites.
- Only a Done prerequisite satisfies a dependency. In review, Canceled, and
  Duplicate prerequisites stay unresolved: remove an obsolete dependency or replace
  it with the right one; cancellation does not resolve it.
- Reopening a prerequisite recalculates availability for Todo dependents; started
  dependents keep their status. Trashing a Done prerequisite leaves it satisfied;
  trashing an unfinished one leaves it unresolved.

### Trash

- Tickets can be trashed and restored; permanent deletion is not supported. Identity
  and relationships are preserved. Trashing a parent leaves its children visible, with
  a link naming the trashed parent.
- A trashed ticket must be restored before its content, status, or relationships
  change, except that a visible ticket may remove its relationship to a trashed one.
  An unresolved trashed prerequisite is shown explicitly on its dependents.
- Hierarchy and dependency validity still apply across trashed tickets, so restoring
  cannot introduce an invalid relationship.

## Primary workflows

**An agent creates a plan; the person reviews it.** The person brainstorms in a
native Chat or an external harness. The agent creates tickets, tags, hierarchy, and
dependencies through the CLI, typically in one atomic batch. The person reviews the
flat list and dependency graph and edits content or relationships in the UI. The
agent reads current information before continuing.

**An agent finds work and retrieves context.** The agent queries Ready tickets for a
project, retrieves a ticket with the context it needs in one call, does the work in
its harness, and reports status, findings, and outcomes through the CLI. The UI
reflects those changes without a restart.

**A person manages work directly.** The person creates a ticket with a title, adds
content, tags, and relationships when needed, records Activities, updates status, and
opens the graph to understand dependency chains.

## Desktop views

- **List.** A flat stream with search and filters: project (including No project),
  Plan, status, tags, Ready or Blocked, parent, and ticket source. Search covers
  titles, bodies, and authored Activity briefs.
- **Board.** An alternative layout of the same collections, with six fixed status
  columns (empty ones included). Each column reads its own bounded batch, shows its
  total, and offers Load more. Dragging a card, or the Change status action, uses the
  same validation as elsewhere and implies no order within a column. There is no
  manual rank, swimlane, or custom column. List is the default, and the choice is
  remembered locally.
- **Ticket detail.** Description, Activities and history, links, hierarchy,
  dependencies, tags, Documents, attachments, evidence, reminder, and Chats.
- **Plan view.** Member tickets as a List or Board, a Flow view of dependencies,
  status counts, linked Documents, membership, and archive and reactivation.
  Dependencies from outside the Plan appear as boundary nodes, not members.
- **Editor.** Descriptions, Activities, and Documents edit in place with Markdown
  shortcuts, slash commands, checklists, fenced code, simple GFM tables, and offline
  Mermaid diagrams. Markdown stays canonical, source editing is always available, and
  viewing content never rewrites it. Descriptions autosave with visible state,
  Activities submit explicitly, and drafts survive navigation, failed saves, and
  external refresh. If saved content changes beneath a draft, the person chooses to
  reload or save over it; nothing merges automatically.

The interface follows [DESIGN.md](../DESIGN.md).

## CLI and context contract

The CLI calls the shared core directly. It needs no daemon and works with the
desktop closed. [CLI workflows](cli.md) holds worked examples; `ticketd --help` and
command-specific `--help` list every command and option, and `ticketd skills get`
prints the guide that matches the executable.

- Most data commands print JSON on stdout. Diagnostics go to stderr. Runtime
  failures exit with status 1 and argument validation errors exit with status 2.
- Agent mode never prompts. Multiline content comes from `--file`, `--body-file`,
  `--details-file`, or standard input (`-`) so it avoids shell quoting.
- Agents use the CLI and core. They do not write SQL or treat Markdown exports as the
  system of record.

For a worked example using the returned project ID and ticket reference, see
[Create a ticket and verify an update](cli.md#create-a-ticket-and-verify-an-update).

### Capabilities

Beyond the examples above, command groups cover tags (`add-tag`), parents
(`set-parent`), dependencies (`add-dependency`), trash (`trash`, `restore`), `history`,
projects, Plans, Documents, Activities, and evidence. `list` and `search` combine
filters (project, `--unlinked`, Plan, status, tag, `--availability ready|blocked`,
`--family`, `--source`) and page with `--limit` and `--offset`.

### Writes

- **Atomic batches.** `ticketd batch plan.json` (or `-` for stdin) applies a JSON
  array of `create` and `change` operations; all succeed or none persist, and an error
  names the failing operation's index. Names such as `$parent` refer to tickets
  created earlier in the batch. Requests are bounded (1 MiB, 100 operations).
- **Safe retries.** `ticketd write` runs a JSON write request with `--request-id`.
  Repeating an ID with the same content returns the original result without repeating
  changes; reusing it with different content fails. Outcomes persist atomically with
  the changes and are kept in backups. `activity add`, `activity edit`,
  `document create`, and `document change` also accept `--request-id`.
- **Field-level last write wins.** Writes need no record versions. A change updates
  only the fields it supplies, clearing is explicit, and relationship edits are
  explicit additions and removals. Optional expected values let the desktop editor
  reject a stale save ([ADR 0015](adr/0015-optional-expected-values-guard-editor-saves.md)).
- **Attribution.** `--agent` names the editing agent; a missing name does not prove a
  human made the change.

### Context

`ticketd context T-KQ42` returns one consistent read of a ticket with its derived
availability and tags. Scopes such as `--project`, `--plan`, `--relationships`,
`--activities`, `--documents`, `--backlinks`, and `--evidence` add related
information; an omitted scope is absent. Output is bounded and deterministic: lists
hold at most 20 items, text is truncated with a `truncated` flag, and `next_offset`
says how to fetch more. `plan context` does the same for a Plan. ticketd never returns
the whole Workspace by default and does not use AI to select context.

## Context management

Tickets are workable outcomes; Documents hold context. Desktop and CLI use the same
core workflows for Documents, Activities, Plans, tags, and links
([ADR 0007](adr/0007-context-storage-and-graph-queries.md)).

### Documents

- A **Document** is Markdown with its own ID, an optional title, and no mandatory
  type. Without a title, its heading is the first nonempty line (or, for activity
  details, the Activity's brief).
- Capture opens an editor at once with no required field, autosaves, and creates
  nothing if left empty. Documents opens on Recently opened with pinned items above;
  tags, pins, and links are optional.
- Documents use recoverable trash; permanent deletion is not supported. A Document can
  create a ticket and be linked to several tickets and Plans.
- CLI: the `document` command group (`create`, `show`, `read`, `change`, `recent`,
  `search`, `pin`, `tag`, `trash`, `restore`, `link-ticket`, `create-ticket`, and
  reference queries).

### Activities and activity details

- One chronological ticket feed combines automatic history events and authored
  Activities. Each Activity belongs to one ticket, and its author, including an agent,
  supplies the brief; ticketd does not generate summaries.
- Add update shows one brief editor and Add details a second; posting creates the
  Activity and its supporting Document atomically. Unposted text persists per ticket
  across navigation, failed submission, and restart. An existing Document can be linked
  instead.
- Activity details stay out of ordinary Document browsing and search until the person
  chooses Keep in Documents or sets one as a Plan spec; neither changes its identity.
  Deleting an Activity keeps its details and makes them discoverable.
- Automatic events cannot be edited individually. External source conversations are
  separate, read-only provenance.

### Plans

A Plan page shows its purpose, linked Documents, progress, and tickets. Set as spec
selects an existing Document as the Plan's principal long-form entry point without
copying it. Creating a ticket from inside a Plan makes it a member. The Flow view
adds and removes blockers and rejects cycles. CLI: the `plan` command group, including
`spec`, `document`, and `context`.

### Context graph

The graph shows tickets, Documents, and Plans and their explicit relationships. It
opens around the selected item at one hop, with search, filters, expansion, and a
connected-items list alongside; the Workspace graph opens from the sidebar. Scopes are
bounded and report omitted information by relationship group. Relationship kinds keep
distinct meanings (blocks, parent of, related, discovered, mentions, attached, in Plan,
spec of, and others; see [GLOSSARY.md](../GLOSSARY.md#language)). Tags filter or color
nodes but never create edges. Activities are not nodes: their supporting Documents
connect to the owning ticket. CLI: `ticketd graph`.

## Shipped extensions

### Attention inbox

People follow tickets to collect changes in an inbox: new authored Activities, status
changes, and relationship changes, with read and unread state and navigation to the
change. Following and read state are personal, local preferences. Sync conflicts and
due reminders also arrive here. CLI: `ticketd inbox`.

### References and contextual relationships

References in descriptions and Activities are clickable, and each ticket lists incoming
backlinks with the passage containing the reference. Related and Discovered
relationships connect tickets without affecting readiness or hierarchy
(`add-relationship`, `backlinks`).

### Bulk editing

People select tickets in the list and change status, project, or Plan, or add and
remove tags, across the selection. Each bulk edit applies atomically to every
selected ticket or to none.

### Reminders

A person has at most one reminder per ticket, with reschedule, snooze, and dismiss.
A reminder brings the ticket back to attention without changing status or
readiness. Due reminders appear in the inbox while the desktop runs, and missed ones
appear at the next start. CLI: `ticketd reminder` (`set`, `snooze`, `dismiss`).

### Duplicates

Marking a ticket Duplicate requires choosing its canonical ticket; status and
relationship change together and are recorded in history. Each duplicate points
directly to one canonical ticket, and self-links and cycles are rejected. Blocking
dependencies on the duplicate are reviewed first: each is replaced on the canonical
ticket, removed, or retained, and all decisions apply atomically with cycle
validation. Removing the designation restores the status held before. Duplicate and
Canceled blockers never satisfy their dependents. CLI: `mark-duplicate`,
`preview-duplicate`, `remove-duplicate`; see [CLI workflows](cli.md#duplicates).

### Implementation evidence

People and agents attach named evidence to a ticket: pull request URLs, commits,
branches, worktree paths, and verification results. CLI: `ticketd evidence add`,
`edit`, `delete`, and `list`; `context --evidence`. Evidence is explicit; ticketd does
not synchronize with branches, worktrees, or CI.

### Local attachments

An **Attachment** is a reusable file identity within one Workspace, stored as an
immutable local snapshot with its original bytes, filename, size, and a separate
display name. The default per-file limit is 100 MiB (Settings > Attachments).

- Files attach to a ticket from its property rail, or insert into any editor as
  Markdown links (`ticketd://attachment/<workspace-id>/<attachment-id>`) by file
  selection, drop, or screenshot paste, with per-file progress, Cancel, and Retry.
- The Attachments library searches names, filenames, IDs, and sizes, with All files,
  In use, and Unused filters. Images, video, and audio preview locally.
- Cleanup is explicit and reversible: unused files move to quarantine, can be
  restored, and are removed only by a confirmed purge that rechecks every protecting
  reference (saved references, drafts, Undo, Trash).
- **Export Markdown with files** writes Markdown, referenced snapshots, and a
  manifest into a new folder ([export](export.md)). Backups carry every retained file.
- CLI: the `attachment` command group (`add`, `list`, `search`, `link`, `detach`,
  `export`, `usage`, `quarantine`, `purge`, and more).

### Google Drive references and uploads

Authorization uses ticketd's Google app registration and the `drive.file` scope, so
only files the person selects are accessible. Credentials stay in the operating
system's secure store.

- **References.** The attachment picker has a Google Drive tab. A reference points at
  current Drive content, not a snapshot; Docs, Sheets, and Slides open in Drive.
  Last-known metadata survives offline and provider failures, and each access failure
  has its own recovery. Removing a reference never deletes the Drive file or changes
  sharing. CLI: `attachment drive-add`, `drive-resolve`, `drive-authorize`.
- **Uploads.** Settings > Attachments sets one upload destination: the local Workspace
  or a writable Drive folder. Each upload keeps its destination through retry and
  restart, and a provider failure never silently falls back to local storage. Uploads
  are durable operations whose retry verifies provenance, size, and digest. An
  uploaded copy is not an immutable snapshot: ticketd compares its checksum and size
  and exports its bytes only when they verify. CLI: `attachment destination`,
  `drive-upload`, `drive-upload-status`.
- Backups keep remote metadata and operations, never remote bytes or credentials.

### Ticket sources

A ticket source connects an external tracker; GitHub Issues is the provider
([ADR 0006](adr/0006-external-ticket-authority.md)). The first connector is built in
and run through a shared extension interface.

- Discovery rules (selected repositories, optional assignee and label filters) can be
  previewed before saving, and matching issues are imported automatically. Refresh runs
  at desktop startup, periodically while the desktop is open, and on demand
  (`ticketd source refresh`). Synchronized content stays available offline.
- A synchronized ticket is **externally owned**: its title, description, and status
  are read-only and flow one way, from the tracker into ticketd. Plan membership,
  relationships, tags, Activities, and Documents stay local and are never overwritten.
  GitHub issue state maps to status: an open issue starts as Todo, a completed
  closure is Done, not-planned is Canceled, and duplicate is Duplicate. While the
  issue stays open, people and agents manage Todo, In progress, and In review
  locally without writing to GitHub. A reopened issue returns to Todo.
- A **locally owned** ticket in Todo, In progress, or In review can be published once
  as a normal issue. Preview shows exactly what would be sent; ownership transfers
  only after ticketd confirms the issue exists, and an uncertain result is resolved
  before any retry so no second issue is created. Local Activities, Plan membership,
  dependencies, and subtickets are not published, and workspace-only attachment
  links block publication until removed. Ongoing synchronization is inbound only.
- If a source ticket becomes unavailable, ticketd keeps its content and local work and
  warns; **Take ownership** makes it local and stops synchronization.
- CLI: the `source` command group (`save`, `refresh`, `take-ownership`,
  `publish --preview`, `resolve`, and more).

### Workspace sync

A person using ticketd on several desktops gets the same Workspace content and
managed Attachments on each through their own Google Drive. Every desktop keeps its
own local Workspace and stays usable offline. There is no ticketd account, server, or
subscription ([ADR 0011](adr/0011-markdown-file-sync-through-google-drive.md);
[sync file format](sync-file-format.md)).

- **Storage.** One visible Drive folder holds one Markdown file per ticket, Document,
  Plan, and project; a ticket's Activities and evidence are sections of its file.
  Attachments are ordinary files. Content is stored unencrypted, and the live SQLite
  database is never synchronized. Inbox read state, checkout paths, credentials, source
  settings, window layout, drafts, and upload queues stay local.
- **Setup.** After connecting Drive, the person uploads this Workspace or downloads an
  existing one (after a safety backup). Independent Workspaces are never merged
  automatically. A joining desktop takes a fresh device code when needed so references
  never clash. Disconnecting deletes nothing, and the same account can reconnect to
  its folder. Restoring a backup disconnects the Workspace from Drive.
- **When it runs.** While the desktop is open: at launch and reconnect, by polling
  Drive (every minute by default), shortly after a save, and on Sync now. Exit makes a
  bounded attempt to upload pending changes. The CLI never contacts Drive; its changes
  upload when the desktop next runs. Local saving continues through outages and
  expired authorization.
- **Conflicts.** Each desktop compares both sides with its last-synced copy. Different
  fields combine; tags and other sets combine additions and removals. If the same
  field changed on both, the local value is kept and the record is marked Needs
  review, with a side-by-side comparison (also reachable from the inbox). Text is
  never merged automatically. A dependency loop formed by two desktops drops the later
  dependency everywhere, with a notice. No conflict copies are created.
- **Deletion.** Sync never deletes a record; Trash is a synced field. A missing file or
  failed authorization is never a deletion, and unreadable or newer-format files are
  skipped with a Needs attention notice.
- **Version history.** Each desktop keeps the previous version of a ticket or Document
  whenever an edit or incoming sync replaces it, for 30 days. A History view compares
  versions, and restoring one is an ordinary edit.

### Backup, restore, and export

`ticketd backup PATH` saves a consistent backup including every retained local file.
`ticketd inspect-backup` verifies integrity and checksums without restoring, and
`ticketd restore-workspace` restores after saving a safety copy (with `--target`, into
a separate database). The desktop offers the same review and restore, and missing or
damaged bytes block restoration before the current Workspace changes. `ticketd export`
writes a portable JSON snapshot, and `ticketd export-markdown` writes Markdown with
files ([export](export.md)). Backups and exports never contain credentials or remote
file bytes.

### Native Chats

Native Chat is experimental and off by default (Settings > Chat). A Chat hosts the
person's own installed Claude Code or Codex harness with its own sign-in. ticketd
detects the installation and guides the person to the harness's login; it does not
collect OAuth tokens, proxy model requests, or change billing.

- **Identity.** A Chat is a standalone Workspace conversation that can start without a
  project or ticket and link to several projects, tickets, and Documents without being
  owned by any. It keeps the harness it was created with and needs an execution folder
  (an existing one or a persistent managed one). Ticket detail lists a ticket's Chats.
  Before sending, the person picks the harness and, from what it reports, its model,
  effort, and permission mode. Full access, where the harness edits and runs
  commands without asking, is one of those modes for Claude Code and Codex; it is
  never given to an Automation's agent.
- **Conversation.** The UI streams responses, tool activity, native approval requests,
  and questions. Observed activity is Idle, Working, Waiting for you, Interrupted, or
  Failed; a finished turn is not evidence that the task succeeded. Sending during a
  turn steers it where the harness supports that, otherwise the message is visibly
  queued. ticketd owns the queue. Stop pauses it and requests interruption without
  claiming every tool stopped.
- **Lifetime.** Execution belongs to the desktop backend, not the view: navigating away
  keeps work running, and explicit Quit stops it. One ranked status per Chat drives
  the list, sidebar count, app-icon count, and system notifications, which can be
  muted.
- **Durable results.** The records, not the transcript, are the shared context. Agents
  read linked records and write progress back through the CLI as ordinary Activities,
  Documents, evidence, and status changes under native permission rules. Messages never
  become Activities or Documents automatically; Save as Document is offered.
- **Retention and recovery.** History and queued input are saved automatically. Archive
  hides a Chat while work continues; trash stops work and is recoverable. Backups
  include Chat records but not harness credentials or native resume files. Uncertain
  deliveries are never resent automatically.

### Automations

Automations belong to the experimental Chat feature and appear in Settings only while
Chat is on ([ADR 0012](adr/0012-automations-on-a-workspace-event-log.md)). An
**Automation** is a Workspace record with one trigger, conditions that must all pass,
and a flow of steps that can branch.

- **Triggers.** A ticket is created or updated, changes status, gains or loses a tag,
  or receives an authored update; or the Automation runs on a schedule or by hand.
  Triggers read a persisted, device-local Workspace event log, and changes that
  arrived through Workspace sync start nothing.
- **Steps.** Change ticket (set status, add or remove a tag, post an update), Notify
  me, If, and steps that run an **Automation agent**: a named definition of harness,
  model, instructions, allowed tools, and turn and time limits, run in its own Chat.
- **Runs.** A run records its event, steps, outcome, and each agent step's Chat. Runs
  are local to the device that ran them, and an Automation is switched on or off per
  device.
