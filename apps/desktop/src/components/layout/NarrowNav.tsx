import { Menu, Search } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * The narrow window's way to the navigation sheet: a 32px icon button in the
 * leading slot of the view's own header (DESIGN.md section 5), never a bar of
 * its own. What waits in the sheet shows as a dot on the icon's corner and in
 * the button's name: Chats waiting and runs that need the person first,
 * then unread Inbox items.
 */
export function NarrowNav({
  onOpenPalette,
  waitingChats,
  waitingRuns = 0,
  unreadInbox,
}: {
  onOpenPalette: () => void;
  waitingChats: number;
  /** Automation runs that ended needing the person. */
  waitingRuns?: number;
  unreadInbox: number;
}) {
  const waiting = [
    waitingChats > 0 &&
      `${waitingChats} ${waitingChats === 1 ? "Chat" : "Chats"} waiting`,
    waitingRuns > 0 &&
      `${waitingRuns} ${waitingRuns === 1 ? "run needs" : "runs need"} you`,
  ]
    .filter(Boolean)
    .join(", ");
  const unread = unreadInbox > 0 && `${unreadInbox} unread in Inbox`;
  const name = ["Open navigation", waiting || unread]
    .filter(Boolean)
    .join(", ");
  return (
    <span className="shell-nav">
      <span className="shell-nav-button">
        <Tooltip content="Open navigation" side="bottom">
          <SidebarTrigger aria-label={name}>
            <Menu aria-hidden="true" />
          </SidebarTrigger>
        </Tooltip>
        {(waiting || unread) && (
          <StatusDot tone={waiting ? "attention" : "unread"} />
        )}
      </span>
      <IconButton
        label="Search"
        shortcut={shortcutLabel("command-palette")}
        aria-keyshortcuts={ariaKeyShortcuts("command-palette")}
        onClick={onOpenPalette}
      >
        <Search aria-hidden="true" />
      </IconButton>
    </span>
  );
}
