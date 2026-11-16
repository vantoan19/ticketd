import type { ReactNode } from "react";
import { cn } from "cn";
import { RadioGroup } from "radix-ui";
import { Count } from "./count";
import { StatusDot } from "./status-dot";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
  /** Marks the option with an attention dot; these words say why to a screen reader. */
  attention?: string;
  disabled?: boolean;
  title?: string;
};

/**
 * An exclusive choice among a few options. Never empty; arrow keys move the
 * selection. Segments are an equal-width grid that never wraps: a long
 * label truncates inside its segment instead of pushing the row. An
 * unavailable option stays, disabled.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  /** Kept for callers; every segmented control uses the shared 28px density. */
  compact?: boolean;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      orientation="horizontal"
      data-slot="segmented-control"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={cn(
        "ui-segmented inline-grid h-7 auto-cols-fr grid-flow-col items-center gap-0.5 rounded-md p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled ?? false}
          title={option.title}
          className={cn(
            "inline-flex h-6 min-w-0 items-center justify-center gap-1.5 rounded-sm px-2.5 text-secondary-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-(--ring) enabled:hover:text-foreground data-[state=checked]:text-foreground disabled:cursor-not-allowed disabled:text-(--disabled-foreground) [&_svg]:size-4 [&_svg]:shrink-0",
          )}
        >
          {option.icon}
          <span className="truncate">{option.label}</span>{" "}
          {option.count !== undefined && <Count>{option.count}</Count>}
          {option.attention && (
            <>
              <StatusDot tone="attention" size={6} />
              <span className="sr-only">, {option.attention}</span>
            </>
          )}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
