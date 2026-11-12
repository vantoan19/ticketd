import { Children, createContext, useContext, type ReactNode } from "react";
import { cn } from "cn";

const StepNumber = createContext(0);

/**
 * A numbered list of things to do in order, joined by a thin line. Compose
 * `Step`s as children; they are numbered from 1.
 */
export function Steps({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <ol
      data-slot="steps"
      className={cn("m-0 flex list-none flex-col p-0", className)}
    >
      {Children.toArray(children).map((child, index) => (
        <StepNumber.Provider key={index} value={index + 1}>
          {child}
        </StepNumber.Provider>
      ))}
    </ol>
  );
}

/**
 * One step: a title, an optional description and an `action` (a link or small
 * button) at the end of the title line. `state` marks a finished step "done"
 * or the one to do now "current"; the number carries the order and the
 * marker's color the state, so give a done or current step words as well
 * where the state matters.
 */
export function Step({
  title,
  description,
  action,
  state,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  state?: "done" | "current";
}) {
  const number = useContext(StepNumber);
  return (
    <li
      data-slot="step"
      data-state={state}
      aria-current={state === "current" ? "step" : undefined}
      className="relative flex gap-3.5 pb-5 last:pb-0"
    >
      <span
        aria-hidden="true"
        data-slot="step-number"
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs leading-4 tabular-nums",
          state === "done" && "bg-(--status-ready) text-(--primary-foreground)",
          state === "current" && "bg-primary text-primary-foreground",
          !state && "bg-(--surface)",
        )}
      >
        {number}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{title}</span>
          {action}
        </span>
        {description && (
          <span className="text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </li>
  );
}
