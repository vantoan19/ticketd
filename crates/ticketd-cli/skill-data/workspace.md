# Workspace operations and personal state

`ticketd workspace` reports the database path, current format (null if absent),
and format supported by this CLI. It does not create or migrate the workspace.
The default lives in OS application data. Desktop and CLI need the same OS user
and environment; on Linux, `XDG_DATA_HOME` affects the location. Registered
checkout paths identify projects inside the workspace, not separate databases.

Most data commands open the workspace and may create or migrate it. If another
ticketd operation prevents migration, close that operation and retry as directed
by the error. If the workspace format is newer than the CLI supports, use a
compatible CLI; do not edit database metadata to bypass the check.

## Backup, export, and restore

```sh
ticketd backup backup.sqlite3
ticketd export --file snapshot.json
```

`backup` prints `{"path":...}`. Both file destinations must be new. `export` without `--file` prints JSON to
stdout. Export is a portable snapshot, not an import or restore command.
Backup preserves workspace data and retained retry outcomes.

`restore-workspace BACKUP_PATH` replaces the workspace after closing the desktop
and other ticketd operations. It retains a safety backup and prints
`{"restored":WORKSPACE_FILE,"safety_backup":PATH}`; keep that result. This operation affects the entire workspace, unlike `restore
T-KQ1` or `document restore DOCUMENT_ID`, which restore items from trash.

## Personal data

`inbox --limit 20 --offset 0` reads the local person's attention inbox.
`reminder show`, `set`, `snooze`, and `dismiss` operate on a ticket's personal
reminder; times require RFC 3339 with an offset, and `snooze` only moves an
existing reminder to a later time. `show`, `set` and `snooze` print
`{"reference":...,"due_at":...}` (`due_at` is null when there is no reminder);
`dismiss` prints `{"dismissed":true}`, or `{"dismissed":false}` when there was
nothing to dismiss. Following and inbox read state
use the JSON write operations below. This state belongs to `local-person`, not
to the agent named by `--agent`.

```json
{
  "operation": "set_following",
  "reference": "TICKET_REFERENCE",
  "following": true
}
```

```json
{ "operation": "set_inbox_read", "ids": [123], "read": true }
```

Use actual entry IDs that were read, so newer arrivals stay unread. See `ticketd
skills get writes` for request IDs and replay behavior. These are capabilities,
not instructions to change the person's preferences during ordinary ticket work.
