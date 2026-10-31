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
      typeof e.read !== "boolean"
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
    };
  });
}
export function Inbox({
  revision,
  select,
}: {
  revision: number;
  select: (reference: string) => void;
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
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            <button onClick={() => select(e.reference)}>
              {e.reference} · {e.title}
            </button>{" "}
            · {e.kind}: {e.from_value} → {e.to_value} · {e.timestamp} ·{" "}
            <span>{e.read ? "Read" : "Unread"}</span>{" "}
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
      <Button variant="outline" size="sm" onClick={() => void toggle()}>
        {following ? "Unfollow" : "Follow"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
