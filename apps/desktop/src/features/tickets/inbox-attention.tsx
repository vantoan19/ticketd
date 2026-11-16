import { attachments } from "@/lib/api/attachments";
import {
  readReviewRestorations,
  hasReviewRestorations,
  writeReviewRestorations,
  restorationFor,
} from "./inbox-review-restoration";
import { historyClient } from "@/lib/api/history";
import { InboxAttentionContext, type Attention } from "./use-inbox-attention";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { inboxClient, type Entry } from "@/lib/api/inbox";
import { client } from "@/lib/api/client";
import { useChatClient } from "@/features/chats/client";
import { useChatFeature } from "@/features/chats/use-chats";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { useNow } from "@/lib/use-now";
import { describeFailure } from "@/lib/api/describe-failure";
import { approvalChats, needsYou, sameTransition } from "./inboxModel";

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
    chats: [],
    statuses: new Map(),
    reminders: new Map(),
    latestStatusChanges: new Map(),
    loading: true,
    error: null,
  });
  const loadLatest = useRef<
    (() => Promise<Omit<Attention, "needsCount" | "reload">>) | null
  >(null);
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
      const workspaceId = hasReviewRestorations()
        ? await attachments.workspaceId()
        : null;
      const saved = workspaceId ? readReviewRestorations(workspaceId) : [];
      const current = saved.filter((restored) => {
        const entry = entries.find(
          (entry) =>
            entry.id === restored.id &&
            entry.reference === restored.reference &&
            entry.timestamp === restored.originalTimestamp &&
            entry.editing_agent === restored.originalAgent,
        );
        const latest = histories.find(
          ([reference]) => reference === restored.reference,
        )?.[1];
        return (
          !!entry &&
          !!latest &&
          sameTransition(latest, restored.transition) &&
          statuses.some(
            ([reference, status]) =>
              reference === restored.reference && status === "In review",
          )
        );
      });
      if (workspaceId && current.length !== saved.length)
        writeReviewRestorations(workspaceId, current);
      const next = {
        entries,
        restoredReviews: new Map(
          current.map((restored) => [restored.id, restored.transition]),
        ),
        statuses: new Map(statuses),
        latestStatusChanges: new Map(
          histories.flatMap(([reference, entry]) =>
            entry ? [[reference, entry] as const] : [],
          ),
        ),
        reminders: new Map(reminders),
        approvals: approvalChats(summaries),
        chats: summaries,
        loading: false,
        error: null,
      };
      if (active) setState(next);
      return next;
    }
    loadLatest.current = load;
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
        readLatest: async () => {
          const latest = await loadLatest.current?.();
          const fresh = latest ?? state;
          return {
            ...fresh,
            needsCount:
              fresh.approvals.length +
              fresh.entries.filter((entry) =>
                needsYou(entry, fresh, new Date()),
              ).length,
            reload: () => setAttempt((value) => value + 1),
          };
        },
        restoreReview: async (entry) => {
          const latest = (await historyClient.list(entry.reference))
            .filter((item) => item.kind === "status")
            .at(-1);
          if (!latest || latest.to_value !== "In review")
            throw new Error(
              "The Ticket changed again. Reload the Inbox before retrying Undo.",
            );
          const workspaceId = await attachments.workspaceId();
          const saved = readReviewRestorations(workspaceId).filter(
            (item) => item.id !== entry.id,
          );
          writeReviewRestorations(workspaceId, [
            ...saved,
            restorationFor(entry, latest),
          ]);
          setAttempt((value) => value + 1);
        },
      }}
    >
      {children}
    </InboxAttentionContext>
  );
}
