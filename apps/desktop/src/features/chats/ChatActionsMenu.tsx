import { Ellipsis } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useChatClient, type Retention } from "@/features/chats/client";

/** What the menu needs to know about the Chat it acts on. */
export type ActionTarget = {
  id: string;
  retention: Retention;
  muted: boolean;
  /** Shows Mark as read instead of Mark as unread. */
  unseen: boolean;
};

/**
 * The one Chat actions menu, for a list row's ⋯ and the Chat header: Mark as
 * unread or read, Mute or Unmute, then Archive and Move to Trash. A refused
 * action keeps the old state; `onResult` hears why, or "" once one succeeds.
 */
export function ChatActionsMenu({
  chat,
  label,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onResult,
}: {
  chat: ActionTarget;
  /** "Actions for {title}" in rows, "Chat actions" in the header. */
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onResult: (failure: string) => void;
}) {
  const client = useChatClient();
  const act = (action: Promise<void>) =>
    void action.then(
      () => onResult(""),
      (reason: unknown) =>
        onResult(reason instanceof Error ? reason.message : String(reason)),
    );
  const trashed = chat.retention === "trashed";
  return (
    <DropdownMenu
      {...(open !== undefined && { open })}
      {...(onOpenChange && { onOpenChange })}
    >
      <DropdownMenuTrigger asChild>
        <IconButton label={label}>
          <Ellipsis aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        {...(onCloseAutoFocus && { onCloseAutoFocus })}
      >
        <DropdownMenuItem
          onSelect={() =>
            act(
              chat.unseen
                ? client.markRead(chat.id)
                : client.markUnread(chat.id),
            )
          }
        >
          {chat.unseen ? "Mark as read" : "Mark as unread"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => act(client.setMuted(chat.id, !chat.muted))}
        >
          {chat.muted ? "Unmute notifications" : "Mute notifications"}
        </DropdownMenuItem>
        {!trashed && <DropdownMenuSeparator />}
        {chat.retention === "active" && (
          <DropdownMenuItem onSelect={() => act(client.archive(chat.id))}>
            Archive
          </DropdownMenuItem>
        )}
        {!trashed && (
          <DropdownMenuItem onSelect={() => act(client.trash(chat.id))}>
            Move to Trash
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
