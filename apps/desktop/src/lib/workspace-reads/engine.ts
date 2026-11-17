import {
  QueryClient,
  hashKey,
  isCancelledError,
  notifyManager,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import type { ChangeSignal } from "./change-signal";
import { fillsFor, type Fill, type Returned } from "./catalog";
// Declared reads fill from returned Tickets only once they are declared.
import "./reads";

// Views hear of an answer in the same turn it arrives. The default waits a
// timer tick, which a test with fake timers never gets, and which adds nothing
// here: the batch already collects every update of one turn.
notifyManager.setScheduler((callback) => queueMicrotask(callback));

/**
 * The cache and the rules for when it is read. Nothing reads on a timer, on
 * window focus or on reconnect. A read is read when it is first shown, and
 * again when the person presses Retry, when a change or an own write makes it
 * stale while it is visible, or when it is shown after such a change it missed.
 * A read that failed is not read again because another view of it mounted or
 * because it was shown again with no change since it failed.
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
   * Whether a visible view may read this entry on its own (mounting, or being
   * shown): false for an entry whose last read failed and that no change has
   * made stale since. It is the `enabled` of every read, next to visibility.
   */
  mayRead(query: { queryHash: string; state: { status: string } }): boolean;
  /**
   * Runs `start`, a read of the entry, and resolves once a read started at or
   * after this call has answered with a value or a failure. A read that `start`
   * began and an own write cancelled does not count: the re-read that follows
   * the write does. It also resolves when no view shows the entry any more
   * (unmounted, hidden or skipped), and never rejects.
   */
  reread(queryKey: QueryKey, start: () => unknown): Promise<void>;
  /**
   * Reads one more page of a paged read; see `usePagedRead`. `retrying` says the
   * last "Show more" failed, so the pages before it are as they were read.
   */
  showMore(queryKey: QueryKey, retrying?: boolean): void;
  /** Reads a page asked for earlier, if the read is current and visible. */
  resumeMore(queryKey: QueryKey): void;
  /**
   * A view of a paged read is mounted; pages are remembered for it only while
   * one is. The result says it is gone: with the last view, a page asked for
   * and not yet read is forgotten.
   */
  watchMore(queryKey: QueryKey): () => void;
  /** What is cached for the entry now, without reading it or observing it. */
  peek(queryKey: QueryKey): unknown;
  /** Fills reads from returned Tickets and fills as if just read, for tests. */
  prime(returned: Returned): void;
};

export function createReads(signal: ChangeSignal, moved: () => void): Reads {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // Fresh until a change says otherwise; hidden pages keep their data.
        staleTime: Infinity,
        gcTime: 60 * 60 * 1000,
        // Nothing retries on its own; the person presses Retry. A failed read
        // is read again on mount or when shown only after a change (`mayRead`).
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Every read is local; macOS may report no network while offline.
        networkMode: "always",
      },
    },
  });
  const cache = client.getQueryCache();

  // Counts the changes of the Workspace (a poll that saw a new token, an own
  // write, a replace). A read that failed at the current count has seen every
  // change there was, so only a later one is a reason to read it again.
  let epoch = 0;
  const failedAt = new Map<string, number>();
  // How many reads of an entry have answered, with a value or a failure.
  const answers = new Map<string, number>();

  // "Show more" pages the person asked for that must be read once the pages
  // before them are current. They are kept by query hash, never as a fetch in
  // flight: a fetch started before a change is dropped, and one started after
  // it is not the re-read of the pages it comes after.
  const wanted = new Set<string>();
  // The mounted views of each paged read (see `watchMore`): a page is remembered
  // only for a read that someone still shows.
  const watchers = new Map<string, number>();

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
  const lookup = (queryKey: QueryKey) => cache.get(hashKey(queryKey));

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
  cache.subscribe((event) => {
    const hash = event.query.queryHash;
    if (event.type === "removed") {
      wanted.delete(hash);
      failedAt.delete(hash);
      answers.delete(hash);
      return;
    }
    if (event.type !== "updated") return;
    const { query, action } = event;
    if (action.type === "error" && !isCancelledError(action.error)) {
      failedAt.set(hash, epoch);
      answers.set(hash, (answers.get(hash) ?? 0) + 1);
      // The pages before it could not be read, so the page cannot follow them.
      wanted.delete(hash);
    } else if (action.type === "success") {
      // A fill is a success too, but not an answer to a read.
      if (!action.manual) answers.set(hash, (answers.get(hash) ?? 0) + 1);
      if (wanted.size > 0) queueMicrotask(() => readWanted(query));
    }
  });

  // A page being added is dropped and remembered as wanted, because the pages
  // it was to follow are about to be re-read.
  const takeShowingMore = () => {
    for (const hash of watchers.keys()) {
      const query = cache.get(hash);
      if (!query || !isLoadingMore(query)) continue;
      wanted.add(hash);
      void query.cancel({ revert: true, silent: true });
    }
  };

  // A call cannot be aborted, but its answer can be dropped: cancelling reverts
  // the entry to what it held before the call and ignores the late answer. A
  // page being added is remembered, not just dropped (`takeShowingMore`).
  const supersede = () => {
    takeShowingMore();
    void client.cancelQueries(
      { predicate: (query) => query.state.fetchStatus === "fetching" },
      { revert: true, silent: true },
    );
  };

  const applyFills = (fills: readonly Fill[]) => {
    for (const fill of fills) {
      client.setQueryData(fill.key, (cached: unknown) => fill.apply(cached));
    }
  };

  // Marks everything stale and re-reads what is visible (active). A re-read that
  // started after the last `supersede` is reused rather than restarted. A page
  // that was being added is read once the loaded ones are back (`readWanted`).
  const makeStale = async () => {
    epoch += 1;
    await client.invalidateQueries(
      { refetchType: "active" },
      { cancelRefetch: false },
    );
  };

  // Whether a view shows the entry now: mounted, visible and not skipped. The
  // views say so in their options (`meta.visible`); `isActive` cannot, because
  // it is false for a read that failed and waits for a change (`mayRead`).
  const shown = (query: Query) =>
    query.observers.some((observer) => observer.options.meta?.visible === true);

  /** The entry has answered a read started after `before` and is not reading. */
  const answeredSince = (query: Query, before: number) =>
    (answers.get(query.queryHash) ?? 0) > before &&
    query.state.fetchStatus === "idle" &&
    !wanted.has(query.queryHash);

  return {
    client,
    prime(returned) {
      applyFills(fillsFor(returned));
    },
    peek(queryKey) {
      return client.getQueryData(queryKey);
    },
    mayRead(query) {
      return !(
        query.state.status === "error" &&
        (failedAt.get(query.queryHash) ?? -1) >= epoch
      );
    },
    changed() {
      supersede();
      void makeStale().catch(() => {});
      moved();
    },
    async reread(queryKey, start) {
      const query = lookup(queryKey);
      if (!query) return;
      const before = answers.get(query.queryHash) ?? 0;
      try {
        await start();
      } catch {
        // The read's failure shows in its state; what is waited for is an answer.
      }
      await new Promise<void>((resolve) => {
        let unsubscribe = () => {};
        const check = () => {
          if (
            !cache.get(query.queryHash) ||
            answeredSince(query, before) ||
            !shown(query)
          ) {
            unsubscribe();
            resolve();
          }
        };
        unsubscribe = cache.subscribe((event) => {
          if (event.query === query) check();
        });
        check();
      });
    },
    showMore(queryKey, retrying = false) {
      const query = lookup(queryKey);
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
      const query = lookup(queryKey);
      if (query) readWanted(query);
    },
    watchMore(queryKey) {
      const hash = hashKey(queryKey);
      watchers.set(hash, (watchers.get(hash) ?? 0) + 1);
      return () => {
        const left = (watchers.get(hash) ?? 1) - 1;
        if (left > 0) {
          watchers.set(hash, left);
        } else {
          watchers.delete(hash);
          wanted.delete(hash);
        }
      };
    },
    async wrote(returned) {
      // Reads sent before the write may not include it.
      supersede();
      applyFills(fillsFor(returned));
      // The poll must see the token this write produced as already seen.
      await signal.catchUp().catch(() => {});
      // A page asked for while the token was being read started after the
      // supersede above, so it was not dropped. It follows pages that are about
      // to be re-read, so it is dropped and remembered now, as before them.
      takeShowingMore();
      const settled = makeStale();
      moved();
      await settled.catch(() => {});
    },
    async replaced() {
      // The new Workspace's token counts as seen before anything is read
      // again, as for a write, so the poll starts no second wave.
      await signal.catchUp().catch(() => {});
      wanted.clear();
      epoch += 1;
      // Resetting drops every value (and the late answer of a call in flight)
      // and reads again what is visible.
      const settled = client.resetQueries();
      moved();
      await settled.catch(() => {});
    },
  };
}
