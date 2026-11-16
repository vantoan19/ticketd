import { QueryClient, notifyManager } from "@tanstack/react-query";
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
        retryOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Every read is local; macOS may report no network while offline.
        networkMode: "always",
      },
    },
  });

  // A call cannot be aborted, but its answer can be dropped: cancelling reverts
  // the entry to what it held before the call and ignores the late answer.
  const supersede = () =>
    client.cancelQueries(
      { predicate: (query) => query.state.fetchStatus === "fetching" },
      { revert: true, silent: true },
    );

  // Marks everything stale and re-reads what is visible (active). Reads that
  // started after the last `supersede` are reused rather than restarted.
  const makeStale = () =>
    client.invalidateQueries(
      { refetchType: "active" },
      { cancelRefetch: false },
    );

  return {
    client,
    prime(returned) {
      for (const seed of seedsFor(returned)) {
        client.setQueryData(seed.key, seed.value);
      }
    },
    changed() {
      void supersede();
      void makeStale();
      moved();
    },
    async wrote(returned) {
      // Reads sent before the write may not include it.
      void supersede();
      for (const seed of seedsFor(returned)) {
        client.setQueryData(seed.key, seed.value);
      }
      // The poll must see the token this write produced as already seen.
      await signal.catchUp().catch(() => {});
      const settled = makeStale();
      moved();
      await settled.catch(() => {});
    },
  };
}
