import type { Ticket } from "@/lib/api/client";
import { flowOrder } from "./flow-order";
export type FlowTicket = Pick<
  Ticket,
  "reference" | "title" | "status" | "availability" | "prerequisites"
>;
const closed = new Set(["Done", "Canceled", "Duplicate"]);
/** Complete Plan membership is required: bounded graph pages cannot establish depth. */
export function planFlow<T extends FlowTicket>(members: T[]) {
  const open = members.filter((ticket) => !closed.has(ticket.status));
  const byRef = new Map(open.map((ticket) => [ticket.reference, ticket]));
  const depths = new Map<string, number>();
  const cycles = new Set<string>();
  // Strongly connected groups need their own explanation, including overlapping cycles.
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  function visit(reference: string) {
    const index = indices.size;
    indices.set(reference, index);
    low.set(reference, index);
    stack.push(reference);
    stacked.add(reference);
    for (const blocker of byRef.get(reference)?.prerequisites ?? []) {
      if (!blocker.unresolved || !byRef.has(blocker.reference)) continue;
      if (!indices.has(blocker.reference)) {
        visit(blocker.reference);
        low.set(
          reference,
          Math.min(low.get(reference)!, low.get(blocker.reference)!),
        );
      } else if (stacked.has(blocker.reference))
        low.set(
          reference,
          Math.min(low.get(reference)!, indices.get(blocker.reference)!),
        );
    }
    if (low.get(reference) !== index) return;
    const group: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member) {
        group.push(member);
        stacked.delete(member);
      }
    } while (member && member !== reference);
    if (
      group.length > 1 ||
      byRef
        .get(reference)
        ?.prerequisites.some(
          (blocker) => blocker.unresolved && blocker.reference === reference,
        )
    )
      group.forEach((member) => cycles.add(member));
  }
  for (const ticket of open)
    if (!indices.has(ticket.reference)) visit(ticket.reference);
  function depth(reference: string): number {
    if (!byRef.has(reference)) return 0;
    if (cycles.has(reference)) {
      depths.set(reference, Infinity);
      return Infinity;
    }
    const known = depths.get(reference);
    if (known !== undefined) return known;
    const blockers = byRef
      .get(reference)!
      .prerequisites.filter((item) => item.unresolved);
    const value = blockers.length
      ? 1 + Math.max(...blockers.map((item) => depth(item.reference)))
      : 0;
    depths.set(reference, value);
    return value;
  }
  for (const ticket of open) depth(ticket.reference);
  const ordered = flowOrder(open);
  const lanes = [0, 1, 2].map((lane) =>
    ordered.filter(
      (ticket) => Math.min(2, depths.get(ticket.reference) ?? 0) === lane,
    ),
  );
  const edges = open.flatMap((ticket) =>
    ticket.prerequisites
      .filter((blocker) => blocker.unresolved && byRef.has(blocker.reference))
      .map((blocker) => ({
        blocker: blocker.reference,
        dependent: ticket.reference,
      })),
  );
  // Canceled and Duplicate prerequisites stay unresolved (spec 4.5), but Flow
  // hides closed tickets, so name the status where the blocker is not on screen.
  function blockerName(blocker: T["prerequisites"][number]) {
    const notes = [
      ...(!members.some((member) => member.reference === blocker.reference)
        ? ["outside this Plan"]
        : []),
      ...(closed.has(blocker.status) ? [blocker.status] : []),
    ];
    return blocker.reference + (notes.length ? ` (${notes.join(", ")})` : "");
  }
  function reason(ticket: T) {
    const blockers = ticket.prerequisites.filter((item) => item.unresolved);
    if (blockers.length)
      return `Waits on ${blockers.map(blockerName).join(", ")}${cycles.has(ticket.reference) ? " (they block each other)" : ""}`;
    const dependents = edges
      .filter((edge) => edge.blocker === ticket.reference)
      .map((edge) => edge.dependent);
    return dependents.length
      ? `Blocks ${dependents.join(", ")}`
      : "No open blockers";
  }
  // Flow only draws lines that run to a later lane; the rest sit in one lane
  // (every ticket two or more steps from Now shares "Later") or form a cycle.
  const laneOf = new Map(
    lanes.flatMap((lane, index) =>
      lane.map((ticket) => [ticket.reference, index] as const),
    ),
  );
  const undrawn = edges.filter(
    (edge) => laneOf.get(edge.blocker)! >= laneOf.get(edge.dependent)!,
  ).length;
  return { lanes, edges, undrawn, reason };
}
