import { useSyncExternalStore } from "react";
import { useChatClient, type ChatClient, type HarnessInfo } from "./client";

const EMPTY: readonly HarnessInfo[] = [];
const stores = new WeakMap<ChatClient, ReturnType<typeof catalogStore>>();

function catalogStore(client: ChatClient) {
  let entries = EMPTY;
  let requested = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!requested) {
        requested = true;
        void client.harnessCatalog().then(
          (catalog) => {
            entries = catalog;
            listeners.forEach((notify) => notify());
          },
          () => {
            requested = false;
          },
        );
      }
      return () => listeners.delete(listener);
    },
  };
}

export function useHarnessCatalog(): readonly HarnessInfo[] {
  const client = useChatClient();
  let store = stores.get(client);
  if (!store) {
    store = catalogStore(client);
    stores.set(client, store);
  }
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
