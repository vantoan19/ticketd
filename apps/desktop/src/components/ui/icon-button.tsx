import * as React from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * A button that shows only an icon. `label` is required: it is the accessible
 * name and the tooltip that appears on hover and keyboard focus (never on
 * focus returned by a closing menu or dialog). It also works as the child of a
 * menu or popover trigger (`asChild`). `shortcut`, when given, follows the
 * label in the tooltip as Kbd chips ("New ticket  C"); pair it with
 * `aria-keyshortcuts` for assistive technology. `tooltipSide` overrides the
 * region's side (TooltipSide): bottom in headers, right in the sidebar.
 */
function IconButton({
  label,
  variant = "ghost",
  size = "icon-sm",
  shortcut,
  tooltipSide,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "aria-label" | "children"> & {
  label: string;
  shortcut?: string | string[];
  tooltipSide?: "top" | "right" | "bottom" | "left";
  children: React.ReactNode;
}) {
  return (
    <Tooltip
      content={label}
      {...(shortcut !== undefined && { shortcut })}
      {...(tooltipSide && { side: tooltipSide })}
    >
      <Button aria-label={label} variant={variant} size={size} {...props} />
    </Tooltip>
  );
}

export { IconButton };
