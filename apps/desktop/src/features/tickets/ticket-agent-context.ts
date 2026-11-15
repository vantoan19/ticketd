import { createContext } from "react";
import type { ChatSummary } from "@/features/chats/client";
import type { LatestUpdate } from "@/lib/api/progress";
export const AgentContext = createContext<{
  reserved: boolean;
  ready: boolean;
  chat: ChatSummary | undefined;
  update: LatestUpdate | null;
} | null>(null);
