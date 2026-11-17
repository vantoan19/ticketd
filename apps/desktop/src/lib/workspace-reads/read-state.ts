import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /**
   * Reads again now; for a paged read, every loaded page, or the page after a
   * failed "Show more". It resolves once a read started at or after the call has
   * answered with a value or a failure: a read of the same entry that a change
   * or an own write started in its place counts, one they cancelled does not. It
   * never rejects (a failure shows as `failure`). It does nothing, and resolves
   * at once, for a read that is skipped or hidden, and it resolves when the view
   * goes away or is hidden while it waits.
   */
  retry(): Promise<void>;
  status: ReadStatus;
  /**
   * Whether `value` is as current as the last change: false while a change
   * has made it stale and its re-read is not back, and while its re-read has
   * failed. (A hidden read that did not fail is not asked: it catches up when
   * shown.) It is read when asked for, so a view that never asks does not
   * re-render when it moves.
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

type Kept = {
  identity: string;
  error: unknown;
  action: string;
  more: boolean;
};

/**
 * The failure in people's words, and whether it was a failed "Show more"; the
 * same object until the failure changes. TanStack clears the error when a retry
 * of a never-answered read starts, and `isFetchNextPageError` when any refetch
 * starts, so the failure is kept as it was first worded (for the same read)
 * until an answer succeeds.
 *
 * A read that is "pending" with a failure behind it (`errorUpdatedAt` is set) is
 * a Retry of a read that never answered, so the failure stays. A reset puts a
 * read back to pending with no failure behind it: the one kept from before is
 * about a Workspace that is gone, and is not shown.
 */
export function useFailure(
  query: {
    status: "pending" | "error" | "success";
    error: unknown;
    errorUpdatedAt: number;
  },
  identity: string,
  action: string,
  more = false,
): { failure: FailureDescription | null; more: boolean } {
  const [kept, setKept] = useState<Kept | null>(null);
  let shown: Kept | null = null;
  if (query.status === "error") {
    shown =
      kept?.error === query.error
        ? kept
        : { identity, error: query.error, action, more };
    // Only a new failure is stored (a store on success would render twice).
    if (shown !== kept) setKept(shown);
  } else if (
    query.status === "pending" &&
    query.errorUpdatedAt > 0 &&
    kept?.identity === identity
  ) {
    shown = kept;
  }
  const error = shown?.error ?? null;
  const worded = shown?.action ?? "";
  const failure = useMemo(
    () => (error === null ? null : describeFailure(error, worded)),
    [error, worded],
  );
  return { failure, more: shown?.more ?? false };
}

/**
 * Adds `current` to a read's state as a getter, so a view that never asks for
 * it does not re-render when it moves (it is a tracked property of the query).
 * The getter is an own property, so a spread of the state copies the value.
 */
export function withCurrent<S extends object>(
  state: S,
  current: () => boolean,
): S & { readonly current: boolean } {
  return Object.defineProperty({ ...state }, "current", {
    get: current,
    enumerable: true,
  }) as S & { readonly current: boolean };
}

/**
 * A stable function that runs the latest render's `callback`, for buttons that
 * may be from an earlier render (a Retry kept after its Ticket closed).
 */
export function useLatest<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
