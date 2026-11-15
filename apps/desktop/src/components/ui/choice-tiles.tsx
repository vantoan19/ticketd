import type { ReactNode } from "react";
import { cn } from "cn";
import { RadioGroup } from "radix-ui";

/**
 * A group of tiles of which exactly one is chosen, for choices that deserve a
 * title, a sentence and often a preview. Wraps a Radix radio group: arrow keys
 * move the choice, Tab enters and leaves the group. Name it with `aria-label`
 * or `aria-labelledby`. Compose `ChoiceTile`s as children.
 */
export function ChoiceTiles({
  value,
  onValueChange,
  columns = 2,
  disabled = false,
  className,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: {
  value: string;
  onValueChange: (value: string) => void;
  columns?: 2 | 3;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <RadioGroup.Root
      data-slot="choice-tiles"
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      orientation="horizontal"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={cn(
        "grid gap-3 max-sm:grid-cols-1",
        columns === 3 ? "grid-cols-3" : "grid-cols-2",
        className,
      )}
    >
      {children}
    </RadioGroup.Root>
  );
}

/**
 * One choice in `ChoiceTiles`. `preview` is drawn above the title (a small
 * picture of the result); `children` sit under the description for extra
 * detail and must not be interactive. Without a preview the tile is plain and
 * padded evenly; a plain tile may carry an `icon`, drawn in a small tile on
 * its own top row. The radio always leads the title row (P11). The chosen
 * tile wears a 2px interactive ring; a disabled tile drops its ring and reads
 * in `--disabled-foreground`, its description saying why.
 */
export function ChoiceTile({
  value,
  title,
  description,
  preview,
  icon,
  disabled = false,
  className,
  children,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  preview?: ReactNode;
  /** A glyph for plain tiles, decorative; the title names the tile. */
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const radio = (
    <span
      aria-hidden="true"
      data-slot="choice-tile-radio"
      className="mt-0.5 size-4 shrink-0 rounded-full bg-(--surface)"
    />
  );
  return (
    <RadioGroup.Item
      data-slot="choice-tile"
      value={value}
      disabled={disabled}
      className={cn(
        "group flex flex-col gap-3 rounded-(--radius-panel) bg-(--surface) text-left text-sm text-foreground shadow-(--shadow-border) outline-none",
        preview
          ? "px-2 pt-2 pb-3"
          : icon
            ? "px-4 py-3.5 gap-3.5"
            : "px-4 py-3.5",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)",
        "disabled:cursor-not-allowed disabled:bg-(--recessed) disabled:text-(--disabled-foreground) disabled:shadow-none",
        className,
      )}
    >
      {preview}
      {icon && (
        <span
          aria-hidden="true"
          data-slot="choice-tile-icon"
          className="flex size-9 items-center justify-center rounded-md bg-(--recessed) text-foreground shadow-(--shadow-border-base) group-disabled:text-(--disabled-foreground)"
        >
          {icon}
        </span>
      )}
      <span className={cn("flex items-start gap-2.5", preview && "px-1")}>
        {radio}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{title}</span>
          {description && (
            <span className="text-xs leading-4 text-muted-foreground group-disabled:text-(--disabled-foreground)">
              {description}
            </span>
          )}
          {children}
        </span>
      </span>
    </RadioGroup.Item>
  );
}
