# Tickets and relationships

## Discover and read

```sh
ticketd project list --all
ticketd list --project PROJECT_ID --limit 20
ticketd search "search text" --project PROJECT_ID --limit 20
ticketd show T-KQ1
ticketd context T-KQ1 --relationships --latest-update
```

`list` and `search` combine filters; inspect their help for status, tags, Plan,
family, source, and availability. Use `--unlinked` for tickets with no project.
Neither command infers a project from the working directory. Search is a literal
substring over saved ticket titles, bodies, and authored Activities, with ASCII
case-insensitive matching. An empty query applies only the filters, like `list`.
Normal results exclude trash. Use `--limit` from 1 to 100 (default 50). Values
outside that range fail argument validation. For the next page, advance
`--offset` by the number returned. Stop when a page is empty.

`show` returns full ticket content, relationships, and source ownership metadata.
`context` returns bounded, explicitly selected scopes; see `skills get context`.
Use `source` ownership rather than the presence of an external URL to determine
which system can edit authoritative fields; see `skills get sources`.

## Create and change

```sh
ticketd create "Example ticket" --project PROJECT_ID
ticketd change T-KQ1 --body-file description.md
ticketd change T-KQ1 --status "In progress" --agent agent-name
ticketd add-tag T-KQ1 research
ticketd remove-tag T-KQ1 research
```

Creation requires only a title. Direct `create` can also take `--plan`; without an
explicit project it checks active Projects' registered checkout paths, including
parent directories. Archived Projects keep their registrations and are skipped
during inference. Ambiguous matches fail, and no active match creates an unlinked
ticket. JSON creation and
batches require explicit `project_id` to link a project.

A title is one non-empty line of at most 1000 characters; put detail in the body. A
new tag is at most 100 characters with no commas, tabs, or line breaks. Plan names
are at most 1000 characters. Older data that exceeds these limits stays readable.

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
affected dependencies before deciding how to change them. `mark-duplicate`
refuses a source with blocking dependencies; apply your reviewed decisions with
`ticketd write` and a `mark_duplicate_reviewed` request (`docs/cli.md#duplicates`).
Canceling, duplicating, or trashing an unfinished blocker does not satisfy its
dependents.

## Write tickets people can skim

- Start the description with the intended outcome.
- Record blockers, parents and subtickets as relationships using the commands below.
- Link to supporting references and keep their details at the source.
- End the description with a `## Acceptance criteria` heading followed by one
  Markdown checklist item (`- [ ]`) per check.
- Start updates with the outcome. The card shows the first four lines.

## Relationships and evidence

```sh
ticketd set-parent T-KQ2 --parent T-KQ1
ticketd add-dependency T-KQ1 T-KQ2
ticketd add-relationship T-KQ1 T-KQ2 related
ticketd add-relationship T-KQ1 T-KQ2 discovered
ticketd evidence add T-KQ1 --kind branch --name branch --value feature/example
ticketd evidence list T-KQ1
```

The first dependency argument blocks the second. For `discovered`, the first
ticket is the work during which the second was discovered. `related` is symmetric;
neither contextual relationship affects readiness. Parent/subticket hierarchy
is separate from dependencies and supports one level. Project and Plan membership
are independent between parent and child. Detach with `set-parent T-KQ2` (no
`--parent`), `remove-dependency`, or `remove-relationship` as appropriate.

Evidence kinds include `branch`, `worktree`, `pull-request`, `commit`, and
`verification`; values are recorded text, not execution or verification by ticketd.
Use evidence IDs returned by `evidence list` for edit/delete operations.

## Projects and trash

`project create NAME PATH` creates a project and registers its existing checkout.
`project register PROJECT_ID PATH` associates another checkout with that same
project; `unregister` removes a registration. Discover existing projects before
creating one. `project create` saves a detected Project remote from `upstream` or `origin`,
with `--remote host/owner/name` to override it or `--no-remote` to skip detection.
`project edit ID NAME PATH` accepts `--remote host/owner/name` or
`--clear-remote`. Project results include `remote` and `archived`.

Use `ticketd project archive ID` to keep existing links and settings while
setting a project aside. Use `ticketd project reactivate ID` to resume active use
and change its settings. `ticketd project list --all` includes both states.
`ticketd project show ID` and `ticketd list --project ID` work in either state.
Registering a checkout with a different detected remote still succeeds and
prints a warning to stderr. Paths are native to the OS; WSL interoperability is not validated.

To connect a Project remote to GitHub discovery and backfill existing unlinked
tickets, see `project connect-source` in `ticketd skills get sources`.

`trash T-KQ1` hides a ticket while preserving its data and relationships.
`trash-list` finds hidden tickets; `restore T-KQ1` returns one to ordinary visibility.
A trashed ticket must be restored before editing. Ticket trash is distinct from
permanent deletion, Plan archiving, and workspace restore.
