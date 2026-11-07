# ticketd

ticketd organizes workable outcomes and their supporting context.

## Language

**Workspace**:
The local boundary containing tickets, Documents, Activities, projects, Plans, and their shared tag vocabulary.

**Ticket**:
A unit of work describing an intended outcome, optionally linked to one project. A ticket with subtickets still has its own outcome rather than serving only as a container.
_Avoid_: Issue, task

**Locally owned ticket**:
A ticket whose authoritative record is maintained by ticketd.

**Externally owned ticket**:
A ticket whose authoritative record is maintained by an external tracker and synchronized into ticketd, with local progress, authored activities, and organization maintained separately.

**Ticket publication**:
A one-time outward transfer of a locally owned ticket to an external tracker, after which that tracker is authoritative and changes flow into ticketd while its ticketd identity is preserved.

**Ticket source**:
The system that currently owns a ticket's authoritative record: ticketd or an external tracker.

**Ticket source extension**:
A connector to an external ticket source, run by ticketd through a shared extension interface.

**External ticket identity**:
The identity of a ticket's corresponding record in an external tracker, retained as provenance even when ticketd takes ownership. Its presence alone does not imply external ownership or active synchronization.

**Ticket reference**:
A short, workspace-unique reference to a ticket that stays unchanged when its project or Plan links change.

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
A repository associated with tickets, with an explicit identity preserved across repository moves and renames. Multiple local checkouts of the same repository represent the same project.
_Avoid_: Work grouping

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
and attachment identity. Cancellation and removal never delete the remote file.

**Recoverable draft**:
Unpublished editor content retained independently of a ticket, Document, or Activity save. Its attachment references protect files while the editor is closed. Independently recoverable Undo states have separate protection; saving or discarding the current draft does not imply permission to delete their files.

**Context graph**:
A bounded view of explicit relationships among tickets, Documents, and Plans. Activities explain ticket-to-supporting-Document connections but are not separate graph nodes. Tags classify or color items without implying pairwise links or blocking dependencies.

**Workspace graph**:
The Context graph for the whole workspace, opened from the sidebar rather than from one ticket, Document, or Plan. It is bounded and explains any limit in the same way.

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

**Implementation evidence**:
Named material associated with a ticket that locates its implementation or records verification, such as a pull request, commit, branch, worktree, or verification result.
