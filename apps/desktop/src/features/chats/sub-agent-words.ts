import type { KeyboardEvent } from "react";
import { markerText } from "@/features/chats/model";
import type { Ending } from "@/features/chats/sub-agents";

/** What takes an Esc before the view does: menus, popovers, dialogs, pickers. */
const LAYER =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';

/**
 * Back from a sub-agent's view by keyboard: Cmd+[ (Ctrl+[), or Esc when no
 * menu, popover or request has the key. Never stops anything.
 */
export function backKey(event: KeyboardEvent<HTMLElement>, onBack: () => void) {
  if (event.nativeEvent.isComposing || event.defaultPrevented) return;
  const back =
    event.key === "Escape" ||
    (event.key === "[" && (event.metaKey || event.ctrlKey));
  if (!back) return;
  const target = event.target as Element;
  if (
    event.key === "Escape" &&
    (target.closest(LAYER) ||
      document.querySelector(LAYER) ||
      target.closest(".chat-tray"))
  )
    return;
  event.preventDefault();
  onBack();
}

/** The sentence a StopReason is told by in the transcript, without its edits clause. */
function stoppedWords(reason: string, harness: string) {
  const words = markerText(
    {
      id: "",
      at: "",
      kind: "marker",
      reason: reason as "quit",
    },
    harness,
    false,
  );
  const first = words?.split(/(?<=\.) /)[0];
  return first && first.length > 0 ? first : undefined;
}

/** How a sub-agent ended, as one step-style row under its last words. */
export function endingWords(ending: Ending, harness: string) {
  if (ending.kind === "lost")
    return {
      text: `Contact lost when ticketd quit.${ending.resumable ? ` ${harness} can resume it.` : ""}`,
      icon: "unplug" as const,
    };
  const text =
    ending.by === "person"
      ? "You stopped it."
      : ending.by === "main_agent"
        ? "The main agent stopped it."
        : ending.by === "ticketd"
          ? ((ending.reason && stoppedWords(ending.reason, harness)) ??
            "ticketd stopped it.")
          : "Stopped.";
  return { text, icon: "square" as const };
}
