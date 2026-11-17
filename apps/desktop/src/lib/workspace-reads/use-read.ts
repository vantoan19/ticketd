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
 * hidden. A failed re-read keeps the last value.
 */
export function useRead<A, V>(
  spec: ReadSpec<A, V>,
  args: A | Skip,
): ReadState<V> {
  const reads = useReads("useRead");
  const visible = useVisible();
  const enabled = args !== skip && visible;
  // Properties are tracked: a view re-renders only for the ones it reads here.
  const query = useQuery(
    {
      queryKey: readKey(spec, args),
      queryFn: () => spec.call(args as A),
      enabled,
    },
    reads.client,
  );
  const { failure } = useFailure(
    query,
    JSON.stringify(readKey(spec, args)),
    args === skip ? "" : words(spec.failure, args),
  );
  const refetch = query.refetch;
  // Retry reads only what is read now: a leftover button (for a Ticket that has
  // closed, or a hidden view) must not call the read or touch the entry.
  const retry = useLatest(async () => {
    if (enabled) await refetch().catch(() => {});
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
    () => !skipped && query.data !== undefined && !query.isStale,
  );
}
