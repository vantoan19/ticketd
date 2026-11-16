import { useEffect, useEffectEvent } from "react";
import { matchesShortcut, SHORTCUTS, type Shortcut } from "@/lib/shortcuts";

export type GoTo =
  | "inbox"
  | "all"
  | "ready"
  | "chats"
  | "automations"
  | "documents"
  | "projects"
  | "plans"
  | "settings"
  | "trash";
const destinations: Record<string, GoTo> = {
  "go-inbox": "inbox",
  "go-all": "all",
  "go-ready": "ready",
  "go-chats": "chats",
  "go-documents": "documents",
  "go-settings": "settings",
  "go-trash": "trash",
};
const typing =
  "input, textarea, select, [contenteditable]:not([contenteditable=false])";
const overlays =
  "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-slot=popover-content]";

/** The shell owns navigation; sequences never escape typing or overlay contexts. */
export function useCommandKeys(
  open: () => void,
  go: (target: GoTo) => void,
  ticketAction: (event: KeyboardEvent) => boolean,
) {
  const openPalette = useEffectEvent(open);
  const navigate = useEffectEvent(go);
  const actOnTicket = useEffectEvent(ticketAction);
  useEffect(() => {
    let pending = false;
    let timer: number | undefined;
    const reset = () => {
      pending = false;
      window.clearTimeout(timer);
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        reset();
        return;
      }
      if (matchesShortcut(event, "command-palette")) {
        reset();
        // Plate owns Mod+K at the caret. Other fields may still open global search.
        if (target?.closest("[contenteditable]:not([contenteditable=false])"))
          return;
        if (document.querySelector(overlays)) return;
        event.preventDefault();
        openPalette();
        return;
      }
      if (
        !pending &&
        !target?.closest(typing) &&
        !target?.closest(".inbox") &&
        !document.querySelector(overlays) &&
        actOnTicket(event)
      ) {
        reset();
        event.preventDefault();
        return;
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        target?.closest(typing) ||
        document.querySelector(overlays)
      ) {
        reset();
        return;
      }
      const key = event.key.toUpperCase();
      const sequences = (SHORTCUTS as readonly Shortcut[]).filter(
        (entry) => entry.sequences,
      );
      if (pending) {
        reset();
        const match = sequences.find((entry) =>
          entry.sequences?.some((sequence) => sequence[1]?.[0] === key),
        );
        const destination = match && destinations[match.id];
        if (destination) {
          event.preventDefault();
          navigate(destination);
          return;
        }
      }
      if (
        sequences.some((entry) =>
          entry.sequences?.some((sequence) => sequence[0]?.[0] === key),
        )
      ) {
        event.preventDefault();
        pending = true;
        timer = window.setTimeout(reset, 1000);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", reset);
    document.addEventListener("focusin", reset);
    return () => {
      reset();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("focusin", reset);
    };
  }, []);
}
