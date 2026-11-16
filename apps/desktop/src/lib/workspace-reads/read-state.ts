import { useMemo, useState } from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";

export type ReadStatus = "idle" | "loading" | "failed" | "ready";

/** What a view sees of one read. */
export type ReadState<V> = {
  value: V | undefined;
  /** The last failure, kept (with `value`) until a read succeeds. */
  failure: FailureDescription | null;
  /** Reads again now; for a paged read, every page loaded so far. */
  retry(): void;
  status: ReadStatus;
  /**
   * Whether `value` is as current as the last change: false while a change
   * has made it stale and its re-read is not back. (A hidden read is not
   * asked: it catches up when shown.) It is read when asked for, so a view
   * that never asks does not re-render when it moves.
   */
  readonly current: boolean;
};

export function statusOf(
  hasValue: boolean,
  failed: boolean,
  enabled: boolean,
): ReadStatus {
  if (hasValue) return "ready";
  if (failed) return "failed";
  return enabled ? "loading" : "idle";
}

/**
 * The failure in people's words; the same object until the failure changes.
 * TanStack clears the error when a retry of a never-answered read starts, so
 * the last one is kept (for the same read) until an answer succeeds.
 */
export function useFailure(
  query: { status: "pending" | "error" | "success"; error: unknown },
  identity: string,
  action: string,
): FailureDescription | null {
  const [kept, setKept] = useState<{ identity: string; error: unknown } | null>(
    null,
  );
  let error: unknown = null;
  if (query.status === "error") error = query.error;
  else if (query.status === "pending" && kept?.identity === identity) {
    error = kept.error;
  }
  // Only a new failure is stored (a store on success would render twice). A
  // read that has answered never goes back to "pending", so this stays correct.
  if (query.status === "error" && kept?.error !== error) {
    setKept({ identity, error });
  }
  return useMemo(
    () => (error === null ? null : describeFailure(error, action)),
    [error, action],
  );
}
