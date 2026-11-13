import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RailSection } from "@/features/tickets/RailSection";
import {
  rankSchema,
  type ChatSummary,
} from "@/features/chats/client";
import { ChatStatus } from "@/features/chats/ChatStatus";
import { chatCount, emphasised } from "@/features/chats/model";
import type { TicketRecord } from "@/features/chats/ticket-chat";
import { useChatFeature, useLinkedChats } from "@/features/chats/use-chats";

/** What the ticket side needs of a ticket to show and start its Chats. */
export type ChatTicket = Omit<TicketRecord, "kind"> & { trashed: boolean };

/**
 * The Chat whose status the line shows: the highest rank (spec 21.3). None
 * when every Chat is idle and seen, so the line is only the count.
 */
export function topChat(chats: ChatSummary[]): ChatSummary | null {
  let top: ChatSummary | null = null;
  const order = rankSchema.options;
  for (const chat of chats)
    if (!top || order.indexOf(chat.status.rank) < order.indexOf(top.status.rank))
      top = chat;
  if (!top || (top.status.rank === "idle" && !top.status.unseen)) return null;
  return top;
}

/**
 * "Chat about this ticket": opens New Chat with the ticket linked, the
 * Project's folder chosen and an unsent prompt. Null while Chat is off or the
 * ticket is in Trash.
 */
export function useChatAboutTicket(
  ticket: ChatTicket | undefined,
  folder: string | null,
) {
  const { enabled, requestChat } = useChatFeature();
  if (!enabled || !ticket || ticket.trashed) return null;
  const { trashed: _trashed, ...record } = ticket;
  return () =>
    requestChat({
      kind: "new",
      start: { ticket: { kind: "ticket", ...record }, folder },
    });
}

/**
 * The ticket's Chats as one quiet line, `3 Chats · ● Approval needed ›`, that
 * opens a menu of them, with Chat about this ticket under it. The menu is a
 * snapshot; the line itself follows every Chat's status as it changes. In the
 * narrow chip bar the line is a chip.
 */
export function LinkedChats({
  ticket,
  folder,
  chip = false,
}: {
  ticket: ChatTicket;
  /** The ticket's Project's folder, offered to a new Chat. */
  folder: string | null;
  chip?: boolean;
}) {
  const { enabled, requestChat } = useChatFeature();
  const { list, retry } = useLinkedChats(
    enabled ? { kind: "ticket", id: ticket.id } : null,
  );
  const chatAbout = useChatAboutTicket(ticket, folder);
  if (!enabled) return null;
  const chats = list?.chats ?? [];
  const top = topChat(chats);
  const action = chatAbout && (
    <Button
      variant={chip ? "outline" : "ghost"}
      size="sm"
      onClick={chatAbout}
    >
      <Plus aria-hidden />
      Chat about this ticket
    </Button>
  );
  const menu = chats.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={chip ? "outline" : "ghost"}
          size="sm"
          aria-label={`Chats: ${chats.length}${top ? `, ${top.status.word}` : ""}`}
        >
          <span className="linked-chats-line">
            <span>{chatCount(chats.length)}</span>
            {top && (
              <>
                <span aria-hidden="true">·</span>
                <ChatStatus
                  status={{ ...top.status, detail: null }}
                  activity={top.activity}
                />
              </>
            )}
          </span>
          <ChevronRight aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {chats.map((chat) => (
          <DropdownMenuItem
            key={chat.id}
            aria-label={`${chat.title}, ${chat.harness_name}, ${chat.status.word}`}
            onSelect={() =>
              requestChat({
                kind: "open",
                chatId: chat.id,
                retention: chat.retention,
                from: ticket.reference,
              })
            }
          >
            {/* The harness mark's place (#368). */}
            <span
              className="linked-chats-item"
              data-attention={emphasised(chat.status) ? "" : undefined}
            >
              <span className="linked-chats-item-title">{chat.title}</span>
              <ChatStatus status={chat.status} activity={chat.activity} />
            </span>
          </DropdownMenuItem>
        ))}
        {chatAbout && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={chatAbout}>
              <Plus aria-hidden />
              Chat about this ticket
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const state = !list ? (
    <span className="linked-chats-note" role="status">
      Loading Chats…
    </span>
  ) : list.error ? (
    <span className="linked-chats-note" role="alert">
      Couldn’t load Chats{" "}
      <Button variant="ghost" size="xs" onClick={retry}>
        Retry
      </Button>
    </span>
  ) : null;
  if (chip)
    return (
      <>
        {menu || state}
        {!menu && action}
      </>
    );
  return (
    <RailSection label="Chats">
      <div className="linked-chats">
        {state}
        {menu}
        {action}
      </div>
    </RailSection>
  );
}
