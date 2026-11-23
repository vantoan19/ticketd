import { StatusLineRegion } from "@/components/ui/status-line";
import { StatusLineContext } from "@/components/ui/use-status-line";
import { useStickyGroupHeadings } from "@/components/ui/use-sticky-group-headings";
import { Skeleton } from "@/components/ui/skeleton";
import { onInboxAction } from "./inbox-commands";
import { useInboxAction } from "./use-inbox-action";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import {
  useInboxTriage,
  triageId,
  type TriageSelection,
} from "./inbox-triage-context";
import type { Attention } from "./use-inbox-attention";
import {
  matchesShortcut,
  shortcutLabel,
  ariaKeyShortcuts,
} from "@/lib/shortcuts";
import { Kbd } from "@/components/ui/kbd";
import { emptyCopy } from "@/lib/empty-copy";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import { progressBrief } from "./progress-brief";
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
import { EntrySlot, UnreadDot } from "./inbox-motion";
import { useNewEntries } from "./inbox-arrivals";
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
import { useEditingHarness } from "@/features/chats/editing-harness";
import { Count } from "@/components/ui/count";
const PAGE_SIZE = 50;
const MARK_BATCH = 100;

function EntryIcon({ entry }: { entry: Entry }) {
  const editingHarness = useEditingHarness();
  if (entry.kind === "reminder") return <AlarmClock aria-hidden="true" />;
  if (entry.kind === "activity") {
    const harness = editingHarness(entry.editing_agent);
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

function SnoozeButton({
  label,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip
      content={
        label === "Snooze" ? "Snooze this reminder" : "Remind me on this Ticket"
      }
      shortcut={shortcutLabel("inbox-remind")}
    >
      <Button
        variant="ghost"
        size="compact"
        aria-keyshortcuts={ariaKeyShortcuts("inbox-remind")}
        {...props}
      >
        {label}
        <Kbd>{shortcutLabel("inbox-remind")}</Kbd>
      </Button>
    </Tooltip>
  );
}

/** Snooze is a menu whose rows say when the reminder comes back (list I-03). */
export function Snooze({
  entry,
  snooze,
  openRequest,
  label,
  disabled = false,
}: {
  entry: Pick<Entry, "reference">;
  label?: string;
  disabled?: boolean;
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
        {label ? (
          <SnoozeButton label={label} disabled={disabled} />
        ) : (
          <IconButton
            disabled={disabled}
            label={`Snooze reminder for ${entry.reference}`}
            tooltipSide="top"
            aria-keyshortcuts="H"
          >
            <Clock />
          </IconButton>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Snooze until">
        <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {snoozeChoices.map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            disabled={disabled}
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

/** Neutral placeholders reserve the same group and two-line row geometry. */
function InboxRowsSkeleton() {
  return (
    <div role="status" aria-label="Loading Inbox" className="inbox-loading">
      <span className="sr-only">Loading Inbox…</span>
      <section aria-hidden="true">
        <h2>
          <Skeleton shape="circle" className="size-1.5" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-4" />
        </h2>
        <ul className="inbox-entries">
          {[0, 1, 2].map((row) => (
            <li key={row} className="inbox-entry">
              <span className="inbox-dot">
                <Skeleton shape="circle" className="size-1.5" />
              </span>
              <div className="inbox-ticket">
                <div className="inbox-title-line">
                  <span className="inbox-icon">
                    <Skeleton shape="circle" className="size-4" />
                  </span>
                  <Skeleton className="h-3 w-11" />
                  <Skeleton className="h-3 flex-1" />
                </div>
                <div className="inbox-summary inbox-loading-summary">
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
              <span className="inbox-trailing">
                <Skeleton className="h-3 w-6" />
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
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
  disabledReason,
  arriving = false,
  opens = true,
  wrap = false,
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
  disabledReason?: string | null;
  snooze?: (openRequest: number) => React.ReactNode;
  /** A new entry opens its space; one already shown just renders. */
  arriving?: boolean;
  /**
   * False for an entry with nothing to open: it does not look or act
   * clickable, though it still takes focus so E marks it.
   */
  opens?: boolean;
  /** The summary wraps instead of being cut, for one naming a file path. */
  wrap?: boolean;
}) {
  const now = useNow();
  const [snoozeRequest, setSnoozeRequest] = useState(0);
  return (
    <EntrySlot arriving={arriving}>
      <div
        className="inbox-entry"
        data-read={read}
        data-static={!opens || undefined}
        data-wrap={wrap || undefined}
        aria-current={current || undefined}
      >
        <span className="inbox-dot">
          <UnreadDot read={read} />
        </span>
        <button
          type="button"
          className="inbox-ticket"
          aria-keyshortcuts={snooze ? "E H" : "E"}
          onClick={(event) => {
            if (opens) onOpen();
            // Opening the detail must leave entry shortcuts on the entry, and
            // one with nothing to open still takes focus for E: WebKit does
            // not focus a clicked button.
            event.currentTarget.focus();
          }}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey
            )
              return;
            if (
              disabledReason &&
              ["e", "h"].includes(event.key.toLowerCase())
            ) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
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
              disabled={!!disabledReason}
              label={
                disabledReason ? `${markLabel} · ${disabledReason}` : markLabel
              }
              tooltipSide="top"
              aria-keyshortcuts="E"
              onClick={onMark}
            >
              {read ? <Circle /> : <Check />}
            </IconButton>
          </span>
        </span>
      </div>
    </EntrySlot>
  );
}

/** A conflict or a notice from sync, drawn as any other Inbox row. */
function SyncRow({
  entry,
  mark,
  open,
  disabledReason,
  arriving,
}: {
  entry: SyncEntry;
  arriving: boolean;
  disabledReason?: string | null;
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
      arriving={arriving}
      disabledReason={disabledReason ?? null}
      opens={!!(entry.conflict || entry.reference)}
      wrap={entry.file ?? false}
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
  select: (reference: string | null, noteId?: string) => void;
  onBrowse: () => void;
  selected?: string | null;
}) {
  const attention = useInboxAttention();
  const line = useContext(StatusLineContext);
  const content = attention ? (
    <InboxContent {...props} />
  ) : (
    <InboxAttentionProvider revision={props.revision}>
      <InboxContent {...props} />
    </InboxAttentionProvider>
  );
  return line ? content : <StatusLineRegion>{content}</StatusLineRegion>;
}

function InboxContent({
  revision,
  select,
  selected = null,
}: {
  revision: number;
  select: (reference: string | null, noteId?: string) => void;
  /** Opens the ticket list, where tickets can be followed. */
  onBrowse: () => void;
  /** The ticket open beside the Inbox. */
  selected?: string | null;
}) {
  const attention = useInboxAttention()!;
  const triage = useInboxTriage();
  const [held, setHeld] = useState<Attention | null>(null);
  const [heldSync, setHeldSync] = useState<SyncEntry[] | null>(null);
  const [heldTime, setHeldTime] = useState<number | null>(null);
  const projection = held ?? attention;
  const chats = useChatClient();
  const chatFeature = useChatFeature();
  const liveNow = useNow();
  const now = heldTime ?? liveNow;
  const [pages, setPages] = useState(1);
  // Attention never disappears behind update paging, even when its event is old.
  const urgent = projection.entries.filter((entry) =>
    needsYou(entry, projection, new Date(now)),
  );
  const updates = projection.entries.filter(
    (entry) => !needsYou(entry, projection, new Date(now)),
  );
  const entries = [...urgent, ...updates.slice(0, pages * PAGE_SIZE)];
  const hidden = updates.slice(pages * PAGE_SIZE);
  // Everything is loaded; only the rows are paged. Headings count them all.
  const hiddenCounts = new Map<string, number>();
  for (const entry of hidden) {
    const group = attentionGroup(entry, new Date(now));
    hiddenCounts.set(group, (hiddenCounts.get(group) ?? 0) + 1);
  }
  const more = hidden.length > 0;
  const [navigationError, setNavigationError] =
    useState<FailureDescription | null>(null);
  const error = navigationError ?? attention.error;
  const loading = attention.loading;
  const openRun = useContext(RunNavigation);
  const sync = useSyncEntries(revision);
  const [reviewing, setReviewing] = useState<ConflictSummary | null>(null);
  const reload = attention.reload;
  const blocked = editingBlockedReason(useWorkspaceState());
  const { pending, perform } = useInboxAction(
    () => {
      reload();
      sync.reload();
    },
    undefined,
    true,
  );
  async function mark(ids: number[], read: boolean, notify = true) {
    if (blocked || !ids.length) return;
    const before = attention.entries.filter((entry) => ids.includes(entry.id));
    const batches: { ids: number[]; requestId: string; undoId?: string }[] = [];
    for (let start = 0; start < ids.length; start += MARK_BATCH)
      batches.push({
        ids: ids.slice(start, start + MARK_BATCH),
        requestId: crypto.randomUUID(),
      });
    const undo = before.map((entry) => ({
      ...entry,
      requestId: crypto.randomUUID(),
    }));
    await perform(
      `Marked updates ${read ? "read" : "unread"}`,
      async () => {
        for (const batch of batches)
          await inboxClient.setRead(batch.ids, read, batch.requestId);
      },
      notify
        ? async () => {
            for (const entry of undo)
              await inboxClient.setRead(
                [entry.id],
                entry.read,
                entry.requestId,
              );
          }
        : undefined,
    );
  }
  async function snooze(entry: Entry, choice: SnoozeChoice) {
    if (blocked) return;
    const due = snoozeInstant(choice, new Date());
    const requestId = crypto.randomUUID();
    const undoId = crypto.randomUUID();
    let before: string | null | undefined;
    await perform(
      `Reminder set for ${entry.reference}`,
      async () => {
        if (before === undefined)
          before = await inboxClient.reminder(entry.reference);
        await inboxClient.snooze(entry.reference, due, requestId);
      },
      () => inboxClient.snooze(entry.reference, before ?? null, undoId),
    );
  }
  async function markSync(ids: string[], read: boolean) {
    if (blocked || !ids.length) return;
    const before = sync.entries.filter((entry) => ids.includes(entry.id));
    await perform(
      `Marked updates ${read ? "read" : "unread"}`,
      () => syncReview.setRead(ids, read),
      async () => {
        for (const entry of before)
          await syncReview.setRead([entry.id], entry.read);
      },
      read ? "mark updates as read" : "mark as unread",
    );
  }
  const syncShown = heldSync ?? sync.entries;
  const unreadShown = entries.filter(
    (e) =>
      !(attention.entries.find((entry) => entry.id === e.id)?.read ?? e.read),
  );
  const unreadSync = syncShown
    .filter(
      (e) =>
        !(sync.entries.find((current) => current.id === e.id)?.read ?? e.read),
    )
    .map((e) => e.id);
  // A conflict still waiting for review needs you as much as an approval does,
  // even though it is listed under Updates.
  const unreadConflicts = syncShown.some(
    (e) => e.conflict && unreadSync.includes(e.id),
  );
  const unreadApprovals = projection.approvals.filter(
    (chat) =>
      attention.chats.find((current) => current.id === chat.id)?.status
        .unseen ?? chat.status.unseen,
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
        : needsYou(entry, projection, new Date(now))
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
      items.length || (group === "Needs you" && projection.approvals.length),
  );
  const arrivals = useNewEntries(
    [
      ...projection.approvals.map((chat) => `chat:${chat.id}`),
      ...groups.flatMap(([, items]) => items.map((item) => String(item.id))),
    ],
    !loading,
    pages,
  );
  async function markChat(id: string, read: boolean) {
    if (blocked) return;
    const before = !(
      attention.chats.find((chat) => chat.id === id)?.status.unseen ?? !read
    );
    const set = async (value: boolean) => {
      if (value) await chats.markRead(id);
      else await chats.markUnread(id);
    };
    await perform(
      `Marked Chat ${read ? "read" : "unread"}`,
      () => set(read),
      () => set(before),
    );
  }
  function markAll() {
    if (blocked) return;
    const numeric = unreadShown.map((entry) => entry.id);
    const batches: { ids: number[]; requestId: string; undoId?: string }[] = [];
    for (let start = 0; start < numeric.length; start += MARK_BATCH)
      batches.push({
        ids: numeric.slice(start, start + MARK_BATCH),
        requestId: crypto.randomUUID(),
        undoId: crypto.randomUUID(),
      });
    void perform(
      "Marked shown entries read",
      async () => {
        for (const batch of batches)
          await inboxClient.setRead(batch.ids, true, batch.requestId);
        if (unreadSync.length) await syncReview.setRead(unreadSync, true);
        for (const chat of unreadApprovals) await chats.markRead(chat.id);
      },
      async () => {
        for (const batch of batches)
          await inboxClient.setRead(batch.ids, false, batch.undoId);
        if (unreadSync.length) await syncReview.setRead(unreadSync, false);
        for (const chat of unreadApprovals) await chats.markUnread(chat.id);
      },
    );
  }
  const queue: TriageSelection[] = [
    ...projection.approvals.map((chat) => ({
      kind: "approval" as const,
      chat,
    })),
    ...groups.flatMap(([, items]) =>
      items.flatMap((entry) =>
        "summary" in entry ? [] : [{ kind: "entry" as const, entry }],
      ),
    ),
  ];
  function openSelection(selection: TriageSelection, fresh = attention) {
    if (triage) {
      setHeld(fresh);
      setHeldSync(sync.entries);
      setHeldTime(liveNow);
    }
    triage?.choose(selection);
    setNavigationError(null);
    triage?.openChat(null);
    if (selection.kind === "approval") {
      const reference =
        selection.chat.tickets[0]?.reference ?? selection.chat.first_ticket;
      select(reference ?? null);
    } else {
      const entry = selection.entry;
      if (!entry.read) void mark([entry.id], true, false);
      if (entry.kind === "activity") select(entry.reference, entry.from_value);
      else if (entry.kind === "automation_run" && openRun)
        openRun(entry.from_value);
      else select(entry.reference);
    }
  }
  async function walk(direction: 1 | -1) {
    const selected = triage?.selection;
    const index = selected
      ? queue.findIndex((entry) => triageId(entry) === triageId(selected))
      : -1;
    const next = queue[index < 0 ? 0 : index + direction];
    {
      try {
        const fresh = (await attention.readLatest?.()) ?? attention;
        if (next) openSelection(next, fresh);
        else {
          setHeld(fresh);
          setHeldSync(sync.entries);
          setHeldTime(liveNow);
        }
      } catch (reason) {
        setNavigationError(
          describeFailure(reason, "load the next Inbox entry"),
        );
      }
    }
  }
  useEffect(() => {
    if (!triage) return;
    return onInboxAction((action) => {
      if (action === "next") void walk(1);
      else if (action === "previous") void walk(-1);
    });
  });
  useLayoutEffect(() => {
    triage?.registerWalk(walk);
    const selected = triage?.selection;
    const index = selected
      ? queue.findIndex((entry) => triageId(entry) === triageId(selected))
      : -1;
    triage?.setPosition(
      // Rows not paged in yet still count, as they do in the group headings.
      index < 0
        ? null
        : { index: index + 1, total: queue.length + hidden.length },
    );
  });
  useEffect(() => {
    if (!triage) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !(target instanceof HTMLElement) ||
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"],[role="menu"],[role="listbox"]',
        )
      )
        return;
      if (
        !matchesShortcut(event, "inbox-next") &&
        !matchesShortcut(event, "inbox-previous")
      )
        return;
      if (!target.closest(".ticket-workspace,.inbox")) return;
      event.preventDefault();
      event.stopPropagation();
      walk(matchesShortcut(event, "inbox-next") ? 1 : -1);
    };
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !target.closest(
          '.ticket-workspace,.inbox,[role="menu"],[role="dialog"],[data-slot="status-line"]',
        )
      ) {
        setHeld(null);
        setHeldSync(null);
        setHeldTime(null);
      }
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focus);
    };
  });
  // "Show 50 more": the first new row takes focus when the button had it.
  const arriving = useRef<number | null>(null);
  const revealingRead = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  useStickyGroupHeadings(body);
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
            <Tooltip content={blocked ?? "Mark all shown unread entries read"}>
              <span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!blocked || pending}
                  onClick={markAll}
                >
                  <CheckCheck />
                  Mark all read
                </Button>
              </span>
            </Tooltip>
          )
        }
      />
      <div
        className="inbox-body"
        ref={body}
        onFocusCapture={(event) => {
          if (
            triage &&
            !held &&
            event.target instanceof HTMLElement &&
            event.target.closest(".inbox-entry")
          ) {
            setHeld(attention);
            setHeldSync(sync.entries);
            setHeldTime(liveNow);
          }
        }}
      >
        {loading && !entries.length && !error && <InboxRowsSkeleton />}
        {error && (
          <FailureAlert size="compact" failure={error} onRetry={reload} />
        )}
        {!loading &&
          !error &&
          projection.needsCount === 0 &&
          !unreadConflicts && (
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
            <h2 id={`inbox-group-${group}`} data-sticky-group-heading>
              {group === "Needs you" && <StatusDot tone="attention" size={6} />}
              {group}
              <Count>
                {items.length +
                  (hiddenCounts.get(group) ?? 0) +
                  (group === "Needs you" ? projection.approvals.length : 0)}
              </Count>
            </h2>
            <ul className="inbox-entries">
              {group === "Needs you" &&
                projection.approvals.map((chat) => (
                  <InboxRow
                    key={`chat:${chat.id}`}
                    arriving={arrivals.has(`chat:${chat.id}`)}
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
                    read={
                      !(
                        attention.chats.find(
                          (current) => current.id === chat.id,
                        )?.status.unseen ?? chat.status.unseen
                      )
                    }
                    timestamp={chat.updated_at}
                    current={
                      triage?.selection?.kind === "approval" &&
                      triage.selection.chat.id === chat.id
                    }
                    markLabel={`Mark ${chat.title} ${chat.status.unseen ? "read" : "unread"}`}
                    disabledReason={blocked}
                    onMark={() => void markChat(chat.id, !chat.status.unseen)}
                    onOpen={() =>
                      triage
                        ? openSelection({ kind: "approval", chat })
                        : chatFeature.requestChat({
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
                      arriving={arrivals.has(String(e.id))}
                      entry={{
                        ...e,
                        read:
                          sync.entries.find((entry) => entry.id === e.id)
                            ?.read ?? e.read,
                      }}
                      disabledReason={blocked}
                      mark={(read) => void markSync([e.id], read)}
                      open={() => {
                        if (e.conflict) setReviewing(e.conflict);
                        else if (e.reference) {
                          // This Ticket replaces the entry read before it:
                          // that entry's triage card and Chat do not stay.
                          triage?.choose(null);
                          triage?.openChat(null);
                          select(e.reference);
                        }
                      }}
                    />
                  );
                const noun = entryNoun(e);
                const currentRead =
                  attention.entries.find((entry) => entry.id === e.id)?.read ??
                  e.read;
                return (
                  <InboxRow
                    key={e.id}
                    arriving={arrivals.has(String(e.id))}
                    reference={e.reference}
                    title={e.title}
                    summary={
                      needsYou(e, projection, new Date(now)) &&
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
                          : {progressBrief(e.to_value)}
                        </>
                      ) : (
                        summarize(e)
                      )
                    }
                    icon={
                      <EntryIcon
                        entry={
                          e.kind === "status" && e.to_value === "In review"
                            ? {
                                ...e,
                                to_value:
                                  attention.statuses.get(e.reference) ??
                                  e.to_value,
                              }
                            : e
                        }
                      />
                    }
                    read={currentRead}
                    timestamp={e.timestamp}
                    current={selected === e.reference}
                    markLabel={`Mark ${e.reference} ${noun} ${currentRead ? "unread" : "read"}`}
                    onOpen={() => openSelection({ kind: "entry", entry: e })}
                    disabledReason={blocked}
                    onMark={() => void mark([e.id], !currentRead)}
                    {...(e.kind === "reminder" && {
                      snooze: (request: number) => (
                        <Snooze
                          entry={e}
                          openRequest={request}
                          disabled={!!blocked || pending}
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
            more={Math.min(PAGE_SIZE, hidden.length)}
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
