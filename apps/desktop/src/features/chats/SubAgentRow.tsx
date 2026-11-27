import { Fragment, memo, useContext } from "react";
import { Bot, ChevronRight, LoaderCircle } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { ItemOf, SubAgent } from "@/features/chats/client";
import { subAgentLabel, subAgentSuffix } from "@/features/chats/model";
import { RowLine } from "@/features/chats/Transcript";
import { SubAgentsContext } from "@/features/chats/sub-agent-context";
import { useNow } from "@/features/chats/use-now";

const STOPPERS = {
  person: "Stopped by you",
  ticketd: "Stopped by ticketd",
  main_agent: "Stopped by the main agent",
} as const;

/** What the row's tooltip says: "Sub-agent · Explore · Claude Haiku 5.5 · Stopped by you". */
function tooltipOf(row: ItemOf<"sub_agent">, record: SubAgent | undefined) {
  const parts = [
    "Sub-agent",
    record?.type,
    record?.model,
    row.status === "stopped" && row.stopped_by && STOPPERS[row.stopped_by],
  ].filter(Boolean);
  return parts.length > 1 ? parts.join(" · ") : undefined;
}

/**
 * One run of a sub-agent as a step row: `[bot] Title · suffix ›`. The whole row
 * opens the sub-agent's view. While it runs the spinner takes the icon's slot
 * (no shimmer: it runs for minutes) and the clock counts; the spinner and the
 * clock are hidden from a screen reader, which hears the state in the name.
 */
export const SubAgentRow = memo(function SubAgentRow({
  item,
  onOpen,
}: {
  item: ItemOf<"sub_agent">;
  onOpen:
    ((item: ItemOf<"sub_agent">, origin: HTMLElement) => void) | undefined;
}) {
  const record = useContext(SubAgentsContext).find(
    (one) => one.id === item.sub_agent,
  );
  // A running sub-agent spins whether or not its parent turn has ended.
  const running = item.status === "running";
  const now = useNow(running);
  const title = record?.title ?? "Sub-agent";
  const suffix = subAgentSuffix(item, record, now);
  return (
    <Tooltip content={tooltipOf(item, record)} side="right">
      <button
        type="button"
        className="chat-steps chat-subagent"
        data-anchor=""
        data-sub-agent={item.id}
        data-state={item.status}
        data-running={running ? "" : undefined}
        aria-label={subAgentLabel(title, item, record, now)}
        onClick={(event) => onOpen?.(item, event.currentTarget)}
      >
        <RowLine
          line
          icon={
            running ? (
              <LoaderCircle size={12} className="chat-spin" />
            ) : (
              <Bot size={16} />
            )
          }
        >
          <span className="chat-subagent-title">{title}</span>
          <span className="chat-step-suffix">
            {suffix.map((part) => (
              <Fragment key={part.text}>
                <span aria-hidden> · </span>
                <span data-outcome={part.outcome ? "" : undefined}>
                  {part.text}
                </span>
              </Fragment>
            ))}
          </span>
        </RowLine>
        <ChevronRight size={14} className="chat-chevron" aria-hidden />
      </button>
    </Tooltip>
  );
});
