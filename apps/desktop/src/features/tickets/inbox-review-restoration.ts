import { z } from "zod";
import type { Entry } from "./inboxModel";
import type { Entry as HistoryEntry } from "@/lib/api/history";

const transitionSchema = z.object({
  kind: z.literal("status"),
  from_value: z.string(),
  to_value: z.literal("In review"),
  timestamp: z.string(),
  editing_agent: z.string().nullable(),
});
const restorationSchema = z.object({
  id: z.number(),
  reference: z.string(),
  originalTimestamp: z.string(),
  originalAgent: z.string(),
  transition: transitionSchema,
});
const restorationsSchema = z.array(restorationSchema);
export type ReviewRestoration = z.infer<typeof restorationSchema>;
const key = (workspaceId: string) => `ticketd.inbox-review-undo:${workspaceId}`;
export function readReviewRestorations(
  workspaceId: string,
): ReviewRestoration[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(key(workspaceId)) ?? "[]",
    );
    const result = restorationsSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
export function writeReviewRestorations(
  workspaceId: string,
  entries: ReviewRestoration[],
) {
  localStorage.setItem(key(workspaceId), JSON.stringify(entries));
}
export function restorationFor(
  entry: Entry,
  transition: HistoryEntry,
): ReviewRestoration {
  return restorationSchema.parse({
    id: entry.id,
    reference: entry.reference,
    originalTimestamp: entry.timestamp,
    originalAgent: entry.editing_agent,
    transition,
  });
}

export function hasReviewRestorations() {
  try {
    return Object.keys(localStorage).some((key) =>
      key.startsWith("ticketd.inbox-review-undo:"),
    );
  } catch {
    return false;
  }
}
