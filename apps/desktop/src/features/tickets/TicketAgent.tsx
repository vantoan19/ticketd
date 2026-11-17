import { AgentContext } from "./ticket-agent-context";
import {
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
} from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { Loader2, TriangleAlert } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { editingHarness } from "@/features/chats/editing-harness";
import {
  useChat,
  useChatFeature,
  useLinkedChats,
} from "@/features/chats/use-chats";
import { topChat } from "@/features/chats/use-ticket-chats";
import type { ChatSummary } from "@/features/chats/client";
import { duration, stepWords } from "@/features/chats/model";
import type { LatestUpdate } from "@/lib/api/progress";
import type { Ticket } from "@/lib/api/client";
import { relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { useInboxAttention } from "./use-inbox-attention";
import { useLatestUpdateOf } from "./open-ticket";
import { progressBrief } from "./progress-brief";

/** Decide the slot once per opening, before displaying the document. */
export function TicketAgentSession({
  ticket,
  children,
}: {
  ticket: Ticket | undefined;
  children: (loading: boolean) => ReactNode;
}) {
  const { enabled } = useChatFeature();
  const { show } = useStatusLine();
  const { list } = useLinkedChats(
    ticket && enabled ? { kind: "ticket", id: ticket.id } : null,
  );
  const reference = ticket?.reference;
  // The latest update is shared with the Ticket page's "Latest update" line,
  // and is read by reference: it does not wait for the Ticket's record.
  const latest = useLatestUpdateOf(reference ?? null);
  const { failure, retry } = latest;
  useEffect(() => {
    if (!failure) return;
    show({
      tone: "error",
      message: `${failure.title}. ${failure.sentence}`,
      action: { label: "Retry", run: retry },
    });
  }, [failure, retry, show]);
  // Answered since the last change, or failed: a cached answer a change has
  // made stale (an update posted while this Ticket was away) does not decide
  // the once-per-opening slot, and a failed read leaves the line without one.
  const answered =
    (latest.value !== undefined && latest.current) || failure !== null;
  const update = latest.value ?? null;
  const attention = useInboxAttention();
  const ready = Boolean(ticket && answered && (!enabled || list));
  const chats = list?.chats ?? [];
  const projected =
    attention?.chats.filter((chat) =>
      chat.tickets.some((link) => link.reference === ticket?.reference),
    ) ?? [];
  const chat =
    topChat([
      ...projected,
      ...chats.filter(
        (chat) => !projected.some((current) => current.id === chat.id),
      ),
    ]) ??
    projected[0] ??
    chats[0];
  const [opening, setOpening] = useState<{
    reference: string | undefined;
    reserved: boolean | null;
  }>({ reference: ticket?.reference, reserved: null });
  if (opening.reference !== ticket?.reference) {
    setOpening({ reference: ticket?.reference, reserved: null });
  } else if (
    opening.reserved === null &&
    (ready || chat || ticket?.progress_summary?.editing_agent)
  )
    setOpening({
      reference: ticket?.reference,
      reserved:
        chats.length > 0 ||
        projected.length > 0 ||
        Boolean(
          update?.editing_agent || ticket?.progress_summary?.editing_agent,
        ),
    });
  return (
    <AgentContext
      value={{
        ready,
        reserved:
          opening.reference === ticket?.reference && Boolean(opening.reserved),
        chat,
        update: ready ? update : (ticket?.progress_summary ?? null),
      }}
    >
      {children(Boolean(ticket && !ready))}
    </AgentContext>
  );
}

export function TicketAgentHeader({ reference }: { reference: string }) {
  const { requestChat } = useChatFeature();
  const agent = useContext(AgentContext);
  if (!agent?.ready || agent.reserved || !agent.chat) return null;
  const chat = agent.chat;
  if (chat.status.rank === "approval")
    return (
      <Tooltip content="Review the request in Chat">
        <Button
          aria-label="Review request"
          aria-description="Approval needed"
          variant="attention"
          size="compact-responsive"
          onClick={() =>
            requestChat({
              kind: "open",
              chatId: chat.id,
              retention: chat.retention,
              from: reference,
            })
          }
        >
          <span className="ticket-agent-header-long">
            <StatusDot tone="attention" size={6} />
          </span>
          <span className="ticket-agent-header-long">Approval needed</span>
          <TriangleAlert
            className="ticket-agent-header-short"
            aria-hidden="true"
          />
        </Button>
      </Tooltip>
    );
  if (chat.status.rank !== "working") return null;
  return (
    <Tooltip content="Working">
      <Badge
        variant="record"
        size="compact-responsive"
        role="status"
        aria-label="Working"
      >
        <HarnessMark
          harness={chat.harness_id}
          name={chat.harness_name}
          decorative
        />
        <span className="ticket-agent-header-long">Working</span>
      </Badge>
    </Tooltip>
  );
}

export function TicketAgentStrip({
  reference,
  onOpenUpdate,
}: {
  reference: string;
  onOpenUpdate?: ((id: string) => void) | undefined;
}) {
  const agent = useContext(AgentContext);
  if (!agent?.reserved) return null;
  return (
    <div className="ticket-agent-slot">
      <div
        role="status"
        aria-label="Ticket agent"
        aria-live="polite"
        aria-atomic="true"
        className="ticket-agent-strip ui-agent-strip"
      >
        {agent.chat ? (
          <LiveAgent
            key={agent.chat.id}
            chat={agent.chat}
            reference={reference}
            update={agent.update}
            onOpenUpdate={onOpenUpdate}
          />
        ) : (
          <IdleAgent update={agent.update} onOpenUpdate={onOpenUpdate} />
        )}
      </div>
    </div>
  );
}

function IdleAgent({
  update,
  onOpenUpdate,
}: {
  update: LatestUpdate | null;
  onOpenUpdate?: ((id: string) => void) | undefined;
}) {
  const now = useNow();
  if (!update) return null;
  const name = update.editing_agent ?? "You";
  return (
    <button
      type="button"
      className="ticket-agent-copy text-left"
      onClick={() => onOpenUpdate?.(update.activity_id)}
      aria-label={`Go to update: ${update.brief.text}`}
    >
      <HarnessMark harness={editingHarness(name)} name={name} decorative />
      <span>
        <strong>{name}</strong> ·{" "}
        <span aria-hidden="true">
          {relativeDateTime(update.reported_at, now)}
        </span>{" "}
        · {progressBrief(update.brief.text)}
        {update.brief.truncated ? "…" : ""}
      </span>
    </button>
  );
}

function LiveAgent({
  chat,
  reference,
  update,
  onOpenUpdate,
}: {
  chat: ChatSummary;
  reference: string;
  update: LatestUpdate | null;
  onOpenUpdate?: ((id: string) => void) | undefined;
}) {
  const { requestChat } = useChatFeature();
  const approval = chat.status.rank === "approval";
  const live = approval || chat.status.rank === "working";
  return (
    <>
      <div className="ticket-agent-copy ui-agent-state" key={chat.status.rank}>
        {live ? (
          <LiveAgentText chat={chat} />
        ) : update ? (
          <IdleAgent update={update} onOpenUpdate={onOpenUpdate} />
        ) : (
          <>
            <HarnessMark
              harness={chat.harness_id}
              name={chat.harness_name}
              decorative
            />
            <span>
              <strong>{chat.harness_name}</strong> ·{" "}
              {chat.preview ?? chat.status.word}
            </span>
          </>
        )}
      </div>
      <Tooltip
        content={
          approval ? "Review the request in Chat" : "Open this ticket’s Chat"
        }
      >
        <Button
          variant={approval ? "outline" : "ghost"}
          size="compact"
          onClick={() =>
            requestChat({
              kind: "open",
              chatId: chat.id,
              retention: chat.retention,
              from: reference,
            })
          }
        >
          {approval ? "Review request" : "Open Chat"}
        </Button>
      </Tooltip>
    </>
  );
}

/** Only live work attaches a snapshot; reading an idle outcome must not mark its Chat seen. */
function LiveAgentText({ chat }: { chat: ChatSummary }) {
  const { snapshot, error, retry } = useChat(chat.id);
  const { show } = useStatusLine();
  const reportFailure = useEffectEvent(() => {
    if (error)
      show({
        tone: "error",
        message: error.sentence,
        action: { label: "Retry", run: retry },
      });
  });
  useEffect(() => {
    if (error) reportFailure();
  }, [error]);
  const working = chat.status.rank === "working";
  const step = snapshot?.items
    .flatMap((item) => (item.kind === "steps" ? item.steps : []))
    .reverse()
    .find((step) => step.state === "running");
  const request = snapshot?.items
    .slice()
    .reverse()
    .find((item) => item.kind === "request" && item.state === "pending");
  const words = step ? stepWords(step) : null;
  const stepText = words
    ? words.parts
        .map((part) => part.text)
        .filter(Boolean)
        .join(" ")
    : chat.status.detail;
  return (
    <>
      {working ? (
        <HarnessMark
          harness={chat.harness_id}
          name={chat.harness_name}
          decorative
        />
      ) : (
        <StatusDot tone="attention" size={6} />
      )}
      <span>
        <strong>{chat.harness_name}</strong>{" "}
        {working
          ? "is working on this"
          : `wants to run ${request?.kind === "request" ? (request.command ?? request.subject ?? request.title) : (chat.status.detail ?? "a command")}`}
        {working && stepText && (
          <span className="text-muted-foreground"> · {stepText}</span>
        )}
        {working && step?.started_at && <Elapsed started={step.started_at} />}
      </span>
      {working && (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      )}
    </>
  );
}

function Elapsed({ started }: { started: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span aria-hidden="true" className="text-muted-foreground">
      {" "}
      · {duration(Math.max(0, now - Date.parse(started)))}
    </span>
  );
}
