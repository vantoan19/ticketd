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

### Atomic batches

`ticketd batch plan.json` accepts a JSON array; use `ticketd batch -` to read
standard input. A create names a ticket for later operations using `$name`:

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
JSON ticket snapshots in operation order. Failures identify the zero-based
operation index and roll back the entire request. Requests are limited to 1 MiB,
100 operations, and 1,000 individual edits; execution checks a 10-second limit
between operations.

### Bounded ticket context

`ticketd context T-KQ1` returns JSON with the ticket, derived availability, and
its tags. Add `--project`, `--plan`, `--relationships`, or `--activities` to
select those scopes. An omitted scope is absent; a selected but unlinked project,
Plan, or parent is `null`. Related tickets include status and `trashed`; only
Done satisfies a prerequisite. A missing root or a missing linked project or
Plan produces an error on stderr and a nonzero exit code, with no JSON on
stdout.

Each list is ordered by ticket reference number, tag name, or Activity insertion
order, and contains at most 20 items. A non-null `next_offset` means to repeat
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
Use `--limit` (1–100, default 50) and `--offset` for pages, and `--project ID`
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
T-KQ1 ACTIVITY_ID`. Supporting Document references and detail fetching depend on
supporting-document functionality when available.

Record optional execution evidence using `ticketd evidence add T-KQ1 --kind
branch --name branch --value feature/example`; kinds also include `worktree`,
`pull-request`, `commit`, and `verification`. For example, use `--kind
verification --name checks --value './scripts/check passed'`. Read evidence
with `ticketd evidence list T-KQ1` or select it with `ticketd context T-KQ1 --evidence`.
