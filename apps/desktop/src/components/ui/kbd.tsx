import * as React from "react";
import { cn } from "cn";

/** The label for the platform's primary modifier key. */
// eslint-disable-next-line react-refresh/only-export-components -- required beside Kbd; only affects dev reloads
export function modifierKeyLabel(): string {
  const platform =
    typeof navigator === "undefined" ? "" : navigator.platform || "";
  return /mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl";
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-[4px] bg-(--surface) px-1 font-mono text-xs leading-5 text-secondary-foreground shadow-(--shadow-border-base)",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
