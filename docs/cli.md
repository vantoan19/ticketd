# CLI workflows

For every command and option, use `ticketd --help` and command-specific `--help`.
The bundled `ticketd skills get` guide matches your executable version.
See [installation](install.md) and [development setup](development.md) to get started.

## Project context

Checkout registrations use native filesystem paths. Register each existing checkout
with `ticketd project register PROJECT_ID PATH` and remove obsolete registrations
with `ticketd project unregister PROJECT_ID PATH`; project identity is unchanged.
Ticket creation infers context from the invocation's current directory, including
nested directories. `--project PROJECT_ID` overrides inference. Multiple matching
projects produce an error; an unmatched directory creates an unlinked ticket.
Paths are interpreted by the native operating system; interoperability with WSL
has not been validated.

### JSON output

Agents parse command output, so its shape is the same in every command:

- Status counts use the keys `todo`, `in_progress`, `in_review`, `done`,
  `canceled` and `duplicate` (`plan show` and `plan context` alike). Ticket
  `status` values keep their display spelling, such as `In progress`.
- A write with no record to return prints `{"ok":true}`. This covers `evidence
  delete`, `activity delete`, `document tag`, `document pin` and `export --file`.
  A write that changes a record prints that record.
- Reminders print `{"reference":...,"due_at":...}` from `reminder show`, `set` and
  `snooze`, with `due_at` null when there is none; `reminder dismiss` prints
  `{"dismissed":true}` or `{"dismissed":false}`. `backup` prints `{"path":...}` and
  `restore-workspace` prints `{"restored":...,"safety_backup":...}`.
- Keys appear in the order of the record's definition, so `document keep`,
  `document trash` and `document restore` print exactly what `document show` does.
- `list --latest-update` and `search --latest-update` print `{"ticket": ...,
  "latest_update": ...}` rows. The update, with its bounded brief, appears only
  beside the ticket; the ticket inside the row has no `latest_update` of its own.

### Atomic batches

`ticketd batch plan.json` accepts a JSON array; use `ticketd batch -` to read
standard input. Every create needs a `name` and a `title`; later operations refer
to the new ticket as `$name`:

```json
[
  { "operation": "create", "name": "parent", "title": "Ship the feature" },
  { "operation": "create", "name": "child", "title": "Implement it" },
  {
    "operation": "change",
    "ticket": "$child",
    "change": {
      "parent": "$parent",
      "add_blockers": ["$parent"],
      "add_tags": ["feature"],
      "activities": ["Plan agreed"]
    }
  }
]
```

Changes also accept `title`, `body`, `status`, `editing_agent`, `project_id`,
`plan_id`, `remove_tags`, and `remove_blockers`. Set `parent`, `project_id`, or
`plan_id` to null to clear it; omit a field to leave it unchanged. Results are
JSON ticket snapshots in operation order. Failures, including a malformed operation, identify the zero-based
operation index and roll back the entire request. A failure refers to a ticket the
batch created by its `$name` (for example `$a can't block $b`), because those
tickets were never saved; tickets that existed before keep their `T-` references. Requests are limited to 1 MiB,
100 operations, and 1,000 individual edits; execution checks a 10-second limit
between operations.

### Input limits

New writes (`create`, `change`, `batch`, `write`, and the desktop app) enforce
these limits. Data saved earlier stays valid and is never rewritten.

- A ticket title is one non-empty line (no line breaks) of at most 1000 characters.
  Put anything longer in the description.
- A tag is at most 100 characters and has no commas, tabs, or line breaks. Tags are
  trimmed and lowercased. A tag that was saved before these limits can still be
  removed.
- A Plan name is at most 1000 characters. Two Plans may share a name.
- A title imported from an external source is normalized instead of refused: line
  breaks collapse to single spaces and the title is cut at 1000 characters. The
  source keeps the original text.

### Bounded ticket context

`ticketd context T-KQ1` returns JSON with the ticket, derived availability, and
its tags. Add `--project`, `--plan`, `--relationships`, `--activities`, `--documents`, or
`--backlinks` to select those scopes. An omitted scope is absent; a selected but unlinked project,
Plan, or parent is `null`. Related tickets include status and `trashed`; only
Done satisfies a prerequisite. A missing root or a missing linked project or
Plan produces an error on stderr and a nonzero exit code, with no JSON on
stdout.

Each list is ordered by ticket reference number, tag name, or Activity (newest first),
and contains at most 20 items. A non-null `next_offset` means to repeat
the command with `--offset` set to that value; the offset applies independently
to every list in the response. Each call reads one snapshot, but later pages can
reflect intervening changes. Text objects contain `text` and `truncated`:
ticket bodies and Activity briefs are limited to 4096 Unicode characters, other user text
to 256. Use `ticketd show T-KQ1` for full ticket content and `ticketd activity list
T-KQ1` for the full activity feed. The bounded body must not be used as an editable draft.

Search saved titles, bodies, and Activity briefs with `ticketd search QUERY`. The query is a
literal substring (ASCII letters match without case); a query of one or two characters
matches titles only, since bodies and briefs are searched through an index of
three-character sequences. An empty query applies only
the filters, like `ticketd list` (the desktop search box returns nothing for an
empty query). Results exclude trash and are ordered by descending ticket reference.
Use `--limit` (1–100, default 50; other values are rejected) and `--offset` for pages, and `--project ID`
or `--unlinked` to restrict results. The desktop search uses the same matching
and pages through 50 results at a time.

`ticketd backlinks T-KQ1` lists incoming references as JSON. Each entry has
`source_reference`, `source_title`, `activity_id` (null for a description),
`reported_at` (when the mentioning update was reported; null for a description),
`passage` (the source line, trimmed to 512 characters around the reference), and
`mention_start` and `mention_end`, which locate the mention in the source ticket
description or authored Activity. They count Unicode scalar values (characters, as `passage`
is), not bytes or UTF-16 units, and do not count a leading U+FEFF byte order
mark, so a Python agent can slice `body[mention_start:mention_end]` after
dropping that mark. The span is the reference itself unless its source uses
escapes or entities, in which case it is the whole text run containing it.

Contextual links can be added with `ticketd add-relationship T-KQ1 T-KQ2 related`
or `ticketd add-relationship T-KQ1 T-KQ2 discovered`. For discovery, the first
ticket is the work during which the second was discovered. Use
`remove-relationship` with the same arguments to detach a link. Related links
are symmetric; neither kind affects readiness. `context --relationships`
returns bounded pages of related tickets, discoveries, and their sources.
The JSON export includes `contextual_relationships` records. Backups retain
these links and retry outcomes; personal preferences remain scoped to
`local-person`, independently of editing-agent attribution.

### Reporting progress

Post an authored Activity when beginning work, reaching a meaningful result,
changing direction, requesting input, pausing, or handing off for review or
completion. Keep the brief readable; optional session context can go in its prose.
Activities do not change status or dependency readiness.

```sh
ticketd activity add T-KQ1 --file update.md --agent agent-name
printf '%s\n' 'Investigating the failure' | ticketd activity add T-KQ1 --file - --agent agent-name
```

For safe retries, put the following JSON in `report.json` (or pass `-` and pipe
it on stdin), then run `ticketd write report.json --request-id checkpoint-1`.
Use the same request ID and identical request for a retry; use a new ID for a
new checkpoint. A status change may be included atomically:

```json
{
  "operation": "ticket_change",
  "reference": "T-KQ1",
  "change": {
    "status": "In progress",
    "activities": ["Investigating the failure"],
    "editing_agent": "agent-name"
  }
}
```

Read one latest report with `ticketd context T-KQ1 --latest-update`; the field is
absent unless selected and null when no authored Activity exists. Use `ticketd
list --latest-update` or `ticketd search QUERY --latest-update` for filtered,
paginated ticket summaries. Briefs are limited to 1024 Unicode characters and
carry a `truncated` flag. Fetch the complete brief with `ticketd activity show
T-KQ1 ACTIVITY_ID`. Details saved with an Activity are Documents; see
[Documents](#documents).

Record optional execution evidence using `ticketd evidence add T-KQ1 --kind
branch --name branch --value feature/example`; kinds also include `worktree`,
`pull-request`, `commit`, and `verification`. For example, use `--kind
verification --name checks --value './scripts/check passed'`. Read evidence
with `ticketd evidence list T-KQ1` or select it with `ticketd context T-KQ1 --evidence`.

## Plans

A Plan groups tickets pursuing an objective, independently of a ticket's parent or
project; a ticket belongs to at most one Plan. Create and inspect Plans with
`ticketd plan create NAME`, `plan list` (add `--all` for archived ones), and `plan
show PLAN_ID`, which includes the member tickets. Add a ticket with `plan add PLAN_ID
T-KQ1` and detach it with `plan remove T-KQ1`. `plan rename`, `plan purpose`,
`plan archive`, and `plan reactivate` manage the Plan itself; archiving hides it
from active lists without changing its tickets.

A Plan can carry a spec and supporting Documents. Designate the spec with `plan
spec PLAN_ID DOCUMENT_ID` (omit the ID to clear it) and attach or detach
supporting Documents with `plan document PLAN_ID DOCUMENT_ID [--remove]`. `plan
context PLAN_ID` returns the Plan, its Documents, a status count, tickets, and dependencies
as bounded JSON; add `--bodies` to include Document text. Each Document entry has a
`fetch` command for reading the rest. A ticket's own Plan is available through
`ticketd context T-KQ1 --plan`.

## Documents

A Document is Markdown with its own ID, separate from any ticket reference. Create
one with `ticketd document create --title TITLE --body-file notes.md` (or `--body`;
`-` reads standard input). Without a title, the first line of the body is its
heading. The JSON result includes the ID; `--request-id` makes a retry safe.
`document show ID` returns the full Document and `document read ID --offset N
--limit N` returns a bounded page of its body by character offset, with
`next_offset` for the next page. Change one with `document change ID`, which accepts
`--title`, `--clear-title`, `--body`, or `--body-file`. Find Documents with
`document recent`, `document search QUERY`, `document pins`, and the trash with
`document trash`, `trash-list`, and `restore`. `document pin` and `document tag`
take `--remove` to undo.

An Activity's details become a Document too: `activity add T-KQ1 --brief TEXT
--details-file details.md` saves one, and `--document ID` attaches an existing one.
Generated details stay out of `document recent` and `document search` unless kept
with `document keep ID` or searched with `--include-support`.

To reference an item from content, print its Markdown link with `ticketd document
link TARGET` (a ticket reference, Document ID, or Plan ID). To attach a Document to
a ticket without editing its description, use `document link-ticket ID T-KQ1`;
`unlink-ticket` removes only that attachment. `document create-ticket ID TITLE`
creates a ticket from a Document and links them.

`ticketd context T-KQ1 --documents` lists the Documents related to a ticket: attached
with `link-ticket`, mentioned in its description, or mentioned in an Activity. Each
item has a `source` (`explicit`, `description`, or `update`), a `heading`, and a
`fetch` command. Add `--backlinks` to list the tickets whose descriptions or
Activities mention the ticket, in the same form as `ticketd backlinks T-KQ1`. For
links between any items, `document references ID` lists what an item links to and
`document incoming ID` lists everything linking to it; `document backlinks ID` lists
only tickets that mention a Document.

## Duplicates

`ticketd mark-duplicate SOURCE CANONICAL` sets SOURCE's status to Duplicate and
records CANONICAL as the ticket that carries the work; `remove-duplicate SOURCE`
undoes it. It refuses while SOURCE has blocking dependencies, in either direction,
because they need a decision first. A Duplicate or Canceled blocker never satisfies
its dependents.

Preview the dependencies with `ticketd preview-duplicate SOURCE CANONICAL`. The JSON
lists each `edges` entry with its `replacement_blocker` and `replacement_dependent`
on CANONICAL, the `waiting` tickets, and any `replacement_issues` (an existing
dependency, a cycle, or a trashed ticket) that stop a replacement. For each edge,
choose `replace` (move it to CANONICAL), `remove` (drop it), or `retain` (leave it
on SOURCE, where the Duplicate blocker never satisfies its dependents), then apply every choice and the duplicate marking atomically with
`ticketd write`. Give one decision per edge, copied from the preview, and set
`expected_canonical` to the preview's `canonical`; a stale decision fails with
"dependency review has changed", and nothing is written.

```sh
ticketd preview-duplicate T-KQ1 T-KQ3 \
  | jq '{operation: "mark_duplicate_reviewed", source, canonical,
         expected_canonical: .canonical,
         decisions: [.edges[] | {edge: ., choice: "replace"}]}' \
  | ticketd write - --request-id duplicate-1
```

`agent` may be added to the request to attribute the edits. To move dependencies
without marking SOURCE a duplicate, preview with `--separate` and submit the same
shape with `"operation": "edit_dependencies_reviewed"`.
