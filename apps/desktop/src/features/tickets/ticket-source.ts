import type { DuplicateTarget, Ticket, TicketSource } from "@/lib/api/client";
import { ticketStatuses } from "@/lib/statuses";

/** External choices come from the core; retained provenance does not imply ownership. */
export function ticketStatusChoices(ticket: Ticket): readonly string[] {
  return externalSource(ticket)?.status_choices ?? ticketStatuses;
}

export function providerName(provider: string): string {
  return provider === "github" ? "GitHub" : provider;
}

/**
 * Who a change is attributed to. A change that came from a source is recorded
 * under the provider's id; it reads as the source, never as an editing agent.
 */
export function attribution(agent: string): string {
  const name = providerName(agent);
  return name === agent ? `Agent: ${agent}` : `Changed on ${name}`;
}

/** The source of a ticket the provider currently owns; null for local tickets. */
export function externalSource(ticket: Ticket): TicketSource | null {
  return ticket.source?.ownership === "external" ? ticket.source : null;
}

/** Where the issue lives, such as "owner / repo #98", from the parts the core names. */
export function sourceLocation(source: TicketSource): string {
  return `${source.place.replace("/", " / ")} ${source.number}`.trim();
}

/** The state line's words, and the tone of its dot, if it has one. */
export function sourceState(source: TicketSource): {
  text: string;
  tone: "positive" | "attention" | null;
} {
  const name = source.provider_name;
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
  const name = source.provider_name;
  const since = ago(unavailable.since, now) ?? unavailable.since;
  // Worded by what failed, once: the provider's own text is not chained on.
  const cause =
    unavailable.code === "not_found"
      ? `${name} says ${source.display} was deleted or is not visible to your account.`
      : unavailable.code === "unauthenticated"
        ? `${name} rejected the sign-in, so ${source.display} could not be refreshed.`
        : unavailable.code === "forbidden"
          ? `${name} refused access to ${source.display}.`
          : `${name} could not be reached for ${source.display}.`;
  return {
    title: "Source unavailable",
    detail: `${cause} Nothing in ticketd was deleted or completed.`,
    since: `Since ${since}`,
  };
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
  /** Where the canonical issue can be opened at its source. */
  url: string | null;
} {
  if (target.kind === "unknown")
    return {
      label: "Unknown",
      ticket: null,
      note: "The source did not name an accessible original.",
      url: null,
    };
  const url = target.url ?? null;
  // A target the source stopped supplying is the last one it named.
  const last = target.last_known
    ? " Last known; the source no longer names it."
    : "";
  if (target.problem === "cycle")
    return {
      label: target.display,
      ticket: null,
      note: "Not followed: it leads back to this ticket." + last,
      url,
    };
  if (target.ticket)
    return {
      label: target.ticket,
      ticket: target.ticket,
      note: target.display + (last ? " ·" + last : ""),
      url,
    };
  return {
    label: target.display,
    ticket: null,
    note: "Not imported into ticketd." + last,
    url,
  };
}

/**
 * The canonical issue a source named for a Duplicate that has no local original:
 * the one rule every surface (row, rail, relationships) follows. A taken-over
 * duplicate keeps the last one as provenance, so ownership is not part of it.
 */
export function externalDuplicateTarget(
  ticket: Ticket,
): DuplicateTarget | null {
  return ticket.status === "Duplicate" && !ticket.duplicate_of
    ? (ticket.source?.duplicate_target ?? null)
    : null;
}

/** What a closed duplicate says about its canonical issue, never inventing one. */
export function duplicateTargetText(target: DuplicateTarget): string {
  if (target.kind === "unknown")
    return "Duplicate; the source did not name an accessible original";
  if (target.problem === "cycle")
    return `Duplicate of ${target.display}; not followed because it leads back to this ticket`;
  return target.ticket
    ? `Duplicate of ${target.ticket} (${target.display})`
    : `Duplicate of ${target.display}`;
}
