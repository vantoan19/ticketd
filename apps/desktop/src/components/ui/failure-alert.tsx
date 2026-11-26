import { useId, useState, type ReactNode, type Ref } from "react";
import { Check, ChevronRight, Copy, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusLabel } from "@/components/ui/status-label";
import { useCopy } from "@/components/ui/use-copy";
import type { FailureDescription } from "@/lib/api/describe-failure";

/**
 * "Details": a ghost toggle that reveals the raw failure text in 12px mono with
 * "Copy details". The raw text never appears anywhere else.
 * Not the shared Disclosure: its toggle sits in an action row beside Retry
 * while the text opens below, and the text is not mounted until asked for.
 */
export function FailureDetails({
  details,
  small = false,
  variant = "inline",
  className,
  iconOnly = false,
}: {
  iconOnly?: boolean;
  details: string;
  /** A 24px toggle for caption lines. */
  small?: boolean;
  /** A lasting band opens details over content without changing its height. */
  variant?: "inline" | "popover";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { copied, error, copy } = useCopy();
  if (!details) return null;
  const trigger = iconOnly ? (
    <IconButton
      type="button"
      label="Details"
      size="icon-card"
      aria-expanded={open}
      aria-controls={id}
      {...(variant === "inline" && {
        onClick: () => setOpen((value) => !value),
      })}
    >
      <ChevronRight aria-hidden className={open ? "rotate-90" : undefined} />
    </IconButton>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size={small ? "xs" : "sm"}
      aria-expanded={open}
      aria-controls={id}
      {...(variant === "inline" && {
        onClick: () => setOpen((value) => !value),
      })}
    >
      <ChevronRight aria-hidden className={open ? "rotate-90" : undefined} />
      Details
    </Button>
  );
  const content = (
    <div id={id} className={cn("ui-failure-details", className)}>
      <pre>{details}</pre>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void copy("Details", details)}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied" : "Copy details"}
      </Button>
      {error && (
        <span role="status" className="ui-failure-details-note">
          Copy unavailable. Select the text.
        </span>
      )}
    </div>
  );
  return variant === "popover" ? (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" aria-label="Failure details">
        {content}
      </PopoverContent>
    </Popover>
  ) : (
    <>
      {trigger}
      {open && content}
    </>
  );
}

function RetryButton({
  failure,
  onRetry,
  variant = "ghost",
  label,
}: {
  failure: FailureDescription;
  label?: string;
  onRetry: (() => void) | undefined;
  variant?: "ghost" | "outline" | "link";
}) {
  if (!onRetry || failure.action !== "retry") return null;
  return (
    <Button
      type="button"
      variant={variant}
      size={variant === "link" ? "xs" : "sm"}
      onClick={onRetry}
      {...(label && { "aria-label": label })}
    >
      Retry
    </Button>
  );
}

/**
 * The action-failure recipe: an error Alert at the place that failed, titled
 * "Couldn't {verb} {object}", one plain sentence, Retry only when retrying can
 * succeed (or the fix the caller passes as `actions`), and Details with the raw
 * text. `compact` is one row for dense places.
 */
export function FailureAlert({
  failure,
  onRetry,
  actions,
  size = "default",
  className,
  ref,
}: {
  failure: FailureDescription;
  ref?: Ref<HTMLDivElement>;
  onRetry?: () => void;
  /** The fix when Retry cannot help, such as "Change limit". */
  actions?: ReactNode;
  size?: "default" | "compact";
  className?: string;
}) {
  if (size === "compact")
    return (
      <Alert
        ref={ref}
        tone="error"
        size="compact"
        data-slot="failure-alert"
        className={cn("flex-wrap", className)}
      >
        <AlertDescription>
          <span className="ui-notice-title-inline">{failure.title}.</span>{" "}
          {failure.sentence}
        </AlertDescription>
        <RetryButton failure={failure} onRetry={onRetry} />
        {actions}
        <FailureDetails details={failure.details} />
      </Alert>
    );
  return (
    <Alert
      ref={ref}
      tone="error"
      data-slot="failure-alert"
      className={className}
    >
      <AlertTitle>{failure.title}</AlertTitle>
      <AlertDescription>{failure.sentence}</AlertDescription>
      <AlertActions>
        <RetryButton failure={failure} onRetry={onRetry} />
        {actions}
        <FailureDetails details={failure.details} />
      </AlertActions>
    </Alert>
  );
}

/**
 * A region that could not load: in place of its content, an alert icon,
 * "Couldn't load {things}", the plain cause, Retry and Details. It never claims
 * the region is empty. `inline` is one caption line for a section or rail row.
 * TODO(R2.1): adopt the shared IconTile once EmptyState gains it.
 */
export function FailureState({
  failure,
  onRetry,
  actions,
  size = "block",
  label,
  detailsVariant = "inline",
  className,
}: {
  failure: FailureDescription;
  onRetry?: () => void;
  actions?: ReactNode;
  size?: "block" | "inline";
  /** Short visible wording when the full title is available in Details. */
  label?: string;
  /** Stable rows open Details over content rather than inserting it. */
  detailsVariant?: "inline" | "popover";
  className?: string;
}) {
  if (size === "inline")
    return (
      <div
        role="alert"
        data-slot="failure-state"
        data-size="inline"
        className={cn("ui-failure-inline", className)}
      >
        <StatusLabel tone="attention" size="caption">
          {label ?? failure.title}
        </StatusLabel>
        <span className="sr-only">
          {label && `${failure.title}. `}
          {failure.sentence}
        </span>
        <RetryButton failure={failure} onRetry={onRetry} variant="link" />
        {actions}
        <FailureDetails
          small
          variant={detailsVariant}
          details={`${label ? `${failure.title}. ` : ""}${failure.sentence}\n\n${failure.details}`}
        />
      </div>
    );
  return (
    <div
      role="alert"
      data-slot="failure-state"
      data-size="block"
      className={cn("ui-failure-state", className)}
    >
      <span aria-hidden="true" className="ui-failure-state-icon">
        <TriangleAlert />
      </span>
      <p className="ui-failure-state-title">{failure.title}</p>
      <p className="ui-failure-state-sentence">{failure.sentence}</p>
      <div className="ui-failure-state-actions">
        <RetryButton failure={failure} onRetry={onRetry} variant="outline" />
        {actions}
        <FailureDetails details={failure.details} />
      </div>
    </div>
  );
}

/**
 * Save state for dense rows and the rail: "● Not saved · Retry" on one caption
 * line, the plain cause for screen readers and under Details with the raw
 * text. Nothing else in the row turns red.
 */
export function FailureCaption({
  failure,
  onRetry,
  label = "Not saved",
  className,
  detailsVariant = "inline",
  retryLabel,
  detailsIconOnly = false,
  showSentence = false,
}: {
  detailsIconOnly?: boolean;
  showSentence?: boolean;
  detailsVariant?: "inline" | "popover";
  retryLabel?: string;
  failure: FailureDescription;
  onRetry?: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-slot="failure-caption"
      className={cn("ui-failure-inline", className)}
    >
      <StatusLabel tone="attention" size="caption">
        {showSentence ? (
          <span className="whitespace-normal">
            {failure.title}. {failure.sentence}
          </span>
        ) : (
          label
        )}
      </StatusLabel>
      {!showSentence && (
        <span className="sr-only">
          {failure.title}. {failure.sentence}
        </span>
      )}
      {onRetry && failure.action === "retry" && (
        <>
          <span aria-hidden="true" className="ui-failure-inline-separator">
            ·
          </span>
          <RetryButton
            failure={failure}
            onRetry={onRetry}
            variant="link"
            {...(retryLabel && { label: retryLabel })}
          />
        </>
      )}
      <FailureDetails
        small
        iconOnly={detailsIconOnly}
        variant={detailsVariant}
        details={`${failure.sentence}\n\n${failure.details}`}
      />
    </div>
  );
}
