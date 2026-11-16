import type { StatusLine } from "@/components/ui/use-status-line";
import { createContext, useContext } from "react";
import type { ChatSummary } from "@/features/chats/client";
import type { Entry } from "./inboxModel";

export type TriageSelection =
  { kind: "entry"; entry: Entry } | { kind: "approval"; chat: ChatSummary };
export function triageId(selection: TriageSelection) {
  return selection.kind === "entry"
    ? `entry:${selection.entry.id}`
    : `chat:${selection.chat.id}`;
}
export const InboxTriageContext = createContext<{
  selection: TriageSelection | null;
  line: StatusLine;
  chatId: string | null;
  openChat: (id: string | null) => void;
  position: { index: number; total: number } | null;
  setPosition: (position: { index: number; total: number } | null) => void;
  adjacent: (direction: 1 | -1) => void;
  registerWalk: (callback: (direction: 1 | -1) => void) => void;
  choose: (selection: TriageSelection | null) => void;
} | null>(null);
export function useInboxTriage() {
  return useContext(InboxTriageContext);
}
