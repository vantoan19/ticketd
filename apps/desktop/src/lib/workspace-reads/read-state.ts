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
