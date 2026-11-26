import { ago } from "@/features/tickets/ticket-source";
import type { SyncCounts, SyncStatus } from "@/lib/sync-api";

/** Where the Workspace's files are, as the setup and its notices speak of it. */
export const placeOf = (provider: SyncStatus["provider"]) =>
  provider === "s3" ? "the bucket" : "Drive";

export const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

/** Every kind of record counted, as the Replace review lists them. */
export const contents = (counts: SyncCounts) =>
  [
    plural(counts.tickets, "ticket"),
    plural(counts.documents, "Document"),
    plural(counts.attachments, "Attachment"),
  ].join(", ");

/** What joining replaces on this computer, in words; `null` when it holds nothing. */
export function replacesHere(
  local: Pick<SyncCounts, "tickets" | "documents">,
): string | null {
  const parts = [
    local.tickets > 0 ? plural(local.tickets, "ticket") : null,
    local.documents > 0 ? plural(local.documents, "Document") : null,
  ].filter((part) => part !== null);
  return parts.length > 0
    ? `Replaces the ${parts.join(" and ")} on this computer`
    : null;
}

/** When a Workspace in the storage was last synced, as "yesterday" or "2 h ago"; `null` when unknown. */
export function lastSynced(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const words = ago(iso, now);
  return words === "1 d ago" ? "yesterday" : words;
}
