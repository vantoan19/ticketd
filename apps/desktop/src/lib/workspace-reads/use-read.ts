import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { readKey, skip, words, type ReadSpec, type Skip } from "./catalog";
import { statusOf, useFailure, type ReadState } from "./read-state";
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
  const failure = useFailure(
    query.error,
    args === skip ? "" : words(spec.failure, args),
  );
  const refetch = query.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);
  return {
    value: query.data,
    failure,
    retry,
    status: statusOf(query.data !== undefined, query.error !== null, enabled),
    get current() {
      return query.data !== undefined && !query.isStale;
    },
  };
}
