import {
  client,
  type WorkspaceGraph,
  type WorkspaceGraphRequest,
  type TicketMetadata,
} from "@/lib/api/client";
import { plansClient, type PlanCounts } from "@/lib/api/plans";

// A window has at most eight Plan reads, 240 island identities, 50 workspace
// candidates, 250 drawn nodes and 600 edges. Each island and the final join
// visits at most 3,000 relationships (at most nine joins per window).
// Every continuation replaces this window; it never grows an unbounded cache.
const PLAN_WINDOW = 8;
const ISLAND_IDENTITIES = 240;
const NODE_LIMIT = 250;
const EDGE_LIMIT = 600;
const RELATIONSHIP_WORK = 3000;
const MATCH_PAGES = 5;
export type PlanIslandGraph = WorkspaceGraph & {
  structuralPlans: WorkspaceGraph["nodes"];
  planMembership: Record<string, string[]>;
  planCounts: Record<string, PlanCounts>;
  availability: Record<string, string | null>;
  partialTotal?: boolean;
  windowCursor: string | null;
  ticketMetadata: Record<string, TicketMetadata>;
};
type Source = Awaited<ReturnType<typeof planSource>>;
type Matches = { ids: Set<string>; omitted: boolean } | null;
type Continuation = {
  planOffset: number;
  memberOffset: number;
  workspaceCursor: string | null;
};
const prefix = "plan-window:";
function continuation(cursor: string | null): Continuation {
  if (cursor?.startsWith(prefix)) {
    const values = cursor.slice(prefix.length).split(":");
    return {
      planOffset: Number(values[0]) || 0,
      memberOffset: Number(values[1]) || 0,
      workspaceCursor: decodeURIComponent(values.slice(2).join(":")) || null,
    };
  }
  return { planOffset: 0, memberOffset: 0, workspaceCursor: cursor };
}
function cursor(value: Continuation) {
  return `${prefix}${value.planOffset}:${value.memberOffset}:${encodeURIComponent(value.workspaceCursor ?? "")}`;
}
async function planSource(id: string, limit: number, offset: number) {
  // The extra metadata row detects Document pagination without adding a DTO.
  // Counts are aggregated by Core independently of the bounded member read.
  const view = await plansClient.show(id, limit + 1, offset, false);
  const total = Object.values(view.counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const members = [];
  for (let read = 0; read < limit; read += 100) {
    const count = Math.min(100, limit - read);
    const page = await client.findTicketMetadata({
      query: "",
      unlinked: false,
      project: null,
      plan: id,
      status: null,
      tags: [],
      availability: null,
      family: null,
      limit: count,
      offset: offset + read,
    });
    members.push(...page.items.slice(0, count));
    if (page.items.length < count) break;
  }
  const expected = Math.min(limit, Math.max(0, total - offset));
  if (members.length !== expected)
    throw new Error(
      "Plan membership changed while loading. Retry to load a consistent island window.",
    );
  return {
    view: { ...view, documents: view.documents.slice(0, limit) },
    members,
    omitted: total > offset + limit || view.documents.length > limit,
    offset,
    limit,
  };
}
async function filterMatches(
  request: WorkspaceGraphRequest,
  first?: WorkspaceGraph,
): Promise<Matches> {
  if (!request.search && !request.tag) return null;
  const ids = new Set<string>();
  let next: string | null = null;
  let page = first;
  for (let count = 0; count < MATCH_PAGES; count++) {
    page ??= await client.workspaceGraph({
      ...request,
      relationship: null,
      cursor: next,
      visible_ids: [],
      hydrate_only: false,
    });
    page.nodes.forEach((node) => ids.add(node.id));
    next = page.next_cursor;
    if (!next) return { ids, omitted: false };
    page = undefined;
  }
  return { ids, omitted: true };
}
/** Hydrate one bounded, authoritative Plan window, reusing one filter search. */
export async function planWorkspaceGraph(
  id: string,
  request: WorkspaceGraphRequest,
  source?: Source,
  sharedMatches?: Matches,
): Promise<PlanIslandGraph> {
  const state = continuation(request.cursor);
  const current = source ?? (await planSource(id, 119, state.memberOffset));
  const { members, view } = current;
  const ids = [
    id,
    ...members.map((ticket) => ticket.id),
    ...view.documents
      .filter((document) => !document.trashed)
      .map((document) => document.id),
  ];
  const matches =
    sharedMatches === undefined ? await filterMatches(request) : sharedMatches;
  const wanted = new Set(ids.filter((id) => !matches || matches.ids.has(id)));
  const nodes = new Map<string, WorkspaceGraph["nodes"][number]>();
  const edges = new Map<string, WorkspaceGraph["edges"][number]>();
  const groups = new Set<string>();
  const tags: Record<string, string> = {};
  let work = 0;
  function join(
    source: string,
    target: string,
    kind: WorkspaceGraph["edges"][number]["kind"],
    explanation: string | null = null,
  ) {
    if (++work > RELATIONSHIP_WORK || edges.size >= EDGE_LIMIT) {
      groups.add("Plan relationship budget");
      return;
    }
    if (
      !nodes.has(source) ||
      !nodes.has(target) ||
      (request.relationship && request.relationship !== kind)
    )
      return;
    edges.set(`${source}:${kind}:${target}`, {
      source,
      target,
      kind,
      explanation,
    });
  }
  const wantedIds = ids.filter((id) => wanted.has(id));
  for (let offset = 0; offset < wantedIds.length; offset += NODE_LIMIT) {
    const page = await client.workspaceGraph({
      ...request,
      relationship: null,
      visible_ids: wantedIds.slice(offset, offset + NODE_LIMIT),
      node_limit: NODE_LIMIT,
      edge_limit: EDGE_LIMIT,
      hydrate_only: true,
    });
    page.nodes.forEach((node) => {
      if (wanted.has(node.id)) nodes.set(node.id, node);
    });
    page.edges.forEach((edge) => {
      if (
        edges.size < EDGE_LIMIT &&
        wanted.has(edge.source) &&
        wanted.has(edge.target)
      )
        edges.set(`${edge.source}:${edge.kind}:${edge.target}`, edge);
    });
    page.omitted_groups.forEach((group) => groups.add(group));
    Object.assign(tags, page.node_tags);
  }
  const planNode: WorkspaceGraph["nodes"][number] = {
    id,
    kind: "plan",
    label: view.plan.name,
    state: view.plan.archived ? "Archived" : "Active",
    trashed: false,
    activity_detail: false,
  };
  if ((!request.kind || request.kind === "plan") && wanted.has(id))
    nodes.set(id, planNode);
  const expected = members.filter(
    (ticket) =>
      (!request.kind || request.kind === "ticket") && wanted.has(ticket.id),
  );
  const documents = view.documents.filter(
    (document) =>
      !document.trashed &&
      (!request.kind || request.kind === "document") &&
      wanted.has(document.id),
  );
  if (
    expected.some((ticket) => !nodes.has(ticket.id)) ||
    documents.some((document) => !nodes.has(document.id))
  )
    throw new Error(
      "Some Plan members could not be loaded. Retry to load this island window.",
    );
  for (const ticket of members) join(id, ticket.id, "membership");
  view.documents.forEach((document) =>
    join(
      id,
      document.id,
      document.id === view.plan.spec_document_id ? "spec" : "document",
      document.id === view.plan.spec_document_id ? "Primary spec" : null,
    ),
  );
  if (!current.omitted && work < RELATIONSHIP_WORK && edges.size < EDGE_LIMIT)
    ["membership", "document", "spec"].forEach((kind) => groups.delete(kind));
  if (request.relationship) {
    const connected = new Set<string>();
    for (const [key, edge] of edges) {
      if (edge.kind !== request.relationship) edges.delete(key);
      else {
        connected.add(edge.source);
        connected.add(edge.target);
      }
    }
    for (const id of nodes.keys()) if (!connected.has(id)) nodes.delete(id);
  }
  if (current.omitted) groups.add("Plan member window");
  if (matches?.omitted) groups.add("Plan filter window");
  return {
    windowCursor: request.cursor,
    ticketMetadata: Object.fromEntries(
      members.map((ticket) => [ticket.id, ticket]),
    ),
    structuralPlans: [planNode],
    planMembership: Object.fromEntries(
      ids.filter((target) => target !== id).map((target) => [target, [id]]),
    ),
    planCounts: { [id]: view.counts },
    availability: Object.fromEntries(
      members.map((ticket) => [ticket.id, ticket.availability]),
    ),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    node_tags: tags,
    omitted: groups.size > 0,
    omitted_groups: [...groups],
    next_cursor: current.omitted
      ? cursor({ ...state, memberOffset: current.offset + current.limit })
      : null,
    total: nodes.size,
    partialTotal: current.omitted || !!matches?.omitted,
  };
}

/** Bounded Plan islands and workspace candidates; membership never depends on edge caps. */
export async function workspacePlanIslands(
  request: WorkspaceGraphRequest,
): Promise<PlanIslandGraph> {
  const state = continuation(request.cursor);
  const [page, planPage] = await Promise.all([
    client.workspaceGraph({
      ...request,
      cursor: state.workspaceCursor,
      visible_ids: request.visible_ids.slice(0, 100),
    }),
    client.listPlans(PLAN_WINDOW + 1, state.planOffset),
  ]);
  const plans = planPage.slice(0, PLAN_WINDOW);
  const limit = Math.max(
    1,
    Math.floor(
      (ISLAND_IDENTITIES - plans.length) / Math.max(1, plans.length) / 2,
    ),
  );
  const sources = await Promise.all(
    plans.map((plan) => planSource(plan.id, limit, state.memberOffset)),
  );
  const matches = await filterMatches(
    request,
    request.relationship ? undefined : page,
  );
  const islands = await Promise.all(
    plans.map((plan, index) =>
      planWorkspaceGraph(plan.id, request, sources[index], matches),
    ),
  );
  const nodes = new Map(
    islands.flatMap((island) => island.nodes).map((node) => [node.id, node]),
  );
  const groups = new Set([
    ...page.omitted_groups,
    ...islands.flatMap((island) => island.omitted_groups),
  ]);
  page.nodes.forEach((node) => {
    if (nodes.size < NODE_LIMIT || nodes.has(node.id)) nodes.set(node.id, node);
    else groups.add("Workspace node window");
  });
  const membership: Record<string, string[]> = {};
  const availability: Record<string, string | null> = {};
  for (const island of islands) {
    for (const [id, owners] of Object.entries(island.planMembership))
      membership[id] = [...new Set([...(membership[id] ?? []), ...owners])];
    Object.assign(availability, island.availability);
  }
  const allMembershipLoaded =
    planPage.length <= PLAN_WINDOW &&
    state.planOffset === 0 &&
    state.memberOffset === 0 &&
    !sources.some((source) => source.omitted);
  const ticketMetadata = Object.assign(
    {},
    ...islands.map((island) => island.ticketMetadata),
  ) as Record<string, TicketMetadata>;
  const unknownIds = page.nodes
    .filter((node) => node.kind === "ticket" && !ticketMetadata[node.id])
    .slice(0, 50)
    .map((node) => node.id);
  if (unknownIds.length) {
    const metadata = await client.findTicketMetadata(
      {
        query: "",
        project: null,
        unlinked: false,
        plan: null,
        status: null,
        tags: [],
        availability: null,
        family: null,
        limit: 50,
        offset: 0,
      },
      unknownIds,
    );
    for (const ticket of metadata.items) {
      ticketMetadata[ticket.id] = ticket;
      membership[ticket.id] = ticket.plan_id ? [ticket.plan_id] : [];
      availability[ticket.id] = ticket.availability;
    }
  }
  if (allMembershipLoaded)
    for (const node of nodes.values())
      if (node.kind !== "ticket") membership[node.id] ??= [];
  const structural = new Map(
    [
      ...page.nodes.filter((node) => node.kind === "plan"),
      ...islands.flatMap((island) => island.structuralPlans),
    ].map((node) => [node.id, node]),
  );
  const outside = [...new Set(Object.values(membership).flat())]
    .filter((id) => !structural.has(id))
    .slice(0, 50);
  if (outside.length) {
    const metadata = await client.workspaceGraph({
      ...request,
      kind: "plan",
      relationship: null,
      visible_ids: outside,
      hydrate_only: true,
    });
    metadata.nodes.forEach((node) => structural.set(node.id, node));
  }
  const edges = new Map<string, WorkspaceGraph["edges"][number]>();
  let work = 0;
  const join = (edge: WorkspaceGraph["edges"][number]) => {
    if (++work > RELATIONSHIP_WORK || edges.size >= EDGE_LIMIT) {
      groups.add("Plan relationship budget");
      return;
    }
    if (
      nodes.has(edge.source) &&
      nodes.has(edge.target) &&
      (!request.relationship || request.relationship === edge.kind)
    )
      edges.set(`${edge.source}:${edge.kind}:${edge.target}`, edge);
  };
  const joinPage = (values: WorkspaceGraph["edges"]) => {
    for (const edge of values) {
      if (work >= RELATIONSHIP_WORK) {
        groups.add("Plan relationship budget");
        break;
      }
      join(edge);
    }
  };
  for (const island of islands) joinPage(island.edges);
  joinPage(page.edges);
  // The workspace page already joins its own candidates and visible IDs.
  // Only separately hydrated Plan islands need a cross-island join.
  if (nodes.size && islands.length) {
    const connections = await client.workspaceGraph({
      ...request,
      visible_ids: [...nodes.keys()],
      hydrate_only: true,
      node_limit: NODE_LIMIT,
      edge_limit: EDGE_LIMIT,
    });
    joinPage(connections.edges);
    connections.omitted_groups.forEach((group) => groups.add(group));
  }
  const moreMembers = sources.some((source) => source.omitted);
  const morePlans = planPage.length > PLAN_WINDOW;
  if (morePlans || state.planOffset > 0) groups.add("Plan island window");
  const next = moreMembers
    ? cursor({
        ...state,
        memberOffset: state.memberOffset + limit,
        workspaceCursor: page.next_cursor,
      })
    : morePlans
      ? cursor({
          planOffset: state.planOffset + PLAN_WINDOW,
          memberOffset: 0,
          workspaceCursor: page.next_cursor,
        })
      : page.next_cursor;
  return {
    ...page,
    windowCursor: request.cursor,
    ticketMetadata,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    structuralPlans: [...structural.values()],
    planMembership: membership,
    planCounts: Object.assign(
      {},
      ...islands.map((island) => island.planCounts),
    ),
    availability,
    node_tags: Object.assign(
      {},
      page.node_tags,
      ...islands.map((island) => island.node_tags),
    ),
    omitted: page.omitted || groups.size > 0,
    omitted_groups: [...groups],
    next_cursor: next,
  };
}
