import { useCallback, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { readKey, skip, words, type PagedReadSpec, type Skip } from "./catalog";
import { statusOf, useFailure, type ReadState } from "./read-state";
import { useReads } from "./reads-context";
import { useVisible } from "./visibility-context";

export type PagedState<V> = ReadState<V> & {
  /** Whether there is another page to show. */
  more: boolean;
  /** Reads one more page; ignored while one is loading. */
  showMore(): void;
  loadingMore: boolean;
};

/**
 * A read in pages. `showMore()` reads one more page. A change re-reads every
 * page loaded so far, in order, and never collapses what the person expanded.
 * Failure and visibility work as for `useRead`; a failed `showMore()` keeps the
 * loaded pages and words its failure with the read's `more` action.
 */
export function usePagedRead<A, V, P>(
  spec: PagedReadSpec<A, V, P>,
  args: A | Skip,
): PagedState<V> {
  const reads = useReads("usePagedRead");
  const visible = useVisible();
  const enabled = args !== skip && visible;
  const query = useInfiniteQuery(
    {
      queryKey: readKey(spec, args),
      queryFn: ({ pageParam }) => spec.call(args as A, pageParam),
      initialPageParam: 0,
      getNextPageParam: (last, all) => spec.next(last, all) ?? undefined,
      enabled,
    },
    reads.client,
  );
  const action =
    args === skip
      ? ""
      : words(query.isFetchNextPageError ? spec.more : spec.failure, args);
  const failure = useFailure(
    query,
    JSON.stringify(readKey(spec, args)),
    action,
  );
  const data = query.data;
  const value = useMemo(
    () => (data === undefined ? undefined : spec.join(data.pages)),
    [data, spec],
  );
  const refetch = query.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);
  const fetchNextPage = query.fetchNextPage;
  const loadingMore = query.isFetchingNextPage;
  const showMore = useCallback(() => {
    if (!loadingMore) void fetchNextPage({ cancelRefetch: false });
  }, [fetchNextPage, loadingMore]);
  return {
    value,
    failure,
    retry,
    status: statusOf(value !== undefined, failure !== null, enabled),
    get current() {
      return query.data !== undefined && !query.isStale;
    },
    more: query.hasNextPage,
    showMore,
    loadingMore,
  };
}
