/** Direct keys and Inbox replies open the existing Activity composer, including its empty fold. */
export function requestTicketUpdate(
  reference: string,
  quote?: string,
  preferCard = false,
) {
  if (
    preferCard &&
    !window.dispatchEvent(
      new CustomEvent("ticketd:reply-in-card", { detail: { reference }, cancelable: true }),
    )
  )
    return;
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


/** An idle In progress ticket lets its card handle the shortcut first. */
export function onTicketCardReply(reference: string, open: () => void) {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.detail.reference !== reference) return;
    event.preventDefault();
    open();
  };
  window.addEventListener("ticketd:reply-in-card", listener);
  return () => window.removeEventListener("ticketd:reply-in-card", listener);
}
