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

## Load a topic guide at its gate

This guide covers connecting and the shared contracts below. Before the action
in a row, load that row's guide; load only the guides your task reaches.

| Before you…                                                                                    | Load                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------ |
| Find, create, edit, or relate a ticket; register a project; attach evidence                    | `ticketd skills get tickets`   |
| Retrieve context; read or write a Document, Activity, or Plan; browse a graph                  | `ticketd skills get context`   |
| Send a write that must survive a retry, replace shared text, or change several tickets at once | `ticketd skills get writes`    |
| Touch a ticket an external source owns, change source settings, refresh, or publish            | `ticketd skills get sources`   |
| Move, back up, restore, or export the workspace; use reminders or the personal inbox           | `ticketd skills get workspace` |
| Start work in a ticketd Chat (the app started you and named linked records)                    | `ticketd skills get chat`      |

`ticketd COMMAND --help` and `ticketd GROUP COMMAND --help` describe current
arguments and flags. Examples use placeholders such as PROJECT_ID and DOCUMENT_ID; substitute actual
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
