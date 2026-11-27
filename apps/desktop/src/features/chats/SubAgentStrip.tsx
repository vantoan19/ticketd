import {
  useCallback,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ChevronRight, ChevronUp, LoaderCircle, Square } from "lucide-react";
import { CrossfadeText } from "@/components/ui/motion";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SubAgent } from "@/features/chats/client";
import { duration } from "@/features/chats/model";
import {
  runningTree,
  runningWords,
  STRIP_OPENER,
} from "@/features/chats/sub-agents";
import { useNow } from "@/features/chats/use-now";

/** How long a running sub-agent has gone, or nothing before a second. */
function clock(agent: SubAgent, now: number) {
  const elapsed = now - Date.parse(agent.started_at);
  return elapsed >= 1000 ? duration(elapsed) : "";
}

/** Where the keyboard was in the strip as a part of it left: a list row's place, or 0 for the pill. */
export type StripFocus = number | null;

/** Where the strip's rows are in the open list, and its pill: what focus is handed to. */
const LIST_ROW = ".chat-subagent-item";
const pillSelector = `[data-sub-agent="${STRIP_OPENER}"]`;

/**
 * A ref for a part of the strip that can leave under focus (a sub-agent ended,
 * the list closed itself): as it detaches, it notes where focus was, so the
 * strip can hand focus on instead of dropping it to the page.
 */
function useNoteLeaving(heldRef: RefObject<StripFocus>) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      return () => {
        if (!element.contains(document.activeElement)) return;
        const row = element.closest("li");
        heldRef.current = row?.parentElement
          ? [...row.parentElement.children].indexOf(row)
          : 0;
      };
    },
    [heldRef],
  );
}

/**
 * The strip: one 28px recessed pill in the tray while any sub-agent runs, in or
 * out of a turn. One running names it and opens it; several count and open a
 * list, each row opening its sub-agent, with Stop for one where the harness can.
 * The pill's count is a polite live region: the clocks are not read out.
 */
export function SubAgentStrip({
  agents,
  onOpen,
  onStop,
  heldRef,
}: {
  agents: readonly SubAgent[];
  onOpen: (agent: SubAgent) => void;
  onStop: (agent: SubAgent) => void;
  /** Filled in when focus was in a part of the strip as it left; the strip or its Chat then hands focus on. */
  heldRef: RefObject<StripFocus>;
}) {
  const [open, setOpen] = useState(false);
  const tree = runningTree(agents);
  const now = useNow(tree.length > 0);
  const noteLeaving = useNoteLeaving(heldRef);
  // After a commit that took the focused part away: the next row at its place
  // (or the last), else the pill; with the strip gone, its Chat's message box.
  useLayoutEffect(() => {
    const at = heldRef.current;
    if (at === null || tree.length === 0) return;
    heldRef.current = null;
    if (document.activeElement && document.activeElement !== document.body)
      return;
    const rows = [...document.querySelectorAll<HTMLElement>(LIST_ROW)];
    const target =
      tree.length > 1
        ? rows[Math.min(at, rows.length - 1)]
        : document.querySelector<HTMLElement>(pillSelector);
    target?.focus();
  });
  const [first] = tree;
  if (!first) return null;
  if (tree.length === 1) {
    const { agent } = first;
    const time = clock(agent, now);
    return (
      <button
        ref={noteLeaving}
        type="button"
        className="chat-plan-pill chat-subagent-pill"
        data-sub-agent={STRIP_OPENER}
        aria-label={`${agent.title}, working${time && `, ${time}`}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onOpen(agent)}
      >
        <span className="chat-plan-pill-icon" aria-hidden="true">
          <LoaderCircle className="chat-spin chat-plan-pill-mark" />
          <ChevronRight className="chat-chevron" />
        </span>
        <span className="chat-plan-pill-count">{agent.title}</span>
        {time && (
          <>
            <span className="chat-plan-pill-separator" aria-hidden="true">
              ·
            </span>
            <span className="chat-plan-pill-now">{time}</span>
          </>
        )}
      </button>
    );
  }
  /** ↑ and ↓ move between the list's rows; Enter opens one natively. */
  const move = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        ".chat-subagent-item",
      ),
    ];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    // From a row's Stop, the arrows move between its neighbours' rows too.
    const target = at < 0 ? undefined : rows[next];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={noteLeaving}
          type="button"
          className="chat-plan-pill chat-subagent-pill"
          data-sub-agent={STRIP_OPENER}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="chat-plan-pill-icon" aria-hidden="true">
            <LoaderCircle className="chat-spin chat-plan-pill-mark" />
            <ChevronUp className="chat-chevron" />
          </span>
          <span className="chat-plan-pill-count" aria-live="polite">
            <CrossfadeText>{runningWords(tree.length)}</CrossfadeText>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label="Running sub-agents"
        variant="compact-form"
        className="w-90"
        onKeyDown={move}
      >
        <ul className="chat-subagent-list">
          {tree.map(({ agent, depth }) => (
            <li
              key={agent.id}
              ref={noteLeaving}
              {...(depth > 0 && { "data-depth": depth })}
            >
              <button
                type="button"
                className="chat-subagent-item"
                onClick={() => {
                  setOpen(false);
                  onOpen(agent);
                }}
              >
                <span className="chat-row-icon" aria-hidden="true">
                  <LoaderCircle size={12} className="chat-spin" />
                </span>
                <span className="chat-subagent-title">{agent.title}</span>
                <span className="chat-subagent-time">{clock(agent, now)}</span>
              </button>
              {agent.capabilities.stop && (
                <IconButton
                  label={`Stop ${agent.title}`}
                  variant="ghost"
                  size="icon-row-action"
                  tooltipSide="top"
                  onClick={() => onStop(agent)}
                >
                  <Square className="chat-stop-mark" fill="currentColor" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
