import { createContext, useContext, useId } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "cn";
import { RadioGroup } from "radix-ui";
import { Count } from "./count";
import { Glide } from "./motion";
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

const frame =
  "ui-segmented inline-grid h-7 auto-cols-fr grid-flow-col items-center gap-0.5 rounded-md p-0.5";
const segment =
  "relative inline-flex h-6 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-secondary-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-(--ring) enabled:hover:text-foreground data-[state=checked]:text-foreground aria-selected:text-foreground disabled:cursor-not-allowed disabled:text-(--disabled-foreground) [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * The selection is one highlight that glides to the chosen segment; the labels
 * trade colour (DESIGN.md section 12). It needs an id of its own per control,
 * so two controls never pull each other's highlight. Plain tabs show the
 * selection by colour alone, with no highlight.
 */
const HighlightId = createContext<string | null>(null);

/** The same segmented anatomy for tabs whose caller owns their keyboard model. */
export function SegmentedTabList({
  className,
  plain = false,
  ...props
}: ComponentProps<"div"> & { plain?: boolean }) {
  const id = useId();
  return (
    <HighlightId value={plain ? null : id}>
      <div
        {...props}
        role="tablist"
        data-slot="segmented-control"
        data-variant={plain ? "plain" : undefined}
        className={cn(frame, className)}
      />
    </HighlightId>
  );
}
export function SegmentedTab({
  className,
  children,
  ...props
}: ComponentProps<"button">) {
  const highlight = useContext(HighlightId);
  const selected =
    props["aria-selected"] === true || props["aria-selected"] === "true";
  return (
    <button
      {...props}
      type="button"
      role="tab"
      className={cn(segment, className)}
    >
      {highlight && selected && <Glide id={highlight} />}
      {children}
    </button>
  );
}

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
  const highlight = useId();
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      orientation="horizontal"
      data-slot="segmented-control"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={cn(frame, className)}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled ?? false}
          title={option.title}
          className={segment}
        >
          {option.value === value && <Glide id={highlight} />}
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
