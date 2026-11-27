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

/**
 * When something happened, in words: "just now", "a minute ago", "3 hours ago",
 * "yesterday". `null` when the time cannot be read.
 */
export function agoWords(iso: string, now: number): string | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "an hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
