import { useNow } from "@/lib/use-now";
import {
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { m } from "motion/react";
import {
  AlarmClock,
  Bot,
  Cloud,
  CornerDownRight,
  Folder,
  Layers,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { Item } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Appear,
  Arrival,
  CrossfadeText,
  Glide,
  Presence,
} from "@/components/ui/motion";
import {
  arrival,
  departure,
  glide,
  pageArriving,
  rowTokens,
} from "@/components/ui/row-motion";
import { HiddenContext } from "@/lib/workspace-reads/visibility-context";
import { StatusIcon } from "./StatusIcon";
import { RowTags } from "./RowTags";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { editingHarness } from "@/features/chats/editing-harness";
import { progressBrief } from "./progress-brief";
import { ago, externalSource } from "./ticket-source";
import { useKnownTicket, useTicket } from "./open-ticket";
import { useStickyRows } from "./use-sticky-rows";
import { groupTickets } from "./ticket-groups";
import {
  readiness,
  readinessLabel,
  rowContextItem,
  type RowContextKind,
  type RowScope,
} from "./ticket-row";
import { compactAgo, formatDateTime } from "@/lib/format";
import type { StatusCounts, Ticket } from "@/lib/api/client";
import "./ticket-list.css";
import { Badge } from "@/components/ui/badge";
import { Count } from "@/components/ui/count";
import { Reference } from "@/components/ui/reference";
import { useInboxAttention } from "./use-inbox-attention";
import type { ChatSummary } from "@/features/chats/client";
import { useConflicts } from "@/features/sync-review/use-conflicts";

/** The rows a cascade moves, and the rest that mounted with them and stay still. */
type Mounted = {
  cascading: ReadonlySet<string>;
  still: ReadonlySet<string>;
};

/** The shortest a row is, in px (list rows are 36px; Display can only make them taller). */
const SHORTEST_ROW = 36;

/**
 * The rows that can be on screen as a list mounts, from the window's height:
 * the list starts at its top, and a row below the window is never seen
 * arriving. Rows that are a little out of view only cost a few animations.
 */
function firstScreen(keys: string[]): Mounted {
  const shown = Math.ceil(window.innerHeight / SHORTEST_ROW);
  return {
    cascading: new Set(keys.slice(0, shown)),
    still: new Set(keys.slice(shown)),
  };
}

/** `mounted` without the rows that are no longer listed; the same object if none left. */
function stillHere(mounted: Mounted, listed: ReadonlySet<string>): Mounted {
  const keep = (keys: ReadonlySet<string>) =>
    keys.size === 0 || [...keys].every((key) => listed.has(key))
      ? keys
      : new Set([...keys].filter((key) => listed.has(key)));
  const cascading = keep(mounted.cascading);
  const still = keep(mounted.still);
  return cascading === mounted.cascading && still === mounted.still
    ? mounted
    : { cascading, still };
}

export function TicketList({
  tickets,
  selected,
  onOpen,
  bulkSelection,
  onToggle,
  onSelectMany,
  selectable,
  selectionDisabled = false,
  scope,
  rowAction,
  grouping,
  singleStatus = false,
  simple = true,
  empty,
  scopeKey = "",
  cascade: cascadeRequested = false,
  onCascaded,
}: {
  tickets: Ticket[];
  empty?: ReactNode;
  scopeKey?: string;
  /**
   * The rows present when the list mounts fade up top first, as when it
   * replaces the board or the placeholders. Only the rows in view take part, so
   * a long list never starts hundreds of animations. A page arrival in progress
   * does it instead.
   */
  cascade?: boolean;
  /** Called once the list has mounted with `cascade`, which is one-shot. */
  onCascaded?: () => void;
  selected: string | null;
  onOpen: (reference: string) => void;
  bulkSelection: string[];
  onToggle: (reference: string) => void;
  /**
   * Adds several tickets to the selection: a Shift-click or Shift+↑/↓ range
   * from the last one toggled, or Mod+A for every listed ticket.
   */
  onSelectMany?: (references: string[]) => void;
  selectable: boolean;
  selectionDisabled?: boolean;
  scope: RowScope;
  /** An optional control after each row, revealed on hover and keyboard focus. */
  rowAction?: (ticket: Ticket) => ReactNode;
  /**
   * Group the rows by status, with the counts of the whole result and an Add
   * action per group. Without it the list is flat and each row names its status.
   */
  grouping?: {
    counts: StatusCounts;
    /** Omit to hide the per-group Add action (a read-only scope). */
    onAdd?: (status: string, trigger: HTMLButtonElement) => void;
  };
  /**
   * The view lists one status (Ready, In progress, or a status filter): no
   * group header and no per-row status word, since the view's title says it.
   * A Todo row still carries Ready or Blocked.
   */
  singleStatus?: boolean;
  /** Every row is Ready (the Ready view), so the per-row Ready dot is omitted. */
  readyView?: boolean;
  /** Simple rows: one line, ending with the Ready or Blocked dot and the time. */
  simple?: boolean;
}) {
  const navigator = selected !== null;
  const attention = useInboxAttention();
  const ticketChats = new Map<string, ChatSummary>();
  for (const chat of attention?.chats ?? []) {
    if (chat.status.rank !== "working" && chat.status.rank !== "approval")
      continue;
    for (const { reference } of chat.tickets) {
      if (ticketChats.get(reference)?.status.rank !== "approval")
        ticketChats.set(reference, chat);
    }
  }
  const known = useKnownTicket();
  const sticky = useStickyRows(
    tickets,
    selected,
    known,
    bulkSelection,
    scopeKey,
  );
  // A held row shows the newest copy known of its Ticket. Only the open
  // Ticket's row that the list dropped follows its read; no other row, and the
  // list otherwise, re-renders for a Ticket's read.
  useTicket(sticky.watching);
  // Sizes the reference column to the longest reference on screen (#289),
  // counting the rows held after the list dropped them.
  let referenceChars = 0;
  for (const { reference } of sticky.tickets)
    referenceChars = Math.max(referenceChars, reference.length);
  const { conflicts } = useConflicts();
  const needsReview = new Set(
    conflicts.filter((item) => item.kind === "ticket").map((item) => item.id),
  );
  const rows = useRef(new Map<string, HTMLButtonElement>());
  // The list is one Tab stop (roving tabindex, list R-08): the row last
  // focused, else the open ticket, else the first row.
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  // Groups and rows share one list so a row that changes group keeps its
  // element and the list keeps its scroll position.
  const entries: (
    { header: ReturnType<typeof groupTickets>[number] } | { ticket: Ticket }
  )[] =
    grouping && !singleStatus
      ? groupTickets(sticky.tickets, grouping.counts, sticky.status).flatMap(
          (group) => [
            { header: group },
            ...group.tickets.map((ticket) => ({ ticket })),
          ],
        )
      : sticky.tickets.map((ticket) => ({ ticket }));
  const ordered = entries.flatMap((entry) =>
    "ticket" in entry ? [entry.ticket] : [],
  );
  const tabStop =
    ordered.find((ticket) => ticket.id === focusedRow)?.id ??
    ordered.find((ticket) => ticket.reference === selected)?.id ??
    ordered[0]?.id;
  const focusRow = (ticket: Ticket | undefined) => {
    if (ticket) rows.current.get(ticket.id)?.focus();
  };
  // Where a Shift range starts: the ticket last toggled by itself.
  const anchor = useRef<string | null>(null);
  // A Shift-click already applied its range; its change event must not toggle.
  const ranged = useRef(false);
  const range = (to: Ticket) => {
    const from = ordered.findIndex((item) => item.reference === anchor.current);
    const end = ordered.indexOf(to);
    if (from < 0 || end < 0) return [to.reference];
    const [low, high] = from < end ? [from, end] : [end, from];
    return ordered.slice(low, high + 1).map((item) => item.reference);
  };
  const canSelect = selectable && !selectionDisabled;
  const keyOf = (entry: (typeof entries)[number]) =>
    "header" in entry ? `group-${entry.header.status}` : entry.ticket.id;
  // Rows are measured for a glide only when the order changes, not on every
  // hover or focus.
  const keys = entries.map(keyOf);
  const order = keys.join();
  // The cascade is one-shot: only the rows in view when the list mounts take
  // part, and they fade up in place with no height. The rest of what mounted is
  // simply there. A row added later opens its own space, and so does one that
  // left and came back, so a row's place in either set ends when it leaves.
  const [mounted, setMounted] = useState<Mounted>(() =>
    cascadeRequested && !pageArriving()
      ? firstScreen(keys)
      : { cascading: new Set(), still: new Set() },
  );
  const kept = stillHere(mounted, new Set(keys));
  if (kept !== mounted) setMounted(kept);
  // A list that is shown again after being hidden (the First-run guide giving
  // way, a page coming back) arrives with its page: the shell cascades it. What
  // mounts in that same commit is simply there, so a row has one owner for its
  // arrival and its rise does not play twice. (`wasHidden` lags the reveal by a
  // frame, which is what makes it visible in the commit that shows the list.)
  const hidden = useContext(HiddenContext);
  const [wasHidden, setWasHidden] = useState(hidden);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setWasHidden(hidden));
    return () => cancelAnimationFrame(frame);
  }, [hidden]);
  const revealed = wasHidden && !hidden;
  useEffect(() => {
    if (cascadeRequested) onCascaded?.();
  }, [cascadeRequested, onCascaded]);
  // The motion tokens, once for every row of this render.
  const tokens = rowTokens();
  return (
    <>
      {/* Once the last rows are leaving, the list's own padding closes with them. */}
      <ul
        className="ticket-rows"
        data-empty={entries.length === 0 || undefined}
        style={{ "--reference-chars": referenceChars } as CSSProperties}
      >
        <Presence initial={mounted.cascading.size > 0}>
          {entries.map((entry, position) => {
            const key = keys[position]!;
            const cascades = mounted.cascading.has(key);
            const rowMotion = (name: "smooth" | "travel", gap?: number) => {
              const shape = { space: !cascades, gap };
              return {
                ...glide(order, name, tokens),
                ...arrival(cascades ? position : 0, shape, tokens),
                ...departure({ space: true, gap }, tokens),
                // Below the first screen of a cascade: there, not arriving.
                ...((revealed || mounted.still.has(key)) && {
                  initial: false as const,
                }),
              };
            };
            if ("header" in entry) {
              const { status, count, tickets: shown } = entry.header;
              // Ready is summarised here, not repeated on every row (list R-10);
              // only a whole group can say how many are ready.
              const ready =
                status === "Todo" && shown.length === count
                  ? shown.filter((ticket) => readiness(ticket).kind === "ready")
                      .length
                  : 0;
              return (
                <Item key={`group-${status}`} variant="ledger-group" asChild>
                  <m.li
                    className="ticket-group-header"
                    data-status={status}
                    // The gap above a group opens and closes with its header.
                    {...rowMotion("smooth", position === 0 ? 0 : 6)}
                  >
                    <StatusIcon status={status} decorative />
                    <h2>{status}</h2>
                    {/* Always the group's total, never the part shown (list R-09). */}
                    {/* The noun sits outside Count so the number alone crossfades. */}
                    <Count>{count}</Count>
                    <span className="sr-only">
                      {" "}
                      {count === 1 ? "ticket" : "tickets"}
                    </span>
                    {status === "Todo" && shown.length === count && (
                      <span className="ticket-group-meta">
                        <CrossfadeText>{`· ${ready} ready`}</CrossfadeText>
                      </span>
                    )}
                    {grouping?.onAdd && (
                      // Revealed on header hover or focus; it stays in the tab order.
                      <span className="ticket-group-add">
                        <IconButton
                          // The Duplicate group's action names what it opens (R-03).
                          label={
                            status === "Duplicate"
                              ? "Mark a ticket as duplicate…"
                              : `Add ${status} ticket`
                          }
                          onClick={(event) =>
                            grouping.onAdd?.(status, event.currentTarget)
                          }
                        >
                          <Plus aria-hidden="true" />
                        </IconButton>
                      </span>
                    )}
                  </m.li>
                </Item>
              );
            }
            const { ticket } = entry;
            const index = ordered.indexOf(ticket);
            const arriving = sticky.arrivals.has(ticket.id);
            return (
              <Item
                key={ticket.id}
                variant={navigator ? "navigator" : "ledger"}
                asChild
              >
                <m.li
                  // A row released from its hold travels to its new group.
                  {...rowMotion(arriving ? "travel" : "smooth")}
                  data-arrive="row"
                  data-arrival-fill={arriving || undefined}
                  onAnimationEnd={(event) => {
                    if (
                      event.target instanceof HTMLElement &&
                      event.target.dataset.slot === "arrival"
                    )
                      sticky.onArrivalEnd(ticket.id);
                  }}
                  onPointerEnter={() => sticky.onPointerEnter(ticket.id)}
                  onPointerLeave={sticky.onPointerLeave}
                >
                  {!selectable && (
                    // Keeps rows aligned with lists that have a selection column.
                    <span className="ticket-select" aria-hidden="true" />
                  )}
                  {selectable && (
                    <label className="ticket-select">
                      <input
                        type="checkbox"
                        tabIndex={-1}
                        aria-label={`Select ${ticket.reference}`}
                        checked={bulkSelection.includes(ticket.reference)}
                        disabled={selectionDisabled}
                        onClick={(event) => {
                          // Shift-click selects the range from the last ticket toggled.
                          if (
                            event.shiftKey &&
                            anchor.current &&
                            onSelectMany
                          ) {
                            event.preventDefault();
                            ranged.current = true;
                            window.setTimeout(
                              () => (ranged.current = false),
                              0,
                            );
                            onSelectMany(range(ticket));
                          }
                        }}
                        onChange={() => {
                          if (ranged.current) {
                            ranged.current = false;
                            return;
                          }
                          anchor.current = ticket.reference;
                          onToggle(ticket.reference);
                        }}
                      />
                    </label>
                  )}
                  <button
                    ref={(node) => {
                      if (node) rows.current.set(ticket.id, node);
                      else rows.current.delete(ticket.id);
                    }}
                    type="button"
                    className="ticket-row"
                    data-ticket-reference={ticket.reference}
                    data-rows={simple ? "simple" : "detailed"}
                    data-status={ticket.status}
                    aria-pressed={ticket.reference === selected}
                    tabIndex={ticket.id === tabStop ? 0 : -1}
                    onClick={(event) => {
                      if (event.detail <= 1) onOpen(ticket.reference);
                    }}
                    onFocus={(event) => {
                      setFocusedRow(ticket.id);
                      event.currentTarget.scrollIntoView?.({
                        block: "nearest",
                      });
                    }}
                    onKeyDown={(event) => {
                      const plain =
                        !event.metaKey && !event.ctrlKey && !event.altKey;
                      if (
                        canSelect &&
                        onSelectMany &&
                        event.shiftKey &&
                        (event.key === "ArrowDown" || event.key === "ArrowUp")
                      ) {
                        // Shift+↑/↓ extends the selection as focus moves.
                        event.preventDefault();
                        const next =
                          ordered[index + (event.key === "ArrowDown" ? 1 : -1)];
                        if (!next) return;
                        anchor.current ??= ticket.reference;
                        onSelectMany(range(next));
                        focusRow(next);
                      } else if (
                        canSelect &&
                        onSelectMany &&
                        (event.metaKey || event.ctrlKey) &&
                        !event.altKey &&
                        event.key.toLowerCase() === "a"
                      ) {
                        // Mod+A selects every listed ticket.
                        event.preventDefault();
                        onSelectMany(ordered.map((item) => item.reference));
                      } else if (
                        event.key === "ArrowDown" ||
                        event.key === "ArrowUp" ||
                        (plain && (event.key === "j" || event.key === "k"))
                      ) {
                        event.preventDefault();
                        const down =
                          event.key === "ArrowDown" || event.key === "j";
                        const next = ordered[index + (down ? 1 : -1)];
                        focusRow(next);
                        if (selected && next) onOpen(next.reference);
                      } else if (event.key === "Home" || event.key === "End") {
                        event.preventDefault();
                        focusRow(
                          event.key === "Home" ? ordered[0] : ordered.at(-1),
                        );
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        onOpen(ticket.reference);
                      } else if (
                        event.key === " " &&
                        selectable &&
                        !selectionDisabled
                      ) {
                        // Space selects for bulk actions; Enter opens.
                        event.preventDefault();
                        anchor.current = ticket.reference;
                        onToggle(ticket.reference);
                      }
                    }}
                    onKeyUp={(event) => {
                      // Stop the native Space-click that would open the ticket.
                      if (event.key === " " && selectable && !selectionDisabled)
                        event.preventDefault();
                    }}
                    aria-keyshortcuts={
                      selectable
                        ? "Space Enter Shift+ArrowDown Shift+ArrowUp Meta+A Control+A"
                        : undefined
                    }
                  >
                    <RowFace
                      ticket={ticket}
                      grouped={Boolean(grouping && !singleStatus)}
                      scope={scope}
                      simple={simple}
                      navigator={navigator}
                      needsReview={needsReview.has(ticket.id)}
                      chat={ticketChats.get(ticket.reference)}
                      reminder={attention?.reminders.get(ticket.reference)}
                    />
                  </button>
                  {rowAction && (
                    <span className="ticket-row-action">
                      {rowAction(ticket)}
                    </span>
                  )}
                  {ticket.reference === selected && (
                    // The open ticket's highlight glides between rows.
                    <Glide id="ticket-list-open" />
                  )}
                  {arriving && <Arrival at={1} />}
                </m.li>
              </Item>
            );
          })}
        </Presence>
      </ul>
      <Presence initial={false}>
        {/* Nobody sees it while the list is hidden, and it must not be left to fade out over the page that replaces the list. */}
        {!hidden && sticky.tickets.length === 0 && empty && (
          <Appear key="empty" rise="overlay">
            {empty}
          </Appear>
        )}
      </Presence>
    </>
  );
}

/** The owner of an externally owned ticket; a local ticket has no pill. */
export function SourcePill({ ticket }: { ticket: Ticket }) {
  const source = externalSource(ticket);
  if (!source) return null;
  return (
    <Tooltip content={`Owned by ${source.provider_name}: ${source.display}`}>
      <Badge
        variant="source"
        // Raised: the pill keeps its fill when the row is hovered or selected.
        tone="raised"
      >
        <span className="sr-only">
          Owned by {source.provider_name}, {source.number}
        </span>
        <Cloud aria-hidden="true" />
        <span aria-hidden="true">{source.number}</span>
      </Badge>
    </Tooltip>
  );
}

function ContextIcon({ kind }: { kind: RowContextKind | "unlinked" }) {
  const props = { "aria-hidden": true } as const;
  // The Duplicate status glyph, never a copy icon (list R-06).
  if (kind === "duplicate")
    return <StatusIcon status="Duplicate" size={12} decorative />;
  if (kind === "subticket") return <CornerDownRight {...props} />;
  if (kind === "unlinked") return <Folder {...props} strokeDasharray="2 3" />;
  return kind === "plan" ? <Layers {...props} /> : <Folder {...props} />;
}

type RowFaceProps = {
  ticket: Ticket;
  /** The group header names the status, so the row's glyph has no tooltip. */
  grouped: boolean;
  scope: RowScope;
  simple: boolean;
  navigator: boolean;
  needsReview: boolean;
  chat: ChatSummary | undefined;
  reminder: string | null | undefined;
};

/**
 * What a row shows. The list re-renders for every open, hover target, focus and
 * selection change, and the motion of the ticket pane, the sidebar and the
 * palette starts in that same commit, so a row re-renders only when what it
 * shows changes. The scope arrives as a new object each render; its parts are
 * compared.
 */
const RowFace = memo(function RowFace({
  ticket,
  grouped,
  ...details
}: RowFaceProps) {
  return (
    <>
      {grouped ? (
        // The group header already names the status (list R-02).
        <span className="ticket-row-status">
          <StatusIcon status={ticket.status} />
        </span>
      ) : (
        <Tooltip content={ticket.status}>
          <span className="ticket-row-status">
            <StatusIcon status={ticket.status} />
          </span>
        </Tooltip>
      )}
      {!details.navigator && <Reference>{ticket.reference}</Reference>}

      <span className="ticket-title-lane">
        <Tooltip content={ticket.title} overflowOnly>
          <span className="ticket-title">{ticket.title}</span>
        </Tooltip>
        <SourcePill ticket={ticket} />
      </span>
      <RowDetails ticket={ticket} {...details} />
    </>
  );
}, sameRowFace);

function sameRowFace(before: RowFaceProps, after: RowFaceProps): boolean {
  const { scope: a, ...restBefore } = before;
  const { scope: b, ...restAfter } = after;
  return (
    a.showPlan === b.showPlan &&
    a.showProject === b.showProject &&
    a.plans === b.plans &&
    a.projects === b.projects &&
    (Object.keys(restBefore) as (keyof typeof restBefore)[]).every(
      (key) => restBefore[key] === restAfter[key],
    )
  );
}

/** Each mode renders only its own caption or lanes, with shared state labels. */
function RowDetails({
  ticket,
  scope,
  simple,
  navigator,
  needsReview,
  chat,
  reminder,
}: {
  ticket: Ticket;
  scope: RowScope;
  simple: boolean;
  navigator: boolean;
  needsReview: boolean;
  chat: ChatSummary | undefined;
  reminder: string | null | undefined;
}) {
  const now = useNow();
  const state = readiness(ticket);
  const context = rowContextItem(ticket, scope, false);
  const duplicate = rowContextItem(ticket, scope);
  const unavailable = Boolean(externalSource(ticket)?.unavailable);
  const contextLabel =
    context?.label ?? (ticket.project_id ? "" : "No project");
  const update = ticket.progress_summary;
  const harness = editingHarness(update?.editing_agent);
  const due = reminder && Date.parse(reminder) <= now;
  const live = chat?.status.rank;
  const label = needsReview
    ? "Needs review"
    : unavailable
      ? "Source unavailable"
      : live === "approval"
        ? "Approval needed"
        : live === "working"
          ? "Working"
          : state.kind === "blocked"
            ? readinessLabel(state)
            : due
              ? "Reminder due"
              : ticket.status === "In review" && update?.editing_agent
                ? "Ready for review"
                : duplicate?.kind === "duplicate"
                  ? duplicate.label
                  : "";
  return (
    <>
      {navigator ? (
        <span className="ticket-navigator-caption">
          <Reference>{ticket.reference}</Reference>
          <span>·</span>
          {label === "Working" && chat ? (
            <HarnessMark harness={chat.harness_id} name={chat.harness_name} />
          ) : (!label || label === "Ready for review") && harness ? (
            <HarnessMark
              harness={harness}
              name={update?.editing_agent ?? harness}
            />
          ) : null}
          <span aria-label={label || undefined}>
            {label ||
              (update
                ? `${update.editing_agent ?? "You"} · ${progressBrief(update.brief.text)}`
                : contextLabel)}
          </span>
        </span>
      ) : (
        <>
          <span className="ticket-row-state" aria-label={label || undefined}>
            {label && (
              <Tooltip content={label}>
                <span
                  className={`ticket-row-state-content ${label === "Working" ? "text-foreground" : label === "Approval needed" || state.kind === "blocked" ? "text-status-blocked" : ""}`}
                >
                  {label === "Working" && chat ? (
                    <HarnessMark
                      harness={chat.harness_id}
                      name={chat.harness_name}
                    />
                  ) : label === "Ready for review" ? (
                    harness ? (
                      <HarnessMark
                        harness={harness}
                        name={update?.editing_agent ?? ""}
                      />
                    ) : (
                      <Bot size={12} aria-hidden="true" />
                    )
                  ) : label === "Reminder due" ? (
                    <AlarmClock size={12} aria-hidden="true" />
                  ) : label === duplicate?.label &&
                    duplicate?.kind === "duplicate" &&
                    !needsReview &&
                    !unavailable ? (
                    <StatusIcon status="Duplicate" size={12} decorative />
                  ) : (
                    <StatusDot tone="attention" size={6} />
                  )}
                  <span className="ticket-row-state-label">{label}</span>
                  {label === "Working" && (
                    <LoaderCircle
                      size={12}
                      className="chat-spin"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </Tooltip>
            )}
          </span>
          <span className="ticket-row-tags-lane">
            <RowTags tags={ticket.tags} ledger />
          </span>
          <span className="ticket-row-context" data-kind={context?.kind}>
            {contextLabel && (
              <>
                <ContextIcon kind={context?.kind ?? "unlinked"} />
                <span className="ticket-row-context-label">{contextLabel}</span>
              </>
            )}
          </span>
        </>
      )}
      <span className="ticket-row-time">
        {ticket.updated_at ? (
          <Tooltip content={formatDateTime(ticket.updated_at)}>
            <time dateTime={ticket.updated_at}>
              <span className="sr-only">
                {ticket.trashed ? "Trashed" : "Updated"}{" "}
                {ago(ticket.updated_at, now)}
              </span>
              <span aria-hidden="true">
                {ticket.trashed ? "Trashed " : ""}
                {compactAgo(ticket.updated_at, now)}
              </span>
            </time>
          </Tooltip>
        ) : (
          <span aria-label="Update time unknown">—</span>
        )}
      </span>
      {!navigator && !simple && (
        <span className="ticket-row-update">
          {update?.editing_agent ? (
            <>
              {harness ? (
                <HarnessMark
                  harness={harness}
                  name={update.editing_agent}
                  decorative
                />
              ) : (
                <Bot size={12} aria-hidden="true" />
              )}
              <span>{update.editing_agent}:</span>
              <span className="ticket-row-update-brief">
                {progressBrief(update.brief.text)}
                {update.brief.truncated ? "…" : ""}
              </span>
            </>
          ) : (
            contextLabel
          )}
        </span>
      )}
    </>
  );
}
