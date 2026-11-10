# Context, Documents, Activities, and Plans

## Bounded reads

```sh
ticketd context T-1 --project --plan --relationships --activities --documents
ticketd context T-1 --latest-update --evidence
ticketd document read DOCUMENT_ID --limit 4096
ticketd document show DOCUMENT_ID
```

Select only relevant scopes. An omitted context scope is absent; a selected but
unlinked item is null. Context lists contain at most 20 items. Follow each list's
`next_offset` using `--offset`; that offset applies independently to every selected
list, not to a single combined stream. Later calls can reflect intervening edits.
Text objects advertise `truncated`; ticket bodies and Activity briefs are capped
at 4096 characters, most other text at 256, and latest-update briefs at 1024.

For full content, use `show T-1`, `activity show T-1 ACTIVITY_ID`, or `document show
DOCUMENT_ID`. `document read` paginates body text using character offsets and its
returned `next_offset`. Reassemble a complete, current value before editing; a
truncated excerpt must never become a replacement body. `document open` additionally
records recency, while `show` just reads the Document after opening the workspace.

## Documents and Activities

```sh
ticketd document create --title "Example document" --body-file detail.md
ticketd document search "search text" --limit 20
ticketd document link-ticket DOCUMENT_ID T-1
ticketd activity add T-1 --brief "Example update" --document DOCUMENT_ID --agent agent-name
ticketd activity list T-1 --limit 20
```

A Document has its own returned ID and Markdown body. A ticket reference such as
T-1 is not a Document ID. `document link TARGET` prints canonical Markdown for an
existing ticket, Document, or Plan; use it to reference items in content.
`document link-ticket` explicitly attaches a Document without editing the ticket
description; `unlink-ticket` removes that attachment, not authored mentions.

Activities require a brief: `--brief TEXT` or `--file PATH` (`--brief-file` is an
alias). `--details-file PATH` creates a new supporting Document; `--document ID`
attaches an existing one. Those two options are mutually exclusive. Supply files
when both brief and details need multiline input; they cannot both consume stdin.
Authored Activities are editable/deletable; automatic history is read using
`history T-1`. Activities alone do not change status or readiness.

Generated Activity details are omitted from ordinary Document browsing unless
kept. Use `document search QUERY --include-support` or `document recent
--include-support` to include them. `document keep`, linking them to a ticket,
or designating them as a Plan spec makes them discoverable without changing ID.
Deleting an originating Activity preserves its Document. Document trash/restore
and pin/tag commands are available under `document --help`.

For retryable Activity and Document writes and guarded body edits, load
`ticketd skills get writes`.

## Plans

```sh
ticketd plan list
ticketd plan create "Example plan"
ticketd plan add PLAN_ID T-1
ticketd plan spec PLAN_ID DOCUMENT_ID
ticketd plan document PLAN_ID DOCUMENT_ID
ticketd plan context PLAN_ID
```

A Plan groups tickets pursuing an objective; a project represents a repository.
A ticket belongs to at most one Plan, independently of its parent or project.
`plan show` includes members; `plan context` retrieves linked Documents, with
`--bodies` when their text is needed. `plan remove T-1` unlinks membership.
Omit the Document ID from `plan spec PLAN_ID` to clear the spec; use `--remove`
with `plan document` to detach supporting context. Archiving hides a Plan from
active lists, without completing, hiding, or changing its tickets. `plan list
--all` includes archived Plans; `plan reactivate` restores active visibility.

## Graphs and references

`graph T-1` shows bounded dependency data. `graph T-1 --context` shows contextual
connections; `graph --context --workspace` browses workspace context. Inspect
`graph --help` for expansion and page arguments. Respect returned limits and
continuation data instead of treating a bounded graph as complete.

`backlinks T-1` finds incoming textual references with passages. `document
references ID` and `document incoming ID` inspect outgoing/incoming links across
entity types. Relationships, references, and shared tags have different meanings:
a tag alone establishes no pairwise link or blocking dependency.
