# Archive Projects without losing their identity

Archiving is a recoverable Project state. The Project keeps its identity and
existing ticket and Chat links, including links from tickets in Trash.
Workspace sync shares archive and restore as changes to the Project record.
This follows the recoverable lifecycle in [ADR 0011](0011-markdown-file-sync-through-google-drive.md).

Checkout registrations and Project remotes stay device-local and reserved while
the Project is archived. Checkout inference skips the Project. Source discovery
still imports new tickets, with No project when the matching Project is archived,
and refresh keeps the Project links of existing tickets. This narrows initial
routing from [ADR 0021](0021-route-external-tickets-to-projects-by-project-remote.md)
to active Projects.

Restoring resumes checkout inference and routing for future imports. It leaves
tickets imported during the archive where they are. Keeping the registrations
and remote claim lets restore resume routing without setup or a competing Project.

## Desktop and CLI

A Project can be archived with open tickets. Its tickets keep their status and
remain available in their usual views. The desktop moves the Project out of
active navigation and offers Undo. The Projects page lists archived Projects in
an Archived view where people can open their tickets and reactivate them.

Existing ticket and Chat links still resolve. Reactivation is required to edit a
Project's settings, assign a new ticket to it, move a ticket into it, or add a new
Chat link to it.

The CLI provides `ticketd project archive ID` and `ticketd project reactivate ID`.
`ticketd project list` lists active Projects and `--all` includes archived Projects.
`ticketd project show ID` and `ticketd list --project ID` work for archived Projects.
