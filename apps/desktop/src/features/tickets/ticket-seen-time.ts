import { useLayoutEffect, useRef, useState } from "react";
import { attachments } from "@/lib/api/attachments";
import { windowQuittingEvent } from "@/lib/api/window";

function readSeenTime(key: string): number | null {
  try {
    const value = localStorage.getItem(key);
    if (value !== null && Number.isFinite(Number(value))) return Number(value);
  } catch {
    // A device without local storage has no earlier visit to compare with.
  }
  return null;
}

/** The previous visit's cutoff for the entire time this ticket is visible. */
export function useTicketSeenTime(ticketId: string, active: boolean) {
  const [seen, setSeen] = useState<{
    ticketId: string;
    time: number | null;
  } | null>(null);
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) setSeen(null);
  }
  const visit = useRef<{ ticketId: string } | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      visit.current = null;
      return;
    }
    const opened = { ticketId };
    visit.current = opened;
    let visible = true;
    let quitting = false;
    let key: string | undefined;
    let leftAt: number | undefined;
    function save(time: number) {
      leftAt = time;
      if (!key) return;
      try {
        if (time > (readSeenTime(key) ?? -Infinity))
          localStorage.setItem(key, String(time));
      } catch {
        // Seen time is local reading history and may be unavailable.
      }
    }
    void attachments
      .workspaceId()
      .then((workspaceId) => {
        key = `ticketd:ticket-seen:${encodeURIComponent(workspaceId)}:${ticketId}`;
        if (visible) setSeen({ ticketId, time: readSeenTime(key) });
        if (leftAt !== undefined) save(leftAt);
      })
      .catch(() => {});
    function onQuit() {
      if (quitting) return;
      quitting = true;
      save(Date.now());
    }
    window.addEventListener(windowQuittingEvent, onQuit);
    window.addEventListener("beforeunload", onQuit);
    return () => {
      visible = false;
      window.removeEventListener(windowQuittingEvent, onQuit);
      window.removeEventListener("beforeunload", onQuit);
      if (quitting) return;
      const time = Date.now();
      // A Strict Mode effect replay immediately starts the same visit again.
      queueMicrotask(() => {
        if (visit.current === opened || visit.current?.ticketId !== ticketId)
          save(time);
      });
    };
  }, [active, ticketId]);
  return active && seen?.ticketId === ticketId ? seen.time : null;
}

export function isNewUpdate(
  update: { editing_agent: string | null; reported_at: string },
  seenTime: number | null,
): boolean {
  return (
    seenTime !== null &&
    Boolean(update.editing_agent) &&
    Date.parse(update.reported_at) > seenTime
  );
}
