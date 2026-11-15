import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
} from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { failureText } from "@/lib/api/describe-failure";
import { Loader2 } from "lucide-react";
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
import { latestUpdate, type LatestUpdate } from "@/lib/api/progress";
import type { Ticket } from "@/lib/api/client";
import { relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { useInboxAttention } from "./use-inbox-attention";
import { progressBrief } from "./progress-brief";

const AgentContext = createContext<{
  reserved: boolean;
  chat: ChatSummary | undefined;
  update: LatestUpdate | null;
} | null>(null);

/** Decide the slot once per opening, before displaying the document. */
export function TicketAgentSession({
  ticket,
  revision,
  children,
}: {
  ticket: Ticket | undefined;
  revision: number;
  children: (loading: boolean) => ReactNode;
}) {
  const { enabled } = useChatFeature();
  const { show } = useStatusLine();
  const [attempt, setAttempt] = useState(0);
  const { list } = useLinkedChats(
    ticket && enabled ? { kind: "ticket", id: ticket.id } : null,
  );
  const [update, setUpdate] = useState<{
    reference: string;
    value: LatestUpdate | null;
  } | null>(null);
  const reference = ticket?.reference;
  useEffect(() => {
    if (!reference) return;
    let current = true;
    latestUpdate(reference).then(
      (value) => {
        if (current) setUpdate({ reference, value });
      },
      (reason: unknown) => {
        if (!current) return;
        setUpdate({ reference, value: null });
        show({
          tone: "error",
          message: failureText(reason, "load the latest update"),
          action: {
            label: "Retry",
            run: () => setAttempt((count) => count + 1),
          },
        });
      },
    );
    return () => {
      current = false;
    };
  }, [reference, revision, attempt, show]);
  const attention = useInboxAttention();
  const ready = Boolean(
    ticket && update?.reference === ticket.reference && (!enabled || list),
  );
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
    setUpdate(null);
  } else if (ready && opening.reserved === null)
    setOpening({
      reference: ticket?.reference,
      reserved:
        chats.length > 0 ||
        projected.length > 0 ||
        Boolean(update?.value?.editing_agent),
    });
  return (
    <AgentContext
      value={{
        reserved:
          opening.reference === ticket?.reference && Boolean(opening.reserved),
        chat,
        update: ready ? (update?.value ?? null) : null,
      }}
    >
      {children(Boolean(ticket && !ready))}
    </AgentContext>
  );
}

export function TicketAgentHeader() {
  const agent = useContext(AgentContext);
  if (!agent || agent.reserved || agent.chat?.status.rank !== "working")
    return null;
  return (
    <Badge variant="record">
      <HarnessMark
        harness={agent.chat.harness_id}
        name={agent.chat.harness_name}
        decorative
      />{" "}
      Working
    </Badge>
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
