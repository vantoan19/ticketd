import { createContext } from "react";
import type { ChatSummary } from "@/features/chats/client";
import type { TicketAgent } from "@/features/chats/ticket-agents";
import type { LatestUpdate } from "@/lib/api/progress";
export const AgentContext = createContext<{
  reserved: boolean;
  ready: boolean;
  chat: ChatSummary | undefined;
  /** The agents at work on the ticket, as the host lists them; empty when it lists none. */
  agents: TicketAgent[];
  update: LatestUpdate | null;
} | null>(null);
