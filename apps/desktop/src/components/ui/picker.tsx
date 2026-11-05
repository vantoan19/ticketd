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
}: {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      {...(disabled !== undefined && { disabled })}
    >
      <SelectTrigger
        size="sm"
        className="ui-picker"
        aria-label={`${label}: ${current}`}
      >
        <span className="text-muted-foreground">{label}</span>
        <SelectValue />
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
}
