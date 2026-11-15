import { Bell, CalendarClock } from "lucide-react";
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
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { ChoiceList } from "@/components/ui/choice-list";
import { Picker } from "@/components/ui/picker";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { formatDateTime, formatTime } from "@/lib/format";
import { reminderSummary } from "@/features/tickets/reminder-summary";
import { reminderPresets } from "./reminder-presets";

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
  const sign = minutes >= 0 ? "+" : "−";
  return `UTC${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}

/** "Bangkok (UTC+07:00)": the zone the reminder's time is read in. */
function zoneLabel(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const place = zone?.split("/").pop()?.replaceAll("_", " ");
  return place
    ? `${place} (${offsetLabel(now)})`
    : `Your local time (${offsetLabel(now)})`;
}

/** The value a datetime-local field shows for an instant, in local time. */
function localValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The ticket's reminder: a trigger in the rail's Attention row ("Remind me"
 * or "Tomorrow, 9:00 AM") or a bell in the property strip, and a popover
 * that leads with presets (Later today, Tomorrow, Next week) and Custom…,
 * which reveals a prefilled date and time named in the person's zone. A
 * scheduled reminder offers Snooze 1 hour and Dismiss.
 */
export function Reminder({
  reference,
  revision,
  variant = "rail",
}: {
  reference: string;
  revision: number;
  variant?: "rail" | "strip";
}) {
  const [due, setDue] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const options = localInstants(draft);
  // A whole date and time that does not exist here: the clock skips it.
  const skipped = complete(draft) && options.length === 0;
  // Reading and changing the reminder fail separately: a failed read names
  // the trigger, a failed change shows under the actions until the next try.
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
      setCustom(false);
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
  const now = new Date();
  const summary = due ? reminderSummary(due) : null;
  const label = summary ?? (loadFailure ? "Reminder unavailable" : "Remind me");
  const name = due
    ? summary === "Reminder due"
      ? "Manage reminder, due"
      : `Manage reminder, scheduled ${summary}`
    : loadFailure
      ? "Manage reminder, unavailable"
      : "Manage reminder";
  function openCustom() {
    setCustom(true);
    // Prefilled: the scheduled time, or tomorrow at 9:00.
    const fallback = reminderPresets(now).find(
      (preset) => preset.key === "tomorrow",
    )!.at;
    setDraft(localValue(due ? new Date(due) : fallback));
    setOccurrence("");
  }
  const presets = reminderPresets(now);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A failure belongs to the attempt that made it, not the next visit.
        if (!next) {
          setError(null);
          setCustom(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        {variant === "strip" ? (
          <IconButton
            label={summary ?? label}
            aria-label={name}
            aria-pressed={due !== null}
          >
            <Bell aria-hidden="true" />
          </IconButton>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={name}
            data-set={due ? "" : undefined}
          >
            <Bell aria-hidden="true" />
            <span className="reminder-label">{label}</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="reminder-popover">
        <PopoverHeader>
          <PopoverTitle>Reminder</PopoverTitle>
          <PopoverDescription>
            {due
              ? summary === "Reminder due"
                ? `Due since ${formatDateTime(due)}.`
                : `Scheduled for ${formatDateTime(due)}.`
              : "Bring this ticket back to your Inbox."}
          </PopoverDescription>
        </PopoverHeader>
        <ChoiceList
          label="Remind me"
          autoFocus={false}
          groups={[
            ...presets.map((preset) => ({
              value: preset.key,
              label: preset.label,
              icon: preset.icon,
              meta: preset.meta,
              disabled: pending,
            })),
            {
              value: "custom",
              label: "Custom…",
              icon: <CalendarClock aria-hidden="true" />,
              disabled: pending,
            },
          ]}
          onSelect={(key) => {
            if (key === "custom") return openCustom();
            const preset = presets.find((item) => item.key === key);
            if (preset) {
              const at = preset.at.toISOString();
              void save(`preset:${at}`, () => at);
            }
          }}
        />
        {custom && (
          <Field>
            <FieldLabel htmlFor={`reminder-time-${reference}`}>
              Date and time
            </FieldLabel>
            <Input
              id={`reminder-time-${reference}`}
              type="datetime-local"
              disabled={pending}
              value={draft}
              aria-invalid={skipped || undefined}
              aria-describedby={
                skipped
                  ? `reminder-time-error-${reference}`
                  : `reminder-zone-${reference}`
              }
              onChange={(e) => {
                setDraft(e.target.value);
                setOccurrence("");
              }}
            />
            {skipped ? (
              <FieldError id={`reminder-time-error-${reference}`}>
                The clock skips this time here. Choose another time.
              </FieldError>
            ) : (
              <FieldDescription id={`reminder-zone-${reference}`}>
                {zoneLabel(now)}
              </FieldDescription>
            )}
            {options.length > 1 && (
              <Picker
                stacked
                label="Clock change"
                value={occurrence || "none"}
                disabled={pending}
                onValueChange={(value) =>
                  setOccurrence(value === "none" ? "" : value)
                }
                options={[
                  ...(occurrence
                    ? []
                    : [{ value: "none", label: "Choose which one" }]),
                  ...options.map((date) => ({
                    value: date.toISOString(),
                    label: `${formatTime(date)} (${offsetLabel(date)})`,
                  })),
                ]}
              />
            )}
          </Field>
        )}
        {(custom || due) && (
          <div className="reminder-actions">
            {due && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
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
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void save("dismiss", () => null, true)}
                >
                  Dismiss reminder
                </Button>
              </>
            )}
            {custom && (
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
                {due ? "Reschedule" : "Set reminder"}
              </Button>
            )}
          </div>
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
