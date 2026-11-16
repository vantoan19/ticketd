import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { StatusDot } from "@/components/ui/status-dot";

const alertVariants = cva("ui-notice", {
  variants: {
    presentation: {
      inline: "",
      floating: "ui-notice-floating",
      hint: "ui-notice-hint",
    },
    tone: {
      neutral: "",
      attention: "",
      error: "ui-notice-error",
    },
    size: {
      default: "",
      compact: "ui-notice-compact",
    },
    flat: {
      true: "ui-notice-flat",
      false: "",
    },
  },
  defaultVariants: {
    presentation: "inline",
    tone: "neutral",
    size: "default",
    flat: false,
  },
});

type Tone = NonNullable<VariantProps<typeof alertVariants>["tone"]>;

const ToneContext = React.createContext<Tone>("neutral");

/**
 * The one inline notice: an optional title, one sentence and its actions.
 * `neutral` is context, `attention` puts a status dot in the title (a source
 * is unavailable, an outcome is unknown) and `error` is a failure. `compact`
 * is a single row for a short sentence. `flat` draws it as a section of a
 * surface that already has the ring (the Chat's tray, a popover): no fill,
 * ring or radius, and an error's sentence stays muted, only its title in the
 * error colour. It is `role="alert"` unless the caller passes another role,
 * such as `status` for a calm update. `presentation="floating"` takes the
 * place of a floating action bar and wraps its full failure explanation.
 */
function Alert({
  className,
  tone = "neutral",
  size = "default",
  flat = false,
  presentation = "inline",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <ToneContext value={tone ?? "neutral"}>
      <div
        data-slot="alert"
        data-tone={tone}
        role="alert"
        className={cn(
          alertVariants({ tone, size, flat, presentation }),
          className,
        )}
        {...props}
      />
    </ToneContext>
  );
}

/** The notice’s title; `level` makes it a heading where the notice replaced one. */
function AlertTitle({
  className,
  children,
  level,
  ...props
}: React.ComponentProps<"div"> & { level?: 2 | 3 | 4 }) {
  const tone = React.use(ToneContext);
  const Title = level ? (`h${level}` as const) : "div";
  return (
    <Title
      data-slot="alert-title"
      className={cn("ui-notice-title", className)}
      {...props}
    >
      {tone === "attention" && <StatusDot tone="attention" size={10} />}
      {children}
    </Title>
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("ui-notice-description", className)}
      {...props}
    />
  );
}

/** The notice's real buttons, in a wrapping row. */
function AlertActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-actions"
      className={cn("ui-notice-actions", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertActions };
