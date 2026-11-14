# Automations on a Workspace event log, with runs as records around Chats

## Decision

Automations are triggered from a persisted, device-local Workspace event log
rather than from in-memory notifications or polling for differences. Every
ticket change the core commits also appends one Workspace event in the same
transaction: a type (`ticket.created`, `ticket.updated`,
`ticket.status_changed`, `ticket.tag_added`, `ticket.tag_removed`,
`activity.created`), the ticket, the previous and current values of what
changed, the time, and the actor kind: person, Automation, a ticket source's
refresh (`sync`), or Workspace sync applying a change from another desktop
(`workspace_sync`).
A ticket created with tags emits one `ticket.tag_added` per tag. The first
import of a ticket source emits nothing: every issue of a source read for the
first time, and every issue new to the Workspace in the first read after the
source's configuration changed (a repository added, a rule loosened). Each
Automation keeps a cursor into the log, so changes made while the desktop was
not running (by the CLI or arriving from a ticket source) fire when it next
starts. Schedule and run-now triggers
do not go through the log; a schedule missed while the desktop was not running
fires once at the next start.

An Automation run is its own record: the triggering event, the Automation as it
was defined when the run started, per-step status and timing. No data is passed
between steps: an agent records its result on the ticket through the CLI, and a
branch tests the ticket's state at that moment.
Each agent step runs as an ordinary Chat on the existing Chat host, and the run
points to it. Runs are listed on the ticket and under their Automation and stay
out of the Chat list until the person replies in one, which makes that Chat an
ordinary Chat.

Agent steps run unattended: there is no approval prompt. Tools outside the
Automation agent's allowlist are denied, and a step that needs the person fails.
Ticket text is passed to the agent as untrusted data. A failed step follows its
failure path when one is defined, and the run then counts as completed with the
step marked failed; without a failure path the run ends as needing attention.
Nothing retries automatically.

Events whose actor is an Automation never trigger Automations. Neither do
events whose actor is Workspace sync: each desktop reacts only to changes made
on it and to changes arriving from an external ticket source such as GitHub. A
change another desktop made, whoever made it there, starts no run here. The
actor is not synchronized, so without this an Automation's change made on one
desktop would arrive on another as an ordinary change and could start an
Automation there, and two desktops could answer each other without end. This
rule is provisional (decided 2026-11-15): a way for devices to agree on which
one runs an Automation has yet to be designed. One run is
active per ticket per Automation, and a configurable number of runs (default 2)
execute at once; the rest queue in event order.

Automations and Automation agents are Workspace records and synchronize.
Whether an Automation is on, its cursor, the event log and runs are per device;
a synchronized Automation arrives switched off. Events and runs are kept 90
days.

Automations run only inside the desktop process. While any Automation is on,
closing the window hides to the tray as it already does for a working Chat, and
the person can choose to start ticketd at login. No separate service is added.

## Trade-off

Triggering from the UI's change-token polling or from in-process notifications
would need no new table, but would lose changes made while the desktop was
closed and could not tell an Automation's own writes from a person's, which is
what prevents loops. The log costs one extra row per change and a retention job.

Making a run just a flagged Chat would avoid a second record, but a Chat has
nowhere to hold the trigger, branch taken or step outcomes, and
unattended runs would crowd the person's own Chats.

Passing an agent step's declared outputs to later steps would let a branch
tell "decided no" from "did not say", but agent output varies between runs,
carries whatever untrusted ticket text put into it on to the next step, and
hides the reason for a branch inside the run. Using the ticket as the hand-off
keeps every agent decision visible on the ticket; the cost is that an agent
that forgets to record its result sends the branch down the No path.

Keeping on/off per device means the person must switch an Automation on again
on a second desktop. The alternative, a synchronized switch, would let one tag
start the same agent on two machines, since no device knows another is running.

Ignoring what Workspace sync brings in means an Automation runs only where the
change was made: a tag added on the laptop starts nothing on the desktop that
is always on, and a change made while the only desktop with the Automation on
was not the one used is never acted on. Matching synchronized changes instead
would bring back the loop and the doubled runs above. A locking or hand-over
mechanism between devices could give both, and is left for a later decision.

Running in the tray means Automations stop when the person quits ticketd or
logs out. A standalone service would remove that limit at the cost of a second
process owning the Workspace and the harnesses, which the architecture has not
selected.
