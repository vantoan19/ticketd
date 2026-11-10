# Tickets and relationships

## Discover and read

```sh
ticketd project list
ticketd list --project PROJECT_ID --limit 20
ticketd search "search text" --project PROJECT_ID --limit 20
ticketd show T-1
ticketd context T-1 --relationships --latest-update
```

`list` and `search` combine filters; inspect their help for status, tags, Plan,
family, source, and availability. Use `--unlinked` for tickets with no project.
Neither command infers a project from the working directory. Search is a literal
substring over saved ticket titles, bodies, and authored Activities, with ASCII
case-insensitive matching. An empty query applies only the filters, like `list`.
Normal results exclude trash. A page holds at most 100 tickets whatever `--limit`
asks for: advance `--offset` by the number returned and stop at an empty page.

`show` returns full ticket content, relationships, and source ownership metadata.
`context` returns bounded, explicitly selected scopes; see `skills get context`.
Use `source` ownership rather than the presence of an external URL to determine
which system can edit authoritative fields; see `skills get sources`.

## Create and change

```sh
ticketd create "Example ticket" --project PROJECT_ID
ticketd change T-1 --body-file description.md
ticketd change T-1 --status "In progress" --agent agent-name
ticketd add-tag T-1 research
ticketd remove-tag T-1 research
```

Creation requires only a title. Direct `create` can also take `--plan`; without an
explicit project it checks registered checkout paths, including parent directories.
Ambiguous matches fail; no match creates an unlinked ticket. JSON creation and
batches require explicit `project_id` to link a project.

`change` updates supplied fields only, but body/title values replace the complete
field. Use full reads and the optional guards described in `skills get writes`
when editing shared text. `--clear-project` unlinks the project. A request ID is
not supported on direct `create`/`change`; use `write` for retry protection.

Statuses are `Todo`, `In progress`, `In review`, `Done`, `Canceled`, and
`Duplicate`. Only Done satisfies a blocking dependency. Ready means a non-trashed
Todo ticket with all prerequisites Done; Blocked means Todo with unresolved
prerequisites. Other statuses have neither indicator. These indicators do not
prohibit starting work. Status transitions are explicit and never cascade.

Duplicate designation also identifies a canonical ticket: use `mark-duplicate`
and `preview-duplicate`, not just a status patch. Inspect their help and preview
affected dependencies before deciding how to change them. Canceling, duplicating,
or trashing an unfinished blocker does not satisfy its dependents.

## Relationships and evidence

```sh
ticketd set-parent T-2 --parent T-1
ticketd add-dependency T-1 T-2
ticketd add-relationship T-1 T-2 related
ticketd add-relationship T-1 T-2 discovered
ticketd evidence add T-1 --kind branch --name branch --value feature/example
ticketd evidence list T-1
```

The first dependency argument blocks the second. For `discovered`, the first
ticket is the work during which the second was discovered. `related` is symmetric;
neither contextual relationship affects readiness. Parent/subticket hierarchy
is separate from dependencies and supports one level. Project and Plan membership
are independent between parent and child. Detach with `set-parent T-2` (no
`--parent`), `remove-dependency`, or `remove-relationship` as appropriate.

Evidence kinds include `branch`, `worktree`, `pull-request`, `commit`, and
`verification`; values are recorded text, not execution or verification by ticketd.
Use evidence IDs returned by `evidence list` for edit/delete operations.

## Projects and trash

`project create NAME PATH` creates a project and registers its existing checkout.
`project register PROJECT_ID PATH` associates another checkout with that same
project; `unregister` removes a registration. Discover existing projects before
creating one. Paths are native to the OS; WSL interoperability is not validated.

`trash T-1` hides a ticket while preserving its data and relationships.
`trash-list` finds hidden tickets; `restore T-1` returns one to ordinary visibility.
A trashed ticket must be restored before editing. Ticket trash is distinct from
permanent deletion, Plan archiving, and workspace restore.
