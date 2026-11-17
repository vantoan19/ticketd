import { Skeleton } from "@/components/ui/skeleton";
import { onInboxAction } from "./inbox-commands";
import { AgentContext } from "./ticket-agent-context";
import { workspaceClient } from "@/lib/api/workspace";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useInboxAction } from "./use-inbox-action";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { client, type Evidence, type Ticket } from "@/lib/api/client";
import { useTicket, useTicketChanged } from "./open-ticket";
import { inboxClient } from "@/lib/api/inbox";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { useChatClient } from "@/features/chats/client";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { editingHarness } from "@/features/chats/editing-harness";
import { Time } from "@/components/ui/time";
import {
  shortcutLabel,
  matchesShortcut,
  ariaKeyShortcuts,
} from "@/lib/shortcuts";
import { Snooze } from "./Inbox";
import { useInboxTriage } from "./inbox-triage-context";
import { useInboxAttention } from "./use-inbox-attention";
import { requestTicketUpdate } from "./activity-composer-request";
import {
  summarize,
  snoozeInstant,
  ticketUnavailable,
  type SnoozeChoice,
} from "./inboxModel";

export function InboxTriageCard() {
  const triage = useInboxTriage();
  const attention = useInboxAttention();
  const chats = useChatClient();
  const agentContext = useContext(AgentContext);
  const blocked = editingBlockedReason(useWorkspaceState());
  const [snoozeRequest, setSnoozeRequest] = useState(0);
  const sequence = useRef(0);
  const selection = triage?.selection;
  const original = selection?.kind === "entry" ? selection.entry : null;
  const entry =
    attention?.entries.find((item) => item.id === original?.id) ?? original;
  const chat =
    selection?.kind === "approval"
      ? (attention?.chats.find((item) => item.id === selection.chat.id) ??
        selection.chat)
      : null;
  const reference =
    entry?.reference ??
    chat?.tickets[0]?.reference ??
    chat?.first_ticket ??
    null;
  const record = useTicket(reference).value;
  // Undefined until the Ticket is read; null once the core says it is gone.
  const ticket = record ?? undefined;
  const changed = useTicketChanged();
  const read = entry?.read ?? !chat?.status.unseen;
  const ticketReason =
    blocked ??
    (!reference
      ? "This Chat has no linked Ticket."
      : ticketUnavailable(record));
  const agent = entry?.editing_agent ?? chat?.harness_name;
  const harness = chat?.harness_id ?? editingHarness(agent);
  const description = entry
    ? summarize(entry)
    : chat?.status.detail
      ? `${agent} wants to run ${chat.status.detail}`
      : "Approval needed";
  const latestBrief = chat
    ? description
    : entry?.kind === "activity"
      ? entry.to_value
      : (agentContext?.update?.brief.text ?? description);
  const [bodySnapshot, setBodySnapshot] = useState({
    selection,
    ready: !entry || agentContext?.ready === true,
    brief: latestBrief,
  });
  const ready = !entry || agentContext?.ready === true;
  if (bodySnapshot.selection !== selection || (!bodySnapshot.ready && ready))
    setBodySnapshot({ selection, ready, brief: latestBrief });
  const brief =
    bodySnapshot.selection === selection ? bodySnapshot.brief : latestBrief;
  const [evidenceState, setEvidenceState] = useState<{
    reference: string;
    items: Evidence[];
    error: FailureDescription | null;
  } | null>(null);
  const [evidenceAttempt, setEvidenceAttempt] = useState(0);
  useEffect(() => {
    if (!reference) return;
    let active = true;
    void client.evidence(reference, 0).then(
      (items) => {
        if (active)
          setEvidenceState({
            reference,
            items: items
              .filter(
                (item) =>
                  item.kind === "pull_request" || item.kind === "verification",
              )
              .slice(0, 2),
            error: null,
          });
      },
      (reason: unknown) => {
        if (active)
          setEvidenceState({
            reference,
            items: [],
            error: describeFailure(reason, "load the evidence"),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [reference, evidenceAttempt]);
  const isReview = entry?.kind === "status" && entry.to_value === "In review";
  const isReminder = entry?.kind === "reminder";
  // The one report of a write, with the Ticket the write returned.
  async function reload(returned?: Ticket) {
    attention?.reload();
    await changed(returned);
  }
  const { pending, perform } = useInboxAction(reload, triage?.line);
  function mark(next: boolean) {
    if (blocked || pending || (!entry && !chat)) return;
    const before = read;
    const requestId = crypto.randomUUID();
    const undoId = crypto.randomUUID();
    const set = async (value: boolean, id: string) => {
      if (entry) await inboxClient.setRead([entry.id], value, id);
      else if (chat) {
        if (value) await chats.markRead(chat.id);
        else await chats.markUnread(chat.id);
      }
    };
    void perform(
      `Marked ${reference ?? "Chat"} ${next ? "read" : "unread"}`,
      () => set(next, requestId),
      () => set(before, undoId),
    );
  }
  function remind(choice: SnoozeChoice) {
    if (ticketReason || !reference || pending) return Promise.resolve();
    const due = snoozeInstant(choice, new Date());
    const beforeRead = read;
    const id = crypto.randomUUID();
    const readId = crypto.randomUUID();
    const undoId = crypto.randomUUID();
    const undoReadId = crypto.randomUUID();
    // Capture once, before any write. Retry reuses both this value and all request IDs.
    let before: string | null | undefined;
    return perform(
      `Reminder set for ${reference}`,
      async () => {
        if (before === undefined)
          before = await inboxClient.reminder(reference);
        await inboxClient.snooze(reference, due, id);
        if (entry && !isReminder)
          await inboxClient.setRead([entry.id], true, readId);
        else if (chat) await chats.markRead(chat.id);
      },
      async () => {
        await inboxClient.snooze(reference, before ?? null, undoId);
        if (entry)
          await inboxClient.setRead([entry.id], beforeRead, undoReadId);
        else if (chat && !beforeRead) await chats.markUnread(chat.id);
      },
    );
  }
  function primary() {
    if (chat) {
      triage?.openChat(chat.id);
      return;
    }
    if (!entry || blocked || pending) return;
    if (!isReview && !isReminder) {
      mark(true);
      return;
    }
    if (primaryReason || !reference) return;
    const id = crypto.randomUUID();
    const undoId = crypto.randomUUID();
    if (isReview) {
      let before: string | undefined;
      void perform(
        `Moved ${reference} to Done`,
        async () => {
          before ??= (await client.showTicket(reference)).status;
          return client.changeTicket(reference, { status: "Done" }, id);
        },
        // The Ticket the Undo wrote is reported at once; the Inbox's own record
        // that this review needs you again follows, and fails on its own.
        () =>
          client.changeTicket(
            reference,
            { status: before ?? "In review" },
            undoId,
          ),
        undefined,
        {
          action: `show ${reference} under Needs you again`,
          run: async () => {
            await attention?.restoreReview?.(entry);
          },
        },
      );
    } else {
      let before: string | null | undefined;
      void perform(
        `Cleared reminder for ${reference}`,
        async () => {
          if (before === undefined)
            before = await inboxClient.reminder(reference);
          await inboxClient.snooze(reference, null, id);
        },
        () => inboxClient.snooze(reference, before ?? null, undoId),
      );
    }
  }
  function reply() {
    if (!ticketReason && reference) requestTicketUpdate(reference, brief);
  }
  useLayoutEffect(() => {
    if (!selection) return;
    return onInboxAction((action) => {
      if (action === "primary") primary();
      else if (action === "reply") reply();
      else if (action === "read") mark(!read);
      else if (action === "remind" && !ticketReason)
        setSnoozeRequest((n) => n + 1);
    });
  });
  useLayoutEffect(() => {
    if (!selection) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !(target instanceof HTMLElement) ||
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-inbox-chat]',
        )
      )
        return;
      if (event.key.toLowerCase() === "g" && !event.metaKey && !event.ctrlKey) {
        sequence.current = Date.now();
        return;
      }
      if (Date.now() - sequence.current < 1000) {
        sequence.current = 0;
        return;
      }
      let action: (() => void) | undefined;
      if (
        matchesShortcut(event, "inbox-primary") ||
        (chat && matchesShortcut(event, "inbox-open"))
      )
        action = primary;
      else if (matchesShortcut(event, "inbox-read")) action = () => mark(!read);
      else if (matchesShortcut(event, "inbox-reply")) action = reply;
      else if (matchesShortcut(event, "inbox-remind"))
        action = () => {
          if (!ticketReason) setSnoozeRequest((n) => n + 1);
        };
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        action();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  if (!selection) return null;
  const primaryReason = chat
    ? null
    : isReview
      ? (ticketReason ??
        (ticket?.status !== "In review"
          ? "This review is already resolved."
          : ticket.source?.ownership === "external" &&
              (ticket.source.status_locked ||
                !ticket.source.status_choices.includes("Done"))
            ? "The source does not allow moving this Ticket to Done."
            : null))
      : isReminder
        ? ticketReason
        : blocked;
  const primaryLabel = chat
    ? "Review in Chat"
    : isReview
      ? "Move to Done"
      : isReminder
        ? "Clear reminder"
        : "Mark read";
  return (
    <div
      className="inbox-triage-document"
      key={selection.kind === "entry" ? selection.entry.id : selection.chat.id}
    >
      <Card variant="triage" aria-label="Inbox triage" role="region">
        <div className="inbox-triage-card">
          <div className="inbox-triage-context" data-slot="triage-context">
            {harness && (
              <HarnessMark harness={harness} name={agent ?? ""} decorative />
            )}
            <span>{agent ?? "Your reminder"}</span>
            <span>
              {isReview
                ? "moved this to In review"
                : chat
                  ? "needs your approval"
                  : "brought this Ticket to your attention"}
            </span>
            <span>·</span>
            <Time value={entry?.timestamp ?? chat?.updated_at ?? ""} />
          </div>
          {(!ticket || !reference) && (
            <p>
              {reference && <strong>{reference} · </strong>}
              {entry?.title ?? chat?.title}
            </p>
          )}
          {ready ? <p>{brief}</p> : <Skeleton className="mt-2 h-12 w-full" />}
          <div className="inbox-triage-evidence" data-slot="triage-evidence">
            {evidenceState?.reference === reference && evidenceState.error ? (
              <>
                <span>{evidenceState.error.title}</span>
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => setEvidenceAttempt((n) => n + 1)}
                >
                  Retry
                </Button>
              </>
            ) : (
              evidenceState?.reference === reference &&
              evidenceState.items.map((item) => (
                <Tooltip key={item.id} content={`${item.name}: ${item.value}`}>
                  <span>
                    {item.kind === "pull_request" ? (
                      <Button
                        variant="link"
                        size="inline"
                        onClick={() =>
                          void workspaceClient
                            .openLink(item.value)
                            .catch((reason: unknown) =>
                              setEvidenceState({
                                reference,
                                items: evidenceState.items,
                                error: describeFailure(
                                  reason,
                                  "open the evidence",
                                ),
                              }),
                            )
                        }
                      >
                        {item.name || item.value}
                      </Button>
                    ) : (
                      `${item.name}: ${item.value}`
                    )}
                  </span>
                </Tooltip>
              ))
            )}
          </div>
          {ticketReason && (
            <p className="inbox-triage-reason" data-slot="triage-reason">
              {ticketReason}
            </p>
          )}
          <div className="inbox-triage-actions">
            <Tooltip
              content={primaryReason ?? primaryLabel}
              shortcut={shortcutLabel(chat ? "inbox-open" : "inbox-primary")}
            >
              <span>
                <Button
                  size="compact"
                  aria-keyshortcuts={ariaKeyShortcuts(
                    chat ? "inbox-open" : "inbox-primary",
                  )}
                  disabled={pending || !!primaryReason}
                  onClick={primary}
                >
                  {pending ? "Saving…" : primaryLabel}
                  <Kbd>
                    {shortcutLabel(chat ? "inbox-open" : "inbox-primary")}
                  </Kbd>
                </Button>
              </span>
            </Tooltip>
            <Tooltip
              content={ticketReason ?? "Reply on this Ticket"}
              shortcut={shortcutLabel("inbox-reply")}
            >
              <span>
                <Button
                  variant="outline"
                  size="compact"
                  disabled={!!ticketReason || pending}
                  aria-keyshortcuts={ariaKeyShortcuts("inbox-reply")}
                  onClick={reply}
                >
                  Reply<Kbd>{shortcutLabel("inbox-reply")}</Kbd>
                </Button>
              </span>
            </Tooltip>
            <Snooze
              entry={{ reference: reference ?? "Chat" }}
              openRequest={snoozeRequest}
              snooze={remind}
              label={isReminder ? "Snooze" : "Remind me"}
              disabled={!!ticketReason || pending}
            />
            <span className="inbox-triage-spacer" />
            <Tooltip
              content={blocked ?? (read ? "Mark unread" : "Mark read")}
              shortcut={shortcutLabel("inbox-read")}
            >
              <span>
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={!!blocked || pending}
                  aria-keyshortcuts={ariaKeyShortcuts("inbox-read")}
                  onClick={() => mark(!read)}
                >
                  {read ? "Mark unread" : "Mark read"}
                  <Kbd>{shortcutLabel("inbox-read")}</Kbd>
                </Button>
              </span>
            </Tooltip>
          </div>
        </div>
      </Card>
    </div>
  );
}
