import type { DuplicateTarget, Ticket, TicketSource } from "@/lib/api/client";

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

/** "Synced 4 min ago", or that the ticket has not been confirmed yet. */
export function freshness(source: TicketSource, now = Date.now()): string {
  if (!source.last_refreshed_at) return "Not synced yet";
  const then = new Date(source.last_refreshed_at).getTime();
  if (Number.isNaN(then)) return `Synced ${source.last_refreshed_at}`;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  return `Synced ${Math.floor(hours / 24)} d ago`;
}

/**
 * How a closed duplicate's canonical target reads. An external-only target is
 * never presented as a local ticket; one that resolved names the local ticket
 * beside the source's own reference.
 */
export function duplicateTargetParts(target: DuplicateTarget): {
  /** What the target is called. */
  label: string;
  /** The local ticket it resolved to, which can be opened. */
  ticket: string | null;
  note: string;
} {
  if (target.kind === "unknown")
    return {
      label: "Unknown",
      ticket: null,
      note: "The source did not name an accessible original.",
    };
  if (target.problem === "cycle")
    return {
      label: target.display,
      ticket: null,
      note: "Not followed: it leads back to this ticket.",
    };
  if (target.ticket)
    return {
      label: target.ticket,
      ticket: target.ticket,
      note: target.display,
    };
  return {
    label: target.display,
    ticket: null,
    note: "Not imported into ticketd.",
  };
}

/** What a closed duplicate says about its canonical issue, never inventing one. */
export function duplicateTargetText(source: TicketSource): string | null {
  const target = source.duplicate_target;
  if (!target) return null;
  if (target.kind === "unknown")
    return "Duplicate; the source did not name an accessible original";
  if (target.problem === "cycle")
    return `Duplicate of ${target.display}; not followed because it leads back to this ticket`;
  return target.ticket
    ? `Duplicate of ${target.ticket} (${target.display})`
    : `Duplicate of ${target.display}`;
}
