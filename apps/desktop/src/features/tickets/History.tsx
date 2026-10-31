import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { Project } from "@/lib/api/client";

type Entry = {
  kind: string;
  from_value: string;
  to_value: string;
  timestamp: string;
  editing_agent: string | null;
};
function parseEntries(value: unknown): Entry[] {
  if (!Array.isArray(value))
    throw new Error("Invalid history returned by workspace");
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null)
      throw new Error("Invalid history entry");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.kind !== "string" ||
      typeof entry.from_value !== "string" ||
      typeof entry.to_value !== "string" ||
      typeof entry.timestamp !== "string" ||
      !(entry.editing_agent === null || typeof entry.editing_agent === "string")
    )
      throw new Error("Invalid history entry");
    return {
      kind: entry.kind,
      from_value: entry.from_value,
      to_value: entry.to_value,
      timestamp: entry.timestamp,
      editing_agent: entry.editing_agent,
    };
  });
}
export function History({
  reference,
  status,
  revision,
  onChange,
  projects,
  trashed,
}: {
  reference: string;
  status: string;
  revision: number;
  onChange: () => Promise<void>;
  projects: Project[];
  trashed: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void invoke("ticket_history", { reference })
      .then((result: unknown) => {
        if (active) setEntries(parseEntries(result));
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [reference, status, revision]);
  async function changeStatus(value: string) {
    try {
      await invoke("change_ticket", { reference, patch: { status: value } });
      await onChange();
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }
  function historyValue(entry: Entry, value: string) {
    if (entry.kind !== "project") return value;
    return value
      ? (projects.find((project) => project.id === value)?.name ?? value)
      : "Unlinked";
  }
  return (
    <div className="history-block">
      <label>
        Status{" "}
        <select
          className="ml-2 rounded border p-1"
          value={status}
          disabled={trashed}
          onChange={(event) => void changeStatus(event.target.value)}
        >
          {["Todo", "In progress", "In review", "Done", "Canceled"].map(
            (value) => (
              <option key={value}>{value}</option>
            ),
          )}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <details className="detail-disclosure">
        <summary>Activity & history</summary>
        {entries.length === 0 ? (
          <p>No recorded changes.</p>
        ) : (
          <ol>
            {entries.map((entry, index) => (
              <li key={index}>
                {entry.kind}: {historyValue(entry, entry.from_value)} →{" "}
                {historyValue(entry, entry.to_value)} · {entry.timestamp} ·{" "}
                {entry.editing_agent ?? "Unknown"}
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}
