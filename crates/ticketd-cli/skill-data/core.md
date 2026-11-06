# Using ticketd

ticketd is a local workspace shared by the desktop app and CLI. The desktop does
not need to be running. Use the CLI for data operations; its core enforces the
domain rules. Workflow choices belong to the user and their other instructions.

## Establish the target

Use the same executable throughout an interaction. Check `ticketd --version`
and `ticketd workspace` when establishing the connection. The latter prints the
workspace path and current/supported format versions without creating or migrating
the database. Most ordinary commands open the workspace and may create or migrate
it. An unexpected path or incompatible format needs resolving before a write.

The default workspace is per OS user/environment, outside repositories. A project
registration scopes tickets; it does not select a different workspace. Desktop
and CLI must use the same OS user/environment to see the same data.

`ticketd project list` discovers project IDs and registered checkout paths.
Only direct `ticketd create` infers a project from the current directory.
`list`, `search`, and JSON writes do not. Supply the intended project explicitly
where supported. Tickets without a project are valid. Keep returned ticket
references and entity IDs; names and directory names are not substitutes for IDs.

## Select the relevant guide

| Operation                                                                   | Read                           |
| --------------------------------------------------------------------------- | ------------------------------ |
| Find, create, edit, or relate tickets; project registration; evidence       | `ticketd skills get tickets`   |
| Retrieve context; read/write Documents, Activities, or Plans; browse graphs | `ticketd skills get context`   |
| Retryable writes, guarded edits, or atomic ticket batches                   | `ticketd skills get writes`    |
| Externally owned tickets, source settings, refresh, or publication          | `ticketd skills get sources`   |
| Workspace location, backup/restore/export, reminders, or personal inbox     | `ticketd skills get workspace` |

Load the applicable topic rather than every guide. `ticketd COMMAND --help`
and `ticketd GROUP COMMAND --help` describe current arguments and flags.
Examples use placeholders such as PROJECT_ID and DOCUMENT_ID; substitute actual
returned values. Each example illustrates an operation, not a required sequence.

## Read and write contracts

- Most data commands print JSON directly. There is no global `--json` flag.
  `write` returns a `kind`/`value` envelope; ordinary commands usually return the
  bare object or array. `list/search --latest-update` wrap each ticket with its
  latest authored update. `document link` and management commands can print text.
  Read/write results can contain full bodies: capture the JSON and display only
  needed fields, retaining the full data when preparing an edit.
- Check the exit status and stderr as well as stdout. Runtime failures exit 1
  with an `error:` message; argument errors are separate. Source operations can
  emit useful JSON even when they fail. Errors are not a stable JSON taxonomy.
- Read the full current content before replacing it. Bounded context and excerpts
  are for inspection, not editable drafts. A missing scope is not proof of no data.
- Use UTF-8 files or stdin for substantial Markdown and JSON, with the shell's
  normal quoting rules. Pass `-` only where help advertises stdin. Prefer a JSON
  serializer to hand-built strings; a command has only one stdin stream.
- Apply only intended fields. Use guarded JSON edits when replacing shared text;
  see `writes`. After an uncertain write, recover using its request ID where
  supported. A failed output pipe can follow a committed write.
- Returned state describes that operation. Fetch current state again when a later
  decision depends on it, especially after replaying a request ID.

`--agent` is descriptive attribution. It grants no permission, claim, lease, or
exclusive ownership. Readiness and status also do not reserve a ticket for an agent.
