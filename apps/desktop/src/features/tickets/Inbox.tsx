import { emptyCopy } from "@/lib/empty-copy";
import { useContext, useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  Check,
  Circle,
  Clock,
  Eye,
  FileWarning,
  GitCompare,
  Inbox as InboxIcon,
  Link2,
  MessageSquare,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeader } from "@/components/ui/list-header";
import { Pager } from "@/components/ui/pager";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { RunNavigation } from "@/features/automations/navigation";
import { compactAgo, formatDateTime, formatTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { inboxClient } from "@/lib/api/inbox";
import { StatusIcon } from "./StatusIcon";
import {
  entryNoun,
  groupEntries,
  snoozeChoices,
  snoozeInstant,
  summarize,
  type Entry,
  type SnoozeChoice,
} from "./inboxModel";
import { useWorkspaceChange } from "@/lib/workspace-change";
import "./inbox.css";
import { Reference } from "@/components/ui/reference";
import { ConflictReview } from "@/features/sync-review/ConflictReview";
import {
  mergeByTime,
  useSyncEntries,
  type SyncEntry,
} from "@/features/sync-review/inbox-entries";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { syncReview, type ConflictSummary } from "@/lib/sync-review-api";

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
  if (entry.kind === "automation_run") return <Workflow aria-hidden="true" />;
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

/** Snooze is a menu whose rows say when the reminder comes back (list I-03). */
function Snooze({
  entry,
  snooze,
  openRequest,
}: {
  entry: Entry;
  snooze: (choice: SnoozeChoice) => Promise<void>;
  /** Bumped by H on the row, to open the menu from the keyboard. */
  openRequest: number;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(openRequest);
  if (seen !== openRequest) {
    setSeen(openRequest);
    setOpen(true);
  }
  const now = new Date();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={`Snooze reminder for ${entry.reference}`}
          tooltipSide="top"
          aria-keyshortcuts="H"
        >
          <Clock />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Snooze until">
        {snoozeChoices.map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            onSelect={() => void snooze(choice.value)}
          >
            <Clock aria-hidden="true" />
            {choice.label}
            <span className="inbox-snooze-time">
              {formatTime(new Date(snoozeInstant(choice.value, now)))}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One Inbox row, in the ticket row's anatomy (S6): unread dot, kind icon,
 * mono Reference and title; the summary on line two; the relative time at
 * the end, with the exact time in its tooltip. Actions overlay the time on
 * hover or focus. E marks the focused row read or unread; H snoozes it.
 */
function InboxRow({
  reference,
  title,
  summary,
  icon,
  read,
  timestamp,
  current,
  markLabel,
  onOpen,
  onMark,
  snooze,
}: {
  reference: string | null;
  title: string;
  summary: string;
  icon: React.ReactNode;
  read: boolean;
  timestamp: string;
  current: boolean;
  markLabel: string;
  onOpen: () => void;
  onMark: () => void;
  snooze?: (openRequest: number) => React.ReactNode;
}) {
  const now = useNow();
  const [snoozeRequest, setSnoozeRequest] = useState(0);
  return (
    <li
      className="inbox-entry"
      data-read={read}
      aria-current={current || undefined}
    >
      <span className="inbox-dot">
        {!read && <StatusDot tone="unread" size={8} />}
      </span>
      <button
        type="button"
        className="inbox-ticket"
        aria-keyshortcuts={snooze ? "E H" : "E"}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key === "e" || event.key === "E") {
            event.preventDefault();
            onMark();
          } else if (snooze && (event.key === "h" || event.key === "H")) {
            event.preventDefault();
            setSnoozeRequest((value) => value + 1);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            // ↑/↓ move between rows, as in every list.
            event.preventDefault();
            const rows = [
              ...(event.currentTarget
                .closest(".inbox-body")
                ?.querySelectorAll<HTMLElement>(".inbox-ticket") ?? []),
            ];
            const index = rows.indexOf(event.currentTarget);
            rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
          }
        }}
      >
        <span className="inbox-title-line">
          <span className="inbox-icon">{icon}</span>
          {reference && <Reference>{reference}</Reference>}
          <span className="inbox-title">{title}</span>
          {!read && <span className="sr-only">Unread</span>}
        </span>
        <span className="inbox-summary">{summary}</span>
      </button>
      <span className="inbox-trailing">
        <Tooltip content={formatDateTime(timestamp)} side="top">
          <time dateTime={timestamp} tabIndex={-1}>
            {compactAgo(timestamp, now) ?? timestamp}
          </time>
        </Tooltip>
        <span className="inbox-actions">
          {snooze?.(snoozeRequest)}
          <IconButton
            label={markLabel}
            tooltipSide="top"
            aria-keyshortcuts="E"
            onClick={onMark}
          >
            {read ? <Circle /> : <Check />}
          </IconButton>
        </span>
      </span>
    </li>
  );
}

/** A conflict or a notice from sync, drawn as any other Inbox row. */
function SyncRow({
  entry,
  mark,
  open,
}: {
  entry: SyncEntry;
  mark: (read: boolean) => void;
  open: () => void;
}) {
  const Icon =
    entry.icon === "review"
      ? GitCompare
      : entry.icon === "file"
        ? FileWarning
        : Link2;
  return (
    <InboxRow
      reference={entry.reference}
      title={entry.title}
      summary={entry.summary}
      icon={<Icon aria-hidden="true" />}
      read={entry.read}
      timestamp={entry.timestamp}
      current={false}
      markLabel={`Mark ${entry.reference ?? "Drive file"} ${entry.conflict ? "review" : "notice"} ${entry.read ? "unread" : "read"}`}
      onOpen={() => {
        if (!entry.read) mark(true);
        open();
      }}
      onMark={() => mark(!entry.read)}
    />
  );
}

/**
 * The Inbox (DESIGN.md section 9, S6): the list half of a triage split. An
 * entry opens its ticket in the detail pane beside it, so several can be
 * read in a row without leaving the Inbox.
 */
export function Inbox({
  revision,
  select,
  onBrowse,
  selected = null,
}: {
  revision: number;
  select: (reference: string, noteId?: string) => void;
  /** Opens the ticket list, where tickets can be followed. */
  onBrowse: () => void;
  /** The ticket open beside the Inbox. */
  selected?: string | null;
}) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [pages, setPages] = useState(1);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  // A failed read can be retried by reading again; a failed mark or snooze is
  // said once and done again by the person.
  const [loadError, setLoadError] = useState<FailureDescription | null>(null);
  const [actionError, setError] = useState<FailureDescription | null>(null);
  const error = actionError ?? loadError;
  const [tick, setTick] = useState(0);
  const changeVersion = useWorkspaceChange();
  const openRun = useContext(RunNavigation);
  const sync = useSyncEntries(revision);
  const [reviewing, setReviewing] = useState<ConflictSummary | null>(null);
  const reload = () => setTick((value) => value + 1);
  // Loading while the last finished read is not the one asked for now.
  const readKey = JSON.stringify([
    filter,
    pages,
    revision,
    tick,
    changeVersion,
  ]);
  const [readDone, setReadDone] = useState("");
  const loading = readDone !== readKey;
  useEffect(() => {
    let active = true;
    void fetchEntries(filter, pages)
      .then(
        (result) => {
          if (!active) return;
          setEntries(result.entries);
          setMore(result.more);
          setLoadError(null);
        },
        (e: unknown) => {
          if (active) setLoadError(describeFailure(e, "load the Inbox"));
        },
      )
      .finally(() => {
        if (active) setReadDone(readKey);
      });
    return () => {
      active = false;
    };
  }, [filter, pages, revision, tick, changeVersion, readKey]);
  async function mark(ids: number[], read: boolean) {
    try {
      for (let start = 0; start < ids.length; start += MARK_BATCH)
        await inboxClient.setRead(ids.slice(start, start + MARK_BATCH), read);
      reload();
    } catch (e) {
      setError(
        describeFailure(e, read ? "mark updates as read" : "mark as unread"),
      );
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
      setError(describeFailure(e, `snooze ${entry.reference}`));
    }
  }
  function changeFilter(next: InboxFilter) {
    setFilter(next);
    setPages(1);
    setEntries([]);
    setMore(false);
  }
  async function markSync(ids: string[], read: boolean) {
    try {
      if (ids.length) await syncReview.setRead(ids, read);
      sync.reload();
    } catch (e) {
      setError(
        describeFailure(e, read ? "mark updates as read" : "mark as unread"),
      );
    }
  }
  const syncShown = sync.entries.filter((e) => filter === "all" || !e.read);
  const unreadShown = entries.filter((e) => !e.read);
  const unreadSync = syncShown.filter((e) => !e.read).map((e) => e.id);
  const unreadCount = unreadShown.length + unreadSync.length;
  const groups = groupEntries(mergeByTime(entries, syncShown), new Date());
  const empty = entries.length + syncShown.length === 0 && !error && !loading;
  // "Show 50 more": the first new row takes focus when the button had it.
  const arriving = useRef<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const from = arriving.current;
    if (from === null || entries.length <= from) return;
    arriving.current = null;
    body.current?.querySelectorAll<HTMLElement>(".inbox-ticket")[from]?.focus();
  }, [entries.length]);
  return (
    <div className="inbox">
      <PaneHeader
        title="Inbox"
        actions={
          // Only while something shown is unread (list I-07).
          unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void mark(
                  unreadShown.map((e) => e.id),
                  true,
                );
                void markSync(unreadSync, true);
              }}
            >
              <Check />
              Mark shown as read
            </Button>
          )
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
      </PaneHeader>
      <div className="inbox-body" ref={body}>
        {error && (
          <FailureAlert
            size="compact"
            failure={error}
            {...(!actionError && { onRetry: reload })}
          />
        )}
        {groups.map(({ group, entries: items }) => (
          <section key={group} aria-labelledby={`inbox-group-${group}`}>
            <h2 id={`inbox-group-${group}`}>{group}</h2>
            <ul className="inbox-entries">
              {items.map((e) => {
                if ("summary" in e)
                  return (
                    <SyncRow
                      key={e.id}
                      entry={e}
                      mark={(read) => void markSync([e.id], read)}
                      open={() => {
                        if (e.conflict) setReviewing(e.conflict);
                        else if (e.reference) select(e.reference);
                      }}
                    />
                  );
                const noun = entryNoun(e);
                return (
                  <InboxRow
                    key={e.id}
                    reference={e.reference}
                    title={e.title}
                    summary={summarize(e)}
                    icon={<EntryIcon entry={e} />}
                    read={e.read}
                    timestamp={e.timestamp}
                    current={selected === e.reference}
                    markLabel={`Mark ${e.reference} ${noun} ${e.read ? "unread" : "read"}`}
                    onOpen={() => {
                      if (!e.read) void mark([e.id], true);
                      // A deleted update still opens with its id, so the ticket says it is gone.
                      if (e.kind === "activity")
                        select(e.reference, e.from_value);
                      // Reading the entry is not acting on the run: it opens.
                      else if (e.kind === "automation_run" && openRun)
                        openRun(e.from_value);
                      else select(e.reference);
                    }}
                    onMark={() => void mark([e.id], !e.read)}
                    {...(e.kind === "reminder" && {
                      snooze: (request: number) => (
                        <Snooze
                          entry={e}
                          openRequest={request}
                          snooze={(choice) => snooze(e, choice)}
                        />
                      ),
                    })}
                  />
                );
              })}
            </ul>
          </section>
        ))}
        {more && (
          <Pager
            noun="Inbox entries"
            loading={loading}
            onMore={() => {
              arriving.current = document.activeElement?.closest(
                '[data-slot="pager"]',
              )
                ? entries.length
                : null;
              setPages(pages + 1);
            }}
          />
        )}
        {empty &&
          (filter === "unread" ? (
            <EmptyState
              icon={<Check />}
              title={emptyCopy("inbox-unread").title}
              description={emptyCopy("inbox-unread").sentence}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => changeFilter("all")}
                >
                  Show all
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<InboxIcon />}
              title={emptyCopy("inbox-all").title}
              description={emptyCopy("inbox-all").sentence}
              action={
                <Button variant="outline" size="sm" onClick={onBrowse}>
                  Browse tickets to follow
                </Button>
              }
              footnote={
                <>
                  <Eye aria-hidden="true" />
                  Follow and Remind me live in each ticket’s Attention section.
                </>
              }
            />
          ))}
        {reviewing && (
          <ConflictReview
            conflict={reviewing}
            onClose={() => setReviewing(null)}
            onResolved={sync.reload}
          />
        )}
      </div>
    </div>
  );
}
export function Follow({
  reference,
  revision,
  chip = false,
}: {
  reference: string;
  revision: number;
  /** A chip that reads "Following" when on, for the narrow pane’s chip bar. */
  chip?: boolean;
}) {
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  useEffect(() => {
    let active = true;
    void inboxClient
      .isFollowing(reference)
      .then((value) => {
        if (active) {
          setFollowing(value);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (active) setError(describeFailure(e, "check Follow"));
      });
    return () => {
      active = false;
    };
  }, [reference, revision]);
  async function toggle() {
    try {
      await inboxClient.setFollowing(reference, !following);
      setFollowing(!following);
      setError(null);
    } catch (e) {
      setError(
        describeFailure(
          e,
          following ? `unfollow ${reference}` : `follow ${reference}`,
        ),
      );
    }
  }
  if (chip)
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          role="switch"
          aria-checked={following}
          onClick={() => void toggle()}
        >
          <Eye data-icon="inline-start" aria-hidden="true" />
          {following ? "Following" : "Follow"}
        </Button>
        {error && <FailureState size="inline" failure={error} />}
      </>
    );
  return (
    <>
      <label className="rail-follow">
        <Switch checked={following} onCheckedChange={() => void toggle()} />
        Follow
      </label>
      {error && <FailureState size="inline" failure={error} />}
    </>
  );
}
