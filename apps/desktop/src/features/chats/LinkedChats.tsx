import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureState } from "@/components/ui/failure-alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RailSection } from "@/features/tickets/RailSection";
import { ChatStatus } from "@/features/chats/ChatStatus";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { chatCount, emphasised, statusLabel } from "@/features/chats/model";
import { useChatFeature, useLinkedChats } from "@/features/chats/use-chats";
import {
  topChat,
  useChatAboutTicket,
  type ChatTicket,
} from "@/features/chats/use-ticket-chats";

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
    <Button variant={chip ? "outline" : "ghost"} size="sm" onClick={chatAbout}>
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
          aria-label={`Chats: ${chats.length}${top ? `, ${statusLabel(top.status)}` : ""}`}
        >
          <span className="linked-chats-line">
            <span>{chatCount(chats.length)}</span>
            {top && (
              <>
                <span aria-hidden="true">·</span>
                <ChatStatus
                  status={{
                    ...top.status,
                    word: statusLabel(top.status),
                    detail: null,
                  }}
                  activity={top.activity}
                />
              </>
            )}
          </span>
          <ChevronRight aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8}>
        {chats.map((chat) => (
          <DropdownMenuItem
            key={chat.id}
            aria-label={`${chat.title}, ${chat.harness_name}, ${statusLabel(chat.status)}`}
            onSelect={() =>
              requestChat({
                kind: "open",
                chatId: chat.id,
                retention: chat.retention,
                from: ticket.reference,
              })
            }
          >
            <HarnessMark
              harness={chat.harness_id}
              name={chat.harness_name}
              className="linked-chats-mark"
              decorative
            />
            <span
              className="linked-chats-item"
              data-attention={emphasised(chat.status) ? "" : undefined}
            >
              <span className="linked-chats-item-title">{chat.title}</span>
              <ChatStatus
                status={{
                  ...chat.status,
                  word: statusLabel(chat.status),
                  detail: null,
                }}
                activity={chat.activity}
              />
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
    <FailureState size="inline" failure={list.error} onRetry={retry} />
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
