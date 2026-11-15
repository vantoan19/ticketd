import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One option of a Picker. */
export type PickerOption<T extends string> = {
  value: T;
  label: string;
  /** A 16px icon, as the trigger shows it (StatusIcon, Folder, Layers). */
  icon?: ReactNode;
  /** The clearing choice ("No project"): drawn last, after a separator. */
  clear?: boolean;
  /** A labelled group drawn after the ungrouped options ("Archived"). */
  group?: string;
};

/**
 * A labeled, outlined single-choice picker. The label is part of the
 * accessible name ("Status: Todo") and is shown beside the value, so a closed
 * picker always says what it sets. The list (P3) opens below the trigger with
 * the current value highlighted and checked; rows carry the same icon as the
 * trigger, and a clearing choice comes last after a separator. Typing never
 * commits; see SelectTrigger.
 */
export function Picker<T extends string>({
  label,
  value,
  onValueChange,
  options,
  disabled,
  icon,
  stacked = false,
  inSentence = false,
}: {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: PickerOption<T>[];
  disabled?: boolean;
  /** Leading icon inside the control, in place of the label text. */
  icon?: ReactNode;
  /** A form field: the label sits above a 40px control that shows the icon and the value. */
  stacked?: boolean;
  /**
   * A choice inside a sentence ("T-FV1 [is related to ▾]"): a 40px control
   * showing only the value; the label stays its accessible name.
   */
  inSentence?: boolean;
}) {
  const option = options.find((o) => o.value === value);
  const current = option?.label ?? value;
  const leading = icon;
  const item = (o: PickerOption<T>) => (
    <SelectItem key={o.value} value={o.value}>
      {o.icon}
      {o.label}
    </SelectItem>
  );
  const choices = options.filter((o) => !o.clear && !o.group);
  const groups = [
    ...new Set(options.flatMap((o) => (o.group && !o.clear ? [o.group] : []))),
  ];
  const clearing = options.filter((o) => o.clear);
  const select = (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      {...(disabled !== undefined && { disabled })}
    >
      <SelectTrigger
        size={stacked || inSentence ? "default" : "sm"}
        className={stacked ? "ui-picker ui-picker-field" : "ui-picker"}
        aria-label={`${label}: ${current}`}
      >
        {leading ??
          (!inSentence && (
            <span className="text-muted-foreground">{label}</span>
          ))}
        <SelectValue>
          {/* The value is a flex container; ellipsis belongs on its text child. */}
          <span className="min-w-0 truncate">{current}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {choices.map(item)}
        {groups.map((group) => (
          <SelectGroup key={group}>
            <SelectSeparator />
            <SelectLabel>{group}</SelectLabel>
            {options.filter((o) => o.group === group && !o.clear).map(item)}
          </SelectGroup>
        ))}
        {clearing.length > 0 && <SelectSeparator />}
        {clearing.map(item)}
      </SelectContent>
    </Select>
  );
  return stacked ? (
    <div className="flex min-w-0 flex-col gap-2">
      <span aria-hidden="true">{label}</span>
      {select}
    </div>
  ) : (
    select
  );
}
