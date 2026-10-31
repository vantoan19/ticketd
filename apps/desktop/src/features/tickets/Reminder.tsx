import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Reminder({
  reference,
  revision,
}: {
  reference: string;
  revision: number;
}) {
  const [due, setDue] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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
      {due && (
        <p>
          Scheduled: {new Date(due).toLocaleString()} ({due})
        </p>
      )}
      <label htmlFor="reminder-time">Reminder time with offset</label>
      <Input
        id="reminder-time"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="2030-01-01T12:00:00+07:00"
      />
      <p>
        Use an ISO 8601 time with an explicit UTC offset, such as +07:00 or Z.
      </p>
      <Button size="sm" onClick={() => void save(draft)}>
        {due ? "Reschedule reminder" : "Set reminder"}
      </Button>
      {due && (
        <>
          <Button size="sm" variant="outline" onClick={() => void save(draft)}>
            Snooze until entered time
          </Button>
          <Button size="sm" variant="outline" onClick={() => void save(null)}>
            Dismiss reminder
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
