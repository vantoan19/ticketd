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
  hideTooltip,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "aria-label" | "children"> & {
  label: string;
  children: React.ReactNode;
  /** Keeps the tooltip closed, for example once the button's menu item opened a dialog. */
  hideTooltip?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <TooltipProvider>
      <Tooltip
        {...(hideTooltip !== undefined && {
          open: open && !hideTooltip,
          onOpenChange: setOpen,
        })}
      >
        <TooltipTrigger asChild>
          <Button aria-label={label} variant={variant} size={size} {...props} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { IconButton };
