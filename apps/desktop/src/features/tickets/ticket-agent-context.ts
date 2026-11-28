import { createContext } from "react";
import type { LatestUpdate } from "@/lib/api/progress";
import type { TicketAgentState } from "./ticket-agent-state";

export const AgentContext = createContext<{
  reference: string | undefined;
  openedWithCard: boolean | null;
  ready: boolean;
  state: TicketAgentState | null;
  reportUnknownAnswer: () => void;
  update: LatestUpdate | null;
} | null>(null);
