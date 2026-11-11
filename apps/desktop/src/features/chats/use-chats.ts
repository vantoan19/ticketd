import { createContext, useContext, useEffect, useState } from "react";
import {
  useChatClient,
  type ChatOverview,
  type ChatSnapshot,
  type ChatSummary,
  type Retention,
} from "@/features/chats/client";
import { applyChange } from "@/features/chats/model";

export type ChatFeature = {
  /** The Experimental switch; false until the host has answered. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
  overview: ChatOverview;
  /** Rises whenever any Chat's summary may have changed. */
  revision: number;
};

export const ChatFeatureContext = createContext<ChatFeature>({
  enabled: false,
  setEnabled: async () => {},
  overview: { needs_you: 0, working: 0 },
  revision: 0,
});
export const useChatFeature = () => useContext(ChatFeatureContext);

/** The Chats of one scope, refetched when the host says a summary changed. */
export function useChatList(scope: Retention) {
  const client = useChatClient();
  const { revision } = useChatFeature();
  const [state, setState] = useState<{
    scope: Retention;
    chats: ChatSummary[];
    error: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    client.listChats(scope).then(
      (chats) => current && setState({ scope, chats, error: "" }),
      (reason: unknown) =>
        current && setState({ scope, chats: [], error: String(reason) }),
    );
    return () => {
      current = false;
    };
  }, [client, scope, revision]);
  // Another scope's rows are never shown under this scope's title.
  return state?.scope === scope ? state : null;
}

/**
 * One open Chat: a snapshot, then the ordered changes after it. A gap or a
 * resync marker reopens the Chat for a fresh snapshot rather than patching
 * over what was missed; the host stays the owner of the work throughout.
 */
export function useChat(id: string) {
  const client = useChatClient();
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState("");
  // Bumped to open the Chat again after a resync.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    let unsubscribe = () => {};
    client.openChat(id).then(
      (opened) => {
        if (!current) return;
        let latest = opened;
        setSnapshot(opened);
        setError("");
        unsubscribe = client.subscribe(id, opened.cursor, (change) => {
          if (!current) return;
          const next = applyChange(latest, change);
          if (next === "resync") {
            current = false;
            unsubscribe();
            setAttempt((count) => count + 1);
            return;
          }
          latest = next;
          setSnapshot(next);
        });
      },
      (reason: unknown) => current && setError(String(reason)),
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client, id, attempt]);
  return { snapshot: snapshot?.chat.id === id ? snapshot : null, error };
}
