import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { readKey, skip, words, type PagedReadSpec, type Skip } from "./catalog";
import {
  statusOf,
  useFailure,
  useLatest,
  withCurrent,
  type ReadState,
} from "./read-state";
import { useReads } from "./reads-context";
import { useVisible } from "./visibility-context";

export type PagedState<V> = ReadState<V> & {
  /** Whether there is another page to show. */
  more: boolean;
  /** Reads one more page; ignored while one is loading. */
  showMore(): void;
  loadingMore: boolean;
  /** Whether `failure` is a failed `showMore()`, not a failed read or re-read. */
  failedMore: boolean;
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
  const { failure, more: failedMore } = useFailure(
    query,
    JSON.stringify(readKey(spec, args)),
    action,
    query.isFetchNextPageError,
  );
  const data = query.data;
  const value = useMemo(
    () => (data === undefined ? undefined : spec.join(data.pages)),
    [data, spec],
  );
  // The same key as a value that changes only when the read's identity does.
  const identity = JSON.stringify(readKey(spec, args));
  const queryKey = useMemo(() => JSON.parse(identity) as unknown[], [identity]);
  const refetch = query.refetch;
  const loadingMore = query.isFetchingNextPage;
  // The buttons may be from an earlier render, so they act on the latest one.
  // The engine reads the page when the pages before it are current, so a click
  // during a re-read is not lost; see `Reads.showMore`.
  const showMore = useLatest(() => {
    if (enabled) reads.showMore(queryKey);
  });
  // Retry repeats what failed: the page after a failed "Show more", the loaded
  // pages after a failed re-read.
  const retry = useLatest(async () => {
    if (!enabled) return;
    if (failedMore) reads.showMore(queryKey, true);
    else await refetch().catch(() => {});
  });
  // A page asked for while hidden is read when the view is shown again, and is
  // forgotten when the view goes away.
  useEffect(() => {
    if (enabled) reads.resumeMore(queryKey);
  }, [reads, enabled, queryKey]);
  useEffect(() => () => reads.dropMore(queryKey), [reads, queryKey]);
  return withCurrent(
    {
      value,
      failure,
      failedMore,
      retry,
      status: statusOf(value !== undefined, failure !== null, enabled),
      more: query.hasNextPage,
      showMore,
      loadingMore,
    },
    () => query.data !== undefined && !query.isStale,
  );
}
