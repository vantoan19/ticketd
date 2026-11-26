import { useEffect, useRef } from "react";
import { inboxClient } from "@/lib/api/inbox";
import { notificationClient } from "@/lib/api/notifications";
import { notificationsAllowed } from "@/lib/notification-permission";
import { useOnWorkspaceChange } from "@/lib/workspace-change";

/**
 * Shows one system notification per reminder that comes due while ticketd is
 * open and the system allows notifications. Reminders already in the inbox when this
 * starts stay inbox-only. `open` receives the ticket to show when the person
 * clicks the notification. The desktop delivers a reminder to the inbox when it
 * comes due, which moves the change token, so the inbox is read on each
 * workspace change rather than on a timer of its own.
 */
export function useReminderNotifications(open: (reference: string) => void) {
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  const changed = useRef(() => {});
  useOnWorkspaceChange(() => changed.current());
  useEffect(() => {
    let active = true;
    let busy = false;
    // A change that came during a read is read once that read ends.
    let again = false;
    let seen: number | null = null;
    let stopListening: (() => void) | undefined;
    async function check() {
      if (busy) {
        again = true;
        return;
      }
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
        if (due.length === 0 || !(await notificationsAllowed())) return;
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
        if (again && active) {
          again = false;
          void check();
        }
      }
    }
    function start() {
      if (!active) return;
      void check();
      changed.current = () => void check();
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
      changed.current = () => {};
      stopListening?.();
    };
  }, []);
}
