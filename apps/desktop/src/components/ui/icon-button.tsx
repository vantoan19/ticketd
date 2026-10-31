import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A button that shows only an icon. `label` is required: it is the accessible
 * name and the tooltip that appears on hover and keyboard focus. It also works
 * as the child of a menu or popover trigger (`asChild`).
 */
function IconButton({
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "aria-label" | "children"> & {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label={label} variant={variant} size={size} {...props} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { IconButton };
