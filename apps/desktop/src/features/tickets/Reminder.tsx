import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  async function save(dueAt: string | null) {
    try {
      await invoke("set_reminder", {
        reference,
        dueAt,
        requestId: crypto.randomUUID(),
      });
      const value: unknown = await invoke("reminder", { reference });
      if (value !== null && typeof value !== "string")
        throw new Error("Invalid reminder");
      setDue(value);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div>
      {due && <p>Scheduled: {new Date(due).toLocaleString()}</p>}
      <label htmlFor="reminder-time">Local reminder date and time</label>
      <Input
        id="reminder-time"
        type="datetime-local"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOccurrence("");
        }}
      />
      <p>
        Uses your computer’s local time zone. The selected time is saved as an
        instant with a UTC offset.
      </p>
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
        disabled={options.length === 0 || (options.length > 1 && !occurrence)}
        onClick={() => void save(occurrence || options[0]!.toISOString())}
      >
        {due ? "Reschedule reminder" : "Set reminder"}
      </Button>
      {due && (
        <Button size="sm" variant="outline" onClick={() => void save(null)}>
          Dismiss reminder
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
