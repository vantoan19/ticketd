import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceList } from "@/components/ui/choice-list";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Chooses several tags (DESIGN.md section 11, P3): a field that shows the
 * chosen tags as badges and opens a ChoiceList below it. Rows toggle with a
 * trailing check and the list stays open; typing filters, and a new word is
 * offered as "Create “x”" (matching ignores case, so no duplicate by case).
 * `size="field"` is the 40px dialog control; `sm` is a 32px toolbar control.
 */
export function TagPicker({
  label,
  values,
  onChange,
  suggestions = [],
  placeholder = "Add tags",
  size = "field",
  disabled = false,
}: {
  /** The accessible name of the control ("Tags"). */
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  /** Existing tags to offer; chosen ones are listed too. */
  suggestions?: readonly string[];
  placeholder?: string;
  size?: "field" | "sm";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const has = (tag: string) =>
    values.some((value) => value.toLowerCase() === tag.toLowerCase());
  const toggle = (tag: string) =>
    onChange(
      has(tag)
        ? values.filter((value) => value.toLowerCase() !== tag.toLowerCase())
        : [...values, tag],
    );
  const offered = [
    ...values,
    ...suggestions.filter((tag) => !values.includes(tag) && !has(tag)),
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size === "field" ? "default" : "sm"}
          disabled={disabled}
          aria-label={`${label}: ${values.length ? values.join(", ") : "none"}`}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {values.length ? (
              values.map((tag) => (
                <Badge key={tag} variant="tag">
                  {tag}
                </Badge>
              ))
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        variant="list"
        aria-label={`${label} choices`}
      >
        <ChoiceList
          label={`${label} choices`}
          searchPlaceholder="Search tags"
          groups={offered.map((tag) => ({ value: tag, label: tag }))}
          selected={values}
          onSelect={toggle}
          create={(tag) => {
            if (!has(tag)) onChange([...values, tag]);
          }}
          empty="No tags yet"
        />
      </PopoverContent>
    </Popover>
  );
}
