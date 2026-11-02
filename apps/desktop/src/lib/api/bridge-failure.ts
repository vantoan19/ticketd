import { z } from "zod";

/** Every kind of failure the core reports across the bridge. */
export const failureCodes = [
  "batch_operation",
  "review_changed",
  "review_mode",
  "publication_ineligible",
  "publication_failed",
  "publication_unresolved",
  "publication_nothing_to_resolve",
  "publication_still_running",
  "publication_unverified",
  "publication_mismatch",
  "publication_candidates",
  "publication_settled",
  "publication_changed",
  "rejected",
  "unauthenticated",
  "forbidden",
  "not_found",
  "rate_limited",
  "unavailable",
  "protocol",
  "unsupported",
  "invalid_configuration",
  "unknown_provider",
  "incompatible_contract",
  "failed",
] as const;
export type FailureCode = (typeof failureCodes)[number];

/**
 * A bridge failure with the kind the core reported, so callers never read its
 * message to decide. A code this build does not know reads as `failed`.
 */
export class BridgeFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    /** For `batch_operation`, which operation of the batch was rejected. */
    readonly index: number | null = null,
    /** For `invalid_configuration`, the problems with each field. */
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

const failureSchema = z.object({
  code: z.enum(failureCodes).catch("failed"),
  index: z.number().nullish(),
  message: z.string(),
  fields: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .nullish(),
});

/** Reads what a command rejected with; anything unstructured is a plain failure. */
export function toFailure(reason: unknown): BridgeFailure {
  if (reason instanceof BridgeFailure) return reason;
  const parsed = failureSchema.safeParse(reason);
  if (parsed.success)
    return new BridgeFailure(
      parsed.data.code,
      parsed.data.message,
      parsed.data.index ?? null,
      parsed.data.fields ?? [],
    );
  return new BridgeFailure(
    "failed",
    reason instanceof Error ? reason.message : String(reason),
  );
}

/** Awaits a command that reports structured failures. */
export async function structured<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (reason) {
    throw toFailure(reason);
  }
}
