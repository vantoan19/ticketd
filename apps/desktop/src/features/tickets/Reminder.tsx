import { Bell } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reminderSummary } from "@/features/tickets/reminder-summary";

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
}: {
  reference: string;
  revision: number;
}) {
  const [due, setDue] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const options = localInstants(draft);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
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
        if (active) setDue(value);
      })
      .catch((e: unknown) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [reference, revision]);
  async function save(key: string, makeDue: () => string | null) {
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
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            due
              ? reminderSummary(due) === "Reminder due"
                ? "Manage reminder, due"
                : `Manage reminder, scheduled ${reminderSummary(due)}`
              : "Manage reminder"
          }
        >
          <Bell data-icon="inline-start" />
          {due ? reminderSummary(due) : "Remind me"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="reminder-popover">
        <PopoverHeader>
          <PopoverTitle>Reminder</PopoverTitle>
          <PopoverDescription>
            Bring this ticket back to your inbox.
          </PopoverDescription>
        </PopoverHeader>
        {due && <p>Scheduled: {new Date(due).toLocaleString()}</p>}
        <label htmlFor="reminder-time">Local reminder date and time</label>
        <Input
          id="reminder-time"
          type="datetime-local"
          disabled={pending}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOccurrence("");
          }}
        />
        <p className="text-muted-foreground text-xs">Your local time zone.</p>
        {draft && options.length === 0 && (
          <p role="alert">
            This local time is invalid or skipped by a clock change. Choose
            another time.
          </p>
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
              onClick={() => void save("dismiss", () => null)}
            >
              Dismiss reminder
            </Button>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
