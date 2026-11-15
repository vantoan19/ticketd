import { Bell } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";
import { invoke } from "@/lib/api/bridge-failure";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldError } from "@/components/ui/field";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { formatDateTime } from "@/lib/format";
import { reminderSummary } from "@/features/tickets/reminder-summary";

/**
 * Whether the field holds a whole date and time yet. While a year is still being
 * typed the field reports years such as 0006; that is unfinished, not invalid.
 */
function complete(value: string): boolean {
  const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}$/.exec(value);
  return match !== null && Number(match[1]) >= 1000;
}

// A local clock time may be skipped or occur twice during a time-zone transition.
function localInstants(value: string): Date[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return [];
  const [, y, m, d, h, min] = match;
  const utc = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(h),
    Number(min),
  );
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta++)
    offsets.add(new Date(utc + delta * 3600000).getTimezoneOffset());
  return [...offsets]
    .map((offset) => new Date(utc + offset * 60000))
    .filter(
      (date) =>
        date.getFullYear() === Number(y) &&
        date.getMonth() === Number(m) - 1 &&
        date.getDate() === Number(d) &&
        date.getHours() === Number(h) &&
        date.getMinutes() === Number(min),
    )
    .sort((a, b) => a.getTime() - b.getTime());
}
function offsetLabel(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  return `UTC${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}

export function Reminder({
  reference,
  revision,
  variant = "ghost",
}: {
  reference: string;
  revision: number;
  variant?: "ghost" | "outline";
}) {
  const [due, setDue] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const options = localInstants(draft);
  // A whole date and time that does not exist here: the clock skips it.
  const skipped = complete(draft) && options.length === 0;
  // Reading and changing the reminder fail separately: a failed read names
  // the trigger, a failed change shows under the buttons until the next try.
  const [loadFailure, setLoadFailure] = useState<FailureDescription | null>(
    null,
  );
  const [error, setError] = useState<FailureDescription | null>(null);
  const [reads, setReads] = useState(0);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const busy = useRef(false);
  const attempt = useRef<{
    key: string;
    id: string;
    dueAt: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void invoke("reminder", { reference })
      .then((value) => {
        if (value !== null && typeof value !== "string")
          throw new Error("Invalid reminder");
        if (active) {
          setDue(value);
          setLoadFailure(null);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setLoadFailure(describeFailure(reason, "load the reminder"));
      });
    return () => {
      active = false;
    };
  }, [reference, revision, reads]);
  async function save(
    key: string,
    makeDue: () => string | null,
    closeAfter = false,
  ) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const intent = JSON.stringify([reference, key]);
    if (attempt.current?.key !== intent) {
      attempt.current = {
        key: intent,
        id: crypto.randomUUID(),
        dueAt: makeDue(),
      };
    }
    const request = attempt.current;
    try {
      await invoke("set_reminder", {
        reference,
        dueAt: request.dueAt,
        requestId: request.id,
      });
      const value: unknown = await invoke("reminder", { reference });
      if (value !== null && typeof value !== "string")
        throw new Error("Invalid reminder");
      setDue(value);
      attempt.current = null;
      setError(null);
      setLoadFailure(null);
      // The time was used; nothing typed is left to explain.
      setDraft("");
      setOccurrence("");
      // Dismissing is final: nothing is left to change, so the popover goes.
      if (closeAfter) setOpen(false);
    } catch (reason) {
      setError(
        describeFailure(
          reason,
          key === "dismiss"
            ? "dismiss the reminder"
            : key === "snooze-hour"
              ? "snooze the reminder"
              : "set the reminder",
        ),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A failure belongs to the attempt that made it, not the next visit.
        if (!next) setError(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={variant}
          size="sm"
          aria-label={
            due
              ? reminderSummary(due) === "Reminder due"
                ? "Manage reminder, due"
                : `Manage reminder, scheduled ${reminderSummary(due)}`
              : loadFailure
                ? "Manage reminder, unavailable"
                : "Manage reminder"
          }
        >
          <Bell data-icon="inline-start" />
          <span className="reminder-label">
            {due
              ? reminderSummary(due)
              : loadFailure
                ? "Reminder unavailable"
                : "Remind me…"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="reminder-popover">
        <PopoverHeader>
          <PopoverTitle>Reminder</PopoverTitle>
          <PopoverDescription>
            Bring this ticket back to your inbox.
          </PopoverDescription>
        </PopoverHeader>
        {due && (
          <p>
            {reminderSummary(due) === "Reminder due"
              ? "Due since"
              : "Scheduled:"}{" "}
            {formatDateTime(due)}
          </p>
        )}
        <label htmlFor="reminder-time">Local reminder date and time</label>
        <Input
          id="reminder-time"
          type="datetime-local"
          disabled={pending}
          value={draft}
          aria-invalid={skipped || undefined}
          aria-describedby={skipped ? "reminder-time-error" : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setOccurrence("");
          }}
        />
        <p className="text-muted-foreground text-xs">Your local time zone.</p>
        {skipped && (
          <FieldError id="reminder-time-error">
            The clock skips this time here. Choose another time.
          </FieldError>
        )}
        {options.length > 1 && (
          <label>
            Clock change: choose which occurrence
            <select
              value={occurrence}
              disabled={pending}
              onChange={(e) => setOccurrence(e.target.value)}
            >
              <option value="">Choose an offset</option>
              {options.map((date) => (
                <option key={date.toISOString()} value={date.toISOString()}>
                  {offsetLabel(date)}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          size="sm"
          disabled={
            pending ||
            options.length === 0 ||
            (options.length > 1 && !occurrence)
          }
          onClick={() => {
            const selected = occurrence || options[0]!.toISOString();
            void save(`schedule:${selected}`, () => selected);
          }}
        >
          {due ? "Reschedule reminder" : "Set reminder"}
        </Button>
        {due && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void save("snooze-hour", () =>
                  new Date(Date.now() + 3600000).toISOString(),
                )
              }
            >
              Snooze 1 hour
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void save("dismiss", () => null, true)}
            >
              Dismiss reminder
            </Button>
          </>
        )}
        {loadFailure && !due && (
          <FailureAlert
            size="compact"
            failure={loadFailure}
            onRetry={() => setReads((value) => value + 1)}
          />
        )}
        {error && <FailureAlert size="compact" failure={error} />}
      </PopoverContent>
    </Popover>
  );
}
