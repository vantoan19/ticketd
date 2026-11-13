import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * A labeled, outlined single-choice picker. The label is part of the
 * accessible name ("Status: Todo") and is shown beside the value, so a closed
 * picker always says what it sets. Typing never commits; see SelectTrigger.
 */
export function Picker<T extends string>({
  label,
  value,
  onValueChange,
  options,
  disabled,
  icon,
  stacked = false,
}: {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  /** Leading icon inside the control. */
  icon?: ReactNode;
  /** A form field: the label sits above a 40px control that shows the icon and the value. */
  stacked?: boolean;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  const select = (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      {...(disabled !== undefined && { disabled })}
    >
      <SelectTrigger
        size={stacked ? "default" : "sm"}
        className={stacked ? "ui-picker ui-picker-field" : "ui-picker"}
        aria-label={`${label}: ${current}`}
      >
        {icon ?? <span className="text-muted-foreground">{label}</span>}
        <SelectValue>
          {/* The value is a flex container; ellipsis belongs on its text child. */}
          <span className="min-w-0 truncate">{current}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
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
