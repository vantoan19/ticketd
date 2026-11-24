import { useSyncExternalStore } from "react";
import { useChatClient, type ChatClient, type HarnessInfo } from "./client";

const EMPTY: readonly HarnessInfo[] = [];
const stores = new WeakMap<ChatClient, ReturnType<typeof catalogStore>>();

type CatalogSnapshot = { entries: readonly HarnessInfo[] } & (
  | { status: "idle" | "loading" | "ready" }
  | { status: "failed"; error: unknown }
);

function catalogStore(client: ChatClient) {
  let snapshot: CatalogSnapshot = { entries: EMPTY, status: "idle" };
  const listeners = new Set<() => void>();
  function publish(next: CatalogSnapshot) {
    snapshot = next;
    listeners.forEach((notify) => notify());
  }
  async function load() {
    if (snapshot.status !== "idle" && snapshot.status !== "failed") return;
    publish({ entries: EMPTY, status: "loading" });
    let entries: HarnessInfo[];
    try {
      entries = await client.harnessCatalog();
    } catch (error) {
      publish({ entries: EMPTY, status: "failed", error });
      return;
    }
    publish({ entries, status: "ready" });
  }
  return {
    getSnapshot: () => snapshot,
    getEntries: () => snapshot.entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (snapshot.status === "idle") void load();
      return () => listeners.delete(listener);
    },
    retry: () => void load(),
  };
}

function useCatalogStore() {
  const client = useChatClient();
  let store = stores.get(client);
  if (!store) {
    store = catalogStore(client);
    stores.set(client, store);
  }
  return store;
}

export function useHarnessCatalog(): readonly HarnessInfo[] {
  const store = useCatalogStore();
  return useSyncExternalStore(store.subscribe, store.getEntries);
}

export function useHarnessCatalogState() {
  const store = useCatalogStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...snapshot, retry: store.retry };
}
