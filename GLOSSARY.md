# ticketd

ticketd organizes workable outcomes and their supporting context.

## Language

**Workspace**:
The local boundary containing tickets, Documents, Activities, projects, Plans, Chats, and their shared tag vocabulary.

**Format version**:
Which shape of Workspace file a ticketd can read. It rises with each change to what a Workspace stores. A backup restores on a ticketd with the same or newer format version.
_Avoid_: schema version

**Chat**:
A standalone conversation in a workspace, linked to a harness session. It can have optional links to multiple projects, tickets, and Documents without belonging to any one of them.

**Chat attachment**:
A local snapshot of an image or file attached to a draft, queued, or sent message in a Chat. The snapshot belongs to that Chat.

**Harness**:
The person's own installed agent program, such as Claude Code or Codex, that a Chat runs in. It owns authentication, billing, its settings and its native session; ticketd starts, supervises and answers it but never signs in for it or changes how it bills.
_Avoid_: Provider, model

**Agent**:
The interface's word for the program a harness runs, such as Claude Code or Codex, as the person meets it on Settings › Agents and in a Chat's picker. "Harness" stays the word in code, the CLI and these definitions for the same program. An Automation agent is a different thing, a saved definition of who runs a step; it and the Editing agent keep their own entries.
_Avoid_: Bot, assistant

**Model**:
The AI model a harness runs, as the harness reports it, such as Claude Opus 5.5. It names the agent on tickets. When the harness reports none, the harness name stands in. It is distinct from the Harness: one harness can run several models, and a sub-agent can run a different model from the main agent.
_Avoid_: Harness (for the model), provider

**Turn**:
One run of the harness from a message the person sent, from the main agent resuming by itself, or from ticketd waking it, until it ends: completed, failed, stopped by the person, or cut off. A turn the person did not start says who did. A steer joins the running turn instead of starting another. A sub-agent's activity never opens or ends a turn. A turn that ended is not evidence that its task succeeded.

**Step**:
One thing the main agent or a sub-agent did, in ticketd's words, whatever the harness called it. A step belongs to the agent that did it, and not necessarily to a turn: a sub-agent can keep working after the turn that started it has ended.

**Main agent**:
The agent a Chat's harness runs for the person, the one the person's messages go to. Sub-agents work for it. Say "main agent" where a harness name would be ambiguous.
_Avoid_: Parent, lead

**Sub-agent**:
An agent the Chat's harness starts by itself to do part of the work. It runs under the Chat's session, permissions and billing. It is not a Chat, and the person cannot message it. ticketd shows it, can stop it where the harness allows, and credits ticket writes to it, but never starts one. A sub-agent the main agent resumes is the same sub-agent with a new run. Background commands and monitors are Steps, not sub-agents.
_Avoid_: Subagent, helper, child, task, thread, worker

**Steer**:
A message sent while a turn runs that the harness takes into that turn, where its capabilities allow, instead of waiting for the turn to end. What steering does to running tools is the harness's own behaviour and is said before the person chooses it.

**Queue**:
A Chat's messages waiting to go out, in order, each as its own turn once the current one ends. ticketd owns the queue: it can be paused, and a queued message can be sent now. Only a message known not to have been accepted falls back from a steer into it.

**Seen and unseen**:
A turn that ended after the person last viewed its Chat is unseen until the Chat is in view again (open in the detail pane with the window focused). The position the person has seen through is stored with the Chat. Mark as unread makes the last turn unseen again and Mark as read clears it; neither notifies.

**Muted Chat**:
A Chat whose outcomes never raise a system notification or count on the app icon. It still shows its status and counts in the sidebar.

**Progress note**:
A response a harness writes while a turn is still working, with more work after it. It is the harness talking to the person as it goes, not the turn's answer: it shows in the working size and has no reply actions. The turn's last response is its final response. The steps between two progress notes (or a note and the turn's start or end) are a **stretch**, shown as one row such as "Read 6 files and ran 3 commands" that opens to its steps.

**Turn report**:
What the harness reported about a turn besides its steps and final response: its reasoning, its plan and the files it changed. Each is kept in Chat history as the harness last reported it, and what it did not report is not shown.

**Ticket**:
A unit of work describing an intended outcome, optionally linked to one project. A ticket with subtickets still has its own outcome rather than serving only as a container.
_Avoid_: Issue, task

**Open Ticket**:
The Ticket shown in the detail pane, whose details the person is viewing. It says nothing about the Ticket's status or about an external issue being open.

**Locally owned ticket**:
A ticket whose authoritative record is maintained by ticketd.

**Externally owned ticket**:
A ticket whose authoritative record is maintained by an external tracker and synchronized into ticketd, with local progress, authored activities, and organization maintained separately.

**Ticket publication**:
A one-time outward transfer of a locally owned ticket to an external tracker, after which that tracker is authoritative and changes flow into ticketd while its ticketd identity is preserved.

**Ticket source**:
The system that currently owns a ticket's authoritative record: ticketd or an external tracker.

**Ticket source extension**:
A separate program that connects ticketd to an external ticket source through a versioned contract.

**Source connection**:
A named, device-local configuration for an account and site at a ticket source extension, with its own settings and credentials.

**GitHub integration**:
The built-in issue integration on a device. It uses the GitHub CLI for sign-in and holds a list of repositories with their issue import filters.

**GitHub Project login**:
An optional GitHub CLI login that a Project selects for a particular host on this device. A Project without a selection uses the active login on that host.

**Conformance suite**:
The shared checks that verify whether a connector follows the ticket source contract.

**Source state category**:
ticketd's interpretation of a typed tracker state: open, completed, not planned, duplicate, or unknown. The source's state name is display text. Only completed, not planned, and duplicate imply a terminal ticket status.

**External ticket identity**:
The identity of a ticket's corresponding record in an external tracker, retained as provenance even when ticketd takes ownership. Its presence alone does not imply external ownership or active synchronization.

**Ticket reference**:
A short, workspace-unique label for a ticket: `T-`, the device code of the Workspace installation that created it, then that device's counter, with no dash between them (`T-KQ43`). It is stored with the ticket and never changes, including when project or Plan links change or the device later takes another code. The ticket's internal identifier, not the reference, is its identity. The one case in which two tickets can carry the same reference is a Workspace file copied by hand, until sync detects the copy ([ADR 0011](docs/adr/0011-markdown-file-sync-through-google-drive.md#identity)).

**Device code**:
Two uppercase letters identifying one Workspace installation in the Ticket references it issues, so desktops sharing a Workspace do not issue the same reference (a hand-copied Workspace file is the exception until sync detects it, see [ADR 0011](docs/adr/0011-markdown-file-sync-through-google-drive.md#identity)). It is random by default. A restored Workspace takes a fresh one, as does a desktop joining a sync folder where its code is held or was given up, and a file copy of a Workspace once sync detects that the original also syncs.

**Restore point**:
A copy of the Workspace the desktop keeps on this computer to go back to: one saved the first time ticketd opens each day, and one for each Back up now, with the last 7 kept. It sits in a folder beside the Workspace file, is checked after it is written, and shares its attachment files with the other restore points, so it restores only here. A copy saved before a restore or before an update that changes the Workspace format (a safety copy) is listed with the restore points under a label and is kept besides the 7. It differs from a backup file, which `ticketd backup PATH` writes as one standalone file that restores anywhere, and from a Version, which is an earlier state of one ticket or Document.
_Avoid_: Snapshot, auto-backup

**Version**:
An earlier state of a ticket or Document (title, body, status, trash), saved locally on the device whenever a local edit or an incoming sync replaces it. Versions are kept 30 days; the record itself is the current version and is always kept. Restoring a version is an ordinary edit.

**Workspace sync**:
Keeping one person's Workspace the same on several desktops through storage that person owns: a folder in their Google Drive, or a prefix in their S3 bucket (reached through their AWS CLI profile, with no AWS secret kept by ticketd). A Workspace has one storage at a time. Each device keeps its own local Workspace; every ticket, Document, Plan and project is also stored there as one readable, unencrypted Markdown file. An S3 bucket must have Versioning on and honour conditional writes; setup checks this before the first sync. It is distinct from the inbound synchronization of an externally owned ticket and never publishes to a tracker.
_Avoid_: Cloud sync, backup

**Last-synced copy**:
A device's own copy of a synced record as it was when that device last synchronized it. When a record changed both locally and in the sync storage, each side is compared with this copy to tell which fields each side changed. The copies are kept while a device is disconnected, so reconnecting to the same folder merges the same way.

**Needs review**:
The state of a synced record whose same field was changed on two devices. The local value is kept until the person chooses or edits the value in a comparison of the conflicting fields. Changes to different fields, and to tags and other sets, combine without review.

**Parent ticket**:
A ticket whose outcome is broken into subtickets. It may be Done while subtickets remain open, and completing all subtickets does not necessarily fulfill its own outcome.

**Subticket**:
A ticket describing part of its parent ticket's work, possibly linked to a different project or belonging to a different Plan. Its ownership and Plan membership are independent of its parent's.

**Blocking dependency**:
A directed relationship in which one ticket must be Done before another is considered Ready, including across projects. A canceled or duplicate blocker remains unresolved until the relationship is removed; readiness guides selection without preventing work from starting.

**Ready**:
A Todo ticket that is not in the trash and has no unresolved blocking dependencies.

**Blocked**:
A Todo ticket that is not in the trash and has unresolved blocking dependencies. Started, terminal, and trashed tickets have neither Ready nor Blocked indicators; their dependency lists still show unresolved prerequisites.

**Project**:
A repository associated with tickets, with an explicit identity preserved across repository moves and renames. Multiple local checkouts of the same repository represent the same project. A Project remote can identify its hosted repository.
_Avoid_: Work grouping

**Archived Project**:
A Project set aside from active use that can be restored to Active. It keeps its identity and existing links.

**Project remote**:
The hosted repository a project corresponds to, identified as `host/owner/name`. A project can have at most one Project remote, and each Project remote can belong to at most one project in a workspace. Matching ignores case.
_Avoid_: origin, git link

**Project context**:
The project selected for a particular UI or CLI interaction, independent of other interactions. Explicit selection takes precedence over inference from a registered checkout; without either, new tickets remain unlinked. The unlinked choice is shown to users as "No project".

**Plan**:
A named grouping of tickets pursuing a shared objective, potentially spanning multiple projects; each ticket belongs to at most one Plan and membership is optional. A Plan is Active or explicitly Archived, with progress expressed as counts by status of all non-trashed members, including parents and subtickets equally.
_Avoid_: Work, initiative

**Archived Plan**:
A Plan removed from active Plan views that can be restored to Active. Its tickets remain searchable and editable, with their statuses and relationships unchanged.

**Trashed ticket**:
A ticket removed from ordinary lists and work selection while preserved for restoration along with its relationships; permanent deletion is not supported. Trash leaves completion unchanged: Done prerequisites remain satisfied, unfinished prerequisites remain unresolved, and children of a trashed parent remain visible.

**Restoration**:
Returning a trashed ticket to ordinary visibility. A trashed ticket must be restored before editing, except that visible tickets may detach relationships to it; hierarchy and dependency validity continue to apply while tickets are in trash.

**Ticket status**:
The recorded state of a ticket: Todo, In progress, In review, Done, Canceled, or Duplicate. Publication preserves this status; status changes do not automatically change related tickets.

**In review**:
A ticket status indicating that implementation is finished but review is pending. An In review ticket remains an unresolved blocker for its dependents.

**Done**:
A ticket status indicating that its work is complete and no further review is required.

**Canceled**:
A ticket status indicating that its work will not continue. Cancellation does not satisfy its dependents' prerequisites.

**Activity**:
An automatic event or authored update attached to exactly one ticket. Authored activities have a required human-readable brief and optionally link to one supporting Document; they are editable and deletable. Automatic events record structured changes and cannot be edited or deleted individually. Attribution, when supplied, identifies the editing agent. The interface calls an authored Activity an update and its Activity details its details; it never says note. The command line keeps `activity`, `--brief` and `--details-file`.

**Document**:
Reusable context: a thought, draft, spec, knowledge, or supporting detail. A Document has stable identity, an optional title, Markdown content, and recoverable trash state. It can be linked from multiple tickets, Plans, and Documents without duplication. A ticket's Documents are those its description mentions plus those attached explicitly (the rail's Add, or `document link-ticket`); detaching removes only an explicit reference and never edits the description.

**Current work**:
The Documents view that opens first: a Document is current when it is attached to an Active Plan or is mentioned by or attached to a ticket in Todo, In progress or In review (a ticket in Trash does not count). It is grouped under its own Active Plan, else its open ticket's Active Plan, else "Open tickets"; within a group the Plan's spec comes first, then the most recently updated, and groups run by their newest Document. **Finished work** is what is linked but has no Active Plan or open ticket; **No Plan or ticket** is what is linked to nothing. Both are counted and read only when opened. Recent is the other view.

**Document summary**:
A Document's optional one-line plain-text statement of its outcome, written by its author (an agent with `--summary`, or a person in the editor) and never generated by ticketd. Line breaks in it become a space, and an empty value removes it. It travels in the Document's sync file beside the title and is included in exports. A Document without one shows no summary at all.

**Activity details**:
A Document created as the supporting detail of an authored Activity. Its originating Activity initially excludes it from ordinary browsing. Keep in Documents or designation as a Plan spec makes it visible without changing identity or provenance; an AI tag does not control visibility. Linking an existing standalone Document does not change its visibility. Deleting the originating Activity leaves the Document intact and discoverable in ordinary browsing.

**Attachment**:
A workspace-scoped file identity with a display name, original filename, available metadata, and storage locator. It is distinct from a Document and Implementation evidence. A local Attachment is an immutable workspace-managed snapshot; uploading a revision creates a new identity. Reusing or detaching an Attachment changes references without replacing or deleting its bytes. Files inside linked Documents stay associated with those Documents.

**External attachment reference**:
An Attachment resolving current provider content rather than a local snapshot. Google Drive references use the connected person's per-file application authorization and existing sharing permissions. Google Docs, Sheets, and Slides open in Drive without conversion. Last-known metadata survives access failures; removing a reference never deletes the remote file.

**Quarantined Attachment**:
A local Attachment whose unused bytes were explicitly moved out of active storage for reversible cleanup. Its identity and metadata remain discoverable, complete backups retain its bytes, and restoration makes the same identity reusable. Saved references, recoverable drafts, Undo and Trash protect files from quarantine. Quarantine still occupies disk space until explicit purge.

**Uploaded copy**:
An Attachment uploaded by ticketd to an explicitly selected remote folder. Its
operation, remote identity, input digest and observed checksum/version are retained
for recovery. The provider can change the content independently; an uploaded copy
does not promise preserved original bytes. A revision uses a new upload operation
and attachment identity. Cancellation and removal never delete the remote file. While
Workspace sync is on Google Drive the folder is the **Uploads** folder inside the sync
folder: the person's own files, which sync never reads, replaces or removes.

**Purged Attachment**:
A local Attachment whose quarantined bytes were permanently removed by explicit
confirmation. Its identity, names and references remain with unavailable status.
Undo cannot recover purged bytes; deliberately restoring an older complete backup
can recover the earlier workspace. A pending purge records committed intent but
unconfirmed completion and requires explicit retry, never automatic deletion.

**Recoverable draft**:
Unpublished editor content retained independently of a ticket, Document, or Activity save. Its attachment references protect files while the editor is closed. Independently recoverable Undo states have separate protection; saving or discarding the current draft does not imply permission to delete their files.

**Context graph**:
A bounded view of explicit relationships among tickets, Documents, and Plans. Activities explain ticket-to-supporting-Document connections but are not separate graph nodes. Tags classify or color items without implying pairwise links or blocking dependencies.

**Workspace graph**:
The Context graph for the whole workspace, opened from the sidebar rather than from one ticket, Document, or Plan. It is bounded and explains any limit in the same way.

**Dependencies (graph)**:
A ticket's view of the Context graph limited to "blocks": the bounded set of tickets joined to it by blocking dependencies, each marked Ready or Blocked. The interface calls the item-centred Context graph "Graph"; a ticket's Graph opens on its Dependencies.

**Graph relationships**:
Each relationship has one name, used on the line, in the legend and (capitalised) as the filter, and is read from either end with the role names below.

| Kind       | Name            | From the source | From the target           |
| ---------- | --------------- | --------------- | ------------------------- |
| blocks     | blocks          | Blocks          | Blocked by                |
| subticket  | parent of       | Parent of       | Subticket of              |
| related    | related         | Related to      | Related to                |
| discovered | discovered      | Discovered      | Discovered from           |
| mention    | mentions        | Mentions        | Mentioned by              |
| attached   | attached        | Has attached    | Attached to               |
| activity   | update mentions | Update mentions | Mentioned in an update on |
| support    | update cites    | Update cites    | Cited in an update on     |
| membership | in Plan         | Contains        | In Plan                   |
| document   | document of     | Has document    | Document of               |
| spec       | spec of         | Has spec        | Spec of                   |

**Editing agent**:
The agent identified as the source of a write when supplied. This is descriptive attribution, not a verified identity or permission; absent attribution does not establish that a human made the change.

**Ticket history**:
An automatic record of changes to a ticket's status, relationships, project or Plan membership, and trash or restoration state. It is distinct from authored activities and does not imply a full history of body revisions.

**Checklist item**:
A checkable item within a ticket's Markdown content, without independent status or dependencies. Unchecked items do not prevent ticket completion.

**Tag**:
A label from a shared workspace vocabulary used to classify tickets across projects and Plans. A ticket may have multiple tags independently of its other relationships.

**Followed ticket**:
A ticket a person has explicitly selected to receive changes about in their attention inbox. Following is personal to that person.

**Attention inbox**:
The person's collection of changes on followed tickets, with read and unread state.

**Ticket backlink**:
An incoming reference from another ticket's description or authored activity (or a Document), including the passage containing the reference. A ticket's own text is never a backlink to itself.

**Related tickets**:
Tickets connected by shared context without implying a blocking dependency or parent/subticket relationship.

**Discovery relationship**:
A directed relationship recording that a ticket was discovered while working on another ticket. It does not affect readiness.

**Ticket reminder**:
A person's request to bring a ticket back to their attention at a chosen time, independent of its status and readiness.

**Duplicate ticket**:
A ticket in Duplicate status, recognized as describing the same intended outcome as a canonical ticket, with its own identity and history preserved.

**Canonical ticket**:
The ticket selected to represent an intended outcome shared by duplicate tickets. It is the direct destination of those duplicate relationships and is not itself a duplicate.

**Automation**:
A workspace record that runs steps without the person starting them: one trigger, conditions that must all pass, then a flow of steps that can branch. It is switched on or off separately on each device.
_Avoid_: Workflow, rule

**Automation agent**:
A named, reusable definition of who an Automation step runs: harness, model, instructions, allowed tools, and turn and time limits. The interface calls it an Agent. It is distinct from the Editing agent, which is attribution on a write.

**Automation run**:
One firing of an Automation: the Workspace event that started it, the steps taken, its outcome, and the Chat of each agent step. The interface calls it a run. It is local to the device that ran it.

**Workspace event**:
A logged fact that something in the Workspace changed (for example a tag added to a ticket), with the previous and current values and who made the change: a person, an Automation, a refresh of an external ticket source, or Workspace sync applying a change from another desktop. Automations are triggered from this log by the changes a person or a ticket source made. A change that arrived through Workspace sync starts no Automation, whoever made it on the other desktop; this rule is provisional until running Automations across devices is designed. It is distinct from an Activity's automatic event, which is ticket history shown to the person.

**Implementation evidence**:
Named material associated with a ticket that locates its implementation or records verification, such as a pull request, commit, branch, worktree, or verification result.
