import * as React from "react";
import { cn } from "cn";
import { keyGlyph, spokenKeys } from "@/lib/shortcuts";
import "./patterns.css";

/**
 * One key. `inverted` sits inside a dark tooltip chip. Write keys through
 * `KeyChords` (platform glyphs from the shortcut registry) rather than by hand.
 */
function Kbd({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"kbd"> & { tone?: "default" | "inverted" }) {
  return (
    <kbd
      data-slot="kbd"
      data-tone={tone === "inverted" ? "inverted" : undefined}
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-sm px-1 font-mono text-xs leading-5",
        tone === "inverted"
          ? "bg-transparent text-current shadow-(--shadow-border-base)"
          : "bg-(--surface) text-secondary-foreground shadow-(--shadow-border-base)",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Keys as chips with this platform's glyphs ("⌘ ⇧ N" on macOS, "Ctrl Shift N"
 * elsewhere); alternatives are joined by "or". Pass a registry entry's `keys`.
 * Read aloud as words ("Command plus Shift plus N").
 */
function KeyChords({
  keys,
  tone = "default",
  className,
}: {
  keys: readonly (readonly string[])[];
  tone?: "default" | "inverted";
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={spokenKeys(keys)}
      className={cn("ui-kbd-group", className)}
    >
      {keys.map((chord, index) => (
        <span key={chord.join("+")} className="ui-kbd-group">
          {index > 0 && (
            <span aria-hidden="true" className="px-1 text-muted-foreground">
              or
            </span>
          )}
          {chord.map((key) => (
            <Kbd key={key} tone={tone} aria-hidden="true">
              {keyGlyph(key)}
            </Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

export { Kbd, KeyChords };
