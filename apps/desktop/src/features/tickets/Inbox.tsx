import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  Check,
  Circle,
  Link2,
  MessageSquare,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusIcon } from "./StatusIcon";
import {
  entryNoun,
  entryTime,
  groupEntries,
  parseEntries,
  snoozeChoices,
  snoozeInstant,
  summarize,
  type Entry,
  type SnoozeChoice,
} from "./inboxModel";
import "./inbox.css";

const PAGE_SIZE = 50;
const MARK_BATCH = 100;

type InboxFilter = "all" | "unread";

async function fetchEntries(
  filter: InboxFilter,
  pages: number,
): Promise<{ entries: Entry[]; more: boolean }> {
  const entries: Entry[] = [];
  let more = false;
  for (let page = 0; page < pages; page++) {
    const chunk = parseEntries(
      await invoke("inbox", {
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        unreadOnly: filter === "unread",
      }),
    );
    entries.push(...chunk);
    more = chunk.length === PAGE_SIZE;
    if (!more) break;
  }
  return { entries, more };
}

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "reminder") return <AlarmClock aria-hidden="true" />;
  if (entry.kind === "note") return <MessageSquare aria-hidden="true" />;
  if (entry.kind === "status")
    return <StatusIcon status={entry.to_value} decorative />;
  return entry.kind.startsWith("relationship:") ||
    entry.kind === "parent" ||
    entry.kind === "dependency" ? (
    <Link2 aria-hidden="true" />
  ) : (
    <Circle aria-hidden="true" />
  );
}

function Snooze({
  entry,
  snooze,
}: {
  entry: Entry;
  snooze: (choice: SnoozeChoice) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Snooze reminder for ${entry.reference}`}
          title="Snooze"
        >
          <Bell />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="inbox-snooze">
        {snoozeChoices.map((choice) => (
          <Button
            key={choice.value}
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false);
              void snooze(choice.value);
            }}
          >
            {choice.label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function Inbox({
  revision,
  select,
}: {
  revision: number;
  select: (reference: string, noteId?: string) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [pages, setPages] = useState(1);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const result = await fetchEntries(filter, pages);
      if (ticket !== latest.current) return;
      setEntries(result.entries);
      setMore(result.more);
      setError("");
    } catch (e) {
      if (ticket === latest.current) setError(String(e));
    }
  }, [filter, pages]);
  useEffect(() => {
    // Reads run through `load`; `revision` re-runs it after workspace changes.
    void load();
    return () => {
      latest.current++;
    };
  }, [load, revision]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function mark(ids: number[], read: boolean) {
    try {
      for (let start = 0; start < ids.length; start += MARK_BATCH)
        await invoke("set_inbox_read", {
          ids: ids.slice(start, start + MARK_BATCH),
          read,
          requestId: crypto.randomUUID(),
        });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }
  async function snooze(entry: Entry, choice: SnoozeChoice) {
    try {
      await invoke("set_reminder", {
        reference: entry.reference,
        dueAt: snoozeInstant(choice, new Date()),
        requestId: crypto.randomUUID(),
      });
      await invoke("set_inbox_read", {
        ids: [entry.id],
        read: true,
        requestId: crypto.randomUUID(),
      });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }
  function changeFilter(next: InboxFilter) {
    setFilter(next);
    setPages(1);
    setEntries([]);
    setMore(false);
  }
  const unreadShown = entries.filter((e) => !e.read);
  const groups = groupEntries(entries, new Date());
  return (
    <div className="management inbox">
      <header className="inbox-header">
        <div className="inbox-heading">
          <h1>Inbox</h1>
          <p>Changes on tickets you follow, and reminders that are due.</p>
        </div>
        <SegmentedControl
          aria-label="Show"
          value={filter}
          onValueChange={changeFilter}
          options={[
            { value: "all", label: "All" },
            { value: "unread", label: "Unread" },
          ]}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={unreadShown.length === 0}
          onClick={() =>
            void mark(
              unreadShown.map((e) => e.id),
              true,
            )
          }
        >
          <Check />
          Mark shown as read
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {groups.map(({ group, entries: items }) => (
        <section key={group} aria-labelledby={`inbox-group-${group}`}>
          <h2 id={`inbox-group-${group}`}>{group}</h2>
          <ul className="inbox-entries">
            {items.map((e) => {
              const noun = entryNoun(e);
              return (
                <li key={e.id} className="inbox-entry" data-read={e.read}>
                  {e.read ? (
                    <span className="inbox-dot" aria-hidden="true" />
                  ) : (
                    <span className="inbox-dot">
                      <StatusDot tone="unread" />
                    </span>
                  )}
                  <span className="inbox-icon">
                    <EntryIcon entry={e} />
                  </span>
                  <button
                    className="inbox-ticket"
                    onClick={() =>
                      e.kind === "note"
                        ? select(e.reference, e.from_value)
                        : select(e.reference)
                    }
                  >
                    <span className="inbox-title-line">
                      <span className="inbox-reference">{e.reference}</span>
                      <span className="inbox-title">{e.title}</span>
                      {!e.read && <span className="sr-only">Unread</span>}
                    </span>
                    <span className="inbox-summary">{summarize(e)}</span>
                  </button>
                  <time dateTime={e.timestamp}>
                    {entryTime(e.timestamp, group)}
                  </time>
                  <span className="inbox-actions">
                    {e.kind === "reminder" && (
                      <Snooze
                        entry={e}
                        snooze={(choice) => snooze(e, choice)}
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Mark ${e.reference} ${noun} ${e.read ? "unread" : "read"}`}
                      title={e.read ? "Mark unread" : "Mark read"}
                      onClick={() => void mark([e.id], !e.read)}
                    >
                      {e.read ? <Circle /> : <Check />}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {entries.length === 0 && filter === "all" && !error && (
        <p className="inbox-note">No inbox entries yet.</p>
      )}
      {more && (
        <div className="inbox-more">
          <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>
            Load older
          </Button>
        </div>
      )}
      {filter === "unread" && !more && !error && (
        <p className="inbox-note">
          That’s everything unread. Read changes stay under All.
        </p>
      )}
      <p className="inbox-footer">
        <Bell aria-hidden="true" />
        Follow or unfollow a ticket from its header; reminders live there too.
      </p>
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
        {following ? "Following" : "Follow"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
