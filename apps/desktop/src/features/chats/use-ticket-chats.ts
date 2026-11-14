import { rankSchema, type ChatSummary } from "@/features/chats/client";
import type { TicketRecord } from "@/features/chats/ticket-chat";
import { useChatFeature } from "@/features/chats/use-chats";

/** What the ticket side needs of a ticket to show and start its Chats. */
export type ChatTicket = Omit<TicketRecord, "kind"> & { trashed: boolean };

/**
 * The Chat whose status the line shows: the highest rank (spec 21.3). None
 * when every Chat is idle and seen, so the line is only the count.
 */
export function topChat(chats: ChatSummary[]): ChatSummary | null {
  let top: ChatSummary | null = null;
  const order = rankSchema.options;
  for (const chat of chats)
    if (
      !top ||
      order.indexOf(chat.status.rank) < order.indexOf(top.status.rank)
    )
      top = chat;
  if (!top || (top.status.rank === "idle" && !top.status.unseen)) return null;
  return top;
}

/**
 * "Chat about this ticket": opens New Chat with the ticket linked, the
 * Project's folder chosen and an unsent prompt. Null while Chat is off or the
 * ticket is in Trash.
 */
export function useChatAboutTicket(
  ticket: ChatTicket | undefined,
  folder: string | null,
) {
  const { enabled, requestChat } = useChatFeature();
  if (!enabled || !ticket || ticket.trashed) return null;
  const record: TicketRecord = {
    kind: "ticket",
    id: ticket.id,
    reference: ticket.reference,
    title: ticket.title,
    status: ticket.status,
  };
  return () => requestChat({ kind: "new", start: { ticket: record, folder } });
}
