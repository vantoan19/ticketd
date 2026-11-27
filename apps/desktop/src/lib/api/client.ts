import { latestUpdateSchema } from "./progress";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";
import { plainLabel } from "@/lib/plain-text";
import { invoke, structured } from "@/lib/api/bridge-failure";
import { publicationAttemptSchema } from "@/lib/api/publication";
import { ticketStatuses } from "@/lib/statuses";
import { creditedSubAgentSchema } from "@/lib/api/credit";

export type { PublicationAttempt } from "@/lib/api/publication";

const statusSchema = lazySchema(() => z.enum(ticketStatuses));
const stateCategorySchema = lazySchema(() =>
  z.enum(["open", "completed", "not_planned", "duplicate", "unknown"]),
);
const externalStateSchema = lazySchema(() =>
  z.object({ category: stateCategorySchema, name: z.string().nullish() }),
);
const duplicateTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unknown") }),
    z.object({
      kind: z.literal("external"),
      identity: z.object({ provider: z.string(), id: z.string() }),
      locator: z.string(),
      display: z.string(),
      /** The local ticket the reference resolves to once the canonical issue was imported. */
      ticket: z.string().nullish(),
      /** The reference is shown but not followed because it would loop back to this ticket. */
      problem: z.enum(["cycle"]).nullish(),
      /** Where the canonical issue can be opened at its source. */
      url: z.string().nullish(),
      /** The source no longer supplied it: the last target it named, not a confirmed one. */
      last_known: z.boolean().nullish(),
    }),
  ]),
);
export type DuplicateTarget = z.infer<typeof duplicateTargetSchema>;
/** The external issue a ticket is or was, with who owns it now and how fresh it is. */
const ticketSourceSchema = lazySchema(() =>
  z.object({
    provider: z.string(),
    /** What people call the provider, such as "GitHub". */
    provider_name: z.string(),
    provider_icon_svg: z.string().nullish(),
    /** Where the issue lives, such as "owner/repo". */
    place: z.string(),
    place_label: z.string().optional(),
    duplicate_number: z.string().optional(),
    /** The provider's short number for the issue, such as "#98". */
    number: z.string(),
    id: z.string(),
    locator: z.string(),
    display: z.string(),
    url: z.string(),
    origin: z.enum(["imported", "published"]),
    discovery_matches: z.boolean().nullish(),
    ownership_changed_at: z.string().nullish(),
    /** Who may change the ticket's content now. Retained identity alone is not ownership. */
    ownership: z.enum(["external", "local"]),
    state: externalStateSchema,
    /** The source's latest closure time, only when the core can confirm it. */
    closed_at: z.string().nullish(),
    /** Who opened the issue at the source; unknown until a refresh reads it. */
    author: z.string().nullish(),
    /** When the issue was opened at the source; unknown until a refresh reads it. */
    created_at: z.string().nullish(),
    /** The source reported a state category ticketd cannot map to a status. */
    closure_unrecognized: z.boolean(),
    last_refreshed_at: z.string().nullable(),
    last_attempt_at: z.string().nullable(),
    last_error: z.object({ code: z.string(), message: z.string() }).nullable(),
    /** The latest read of the issue's comments failed; the ticket itself is fine. */
    conversation_error: z
      .object({ code: z.string(), message: z.string() })
      .nullish(),
    /**
     * Set while the source cannot be read: the latest refresh failed with an
     * unreachable, unauthorized, forbidden, missing or unusable answer. Saved content
     * and local work are untouched; a rate limit is delayed, not unavailable.
     */
    unavailable: z
      .object({ code: z.string(), message: z.string(), since: z.string() })
      .nullish(),
    content_locked: z.boolean(),
    status_locked: z.boolean(),
    /** The statuses that may be chosen for this ticket now, decided by the core. */
    status_choices: z.array(statusSchema),
    duplicate_target: duplicateTargetSchema.nullable(),
  }),
);
export type TicketSource = z.infer<typeof ticketSourceSchema>;
const ticketSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    /** Core's device-local insertion order; absent in older saved outcomes. */
    local_number: z.number().int().positive().nullish(),
    trashed: z.boolean(),
    reference: z.string(),
    title: z.string(),
    status: z.string(),
    body: z.string(),
    updated_at: z.string().nullish(),
    progress_summary: latestUpdateSchema.nullable().optional(),
    latest_update: z
      .object({
        activity_id: z.string(),
        reported_at: z.string(),
        editing_agent: z.string().nullable(),
      })
      .nullish(),
    tags: z.array(z.string()),
    project_id: z.string().nullable(),
    plan_id: z.string().nullable(),
    availability: z.string().nullable(),
    /** This duplicate's canonical ticket became a Duplicate itself; the ticket that is now the original. */
    duplicate_redirect: z.string().nullish(),
    parent: z
      .object({
        reference: z.string(),
        title: z.string(),
        trashed: z.boolean(),
      })
      .nullable(),
    children: z.array(
      z.object({
        reference: z.string(),
        title: z.string(),
        trashed: z.boolean(),
      }),
    ),
    duplicate_of: z.string().nullable().optional(),
    duplicates: z.array(z.string()).optional(),
    source: ticketSourceSchema.nullish(),
    /** The publication attempt that is running or whose outcome is unknown. */
    publication: publicationAttemptSchema.nullish(),
    prerequisites: z.array(
      z.object({
        reference: z.string(),
        title: z.string(),
        status: z.string(),
        trashed: z.boolean(),
        /** Still has to be Done before the ticket that depends on it is Ready. */
        unresolved: z.boolean(),
      }),
    ),
  }),
);
const relatedSchema = lazySchema(() =>
  z.object({
    reference: z.string(),
    title: z.object({ text: z.string() }),
    status: z.string(),
    trashed: z.boolean(),
    /** Whether this ticket still has to be Done for a dependency on it to clear. */
    unresolved: z.boolean(),
  }),
);
const relatedPageSchema = lazySchema(() =>
  z.object({
    items: z.array(relatedSchema),
    next_offset: z.number().nullable(),
  }),
);
const relationshipsSchema = lazySchema(() =>
  z.object({
    parent: relatedSchema.nullable(),
    children: relatedPageSchema,
    /** Subticket progress over all subtickets, not only the page read. */
    children_progress: z.object({ total: z.number(), done: z.number() }),
    prerequisites: relatedPageSchema,
    blocking: relatedPageSchema,
    related: relatedPageSchema,
    discovered_while: relatedPageSchema,
    discoveries: relatedPageSchema,
    duplicate_of: relatedSchema.nullable(),
    duplicates: relatedPageSchema,
  }),
);
export type Relationships = z.infer<typeof relationshipsSchema>;
export type RelatedTicket = z.infer<typeof relatedSchema>;

export const contextGraphSchema = lazySchema(() =>
  z.object({
    center: z.string(),
    nodes: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["ticket", "document", "plan"]),
        // A Document's label is its derived first line, which can hold Markdown.
        label: z.string().transform(plainLabel),
        state: z.string().nullable(),
        trashed: z.boolean(),
        activity_detail: z.boolean(),
        ticket_reference: z.string().nullable().optional(),
      }),
    ),
    edges: z.array(
      z.object({
        source: z.string(),
        target: z.string(),
        kind: z.enum([
          "blocks",
          "membership",
          "document",
          "spec",
          "mention",
          "attached",
          "activity",
          "support",
          "subticket",
          "related",
          "discovered",
        ]),
        explanation: z.string().nullable(),
      }),
    ),
    omitted: z.boolean(),
    omitted_groups: z.array(z.string()),
    continuations: z.array(
      z.object({
        anchor: z.string(),
        group: z.number(),
        kind: z.string(),
        next_offset: z.number().nullable(),
      }),
    ),
    hidden_details: z.boolean(),
    max_nodes: z.number(),
    max_edges: z.number(),
    max_work: z.number(),
  }),
);
export type ContextGraph = z.infer<typeof contextGraphSchema>;
export const workspaceGraphSchema = lazySchema(() =>
  contextGraphSchema.pick({ nodes: true, edges: true, omitted: true }).extend({
    next_cursor: z.string().nullable(),
    total: z.number(),
    omitted_groups: z.array(z.string()),
    node_tags: z.record(z.string(), z.string()),
    /** Every connection an item has in the workspace, shown or not. */
    connection_counts: z.record(z.string(), z.number()).optional(),
  }),
);
export type WorkspaceGraph = z.infer<typeof workspaceGraphSchema>;
export type WorkspaceGraphRequest = {
  cursor: string | null;
  search: string | null;
  kind: string | null;
  tag: string | null;
  relationship: string | null;
  include_details: boolean;
  adjacency_limit: number;
  visible_ids: string[];
  hydrate_only: boolean;
  node_limit?: number;
  edge_limit?: number;
};

export const graphSchema = lazySchema(() =>
  z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        trashed: z.boolean(),
        reference: z.string(),
        title: z.string(),
        status: z.string(),
        availability: z.string().nullable(),
        boundary: z.boolean().optional(),
        project_id: z.string().nullable().optional(),
      }),
    ),
    edges: z.array(z.object({ blocker: z.string(), dependent: z.string() })),
    max_nodes: z.number(),
    max_depth: z.number(),
    max_edges: z.number(),
    max_work: z.number(),
    omitted_neighbors: z.boolean(),
    omitted_edges: z.boolean(),
    truncated: z.boolean(),
    total_members: z.number().nullable().optional(),
    outside_total: z.number().nullable().optional(),
  }),
);
export type DependencyGraph = z.infer<typeof graphSchema>;
const readinessSchema = lazySchema(() =>
  z.enum(["ready", "blocked", "no_ready_state"]),
);
const reviewModeSchema = lazySchema(() => z.enum(["duplicate", "separate"]));
const dependencyEdgeSchema = lazySchema(() =>
  z.object({
    blocker: z.string(),
    dependent: z.string(),
    replacement_blocker: z.string(),
    replacement_dependent: z.string(),
    // Stamped by the preview; submitted back unchanged with each decision.
    mode: reviewModeSchema,
    basis: z.string(),
    replacement_basis: z.string(),
  }),
);
const duplicatePreviewSchema = lazySchema(() =>
  z.object({
    source: z.string(),
    mode: reviewModeSchema,
    canonical: z.string(),
    edges: z.array(dependencyEdgeSchema),
    // Each dependent as it is now; what a choice changes comes from evaluating.
    waiting: z.array(
      z.object({
        ticket: z.string(),
        status: statusSchema,
        trashed: z.boolean(),
        readiness: readinessSchema,
        unresolved: z.array(z.string()),
      }),
    ),
    replacement_issues: z
      .array(
        z.enum(["already_exists", "self_block", "cycle", "trashed"]).nullable(),
      )
      .default([]),
  }),
);
// What every choice together does to one waiting ticket; decided by the core.
const waitingOutcomeSchema = lazySchema(() =>
  z.object({
    ticket: z.string(),
    status: statusSchema,
    trashed: z.boolean(),
    before: readinessSchema,
    after: readinessSchema,
    unresolved_after: z.array(z.string()),
  }),
);
export type WaitingOutcome = z.infer<typeof waitingOutcomeSchema>;
export type DependencyEdge = z.infer<typeof dependencyEdgeSchema>;
export type DuplicatePreview = z.infer<typeof duplicatePreviewSchema>;
export type DependencyDecision = {
  edge: DependencyEdge;
  choice: "replace" | "remove" | "retain";
};

export const projectSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    paths: z.array(z.string()),
    remote: z.string().nullish(),
    archived: z.boolean().optional(),
  }),
);
export type Project = z.infer<typeof projectSchema>;
const projectArchiveOutcomeSchema = lazySchema(() =>
  z.object({ project: projectSchema, change: z.string().nullable() }),
);
const projectRemoteDetectionSchema = lazySchema(() =>
  z.object({
    suggested: z.string().nullable(),
    candidates: z.array(z.object({ name: z.string(), remote: z.string() })),
  }),
);
export type ProjectRemoteDetection = z.infer<
  typeof projectRemoteDetectionSchema
>;
const activitySchema = lazySchema(() =>
  z.object({
    id: z.string(),
    ticket_id: z.string(),
    brief: z.string(),
    reported_at: z.string(),
    updated_at: z.string(),
    editing_agent: z.string().nullable(),
    supporting_document_id: z.string().nullable().optional(),
    credited_to: creditedSubAgentSchema.nullish(),
  }),
);
const activityFeedSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("authored"), activity: activitySchema }),
    z.object({
      type: z.literal("automatic"),
      id: z.number(),
      event: z.object({
        kind: z.string(),
        from_value: z.string(),
        to_value: z.string(),
        timestamp: z.string(),
        editing_agent: z.string().nullable(),
        credited_to: creditedSubAgentSchema.nullish(),
      }),
    }),
  ]),
);
const evidenceSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    kind: z.enum([
      "pull_request",
      "commit",
      "branch",
      "worktree",
      "verification",
    ]),
    name: z.string(),
    value: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    editing_agent: z.string().nullable(),
  }),
);
export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceInput = Pick<
  Evidence,
  "kind" | "name" | "value" | "editing_agent"
>;
export type AuthoredActivity = z.infer<typeof activitySchema>;
export type ActivityFeedEntry = z.infer<typeof activityFeedSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
const ticketMetadataSchema = lazySchema(() =>
  ticketSchema
    .pick({
      id: true,
      reference: true,
      title: true,
      status: true,
      trashed: true,
      project_id: true,
      plan_id: true,
      availability: true,
    })
    .extend({
      status: statusSchema,
      availability: z.enum(["Ready", "Blocked"]).nullable(),
    }),
);
const flowTicketMetadataSchema = lazySchema(() =>
  ticketMetadataSchema.extend({
    prerequisites: ticketSchema.shape.prerequisites,
    updated_at: ticketSchema.shape.updated_at,
    source: ticketSourceSchema.pick({ unavailable: true }).nullish(),
  }),
);
/** A ticket as a list or board row shows it; the detail pane reads the whole Ticket. */
const ticketRowSchema = lazySchema(() =>
  ticketMetadataSchema.extend({
    updated_at: ticketSchema.shape.updated_at,
    tags: ticketSchema.shape.tags,
    latest_update: latestUpdateSchema.nullable(),
    /** Set only while an external source owns the ticket. */
    source: z
      .object({
        provider: z.string(),
        provider_name: z.string(),
        place: z.string(),
        number: z.string(),
        display: z.string(),
      })
      .nullable(),
    parent: ticketSchema.shape.parent,
    duplicate_of: z.string().nullable(),
    prerequisites: z.object({
      total: z.number().int().nonnegative(),
      unresolved: z.number().int().nonnegative(),
    }),
  }),
);
export type TicketMetadata = z.infer<typeof ticketMetadataSchema>;
export type TicketRow = z.infer<typeof ticketRowSchema>;
export type FlowTicketMetadata = z.infer<typeof flowTicketMetadataSchema>;
export type FindFilter = {
  query: string;
  project: string | null;
  unlinked: boolean;
  plan: string | null;
  status: string | null;
  tags: string[];
  availability: string | null;
  family: string | null;
  /** Only tickets a provider owns, or only local ones; null for all. */
  source?: "Local" | { Provider: string } | null;
  /** "Workflow" pages through In progress, In review, Todo, Done, Canceled, Duplicate. */
  order?: "Newest" | "Workflow";
  limit: number;
  offset: number;
};
const statusCountsSchema = lazySchema(() =>
  z.object({
    todo: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative(),
    in_review: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    /** Every ticket of the result, summed by the core. */
    total: z.number().int().nonnegative(),
  }),
);
/** A source comment or timeline event, read-only. Authors are the source's own, never editing agents. */
const conversationEntrySchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("comment"),
      id: z.string(),
      author: z.string(),
      body: z.string(),
      url: z.string(),
      created_at: z.string(),
      edited_at: z.string().nullable(),
    }),
    z.object({
      type: z.literal("event"),
      id: z.string(),
      event: z.string(),
      state_category: stateCategorySchema.optional(),
      actor: z.string().nullable(),
      subject: z.string().nullable(),
      created_at: z.string(),
    }),
  ]),
);
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;
const sourceCountsSchema = lazySchema(() =>
  z.object({
    all: z.number().int().nonnegative(),
    local: z.number().int().nonnegative(),
    providers: z.record(z.string(), z.number().int().nonnegative()),
  }),
);
/** How many tickets each source filter shows, with the other filters applied. */
export type SourceCounts = z.infer<typeof sourceCountsSchema>;
/** Tickets of a whole filtered result, by status. */
export type StatusCounts = z.infer<typeof statusCountsSchema>;
export type BulkChange = {
  project_id?: string | null;
  plan_id?: string | null;
  add_tags?: string[];
  remove_tags?: string[];
};
/** The first update an agent wrote: Set up ticketd's "An agent has picked up a ticket". */
const agentUpdateSchema = lazySchema(() =>
  z.object({
    reference: z.string(),
    editing_agent: z.string(),
    reported_at: z.string(),
  }),
);
export type AgentUpdate = z.infer<typeof agentUpdateSchema>;
export const client = {
  /** The oldest Activity with an author name (an agent's), or null while no agent has written one. */
  async firstAgentUpdate() {
    return agentUpdateSchema
      .nullable()
      .parse(await invoke("first_agent_update"));
  },
  async workspaceGraph(request: WorkspaceGraphRequest) {
    return workspaceGraphSchema.parse(
      await invoke("workspace_graph", { request }),
    );
  },
  async contextGraphExpanded(
    reference: string,
    includeDetails: boolean,
    expandedIds: string[],
    pages: { anchor: string; group: number; offset: number }[],
  ) {
    return contextGraphSchema.parse(
      await invoke("context_graph_expanded", {
        reference,
        includeDetails,
        expandedIds,
        pages,
      }),
    );
  },
  async contextGraph(reference: string, includeDetails: boolean) {
    return contextGraphSchema.parse(
      await invoke("context_graph", { reference, includeDetails }),
    );
  },
  async bulkChange(
    references: string[],
    change: BulkChange,
    requestId: string,
  ) {
    return z
      .array(ticketSchema)
      .parse(
        await structured(
          invoke("bulk_change", { references, change, requestId }),
        ),
      );
  },
  /** Every relationship of a ticket as the core reports it, one page of each kind. */
  async contextualRelationships(
    reference: string,
    offset = 0,
  ): Promise<Relationships> {
    return z
      .object({ relationships: relationshipsSchema })
      .parse(await invoke("contextual_relationships", { reference, offset }))
      .relationships;
  },
  async changeContextualRelationship(
    source: string,
    target: string,
    kind: "related" | "discovered",
    add: boolean,
    requestId: string,
  ) {
    return ticketSchema.parse(
      await invoke("change_contextual_relationship", {
        source,
        target,
        kind,
        add,
        requestId,
      }),
    );
  },
  async bulkStatus(references: string[], status: string, requestId: string) {
    return z
      .array(ticketSchema)
      .parse(
        await structured(
          invoke("bulk_status", { references, status, requestId }),
        ),
      );
  },
  async previewDuplicate(source: string, canonical: string, separate = false) {
    return duplicatePreviewSchema.parse(
      await invoke("preview_duplicate_dependencies", {
        source,
        canonical,
        separate,
      }),
    );
  },
  async evaluateDuplicate(
    source: string,
    canonical: string,
    separate: boolean,
    decisions: DependencyDecision[],
  ) {
    return z.array(waitingOutcomeSchema).parse(
      await structured(
        invoke("evaluate_dependency_review", {
          source,
          canonical,
          separate,
          decisions,
        }),
      ),
    );
  },
  async markDuplicateReviewed(
    source: string,
    canonical: string,
    expectedCanonical: string,
    decisions: DependencyDecision[],
    requestId: string,
  ) {
    return ticketSchema.parse(
      await structured(
        invoke("mark_duplicate_reviewed", {
          source,
          canonical,
          expectedCanonical,
          decisions,
          requestId,
        }),
      ),
    );
  },
  async editDependenciesReviewed(
    source: string,
    canonical: string,
    expectedCanonical: string,
    decisions: DependencyDecision[],
    requestId: string,
  ) {
    return ticketSchema.parse(
      await structured(
        invoke("edit_dependencies_reviewed", {
          source,
          canonical,
          expectedCanonical,
          decisions,
          requestId,
        }),
      ),
    );
  },
  async takeOwnership(reference: string, requestId: string) {
    return ticketSchema.parse(
      await invoke("take_ownership", { reference, requestId }),
    );
  },
  async removeDuplicate(source: string, requestId: string) {
    return ticketSchema.parse(
      await invoke("remove_duplicate", { source, requestId }),
    );
  },
  async changeDependency(
    command: "add_dependency" | "remove_dependency",
    blocker: string,
    dependent: string,
  ) {
    await invoke(command, { blocker, dependent });
  },
  async searchTags(query: string) {
    return z.array(z.string()).parse(await invoke("search_tags", { query }));
  },
  async changeTag(
    command: "add_tag" | "remove_tag",
    reference: string,
    tag: string,
  ) {
    return ticketSchema.parse(await invoke(command, { reference, tag }));
  },
  async setPlan(reference: string, plan: string | null) {
    return ticketSchema.parse(await invoke("set_plan", { reference, plan }));
  },
  async setParent(reference: string, parent: string | null) {
    await invoke("set_parent", { reference, parent });
  },
  async detachChild(child: string, parent: string) {
    await invoke("detach_child", { child, parent });
  },
  /**
   * Resolves once the workspace was replaced: `safety_path` is the copy of what
   * it was before, and `warning` says what could not be confirmed around the
   * restore. Rejects only when nothing was replaced.
   */
  async restoreWorkspace(path: string) {
    return z
      .object({ safety_path: z.string(), warning: z.string().nullish() })
      .parse(await invoke("restore_workspace", { path }));
  },
  async exportWorkspace(path: string) {
    await invoke("export_workspace", { path });
  },
  async dependencyGraph(reference: string) {
    return graphSchema.parse(await invoke("dependency_graph", { reference }));
  },
  async listPlans(limit?: number, offset = 0) {
    return z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          archived: z.boolean(),
          purpose: z.string().default(""),
        }),
      )
      .parse(
        await (limit === undefined
          ? invoke("list_plans")
          : invoke("list_plans", { limit, offset })),
      );
  },
  async listProjects() {
    return z.array(projectSchema).parse(await invoke("list_projects"));
  },
  async setProjectArchived(
    id: string,
    archived: boolean,
    expectedChange?: string,
  ) {
    return projectArchiveOutcomeSchema.parse(
      await invoke("set_project_archived", { id, archived, expectedChange }),
    );
  },
  async linkSourceRepositoryProject(
    connection: string,
    repository: string,
    projectId: string,
  ) {
    return projectSchema.parse(
      await invoke("link_source_repository_project", {
        connection,
        repository,
        projectId,
      }),
    );
  },
  async createSourceRepositoryProject(
    connection: string,
    repository: string,
    name: string,
    path: string,
  ) {
    return projectSchema.parse(
      await invoke("create_source_repository_project", {
        connection,
        repository,
        name,
        path,
      }),
    );
  },
  async detectProjectRemote(path: string) {
    return projectRemoteDetectionSchema.parse(
      await invoke("detect_project_remote", { path }),
    );
  },
  async createProject(name: string, path: string, remote?: string) {
    return projectSchema.parse(
      await invoke("create_project", { name, path, ...(remote && { remote }) }),
    );
  },
  async editProject(
    id: string,
    name: string,
    path: string,
    remote?: string | null,
  ) {
    return projectSchema.parse(
      await invoke("edit_project", {
        id,
        name,
        path,
        ...(remote === null ? { clearRemote: true } : remote && { remote }),
      }),
    );
  },
  async evidence(reference: string, offset: number) {
    return z
      .array(evidenceSchema)
      .parse(await invoke("list_evidence", { reference, offset }));
  },
  async addEvidence(
    reference: string,
    input: EvidenceInput,
    requestId: string,
  ) {
    return evidenceSchema.parse(
      await invoke("add_evidence", { reference, input, requestId }),
    );
  },
  async editEvidence(
    reference: string,
    id: string,
    input: EvidenceInput,
    requestId: string,
  ) {
    return evidenceSchema.parse(
      await invoke("edit_evidence", { reference, id, input, requestId }),
    );
  },
  async deleteEvidence(reference: string, id: string, requestId: string) {
    await invoke("delete_evidence", { reference, id, requestId });
  },
  async backlinks(reference: string, offset: number) {
    return z
      .array(
        z.object({
          source_reference: z.string(),
          source_title: z.string(),
          activity_id: z.string().nullable(),
          reported_at: z.string().nullable(),
          passage: z.string(),
          mention_start: z.number().int().nonnegative(),
          mention_end: z.number().int().nonnegative(),
        }),
      )
      .parse(
        await invoke("ticket_backlinks", { reference, limit: 20, offset }),
      );
  },
  async activityFeed(reference: string, offset: number) {
    return z
      .array(activityFeedSchema)
      .parse(await invoke("activity_feed", { reference, limit: 50, offset }));
  },
  async activity(reference: string, id: string) {
    return activitySchema
      .nullable()
      .parse(await invoke("get_activity", { reference, id }));
  },
  async addActivity(reference: string, brief: string) {
    return activitySchema.parse(
      await invoke("add_activity", { reference, brief }),
    );
  },
  async addActivityWithDetails(
    reference: string,
    brief: string,
    details: string | null,
    existingDocumentId: string | null,
    requestId: string,
  ) {
    return activitySchema.parse(
      await invoke("add_activity_with_details", {
        reference,
        brief,
        details,
        existingDocumentId,
        requestId,
      }),
    );
  },
  async editActivity(reference: string, id: string, brief: string) {
    return activitySchema.parse(
      await invoke("edit_activity", { reference, id, patch: { brief } }),
    );
  },
  async deleteActivity(reference: string, id: string) {
    await invoke("delete_activity", { reference, id });
  },
  async showTicket(reference: string) {
    return ticketSchema.parse(await invoke("show_ticket", { reference }));
  },
  async findTickets(filter: FindFilter) {
    const page = z
      .array(
        z.object({
          ticket: ticketSchema,
          latest_update: latestUpdateSchema.nullable(),
        }),
      )
      .parse(await invoke("find_tickets_with_updates", { filter }));
    return page.map(({ ticket, latest_update }) => ({
      ...ticket,
      progress_summary: latest_update,
    }));
  },
  /** A page of list or board rows: what `findTickets` finds, without bodies. */
  async findTicketRows(filter: FindFilter) {
    return z
      .array(ticketRowSchema)
      .parse(await invoke("find_ticket_rows", { filter }));
  },
  async findTicketMetadata(filter: FindFilter, ids?: string[]) {
    return z
      .object({ items: z.array(ticketMetadataSchema), omitted: z.boolean() })
      .parse(
        await invoke("find_tickets_with_updates", {
          filter,
          projection: "metadata",
          ...(ids && { ids }),
        }),
      );
  },
  /**
   * The metadata of the tickets these references name, out of the Trash and
   * whatever a list's search and filters say: at most 100 a read. A reference
   * that names no such ticket is left out.
   */
  async findTicketMetadataByReference(references: string[]) {
    const filter: FindFilter = {
      query: "",
      project: null,
      unlinked: false,
      plan: null,
      status: null,
      tags: [],
      availability: null,
      family: null,
      limit: 100,
      offset: 0,
    };
    const page = z.object({ items: z.array(ticketMetadataSchema) }).parse(
      await invoke("find_tickets_with_updates", {
        filter,
        projection: "metadata",
        references,
      }),
    );
    return page.items;
  },
  async findFlowMetadata(filter: FindFilter) {
    return z
      .object({
        items: z.array(flowTicketMetadataSchema),
        omitted: z.boolean(),
      })
      .parse(
        await invoke("find_tickets_with_updates", {
          filter,
          projection: "flow",
        }),
      );
  },
  /** Counts the whole filtered result by status, ignoring its paging. */
  async countTickets(filter: FindFilter) {
    return statusCountsSchema.parse(await invoke("count_tickets", { filter }));
  },
  /** The source's comments and events retrieved for a ticket, oldest first. */
  async sourceConversation(reference: string) {
    return z
      .array(conversationEntrySchema)
      .parse(await invoke("source_conversation", { reference }));
  },
  /** Counts the tickets each source filter (All, a provider, Local) would show. */
  async countBySource(filter: FindFilter) {
    return sourceCountsSchema.parse(
      await invoke("count_by_source", { filter }),
    );
  },
  async searchTickets(query: string, filter: string, offset: number) {
    return z.array(ticketSchema).parse(
      await invoke("search_tickets", {
        query,
        project: filter === "all" || filter === "unlinked" ? null : filter,
        unlinked: filter === "unlinked",
        limit: 50,
        offset,
      }),
    );
  },
  async listTrash() {
    return z.array(ticketSchema).parse(await invoke("list_trash"));
  },
  async setTrashed(reference: string, trashed: boolean) {
    return ticketSchema.parse(
      await invoke("set_trashed", { reference, trashed }),
    );
  },
  async registerCheckout(id: string, path: string) {
    return projectSchema.parse(await invoke("register_checkout", { id, path }));
  },
  async removeCheckout(id: string, path: string) {
    return projectSchema.parse(await invoke("remove_checkout", { id, path }));
  },
  async createTicket(
    title: string,
    body: string,
    status: string,
    projectId: string | null,
    planId: string | null,
    tags: string[],
    follow: boolean,
    requestId?: string,
    blockers: string[] = [],
  ) {
    return ticketSchema.parse(
      await invoke("create_ticket", {
        title,
        body,
        status,
        projectId,
        planId,
        tags,
        follow,
        ...(blockers.length > 0 && { blockers }),
        ...(requestId && { requestId }),
      }),
    );
  },
  async changeTicket(
    reference: string,
    patch: {
      title?: string;
      body?: string;
      /** The title/body last loaded or saved; the core rejects a stale change. */
      expected_title?: string;
      expected_body?: string;
      project_id?: string | null;
      status?: string;
    },
    requestId?: string,
  ) {
    return ticketSchema.parse(
      await invoke("change_ticket", {
        reference,
        patch,
        ...(requestId !== undefined && { requestId }),
      }),
    );
  },
};
