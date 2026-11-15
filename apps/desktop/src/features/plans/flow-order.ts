import type { Ticket } from "@/lib/api/client";

/** Shared order inside a Flow lane, also used to pick a Plan's next Ready ticket. */
export function flowOrder<
  T extends Pick<
    Ticket,
    "reference" | "status" | "availability" | "prerequisites"
  >,
>(members: T[]): T[] {
  const unblocks = new Map<string, number>();
  for (const member of members) {
    if (["Done", "Canceled", "Duplicate"].includes(member.status)) continue;
    for (const blocker of member.prerequisites) {
      if (blocker.unresolved)
        unblocks.set(
          blocker.reference,
          (unblocks.get(blocker.reference) ?? 0) + 1,
        );
    }
  }
  const rank = (ticket: T) =>
    ticket.status === "In progress"
      ? 0
      : ticket.status === "In review"
        ? 1
        : ticket.availability === "Ready"
          ? 2
          : 3;
  return [...members].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (unblocks.get(b.reference) ?? 0) - (unblocks.get(a.reference) ?? 0) ||
      b.reference.localeCompare(a.reference, undefined, { numeric: true }),
  );
}
