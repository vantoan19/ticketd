import { useQuery } from "@tanstack/react-query";
import { readKey, skip, words, type ReadSpec, type Skip } from "./catalog";
import {
  statusOf,
  useFailure,
  useLatest,
  withCurrent,
  type ReadState,
} from "./read-state";
import { useReads } from "./reads-context";
import { useVisible } from "./visibility-context";

/**
 * Reads `spec` with `args` (or nothing yet, with `skip`). Views using the same
 * read and arguments share one entry and one call. It fetches when it has no
 * value, after a change, after an own write or on `retry()`, and never while
 * hidden. A failed re-read keeps the last value. A read that failed is read
 * again only by `retry()`, by a change or write while it is shown, or when it
 * is shown after a change it missed (not because another view of it mounted).
 */
export function useRead<A, V>(
  spec: ReadSpec<A, V>,
  args: A | Skip,
): ReadState<V> {
  const reads = useReads("useRead");
  const visible = useVisible();
  const enabled = args !== skip && visible;
  // Properties are tracked: a view re-renders only for the ones it reads here.
  const queryKey = readKey(spec, args);
  const query = useQuery(
    {
      queryKey,
      queryFn: () => spec.call(args as A),
      enabled: (entry) => enabled && reads.mayRead(entry),
      meta: { visible: enabled },
    },
    reads.client,
  );
  const { failure } = useFailure(
    query,
    JSON.stringify(queryKey),
    args === skip ? "" : words(spec.failure, args),
  );
  const refetch = query.refetch;
  // Retry reads only what is read now: a leftover button (for a Ticket that has
  // closed, or a hidden view) must not call the read or touch the entry. It
  // resolves once a read made after it has answered (`Reads.reread`).
  const retry = useLatest(async () => {
    if (enabled) await reads.reread(queryKey, refetch);
  });
  // A skipped read is idle whatever its shared entry holds.
  const skipped = args === skip;
  return withCurrent(
    {
      value: skipped ? undefined : query.data,
      failure: skipped ? null : failure,
      retry,
      status: skipped
        ? "idle"
        : statusOf(query.data !== undefined, failure !== null, enabled),
    },
    // A failed re-read leaves the value as old as the change that asked for it,
    // though a read that waits for the next change is not "stale" to TanStack.
    () =>
      !skipped &&
      query.data !== undefined &&
      !query.isStale &&
      !query.isRefetchError,
  );
}
