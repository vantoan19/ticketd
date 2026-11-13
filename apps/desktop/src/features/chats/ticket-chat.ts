import type { LinkedRecord, Retention } from "@/features/chats/client";
import type { Token } from "@/features/chats/composer-mentions";

export type TicketRecord = Extract<LinkedRecord, { kind: "ticket" }>;

/** What "Chat about this ticket" starts from: the ticket, and its Project's folder if any. */
export type TicketStart = { ticket: TicketRecord; folder: string | null };

/**
 * A request, from outside the Chats screen, to show a Chat there: an existing
 * one opened from a ticket (which its crumb returns to), or New Chat about a
 * ticket. `n` rises with each request.
 */
export type ChatRequest =
  | {
      kind: "open";
      chatId: string;
      retention: Retention;
      /** The ticket it was opened from: its crumb goes back there. */
      from?: string;
    }
  | { kind: "new"; start: TicketStart };

/** The unsent prompt New Chat opens with: the ticket as a mention, then its title. */
export function ticketPrompt(ticket: TicketRecord): {
  text: string;
  tokens: Token[];
} {
  const lead = "Work on ";
  return {
    text: `${lead}${ticket.reference}: ${ticket.title}`,
    tokens: [
      {
        kind: "record",
        start: lead.length,
        end: lead.length + ticket.reference.length,
        text: ticket.reference,
        record: ticket,
      },
    ],
  };
}
