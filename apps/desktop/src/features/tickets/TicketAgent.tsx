import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TriangleAlert } from "lucide-react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { rankSchema, type ChatSummary } from "@/features/chats/client";
import { useChatFeature, useLinkedChats } from "@/features/chats/use-chats";
import { useTicketAgents } from "@/features/chats/use-ticket-agents";
import type { Ticket } from "@/lib/api/client";
import { ariaKeyShortcuts } from "@/lib/shortcuts";
import { useInboxAttention } from "./use-inbox-attention";
import { useLatestUpdateOf, type TicketState } from "./open-ticket";
import { AgentContext } from "./ticket-agent-context";
import {
  agentState,
  useOpenTicketAgentChat,
  useAgentActivityTime,
} from "./ticket-agent-state";

function mergeChatSummaries(projected: ChatSummary[], linked: ChatSummary[]) {
  const byId = new Map(projected.map((chat) => [chat.id, chat]));
  for (const chat of linked) {
    const previous = byId.get(chat.id);
    if (!previous) {
      byId.set(chat.id, chat);
      continue;
    }
    // Request and resolution both update the Chat's timestamp. When the reads
    // have the same timestamp, keep the higher-ranked request from either.
    const recency =
      Date.parse(chat.updated_at) - Date.parse(previous.updated_at);
    if (
      recency > 0 ||
      (!recency &&
        (chat.status.rank === "approval" || chat.status.rank === "question") &&
        rankSchema.options.indexOf(chat.status.rank) <
          rankSchema.options.indexOf(previous.status.rank))
    )
      byId.set(chat.id, chat);
  }
  return [...byId.values()];
}

/** Keep the opening's decision to give agents room in the document. */
export function TicketAgentSession({
  selected,
  record,
  preview,
  children,
}: {
  selected: string | null;
  record: TicketState;
  preview: Ticket | undefined;
  children: (loading: boolean) => ReactNode;
}) {
  const ticket = record.value === undefined ? preview : record.value;
  const { enabled, checking } = useChatFeature();
  const { show } = useStatusLine();
  const selection = useMemo(() => ({ reference: selected }), [selected]);
  const currentSelection = useRef<typeof selection | null>(null);
  const dismissUnknownAnswer = useRef<(() => void) | void>(undefined);
  useLayoutEffect(() => {
    currentSelection.current = selection;
    return () => {
      currentSelection.current = null;
      dismissUnknownAnswer.current?.();
      dismissUnknownAnswer.current = undefined;
    };
  }, [selection]);
  function reportUnknownAnswer() {
    // The request card can close while its ticket is still selected.
    if (!selection.reference || currentSelection.current !== selection) return;
    dismissUnknownAnswer.current = show({
      tone: "error",
      message: "Couldn't confirm whether the answer arrived.",
    });
  }
  const { list } = useLinkedChats(
    ticket && enabled ? { kind: "ticket", id: ticket.id } : null,
  );
  const reference = ticket?.reference;
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

  const attention = useInboxAttention();
  const agents = useTicketAgents(ticket && enabled ? ticket.id : null);
  const linked = enabled ? (list?.chats ?? []) : [];
  const projected = enabled
    ? (attention?.chats.filter((chat) =>
        chat.tickets.some((link) => link.reference === reference),
      ) ?? [])
    : [];
  const chats = mergeChatSummaries(projected, linked);
  const now = useAgentActivityTime(chats);
  const state = agentState(chats, agents ?? [], now);
  const [opening, setOpening] = useState<{
    reference: string | undefined;
    withCard: boolean | null;
  }>({ reference, withCard: null });
  const sameOpening = opening.reference === reference;
  const placed = opening.withCard !== null;
  const currentTicket = !placed && record.current ? record.value : undefined;
  const ready =
    sameOpening &&
    Boolean(
      ticket &&
      (placed || currentTicket || record.failure) &&
      (placed || failure || (latest.current && latest.value !== undefined)) &&
      !checking &&
      (!enabled || (list && agents)),
    );
  if (!sameOpening) {
    setOpening({ reference, withCard: null });
  } else if (ready && currentTicket && !placed) {
    const { status, trashed } = currentTicket;
    setOpening({
      reference,
      withCard:
        Boolean(state) ||
        (!trashed && (status === "In review" || status === "In progress")),
    });
  }
  return (
    <AgentContext
      value={{
        reference,
        ready,
        openedWithCard: sameOpening ? opening.withCard : null,
        state,
        reportUnknownAnswer,
        update:
          latest.value === undefined
            ? (ticket?.progress_summary ?? null)
            : latest.value,
      }}
    >
      {children(Boolean(ticket && !ready))}
    </AgentContext>
  );
}

export function TicketAgentHeader({ reference }: { reference: string }) {
  const agent = useContext(AgentContext);
  const showingCue =
    agent?.ready &&
    agent.openedWithCard === false &&
    agent.reference === reference;
  const state =
    showingCue &&
    (agent.state?.kind === "working" || agent.state?.kind === "request")
      ? agent.state
      : null;
  const { openChat, setOrigin } = useOpenTicketAgentChat(state, reference);
  if (state?.kind === "request") {
    const label = state.request === "question" ? "Question" : "Approval needed";
    return (
      <Tooltip content="Review the request in Chat">
        <Button
          ref={setOrigin}
          aria-keyshortcuts={ariaKeyShortcuts("ticket-agent-chat")}
          aria-label="Review request"
          aria-description={label}
          variant="attention"
          size="compact-responsive"
          onClick={openChat}
        >
          <span className="ticket-agent-header-long">
            <StatusDot tone="attention" size={6} />
          </span>
          <span className="ticket-agent-header-long">{label}</span>
          <TriangleAlert
            className="ticket-agent-header-short"
            aria-hidden="true"
          />
        </Button>
      </Tooltip>
    );
  }
  if (state?.kind !== "working") return null;
  const working = state.agents[0] ?? state.chat;
  if (!working) return null;
  return (
    <Tooltip content="Working">
      <Badge
        ref={setOrigin}
        variant="record"
        size="compact-responsive"
        role="status"
        aria-label="Working"
      >
        <HarnessMark
          harness={working.harness_id}
          name={working.harness_name}
          decorative
        />
        <span className="ticket-agent-header-long">Working</span>
      </Badge>
    </Tooltip>
  );
}
