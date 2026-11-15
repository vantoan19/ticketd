import { cn } from "cn";
import type { PlanCounts } from "@/lib/api/plans";
import "./plan-progress.css";

type Props = {
  name: string;
  /** Counts from show_plan, never from the current filtered page. */
  counts: PlanCounts;
  className?: string;
  decorative?: boolean;
};

function progress(counts: PlanCounts) {
  const countable =
    counts.todo + counts.in_progress + counts.in_review + counts.done;
  const moving = counts.in_progress + counts.in_review;
  return {
    countable,
    moving,
    share: (count: number) => (countable ? count / countable : 0),
  };
}

function accessible(name: string, counts: PlanCounts, decorative: boolean) {
  const { countable, moving } = progress(counts);
  return decorative
    ? { "aria-hidden": true as const }
    : {
        role: "img",
        "aria-label": `${name}, ${counts.done} of ${countable} done, ${moving} moving`,
      };
}

/** A Plan's moving arc includes Done; the Done arc overlays it. */
export function PlanRing({
  name,
  counts,
  className,
  decorative = false,
  size = 16,
}: Props & { size?: 16 | 20 }) {
  const { share } = progress(counts);
  return (
    <svg
      className={cn("plan-ring", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...accessible(name, counts, decorative)}
    >
      <circle className="plan-ring-track" cx="8" cy="8" r="6" />
      <circle
        className="plan-ring-moving"
        cx="8"
        cy="8"
        r="6"
        pathLength="1"
        strokeDasharray={`${share(counts.done + counts.in_review + counts.in_progress)} 1`}
        visibility={
          share(counts.done + counts.in_review + counts.in_progress)
            ? undefined
            : "hidden"
        }
      />
      <circle
        className="plan-ring-done"
        cx="8"
        cy="8"
        r="6"
        pathLength="1"
        strokeDasharray={`${share(counts.done)} 1`}
        visibility={counts.done ? undefined : "hidden"}
      />
    </svg>
  );
}

/** Done, review and progress segments; Todo remains the track behind them. */
export function PlanSplitBar({
  name,
  counts,
  className,
  decorative = false,
  variant,
}: Props & { variant?: "summary" }) {
  const { share } = progress(counts);
  return (
    <span
      className={cn("plan-split-bar", className)}
      data-variant={variant}
      {...accessible(name, counts, decorative)}
    >
      {(
        [
          ["done", counts.done],
          ["review", counts.in_review],
          ["progress", counts.in_progress],
        ] as const
      ).map(
        ([status, count]) =>
          count > 0 && (
            <span
              key={status}
              data-segment={status}
              style={{ flexGrow: share(count), flexBasis: 0 }}
            />
          ),
      )}
      {counts.todo > 0 && (
        <span
          data-segment="todo"
          style={{ flexGrow: share(counts.todo), flexBasis: 0 }}
        />
      )}
    </span>
  );
}
