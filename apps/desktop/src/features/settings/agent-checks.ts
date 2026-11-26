import { useEffect, useState, useSyncExternalStore } from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  useChatClient,
  type ChatClient,
  type HarnessInstallation,
  type HarnessStatus,
} from "@/features/chats/client";

/**
 * What the agents' sign-in checks last found. `harnesses` keeps the last
 * answer while the next one is read, so a row never blinks back to a skeleton.
 */
export type AgentChecks =
  | { phase: "idle"; harnesses: readonly HarnessStatus[] }
  | { phase: "loading"; harnesses: readonly HarnessStatus[] }
  | { phase: "done"; harnesses: readonly HarnessStatus[] }
  | {
      phase: "failed";
      failure: FailureDescription;
      harnesses: readonly HarnessStatus[];
    };

const NONE: readonly HarnessStatus[] = [];

/**
 * The one place the agents' sign-in checks run. Checking starts the agents'
 * own programs, so only a caller that knows Chats are on may call `refresh`.
 * The Agents page, an opened agent and the sidebar's setup dot all read it,
 * so one check answers all three.
 */
function checksStore(client: ChatClient) {
  let snapshot: AgentChecks = { phase: "idle", harnesses: NONE };
  let round = 0;
  let reading: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: AgentChecks) => {
    snapshot = next;
    listeners.forEach((notify) => notify());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * Checks every agent again. Asked while a check is already running (the
     * sidebar and the page both ask as Settings opens), it joins that check:
     * starting an agent's own program twice at once answers nothing new.
     */
    refresh(): Promise<void> {
      if (reading) return reading;
      const mine = ++round;
      publish({ phase: "loading", harnesses: snapshot.harnesses });
      const read: Promise<void> = client
        .harnesses()
        .then(
          (harnesses) => {
            if (mine === round) publish({ phase: "done", harnesses });
          },
          (reason: unknown) => {
            if (mine !== round) return;
            publish({
              phase: "failed",
              failure: describeFailure(reason, "check the agents"),
              harnesses: snapshot.harnesses,
            });
          },
        )
        .finally(() => {
          if (reading === read) reading = null;
        });
      reading = read;
      return read;
    },
    /** Forgets the answer, as when Chats are turned off. */
    reset() {
      round++;
      reading = null;
      if (snapshot.phase !== "idle")
        publish({ phase: "idle", harnesses: NONE });
    },
  };
}

const stores = new WeakMap<ChatClient, ReturnType<typeof checksStore>>();

export function agentChecksStore(client: ChatClient) {
  let store = stores.get(client);
  if (!store) {
    store = checksStore(client);
    stores.set(client, store);
  }
  return store;
}

/**
 * The agents' sign-in checks, while `active` (Chats are on). Inactive, nothing
 * is checked at all: no first read and no read when the window regains focus.
 * Active, they are read when the page shows (`readOnShow`, unless an answer
 * is already here to show) and again whenever the window regains focus, as a
 * person fixes a sign-in in a terminal and comes back.
 */
export function useAgentChecks({
  active,
  readOnShow = true,
}: {
  active: boolean;
  readOnShow?: boolean;
}) {
  const client = useChatClient();
  const store = agentChecksStore(client);
  const checks = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (!active) {
      store.reset();
      return;
    }
    if (readOnShow || store.getSnapshot().phase === "idle")
      void store.refresh();
    const onFocus = () => void store.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, readOnShow, store]);
  return { checks, checkAgain: () => void store.refresh() };
}

/** What is installed, read without any sign-in check. */
export type InstalledAgents =
  | { phase: "loading" }
  | { phase: "failed"; failure: FailureDescription }
  | { phase: "done"; agents: readonly HarnessInstallation[] };

/**
 * The agents found on this computer with their versions, for the page while
 * Chats are off. It only asks each program its version, never its sign-in, and
 * reads again when the window regains focus (a person installs one, comes back).
 */
export function useInstalledAgents({ active }: { active: boolean }) {
  const client = useChatClient();
  const [found, setFound] = useState<InstalledAgents>({ phase: "loading" });
  useEffect(() => {
    if (!active) return;
    let current = true;
    const read = () =>
      client.installedHarnesses().then(
        (agents) => current && setFound({ phase: "done", agents }),
        (reason: unknown) =>
          current &&
          setFound({
            phase: "failed",
            failure: describeFailure(reason, "look for the agents"),
          }),
      );
    void read();
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [active, client]);
  return found;
}
