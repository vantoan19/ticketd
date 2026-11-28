import { Channel } from "@tauri-apps/api/core";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";
import { BridgeFailure, invoke, structured, toFailure } from "./bridge-failure";
import {
  publicationAttemptSchema,
  publicationReviewSchema,
  type PublicationResolution,
  type ResolveConfirmation,
} from "./publication";

const choiceOptionSchema = lazySchema(() =>
  z.object({
    value: z.string(),
    label: z.string(),
    description: z.string().nullish(),
  }),
);
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;

const fieldBase = () => ({
  key: z.string(),
  label: z.string(),
  help: z.string().nullish(),
  required: z.boolean(),
  placeholder: z.string().nullish(),
  pattern: z.object({ regex: z.string(), message: z.string() }).nullish(),
  advanced: z.boolean().optional(),
  show_if: z.string().nullish(),
});

const optionSourceSchema = lazySchema(() =>
  z.discriminatedUnion("source", [
    z.object({
      source: z.literal("static"),
      options: z.array(choiceOptionSchema),
    }),
    z.object({
      source: z.literal("dynamic"),
      depends_on: z.array(z.string()),
    }),
  ]),
);

const schemaFieldSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({
      ...fieldBase(),
      type: z.literal("text"),
      format: z.string().nullish(),
    }),
    z.object({
      ...fieldBase(),
      type: z.literal("multi_select"),
      options: optionSourceSchema,
      allow_custom: z.boolean(),
      min_items: z.number(),
      max_items: z.number(),
      format: z.string().nullish(),
    }),
    z.object({ ...fieldBase(), type: z.literal("link"), url: z.string() }),
    z.object({ ...fieldBase(), type: z.literal("secret") }),
  ]),
);
export type SchemaField = z.infer<typeof schemaFieldSchema>;

const fieldPresentationSchema = lazySchema(() =>
  z.object({
    placeholder: z.string().nullish(),
    additional_placeholder: z.string().nullish(),
  }),
);
export type FieldPresentation = z.infer<typeof fieldPresentationSchema>;

const presentationSchema = lazySchema(() =>
  z.object({
    icon_svg: z.string().nullish(),
    sign_in: z.object({
      terminal_hint: z.string().nullish(),
      desktop_hint: z.string().nullish(),
      desktop_instruction: z.string().nullish(),
    }),
    fields: z.record(z.string(), fieldPresentationSchema),
    target: z
      .object({
        field: z.string(),
        label: z.string(),
        example: z.string(),
        choose: z.string(),
        add: z.string(),
      })
      .nullish(),
    discovery_note: z.string().nullish(),
    pull_request_link: z
      .object({ host: z.string(), segment: z.string() })
      .nullish(),
    hosts: z.array(z.string()),
  }),
);
const summaryPartSchema = lazySchema(() =>
  z.object({ text: z.string(), emphasis: z.boolean() }),
);
export type SummaryPart = z.infer<typeof summaryPartSchema>;

const connectorSchema = lazySchema(() =>
  z.object({
    provider: z.string(),
    name: z.string(),
    contract_version: z.number(),
    capabilities: z.array(z.string()),
    schema: z.object({ fields: z.array(schemaFieldSchema) }),
    presentation: presentationSchema.optional(),
  }),
);
export type Connector = z.infer<typeof connectorSchema>;

/** Validated configuration values as the core stores them. */
const configSchema = lazySchema(() => z.record(z.string(), z.unknown()));
export type SourceConfig = z.infer<typeof configSchema>;

const savedSourceSchema = lazySchema(() =>
  z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    provider: z.string(),
    config: configSchema,
    account: z.string(),
    saved_at: z.string(),
    secret_fields: z.array(z.string()).optional(),
    session_secret_fields: z.array(z.string()).optional(),
  }),
);
export type SavedSource = z.infer<typeof savedSourceSchema>;

/** A program a person added as a source: what it runs, where it connects, where it came from. */
const registeredExtensionSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    version: z.string(),
    /** The registry's own copy of the folder. */
    path: z.string(),
    development: z.boolean(),
    hosts: z.array(z.string()),
    /** The program and its arguments as the manifest names them: `node dist/index.js`. */
    command: z.string(),
    /** The folder it was added from, when known. */
    origin: z.string().optional(),
  }),
);
export type RegisteredExtension = z.infer<typeof registeredExtensionSchema>;

const extensionStateSchema = lazySchema(() =>
  registeredExtensionSchema.extend({
    /** Its files changed since they were approved, so it is stopped until added again. */
    stopped: z.boolean(),
    bundled: z.boolean(),
  }),
);
export type ExtensionState = z.infer<typeof extensionStateSchema>;

/** A folder read but not run, and the one approval that adds exactly it. */
const extensionConsentSchema = lazySchema(() =>
  z.object({
    token: z.string(),
    extension: registeredExtensionSchema,
    executable: z.string(),
    args: z.array(z.string()),
  }),
);
export type ExtensionConsent = z.infer<typeof extensionConsentSchema>;

/** The codes of a folder that cannot be added, said before any consent. */
export const FOLDER_REFUSALS = [
  "not_a_folder",
  "no_manifest",
  "needs_newer_ticketd",
  "invalid_manifest",
] as const;

const sourceEntrySchema = lazySchema(() =>
  z.object({
    connector: connectorSchema,
    saved: savedSourceSchema.nullable(),
    next_id: z.string().optional(),
    development: z.boolean().optional(),
    unavailable: z.boolean().optional(),
    extension: extensionStateSchema.optional(),
  }),
);
export type SourceEntry = z.infer<typeof sourceEntrySchema>;

export function providerName(
  provider: string,
  entries: readonly SourceEntry[],
): string {
  return (
    entries.find(({ connector }) => connector.provider === provider)?.connector
      .name ?? provider
  );
}

const sourceRepositoryRouteSchema = lazySchema(() =>
  z.object({
    repository: z.string(),
    project_remote: z.string().nullable(),
    project: z.object({ id: z.string(), name: z.string() }).nullable(),
    archived_project_name: z.string().nullable().default(null),
  }),
);
export type SourceRepositoryRoute = z.infer<typeof sourceRepositoryRouteSchema>;

const projectSourceCandidateSchema = lazySchema(() =>
  z.object({
    source: z.string(),
    provider: z.string(),
    connection_id: z.string().nullable(),
    name: z.string(),
  }),
);
export type ProjectSourceCandidate = z.infer<
  typeof projectSourceCandidateSchema
>;

export const previewSchema = lazySchema(() =>
  z.object({
    provider: z.string(),
    account: z.string(),
    issues: z.array(
      z.object({
        display: z.string(),
        label: z.string().optional(),
        url: z.string(),
        title: z.string(),
        ticket: z.string().nullish(),
        assignees: z.array(z.string()),
        labels: z.array(z.string()),
        updated_at: z.string(),
      }),
    ),
    matched: z.number(),
    new: z.number().optional(),
    already_here: z.number().optional(),
    complete: z.boolean(),
  }),
);
export type DiscoveryPreview = z.infer<typeof previewSchema>;

const saveOutcomeSchema = lazySchema(() =>
  z.object({
    source: savedSourceSchema,
    preview: previewSchema,
  }),
);

const connectSourcePreviewSchema = lazySchema(() =>
  z.object({
    project_id: z.string(),
    project_remote: z.string(),
    provider: z.string(),
    connection_id: z.string().nullable(),
    repository: z.string(),
    source: z.enum(["not_connected", "add_repository", "already_listed"]),
    tickets: z.array(z.string()),
    fingerprint: z.string(),
  }),
);
export type ConnectSourcePreview = z.infer<typeof connectSourcePreviewSchema>;

const connectSourceMatchCountSchema = lazySchema(() =>
  z.object({ matched: z.number(), complete: z.boolean() }).nullable(),
);
export type ConnectSourceMatchCount = NonNullable<
  z.infer<typeof connectSourceMatchCountSchema>
>;

const connectSourceOutcomeSchema = lazySchema(() =>
  z.object({
    repository_added: z.boolean(),
    linked_tickets: z.array(z.string()),
  }),
);

const refreshReportSchema = lazySchema(() =>
  z.object({
    imported: z.array(z.string()),
    updated: z.array(z.string()),
    unchanged: z.number(),
    failures: z.array(
      z.object({
        provider: z.string(),
        reference: z.string().nullable(),
        code: z.string(),
        message: z.string(),
        /** What the failure is about: the source, one ticket, one repository or one thread. */
        scope: z
          .enum(["source", "ticket", "partition", "conversation"])
          .catch("source"),
      }),
    ),
    refreshed_at: z.string(),
  }),
);
export type RefreshReport = z.infer<typeof refreshReportSchema>;

const refreshEventSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("started") }),
    z.object({
      kind: z.literal("progress"),
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().nullish(),
    }),
  ]),
);
type RefreshEvent = z.infer<typeof refreshEventSchema>;

/** How a source is doing, as the core decides it. Clients only word it. */
export const sourceHealthValues = [
  "waiting",
  "synced",
  "delayed",
  "unavailable",
  "partial",
] as const;
export type SourceHealthState = (typeof sourceHealthValues)[number];

const sourceStatusSchema = lazySchema(() =>
  z.object({
    provider: z.string(),
    health: z.enum(sourceHealthValues),
    connection_id: z.string().optional(),
    last_attempt_at: z.string().nullable(),
    /** The last run in which the source could be read. */
    last_refreshed_at: z.string().nullable(),
    last_checked_tickets: z.number().int().nonnegative().nullish(),
    tracked_tickets: z.number().int().nonnegative().optional(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    /** When the current streak of failed runs began. */
    failing_since: z.string().nullable(),
    /** The earliest time the source asked to be contacted again. */
    retry_after: z.string().nullable(),
    unavailable_tickets: z.number(),
    /** The discovery rules the last run skipped because they could not be read. */
    partial_message: z.string().nullable(),
  }),
);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

const sourceHealthSchema = lazySchema(() =>
  z.object({
    /** A refresh is running now: startup, periodic, or explicit. */
    refreshing: z.boolean(),
    sources: z.array(sourceStatusSchema),
    /** How often the periodic refresh runs while the app is open, in seconds. */
    interval_secs: z.number().nullish(),
  }),
);
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

const connectionSchema = lazySchema(() => z.object({ account: z.string() }));

const eligibilitySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("eligible") }),
    z.object({
      kind: z.literal("ineligible"),
      reason: z.enum([
        "trashed",
        "externally_owned",
        "provenance_retained",
        "status",
        "source_not_connected",
        "unsupported",
        "attempt_open",
        "internal_attachments",
        "invalid_destination",
        "destination_not_allowed",
        "preview_required",
      ]),
      message: z.string(),
    }),
  ]),
);
/** What publishing would send, exactly, and whether it is allowed. */
const publicationPreviewSchema = lazySchema(() =>
  z.object({
    reference: z.string(),
    provider: z.string(),
    provider_name: z.string(),
    destination: z.string().nullable(),
    destinations: z.array(z.string()),
    destination_labels: z.record(z.string(), z.string()).optional(),
    title: z.string(),
    body: z.string(),
    /** Identifies this title, description and destination; handed back to publish exactly this. */
    fingerprint: z.string(),
    local: z
      .object({
        activities: z.number().int().nonnegative(),
        plan: z.string().nullable(),
        tags: z.array(z.string()),
        subtickets: z.array(z.string()),
        attachments: z.number().int().nonnegative().default(0),
      })
      .optional(),
    eligibility: eligibilitySchema,
    internal_attachments: z
      .array(z.object({ uri: z.string(), display_name: z.string().nullable() }))
      .default([]),
    attempt: publicationAttemptSchema.nullable(),
  }),
);
export type PublicationPreview = z.infer<typeof publicationPreviewSchema>;
const publishOutcomeSchema = lazySchema(() =>
  z.object({
    attempt: publicationAttemptSchema,
    replayed: z.boolean(),
  }),
);

/** A failed source operation: the same structured failure every bridge command reports. */
export { BridgeFailure as SourceFailure, toFailure as toSourceFailure };

export const sourcesClient = {
  /**
   * Imports matching issues and refreshes every externally owned ticket, or only
   * `ticket`. Saved content stays in place when the source cannot be reached; the
   * report names what failed.
   */
  async refresh(
    ticket?: string,
    connection?: string,
    retry = false,
    control?: { id: string; update: (event: RefreshEvent) => void },
  ) {
    const updates = control ? new Channel<unknown>() : undefined;
    if (control && updates) {
      updates.onmessage = (value) =>
        control.update(refreshEventSchema.parse(value));
    }
    return refreshReportSchema.parse(
      await structured(
        invoke("refresh_sources", {
          ticket: ticket ?? null,
          ...(connection && { connection }),
          ...(retry && { retry }),
          ...(control && { refreshId: control.id, updates }),
        }),
      ),
    );
  },
  async cancelRefresh(refreshId: string) {
    return z
      .boolean()
      .parse(await structured(invoke("cancel_source_refresh", { refreshId })));
  },
  /** Persisted freshness of each source and whether a refresh is running. No network I/O. */
  async health() {
    return sourceHealthSchema.parse(await structured(invoke("source_health")));
  },
  /** What publishing a local ticket would send. Makes no network call. */
  async previewPublication(
    reference: string,
    provider: string,
    destination?: string,
  ) {
    return publicationPreviewSchema.parse(
      await structured(
        invoke("preview_publication", {
          reference,
          provider,
          destination: destination ?? null,
        }),
      ),
    );
  },
  /**
   * Publishes a local ticket once. Rejects with a SourceFailure whose code is
   * `publication_failed` (nothing was created), `publication_unresolved` (the
   * issue may exist; publishing again is blocked), or `publication_ineligible`.
   */
  async publish(
    reference: string,
    provider: string,
    destination: string | undefined,
    expectedFingerprint: string,
  ) {
    return publishOutcomeSchema.parse(
      await structured(
        invoke("publish_ticket", {
          reference,
          provider,
          destination: destination ?? null,
          expectedFingerprint,
        }),
      ),
    );
  },
  /**
   * What is known and unknown about an unresolved publication and the safe next
   * actions. With `search`, the source is asked for issues that may be the one created.
   */
  async reviewPublication(reference: string, search: boolean) {
    return publicationReviewSchema.parse(
      await structured(invoke("review_publication", { reference, search })),
    );
  },
  /**
   * Settles an unresolved publication. Rejects, leaving it unresolved, with
   * `publication_unverified` (the source could not give evidence),
   * `publication_candidates`, `publication_mismatch`, `publication_settled` or
   * `publication_different_content` (repeat with `acceptDifferentContent`).
   */
  async resolvePublication(
    reference: string,
    resolution: PublicationResolution,
    confirmation: ResolveConfirmation = {},
  ) {
    return publishOutcomeSchema.parse(
      await structured(
        invoke("resolve_publication", {
          reference,
          resolution,
          acceptDifferentContent: confirmation.acceptDifferentContent ?? false,
        }),
      ),
    );
  },
  /** The registered sources and what is saved for each. */
  async list() {
    return z
      .array(sourceEntrySchema)
      .parse(await structured(invoke("list_sources")));
  },
  async repositoryRoutes(connection: string) {
    return z
      .array(sourceRepositoryRouteSchema)
      .parse(await invoke("source_repository_routes", { connection }));
  },
  async checkConnection(
    provider: string,
    config: SourceConfig,
    connection?: string,
  ) {
    return connectionSchema.parse(
      await structured(
        invoke("source_check_connection", {
          provider,
          config,
          ...(connection && { connection }),
        }),
      ),
    );
  },
  async configurationSummary(provider: string, config: SourceConfig) {
    return z
      .array(summaryPartSchema)
      .parse(
        await structured(
          invoke("source_configuration_summary", { provider, config }),
        ),
      );
  },
  async options(
    provider: string,
    field: string,
    query: string,
    config: SourceConfig,
    connection?: string,
  ) {
    return z.array(choiceOptionSchema).parse(
      await structured(
        invoke("source_options", {
          provider,
          field,
          query,
          config,
          ...(connection && { connection }),
        }),
      ),
    );
  },
  async projectSourceCandidates(projectId: string) {
    return z
      .array(projectSourceCandidateSchema)
      .parse(await invoke("project_source_candidates", { projectId }));
  },
  async previewConnectSource(source: string, projectId: string) {
    return connectSourcePreviewSchema.parse(
      await invoke("preview_connect_source", { source, projectId }),
    );
  },
  async connectSourceMatchCount(
    source: string,
    projectId: string,
    expectedFingerprint: string,
  ) {
    return connectSourceMatchCountSchema.parse(
      await invoke("connect_source_match_count", {
        source,
        projectId,
        expectedFingerprint,
      }),
    );
  },
  async connectSource(
    source: string,
    projectId: string,
    expectedFingerprint: string,
  ) {
    return connectSourceOutcomeSchema.parse(
      await invoke("connect_source", {
        source,
        projectId,
        expectedFingerprint,
      }),
    );
  },
  /** Lists what discovery would match. Imports and saves nothing. */
  async preview(provider: string, config: SourceConfig, connection?: string) {
    return previewSchema.parse(
      await structured(
        invoke("source_preview", {
          provider,
          config,
          ...(connection && { connection }),
        }),
      ),
    );
  },
  /** Validates, previews, and saves the discovery configuration. Imports nothing. */
  async save(provider: string, config: SourceConfig, connection?: string) {
    return saveOutcomeSchema.parse(
      await structured(
        invoke("save_source", {
          provider,
          config,
          ...(connection && { connection }),
        }),
      ),
    );
  },
  async add(
    provider: string,
    connection: string,
    name: string,
    config: SourceConfig,
  ) {
    return saveOutcomeSchema.parse(
      await structured(
        invoke("add_source_connection", {
          provider,
          connection,
          name,
          config,
        }),
      ),
    );
  },
  async rename(connection: string, name: string) {
    return savedSourceSchema.parse(
      await structured(
        invoke("rename_source_connection", { connection, name }),
      ),
    );
  },
  async signIn(connection: string, credentials: SourceConfig) {
    return savedSourceSchema.parse(
      await structured(
        invoke("update_source_credentials", { connection, credentials }),
      ),
    );
  },
  async remove(connection: string) {
    await structured(invoke("remove_source_connection", { connection }));
  },
  /**
   * Reads a folder without running it. Resolves to what the person must approve;
   * a folder that cannot be added rejects with one of `FOLDER_REFUSALS`.
   */
  async prepareExtension(path: string) {
    return extensionConsentSchema.parse(
      await structured(invoke("source_extension_prepare", { path })),
    );
  },
  /** Approves what `prepareExtension` showed, the way `ticketd source extension add` does. */
  async addExtension(token: string) {
    return registeredExtensionSchema.parse(
      await structured(invoke("source_extension_add", { token })),
    );
  },
  /** Drops a prepared folder that was not approved. */
  async cancelExtension(token: string) {
    await structured(invoke("source_extension_cancel", { token }));
  },
  /** Removes the program of a source that was added. Its connections stay saved. */
  async removeExtension(id: string) {
    await structured(invoke("source_extension_remove", { id }));
  },
};
