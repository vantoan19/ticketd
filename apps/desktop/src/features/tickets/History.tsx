import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { historyClient, type Entry } from "@/lib/api/history";
import { useEffect, useState } from "react";
import type { Project } from "@/lib/api/client";

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
    void historyClient
      .list(reference)
      .then((result) => {
        if (active) setEntries(result);
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
      await historyClient.changeStatus(reference, value);
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
      <div className="status-control">
        <span>Status</span>
        <Select
          value={status}
          disabled={trashed}
          onValueChange={(value) => void changeStatus(value)}
        >
          <SelectTrigger aria-label="Status" className="status-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="status-options">
            {["Todo", "In progress", "In review", "Done", "Canceled"].map(
              (value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </div>
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
