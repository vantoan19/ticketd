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
 * as the child of a menu or popover trigger (`asChild`). `shortcut`, when
 * given, follows the label in the tooltip only ("Stop · Esc"); pair it with
 * `aria-keyshortcuts` for assistive technology.
 */
// A tooltip only labels. It must not open, or outlive the moment, a menu or
// dialog is layered over its trigger: a menu item that opens a dialog returns
// focus to the trigger, which would otherwise show the label over the dialog.
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"]';

function IconButton({
  label,
  variant = "ghost",
  size = "icon-sm",
  shortcut,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "aria-label" | "children"> & {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const observer = new MutationObserver(() => {
      if (typeof document !== "undefined" && document.querySelector(OVERLAY))
        setOpen(false);
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [open]);
  return (
    <TooltipProvider>
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          if (next && document.querySelector(OVERLAY)) return;
          setOpen(next);
        }}
      >
        <TooltipTrigger asChild>
          <Button aria-label={label} variant={variant} size={size} {...props} />
        </TooltipTrigger>
        <TooltipContent>
          {shortcut ? `${label} · ${shortcut}` : label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { IconButton };
