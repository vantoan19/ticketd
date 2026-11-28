export const TICKET_DESCRIPTION_REVEAL = "ticketd:reveal-description";

export type TicketDescriptionReveal = {
  ticketId: string;
  target: "acceptance" | { headingOffset: number };
};

/** Reveal a heading at its Markdown source offset, opening any fold around it. */
export function revealTicketDescription(
  ticketId: string,
  target: TicketDescriptionReveal["target"],
) {
  window.dispatchEvent(
    new CustomEvent<TicketDescriptionReveal>(TICKET_DESCRIPTION_REVEAL, {
      detail: { ticketId, target },
    }),
  );
}
