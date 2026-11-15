export type InboxAction =
  "primary" | "reply" | "remind" | "read" | "next" | "previous";
/** Palette actions use the same selected-entry handlers as direct keys. */
export function requestInboxAction(action: InboxAction) {
  window.dispatchEvent(
    new CustomEvent("ticketd:inbox-action", { detail: action }),
  );
}
export function onInboxAction(run: (action: InboxAction) => void) {
  const listener = (event: Event) => {
    if (
      event instanceof CustomEvent &&
      ["primary", "reply", "remind", "read", "next", "previous"].includes(
        event.detail,
      )
    )
      run(event.detail);
  };
  window.addEventListener("ticketd:inbox-action", listener);
  return () => window.removeEventListener("ticketd:inbox-action", listener);
}
