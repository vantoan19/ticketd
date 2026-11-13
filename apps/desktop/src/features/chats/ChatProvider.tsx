import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  useChatClient,
  type ChatOverview,
  type OpenRequest,
} from "@/features/chats/client";
import {
  ChatFeatureContext,
  NO_CHAT_OVERVIEW,
} from "@/features/chats/use-chats";
import { usePreferences } from "@/lib/preferences";
import "@/features/chats/chats.css";
import "@/features/chats/ticket-chats.css";

/**
 * Holds what every screen needs to know about Chat: whether it is on, how
 * many Chats need the person, and the confirmation shown when Quit would stop
 * working Chats. Counts come from the host's own events, not the workspace poll.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const client = useChatClient();
  const [enabled, setEnabledState] = useState(false);
  const [overview, setOverview] = useState<ChatOverview>(NO_CHAT_OVERVIEW);
  const [revision, setRevision] = useState(0);
  const [openRequest, setOpenRequest] = useState<{
    request: OpenRequest;
    n: number;
  } | null>(null);
  const { notifyChats } = usePreferences();
  const [quitting, setQuitting] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    client.getEnabled().then(
      (value) => current && setEnabledState(value),
      () => {},
    );
    const stopQuit = client.onQuitRequested((working) => {
      // Nothing is working: there is nothing to confirm.
      if (working === 0) void client.answerQuit(true);
      else setQuitting(working);
    });
    return () => {
      current = false;
      stopQuit();
    };
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const apply = (next: ChatOverview) => {
      if (!current) return;
      setOverview(next);
      setRevision((count) => count + 1);
    };
    client.overview().then(apply, () => {});
    const stop = client.subscribeOverview(apply);
    const stopOpen = client.onOpenRequested(
      (request) =>
        current &&
        setOpenRequest((last) => ({ request, n: (last?.n ?? 0) + 1 })),
    );
    return () => {
      current = false;
      stop();
      stopOpen();
    };
  }, [client, enabled]);

  // The backend starts with notifications on; it is told the person's choice.
  useEffect(() => {
    if (enabled) void client.setNotify(notifyChats).catch(() => {});
  }, [client, enabled, notifyChats]);

  const feature = useMemo(
    () => ({
      enabled,
      overview: enabled ? overview : NO_CHAT_OVERVIEW,
      revision,
      openRequest,
      setEnabled: async (value: boolean) => {
        try {
          await client.setEnabled(value);
          setEnabledState(value);
        } catch (reason) {
          // A refusal can still have changed the switch, such as Chat turned off
          // with a harness that would not confirm it stopped. Show what holds now.
          await client.getEnabled().then(setEnabledState, () => {});
          throw reason;
        }
      },
    }),
    [client, enabled, overview, revision, openRequest],
  );
  const answerQuit = (quit: boolean) => {
    setQuitting(null);
    void client.answerQuit(quit).catch(() => {});
  };
  return (
    <ChatFeatureContext value={feature}>
      {children}
      <DialogShell
        open={quitting !== null}
        onOpenChange={(open) => {
          if (!open) answerQuit(false);
        }}
        title="Quit ticketd?"
        primaryLabel="Quit"
        primaryVariant="destructive"
        blockedReason={null}
        onSubmit={() => answerQuit(true)}
      >
        <p className="chat-dialog-text">
          {quitting === 1
            ? "1 Chat is still working. Quitting stops it."
            : `${quitting} Chats are still working. Quitting stops them.`}{" "}
          Closing the window instead keeps {quitting === 1 ? "it" : "them"}{" "}
          running.
        </p>
        <p className="chat-fine">
          History and queued messages are kept. Nothing restarts by itself next
          time.
        </p>
      </DialogShell>
    </ChatFeatureContext>
  );
}
