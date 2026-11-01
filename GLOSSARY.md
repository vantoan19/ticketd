# ticketd

ticketd organizes intended work outcomes and the relationships between them.

## Language

**Workspace**:
The local boundary containing tickets, projects, Efforts, and their shared tag vocabulary.

**Ticket**:
A unit of work describing an intended outcome, optionally linked to one project. A ticket with subtickets still has its own outcome rather than serving only as a container.
_Avoid_: Issue, task

**Ticket reference**:
A short, workspace-unique reference to a ticket that stays unchanged when its project or Effort links change.

**Parent ticket**:
A ticket whose outcome is broken into subtickets. It may be Done while subtickets remain open, and completing all subtickets does not necessarily fulfill its own outcome.

**Subticket**:
A ticket describing part of its parent ticket's work, possibly linked to a different project or belonging to a different Effort. Its Effort membership is independent of its parent's membership.

**Blocking dependency**:
A directed relationship in which one ticket must be Done before another is considered Ready, including across projects. A canceled blocker remains unresolved until the relationship is removed; readiness guides selection without preventing work from starting.

**Ready**:
A Todo ticket that is not in the trash and has no unresolved blocking dependencies.

**Blocked**:
A Todo ticket that is not in the trash and has unresolved blocking dependencies. Started, terminal, and trashed tickets have neither Ready nor Blocked indicators; their dependency lists still show unresolved prerequisites.

**Project**:
A repository associated with tickets, with an explicit identity preserved across repository moves and renames. Multiple local checkouts of the same repository represent the same project.
_Avoid_: Work grouping

**Project context**:
The project selected for a particular UI or CLI interaction, independent of other interactions. Explicit selection takes precedence over inference from a registered checkout; without either, new tickets remain unlinked.

**Effort**:
A named grouping of tickets pursuing a shared objective, potentially spanning multiple projects; each ticket belongs to at most one Effort and membership is optional. An Effort is Active or explicitly Archived, with progress expressed as counts by status of all non-trashed members, including parents and subtickets equally.
_Avoid_: Work, initiative

**Archived Effort**:
An Effort removed from active Effort views that can be restored to Active. Its tickets remain searchable and editable, with their statuses and relationships unchanged.

**Trashed ticket**:
A ticket removed from ordinary lists and work selection while preserved for restoration along with its relationships; permanent deletion is not supported. Trash leaves completion unchanged: Done prerequisites remain satisfied, unfinished prerequisites remain unresolved, and children of a trashed parent remain visible.

**Restoration**:
Returning a trashed ticket to ordinary visibility. A trashed ticket must be restored before editing, except that visible tickets may detach relationships to it; hierarchy and dependency validity continue to apply while tickets are in trash.

**Ticket status**:
The recorded state of a ticket: Todo, In progress, In review, Done, or Canceled. People and agents may change directly between any statuses without automatically changing related tickets.

**In review**:
A ticket status indicating that implementation is finished but review is pending. An In review ticket remains an unresolved blocker for its dependents.

**Done**:
A ticket status indicating that its work is complete and no further review is required.

**Canceled**:
A ticket status indicating that its work will not continue. Cancellation does not satisfy its dependents' prerequisites.

**Note**:
An editable, deletable, timestamped progress update or finding attached to a ticket. The editing agent is recorded when supplied; human names are not recorded in the MVP.

**Editing agent**:
The agent identified as the source of a write when supplied. This is descriptive attribution, not a verified identity or permission; absent attribution does not establish that a human made the change.

**Ticket history**:
An automatic record of changes to a ticket's status, relationships, project or Effort membership, and trash or restoration state. It is distinct from authored notes and does not imply a full history of body revisions.

**Checklist item**:
A checkable item within a ticket's Markdown content, without independent status or dependencies. Unchecked items do not prevent ticket completion.

**Tag**:
A label from a shared workspace vocabulary used to classify tickets across projects and Efforts. A ticket may have multiple tags independently of its other relationships.

**Followed ticket**:
A ticket a person has explicitly selected to receive changes about in their attention inbox. Following is personal to that person.

**Attention inbox**:
The person's collection of changes on followed tickets, with read and unread state.

**Ticket backlink**:
An incoming reference from another ticket's description or note, including the passage containing the reference.

**Related tickets**:
Tickets connected by shared context without implying a blocking dependency or parent/subticket relationship.

**Discovery relationship**:
A directed relationship recording that a ticket was discovered while working on another ticket. It does not affect readiness.

**Ticket reminder**:
A person's request to bring a ticket back to their attention at a chosen time, independent of its status and readiness.

**Duplicate ticket**:
A ticket recognized as describing the same intended outcome as a canonical ticket, with its own identity and history preserved.

**Canonical ticket**:
The ticket selected to represent an intended outcome shared by duplicate tickets. It is the direct destination of those duplicate relationships and is not itself a duplicate.

**Implementation evidence**:
Named material associated with a ticket that locates its implementation or records verification, such as a pull request, commit, branch, worktree, or verification result.
