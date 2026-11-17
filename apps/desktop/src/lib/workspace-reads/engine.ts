import {
  QueryClient,
  notifyManager,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import type { ChangeSignal } from "./change-signal";
import { seedsFor, type Returned } from "./catalog";
// Declared reads fill from returned Tickets only once they are declared.
import "./reads";

// Views hear of an answer in the same turn it arrives. The default waits a
// timer tick, which a test with fake timers never gets, and which adds nothing
// here: the batch already collects every update of one turn.
notifyManager.setScheduler((callback) => queueMicrotask(callback));

/**
 * The cache and the rules for when it goes stale. A read is stale only after the
 * change signal moved or after an own write; it never refetches on its own.
 */
export type Reads = {
  readonly client: QueryClient;
  /** The Workspace changed behind our back: make every visible read stale. */
  changed(): void;
  /** The desktop's own write succeeded; see `useWrote`. */
  wrote(returned?: Returned): Promise<void>;
  /** The whole Workspace was replaced; see `useReplaced`. */
  replaced(): Promise<void>;
  /**
   * Reads one more page of a paged read; see `usePagedRead`. `retrying` says the
   * last "Show more" failed, so the pages before it are as they were read.
   */
  showMore(queryKey: QueryKey, retrying?: boolean): void;
  /** Reads a page asked for earlier, if the read is current and visible. */
  resumeMore(queryKey: QueryKey): void;
  /** Forgets a page asked for earlier (its view is gone). */
  dropMore(queryKey: QueryKey): void;
  /** Fills reads from returned Tickets as if they had just been read, for tests. */
  prime(returned: Returned): void;
};

export function createReads(signal: ChangeSignal, moved: () => void): Reads {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // Fresh until a change says otherwise; hidden pages keep their data.
        staleTime: Infinity,
        gcTime: 60 * 60 * 1000,
        // Nothing retries on its own; the person presses Retry.
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Every read is local; macOS may report no network while offline.
        networkMode: "always",
      },
    },
  });

  // "Show more" pages the person asked for that must be read once the pages
  // before them are current. They are kept by query hash, never as a fetch in
  // flight: a fetch started before a change is dropped, and one started after
  // it is not the re-read of the pages it comes after.
  const wanted = new Set<string>();

  type Pages = { pages: unknown[]; pageParams: unknown[] };
  type Paged = {
    getNextPageParam?: (
      last: unknown,
      pages: unknown[],
      lastParam: unknown,
      params: unknown[],
    ) => unknown;
  };
  const hasNextPage = (query: Query) => {
    const data = query.state.data as Pages | undefined;
    if (!data || data.pages.length === 0) return false;
    const next = (query.options as Paged).getNextPageParam?.(
      data.pages.at(-1),
      data.pages,
      data.pageParams.at(-1),
      data.pageParams,
    );
    return next !== undefined && next !== null;
  };
  const isLoadingMore = (query: Query) =>
    query.state.fetchStatus === "fetching" &&
    query.state.fetchMeta?.fetchMore?.direction === "forward";
  const loadNextPage = (query: Query) =>
    void query
      .fetch(undefined, { meta: { fetchMore: { direction: "forward" } } })
      .catch(() => {});

  // Reads a wanted page once its query is idle, visible and current.
  const readWanted = (query: Query) => {
    if (!wanted.has(query.queryHash)) return;
    if (
      query.state.fetchStatus !== "idle" ||
      query.state.isInvalidated ||
      !query.isActive()
    )
      return;
    wanted.delete(query.queryHash);
    if (hasNextPage(query)) loadNextPage(query);
  };
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const { query } = event;
    if (event.action.type === "error") {
      // The pages before it could not be read, so the page cannot follow them.
      wanted.delete(query.queryHash);
    } else if (event.action.type === "success") {
      queueMicrotask(() => readWanted(query));
    }
  });

  // A "Show more" call in flight is dropped and remembered as wanted, because
  // the pages it was to follow are about to be re-read.
  const takeShowingMore = () => {
    for (const query of client.getQueryCache().findAll()) {
      if (!isLoadingMore(query)) continue;
      wanted.add(query.queryHash);
      void client.cancelQueries(
        { queryKey: query.queryKey, exact: true },
        { revert: true, silent: true },
      );
    }
  };

  // A call cannot be aborted, but its answer can be dropped: cancelling reverts
  // the entry to what it held before the call and ignores the late answer.
  const supersede = () => {
    takeShowingMore();
    void client.cancelQueries(
      { predicate: (query) => query.state.fetchStatus === "fetching" },
      { revert: true, silent: true },
    );
  };

  // Marks everything stale and re-reads what is visible (active). A re-read that
  // started after the last `supersede` is reused rather than restarted. A page
  // that was being added is read once the loaded ones are back (`readWanted`).
  const makeStale = async () => {
    takeShowingMore();
    await client.invalidateQueries(
      { refetchType: "active" },
      { cancelRefetch: false },
    );
  };

  return {
    client,
    prime(returned) {
      for (const seed of seedsFor(returned)) {
        client.setQueryData(seed.key, seed.value);
      }
    },
    changed() {
      supersede();
      void makeStale().catch(() => {});
      moved();
    },
    showMore(queryKey, retrying = false) {
      const query = client.getQueryCache().find({ queryKey, exact: true });
      if (!query || !hasNextPage(query) || isLoadingMore(query)) return;
      if (query.state.fetchStatus === "fetching") {
        // A re-read is under way: the page follows it.
        wanted.add(query.queryHash);
      } else if (query.state.isInvalidated && !retrying) {
        // The pages shown may be older than the last change (a re-read failed
        // or is waiting for the view to be shown; a failure also counts):
        // re-read them, then the page.
        wanted.add(query.queryHash);
        void query.fetch().catch(() => {});
      } else {
        loadNextPage(query);
      }
    },
    resumeMore(queryKey) {
      const query = client.getQueryCache().find({ queryKey, exact: true });
      if (query) readWanted(query);
    },
    dropMore(queryKey) {
      const query = client.getQueryCache().find({ queryKey, exact: true });
      if (query) wanted.delete(query.queryHash);
    },
    async wrote(returned) {
      // Reads sent before the write may not include it.
      supersede();
      for (const seed of seedsFor(returned)) {
        client.setQueryData(seed.key, seed.value);
      }
      // The poll must see the token this write produced as already seen.
      await signal.catchUp().catch(() => {});
      const settled = makeStale();
      moved();
      await settled.catch(() => {});
    },
    async replaced() {
      // The new Workspace's token counts as seen before anything is read
      // again, as for a write, so the poll starts no second wave.
      await signal.catchUp().catch(() => {});
      wanted.clear();
      // Resetting drops every value (and the late answer of a call in flight)
      // and reads again what is visible.
      const settled = client.resetQueries();
      moved();
      await settled.catch(() => {});
    },
  };
}
