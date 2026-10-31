import * as React from "react";
import { cn } from "cn";

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
