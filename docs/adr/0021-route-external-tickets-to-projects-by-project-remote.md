# Route external tickets to projects by Project remote

## Decision

A project can claim one hosted repository by its Project remote,
`host/owner/name`. Each remote can belong to one project in a Workspace.
The match ignores case and includes the host so that GitHub Enterprise and
public GitHub repositories can share an owner and name.

When discovery imports a new ticket, it uses the source's reported repository
and sets the matching project in the same transaction as the import. The link
creates an ordinary project membership entry in ticket history. Tickets from
unclaimed repositories or with an unknown repository start in No project.

After import, project membership is ordinary local organization under
[ADR 0006](0006-external-ticket-authority.md). It stays as set when refresh reads
a moved issue or when a Project remote changes. The external identity keeps the
latest observed repository so a later workflow can match it offline without
changing membership during refresh.

## Trade-off

One remote per project gives discovery an unambiguous destination. A Plan can
group work across several projects. Project creation still starts with a local
checkout. Projects defined solely by a hosted repository are deferred.
