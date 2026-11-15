import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
} from "react";
import {
  useChatClient,
  type ChatOverview,
  type ChatSnapshot,
  type ChatSummary,
  type LinkRef,
  type OpenRequest,
  type Retention,
} from "@/features/chats/client";
import { applyChange } from "@/features/chats/model";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import type { ChatRequest } from "@/features/chats/ticket-chat";

export type ChatFeature = {
  /** The Experimental switch; false until the host has answered. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
  overview: ChatOverview;
  /** Rises whenever any Chat's summary may have changed. */
  revision: number;
  /** The last clicked Chat notification; `n` rises with each click. */
  openRequest: { request: OpenRequest; n: number } | null;
  /** The last Chat asked for from a ticket; `n` rises with each request. */
  chatRequest: { request: ChatRequest; n: number } | null;
  /** Shows a Chat, or New Chat about a ticket, on the Chats screen. */
  requestChat: (request: ChatRequest) => void;
};

export const NO_CHAT_OVERVIEW: ChatOverview = {
  needs_you: 0,
  unread: 0,
  app_icon: 0,
  working: 0,
};

export const ChatFeatureContext = createContext<ChatFeature>({
  enabled: false,
  setEnabled: async () => {},
  overview: NO_CHAT_OVERVIEW,
  revision: 0,
  openRequest: null,
  chatRequest: null,
  requestChat: () => {},
});
export const useChatFeature = () => useContext(ChatFeatureContext);

/** The Chats of one scope, refetched when the host says a summary changed. */
export function useChatList(scope: Retention) {
  const client = useChatClient();
  const { revision } = useChatFeature();
  const [state, setState] = useState<{
    scope: Retention;
    chats: ChatSummary[];
    error: FailureDescription | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    client.listChats(scope).then(
      (chats) => current && setState({ scope, chats, error: null }),
      (reason: unknown) =>
        current &&
        setState({
          scope,
          chats: [],
          error: describeFailure(reason, "load Chats"),
        }),
    );
    return () => {
      current = false;
    };
  }, [client, scope, revision, attempt]);
  // Another scope's rows are never shown under this scope's title.
  const list = state?.scope === scope ? state : null;
  return list && { ...list, retry: () => setAttempt((count) => count + 1) };
}

/**
 * The Chats linked to one record, kept current: refetched whenever the host
 * says any summary changed. `retry` asks again after a failure.
 */
export function useLinkedChats(link: LinkRef | null) {
  const client = useChatClient();
  const { enabled, revision } = useChatFeature();
  const [attempt, setAttempt] = useState(0);
  const key = link ? `${link.kind}:${link.id}` : "";
  const [state, setState] = useState<{
    key: string;
    chats: ChatSummary[];
    error: FailureDescription | null;
  } | null>(null);
  // The link's Chats, read when the link changes (`key`).
  const linkedChats = useEffectEvent(() => link && client.linkedTo(link));
  useEffect(() => {
    if (!enabled) return;
    const asked = linkedChats();
    if (!asked) return;
    let current = true;
    asked.then(
      (chats) => current && setState({ key, chats, error: null }),
      (reason: unknown) =>
        current &&
        setState({
          key,
          chats: [],
          error: describeFailure(reason, "load Chats"),
        }),
    );
    return () => {
      current = false;
    };
  }, [client, enabled, key, revision, attempt]);
  return {
    list: state?.key === key ? state : null,
    retry: () => setAttempt((count) => count + 1),
  };
}

/**
 * One open Chat: a snapshot, then the ordered changes after it. A gap or a
 * resync marker reopens the Chat for a fresh snapshot rather than patching
 * over what was missed; the host stays the owner of the work throughout.
 */
export function useChat(id: string) {
  const client = useChatClient();
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState<FailureDescription | null>(null);
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
        setError(null);
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
      (reason: unknown) =>
        current && setError(describeFailure(reason, "open this Chat")),
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client, id, attempt]);
  return {
    snapshot: snapshot?.chat.id === id ? snapshot : null,
    error,
    retry: () => setAttempt((count) => count + 1),
  };
}
