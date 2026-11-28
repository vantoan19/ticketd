import { useRef, useState, type KeyboardEvent } from "react";
import { Tooltip, TooltipSide } from "@/components/ui/tooltip";
import type { PlanOverviewWork } from "./PlanOverview";

type Strip = PlanOverviewWork["strip"];
type Status = Strip[number]["group"];

const statusStyles: Record<Status, string> = {
  Done: "done",
  "In review": "review",
  "In progress": "progress",
  Ready: "ready",
  Blocked: "blocked",
  "Held by source": "held",
};

type StripProps = {
  strip: Strip;
  selected: string | null;
  onOpen: (reference: string, trigger: HTMLElement) => void;
};

export function PlanOverviewStrip(props: StripProps) {
  const { strip, selected } = props;
  if (!strip.length) return null;
  return (
    <TooltipSide side="bottom">
      {strip.length > 60 ? (
        <PlanOverviewStatusRuns strip={strip} selected={selected} />
      ) : (
        <PlanOverviewTicketSegments {...props} />
      )}
    </TooltipSide>
  );
}

function PlanOverviewTicketSegments({ strip, selected, onOpen }: StripProps) {
  const toolbar = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // Start at the first segment when entering the toolbar, then let Tab leave
  // from whichever segment the arrow keys reached.
  const tabStop = strip.some(({ ticket }) => ticket.reference === focused)
    ? focused
    : strip[0]?.ticket.reference;

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let target: number;
    switch (event.key) {
      case "ArrowLeft":
        target = index - 1;
        break;
      case "ArrowRight":
        target = index + 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = strip.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    toolbar.current?.querySelectorAll("button").item(target)?.focus();
  }

  return (
    <div
      ref={toolbar}
      className="plan-overview-strip"
      role="toolbar"
      aria-label="Plan progress"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(null);
      }}
    >
      {strip.map(({ ticket, group }, index) => {
        const { reference, title } = ticket;
        const name = `${reference} ${title} · ${group}`;
        return (
          <Tooltip key={reference} content={name}>
            <button
              type="button"
              className="plan-overview-strip-target"
              aria-label={name}
              aria-current={selected === reference || undefined}
              tabIndex={tabStop === reference ? 0 : -1}
              onFocus={() => setFocused(reference)}
              onKeyDown={(event) => move(event, index)}
              onClick={(event) => onOpen(reference, event.currentTarget)}
            >
              <span
                className="plan-overview-strip-mark"
                data-status={statusStyles[group]}
                aria-hidden="true"
              />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function PlanOverviewStatusRuns({
  strip,
  selected,
}: {
  strip: Strip;
  selected: string | null;
}) {
  const runs = new Map<Status, number>();
  let current: Status | undefined;
  for (const { ticket, group } of strip) {
    runs.set(group, (runs.get(group) ?? 0) + 1);
    if (selected === ticket.reference) current = group;
  }

  return (
    <div
      className="plan-overview-strip"
      role="group"
      aria-label="Plan progress"
    >
      {Array.from(runs, ([group, count]) => {
        const name = `${count} ${group.toLowerCase()}`;
        return (
          <Tooltip key={group} content={name}>
            <span
              className="plan-overview-strip-target"
              style={{ flexGrow: count }}
              role="img"
              aria-label={name}
              aria-current={group === current || undefined}
            >
              <span
                className="plan-overview-strip-mark"
                data-status={statusStyles[group]}
                aria-hidden="true"
              />
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
