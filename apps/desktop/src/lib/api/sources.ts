import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { publicationAttemptSchema } from "./client";

const choiceOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullish(),
});
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;

const fieldBase = {
  key: z.string(),
  label: z.string(),
  help: z.string().nullish(),
  required: z.boolean(),
};

const optionSourceSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("static"),
    options: z.array(choiceOptionSchema),
  }),
  z.object({
    source: z.literal("dynamic"),
    depends_on: z.array(z.string()),
  }),
]);

const schemaFieldSchema = z.discriminatedUnion("type", [
  z.object({
    ...fieldBase,
    type: z.literal("text"),
    placeholder: z.string().nullish(),
    format: z.string().nullish(),
  }),
  z.object({
    ...fieldBase,
    type: z.literal("multi_select"),
    options: optionSourceSchema,
    allow_custom: z.boolean(),
    min_items: z.number(),
    max_items: z.number(),
    format: z.string().nullish(),
  }),
]);
export type SchemaField = z.infer<typeof schemaFieldSchema>;

const connectorSchema = z.object({
  provider: z.string(),
  name: z.string(),
  contract_version: z.number(),
  capabilities: z.array(z.string()),
  schema: z.object({ fields: z.array(schemaFieldSchema) }),
});
export type Connector = z.infer<typeof connectorSchema>;

/** Validated configuration values as the core stores them. */
const configSchema = z.record(z.string(), z.unknown());
export type SourceConfig = z.infer<typeof configSchema>;

const savedSourceSchema = z.object({
  provider: z.string(),
  config: configSchema,
  account: z.string(),
  saved_at: z.string(),
});
export type SavedSource = z.infer<typeof savedSourceSchema>;

const sourceEntrySchema = z.object({
  connector: connectorSchema,
  saved: savedSourceSchema.nullable(),
});
export type SourceEntry = z.infer<typeof sourceEntrySchema>;

const previewSchema = z.object({
  provider: z.string(),
  account: z.string(),
  issues: z.array(
    z.object({
      display: z.string(),
      url: z.string(),
      title: z.string(),
      assignees: z.array(z.string()),
      labels: z.array(z.string()),
      updated_at: z.string(),
    }),
  ),
  matched: z.number(),
  complete: z.boolean(),
});
export type DiscoveryPreview = z.infer<typeof previewSchema>;

const saveOutcomeSchema = z.object({
  source: savedSourceSchema,
  preview: previewSchema,
});

const refreshReportSchema = z.object({
  imported: z.array(z.string()),
  updated: z.array(z.string()),
  unchanged: z.number(),
  failures: z.array(
    z.object({
      provider: z.string(),
      reference: z.string().nullable(),
      code: z.string(),
      message: z.string(),
    }),
  ),
  refreshed_at: z.string(),
});
export type RefreshReport = z.infer<typeof refreshReportSchema>;

const connectionSchema = z.object({ account: z.string() });

const eligibilitySchema = z.discriminatedUnion("kind", [
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
    ]),
    message: z.string(),
  }),
]);
/** What publishing would send, exactly, and whether it is allowed. */
const publicationPreviewSchema = z.object({
  reference: z.string(),
  provider: z.string(),
  provider_name: z.string(),
  destination: z.string().nullable(),
  destinations: z.array(z.string()),
  title: z.string(),
  body: z.string(),
  eligibility: eligibilitySchema,
  attempt: publicationAttemptSchema.nullable(),
});
export type PublicationPreview = z.infer<typeof publicationPreviewSchema>;
const publishOutcomeSchema = z.object({
  attempt: publicationAttemptSchema,
  replayed: z.boolean(),
});

export type SourceFailureCode =
  | "publication_ineligible"
  | "publication_failed"
  | "publication_unresolved"
  | "rejected"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "protocol"
  | "unsupported"
  | "invalid_configuration"
  | "unknown_provider"
  | "incompatible_contract"
  | "failed";

/** A failed source operation, with the core's kind and any per-field problems. */
export class SourceFailure extends Error {
  constructor(
    readonly code: SourceFailureCode | string,
    message: string,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  fields: z.array(z.object({ field: z.string(), message: z.string() })),
});

export function toSourceFailure(reason: unknown): SourceFailure {
  if (reason instanceof SourceFailure) return reason;
  const parsed = failureSchema.safeParse(reason);
  if (parsed.success)
    return new SourceFailure(
      parsed.data.code,
      parsed.data.message,
      parsed.data.fields,
    );
  return new SourceFailure(
    "failed",
    reason instanceof Error ? reason.message : String(reason),
  );
}

async function call<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (reason) {
    throw toSourceFailure(reason);
  }
}

export const sourcesClient = {
  /**
   * Imports matching issues and refreshes every externally owned ticket, or only
   * `ticket`. Saved content stays in place when the source cannot be reached; the
   * report names what failed.
   */
  async refresh(ticket?: string) {
    return refreshReportSchema.parse(
      await call(invoke("refresh_sources", { ticket: ticket ?? null })),
    );
  },
  /** What publishing a local ticket would send. Makes no network call. */
  async previewPublication(
    reference: string,
    provider: string,
    destination?: string,
  ) {
    return publicationPreviewSchema.parse(
      await call(
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
  async publish(reference: string, provider: string, destination?: string) {
    return publishOutcomeSchema.parse(
      await call(
        invoke("publish_ticket", {
          reference,
          provider,
          destination: destination ?? null,
        }),
      ),
    );
  },
  /** The built-in sources and what is saved for each. */
  async list() {
    return z.array(sourceEntrySchema).parse(await call(invoke("list_sources")));
  },
  async checkConnection(provider: string, config: SourceConfig) {
    return connectionSchema.parse(
      await call(invoke("source_check_connection", { provider, config })),
    );
  },
  async options(
    provider: string,
    field: string,
    query: string,
    config: SourceConfig,
  ) {
    return z
      .array(choiceOptionSchema)
      .parse(
        await call(
          invoke("source_options", { provider, field, query, config }),
        ),
      );
  },
  /** Lists what discovery would match. Imports and saves nothing. */
  async preview(provider: string, config: SourceConfig) {
    return previewSchema.parse(
      await call(invoke("source_preview", { provider, config })),
    );
  },
  /** Validates, previews, and saves the discovery configuration. Imports nothing. */
  async save(provider: string, config: SourceConfig) {
    return saveOutcomeSchema.parse(
      await call(invoke("save_source", { provider, config })),
    );
  },
};
