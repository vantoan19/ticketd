import { inboxClient } from "@/lib/api/inbox";
import { read, skip, useRead, type ReadState } from "@/lib/workspace-reads";
import { parts, type Part } from "../parts";

// The Ticket's reminder and whether the person follows it.

declare module "../parts" {
  interface Parts {
    /** When the reminder is due; null when there is none. */
    reminder: Part<[], ReadState<string | null>>;
    following: Part<[], ReadState<boolean>>;
  }
}

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

parts.reminder = function useReminderPart(record) {
  return useRead(reminderRead, record?.reference ?? skip);
};

parts.following = function useFollowingPart(record) {
  return useRead(followingRead, record?.reference ?? skip);
};
