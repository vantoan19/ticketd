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
  CheckCheck,
  Link2,
  MessageSquare,
  Workflow,
} from "lucide-react";
import { Pager } from "@/components/ui/pager";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeader } from "@/components/ui/list-header";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { RunNavigation } from "@/features/automations/navigation";
import { compactAgo, formatDateTime, formatTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { inboxClient } from "@/lib/api/inbox";
import { StatusIcon } from "./StatusIcon";
import {
  entryNoun,
  attentionGroup,
  needsYou,
  snoozeChoices,
  snoozeInstant,
  summarize,
  type Entry,
  type SnoozeChoice,
} from "./inboxModel";
import "./inbox.css";
import { Reference } from "@/components/ui/reference";
import { ConflictReview } from "@/features/sync-review/ConflictReview";
import {
  useSyncEntries,
  type SyncEntry,
} from "@/features/sync-review/inbox-entries";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { syncReview, type ConflictSummary } from "@/lib/sync-review-api";

import { InboxAttentionProvider } from "./inbox-attention";
import { useInboxAttention } from "./use-inbox-attention";
import { useChatClient } from "@/features/chats/client";
import { useChatFeature } from "@/features/chats/use-chats";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { Count } from "@/components/ui/count";
const PAGE_SIZE = 50;
const MARK_BATCH = 100;

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "reminder") return <AlarmClock aria-hidden="true" />;
  if (entry.kind === "activity") {
    const agent = entry.editing_agent?.toLowerCase();
    const harness =
      agent === "codex"
        ? "codex"
        : agent === "claude" ||
            agent === "claude-code" ||
            agent === "claude code"
          ? "claude-code"
          : null;
    return harness ? (
      <HarnessMark
        harness={harness}
        name={entry.editing_agent ?? ""}
        decorative
      />
    ) : (
      <MessageSquare aria-hidden="true" />
    );
  }
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
        <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
        <DropdownMenuSeparator />
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
 * One Inbox row, in the triage row anatomy (S08): unread dot, kind icon,
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
  summary: React.ReactNode;
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
        {!read && <StatusDot tone="unread" size={6} />}
      </span>
      <button
        type="button"
        className="inbox-ticket"
        aria-keyshortcuts={snooze ? "E H" : "E"}
        onClick={(event) => {
          onOpen();
          // Opening the detail must leave entry shortcuts on the entry.
          event.currentTarget.focus();
        }}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key === "e" || event.key === "E") {
            event.preventDefault();
            event.stopPropagation();
            onMark();
          } else if (snooze && (event.key === "h" || event.key === "H")) {
            event.preventDefault();
            event.stopPropagation();
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
 * The Inbox (DESIGN.md section 9, S08): the list half of a triage split. An
 * entry opens its ticket in the detail pane beside it, so several can be
 * read in a row without leaving the Inbox.
 */
export function Inbox(props: {
  revision: number;
  select: (reference: string, noteId?: string) => void;
  onBrowse: () => void;
  selected?: string | null;
}) {
  const attention = useInboxAttention();
  return attention ? (
    <InboxContent {...props} />
  ) : (
    <InboxAttentionProvider revision={props.revision}>
      <InboxContent {...props} />
    </InboxAttentionProvider>
  );
}

function InboxContent({
  revision,
  select,
  selected = null,
}: {
  revision: number;
  select: (reference: string, noteId?: string) => void;
  /** Opens the ticket list, where tickets can be followed. */
  onBrowse: () => void;
  /** The ticket open beside the Inbox. */
  selected?: string | null;
}) {
  const attention = useInboxAttention()!;
  const chats = useChatClient();
  const chatFeature = useChatFeature();
  const now = useNow();
  const [pages, setPages] = useState(1);
  // Attention never disappears behind update paging, even when its event is old.
  const urgent = attention.entries.filter((entry) =>
    needsYou(entry, attention, new Date(now)),
  );
  const updates = attention.entries.filter(
    (entry) => !needsYou(entry, attention, new Date(now)),
  );
  const entries = [...urgent, ...updates.slice(0, pages * PAGE_SIZE)];
  const more = pages * PAGE_SIZE < updates.length;
  const [actionError, setError] = useState<FailureDescription | null>(null);
  const error = actionError ?? attention.error;
  const loading = attention.loading;
  const openRun = useContext(RunNavigation);
  const sync = useSyncEntries(revision);
  const [reviewing, setReviewing] = useState<ConflictSummary | null>(null);
  const reload = attention.reload;
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
  const syncShown = sync.entries;
  const unreadShown = entries.filter((e) => !e.read);
  const unreadSync = syncShown.filter((e) => !e.read).map((e) => e.id);
  const unreadApprovals = attention.approvals.filter(
    (chat) => chat.status.unseen,
  );
  const unreadCount =
    unreadShown.length + unreadSync.length + unreadApprovals.length;
  const grouped = new Map<string, (Entry | SyncEntry)[]>([
    ["Needs you", []],
    ["Updates", []],
    ["Earlier", []],
  ]);
  for (const entry of [...entries, ...syncShown].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  )) {
    const group =
      "summary" in entry
        ? attentionGroup(entry, new Date(now))
        : needsYou(entry, attention, new Date(now))
          ? "Needs you"
          : attentionGroup(entry, new Date(now));
    grouped.get(group)?.push(entry);
  }
  grouped.get("Needs you")?.sort((a, b) => {
    const priority = (entry: Entry | SyncEntry) =>
      "kind" in entry && entry.kind === "status" ? 0 : 1;
    return priority(a) - priority(b);
  });
  const groups = [...grouped].filter(
    ([group, items]) =>
      items.length || (group === "Needs you" && attention.approvals.length),
  );
  async function markChat(id: string, read: boolean) {
    try {
      if (read) await chats.markRead(id);
      else await chats.markUnread(id);
      reload();
    } catch (reason) {
      setError(describeFailure(reason, "mark the Chat as read"));
    }
  }
  // "Show 50 more": the first new row takes focus when the button had it.
  const arriving = useRef<number | null>(null);
  const revealingRead = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (revealingRead.current) {
      body.current
        ?.querySelector<HTMLElement>('[data-read="true"] .inbox-ticket')
        ?.focus();
      revealingRead.current = false;
    }
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
                for (const chat of unreadApprovals)
                  void markChat(chat.id, true);
              }}
            >
              <CheckCheck />
              Mark all read
            </Button>
          )
        }
      />
      <div className="inbox-body" ref={body}>
        {error && (
          <FailureAlert
            size="compact"
            failure={error}
            {...(!actionError && { onRetry: reload })}
          />
        )}
        {!loading && !error && attention.needsCount === 0 && (
          <EmptyState
            icon={<CheckCheck />}
            title={emptyCopy("inbox-caught-up").title}
            description={emptyCopy("inbox-caught-up").sentence}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const allPages = Math.max(
                    1,
                    Math.ceil(updates.length / PAGE_SIZE),
                  );
                  if (pages < allPages) {
                    revealingRead.current = true;
                    setPages(allPages);
                  } else {
                    body.current
                      ?.querySelector<HTMLElement>(
                        '[data-read="true"] .inbox-ticket',
                      )
                      ?.focus();
                  }
                }}
              >
                {emptyCopy("inbox-caught-up").action}
              </Button>
            }
          />
        )}
        {groups.map(([group, items]) => (
          <section key={group} aria-labelledby={`inbox-group-${group}`}>
            <h2 id={`inbox-group-${group}`}>
              {group === "Needs you" && <StatusDot tone="attention" size={6} />}
              {group}
              <Count>
                {items.length +
                  (group === "Needs you" ? attention.approvals.length : 0)}
              </Count>
            </h2>
            <ul className="inbox-entries">
              {group === "Needs you" &&
                attention.approvals.map((chat) => (
                  <InboxRow
                    key={`chat:${chat.id}`}
                    reference={
                      chat.tickets[0]?.reference ?? chat.first_ticket ?? null
                    }
                    title={`Approval needed in “${chat.title}”`}
                    summary={
                      <>
                        <span className="inbox-agent-name">
                          {chat.harness_name}
                        </span>
                        {chat.status.detail ? (
                          <>
                            {" "}
                            wants to run{" "}
                            <code className="inbox-command">
                              {chat.status.detail}
                            </code>
                          </>
                        ) : (
                          " · Approval needed"
                        )}
                      </>
                    }
                    icon={
                      <HarnessMark
                        harness={chat.harness_id ?? ""}
                        name={chat.harness_name}
                        decorative
                      />
                    }
                    read={!chat.status.unseen}
                    timestamp={chat.updated_at}
                    current={false}
                    markLabel={`Mark ${chat.title} ${chat.status.unseen ? "read" : "unread"}`}
                    onMark={() => void markChat(chat.id, !chat.status.unseen)}
                    onOpen={() =>
                      chatFeature.requestChat({
                        kind: "open",
                        chatId: chat.id,
                        retention: chat.retention,
                      })
                    }
                  />
                ))}
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
                    summary={
                      needsYou(e, attention, new Date(now)) &&
                      e.kind === "status" ? (
                        <>
                          <span className="inbox-agent-name">
                            {e.editing_agent}
                          </span>{" "}
                          moved it to In review, waiting for you
                        </>
                      ) : e.kind === "activity" &&
                        !e.deleted &&
                        e.editing_agent ? (
                        <>
                          <span className="inbox-agent-name">
                            {e.editing_agent}
                          </span>
                          : {e.to_value}
                        </>
                      ) : (
                        summarize(e)
                      )
                    }
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
