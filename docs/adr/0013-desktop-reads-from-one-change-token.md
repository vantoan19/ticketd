# Desktop reads refresh from one change token, behind one reads module

## Decision

The desktop learns that the Workspace changed from the core's single change
token, polled every two seconds, and from its own writes. Any change makes
every visible read stale. Reads in a hidden view, or while the window is
minimized, wait and catch up once when shown. Views do not refetch on window
focus or on timers of their own.

Workspace reads move onto one reads module in
`apps/desktop/src/lib/workspace-reads/`, view by view, starting with the Open
Ticket. The module owns the cache, the poll, visibility and failure wording. It
is built on TanStack Query, which no other module imports. Each read is declared
once in its catalogue; groups of related reads get a domain module on top of it.

After the desktop's own write, the write site reports it once. The module shows
what the write returned or set at once: any returned Ticket, and fills for any
other declared read, so a view keeps no private copy of its own write. It
re-reads the change token so the poll does not repeat the refresh, and makes
every visible read stale. A read sent before the write is superseded rather
than reused, because it may not include the write. A replaced Workspace (a
restore, a download) is reported the same way: the token is read first, then
every cached value, remembered "Show more" page and failure is dropped.

A failed refetch keeps the last good value and offers Retry. A read that failed
is read again only when the person presses Retry, when a change or an own write
arrives while it is visible, or when it is shown or mounts after a change it
missed; not because another view of it mounted, and not because it was shown
again with no change since. Retry resolves once a read made after it has
answered, so a write that cancels it does not end the wait early. A Ticket the
core says does not exist is an answer (an empty value), not a failure: it stays
gone through a later read that fails another way.

## Why

The core already keeps one counter, bumped by triggers on every table a view
shows, and reads are local SQLite queries, so re-reading what is visible is
cheap. The waste was elsewhere: the same data read by several views, hidden
views reading, and a second refresh after every write the desktop made. Hand
written fetch effects (118 cancellation flags and 72 failure states when this
was decided) each got staleness, races and Retry slightly differently.

## Considered options

- Finer staleness, through a token per kind of record or the Workspace event
  log of ADR-0012. Deferred until reads measure slow; the event log covers only
  ticket events today.
- One core read assembling the whole Open Ticket from one snapshot, the "Open
  ticket context" direction in the architecture overview. Deferred: sections of
  a page may still disagree for up to one poll, as before.
- A cache written by hand instead of TanStack Query. Rejected: it would recreate
  the race-prone code this replaces.

## Consequences

- A check made just before a write, such as detecting a conflicting edit, reads
  the bridge directly, because the cache can trail the database by up to one
  poll.
- Until the bridge client declares which commands write, each write site reports
  its write explicitly. A forgotten report shows the change only at the next
  poll.
