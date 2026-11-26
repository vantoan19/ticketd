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
  refer to it. Registered checkout paths locate projects and can suggest a Project
  remote from Git configuration. Git is optional. A ticket optionally links to
  one project ("No project" is valid).
- **Archived Projects** leave active navigation and stay visible under Projects
  → Archived. Archive works with open tickets and keeps the Project's identity,
  settings, and links, including links on tickets in Trash. Open tickets from the
  Archived view to continue work on existing tickets. Reactivate a Project to
  change its settings. Both desktop actions offer Undo.
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
  details, the Activity's brief). A Document may also carry a **summary**: one
  plain line written by its author (`--summary` on `document create` and `document
change`; an empty value clears it) or by a person in the reader's Edit mode. The
  reader shows it under the meta line. ticketd never writes one.
- Capture opens an editor at once with no required field, autosaves, and creates
  nothing if left empty. Documents opens on **Current work** with pinned items above:
  the Documents of Active Plans and open tickets, one group per Plan, each Plan's spec
  first, then "Open tickets", with "Finished work" and "No Plan or ticket" closed below
  and read when opened. Recent (by recently opened, recently updated, or title) stays one
  click away; the view and which groups are open are remembered on this computer. Tags,
  pins, and links are optional.
- Searching Documents shows where each result matched: **Titles** (the title holds every
  word) first, then **Inside Documents** with the matching passage under the title. The
  words are marked with a fill and an underline, each group shows its count, and the
  search field shows the total.
- Reading a long Document: an outline of its headings opens from the right edge, and
  each h2 and h3 can be folded to its first sentence, one at a time or with Fold all
  in the outline. Folds are kept per Document on this computer, never change the
  Markdown, and editing shows everything.
- A Document can be read at full width: the reader's button hides the list, and the
  choice is remembered on this computer. The header then shows "N of M" with Previous
  and Next Document buttons that follow the list as it shows (the chosen view and its
  order), and the outline becomes a rail beside the text with the sections, Fold all,
  Back to top (once scrolled) and the Document's Linked Plans and tickets, all kept in view; once everything is folded, the rail shows how many sections are folded and Unfold all instead of the list. Narrow windows keep taking
  turns between the list and the reader.
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

GitHub Issues is built in. Linear ships with the desktop app as a ticket
source extension. Extensions use the same ticket authority and refresh
workflows as GitHub. [External ticket authority](adr/0006-external-ticket-authority.md)

Install another extension from a local folder with `ticketd source extension add PATH`.
Review the program and declared hosts before approving. The provider then
appears in Settings → Sources. Authors can link their build folder with
`ticketd source extension link PATH`. The author guide covers the contract,
the TypeScript example and conformance. [Write a ticket source extension](ticket-source-extensions.md)

- Connect your **Linear** teams with
  a personal API key that can read them. Filter discovery by assignee, labels, or
  project. ticketd syncs the issue's current state and its comments and
  timeline.
- Add and name source connections under Settings → Sources. Several accounts can
  connect to the same provider. Connections stay on this device and are excluded
  from Workspace sync, portable backups, and JSON exports.
- Extension credentials go in the system keychain. When a tracker rejects
  authentication, **Needs sign-in** opens the credential fields for that
  connection. On Linux without a usable keyring, ticketd keeps entered
  credentials until the current process closes and displays a notice.
  [Credential setup](ticket-source-extensions.md#supplying-credentials) covers
  environment overrides and password commands.
- Preview discovery rules before saving. The available rules depend on the provider.
  Matching issues are imported on refresh, which runs at desktop startup,
  periodically while the desktop is open, and on demand
  (`ticketd source CONNECTION refresh`). When connections overlap, one ticket is
  imported and refreshed through one connection. When no local connection covers
  a ticket, it shows its last synced content and says the provider isn’t connected
  on this desktop. The ticket carries the provider’s display name and icon.
  During a manually started refresh, **Cancel sync** is available in Settings → Sources.
- An **externally owned** ticket receives its title, description, confirmed closures
  and reopenings from the tracker. Progress on open issues, Plan membership,
  relationships, tags, Activities, and Documents stay in ticketd.
  A source reports a typed state category and its own name for the state. Every
  non-terminal state is open and imports as Todo. A completed issue is Done, a
  not-planned issue is Canceled, and a duplicate is Duplicate. An unknown state
  gets flagged and keeps the ticket's status. While the issue stays open, people
  and agents manage Todo, In progress, and In review in ticketd. A reopened
  issue returns to Todo. The detail shows the tracker's state name alongside
  ticketd's status, for example “GitHub: Closed (not planned)”.
- A **locally owned** ticket in Todo, In progress, or In review can be published once
  through a connection that supports publication. The preview shows exactly what
  would be sent. When the selected connection lists the ticket's Project remote
  on the matching host, the preview selects that repository. You can choose
  another allowed destination. Using the Project remote as the default requires
  the preview's fingerprint. Ownership transfers after ticketd confirms that the
  issue exists. Resolve an uncertain result before retrying to avoid creating a
  second issue. Local Activities, Plan membership,
  dependencies, and subtickets are not published, and workspace-only attachment
  links block publication until removed. Ongoing synchronization is inbound only.
  Linear publishes to one of the connection’s selected teams. Desktop shows the
  team name and key. On the CLI, pass the team UUID from `--preview` as
  `--destination` when more than one team is configured. The Linear key must
  allow issue creation.
- Recovery of an unresolved GitHub publication uses the original host. If the
  original connection is unavailable, the CLI can attach a verified issue
  through an explicitly selected connection on that host.
  [Recover an unresolved publication](cli.md#recover-an-unresolved-publication)
- If an issue disappears or becomes unavailable, ticketd keeps its status, content,
  and local work and shows a warning. **Take ownership** makes it local and stops
  synchronization.
- A legacy GitHub ticket with an unverified host can hold a potential duplicate
  import until you confirm the issue's current URL on its original host. This
  repairs the link on the existing ticket and preserves its ownership.
  [Recover a legacy GitHub issue link](cli.md#recover-a-legacy-github-issue-link)
- A saved connection remains in Sources when its extension is uninstalled.
  You can rename or remove it while the extension is unavailable.
- Remove a connection in Settings → Sources or with
  `ticketd source CONNECTION remove`. Its tickets keep their external identity,
  last synced content, status and local work, and show **Connection removed** on
  this desktop. Discovery of the same issue through a covering connection resumes
  sync unless you took ownership. Any unresolved publication stays recorded
  and continues to block a second create.
- Extension stderr stays in bounded local logs with known credentials redacted.
  The Diagnostics export includes line counts from recent source connection logs.
- Use `ticketd source add PROVIDER` to add a connection and `ticketd source list`
  to find its ID. When several connections can publish, pass
  `ticketd source publish T-XYZ --connection CONNECTION --preview`.

#### Project remote routing

A newly imported GitHub issue is linked to the active Project whose Project remote
matches its repository, including the host. The ticket arrives in No project
when no Project claims the repository or the Project is archived. An archived
Project keeps its claim, and discovery and refresh continue. Reactivating the
Project resumes routing future imports and preserves earlier assignments. When
import links a Project, it records a Project membership change in the ticket's
history. Project links remain locally editable.
When GitHub confirms a transfer to another repository, refresh follows the issue
on the same ticket and keeps its existing project link and local work.
Changing or clearing a Project remote affects future imports. Each device keeps
its own Project remotes alongside checkout and source settings. Workspace export
and backups include them.
[ADR 0021](adr/0021-route-external-tickets-to-projects-by-project-remote.md)

After setting a Project remote, you can pick a matching connection, review its
effect, and confirm. This adds the repository to discovery when needed and links the existing non-trashed,
unlinked tickets whose source still owns them and reports the same repository.
Backfill includes tickets outside the current discovery filters and records an
ordinary project membership change for each ticket. If the repository is already
listed, backfill works offline. If the source needs setup, the preview identifies
the repository to add. Confirming applies the reviewed changes together. If the
effect changes before confirmation, review the updated preview.

GitHub source settings show the Project each saved discovery repository routes to.
For an archived claim, the destination is No project and the preview names the
archived Project. Link an unclaimed repository to an active Project with a local
checkout and no Project remote, or create a Project from a checkout folder,
then review backfill. Removing a repository from discovery leaves its Project
remote on the Project.

### Workspace sync

A person using ticketd on several desktops gets the same Workspace content and
managed Attachments on each through their own Google Drive or their own S3 bucket.
Every desktop keeps its own local Workspace and stays usable offline. There is no
ticketd account, server, or subscription
([ADR 0011](adr/0011-markdown-file-sync-through-google-drive.md);
[ADR 0018](adr/0018-s3-sync-storage-signed-in-through-the-aws-cli.md);
[sync file format](sync-file-format.md)). A Workspace has one storage. Everything
below applies to both unless it names one.

- **Storage.** One visible folder, in Drive or under a prefix in the bucket, holds one
  Markdown file per ticket, Document, Plan, and project; a ticket's Activities and evidence are sections of its file.
  Attachments are ordinary files. Content is stored unencrypted, and the live SQLite
  database is never synchronized. Inbox read state, checkout paths, credentials, source
  settings, window layout, drafts, and upload queues stay local.
- **Setup.** Settings > Workspace sync starts with the choice of Google Drive or S3.
  After connecting, the person uploads this Workspace or downloads an existing one
  (after a safety backup). Independent Workspaces are never merged
  automatically. A joining desktop takes a fresh device code when needed so references
  never clash. Disconnecting deletes nothing, and the same account (or, for S3, the
  same bucket and prefix) can reconnect to its folder. Restoring a backup disconnects
  the Workspace from its storage. To move from Drive to S3, disconnect Drive and
  upload the Workspace to a bucket; there is no migration.
- **When it runs.** While the desktop is open: at launch and reconnect, by polling
  the storage (every minute by default), shortly after a save, and on Sync now. Exit
  makes a bounded attempt to upload pending changes. The CLI never contacts the
  storage; its changes upload when the desktop next runs. Local saving continues
  through outages and expired authorization. The status line and its states work the
  same for both storages and name the one in use.
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
  versions, and restoring one is an ordinary edit. A desktop that never had a version
  reads earlier ones from Drive's revisions or the bucket's object versions.

#### S3

An S3 bucket is a second storage for Workspace sync. It is for people who keep their
data in AWS, or in an S3-compatible service such as MinIO or Ceph, and would rather
not use a Google account. Drive references and uploaded copies stay Google Drive only.
Setup, IAM permissions and the lifecycle rule are in
[S3 sync setup](install.md#s3-sync-setup).

- **Sign-in.** ticketd uses the AWS CLI v2 (2.13 or later) the person already has and
  one of its profiles, so IAM Identity Center (SSO), assumed roles, MFA and
  credential helpers work as in a terminal. It runs the CLI for the profile list and
  short-lived credentials, keeps those credentials in memory only, asks for fresh ones
  before they expire, and stores no AWS secret: not in the operating system's secure
  store, a backup or the Workspace. It sends the S3 requests itself, never through the
  CLI. When the CLI is missing or too old, or the machine has no profile, setup says
  what to install or create (`aws configure sso` or `aws configure`), and the person
  can choose the `aws` program when it is not found.
- **Setup.** In Settings > Workspace sync the person chooses S3, picks a profile,
  chooses Sign in when the profile needs it (it runs `aws sso login`, or `aws login`
  for a profile set up that way, and opens the browser), then chooses the bucket and a
  key prefix (`ticketd/` by default). The bucket is picked from a list when the
  profile may list buckets and typed otherwise. The bucket's region comes from the
  bucket, and the endpoint of an S3-compatible service from the profile. Then Choose a
  workspace (Upload, Download, Reconnect), First sync, and In sync follow, as with
  Drive. A second desktop uses its own profile, under any name, that reaches the same
  bucket.
- **Bucket check.** Before the first Upload, Download or Reconnect, ticketd checks the
  bucket and refuses one that cannot sync safely, with a message that says what to
  fix: Versioning off or suspended, no conditional writes (a second create with
  `If-None-Match: *` must be refused), a missing permission, a KMS key the profile
  cannot use, a missing bucket, or an unsupported bucket type such as an S3 directory
  bucket. It leaves one small `.ticketd-bucket-check` object under the prefix, because
  sync never deletes. A failed check can be tried again after the fix.
- **Which services.** AWS S3, MinIO and Ceph RGW 20.x are confirmed; the MinIO
  contract tests run in CI. Cloudflare R2 (no Versioning), the Google Cloud Storage XML
  API (it ignores conditional headers) and S3 directory buckets are refused. Because a
  list of services goes out of date, every bucket is checked at setup. Reading an
  endpoint of a profile that has a `services` section needs AWS CLI 2.34.22; an older
  CLI asks the person to update it, and a profile without that section works with any
  supported CLI.
- **Folder layout.** The bucket holds the same record folders as Drive, one readable
  Markdown file per record, but keyed by GUID, since an S3 key cannot be renamed
  without deleting. The readable name is the object's download name in the console.
  Attachments over 16 MiB upload in parts and resume after an interruption from the
  last finished part. A Markdown file uploaded by hand with `aws s3 cp` counts as an
  edit from another device once it validates.
- **Conflicting writes.** A write to S3 fails instead of replacing a file another
  desktop just changed, so that change goes through the normal merge. Versioning keeps
  every version of a file, which History uses.
- **One service per bucket.** ticketd remembers which S3 service (AWS or an
  S3-compatible endpoint) the Workspace's bucket was connected through. If the
  profile is edited to reach another one, sync stops with a message that the profile
  now points to another service, and starts again when the profile points back. To
  move a bucket on purpose, Disconnect, then connect again. A Workspace connected
  before this was remembered takes the profile's service the next time sync works.
- **Ended sign-in.** When the AWS session ends (an IAM Identity Center session lasts
  8 hours by default), the status line and the Workspace sync page show Sign in to AWS
  again, with a Sign in button, and no dialog interrupts the person. Changes keep
  saving on this computer and upload after sign-in. Quitting does not wait on an ended
  session. A profile with static access keys has no session to end.
- **Connected view.** The page shows the AWS identity ticketd uses (from STS), the
  bucket, prefix and profile, and either Open in AWS console (AWS buckets) or Copy
  `s3://` address (any other endpoint), plus the desktop's own settings and
  Disconnect. A missing bucket folder, throttling and no network show the same
  recovery states as Drive, worded for S3.
- **Cost and encryption.** The person pays their provider for requests, storage and
  kept versions. Content is stored as ticketd wrote it, unencrypted by ticketd;
  encryption at rest is the bucket's configuration. A lifecycle rule that expires
  noncurrent versions after more than 30 days keeps storage and listing costs bounded
  and leaves History intact; ticketd recommends it and never sets it.

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
person's own installed Claude Code, Codex or Antigravity harness with its own sign-in. ticketd
detects the installation and guides the person to the harness's login; it does not
collect OAuth tokens, proxy model requests, or change billing.

- **Identity.** A Chat is a standalone Workspace conversation that can start without a
  project or ticket and link to several projects, tickets, and Documents without being
  owned by any. It keeps the harness it was created with and needs an execution folder
  (an existing one or a persistent managed one). Ticket detail lists a ticket's Chats.
  Before sending, the person picks the harness and, from what it reports, its model,
  effort, and permission mode. Full access, where the harness edits and runs
  commands without asking, is a choice for a person's Chat.
- **Titles.** A Chat is titled by its first line, cut at a word with "…" when it runs
  past 80 characters. A Chat started from a ticket takes the ticket's title instead of
  repeating "Work on T-12:", and the linked chip then shows the reference alone.
  Existing Chats read the same way; nothing stored is rewritten. A row's second line
  says what the Chat last did (the first sentence of its last turn's records row, where a
  ticket's status moves read as the net move; else the files it changed, or the first
  words of its reply), and "Working" while it runs.
- **Folder choice.** New Chat offers locally registered Project checkouts,
  recent folders, a Scratch folder, and the system folder chooser. If a Chat's
  folder goes missing, it can continue in another Project checkout or a folder
  chosen through the system chooser.
- **Codex composer.** Type `$` to find enabled skills for the Chat's folder.
  Choosing a skill inserts its mention into the draft. At the start of a draft,
  `/` offers the model picker and, when available, the permissions picker.
- **Antigravity.** The person's installed `agy` serves the Chat over ACP. New
  Chats use Antigravity settings by default. Permission choices come from
  the harness, with a native Full access flag that takes effect after a
  restart and resume. Antigravity is available for Chats a person drives.
  A Chat resumes through Antigravity's native history. If that history is
  unavailable during ordinary resume, ticketd shows a notice and starts an
  empty session. If a permission change required the restart, the queue
  stays paused and the person can explicitly choose **Start fresh**.
  See [ADR 0025](adr/0025-antigravity-uses-acp-for-person-driven-chats.md).
- **Conversation.** The UI streams responses, tool activity, native approval requests,
  and questions. Observed activity is Idle, Working, Waiting for you, Interrupted, or
  Failed; a finished turn is not evidence that the task succeeded. Sending during a
  turn steers it where the harness supports that, otherwise the message is visibly
  queued. ticketd owns the queue. Stop pauses it and requests interruption without
  claiming every tool stopped.
- **Working turns.** A turn's progress notes (what the harness says while it
  works) stay in the transcript as lines of its story, and the steps between two
  notes fold into one row each, such as "Read 6 files and ran 3 commands", with
  "· 1 failed" when a step failed. A stretch already done when the Chat opens
  starts folded. The stretch in progress stays open, and one that finishes while
  someone is looking at it folds only after it has left the view, so nothing above
  the newest line moves. What the person opens or closes stays that way for the
  session. When the turn ends its work line folds the notes and stretches together;
  opened, it shows the notes and stretch rows, and a stretch opens to its steps. A
  harness that writes no notes has one stretch per turn, shown as its one stretch
  row, which opens to its steps.
- **Steps.** Each tool call reads as one line in the words of what it did. When Claude
  Code describes a command, the row reads that description and opens to the exact
  command and its output; any other command reads as its first line, muted and cut to
  one line. Paths show their folder muted before the file name, and a long path is cut
  from its start, never its name. A run of reads and searches is one row, "Explored 6
  files · 2 searches". The Chat host reads the description from the stored tool input
  each time the view is built, so existing Chats read this way with no migration
  ([ADR 0022](adr/0022-harnesses-plug-into-ticketds-chat-vocabulary.md)).
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
