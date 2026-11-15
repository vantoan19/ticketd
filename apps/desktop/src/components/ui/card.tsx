import * as React from "react";
import { cn } from "cn";
import { Slot } from "radix-ui";

type Props = React.ComponentProps<"div"> & { asChild?: boolean };

/**
 * The elevated surface for content that has an owner or a boundary: an
 * external source's description or comment, a settings group, a project.
 * Compose `CardHeader` (a 40px band), `CardBody` and `CardFooter`; `asChild`
 * lends a part's look to the element that carries its landmark or label.
 */
function Card({
  variant = "default",
  className,
  asChild = false,
  ...props
}: Props & {
  variant?: "default" | "well" | "slot" | "lift" | "board" | "triage";
}) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card"
      data-variant={variant}
      className={cn("ui-card", `ui-card-${variant}`, className)}
      {...props}
    />
  );
}
/** The band that names the card: its title or owner at the start, actions at the end. */
function CardHeader({ className, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-header"
      className={cn("ui-card-header", className)}
      {...props}
    />
  );
}
function CardBody({ className, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-body"
      className={cn("ui-card-body", className)}
      {...props}
    />
  );
}
/** A recessed strip for the card's explanation or actions. */
function CardFooter({ className, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-footer"
      className={cn("ui-card-footer", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardBody, CardFooter };
