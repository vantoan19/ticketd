import { createContext, useContext } from "react";
import type { Entry } from "@/lib/api/inbox";
import type { ChatSummary } from "@/features/chats/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import type { AttentionContext } from "./inboxModel";
export type Attention = AttentionContext & {
  entries: Entry[];
  approvals: ChatSummary[];
  needsCount: number;
  loading: boolean;
  error: FailureDescription | null;
  reload: () => void;
};
export const InboxAttentionContext = createContext<Attention | null>(null);
export const useInboxAttention = () => useContext(InboxAttentionContext);
