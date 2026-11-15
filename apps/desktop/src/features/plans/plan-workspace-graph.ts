import {
  client,
  type WorkspaceGraph,
  type WorkspaceGraphRequest,
} from "@/lib/api/client";
import { plansClient, type PlanCounts } from "@/lib/api/plans";
import { allPlanMembers } from "./plan-members";
export type PlanIslandGraph = WorkspaceGraph & {
  planCounts: Record<string, PlanCounts>;
  availability: Record<string, string | null>;
};
async function planSource(id: string) {
  const [members, view] = await Promise.all([
    allPlanMembers(id),
    plansClient.show(id),
  ]);
  return { members, view };
}
/** Hydrate authoritative Plan identities, never a recent workspace page. */
export async function planWorkspaceGraph(
  id: string,
  request: WorkspaceGraphRequest,
  source?: Awaited<ReturnType<typeof planSource>>,
): Promise<PlanIslandGraph> {
  const { members, view } = source ?? (await planSource(id));
  const ids = [
    id,
    ...members.map((ticket) => ticket.id),
    ...view.documents
      .filter((document) => !document.trashed)
      .map((document) => document.id),
  ];
  // Hydration intentionally bypasses candidate search; obtain the core's matches
  // before intersecting them with the authoritative Plan identities.
  let matches: Set<string> | null = null;
  if (request.search || request.tag) {
    matches = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await client.workspaceGraph({
        ...request,
        cursor,
        visible_ids: [],
        hydrate_only: false,
      });
      page.nodes.forEach((node) => matches!.add(node.id));
      cursor = page.next_cursor;
    } while (cursor);
  }
  const wanted = new Set(ids.filter((id) => !matches || matches.has(id)));
  const nodes = new Map<string, WorkspaceGraph["nodes"][number]>();
  const edges = new Map<string, WorkspaceGraph["edges"][number]>();
  let omitted = false;
  const omittedGroups = new Set<string>();
  const tags: Record<string, string> = {};
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = await client.workspaceGraph({
      ...request,
      relationship: null,
      visible_ids: ids
        .slice(offset, offset + 100)
        .filter((id) => wanted.has(id)),
      hydrate_only: true,
    });
    for (const node of page.nodes)
      if (wanted.has(node.id)) nodes.set(node.id, node);
    for (const edge of page.edges)
      if (wanted.has(edge.source) && wanted.has(edge.target))
        edges.set(`${edge.source}:${edge.kind}:${edge.target}`, edge);
    Object.assign(tags, page.node_tags);
    omitted ||= page.omitted;
    page.omitted_groups.forEach((group) => omittedGroups.add(group));
  }
  // The Plan identity is already authoritative in show_plan, including when a
  // search matches its members rather than its title.
  if (
    nodes.size ||
    ((!request.kind || request.kind === "plan") && wanted.has(id))
  )
    nodes.set(id, {
      id,
      kind: "plan",
      label: view.plan.name,
      state: view.plan.archived ? "Archived" : "Active",
      trashed: false,
      activity_detail: false,
    });
  const expected = members.filter(
    (ticket) =>
      (!request.kind || request.kind === "ticket") && wanted.has(ticket.id),
  );
  const expectedDocuments = view.documents.filter(
    (document) =>
      !document.trashed &&
      (!request.kind || request.kind === "document") &&
      wanted.has(document.id),
  );
  if (
    expected.some((ticket) => !nodes.has(ticket.id)) ||
    expectedDocuments.some((document) => !nodes.has(document.id))
  )
    throw new Error(
      "Some Plan members could not be loaded. Retry to load the complete island.",
    );
  // These complete relationships are already present in the Plan/member reads;
  // join them independently of graph page boundaries or per-group limits.
  const idOf = new Map(members.map((ticket) => [ticket.reference, ticket.id]));
  function join(
    source: string,
    target: string,
    kind: WorkspaceGraph["edges"][number]["kind"],
    explanation: string | null = null,
  ) {
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
  for (const ticket of members) {
    join(id, ticket.id, "membership");
    for (const blocker of ticket.prerequisites) {
      const source = idOf.get(blocker.reference);
      if (source) join(source, ticket.id, "blocks");
    }
  }
  for (const document of view.documents)
    join(
      id,
      document.id,
      document.id === view.plan.spec_document_id ? "spec" : "document",
      document.id === view.plan.spec_document_id ? "Primary spec" : null,
    );
  for (const kind of ["membership", "blocks", "document", "spec"])
    omittedGroups.delete(kind);
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
  // The existing graph endpoint only resolves connections inside each 100-node
  // hydration. Complete blocking/membership/spec links are joined above; say
  // when other cross-batch relationships may be missing.
  if (ids.length > 100) {
    omitted = true;
    omittedGroups.add("Plan connections across batches");
  }
  return {
    planCounts: { [id]: view.counts },
    availability: Object.fromEntries(
      members.map((ticket) => [ticket.id, ticket.availability]),
    ),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    omitted,
    omitted_groups: [...omittedGroups],
    next_cursor: null,
    total: nodes.size,
    node_tags: tags,
  };
}

/** Add complete Plan islands to the existing workspace page, retaining its limits. */
export async function workspacePlanIslands(
  request: WorkspaceGraphRequest,
): Promise<PlanIslandGraph> {
  const [page, plans] = await Promise.all([
    client.workspaceGraph(request),
    client.listPlans(),
  ]);
  const sources = await Promise.all(plans.map((plan) => planSource(plan.id)));
  const islands = await Promise.all(
    plans.map((plan, index) =>
      planWorkspaceGraph(plan.id, request, sources[index]),
    ),
  );
  const nodes = new Map(page.nodes.map((node) => [node.id, node]));
  const edges = new Map(
    page.edges.map((edge) => [
      `${edge.source}:${edge.kind}:${edge.target}`,
      edge,
    ]),
  );
  const groups = new Set(page.omitted_groups);
  const tags = { ...page.node_tags };
  for (const island of islands) {
    island.nodes.forEach((node) => nodes.set(node.id, node));
    island.edges.forEach((edge) =>
      edges.set(`${edge.source}:${edge.kind}:${edge.target}`, edge),
    );
    island.omitted_groups.forEach((group) => groups.add(group));
    Object.assign(tags, island.node_tags);
  }
  // Member prerequisites also include blockers in other Plans.
  const referenceIds = new Map(
    page.nodes
      .filter((node) => node.ticket_reference)
      .map((node) => [node.ticket_reference, node.id]),
  );
  for (const source of sources)
    for (const ticket of source.members)
      referenceIds.set(ticket.reference, ticket.id);
  if (!request.relationship || request.relationship === "blocks")
    for (const source of sources)
      for (const ticket of source.members)
        for (const blocker of ticket.prerequisites) {
          const id = referenceIds.get(blocker.reference);
          if (id && nodes.has(id) && nodes.has(ticket.id))
            edges.set(`${id}:blocks:${ticket.id}`, {
              source: id,
              target: ticket.id,
              kind: "blocks",
              explanation: null,
            });
        }
  return {
    ...page,
    availability: Object.assign(
      {},
      ...islands.map((island) => island.availability),
    ),
    planCounts: Object.assign(
      {},
      ...islands.map((island) => island.planCounts),
    ),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    node_tags: tags,
    omitted: page.omitted || islands.some((island) => island.omitted),
    omitted_groups: [...groups],
  };
}
