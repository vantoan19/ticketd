import * as React from "react";
import { cn } from "cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "ui-input h-10 w-full min-w-0 px-3 py-2 selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-normal file:text-foreground disabled:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
