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
        "group inline-flex h-5 w-9 shrink-0 items-center justify-center outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-(--ring) disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-(--recessed) p-0.5 shadow-[0_0_0_1px_var(--control-boundary)] transition-colors group-data-[state=checked]:bg-(--interactive)">
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className="pointer-events-none block size-4 rounded-full bg-(--control-boundary) shadow-(--shadow-small) data-[state=checked]:bg-(--surface) transition-transform data-[state=checked]:translate-x-4"
        />
      </span>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
