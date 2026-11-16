import { inboxClient } from "@/lib/api/inbox";
import type { Ticket } from "@/lib/api/client";
import { read, skip, useRead } from "@/lib/workspace-reads";

// The Ticket's reminder and whether the person follows it.

const reminderRead = read({
  key: "reminder",
  call: (reference: string) => inboxClient.reminder(reference),
  failure: "load the reminder",
});

const followingRead = read({
  key: "following",
  call: (reference: string) => inboxClient.isFollowing(reference),
  failure: "check Follow",
});

/** When the reminder is due; null when there is none. */
export function useReminder(record: Ticket | undefined) {
  return useRead(reminderRead, record?.reference ?? skip);
}

/** Whether the person follows the Ticket. */
export function useFollowing(record: Ticket | undefined) {
  return useRead(followingRead, record?.reference ?? skip);
}
