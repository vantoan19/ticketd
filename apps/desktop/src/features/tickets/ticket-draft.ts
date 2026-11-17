import { z } from "zod";
import type { DraftRecovery } from "@/lib/draft-recovery-context";

/** Where a Ticket's unsaved title or description waits on a device without recovery. */
export const ticketDraftKey = (id: string) => `ticketd:ticket-draft:${id}`;

/**
 * The Ticket's editor holds an unsaved draft: in draft recovery (its owner,
 * as `TicketEditor` names it) or, without recovery, in local storage.
 */
export function hasTicketDraft(recovery: DraftRecovery, id: string): boolean {
  if (recovery.active)
    return recovery.read(`ticket:${id}`, z.unknown()) != null;
  try {
    return localStorage.getItem(ticketDraftKey(id)) !== null;
  } catch {
    return false;
  }
}
