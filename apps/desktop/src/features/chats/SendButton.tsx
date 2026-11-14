import { ArrowUp, ChevronDown, CornerUpRight, ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { modifierKeyLabel } from "@/lib/platform";
import type { ComposerControls } from "@/features/chats/model";

const WORD = { send: "Send", steer: "Steer", queue: "Queue" } as const;
const ICON = { send: ArrowUp, steer: CornerUpRight, queue: ListPlus } as const;

/**
 * The composer's one send button: an icon and the word the turn sets. It submits
 * the form, so Enter and a click do the same. Beside Steer only, a caret opens
 * the pointer path to the other action: Steer now, or Queue.
 */
export function SendButton({
  controls,
  busy,
  onSteer,
  onQueue,
}: {
  controls: ComposerControls;
  busy: boolean;
  onSteer: () => void;
  onQueue: () => void;
}) {
  const { send, enabled, queues, effect } = controls;
  const Icon = ICON[send];
  const modifier = modifierKeyLabel();
  const chord = modifier === "⌘" ? "⌘↵" : "Ctrl+Enter";
  const description = [
    queues !== undefined && `${chord} queues it instead.`,
    effect,
  ]
    .filter(Boolean)
    .join(" ");
  const button = (
    <Button
      type="submit"
      size="sm"
      // Solid only for Send; Steer and Queue are lighter while a turn runs (LIVE-15).
      variant={send === "send" ? "default" : "secondary"}
      disabled={busy || !enabled}
      aria-keyshortcuts="Enter"
      {...(description && { "aria-description": description })}
    >
      <Icon aria-hidden /> {WORD[send]}
    </Button>
  );
  return (
    <div className="chat-send">
      {effect ? (
        <TooltipProvider>
          <Tooltip>
            {/* A disabled button gets no pointer events; the span keeps the tooltip. */}
            <TooltipTrigger asChild>
              <span className="chat-send-tip">{button}</span>
            </TooltipTrigger>
            <TooltipContent>{effect}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        button
      )}
      {send === "steer" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              label="More ways to send"
              variant="secondary"
              disabled={busy || (!enabled && !queues)}
            >
              <ChevronDown aria-hidden />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={busy || !enabled} onSelect={onSteer}>
              <CornerUpRight aria-hidden />
              <span className="chat-send-item">
                Steer now
                {effect && <small>{effect}</small>}
              </span>
              <DropdownMenuShortcut>↵</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy || !queues} onSelect={onQueue}>
              <ListPlus aria-hidden />
              <span className="chat-send-item">Queue</span>
              <DropdownMenuShortcut>{chord}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
