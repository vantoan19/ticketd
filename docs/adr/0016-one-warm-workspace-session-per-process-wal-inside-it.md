# One warm Workspace session per process, WAL inside it

## Decision

A long-running process keeps its Workspace open between uses. The core owns one
`WorkspaceSession` per Workspace file per process, beside the per-file sync
registry. The desktop's commands, background ticks, Chat host and Automation
runner use it: `workspace()` lends a Workspace for one use and takes it back
when the guard drops, `read(f)` runs reads in one snapshot (the read scope),
`write(f)` runs one use that may write, and `exclusive(f)` runs work that
replaces the file. Adapters never see the lock protocol. The CLI still opens a
Workspace once per invocation.

The session keeps the connections it opened, at most four idle, and opens
another while uses overlap. Schema parsing, pragmas and the temporary table are
paid once per connection. On each use it checks that the file is still there
and that `schema_version` and `user_version` have not moved; if either has, the
use goes through the full open checks again, so a file a newer ticketd migrated
is refused as newer.

Inside the session the file is in WAL mode with `synchronous=FULL`, so a reader
and a writer do not wait for each other and every commit is still synced.
Journal mode is a property of the file, not a ladder object: it needs no format
version (ADR 0014), and older builds open the file. Every connection the core
opens, including the raw ones for backups, snapshots and restore, is set up by
one crate-private `configure`.

### Releasing the file on request

A kept connection holds the shared Workspace lock, as every open Workspace
does. An exclusive acquirer in another process (a restore, or a migration by a
newer CLI) that finds the lock held writes a release marker,
`<workspace>.release-requested`, beside the restore marker. It removes the
marker once it has the lock or gives up. A restore waits two seconds, a
migration its existing ten. Sessions look for the marker before and after each
use and on a one-second tick, and close their idle connections. While the
marker is fresh, no open takes the shared lock, so sessions do not take the
file back before the acquirer gets it. A marker older than fifteen seconds was
left by an acquirer that died and is ignored.

Exclusive work in the same process (the desktop's restore and Drive
download-replace) calls `session.exclusive(f)`. It waits up to ten seconds for
uses under way to end, closes the session's connections, holds new uses until
`f` returns, and `f` takes the exclusive lock as above.

### The fence for file swaps

Before restore or download-replace swaps the database file, under the exclusive
lock, it:

1. checkpoints the replaced file with `wal_checkpoint(TRUNCATE)` and switches it
   to `journal_mode=DELETE`;
2. deletes any `-wal` and `-shm` left beside it;
3. swaps the file and verifies its SHA-256 as before;
4. reopens.

Every backup and snapshot is written in DELETE mode, so a backup stays a single
file. The SQLite backup API copies the source's header, WAL flag included, so
the copy is switched back explicitly.

## Why

Opening the Workspace cost 4.4 to 5 ms: two canonicalizations, the lock file,
the restore marker, SQLite parsing a 92 KB schema of 95 tables and 264
triggers, pragmas and a temporary table. The desktop paid that on every
command, tick and Chat feed item, against queries of 0.05 to 0.8 ms. Commits
under `DELETE` with `synchronous=FULL` cost 8.3 ms, against 1.8 ms under WAL,
and a writer blocked readers. WAL alone makes each cold open slower (7 to
9 ms), which is why it is enabled only inside the session.

A kept connection holds the shared lock rather than taking it per use, because
the acquirer must know that no connection is still open before it swaps the
file. Windows refuses to replace a file SQLite has open ("Access is denied",
checked on Windows 11), and on Unix a connection left open would go on reading
the replaced file.

## Considered options

- Take the shared lock per use only, as first proposed. Rejected: an acquirer
  could take the exclusive lock while an idle connection still had the file
  open, and would have no way to know when every session had closed it.
- One connection per session behind a mutex. Rejected: a Drive sync run or a
  source refresh holds its Workspace across network calls, and would hold every
  other command up with it.
- WAL for every open. Rejected on the numbers above.

## Consequences

- The `-wal` file holds recent commits while the desktop runs. A Workspace file
  copied by hand alone while the app is open may miss them; backups do not.
- The sync scheduler's hold and the Chats restoring flag stay. They keep Drive
  runs and harnesses away from records about to be replaced and give the
  person a reason; `exclusive` keeps connections away from the file itself.
- A connection's temporary state, such as acting as the local person, lasts as
  long as the connection. Only the desktop uses a session, and all of its uses
  act as the local person.
