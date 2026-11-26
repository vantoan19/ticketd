import { Check } from "lucide-react";
import "./patterns.css";
import {
  Children,
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { cn } from "cn";
import { enter } from "@/components/ui/enter";
import { DrawnPath } from "@/components/ui/motion";

/** A step's place in its list, and its step in the page's entrance if it has one. */
const StepPlace = createContext<{ number: number; enter?: number }>({
  number: 0,
});

/**
 * A numbered list of things to do in order, joined by a thin line. Compose
 * `Step`s as children; they are numbered from 1. On a page with its own
 * entrance (enter.ts), `enterFrom` makes the card arrive with its first step at
 * that step of the page's cascade and each later step follow in turn.
 */
export function Steps({
  className,
  children,
  variant = "default",
  enterFrom,
  label,
}: {
  variant?: "default" | "settings";
  className?: string;
  enterFrom?: number;
  /** Names the list for assistive technology, such as "Setup steps". */
  label?: string;
  children: ReactNode;
}) {
  return (
    <ol
      aria-label={label}
      {...(enterFrom !== undefined && enter(enterFrom))}
      data-slot="steps"
      data-variant={variant}
      className={cn("m-0 flex list-none flex-col p-0", className)}
    >
      {Children.toArray(children).map((child, index) => (
        <StepPlace.Provider
          key={index}
          value={{
            number: index + 1,
            ...(enterFrom !== undefined && { enter: enterFrom + index }),
          }}
        >
          {child}
        </StepPlace.Provider>
      ))}
    </ol>
  );
}

/**
 * One step: a title, an optional description and an `action` (a link or small
 * button) at the end of the title line. `state` marks a finished step "done"
 * or the one to do now "current"; the number carries the order and the
 * marker's color the state, so give a done or current step words as well
 * where the state matters. A state that is read asynchronously passes
 * `settled={false}` until the read is back, so a step that was already done
 * shows its check instead of drawing it.
 */
export function Step({
  title,
  description,
  action,
  state,
  settled = true,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  state?: "done" | "current";
  settled?: boolean;
  /** Content under the description, at the width of the step: a block to copy. */
  children?: ReactNode;
}) {
  const { number, enter: entering } = useContext(StepPlace);
  // A step that completes while it is on screen draws its check; one that was
  // already done when its state first settled just shows it.
  const [arrivedDone, setArrivedDone] = useState<boolean | null>(null);
  if (settled && arrivedDone === null) setArrivedDone(state === "done");
  const completes = arrivedDone === false;
  return (
    <li
      {...(entering !== undefined && enter(entering))}
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
        {state !== "done" ? (
          number
        ) : completes ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <DrawnPath d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <Check aria-hidden="true" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {state === "done" && <span className="sr-only">Completed: </span>}
            {title}
          </span>
          {action}
        </span>
        {description && (
          <span
            data-slot="step-description"
            className="text-xs leading-4 text-muted-foreground"
          >
            {description}
          </span>
        )}
        {children && (
          <div data-slot="step-extra" className="mt-3">
            {children}
          </div>
        )}
      </span>
    </li>
  );
}
