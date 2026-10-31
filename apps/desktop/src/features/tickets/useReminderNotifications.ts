import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { notificationClient } from "@/lib/api/notifications";
import { usePreferences } from "@/lib/preferences";
import { parseEntries } from "./inboxModel";

const POLL_MS = 5000;
// Desktop notifications report no click, so returning to the window soon after
// one appears is treated as activating it.
const ACTIVATION_WINDOW_MS = 30_000;

/**
 * Shows one system notification per reminder that comes due while ticketd is
 * open and the preference is on. Reminders already in the inbox when this
 * starts stay inbox-only. `open` receives the ticket to show when the person
 * returns to ticketd from the notification.
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
    let pending: { reference: string; at: number } | null = null;
    async function check() {
      if (busy) return;
      busy = true;
      try {
        const entries = parseEntries(
          await invoke("inbox", { offset: 0, limit: 20, unreadOnly: false }),
        );
        if (!active) return;
        const newest = Math.max(0, ...entries.map((entry) => entry.id));
        if (seen === null) {
          seen = newest;
          return;
        }
        const previous = seen;
        seen = Math.max(previous, newest);
        const due = entries
          .filter((entry) => entry.kind === "reminder" && entry.id > previous)
          .reverse();
        if (due.length === 0 || !(await notificationClient.permitted())) return;
        for (const entry of due) {
          notificationClient.notify(
            entry.title,
            `${entry.reference}: reminder is due`,
          );
          pending = { reference: entry.reference, at: Date.now() };
        }
      } catch {
        // Notifications are best effort; the inbox still shows every reminder.
      } finally {
        busy = false;
      }
    }
    const onFocus = () => {
      if (pending && Date.now() - pending.at < ACTIVATION_WINDOW_MS) {
        const { reference } = pending;
        pending = null;
        openRef.current(reference);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [notifyReminders]);
}
