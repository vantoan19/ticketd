import { historyClient } from "@/lib/api/history";
import { InboxAttentionContext, type Attention } from "./use-inbox-attention";
import { useEffect, useState, type ReactNode } from "react";
import { inboxClient, type Entry } from "@/lib/api/inbox";
import { client } from "@/lib/api/client";
import { useChatClient } from "@/features/chats/client";
import { useChatFeature } from "@/features/chats/use-chats";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { useNow } from "@/lib/use-now";
import { describeFailure } from "@/lib/api/describe-failure";
import { approvalChats, needsYou } from "./inboxModel";

/** One shared projection for the list and sidebar; all inputs remain host-owned. */
export function InboxAttentionProvider({
  children,
  revision = 0,
}: {
  children: ReactNode;
  revision?: number;
}) {
  const change = useWorkspaceChange();
  const chat = useChatFeature();
  const chats = useChatClient();
  const now = useNow();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<Attention, "needsCount" | "reload">>({
    entries: [],
    approvals: [],
    statuses: new Map(),
    reminders: new Map(),
    latestStatusChanges: new Map(),
    loading: true,
    error: null,
  });
  useEffect(() => {
    let active = true;
    async function load() {
      const entries: Entry[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await inboxClient.list({
          offset,
          limit: 100,
          unreadOnly: false,
        });
        entries.push(...page);
        if (page.length < 100) break;
      }
      const reviewRefs = [
        ...new Set(
          entries
            .filter(
              (e) =>
                e.kind === "status" &&
                e.to_value === "In review" &&
                e.editing_agent !== null &&
                e.editing_agent !== "local-person",
            )
            .map((e) => e.reference),
        ),
      ];
      const reminderRefs = [
        ...new Set(
          entries.filter((e) => e.kind === "reminder").map((e) => e.reference),
        ),
      ];
      const [statuses, reminders, summaries, histories] = await Promise.all([
        Promise.all(
          reviewRefs.map(
            async (reference) =>
              [reference, (await client.showTicket(reference)).status] as const,
          ),
        ),
        Promise.all(
          reminderRefs.map(
            async (reference) =>
              [reference, await inboxClient.reminder(reference)] as const,
          ),
        ),
        chat.enabled ? chats.listChats("active") : Promise.resolve([]),
        Promise.all(
          reviewRefs.map(
            async (reference) =>
              [
                reference,
                (await historyClient.list(reference))
                  .filter((entry) => entry.kind === "status")
                  .at(-1),
              ] as const,
          ),
        ),
      ]);
      if (active)
        setState({
          entries,
          statuses: new Map(statuses),
          latestStatusChanges: new Map(
            histories.flatMap(([reference, entry]) =>
              entry ? [[reference, entry] as const] : [],
            ),
          ),
          reminders: new Map(reminders),
          approvals: approvalChats(summaries),
          loading: false,
          error: null,
        });
    }
    void load().catch((reason: unknown) => {
      if (active)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: describeFailure(reason, "load the Inbox"),
        }));
    });
    return () => {
      active = false;
    };
  }, [change, revision, attempt, chat.enabled, chat.revision, chats]);
  const needsCount =
    state.approvals.length +
    state.entries.filter((entry) => needsYou(entry, state, new Date(now)))
      .length;
  return (
    <InboxAttentionContext
      value={{
        ...state,
        needsCount,
        reload: () => setAttempt((value) => value + 1),
      }}
    >
      {children}
    </InboxAttentionContext>
  );
}
