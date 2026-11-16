import { useRef } from "react";
import { Ellipsis } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useStatusLine } from "@/components/ui/use-status-line";
import { useChatClient, type Retention } from "@/features/chats/client";
import { chatFailure, type ChatFailureNotice } from "./failure";

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
 * action keeps the old state; `onResult` hears why, or null once one succeeds.
 * Archive and Move to Trash act at once and say so in the status line with
 * Undo (DESIGN.md section 12).
 */
export function ChatActionsMenu({
  chat,
  label,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onResult,
  onLink,
  rowAction = false,
}: {
  rowAction?: boolean;
  chat: ActionTarget;
  /** Where the menu can link a record: the Chat header, whose Chat may have no chip row. */
  onLink?: () => void;
  /** "Actions for {title}" in rows, "Chat actions" in the header. */
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onResult: (failure: ChatFailureNotice | null) => void;
}) {
  const client = useChatClient();
  const statusLine = useStatusLine();
  const act = (
    name: string,
    action: () => Promise<void>,
    done?: () => void,
  ): void =>
    void action().then(
      () => {
        onResult(null);
        done?.();
      },
      (reason: unknown) =>
        onResult(chatFailure(reason, name, () => act(name, action, done))),
    );
  const trashed = chat.retention === "trashed";
  // The link picker opens as the menu closes; focus stays with the picker.
  const linking = useRef(false);
  return (
    <DropdownMenu
      {...(open !== undefined && { open })}
      {...(onOpenChange && { onOpenChange })}
    >
      <DropdownMenuTrigger asChild>
        <IconButton
          label={label}
          size={rowAction ? "icon-row-action" : "icon-sm"}
        >
          <Ellipsis aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (linking.current) event.preventDefault();
          else onCloseAutoFocus?.(event);
          linking.current = false;
        }}
      >
        <DropdownMenuItem
          onSelect={() =>
            act(
              chat.unseen ? "mark the Chat as read" : "mark the Chat as unread",
              () =>
                chat.unseen
                  ? client.markRead(chat.id)
                  : client.markUnread(chat.id),
            )
          }
        >
          {chat.unseen ? "Mark as read" : "Mark as unread"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            act(chat.muted ? "unmute the Chat" : "mute the Chat", () =>
              client.setMuted(chat.id, !chat.muted),
            )
          }
        >
          {chat.muted ? "Unmute notifications" : "Mute notifications"}
        </DropdownMenuItem>
        {onLink && !trashed && (
          <DropdownMenuItem
            onSelect={() => {
              linking.current = true;
              onLink();
            }}
          >
            Link a ticket, Document or Project…
          </DropdownMenuItem>
        )}
        {!trashed && <DropdownMenuSeparator />}
        {chat.retention === "active" && (
          <DropdownMenuItem
            onSelect={() =>
              act(
                "archive the Chat",
                () => client.archive(chat.id),
                () =>
                  statusLine.show({
                    message: "Archived the Chat",
                    undo: () => client.unarchive(chat.id),
                  }),
              )
            }
          >
            Archive
          </DropdownMenuItem>
        )}
        {!trashed && (
          <DropdownMenuItem
            onSelect={() =>
              act(
                "move the Chat to Trash",
                () => client.trash(chat.id),
                () =>
                  statusLine.show({
                    message: "Moved the Chat to Trash",
                    undo: () => client.restore(chat.id),
                  }),
              )
            }
          >
            Move to Trash
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
