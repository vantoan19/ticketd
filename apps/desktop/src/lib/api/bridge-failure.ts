import { z } from "zod";

export type FailureCode =
  "batch_operation" | "review_changed" | "review_mode" | "failed";

/** A bridge failure with the kind the core reported, so callers never read its message to decide. */
export class BridgeFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    /** For `batch_operation`, which operation of the batch was rejected. */
    readonly index: number | null = null,
  ) {
    super(message);
  }
}

const failureSchema = z.object({
  code: z.enum(["batch_operation", "review_changed", "review_mode", "failed"]),
  index: z.number().nullable(),
  message: z.string(),
});

/** Reads what a command rejected with; anything unstructured is a plain failure. */
export function toFailure(reason: unknown): BridgeFailure {
  if (reason instanceof BridgeFailure) return reason;
  const parsed = failureSchema.safeParse(reason);
  if (parsed.success)
    return new BridgeFailure(
      parsed.data.code,
      parsed.data.message,
      parsed.data.index,
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
