# Full access in a person's Chat

## Decision

A person's Chat offers Full access as one of its permission modes, for Claude Code
and for Codex. With it the harness edits files and runs commands without asking.
This reverses the earlier rule that ticketd never offers full access. It does not
change Automations: an Automation's agent still runs unattended with its allowed
tools only, and never with Full access.

- **Where and when.** Full access is a choice in the composer's Permissions menu, in
  New Chat and in an open Chat, with a one-line note on what it means. A change
  applies from the next message. There is no confirmation step. New Chat remembers
  the last pick per harness, as it does for every pick, but its default stays the
  asking one.
- **Claude Code.** Full access is `bypassPermissions`. Every person's session starts
  with `allowDangerouslySkipPermissions`, which makes the mode available without
  turning it on, so an open Chat can switch to it. Remembering an approval never
  turns it on. What Claude Code still asks in that mode is shown to the person.
- **Codex.** Full access is approval policy `never` and the `dangerFullAccess`
  sandbox, sent with each turn while it is chosen. The other choice is the person's
  own Codex settings. Leaving Full access restores the approval policy and sandbox
  the thread opened with, which the Chat records. Full access is not offered when
  the person's Codex requirements refuse the no-sandbox profile.
- **Persistence.** The mode is the Chat's: a Chat in Full access is still in it
  after a restart.

## Rejected

- **Never offering it.** Long-running work stops at almost every edit or command,
  and the person has to watch the Chat to keep it going. The person can already
  give their harness full access in its own settings for every session;
  refusing it per Chat protects nothing that a setting cannot undo.
- **Full access by default**, as T3 Code and Orca do. A new Chat asks until the
  person chooses otherwise; once chosen, New Chat remembers it.
- **Approving what Claude Code still asks in Full access**, as Orca does. Those
  requests come from Claude Code's own safety checks or the person's ask rules, so
  they stay with the person, as in T3 Code.
- **Restarting the session to change mode**, as T3 Code and Orca do for Claude.
  Starting every person's session able to switch lets the change apply from the
  next request without losing the process or its state.

## Why

The person owns the folder and the harness, and Full access is their decision for
the work at hand. ticketd's part is to make that state visible: the trigger shows
it at rest, the menu says what it means, and a reopened Chat keeps it.

## Consequences

- An agent in Full access can change anything the person's account can reach from
  the Chat's folder, including files outside it and the network. ticketd sees what
  the harness reports, not what it was prevented from doing.
- Every person's Claude Code process is started able to skip permissions. Only the
  person's pick, sent by the host, puts a session in that mode.
- A Codex thread keeps the last permissions it was given, so ticketd states the
  person's choice on each turn once the thread has had Full access.
