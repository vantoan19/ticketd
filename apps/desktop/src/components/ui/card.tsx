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
  variant?: "default" | "well" | "slot" | "lift" | "board" | "summary";
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
function CardFooter({
  className,
  asChild = false,
  variant = "default",
  ...props
}: Props & { variant?: "default" | "summary" }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-footer"
      className={cn(
        "ui-card-footer",
        variant === "summary" && "ui-card-footer-summary",
        className,
      )}
      {...props}
    />
  );
}

/** Shared content roles for summaries of records, independent of their feature. */
function CardTitle({ className, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-title"
      className={cn("ui-card-title", className)}
      {...props}
    />
  );
}
function CardValue({ className, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-value"
      className={cn("ui-card-value", className)}
      {...props}
    />
  );
}
function CardCaption({ className, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-caption"
      className={cn("ui-card-caption", className)}
      {...props}
    />
  );
}
function CardDescription({ className, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-description"
      className={cn("ui-card-description", className)}
      {...props}
    />
  );
}
export {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  CardTitle,
  CardValue,
  CardCaption,
  CardDescription,
};
