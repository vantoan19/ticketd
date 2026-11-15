import {
  invoke as tauriInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";
import { z } from "zod";
import {
  reportWorkspaceFailure,
  type WorkspaceState,
} from "@/lib/workspace-state";

/** Every kind of failure the core reports across the bridge. */
export const failureCodes = [
  // The core's failure kinds (`ticketd_core::FailureKind`).
  "workspace_read_only",
  "workspace_unreadable",
  "workspace_locked",
  "disk_full",
  "not_found",
  "cycle",
  "conflict",
  "too_large",
  "not_signed_in",
  "offline",
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
  "publication_different_content",
  "publication_candidates",
  "publication_settled",
  "publication_changed",
  "rejected",
  "unauthenticated",
  "forbidden",
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

/** The failures about the whole workspace rather than one change: the workspace band shows them. */
export const workspaceFailureCodes = [
  "workspace_read_only",
  "workspace_unreadable",
  "workspace_locked",
  "disk_full",
] as const satisfies readonly FailureCode[];
export type WorkspaceFailureCode = (typeof workspaceFailureCodes)[number];

export function isWorkspaceCode(code: string): code is WorkspaceFailureCode {
  return (workspaceFailureCodes as readonly string[]).includes(code);
}

/**
 * A bridge failure with the kind the core reported, so callers never read its
 * message to decide. A code this build does not know reads as `failed`. The
 * message is the raw cause: show it only under "Details" (see describeFailure).
 */
export class BridgeFailure extends Error {
  /** The exact band raised by this rejection; a later failure must survive recovery. */
  workspaceFailure: WorkspaceState = null;

  constructor(
    readonly code: FailureCode,
    message: string,
    /** For `batch_operation`, which operation of the batch was rejected. */
    readonly index: number | null = null,
    /** For `invalid_configuration`, the problems with each field. */
    readonly fields: { field: string; message: string }[] = [],
    /** For `batch_operation`, the kind of the rejected operation's failure. */
    readonly causeCode: FailureCode | null = null,
  ) {
    super(message);
  }

  /** The kind that decides the words: a batch reports its rejected operation's kind. */
  get kind(): FailureCode {
    return this.code === "batch_operation" && this.causeCode
      ? this.causeCode
      : this.code;
  }

  /** The message alone, so older `String(reason)` call sites never show "Error:". */
  override toString(): string {
    return this.message;
  }
}

const failureSchema = z.object({
  code: z.enum(failureCodes).catch("failed"),
  index: z.number().nullish(),
  cause: z.enum(failureCodes).nullish().catch(null),
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
      parsed.data.cause ?? null,
    );
  return new BridgeFailure(
    "failed",
    reason instanceof Error ? reason.message : String(reason),
  );
}

/**
 * Awaits a command that reports structured failures. A workspace-level failure
 * (read-only, locked, unreadable, disk full) also raises the workspace band.
 */
export async function structured<T>(call: Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await call;
  } catch (reason) {
    const failure = toFailure(reason);
    if (isWorkspaceCode(failure.kind))
      failure.workspaceFailure = reportWorkspaceFailure(
        failure.kind,
        failure.message,
      );
    throw failure;
  }
  return result;
}

/** Calls a desktop command; every rejection arrives as a BridgeFailure. */
export function invoke<T>(
  ...call: [command: string, args?: InvokeArgs, options?: InvokeOptions]
): Promise<T> {
  // Passes on exactly the arguments given, as a direct call would.
  return structured(tauriInvoke<T>(...call));
}
