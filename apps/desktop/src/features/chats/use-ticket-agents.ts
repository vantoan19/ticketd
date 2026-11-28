import { useEffect, useEffectEvent, useState } from "react";
import { useChatClient } from "@/features/chats/client";
import { useChatFeature } from "@/features/chats/use-chats";
import type { TicketAgent } from "@/features/chats/ticket-agents";

/**
 * The agents at work on one ticket, kept current: refetched whenever the host
 * says anything changed. Null until the first answer for this ticket. A host
 * that cannot say (an older one, or a failed read) is no list: the ticket's
 * line then works from its linked Chats alone, as it did before.
 */
export function useTicketAgents(ticketId: string | null): TicketAgent[] | null {
  const client = useChatClient();
  const { enabled, revision } = useChatFeature();
  const [state, setState] = useState<{
    ticketId: string;
    agents: TicketAgent[];
  } | null>(null);
  const read = useEffectEvent((id: string) => client.ticketAgents(id));
  useEffect(() => {
    if (!enabled || !ticketId) return;
    let current = true;
    read(ticketId).then(
      (agents) => current && setState({ ticketId, agents }),
      () => current && setState({ ticketId, agents: [] }),
    );
    return () => {
      current = false;
    };
  }, [client, enabled, ticketId, revision]);
  if (!enabled || !ticketId) return [];
  return state?.ticketId === ticketId ? state.agents : null;
}
