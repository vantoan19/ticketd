import { useCallback, useState } from "react";

/** A disclosure's explicit choice survives reopening the ticket on this device. */
export function useLinkedGroup(
  ticketId: string,
  group: string,
  defaultOpen: boolean,
) {
  const key = `ticketd.linked-group.${ticketId}.${group}`;
  const [choice, setChoice] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === "open") return true;
      if (stored === "closed") return false;
    } catch {
      // The disclosure still works when browser storage is unavailable.
    }
    return undefined;
  });
  const setOpen = useCallback(
    (open: boolean, persist = true) => {
      setChoice(open);
      if (!persist) return;
      try {
        localStorage.setItem(key, open ? "open" : "closed");
      } catch {
        // Keep the choice for this opening.
      }
    },
    [key],
  );
  return [choice ?? defaultOpen, setOpen] as const;
}
