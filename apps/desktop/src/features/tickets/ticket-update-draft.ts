import { z } from "zod";
import type { DraftRecovery } from "@/lib/draft-recovery-context";

const draftSchema = z.object({
  brief: z.string(),
  requestId: z.string().nullable(),
});
export type TicketUpdateDraft = z.infer<typeof draftSchema>;

type DraftKind = "send-back" | "reply";

export function readTicketUpdateDraft(
  recovery: DraftRecovery,
  id: string,
  kind: DraftKind,
): TicketUpdateDraft | null {
  const owner = `${kind}:${id}`;
  if (recovery.active) return recovery.read(owner, draftSchema);
  try {
    const raw = localStorage.getItem(`ticketd:${owner}`);
    return raw === null ? null : draftSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function keepTicketUpdateDraft(
  recovery: DraftRecovery,
  id: string,
  kind: DraftKind,
  draft: TicketUpdateDraft | null,
) {
  const owner = `${kind}:${id}`;
  if (recovery.active) {
    await recovery.put(owner, draft, draft ? [draft.brief] : []);
  } else if (draft) {
    localStorage.setItem(`ticketd:${owner}`, JSON.stringify(draft));
  } else {
    localStorage.removeItem(`ticketd:${owner}`);
  }
}
