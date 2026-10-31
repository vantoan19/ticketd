import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Entry = {
  id: number;
  reference: string;
  title: string;
  kind: string;
  from_value: string;
  to_value: string;
  timestamp: string;
  read: boolean;
  editing_agent: string | null;
};
function parseEntries(value: unknown): Entry[] {
  if (!Array.isArray(value))
    throw new Error("Invalid inbox returned by workspace");
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null)
      throw new Error("Invalid inbox entry");
    const e = item as Record<string, unknown>;
    if (
      typeof e.id !== "number" ||
      typeof e.reference !== "string" ||
      typeof e.title !== "string" ||
      typeof e.kind !== "string" ||
      typeof e.from_value !== "string" ||
      typeof e.to_value !== "string" ||
      typeof e.timestamp !== "string" ||
      typeof e.read !== "boolean" ||
      (e.editing_agent !== null &&
        e.editing_agent !== undefined &&
        typeof e.editing_agent !== "string")
    )
      throw new Error("Invalid inbox entry");
    return {
      id: e.id,
      reference: e.reference,
      title: e.title,
      kind: e.kind,
      from_value: e.from_value,
      to_value: e.to_value,
      timestamp: e.timestamp,
      read: e.read,
      editing_agent:
        typeof e.editing_agent === "string" ? e.editing_agent : null,
    };
  });
}
function readableTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function eventDescription(e: Entry) {
  const target = e.to_value || e.from_value;
  const action = e.to_value ? "Added" : "Removed";
  switch (e.kind) {
    case "reminder":
      return `Reminder due ${readableTime(e.to_value)}`;
    case "note":
      return `New note: ${e.to_value}`;
    case "status":
      return `Status changed from ${e.from_value} to ${e.to_value}`;
    case "parent":
      return `${action} parent ${target}`;
    case "dependency":
      return `${action} prerequisite ${target}`;
    case "relationship:blocks":
      return `${action} dependent ${target}`;
    case "relationship:related":
      return `${action} related ticket ${target}`;
    case "relationship:discovery":
      return `${action} discovered ticket ${target}`;
    case "relationship:discovered-while":
      return `${action} discovery source ${target}`;
    case "relationship:duplicate":
      return e.to_value
        ? `Marked duplicate of ${e.to_value}`
        : `Duplicate link to ${e.from_value} removed`;
    default:
      return `Ticket relationship changed: ${target}`;
  }
}
export function Inbox({
  revision,
  select,
}: {
  revision: number;
  select: (reference: string, noteId?: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    try {
      setEntries(parseEntries(await invoke("inbox", { offset })));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [offset]);
  useEffect(() => {
    let active = true;
    void invoke("inbox", { offset })
      .then(parseEntries)
      .then(
        (items) => {
          if (active) {
            setEntries(items);
            setError("");
          }
        },
        (error: unknown) => {
          if (active) setError(String(error));
        },
      );
    return () => {
      active = false;
    };
  }, [offset, revision]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function mark(ids: number[], read: boolean) {
    try {
      await invoke("set_inbox_read", {
        ids,
        read,
        requestId: crypto.randomUUID(),
      });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="management">
      <h1>Attention inbox</h1>
      <Button
        disabled={!entries.some((e) => !e.read)}
        onClick={() =>
          void mark(
            entries.filter((e) => !e.read).map((e) => e.id),
            true,
          )
        }
      >
        Mark displayed read
      </Button>
      {error && <p role="alert">{error}</p>}
      <ul className="inbox-entries">
        {entries.map((e) => (
          <li key={e.id} className="inbox-entry">
            <div>
              <button
                className="inbox-ticket"
                onClick={() =>
                  e.kind === "note"
                    ? select(e.reference, e.from_value)
                    : select(e.reference)
                }
              >
                {e.reference} · {e.title}
              </button>
              <p>{eventDescription(e)}</p>
              <p className="inbox-meta">
                <time dateTime={e.timestamp}>{readableTime(e.timestamp)}</time>
                {e.editing_agent && ` · Agent: ${e.editing_agent}`} ·{" "}
                <span>{e.read ? "Read" : "Unread"}</span>
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void mark([e.id], !e.read)}
            >
              Mark {e.read ? "unread" : "read"}
            </Button>
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p>No inbox entries.</p>}
      <Button
        disabled={offset === 0}
        onClick={() => setOffset(Math.max(0, offset - 100))}
      >
        Newer
      </Button>
      <Button
        disabled={entries.length < 100}
        onClick={() => setOffset(offset + 100)}
      >
        Older
      </Button>
    </div>
  );
}
export function Follow({
  reference,
  revision,
}: {
  reference: string;
  revision: number;
}) {
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void invoke("is_following", { reference })
      .then((value) => {
        if (typeof value !== "boolean") throw new Error("Invalid follow state");
        if (active) {
          setFollowing(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [reference, revision]);
  async function toggle() {
    try {
      await invoke("set_following", {
        reference,
        following: !following,
        requestId: crypto.randomUUID(),
      });
      setFollowing(!following);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={following}
        onClick={() => void toggle()}
      >
        {following ? "Unfollow" : "Follow"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
