import { useState, type KeyboardEvent } from "react";
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
}: {
  agents: readonly SubAgent[];
  onOpen: (agent: SubAgent) => void;
  onStop: (agent: SubAgent) => void;
}) {
  const [open, setOpen] = useState(false);
  const tree = runningTree(agents);
  const now = useNow(tree.length > 0);
  const [first] = tree;
  if (!first) return null;
  if (tree.length === 1) {
    const { agent } = first;
    const time = clock(agent, now);
    return (
      <button
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
            <li key={agent.id} {...(depth > 0 && { "data-depth": depth })}>
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
