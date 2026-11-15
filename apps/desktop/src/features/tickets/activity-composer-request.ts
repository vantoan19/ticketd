/** Direct keys and Inbox replies open the existing Activity composer, including its empty fold. */
export function requestTicketUpdate(reference: string, quote?: string) {
  window.dispatchEvent(
    new CustomEvent("ticketd:write-update", { detail: { reference, quote } }),
  );
}
export function onTicketUpdate(
  reference: string,
  open: (quote?: string) => void,
) {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && event.detail.reference === reference)
      open(event.detail.quote);
  };
  window.addEventListener("ticketd:write-update", listener);
  return () => window.removeEventListener("ticketd:write-update", listener);
}
