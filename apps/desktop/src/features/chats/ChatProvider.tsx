import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  useChatClient,
  type ChatOverview,
  type OpenRequest,
  type Stopping,
} from "@/features/chats/client";
import { stoppingText } from "@/features/chats/model";
import {
  ChatFeatureContext,
  NO_CHAT_OVERVIEW,
} from "@/features/chats/use-chats";
import { SelectionAddToChat } from "@/features/chats/SelectionAddToChat";
import type { ChatRequest } from "@/features/chats/ticket-chat";
import { usePreferences } from "@/lib/preferences";
import "@/features/chats/chats.css";
import "@/features/chats/ticket-chats.css";

function quitText({ chats, runs }: Stopping) {
  const { subject, one } = stoppingText(chats, runs);
  const them = one ? "it" : "them";
  return `${subject} still working. Quitting stops ${them}. Closing the window instead keeps ${them} running.`;
}

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
  const [chatRequest, setChatRequest] = useState<{
    request: ChatRequest;
    n: number;
  } | null>(null);
  // Turning Chat off drops its requests: the Chats screen, mounted again when
  // Chat comes back, must not replay them.
  if (!enabled && (openRequest || chatRequest)) {
    setOpenRequest(null);
    setChatRequest(null);
  }
  const { notifyChats } = usePreferences();
  const [quitting, setQuitting] = useState<Stopping | null>(null);

  useEffect(() => {
    let current = true;
    client.getEnabled().then(
      (value) => current && setEnabledState(value),
      () => {},
    );
    const stopQuit = client.onQuitRequested((stopping) => {
      // Nothing is working: there is nothing to confirm.
      if (stopping.chats + stopping.runs === 0) void client.answerQuit(true);
      else setQuitting(stopping);
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
      chatRequest,
      requestChat: (request: ChatRequest) =>
        setChatRequest((last) => ({ request, n: (last?.n ?? 0) + 1 })),
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
    [client, enabled, overview, revision, openRequest, chatRequest],
  );
  const answerQuit = (quit: boolean) => {
    setQuitting(null);
    void client.answerQuit(quit).catch(() => {});
  };
  return (
    <ChatFeatureContext value={feature}>
      {children}
      <SelectionAddToChat />
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
        {quitting && <p className="chat-dialog-text">{quitText(quitting)}</p>}
        <p className="chat-fine">
          History and queued messages are kept. Nothing restarts by itself next
          time.
        </p>
      </DialogShell>
    </ChatFeatureContext>
  );
}
