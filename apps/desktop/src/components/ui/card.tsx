import * as React from "react";
import { cn } from "cn";
import { Slot } from "radix-ui";

type Props = React.ComponentProps<"div"> & { asChild?: boolean };

function part(slot: string, base: string) {
  return function Part({ className, asChild = false, ...props }: Props) {
    const Comp = asChild ? Slot.Root : "div";
    return <Comp data-slot={slot} className={cn(base, className)} {...props} />;
  };
}

/**
 * The elevated surface for content that has an owner or a boundary: an
 * external source's description or comment, a settings group, a project.
 * Compose `CardHeader` (a 40px band), `CardBody` and `CardFooter`; `asChild`
 * lends a part's look to the element that carries its landmark or label.
 */
const Card = part("card", "ui-card");
/** The band that names the card: its title or owner at the start, actions at the end. */
const CardHeader = part("card-header", "ui-card-header");
const CardBody = part("card-body", "ui-card-body");
/** A recessed strip for the card's explanation or actions. */
const CardFooter = part("card-footer", "ui-card-footer");

export { Card, CardHeader, CardBody, CardFooter };
