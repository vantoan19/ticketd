import { useContext, useEffect, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { useChatFeature, useLinkedChats } from "@/features/chats/use-chats";
import { useTicketAgents } from "@/features/chats/use-ticket-agents";
import type { Ticket } from "@/lib/api/client";
import { useInboxAttention } from "./use-inbox-attention";
import { useLatestUpdateOf } from "./open-ticket";
import { AgentContext } from "./ticket-agent-context";
import {
  agentState,
  openAgentChat,
  useAgentActivityTime,
} from "./ticket-agent-state";

/** Keep the opening's decision to give agents room in the document. */
export function TicketAgentSession({
  ticket,
  children,
}: {
  ticket: Ticket | undefined;
  children: (loading: boolean) => ReactNode;
}) {
  const { enabled, checking } = useChatFeature();
  const { show } = useStatusLine();
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
  const chats = [
    ...projected,
    ...linked.filter(
      (chat) => !projected.some((current) => current.id === chat.id),
    ),
  ];
  const now = useAgentActivityTime(chats);
  const state = agentState(chats, agents ?? [], now);
  const [opening, setOpening] = useState<{
    reference: string | undefined;
    ready: boolean;
    withCard: boolean | null;
  }>({ reference, ready: false, withCard: null });
  const sameOpening = opening.reference === reference;
  const ready =
    sameOpening &&
    Boolean(
      ticket &&
      (opening.ready ||
        failure ||
        (latest.current && latest.value !== undefined)) &&
      !checking &&
      (!enabled || (list && agents)),
    );
  if (!sameOpening) {
    setOpening({ reference, ready: false, withCard: null });
  } else if (ready && !opening.ready) {
    setOpening({
      reference,
      ready: true,
      withCard:
        Boolean(state) ||
        (!ticket?.trashed &&
          (ticket?.status === "In review" || ticket?.status === "In progress")),
    });
  }
  return (
    <AgentContext
      value={{
        reference,
        ready,
        openedWithCard: sameOpening ? opening.withCard : null,
        state,
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
  const { requestChat } = useChatFeature();
  const agent = useContext(AgentContext);
  if (
    !agent?.ready ||
    agent.openedWithCard !== false ||
    agent.reference !== reference
  )
    return null;
  const state = agent.state;
  if (state?.kind === "request")
    return (
      <Tooltip content="Review the request in Chat">
        <Button
          aria-label="Review request"
          aria-description="Approval needed"
          variant="attention"
          size="compact-responsive"
          onClick={() =>
            requestChat(openAgentChat(state.target, reference, true))
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
  if (state?.kind !== "working") return null;
  const working = state.agents[0] ?? state.chat;
  if (!working) return null;
  return (
    <Tooltip content="Working">
      <Badge
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
