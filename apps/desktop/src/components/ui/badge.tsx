import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import { X } from "lucide-react";
import "./patterns.css";

const badgeVariants = cva("ui-badge", {
  variants: {
    variant: {
      tag: "",
      experimental: "ui-badge-experimental",
      source: "ui-badge-source",
      linked: "ui-badge-linked",
      doc: "ui-badge-doc",
      // 28px chip naming a record: icon or Reference, then a truncating title.
      record: "ui-badge-record",
      // 28px chip for one active filter; use FilterChip.
      filter: "ui-badge-filter",
    },
    size: {
      default: "",
      sm: "ui-badge-sm",
      "compact-responsive": "ui-badge-compact-responsive",
    },
    // `raised` sits on a recessed control, such as the property rail’s tag picker.
    tone: {
      default: "",
      raised: "ui-badge-raised",
    },
  },
  defaultVariants: {
    variant: "tag",
    size: "default",
    tone: "default",
  },
});

/**
 * The one look for a tag-like label: a ticket or Document tag (`tag`), an
 * external source reference such as #98 (`source`), a Document chip (`doc`,
 * 28px), a record chip (`record`, 28px, at most 280px: icon or Reference and
 * a truncating title; a remove × overlays its end on hover) or a filter chip
 * (`filter`, see FilterChip). `sm` fits inside ticket rows. A badge names
 * something; `asChild` lends the look to the link or button that opens it.
 */
function Badge({
  className,
  variant = "tag",
  size = "default",
  tone = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, size, tone }), className)}
      {...props}
    />
  );
}

/**
 * One active filter: "Status  In review", the dimension muted and the value
 * in the foreground, then a 16px × in a 24px hit area (a recorded exception
 * to the 32px target). Clicking the words edits the filter when `onEdit` is
 * given. `removeLabel` names the remove button ("Remove Status is Todo").
 */
function FilterChip({
  dimension,
  value,
  onEdit,
  onRemove,
  removeLabel,
}: {
  dimension: string;
  value: string;
  onEdit?: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  const words = (
    <>
      <span className="ui-badge-dimension">{dimension}</span>
      <span data-slot="badge-value">{value}</span>
    </>
  );
  return (
    <span
      data-slot="badge"
      data-variant="filter"
      className={badgeVariants({ variant: "filter" })}
    >
      {onEdit ? (
        <button type="button" data-slot="badge-edit" onClick={onEdit}>
          {words}
        </button>
      ) : (
        words
      )}
      <button
        type="button"
        data-slot="badge-remove"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </button>
    </span>
  );
}

export { Badge, FilterChip };
