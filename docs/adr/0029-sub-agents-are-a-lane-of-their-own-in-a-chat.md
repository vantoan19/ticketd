# Sub-agents are a lane of their own in a Chat

Claude Code, Codex and Antigravity hand work to sub-agents in the middle of a
conversation. ticketd's Chat vocabulary had no place for them. Claude's
sub-agent Steps were recorded as the main agent's own, and its background work
opened phantom Turns after the real one had ended. Codex's sub-agents were
dropped, and Antigravity's tool calls were mixed into the main agent's. A
sub-agent's approval was refused or lost its asker, Stop left background work
running, and a ticket a sub-agent updated could not say who updated it.

This decision gives a Chat a sub-agent lane beside its Turns. ticketd shows
the sub-agents the harness starts; it does not start them.

## Decision

### Scope

- (1) ticketd shows the sub-agents Claude Code, Codex and Antigravity start by
  themselves. It never starts one, apart from the Codex wake in decision 13.
- (2) A sub-agent is a Claude agent-kind task, a Codex child thread (multi-agent
  v1 and v2), or an Antigravity child conversation. Claude background shells
  and monitors stay Steps. Ambient and transcript-less Claude tasks are
  excluded. Claude workflows, remote agents and agent teams are out of scope.

### Words

- (3) The GLOSSARY gains **Sub-agent** and **Main agent**, and a **Model** that
  is distinct from the **Harness**. **Turn** starts from a message the person
  sent, when the main agent resumes by itself, or when ticketd wakes it.
  **Step** belongs to the main agent or a sub-agent, and not necessarily to a
  Turn. Product text says "sub-agent" and never subagent, helper, child, task,
  thread or worker.

### Lifecycle

- (4) **Lane.** A sub-agent's activity never opens or ends a Turn. Steps and
  approvals have an owner (the main agent or one sub-agent), and their Turn
  is optional. Events are routed by owner, not by whichever Turn is active.
  Only main-agent output can open a Turn the harness started.
- (5) **Record.** A sub-agent is keyed by its Chat and native ID. It holds its
  parent sub-agent, the Step that started it, its status, its runs and its
  owner links. Each resume adds a run and late output from an earlier run is
  dropped. Title, type and model are derived from the stored native payloads
  when the view is built, as ADR 0022 does for Step kinds. This needs a new
  Workspace format version, and export, retention, backup and lost-contact
  handling cover the new record.
- (6) **Status.** Running, completed, failed, stopped (with who stopped it, using
  the Turn-ending vocabulary), or contact lost. Sub-agents still running when
  ticketd quit or crashed become contact lost. The next message's context
  carries a factual note naming them, and for Claude says they can be
  resumed. The person sees the note under their message. The Chat holds the
  notice until a message carries it (it is stored on that message, so a resend
  repeats it), and a sub-agent the main agent resumes first leaves it. A resume
  keeps what the sub-agent was first asked.
- (7) **Content and plan.** Claude frames tagged with a parent tool use (text,
  reasoning, tool calls) go to their sub-agent. Only the main agent's to-do
  list updates the Turn's plan.

### Display

- (8) A sub-agent is one collapsed row in its parent's transcript. It opens a
  read-only view with a path back to the Chat, and has no composer. A strip
  above the composer lists the running sub-agents.
- (9) **Approvals** live as long as the agent that asked, not the Turn they
  arrived in. They name the sub-agent, move into its view when that view is
  open, notify at once and outrank "working". The asker's identity is carried
  through and stored: Claude passes `agentID`, Codex the child thread, and
  Antigravity the tool call prefix.
- (10) **Done.** A Chat shows as working while any sub-agent runs. It notifies
  Done once, when it goes quiet (no Turn and no running sub-agent).
  Background commands and monitors do not hold Done back, and a sub-agent
  finishing does not notify by itself.

### Control

- (11) **Stop** stops everything running in the Chat. With no active Turn it ends
  the harness process. For Codex it also interrupts every child Turn.
- (12) **Stop one** is a declared capability. Claude uses `stopTask`, for
  background sub-agents only. Codex interrupts the child's Turn and ends its
  terminals. Antigravity does not support it. The view offers Stop only for a
  sub-agent that runs now, in the background. Live Codex 0.172.0 sessions showed
  that interrupting a child's Turn leaves its command running, and that
  `thread/backgroundTerminals/clean` ends it but is answered only on the
  experimental app-server API, so every Codex Chat opens with that API (it
  already declares no tool for a person's Chat). Stop all ends the children's
  commands the same way. The stopped status records who stopped it: the person
  (Stop one or Stop), ticketd with its `StopReason` (the Chat turned off, a backup
  restored, the Chat trashed...; quitting leaves "contact lost" instead), or the
  main agent (Claude's own `TaskStop`, a Codex interrupt ticketd did not ask for).

### Turns ticketd or the harness starts

- (13) **Codex wake.** Codex does not resume an idle main agent when a sub-agent
  finishes. When a direct sub-agent finishes and the main agent is idle,
  ticketd sends one short, factual message, and the Turn reads "Started by
  ticketd: sub-agent finished". Only one wake is outstanding at a time. The
  person's queued message or steer goes first and carries the result in its
  context. The wake is always on, has no setting and never runs in
  Automations.
- (14) A failed Turn the person did not start shows as failed and notifies, but
  does not pause their queue.

### Write credit and tickets

- (15) **Credit by commit order.** Writes committed while a sub-agent's shell Step
  runs are credited to that Step's owner, using the commit order the CLI
  already records for Chat credit. Codex and Antigravity give an exact
  per-call key, which the core descriptor declares and the CLI records with
  the write: `CODEX_TOOL_CALL_ID`, and the tool call ID inside
  `ANTIGRAVITY_SOURCE_METADATA`. When shell Steps overlap and cannot be told
  apart, the write stays credited to the Chat with the sub-agent unknown.
  Commands are never modified. Status changes and Activities are credited;
  evidence and Documents are not yet. Chats are not synced, so a sub-agent's
  name on a credited record is local to the device.
- (16) A sub-agent is linked to a ticket only through its credited writes. There
  is no "mentioned" link.
- (17) **Ticket label.** The ticket's agent strip reads "{model} is working on
  this ticket" for any main agent or sub-agent with a credited write on the
  ticket while it runs, and collapses to "and N others". Each name opens that
  agent's view. The label goes when the work ends. The model is the
  sub-agent's own `message.model` for Claude, `subAgentActivity.model` for
  Codex, and otherwise the harness name.

### Harnesses and Automations

- (18) **Antigravity** shows sub-agent rows and groups their tool calls by the
  `<childId>:` prefix, with exact credit. It shows no sub-agent text or
  reasoning, counts a sub-agent as ended when the main agent's prompt ends,
  and has no Stop one. ticketd says so in the sub-agent's view. It reads no
  Antigravity files and does not use `session/load` of a child.
- (19) **Descriptors** (ADR 0022) declare sub-agent support, Stop one, sub-agent
  text, reasoning, model availability and the per-call credit variable, each as
  its own flag, and a Chat's sub-agent view offers exactly what they declare.
  Codex reports a child's messages and model but not its reasoning; Antigravity
  reports neither text nor reasoning and no model of its own (the sub-agent
  runs with the Chat's).
- (20) **Automations** get no Sub-agents switch for now. A run ends at its first
  Turn end, which would cut off background sub-agents, so the switch needs
  its own design. Meanwhile an unattended agent cannot start sub-agents:
  Codex runs with `agents.enabled=false` and `features.multi_agent_v2=false`,
  and Claude has `Agent` in its disallowed tools. Runs are Chats, so any
  sub-agent work still shows there.

## Rejected

- **Edit the agent's commands to credit them** (a hook prepending a sub-agent
  ID). A rewritten command stops matching the harness's own allow rules and
  changes what the harness would do on its own.
- **Match the IDs a write prints.** `change` prints no history number, read
  commands print the same IDs, and agents pipe, discard or truncate output.
  Commit order is exact for every write kind and needs no output contract.
- **Read the harness's transcript files**, as T3 Code does for Antigravity.
  ticketd reads no harness files on disk.
- **Attach to an Antigravity child with `session/load`.** It is undocumented
  and its tool updates arrive twice.
- **A "mentioned" link** between a sub-agent and a ticket named in its prompt.
  Codex does not expose the prompt, and the link gives false positives.
- **A Sub-agents switch for Automations**, for now (decision 20).
- **No Codex wake.** The Chat would sit idle with finished work unreported.
  We chose T3 Code's approach of waking the main agent.
- **Let a sub-agent's frames join whichever Turn is open.** It is what the host
  did before. Turn boundaries become arbitrary, in-flight calls are orphaned,
  and approvals die with a Turn the asker never belonged to.

## Evidence

- **T3 Code** (pingdotgg/t3code) and **Orca** (stablyai/orca) both store
  sub-agents as records, open them in read-only views and route their events by
  sub-agent rather than by the active run. Both hold "done" back while
  sub-agents run, and stop a single sub-agent only where the harness allows.
  T3 Code wakes Codex when a child finishes, with one wake outstanding per
  thread, and reaches deeper into Antigravity only by reading its files.
  Neither credits external writes to sub-agents or links them to tickets.
- **Live protocol captures** (Claude Agent SDK 0.3.322, codex-cli 0.172.0,
  agy 1.5.17):
  - Codex children get their own `CODEX_THREAD_ID`, and a command's
    `CODEX_TOOL_CALL_ID` equals its item ID. A child outlives its parent's Turn,
    and interrupting the parent leaves it running. Direct input to a v2 child
    is rejected.
  - `features.multi_agent=false` does not stop v2 sub-agents. `agents.enabled=false`
    does, unless `features.multi_agent_v2=true` overrides it.
  - Antigravity children get their own `ANTIGRAVITY_CONVERSATION_ID`, and
    `ANTIGRAVITY_SOURCE_METADATA` carries the tool call ID. Its `invoke_subagent`
    completes at launch and carries no child ID, which first appears on the
    child's first tool call.
  - Claude sub-agents get no per-sub-agent environment variable, and Claude
    resumes the main agent by itself when a background sub-agent finishes.
- **Today's host**, read from a live Chat: a background sub-agent's commands
  opened a Turn 65 seconds before the main agent's notification arrived,
  in-flight sub-agent calls were left running inside Turns recorded as
  completed, and a harness-started Turn that failed paused the person's queue.
  Bugs #610 and #611 cover the flattened Steps and the lost approvals, and #612
  and #613 the Automations that could still start sub-agents.
