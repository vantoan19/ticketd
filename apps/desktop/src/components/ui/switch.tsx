import * as React from "react";
import { cn } from "cn";
import { Switch as SwitchPrimitive } from "radix-ui";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-(--recessed) p-0.5 shadow-[0_0_0_1px_var(--control-boundary)] outline-none transition-colors focus-visible:shadow-(--focus-ring) disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-(--interactive)",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-(--control-boundary) shadow-(--shadow-small) data-[state=checked]:bg-(--surface) transition-transform data-[state=checked]:translate-x-4"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
