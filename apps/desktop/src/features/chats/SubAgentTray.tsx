import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { useChatClient, type TranscriptItem } from "@/features/chats/client";
import { ActivityDock } from "@/features/chats/ActivityDock";
import { DockSlot } from "@/features/chats/DockSlot";
import { draftOf } from "@/features/chats/drafts";
import { type PendingRequest } from "@/features/chats/model";
import { SubAgentControl } from "@/features/chats/SubAgentView";
import type { SubAgentViewData } from "@/features/chats/sub-agents";

const none = () => {};

/**
 * A sub-agent's tray: only what there is to act on. Its own pending request
 * (the card, with its name as plain text), a line when another agent needs the
 * person ("Check limiter test coverage needs you · Review"), and the control
 * row with Stop where the harness can stop it alone. With none of them, none.
 */
export function SubAgentTray({
  view,
  items,
  onStop,
  onReview,
  onLeave,
}: {
  view: SubAgentViewData;
  /** Every item of the Chat. */
  items: TranscriptItem[];
  onStop: () => void;
  /** Goes to the agent that needs the person: a sub-agent's id, or null for the main agent (the Chat). */
  onReview: (agent: string | null) => void;
  /** After an answer: the view takes the keyboard back. */
  onLeave: () => void;
}) {
  const client = useChatClient();
  const { agent, chat } = view;
  const drafts = draftOf(client, chat.id).questions;
  const answerDrafts = useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const pending = items.filter(
    (item): item is PendingRequest =>
      item.kind === "request" && item.state === "pending",
  );
  const own = pending.filter((request) => request.owner === agent.id);
  const other = pending.find((request) => request.owner !== agent.id);
  const stoppable = agent.status === "running" && agent.capabilities.stop;
  if (!own.length && !other && !stoppable) return null;
  const who = other
    ? (chat.sub_agents.find((one) => one.id === other.owner)?.title ??
      chat.harness.name)
    : "";
  return (
    <div className="chat-tray">
      <DockSlot className="chat-tray-top">
        <ActivityDock
          chat={chat}
          requests={own}
          asker={{ agents: chat.sub_agents }}
          answerDraft={own[0] && answerDrafts.get(own[0].id)}
          questionDrafts={drafts}
          lead={
            other && (
              <section className="chat-needs-elsewhere">
                <StatusDot tone="attention" size={6} />
                <span>
                  <strong>{who}</strong> needs you
                </span>
                <span className="chat-spacer" />
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => onReview(other.owner ?? null)}
                >
                  Review
                </Button>
              </section>
            )
          }
          onAnswer={(requestId, answer) =>
            client.answer(chat.id, requestId, answer)
          }
          onLeave={onLeave}
          onSendNow={async () => {}}
          queueEdits={[]}
          draftLocked={false}
          onEdit={none}
          onRemove={none}
          onResume={none}
        />
      </DockSlot>
      {stoppable && <SubAgentControl view={view} onStop={onStop} />}
    </div>
  );
}
