import { useEffect, useRef } from "react";
import { inboxClient } from "@/lib/api/inbox";
import { notificationClient } from "@/lib/api/notifications";
import { usePreferences } from "@/lib/preferences";

const POLL_MS = 5000;

/**
 * Shows one system notification per reminder that comes due while ticketd is
 * open and the preference is on. Reminders already in the inbox when this
 * starts stay inbox-only. `open` receives the ticket to show when the person
 * clicks the notification.
 */
export function useReminderNotifications(open: (reference: string) => void) {
  const { notifyReminders } = usePreferences();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    if (!notifyReminders) return;
    let active = true;
    let busy = false;
    let seen: number | null = null;
    let timer: number | undefined;
    let stopListening: (() => void) | undefined;
    async function check() {
      if (busy) return;
      busy = true;
      try {
        const entries = await inboxClient.list({
          offset: 0,
          limit: 20,
          unreadOnly: false,
        });
        if (!active) return;
        const newest = Math.max(0, ...entries.map((entry) => entry.id));
        // A restored workspace brings an older inbox whose ids start lower, so
        // ids that fall below the highest seen mean the inbox was replaced.
        const previous = seen === null || newest < seen ? newest : seen;
        const first = seen === null;
        seen = Math.max(previous, newest);
        if (first) return;
        const due = entries
          .filter((entry) => entry.kind === "reminder" && entry.id > previous)
          .reverse();
        if (due.length === 0 || !(await notificationClient.permitted())) return;
        for (const entry of due)
          notificationClient.notify(
            entry.title,
            `${entry.reference}: reminder is due`,
            entry.reference,
          );
      } catch {
        // Notifications are best effort; the inbox still shows every reminder.
      } finally {
        busy = false;
      }
    }
    function start() {
      if (!active) return;
      void check();
      timer = window.setInterval(() => void check(), POLL_MS);
    }
    // The listener goes first: clicks are reported only for notifications shown
    // while one exists. Without it the notifications still appear.
    notificationClient
      .onClick((reference) => openRef.current(reference))
      .then(
        (stop) => {
          if (active) stopListening = stop;
          else stop();
        },
        () => {},
      )
      .finally(start);
    return () => {
      active = false;
      window.clearInterval(timer);
      stopListening?.();
    };
  }, [notifyReminders]);
}
