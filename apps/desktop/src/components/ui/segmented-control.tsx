import type { ReactNode } from "react";
import { cn } from "cn";
import { RadioGroup } from "radix-ui";
import { Count } from "./count";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
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
  compact = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  /** The 28px header size: 12px labels with 8px padding. */
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
        "inline-grid auto-cols-fr grid-flow-col items-center gap-0.5 rounded-md bg-(--recessed) p-0.5 shadow-(--shadow-border-base)",
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
            "inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-sm px-2.5 text-sm text-secondary-foreground outline-none focus-visible:shadow-(--focus-ring) enabled:hover:text-foreground data-[state=checked]:bg-(--surface) data-[state=checked]:text-foreground data-[state=checked]:shadow-(--shadow-small) disabled:cursor-not-allowed disabled:text-(--disabled-foreground) [&_svg]:size-4 [&_svg]:shrink-0",
            compact && "h-6 px-2 text-xs",
          )}
        >
          {option.icon}
          <span className="truncate">{option.label}</span>{" "}
          {option.count !== undefined && <Count>{option.count}</Count>}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
