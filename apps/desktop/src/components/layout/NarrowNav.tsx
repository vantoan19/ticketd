import { Menu } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * The narrow window's way to the navigation sheet: a 32px icon button in the
 * leading slot of the view's own header (DESIGN.md section 5), never a bar of
 * its own. What waits in the sheet shows as a dot on the icon's corner and in
 * the button's name: Chats waiting first, then unread Inbox items.
 */
export function NarrowNav({
  waitingChats,
  unreadInbox,
}: {
  waitingChats: number;
  unreadInbox: number;
}) {
  const waiting =
    waitingChats > 0 &&
    `${waitingChats} ${waitingChats === 1 ? "Chat" : "Chats"} waiting`;
  const unread = unreadInbox > 0 && `${unreadInbox} unread in Inbox`;
  const name = ["Open navigation", waiting || unread]
    .filter(Boolean)
    .join(", ");
  return (
    <span className="shell-nav">
      <Tooltip content="Open navigation" side="bottom">
        <SidebarTrigger aria-label={name}>
          <Menu aria-hidden="true" />
        </SidebarTrigger>
      </Tooltip>
      {(waiting || unread) && (
        <StatusDot tone={waiting ? "attention" : "unread"} />
      )}
    </span>
  );
}
