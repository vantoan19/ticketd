# Antigravity uses ACP for person-driven Chats

An Antigravity Chat runs the person's installed Antigravity CLI through its
ACP server. It is available behind the experimental Chat switch.

## Decision

1. Every Prompt starts with a message sent by a person in a Chat. Antigravity
   does not run as an Automation agent.
2. The ACP handshake identifies ticketd by name and version.
3. The client sends no system prompts or tool definitions. Linked records
   use the same visible message context as in the other harnesses.
4. A replacement process resumes the native Session with `session/resume`.
   If the harness has lost its history, the Chat can continue in a new Session
   with no history carried over. A permission change that needs a restart
   requires a successful resume of the same Session.
5. The person signs in through `agy`. The client uses no tokens, private
   Antigravity files or usage endpoints.
6. Review Google's FAQ and terms again before Antigravity leaves experimental.

Find `agy` on PATH or in its default user installation directory and require
version 1.5.2 or newer. The process runs in the Chat's execution folder
with the usual ticketd process environment, plus
`AGY_CLI_DISABLE_AUTO_UPDATE=1`. The Chat credits CLI writes using the same
environment variables as the other harnesses. The ticketd skill installs under
`~/.gemini/config/skills/ticketd`.

The adapter uses the official Rust ACP schema. It shares the JSON-RPC
connection and runtime lifecycle with Codex. A Prompt's reply reports how
its Turn ended. Session updates lack a Prompt ID, so messages sent during a
Turn queue until it ends. Before a Session, New Chat reads model choices from
`agy models` and caches a successful list for the installed version. Model and
thinking-level controls then use the Session's configuration choices. Quota errors show the harness's message.

New Chats default to **Antigravity settings**. Ask for approval, Accept edits
and Plan only are offered when the Session reports their native values. A
change takes effect for the next message once Antigravity confirms it. Full
access is supplied by the native `--dangerously-skip-permissions` startup
flag with the same warning as the other harnesses. Crossing that boundary
replaces the process and resumes the Session before the next message. The
person answers every approval Antigravity still requests, including any
persistent choice it offers. Each warning Antigravity supplies for an approval
choice stays with that choice when the person sees it and if they need to
retry. ticketd returns the exact choice.

Antigravity's sub-agents are shown from what the Prompt already carries
([ADR 0029](0029-sub-agents-are-a-lane-of-their-own-in-a-chat.md)). A child's
tool calls arrive with IDs prefixed by its conversation ID, so they are grouped
into one sub-agent and kept out of the main agent's Steps. Antigravity reports
neither a child's messages nor its end, and holds the Prompt open until the
children finish, so a sub-agent ends with the Prompt and has no Stop of its own;
the sub-agent's view says so. A write a command makes is credited exactly from
the tool call ID in `ANTIGRAVITY_SOURCE_METADATA`.

## Rejected approaches

- Impersonating another client's identity to discover models.
- Driving the interactive terminal or reading private Antigravity files to
  reconstruct Sessions, including a sub-agent's messages.
- Attaching to a child with `session/load`: it is undocumented and repeats its
  tool updates.
- Having ticketd approve native requests to emulate Accept edits or Full
  access. Approval policy belongs to Antigravity and the person.

See [Google's ACP documentation](https://antigravity.google/docs/ide/extensions/acp/),
[Antigravity FAQ](https://antigravity.google/docs/faq/) and
[Antigravity terms](https://antigravity.google/terms).
