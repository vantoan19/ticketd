import type { TranscriptItem } from "@/features/chats/client";

/**
 * The ids of steers the harness has taken but not yet acted on. A steer is
 * read after the agent's current step, and the host reports no moment for
 * that, so the steer waits for as long as nothing the agent did (a step, its
 * words, a request) follows it in the transcript, and only while a turn runs.
 * Its own delivery caption ("Sending…", "Not sent") says everything before it
 * is taken.
 */
export function steersAwaitingRead(
  items: readonly TranscriptItem[],
  working: boolean,
): ReadonlySet<string> {
  const waiting = new Set<string>();
  if (!working) return waiting;
  for (const item of items) {
    if (item.kind === "user") {
      if (item.steer && item.delivery === "delivered") waiting.add(item.id);
    } else if (item.kind !== "turn" && item.kind !== "session") {
      // The agent acted after it: nothing sent before that is still waiting.
      waiting.clear();
    }
  }
  return waiting;
}

/** The caption under a steer that is waiting to be read. */
export const steerCaption = (harness: string) =>
  `${harness} reads this after its current step`;
