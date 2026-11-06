import { useEffect, useState } from "react";
import {
  AlarmClock,
  Check,
  Circle,
  Link2,
  MessageSquare,
  Bell,
  Inbox as InboxIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EmptyState } from "@/components/ui/empty-state";
import { ListHeader } from "@/components/ui/list-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
import { inboxClient } from "@/lib/api/inbox";
import { StatusIcon } from "./StatusIcon";
import {
  entryNoun,
  entryTime,
  groupEntries,
  snoozeChoices,
  snoozeInstant,
  summarize,
  type Entry,
  type SnoozeChoice,
} from "./inboxModel";
import { useWorkspaceChange } from "@/lib/workspace-change";
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
    const chunk = await inboxClient.list({
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
      unreadOnly: filter === "unread",
    });
    entries.push(...chunk);
    more = chunk.length === PAGE_SIZE;
    if (!more) break;
  }
  return { entries, more };
}

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "reminder") return <AlarmClock aria-hidden="true" />;
  if (entry.kind === "activity") return <MessageSquare aria-hidden="true" />;
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
  onBrowse,
}: {
  revision: number;
  select: (reference: string, noteId?: string) => void;
  /** Opens the ticket list, where tickets can be followed. */
  onBrowse: () => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [pages, setPages] = useState(1);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const changeVersion = useWorkspaceChange();
  const reload = () => setTick((value) => value + 1);
  useEffect(() => {
    let active = true;
    void fetchEntries(filter, pages).then(
      (result) => {
        if (!active) return;
        setEntries(result.entries);
        setMore(result.more);
        setError("");
      },
      (e: unknown) => {
        if (active) setError(String(e));
      },
    );
    return () => {
      active = false;
    };
  }, [filter, pages, revision, tick, changeVersion]);
  async function mark(ids: number[], read: boolean) {
    try {
      for (let start = 0; start < ids.length; start += MARK_BATCH)
        await inboxClient.setRead(ids.slice(start, start + MARK_BATCH), read);
      reload();
    } catch (e) {
      setError(String(e));
    }
  }
  async function snooze(entry: Entry, choice: SnoozeChoice) {
    try {
      await inboxClient.snooze(
        entry.reference,
        snoozeInstant(choice, new Date()),
      );
      reload();
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
    <div className="inbox">
      <ListHeader
        title="Inbox"
        actions={
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
        }
      >
        <SegmentedControl
          aria-label="Show"
          compact
          value={filter}
          onValueChange={changeFilter}
          options={[
            { value: "all", label: "All" },
            { value: "unread", label: "Unread" },
          ]}
        />
      </ListHeader>
      <div className="inbox-body">
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
                      onClick={() => {
                        if (!e.read) void mark([e.id], true);
                        // A deleted update still opens with its id, so the ticket says it is gone.
                        if (e.kind === "activity")
                          select(e.reference, e.from_value);
                        else select(e.reference);
                      }}
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
          <EmptyState
            className="p-0 pb-8 md:p-0 md:pb-8"
            icon={<InboxIcon />}
            title="Nothing in your Inbox"
            description="Changes on tickets you follow, and reminders that come due, appear here."
            action={
              <Button variant="outline" size="sm" onClick={onBrowse}>
                Browse tickets to follow
              </Button>
            }
            footnote={
              <>
                <Bell aria-hidden="true" />
                Follow and Remind me live in each ticket’s Attention section.
              </>
            }
          />
        )}
        {more && (
          <div className="inbox-more">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPages(pages + 1)}
            >
              Load older
            </Button>
          </div>
        )}
        {filter === "unread" && !more && !error && (
          <p className="inbox-note">
            That’s everything unread. Read changes stay under All.
          </p>
        )}
        {entries.length > 0 && (
          <p className="inbox-footer">
            <Bell aria-hidden="true" />
            Follow or unfollow a ticket from its Attention section; reminders
            live there too.
          </p>
        )}
      </div>
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
    void inboxClient
      .isFollowing(reference)
      .then((value) => {
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
      await inboxClient.setFollowing(reference, !following);
      setFollowing(!following);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <label className="rail-follow">
        <Switch checked={following} onCheckedChange={() => void toggle()} />
        Follow
      </label>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
