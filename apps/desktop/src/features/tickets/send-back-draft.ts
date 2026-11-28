import { z } from "zod";
import type { DraftRecovery } from "@/lib/draft-recovery-context";

const draftSchema = z.object({
  brief: z.string(),
  requestId: z.string().nullable(),
});
export type SendBackDraft = z.infer<typeof draftSchema>;

const owner = (id: string) => `send-back:${id}`;
const draftKey = (id: string) => `ticketd:${owner(id)}`;

export function readSendBackDraft(
  recovery: DraftRecovery,
  id: string,
): SendBackDraft | null {
  if (recovery.active) return recovery.read(owner(id), draftSchema);
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw === null ? null : draftSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function keepSendBackDraft(
  recovery: DraftRecovery,
  id: string,
  draft: SendBackDraft | null,
) {
  if (recovery.active) {
    await recovery.put(owner(id), draft, draft ? [draft.brief] : []);
  } else if (draft) {
    localStorage.setItem(draftKey(id), JSON.stringify(draft));
  } else {
    localStorage.removeItem(draftKey(id));
  }
}
