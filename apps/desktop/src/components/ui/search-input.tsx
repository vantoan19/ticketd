import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "cn";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import "./patterns.css";

/**
 * A search field: a leading 16px icon inside, a trailing clear button (never
 * the native ⊗) and a fixed width that never shrinks as results change.
 * `size="sm"` is 32px for toolbars and popovers, `default` 40px for dialogs;
 * `fill` takes the free width up to 360px (a pane header). The placeholder is
 * "Search {things}…". Escape clears a value, then leaves the field to the
 * caller (`onKeyDown`).
 */
function SearchInput({
  value,
  onValueChange,
  size = "sm",
  fill = false,
  className,
  onKeyDown,
  ...props
}: Omit<React.ComponentProps<"input">, "size" | "value" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
  size?: "sm" | "default";
  fill?: boolean;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <span
      data-slot="search-input"
      data-fill={fill || undefined}
      className={cn("ui-search-input", className)}
    >
      <Search aria-hidden="true" />
      <Input
        ref={input}
        type="search"
        autoComplete="off"
        spellCheck={false}
        className={size === "sm" ? "h-8" : undefined}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onValueChange("");
            return;
          }
          onKeyDown?.(event);
        }}
        {...props}
      />
      {value && (
        <IconButton
          type="button"
          data-slot="search-clear"
          label="Clear search"
          size="icon-xs"
          onClick={() => {
            onValueChange("");
            input.current?.focus();
          }}
        >
          <X />
        </IconButton>
      )}
    </span>
  );
}

export { SearchInput };
