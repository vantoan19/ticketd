import { createContext, useContext } from "react";
import type { Entry } from "@/lib/api/inbox";
import type { ChatSummary } from "@/features/chats/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import type { AttentionContext } from "./inboxModel";
export type Attention = AttentionContext & {
  entries: Entry[];
  approvals: ChatSummary[];
  /** Active summaries shared by ticket state lanes; no per-row queries. */
  chats: ChatSummary[];
  needsCount: number;
  loading: boolean;
  error: FailureDescription | null;
  reload: () => void;
  readLatest?: () => Promise<Attention>;
  restoreReview?: (entry: Entry) => Promise<void>;
};
export const InboxAttentionContext = createContext<Attention | null>(null);
export const useInboxAttention = () => useContext(InboxAttentionContext);
