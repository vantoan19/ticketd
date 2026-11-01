import type { Ticket, TicketSource } from "@/lib/api/client";

/** The statuses a person manages locally while an externally owned issue is open. */
export const localProgressStatuses = ["Todo", "In progress", "In review"];

export function providerName(provider: string): string {
  return provider === "github" ? "GitHub" : provider;
}

/** The source of a ticket the provider currently owns; null for local tickets. */
export function externalSource(ticket: Ticket): TicketSource | null {
  return ticket.source?.ownership === "external" ? ticket.source : null;
}

/** The provider's number for the issue, such as "#98", from its locator. */
export function externalNumber(source: TicketSource): string {
  const index = source.locator.lastIndexOf("#");
  return index >= 0 ? source.locator.slice(index) : "";
}

/** Where the issue lives, such as "owner / repo #98". */
export function sourceLocation(source: TicketSource): string {
  const index = source.locator.lastIndexOf("#");
  const place = index >= 0 ? source.locator.slice(0, index) : source.locator;
  return `${place.replace("/", " / ")} ${externalNumber(source)}`.trim();
}

/** The state line's words, and the tone of its dot, if it has one. */
export function sourceState(source: TicketSource): {
  text: string;
  tone: "positive" | "attention" | null;
} {
  const name = providerName(source.provider);
  if (source.unavailable)
    return { text: "Source unavailable", tone: "attention" };
  if (source.state.state === "open")
    return { text: `Open on ${name}`, tone: "positive" };
  switch (source.state.reason) {
    case "completed":
      return { text: `Closed on ${name} as completed`, tone: null };
    case "not_planned":
      return { text: `Closed on ${name} as not planned`, tone: null };
    case "duplicate":
      return { text: `Closed on ${name} as a duplicate`, tone: null };
    case "unknown":
      return {
        text: `Closed on ${name}; the reason is not recognized`,
        tone: "attention",
      };
  }
}

/** "just now", "4 min ago", "2 h ago", "3 d ago"; null when the time cannot be read. */
export function ago(iso: string, now = Date.now()): string | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "Synced 4 min ago", or that the ticket has not been confirmed yet. */
export function freshness(source: TicketSource, now = Date.now()): string {
  if (!source.last_refreshed_at) return "Not synced yet";
  return `Synced ${ago(source.last_refreshed_at, now) ?? source.last_refreshed_at}`;
}

/** Whether the source cannot be read, and what to say about it. Never implies completion. */
export function unavailableNotice(
  source: TicketSource,
  now = Date.now(),
): { title: string; detail: string; since: string } | null {
  const unavailable = source.unavailable;
  if (!unavailable || source.ownership !== "external") return null;
  const name = providerName(source.provider);
  const since = ago(unavailable.since, now) ?? unavailable.since;
  return {
    title: "Source unavailable",
    detail: `${name} could not be reached for ${source.display}: ${unavailable.message} Nothing was deleted or completed.`,
    since: `Since ${since}`,
  };
}

/** What a closed duplicate says about its canonical issue, never inventing one. */
export function duplicateTargetText(source: TicketSource): string | null {
  const target = source.duplicate_target;
  if (!target) return null;
  return target.kind === "external"
    ? `Duplicate of ${target.display}`
    : "Duplicate; the source did not name an accessible original";
}
