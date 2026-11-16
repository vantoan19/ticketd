import { useMemo } from "react";
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
   * has made it stale and its re-read is not back, and while hidden after one.
   * It is read when asked for, so a view that never asks does not re-render
   * when it moves.
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

/** The failure in people's words; the same object until the failure changes. */
export function useFailure(
  error: unknown,
  action: string,
): FailureDescription | null {
  return useMemo(
    () => (error === null ? null : describeFailure(error, action)),
    [error, action],
  );
}
