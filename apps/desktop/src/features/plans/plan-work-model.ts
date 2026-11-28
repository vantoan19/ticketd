import type { Ticket } from "@/lib/api/client";

export type PlanWorkTicket = Pick<
  Ticket,
  "reference" | "title" | "status" | "availability" | "prerequisites"
> &
  Partial<Pick<Ticket, "trashed" | "updated_at">>;

type PlanWorkGroup =
  | "In review"
  | "In progress"
  | "Ready"
  | "Blocked"
  | "Held by source"
  | "Done"
  | "Not counted";

function groupOf(ticket: PlanWorkTicket): PlanWorkGroup | null {
  switch (ticket.status) {
    case "In review":
    case "In progress":
    case "Done":
      return ticket.status;
    case "Canceled":
    case "Duplicate":
      return "Not counted";
    case "Todo":
      // Visible Todo tickets without a readiness indicator are held by their source.
      return ticket.availability === "Ready" ||
        ticket.availability === "Blocked"
        ? ticket.availability
        : "Held by source";
    default:
      return null;
  }
}

function isClosed(status: string) {
  return status === "Done" || status === "Canceled" || status === "Duplicate";
}

function indexPlanWork<T extends PlanWorkTicket>(members: readonly T[]) {
  const visible = members.filter((ticket) => !ticket.trashed);
  const open = visible.filter((ticket) => !isClosed(ticket.status));
  const unresolved = new Map(
    visible.map((ticket) => [
      ticket.reference,
      ticket.prerequisites.filter((blocker) => blocker.unresolved),
    ]),
  );
  const dependents = new Map<string, string[]>();
  for (const ticket of open) {
    for (const blocker of unresolved.get(ticket.reference) ?? []) {
      const waiting = dependents.get(blocker.reference);
      if (waiting) waiting.push(ticket.reference);
      else dependents.set(blocker.reference, [ticket.reference]);
    }
  }
  const references = new Set(visible.map((ticket) => ticket.reference));
  return { visible, open, unresolved, dependents, references };
}

function countUnblocked(reference: string, dependents: Map<string, string[]>) {
  // Seed the walk with this reference so a dependency cycle never counts it.
  const seen = new Set([reference]);
  for (const dependent of seen)
    for (const waiting of dependents.get(dependent) ?? []) seen.add(waiting);
  return seen.size - 1;
}

const flowRank: Record<PlanWorkGroup, number> = {
  "In progress": 0,
  "In review": 1,
  Ready: 2,
  Blocked: 3,
  "Held by source": 3,
  Done: 3,
  "Not counted": 3,
};

function rankInFlow(ticket: PlanWorkTicket) {
  const group = groupOf(ticket);
  return group === null ? 3 : flowRank[group];
}

function compareReferences(a: PlanWorkTicket, b: PlanWorkTicket) {
  return a.reference.localeCompare(b.reference, undefined, { numeric: true });
}

function flowOrder<T extends PlanWorkTicket>(
  tickets: readonly T[],
  dependents: Map<string, string[]>,
) {
  // Flow ranks by immediate open dependents.
  return [...tickets].sort(
    (a, b) =>
      rankInFlow(a) - rankInFlow(b) ||
      (dependents.get(b.reference)?.length ?? 0) -
        (dependents.get(a.reference)?.length ?? 0) ||
      compareReferences(b, a),
  );
}

function flowLanes<T extends PlanWorkTicket>({
  open,
  unresolved,
  dependents,
}: ReturnType<typeof indexPlanWork<T>>) {
  const openReferences = new Set(open.map((ticket) => ticket.reference));
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
    for (const blocker of unresolved.get(reference) ?? []) {
      if (!openReferences.has(blocker.reference)) continue;
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
      unresolved
        .get(reference)
        ?.some((blocker) => blocker.reference === reference)
    )
      group.forEach((member) => cycles.add(member));
  }
  for (const ticket of open)
    if (!indices.has(ticket.reference)) visit(ticket.reference);
  function depth(reference: string): number {
    if (!openReferences.has(reference)) return 0;
    if (cycles.has(reference)) {
      depths.set(reference, Infinity);
      return Infinity;
    }
    const known = depths.get(reference);
    if (known !== undefined) return known;
    const blockers = unresolved.get(reference) ?? [];
    const value = blockers.length
      ? 1 + Math.max(...blockers.map((item) => depth(item.reference)))
      : 0;
    depths.set(reference, value);
    return value;
  }
  for (const ticket of open) depth(ticket.reference);
  const ordered = flowOrder(open, dependents);
  const lanes = [0, 1, 2].map((lane) =>
    ordered.filter(
      (ticket) => Math.min(2, depths.get(ticket.reference) ?? 0) === lane,
    ),
  );
  return { lanes, cycles, openReferences };
}

type PlanWorkTimes<T> = {
  /** When the ticket entered its current status. Defaults to its update time. */
  statusSince?: (ticket: T) => string | null | undefined;
  /** The latest update used to rank In progress tickets. */
  latestUpdate?: (ticket: T) => string | null | undefined;
};

function compareTimes(
  a: string | null | undefined,
  b: string | null | undefined,
  newestFirst: boolean,
) {
  const missing = newestFirst ? -Infinity : Infinity;
  const first = Date.parse(a ?? "");
  const second = Date.parse(b ?? "");
  const left = Number.isNaN(first) ? missing : first;
  const right = Number.isNaN(second) ? missing : second;
  if (left === right) return 0;
  return newestFirst ? right - left : left - right;
}

/** Complete Plan membership and prerequisites are required. */
export function planWorkModel<T extends PlanWorkTicket>(
  members: readonly T[],
  {
    statusSince = (ticket) => ticket.updated_at,
    latestUpdate = (ticket) => ticket.updated_at,
  }: PlanWorkTimes<T> = {},
) {
  const index = indexPlanWork(members);
  const { visible, unresolved, dependents, references } = index;
  const items = visible.map((ticket) => ({
    ticket,
    group: groupOf(ticket),
    unblocks: countUnblocked(ticket.reference, dependents),
    waitsOn: (unresolved.get(ticket.reference) ?? []).map((blocker) => ({
      ...blocker,
      insidePlan: references.has(blocker.reference),
    })),
  }));
  type Item = (typeof items)[number];
  const inGroup = <Group extends PlanWorkGroup>(group: Group) =>
    items.filter(
      (item): item is Item & { group: Group } => item.group === group,
    );
  const byUnblocks = (a: Item, b: Item) => b.unblocks - a.unblocks;
  const byReference = (a: Item, b: Item) =>
    compareReferences(a.ticket, b.ticket);
  const blockedByReference = new Map(
    inGroup("Blocked").map((item) => [item.ticket.reference, item]),
  );
  const blocked = blockedByReference.size
    ? flowLanes(index)
        .lanes.flat()
        .flatMap((ticket) => {
          const item = blockedByReference.get(ticket.reference);
          return item ? [item] : [];
        })
    : [];
  const sections = {
    inReview: inGroup("In review").sort(
      (a, b) =>
        byUnblocks(a, b) ||
        compareTimes(statusSince(a.ticket), statusSince(b.ticket), false) ||
        byReference(a, b),
    ),
    inProgress: inGroup("In progress").sort(
      (a, b) =>
        compareTimes(latestUpdate(a.ticket), latestUpdate(b.ticket), true) ||
        byReference(a, b),
    ),
    ready: inGroup("Ready").sort(
      (a, b) => byUnblocks(a, b) || byReference(a, b),
    ),
    blocked,
    held: inGroup("Held by source").sort(byReference),
    done: inGroup("Done").sort(
      (a, b) =>
        compareTimes(statusSince(a.ticket), statusSince(b.ticket), true) ||
        byReference(a, b),
    ),
    notCounted: inGroup("Not counted"),
  };
  const strip = [
    ...[...sections.done].sort(
      (a, b) =>
        compareTimes(statusSince(a.ticket), statusSince(b.ticket), false) ||
        byReference(a, b),
    ),
    ...sections.inReview,
    ...[...sections.inProgress].sort(byUnblocks),
    ...sections.ready,
    ...[...sections.blocked].sort(byUnblocks),
    ...[...sections.held].sort(byUnblocks),
  ];
  return {
    countable: items.filter(
      ({ ticket, group }) =>
        ticket.status === "Todo" || (group !== null && group !== "Not counted"),
    ).length,
    sections,
    strip,
  };
}

/** Complete Plan membership is required: bounded graph pages cannot establish depth. */
export function planFlow<T extends PlanWorkTicket>(members: readonly T[]) {
  const index = indexPlanWork(members);
  const { open, unresolved, dependents, references } = index;
  const { lanes, cycles, openReferences } = flowLanes(index);
  const edges = open.flatMap((ticket) =>
    (unresolved.get(ticket.reference) ?? [])
      .filter((blocker) => openReferences.has(blocker.reference))
      .map((blocker) => ({
        blocker: blocker.reference,
        dependent: ticket.reference,
      })),
  );
  // Canceled and Duplicate prerequisites stay unresolved (spec 4.5), but Flow
  // hides closed tickets, so name the status where the blocker is not on screen.
  function blockerName(blocker: T["prerequisites"][number]) {
    const notes = [
      ...(!references.has(blocker.reference) ? ["outside this Plan"] : []),
      ...(isClosed(blocker.status) ? [blocker.status] : []),
    ];
    return blocker.reference + (notes.length ? ` (${notes.join(", ")})` : "");
  }
  function reason(ticket: T) {
    const blockers = unresolved.get(ticket.reference) ?? [];
    if (blockers.length)
      return `Waits on ${blockers.map(blockerName).join(", ")}${cycles.has(ticket.reference) ? " (they block each other)" : ""}`;
    const waiting = openReferences.has(ticket.reference)
      ? dependents.get(ticket.reference)
      : undefined;
    return waiting?.length
      ? `Blocks ${waiting.join(", ")}`
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

/** Pass complete membership and prerequisites. An empty result means no work is left. */
export function planWrapUp<T extends PlanWorkTicket>(
  archived: boolean,
  members: readonly T[],
): T[] | null {
  const visible = members.filter((ticket) => !ticket.trashed);
  if (archived || visible.length === 0) return null;
  const references = new Set(members.map((ticket) => ticket.reference));
  const open = visible.filter((ticket) => !isClosed(ticket.status));
  for (const ticket of open) {
    if (groupOf(ticket) !== "Blocked") return null;
    const blockers = ticket.prerequisites.filter(
      (blocker) => blocker.unresolved,
    );
    // The projection excludes trashed members but their edges still block work.
    // Without their membership we cannot establish that the blocker is outside.
    if (
      !blockers.length ||
      blockers.some(
        (blocker) => blocker.trashed || references.has(blocker.reference),
      )
    )
      return null;
  }
  return open;
}
