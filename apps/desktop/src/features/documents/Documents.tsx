import { emptyCopy } from "@/lib/empty-copy";
import { PaneHeader, ReturnCrumb } from "@/components/ui/list-header";
import { Count } from "@/components/ui/count";
import { NavigatorSearch } from "@/components/ui/navigator";
import { GroupHeader, PagedGroupBody } from "@/components/ui/grouped-list";
import {
  useGroupFolds,
  useGroupedListFocus,
  usePagedGroup,
} from "@/components/ui/use-grouped-list";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setPreference, usePreferences } from "@/lib/preferences";
import { Pager } from "@/components/ui/pager";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/ui/status-dot";
import { documentRowContext, groupRowContext } from "./row-context";
import { highlight, matchesTitle } from "./search-match";
import { Item } from "@/components/ui/item";
import { formatDateTime, listTime } from "@/lib/format";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import { Badge, FilterChip } from "@/components/ui/badge";
import { ContextGraphNavigation } from "./navigation";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { enter } from "@/components/ui/enter";
import {
  ArrowLeft,
  Clock,
  FileText,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  documents,
  type CurrentWork,
  type Document,
  type DocumentSummary,
  type DocumentSearchResult,
} from "./api";
import { DocumentEditor, type DocumentReading } from "./DocumentEditor";
import { useWorkspaceChange } from "@/lib/workspace-change";
import "./documents.css";

/**
 * Every page from the first up to `offset`, in order: "Show 50 more" appends
 * a page instead of replacing the list (P17).
 */
async function upTo<T>(offset: number, page: (at: number) => Promise<T[]>) {
  const offsets = Array.from({ length: offset / 50 + 1 }, (_, i) => i * 50);
  return (await Promise.all(offsets.map(page))).flat();
}
/** A one-line thought is its own heading and snippet; show it once. */
function sameText(a: string, b: string) {
  const norm = (text: string) =>
    text.replace(/\s+/g, " ").replace(/…$/, "").trim().toLowerCase();
  return norm(a) === norm(b);
}
export type DocumentCommands = {
  search: () => void;
  pin: (() => void) | null;
  pinned: boolean;
};

export function Documents({
  capture,
  active,
  onCapture,
  onCaptureClose,
  currentTicket,
  onOpenTicket,
  onOpenPlan,
  target,
  onDocumentClose,
  listRequest,
  backLabel = "Back to Documents",
  onCommandsChange,
}: {
  onCommandsChange?: (commands: DocumentCommands | null) => void;
  /** Names where the reader's Back button goes: the list, or the ticket it was opened from. */
  backLabel?: string;
  capture: boolean;
  active: boolean;
  onCapture?: () => void;
  onCaptureClose: () => void;
  currentTicket: string | null;
  onOpenTicket: (reference: string) => void;
  onOpenPlan: (id: string) => void;
  target: { id: string; key: number } | null;
  onDocumentClose?: () => void;
  /** Changes when the sidebar asks for the list while a reader is open. */
  listRequest?: number;
}) {
  const openGraph = useContext(ContextGraphNavigation);
  // The button a step used, so the Document it opens takes focus on the same one.
  const steppedWith = useRef<"previous" | "next" | null>(null);
  const [readerCloseRequest, setReaderCloseRequest] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const navigator = useRef<HTMLDivElement>(null);
  const listBody = useRef<HTMLDivElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const restoreSearchFocus = useRef(false);
  useEffect(() => {
    if (!searchOpen && restoreSearchFocus.current) {
      restoreSearchFocus.current = false;
      searchTrigger.current?.focus();
    }
  }, [searchOpen]);
  const [groupPins, setGroupPins] = useState<DocumentSummary[]>([]);
  const engaged = useRef(false);
  const pendingBrowse = useRef<{
    recent: DocumentSummary[];
    pins: DocumentSummary[];
    /** Absent when Current work could not be read: the last one stays. */
    work: CurrentWork | null;
  } | null>(null);
  const releaseBrowse = (
    nextFocus: EventTarget | null = document.activeElement,
  ) => {
    if (
      engaged.current ||
      (nextFocus instanceof Node && navigator.current?.contains(nextFocus))
    )
      return;
    const pending = pendingBrowse.current;
    if (pending) {
      setRecent(pending.recent);
      setGroupPins(pending.pins);
      if (pending.work) setWork(pending.work);
      pendingBrowse.current = null;
    }
  };
  const [recent, setRecent] = useState<DocumentSummary[]>([]);
  const [pins, setPins] = useState<DocumentSummary[]>([]);
  const [trash, setTrash] = useState<DocumentSummary[]>([]);
  const [trashOffset, setTrashOffset] = useState(0);
  // What Documents opens on, and the order of Recent, are kept on this computer.
  const {
    documentsView: view,
    documentsSort: sort,
    openDocuments,
  } = usePreferences();
  const expanded = openDocuments === "expanded";
  const [showTrash, setShowTrash] = useState(false);
  const sorted = view === "recent" && sort !== "opened";
  const [work, setWork] = useState<CurrentWork | null>(null);
  // Plan groups and Open tickets start open. The two folds of old work start closed.
  const { isOpen: groupOpen, setOpen: setGroupOpen } =
    useGroupFolds("documentGroups");
  const finishedOpen = groupOpen("finished", false);
  const unlinkedOpen = groupOpen("unlinked", false);
  const [all, setAll] = useState<DocumentSummary[]>([]);
  const [allOffset, setAllOffset] = useState(0);
  const [allLoaded, setAllLoaded] = useState(false);
  const [selected, setSelected] = useState<Document | null>(null);
  // Documents opened since the list was read: their rows lose the unread dot at once.
  const [openedHere, setOpenedHere] = useState<ReadonlySet<string>>(new Set());
  // Reader identity and failure outlive unrelated successful navigator reads.
  const [opening, setOpening] = useState<{
    id: string;
    failure: FailureDescription | null;
  } | null>(null);
  const openGeneration = useRef(0);
  const loadReader = useCallback((id: string) => {
    const request = ++openGeneration.current;
    setOpening({ id, failure: null });
    setSelected(null);
    return documents.open(id).then(
      (doc) => {
        setOpenedHere((seen) => new Set(seen).add(id));
        if (request !== openGeneration.current) return false;
        setSelected(doc);
        setOpening(null);
        setReaderError(null);
        return true;
      },
      (reason: unknown) => {
        if (request === openGeneration.current)
          setOpening({
            id,
            failure: describeFailure(reason, "open the Document"),
          });
        return false;
      },
    );
  }, []);
  useEffect(() => {
    if (!active || (!selected && !opening)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShortcut(event, "close")) return;
      if (
        document.querySelector(
          '[role="dialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, [contenteditable]")
      )
        return;
      if (page.current?.querySelector('[aria-label="Edit controls"]')) return;
      event.preventDefault();
      if (opening) {
        openGeneration.current++;
        setOpening(null);
        onDocumentClose?.();
      } else setReaderCloseRequest((value) => value + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selected, opening, onDocumentClose]);
  const [browseLoaded, setBrowseLoaded] = useState(false);
  const [searchKey, setSearchKey] = useState("");
  const [trashLoaded, setTrashLoaded] = useState(false);
  const [includeSupport, setIncludeSupport] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [results, setResults] = useState<DocumentSearchResult[]>([]);
  const changeVersion = useWorkspaceChange();
  const [offset, setOffset] = useState(0);
  const [recentOffset, setRecentOffset] = useState(0);
  const [pinOffset, setPinOffset] = useState(0);
  // The list's failure: a load replaces the list, an action shows beside it.
  const [listError, setListError] = useState<{
    failure: FailureDescription;
    kind: "load" | "action";
    retry: () => void;
  } | null>(null);
  // The reader's failure (pin, keep, tags), shown in the reader only.
  const [readerError, setReaderError] = useState<{
    failure: FailureDescription;
    retry: () => void;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryLoad = useCallback(() => setAttempt((value) => value + 1), []);
  const failLoad = useCallback(
    (reason: unknown, things: string) =>
      setListError({
        failure: describeFailure(reason, `load ${things}`),
        kind: "load",
        retry: retryLoad,
      }),
    [retryLoad],
  );
  const [keptId, setKeptId] = useState<string | null>(null);
  // The Document last restored from Trash, said where the Include toggle sits
  // outside Trash, so nothing moves.
  const [restored, setRestored] = useState<DocumentSummary | null>(null);
  // The Trash row whose Restore takes focus once the list reloads.
  const focusAfterRestore = useRef<{
    index: number;
    request: number;
    origin: Element | null;
  } | null>(null);
  const trashGeneration = useRef(0);
  const appliedTrashGeneration = useRef(0);
  const trashList = useRef<HTMLElement>(null);
  const restoredOpen = useRef<HTMLButtonElement>(null);
  // Only mention hidden Activity details when including them would actually find something.
  const [hiddenProbe, setHiddenProbe] = useState({ key: "", found: false });
  const refreshRequest = useRef(0);
  // The update-details choice the shown lists were read with.
  const shownSupport = useRef(false);
  const refresh = useCallback(() => {
    const request = ++refreshRequest.current;
    // Current work is read on its own: its failure must not hide Recent and Pinned.
    const workRead = documents.currentWork(includeSupport).then(
      (value) => ({ value }),
      (reason: unknown) => ({ reason }),
    );
    return Promise.all([
      upTo(recentOffset, (at) => documents.recent(at, includeSupport)),
      upTo(pinOffset, (at) => documents.pins(at)),
      workRead,
    ])
      .then(([r, p, read]) => {
        // A newer refresh owns the answer, whether this one succeeded or failed.
        if (request !== refreshRequest.current) return;
        const w = "value" in read ? read.value : null;
        setPins(p);
        // Rows hold still while the person is on the list, but only for a background
        // refresh: an explicit change of Show update details applies at once.
        const background = shownSupport.current === includeSupport;
        if (
          background &&
          navigator.current?.querySelector("[data-document-row]") &&
          (engaged.current ||
            navigator.current?.contains(document.activeElement))
        ) {
          pendingBrowse.current = { recent: r, pins: p, work: w };
        } else {
          shownSupport.current = includeSupport;
          pendingBrowse.current = null;
          setRecent(r);
          setGroupPins(p);
          if (w) setWork(w);
        }
        setBrowseLoaded(true);
        if ("reason" in read) failLoad(read.reason, "Documents");
        else setListError(null);
      })
      .catch((reason: unknown) => {
        if (request === refreshRequest.current) failLoad(reason, "Documents");
      });
  }, [recentOffset, pinOffset, includeSupport, failLoad]);
  const loadTrash = useCallback(
    (focus?: { index: number; origin: Element | null }) => {
      const request = ++trashGeneration.current;
      // A newer post-Restore read may supersede this one; only the latest read
      // can apply the list and complete that action's pending focus.
      if (focus) focusAfterRestore.current = { ...focus, request };
      else if (focusAfterRestore.current)
        focusAfterRestore.current.request = request;
      void upTo(trashOffset, (at) => documents.trash(at))
        .then((items) => {
          if (request !== trashGeneration.current) return;
          appliedTrashGeneration.current = request;
          setTrash(items);
          setTrashLoaded(true);
          setListError(null);
        })
        .catch((reason: unknown) => {
          if (request === trashGeneration.current) failLoad(reason, "Trash");
        });
    },
    [trashOffset, failLoad],
  );
  useEffect(() => {
    if (!active || !showTrash) return;
    const readGeneration = trashGeneration;
    loadTrash();
    return () => {
      readGeneration.current++;
    };
    // `attempt` reloads after Retry.
  }, [active, showTrash, loadTrash, changeVersion, attempt]);
  useEffect(() => {
    const focus = focusAfterRestore.current;
    if (!active || !showTrash) {
      focusAfterRestore.current = null;
      return;
    }
    if (!focus || focus.request !== appliedTrashGeneration.current) return;
    focusAfterRestore.current = null;
    // A deliberate focus move while the read was pending wins. Removing the
    // original row naturally sends focus to body and still needs recovery.
    if (
      document.activeElement !== focus.origin &&
      !(document.activeElement === document.body && !focus.origin?.isConnected)
    )
      return;
    const buttons = [
      ...(trashList.current?.querySelectorAll<HTMLButtonElement>(
        "[data-restore]",
      ) ?? []),
    ];
    (
      buttons[Math.min(focus.index, buttons.length - 1)] ?? restoredOpen.current
    )?.focus();
  }, [trash, active, showTrash]);
  useEffect(() => {
    if (!active || !sorted) return;
    let current = true;
    const read = sort === "title" ? documents.byTitle : documents.all;
    void upTo(allOffset, (at) => read(at, includeSupport))
      .then((items) => {
        if (!current) return;
        setAll(items);
        setAllLoaded(true);
        setListError(null);
      })
      .catch((reason: unknown) => {
        if (current) failLoad(reason, "Documents");
      });
    return () => {
      current = false;
    };
  }, [
    active,
    sorted,
    sort,
    allOffset,
    includeSupport,
    changeVersion,
    attempt,
    failLoad,
  ]);
  const foldOpen = active && view === "current" && !showTrash;
  const readFinished = useCallback(
    (offset: number) => documents.finished(offset, includeSupport),
    [includeSupport],
  );
  const readUnlinked = useCallback(
    (offset: number) => documents.unlinked(offset, includeSupport),
    [includeSupport],
  );
  const finished = usePagedGroup({
    open: foldOpen && finishedOpen,
    readPage: readFinished,
    revision: changeVersion,
    loadAction: "load Finished work",
  });
  const unlinked = usePagedGroup({
    open: foldOpen && unlinkedOpen,
    readPage: readUnlinked,
    revision: changeVersion,
    loadAction: "load Documents with no Plan or ticket",
  });
  useEffect(() => {
    openGeneration.current++;
    setOpening(null);
  }, [listRequest]);
  useEffect(() => {
    const generation = openGeneration;
    if (target) void loadReader(target.id);
    return () => {
      generation.current++;
    };
  }, [target, loadReader]);
  useEffect(() => {
    if (!active) return;
    refresh();
    // `attempt` reloads after Retry.
  }, [active, capture, refresh, changeVersion, attempt]);
  useEffect(() => {
    let current = true;
    if (!active || (!query.trim() && !filter.trim())) return;
    const search = () => {
      void upTo(offset, (at) =>
        documents.search(query, filter.trim() || null, at, includeSupport),
      )
        .then((r) => {
          if (current) {
            setResults(r);
            setListError(null);
            setSearchKey(
              JSON.stringify([query, filter, offset, includeSupport]),
            );
          }
        })
        .catch((reason: unknown) => {
          if (current)
            setListError({
              failure: describeFailure(reason, "search Documents"),
              kind: "load",
              retry: retryLoad,
            });
        });
    };
    search();
    return () => {
      current = false;
    };
  }, [
    active,
    query,
    filter,
    offset,
    includeSupport,
    changeVersion,
    attempt,
    retryLoad,
  ]);
  const noVisible =
    searchKey === JSON.stringify([query, filter, offset, includeSupport]) &&
    results.length === 0;
  const probeKey = JSON.stringify([query, filter]);
  useEffect(() => {
    let current = true;
    if (!active || includeSupport || !noVisible) return;
    void documents
      .search(query, filter.trim() || null, 0, true)
      .then(
        (r) =>
          current && setHiddenProbe({ key: probeKey, found: r.length > 0 }),
      )
      .catch(() => current && setHiddenProbe({ key: probeKey, found: false }));
    return () => {
      current = false;
    };
  }, [active, includeSupport, noVisible, query, filter, probeKey]);
  const hiddenMatches = hiddenProbe.key === probeKey && hiddenProbe.found;
  const open = (id: string) => {
    void loadReader(id).then((opened) => {
      if (opened) void refresh();
    });
  };
  /** Runs a list action; a failure shows beside the list with Retry. */
  const listAction = (action: string, change: () => Promise<unknown>) =>
    void change().catch((reason: unknown) =>
      setListError({
        failure: describeFailure(reason, action),
        kind: "action",
        retry: () => listAction(action, change),
      }),
    );
  /** Runs a reader action; a failure shows in the reader with Retry. */
  const readerAction = (action: string, change: () => Promise<unknown>) => {
    setReaderError(null);
    void change().catch((reason: unknown) =>
      setReaderError({
        failure: describeFailure(reason, action),
        retry: () => readerAction(action, change),
      }),
    );
  };
  const restore = (doc: DocumentSummary, index: number) => {
    const origin = document.activeElement;
    listAction(`restore ${doc.heading}`, () =>
      documents.setTrashed(doc.id, false, crypto.randomUUID()).then(() => {
        setRestored(doc);
        loadTrash({ index, origin });
        void refresh();
      }),
    );
  };
  const searching = Boolean(query.trim() || filter.trim());
  // Results always start at the top ("Titles"), wherever the list had been scrolled to.
  useLayoutEffect(() => {
    if (searching && listBody.current) listBody.current.scrollTop = 0;
  }, [searching]);
  // A word search lists the Documents whose title matches, then those that match only inside;
  // a search by tag alone has nothing to match and stays one plain list.
  const wordSearch = query.trim() !== "";
  const titleHits = wordSearch
    ? results.filter((doc) => matchesTitle(doc.heading, query))
    : [];
  const bodyHits = wordSearch
    ? results.filter((doc) => !matchesTitle(doc.heading, query))
    : [];
  const ranked = wordSearch ? [...titleHits, ...bodyHits] : results;
  // Current work: the Plan groups in order, then Open tickets, with the two folds last.
  const groups = work?.groups ?? [];
  const groupKey = (plan: { id: string } | null) => plan?.id ?? "open-tickets";
  const currentCount = groups.reduce(
    (sum, group) => sum + group.documents.length,
    0,
  );
  /** Recent's rows without the Documents the Pinned group already lists. */
  const unpinned = (items: DocumentSummary[]) =>
    items.filter((doc) => !groupPins.some((pin) => pin.id === doc.id));
  /** "Recent" over the rows below the Pinned group, so the two groups read apart. */
  const recentHeading = (items: DocumentSummary[]) =>
    groupPins.length > 0 && (
      <h2 className="documents-group">
        <Clock aria-hidden="true" />
        Recent
        <Count>{unpinned(items).length}</Count>
      </h2>
    );
  /** Everything the arrow keys visit, in order: Documents, and the headers that fold them. */
  const rovingItems: string[] = [];
  const visibleRows = showTrash
    ? trash
    : searching
      ? ranked
      : view === "current"
        ? [
            ...groupPins,
            ...groups.flatMap((group) =>
              groupOpen(groupKey(group.plan)) ? group.documents : [],
            ),
            ...finished.rows,
            ...unlinked.rows,
          ]
        : [...groupPins, ...unpinned(sorted ? all : recent)];
  if (!showTrash && !searching && view === "current") {
    rovingItems.push(...groupPins.map((doc) => doc.id));
    for (const group of groups) {
      const key = groupKey(group.plan);
      rovingItems.push(`group:${key}`);
      if (groupOpen(key)) rovingItems.push(...group.documents.map((d) => d.id));
    }
    if (work && work.finished > 0) {
      rovingItems.push("group:finished");
      rovingItems.push(...finished.rows.map((doc) => doc.id));
    }
    if (work && work.unlinked > 0) {
      rovingItems.push("group:unlinked");
      rovingItems.push(...unlinked.rows.map((doc) => doc.id));
    }
  } else rovingItems.push(...visibleRows.map((doc) => doc.id));
  const roving = useGroupedListFocus(
    navigator,
    rovingItems,
    "documents-move",
    selected?.id,
  );
  // The reader's place in the list as it shows now: a step goes to the neighbour in that order.
  // A Document the list shows twice (pinned, and in its Plan group) counts once, at its first row.
  const walkable = visibleRows.filter(
    (doc, index) => visibleRows.findIndex((d) => d.id === doc.id) === index,
  );
  const placeAt = selected
    ? walkable.findIndex((doc) => doc.id === selected.id)
    : -1;
  const reading: DocumentReading | null = selected && {
    expanded,
    onExpandedChange: (value) =>
      setPreference("openDocuments", value ? "expanded" : "split"),
    place: placeAt < 0 ? null : { index: placeAt + 1, total: walkable.length },
    previous: (placeAt > 0 && walkable[placeAt - 1]?.id) || null,
    next: (placeAt >= 0 && walkable[placeAt + 1]?.id) || null,
    focus: steppedWith.current,
    onFocused: () => {
      steppedWith.current = null;
    },
    onStep: (id, direction) => {
      steppedWith.current = direction;
      open(id);
    },
  };
  const commandId =
    visibleRows.find((doc) => doc.id === roving.focusedId)?.id ??
    selected?.id ??
    null;
  const commandPinned = pins.some((doc) => doc.id === commandId);
  const searchCommand = useCallback(() => {
    setSearchOpen(true);
    setShowTrash(false);
    queueMicrotask(() =>
      navigator.current
        ?.querySelector<HTMLInputElement>("input[type=search]")
        ?.focus(),
    );
  }, []);
  const pinCommand = useCallback(
    function pinDocument() {
      if (!commandId) return;
      void documents
        .pin(commandId, !commandPinned)
        .then(refresh)
        .catch((reason: unknown) =>
          setListError({
            failure: describeFailure(reason, "pin the Document"),
            kind: "action",
            retry: pinDocument,
          }),
        );
    },
    [commandId, commandPinned, refresh],
  );
  const commands = useMemo<DocumentCommands>(
    () => ({
      search: searchCommand,
      pin:
        commandId &&
        !showTrash &&
        !(selected?.id === commandId && selected.trashed)
          ? pinCommand
          : null,
      pinned: commandPinned,
    }),
    [searchCommand, pinCommand, commandId, showTrash, selected, commandPinned],
  );
  useEffect(() => {
    onCommandsChange?.(active ? commands : null);
    return () => onCommandsChange?.(null);
  }, [active, commands, onCommandsChange]);
  /** The dot between the parts of a row's meta line. */
  const separator = <span aria-hidden="true">·</span>;
  /** `grouped` rows sit under a header that names their Plan, so they do not repeat it. */
  const list = (
    items: DocumentSummary[],
    {
      mark = "",
      inTrash = false,
      grouped = false,
      passages = false,
      pinnedSection = false,
    }: {
      mark?: string;
      inTrash?: boolean;
      grouped?: boolean;
      passages?: boolean;
      pinnedSection?: boolean;
    } = {},
  ) => (
    <ul className="document-list">
      {items.map((doc, index) => {
        const pinned = pins.some((p) => p.id === doc.id);
        const date = doc.updated_at ? listTime(doc.updated_at) : "";
        const context = grouped
          ? groupRowContext(doc)
          : documentRowContext(doc);
        const duplicate =
          !pinnedSection &&
          !showTrash &&
          !searching &&
          groupPins.some((pin) => pin.id === doc.id);
        const row = roving.item(doc.id, duplicate);
        const snippet =
          passages && doc.snippet && !sameText(doc.snippet, doc.heading)
            ? doc.snippet
            : "";
        const unread = doc.opened === false && !openedHere.has(doc.id);
        // A row with a passage hides its meta line; the button describes itself with it instead,
        // and the unread dot moves in front of the passage.
        const metaId = snippet ? `document-meta-${doc.id}` : undefined;
        const dot = unread && (
          <span role="img" aria-label="Not opened yet">
            <StatusDot tone="unread" size={6} />
          </span>
        );
        return (
          // A row at ticket density (DL-06): the title, then one meta line
          // (origin, tags, date); the snippet only in search results.
          <Item asChild variant="navigator" key={doc.id}>
            <li
              data-open={selected?.id === doc.id || undefined}
              data-pinned={pinned || undefined}
            >
              <div className="document-list-content">
                <button
                  type="button"
                  className="document-list-open"
                  aria-current={selected?.id === doc.id || undefined}
                  aria-describedby={metaId}
                  data-document-row={doc.id}
                  {...row}
                  aria-keyshortcuts={row["aria-keyshortcuts"] + " Enter"}
                  onKeyDown={(event) => {
                    row.onKeyDown(event);
                    if (event.defaultPrevented) return;
                    if (matchesShortcut(event, "documents-pin") && !inTrash) {
                      event.preventDefault();
                      listAction(
                        `${pinned ? "unpin" : "pin"} ${doc.heading}`,
                        () => documents.pin(doc.id, !pinned).then(refresh),
                      );
                    } else if (matchesShortcut(event, "documents-time")) {
                      event.preventDefault();
                      // A row with a passage keeps its time out of sight: nothing to focus.
                      if (!snippet)
                        event.currentTarget
                          .closest("li")
                          ?.querySelector<HTMLElement>("time")
                          ?.focus();
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      open(doc.id);
                    }
                  }}
                  onClick={() => open(doc.id)}
                >
                  <span className="document-list-title">
                    {highlight(doc.heading, mark)}
                  </span>
                </button>
                <p className="document-list-meta" id={metaId}>
                  {!snippet && dot}
                  {date && doc.updated_at && (
                    <Tooltip content={formatDateTime(doc.updated_at)}>
                      <time
                        className="document-list-date"
                        dateTime={doc.updated_at}
                        tabIndex={-1}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Escape" ||
                            event.key === "ArrowLeft"
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            event.currentTarget
                              .closest("li")
                              ?.querySelector<HTMLButtonElement>(
                                "[data-document-row]",
                              )
                              ?.focus();
                          }
                        }}
                      >
                        {date}
                      </time>
                    </Tooltip>
                  )}
                  {date && context && separator}
                  {context && <span className="truncate">{context}</span>}
                  {doc.origin_ticket && (
                    <>
                      {(date || context) && separator}
                      <span className="document-origin">Update details</span>
                      {separator}
                      <span className="document-origin">
                        {doc.origin_ticket}
                      </span>
                    </>
                  )}
                  {doc.tags?.map((tag) => (
                    <Badge key={tag} size="sm" asChild>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`Show Documents tagged ${tag}`}
                        onClick={() => {
                          setFilter(tag);
                          setOffset(0);
                        }}
                      >
                        {tag}
                      </button>
                    </Badge>
                  ))}
                </p>
                {snippet && (
                  <p className="document-snippet">
                    {dot}
                    {highlight(snippet, mark)}
                  </p>
                )}
              </div>
              {inTrash ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-restore
                  tabIndex={-1}
                  aria-label={`Restore ${doc.heading}`}
                  onClick={() => restore(doc, index)}
                >
                  Restore
                </Button>
              ) : (
                <span className="document-list-pin">
                  <IconButton
                    tabIndex={-1}
                    label={`${pinned ? "Unpin" : "Pin"} ${doc.heading}`}
                    shortcut={shortcutLabel("documents-pin")}
                    aria-pressed={pinned}
                    onClick={() =>
                      listAction(
                        `${pinned ? "unpin" : "pin"} ${doc.heading}`,
                        () => documents.pin(doc.id, !pinned).then(refresh),
                      )
                    }
                  >
                    <Pin fill={pinned ? "currentColor" : "none"} />
                  </IconButton>
                </span>
              )}
            </li>
          </Item>
        );
      })}
    </ul>
  );
  // The field says how many Documents match once that is known; "50+" while more can follow.
  const searchTotal =
    searching &&
    searchKey === JSON.stringify([query, filter, offset, includeSupport]) &&
    results.length > 0
      ? `${results.length}${results.length >= offset + 50 ? "+" : ""}`
      : undefined;
  const countKnown = showTrash
    ? trashLoaded
    : searching
      ? searchKey === JSON.stringify([query, filter, offset, includeSupport])
      : view === "current"
        ? work !== null
        : sorted
          ? allLoaded
          : browseLoaded;
  const chooseSupport = (checked: boolean) => {
    setIncludeSupport(checked);
    setOffset(0);
    setRecentOffset(0);
    setAllOffset(0);
    finished.resetPaging();
    unlinked.resetPaging();
  };
  const chooseSort = (value: string) => {
    if (value !== "opened" && value !== "updated" && value !== "title") return;
    if (value === sort) return;
    setAll([]);
    setAllLoaded(false);
    setAllOffset(0);
    setPreference("documentsSort", value);
  };
  const groupHeader = (
    key: string,
    label: string,
    count: number,
    open: boolean,
  ) => (
    <GroupHeader
      label={<span className="documents-group-name">{label}</span>}
      count={count}
      open={open}
      onOpenChange={(next) => setGroupOpen(key, next)}
      roving={roving.item(`group:${key}`)}
    />
  );
  /** One group of word-search results: its name and count, then its rows. */
  const searchGroup = (
    label: string,
    items: DocumentSummary[],
    titles: boolean,
  ) =>
    items.length > 0 && (
      <section aria-label={label} className="documents-search-group">
        <h2 className="documents-search-heading">
          {label} <Count>{items.length}</Count>
        </h2>
        {list(items, { mark: query, passages: !titles })}
      </section>
    );
  const pinnedSection = !showTrash && !searching && groupPins.length > 0 && (
    <section aria-label="Pinned">
      <h2 className="documents-group">
        <Pin aria-hidden="true" />
        Pinned
        <Count>{groupPins.length}</Count>
      </h2>
      {list(groupPins, { pinnedSection: true })}
      {pins.length >= pinOffset + 50 && (
        <Pager
          noun="pinned Documents"
          onMore={() => setPinOffset(pinOffset + 50)}
        />
      )}
    </section>
  );
  // Built only when shown: building its rows claims the list's Tab stop.
  const currentWorkSection = view === "current" && !showTrash && !searching && (
    <section aria-label="Current work">
      {work === null ? (
        <EmptyState
          size="inline"
          role="status"
          description="Loading Documents…"
        />
      ) : (
        currentCount + work.finished + work.unlinked === 0 && (
          <EmptyState
            icon={<FileText />}
            title={emptyCopy("documents-all").title}
            description={emptyCopy("documents-all").sentence}
          />
        )
      )}
      {groups.map((group) => {
        const key = groupKey(group.plan);
        const open = groupOpen(key);
        return (
          <div key={key} className="documents-group-block">
            {groupHeader(
              key,
              group.plan?.name ?? "Open tickets",
              group.documents.length,
              open,
            )}
            {open && list(group.documents, { grouped: true })}
          </div>
        );
      })}
      {work !== null && (work.finished > 0 || work.unlinked > 0) && (
        <div className="documents-folds">
          {work.finished > 0 && (
            <div className="documents-group-block">
              {groupHeader(
                "finished",
                "Finished work",
                work.finished,
                finishedOpen,
              )}
              <PagedGroupBody
                page={finished}
                noun="Documents of finished work"
                loadingText="Loading Documents…"
              >
                {(rows) => list(rows)}
              </PagedGroupBody>
            </div>
          )}
          {work.unlinked > 0 && (
            <div className="documents-group-block">
              {groupHeader(
                "unlinked",
                "No Plan or ticket",
                work.unlinked,
                unlinkedOpen,
              )}
              <PagedGroupBody
                page={unlinked}
                noun="Documents with no Plan or ticket"
                loadingText="Loading Documents…"
              >
                {(rows) => list(rows)}
              </PagedGroupBody>
            </div>
          )}
        </div>
      )}
    </section>
  );
  const optionsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="More">
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        {view === "recent" && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={chooseSort}>
                <DropdownMenuRadioItem value="opened">
                  Recently opened
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="updated">
                  Recently updated
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="title">
                  Title
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuCheckboxItem
          keepOpen={false}
          checked={includeSupport}
          onCheckedChange={chooseSupport}
        >
          Show update details
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setQuery("");
            setFilter("");
            setSearchOpen(false);
            setRestored(null);
            setShowTrash(true);
          }}
        >
          <Trash2 aria-hidden="true" />
          Trash
          {work && <Count className="ml-auto">{work.trashed}</Count>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    // The page stays mounted while another is shown; its entrance (enter.ts)
    // plays again each time it comes back from `hidden`.
    <div
      className="documents-page"
      data-own-entrance=""
      data-reading={selected !== null || opening !== null || undefined}
      data-expanded={expanded || undefined}
      ref={page}
    >
      <div
        className="documents-list-view"
        ref={navigator}
        onPointerEnter={() => {
          engaged.current = true;
        }}
        onPointerLeave={() => {
          engaged.current = false;
          releaseBrowse();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            releaseBrowse(event.relatedTarget);
        }}
        onKeyDown={(event) => {
          if (
            matchesShortcut(event, "documents-search") &&
            !(
              event.target instanceof HTMLElement &&
              event.target.closest("input, textarea, [contenteditable]")
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            searchCommand();
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && searchOpen) {
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(false);
            setQuery("");
            setOffset(0);
            restoreSearchFocus.current = true;
          }
        }}
      >
        <div className="documents-list-head" {...enter(0)}>
          <PaneHeader
            title={showTrash ? "Trash" : "Documents"}
            hideTitle={!showTrash && !searchOpen}
            leading={
              showTrash ? (
                <ReturnCrumb
                  origin="Documents"
                  onReturn={() => {
                    setShowTrash(false);
                    setRestored(null);
                  }}
                />
              ) : undefined
            }
            titleEditor={
              searchOpen ? (
                <NavigatorSearch
                  aria-label="Search Documents"
                  placeholder="Search Documents…"
                  value={query}
                  count={searchTotal}
                  onValueChange={(value) => {
                    setQuery(value);
                    setOffset(0);
                  }}
                />
              ) : undefined
            }
            // While searching, the field takes the whole header (the board's L2).
            actions={
              searchOpen ? undefined : (
                <>
                  <IconButton
                    ref={searchTrigger}
                    label="Search Documents"
                    shortcut={shortcutLabel("documents-search")}
                    aria-keyshortcuts={ariaKeyShortcuts("documents-search")}
                    onClick={() => {
                      setSearchOpen(true);
                      setShowTrash(false);
                    }}
                  >
                    <Search />
                  </IconButton>
                  {onCapture && (
                    <IconButton
                      label="New Document"
                      shortcut={shortcutLabel("capture")}
                      aria-keyshortcuts={ariaKeyShortcuts("capture")}
                      onClick={onCapture}
                    >
                      <Plus />
                    </IconButton>
                  )}
                  {!showTrash && optionsMenu}
                </>
              )
            }
          >
            {!showTrash && !searchOpen && (
              <SegmentedControl
                aria-label="Documents view"
                className="auto-cols-auto"
                value={view}
                onValueChange={(value) => {
                  setPreference("documentsView", value);
                  setRestored(null);
                }}
                options={[
                  {
                    value: "current",
                    label: "Current work",
                    ...(work ? { count: currentCount } : {}),
                  },
                  { value: "recent", label: "Recent" },
                ]}
              />
            )}
          </PaneHeader>
        </div>
        {filter.trim() && (
          <div className="documents-filters">
            <FilterChip
              dimension="Tag"
              value={filter}
              removeLabel={`Remove tag filter ${filter}`}
              onRemove={() => {
                setFilter("");
                setOffset(0);
              }}
            />
          </div>
        )}
        {showTrash && restored && (
          <p role="status" className="documents-restored">
            Restored {restored.heading}.
            <Button
              ref={restoredOpen}
              variant="link"
              size="inline"
              onClick={() => open(restored.id)}
            >
              Open
            </Button>
          </p>
        )}
        {listError && (listError.kind === "action" || countKnown) && (
          <FailureAlert
            size="compact"
            failure={listError.failure}
            onRetry={listError.retry}
          />
        )}
        <div className="documents-list-body" ref={listBody} {...enter(1)}>
          {listError?.kind === "load" && !countKnown ? (
            <FailureState
              failure={listError.failure}
              onRetry={listError.retry}
            />
          ) : showTrash ? (
            <section ref={trashList} aria-label="Trash">
              {!trashLoaded ? (
                <EmptyState
                  size="inline"
                  role="status"
                  description="Loading Trash…"
                />
              ) : (
                trash.length === 0 && (
                  <EmptyState
                    icon={<Trash2 />}
                    title={emptyCopy("documents-trash").title}
                    description={emptyCopy("documents-trash").sentence}
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowTrash(false)}
                      >
                        Browse Documents
                      </Button>
                    }
                  />
                )
              )}
              {list(trash, { inTrash: true })}
              {trash.length >= trashOffset + 50 && (
                <Pager
                  noun="Documents in Trash"
                  onMore={() => setTrashOffset(trashOffset + 50)}
                />
              )}
            </section>
          ) : searching ? (
            <section aria-label="Search results">
              {searchKey !==
              JSON.stringify([query, filter, offset, includeSupport]) ? (
                <p role="status" className="documents-count">
                  Searching Documents…
                </p>
              ) : results.length === 0 ? (
                <EmptyState
                  icon={<SearchX />}
                  title={`No Documents match ${query.trim() ? `“${query.trim()}”` : `tag “${filter.trim()}”`}`}
                  description={
                    !includeSupport && hiddenMatches
                      ? "Update details are hidden, and some match."
                      : "Try another word, or clear the search."
                  }
                  action={
                    !includeSupport && hiddenMatches ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => chooseSupport(true)}
                      >
                        Show update details
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <p role="status" className="sr-only">
                    {results.length === 1
                      ? "1 result"
                      : `${results.length} results`}
                    {wordSearch &&
                      `: ${[
                        titleHits.length > 0 && `${titleHits.length} in titles`,
                        bodyHits.length > 0 &&
                          `${bodyHits.length} inside Documents`,
                      ]
                        .filter(Boolean)
                        .join(", ")}`}
                  </p>
                  {wordSearch ? (
                    <>
                      {searchGroup("Titles", titleHits, true)}
                      {searchGroup("Inside Documents", bodyHits, false)}
                    </>
                  ) : (
                    list(results)
                  )}
                </>
              )}
              {results.length >= offset + 50 && (
                <Pager noun="results" onMore={() => setOffset(offset + 50)} />
              )}
            </section>
          ) : (
            <>
              {pinnedSection}
              {view === "current" ? (
                currentWorkSection
              ) : sorted ? (
                <section aria-label="All Documents">
                  {recentHeading(all)}
                  {!allLoaded ? (
                    <EmptyState
                      size="inline"
                      role="status"
                      description="Loading Documents…"
                    />
                  ) : (
                    all.length === 0 && (
                      <EmptyState
                        icon={<FileText />}
                        title={emptyCopy("documents-all").title}
                        description={emptyCopy("documents-all").sentence}
                      />
                    )
                  )}
                  {list(unpinned(all))}
                  {all.length >= allOffset + 50 && (
                    <Pager
                      noun="Documents"
                      onMore={() => setAllOffset(allOffset + 50)}
                    />
                  )}
                </section>
              ) : (
                <section aria-label="Recently opened">
                  {recentHeading(recent)}
                  {!browseLoaded ? (
                    <EmptyState
                      size="inline"
                      role="status"
                      description="Loading Documents…"
                    />
                  ) : (
                    recent.length === 0 && (
                      <EmptyState
                        icon={<FileText />}
                        title={emptyCopy("documents-recent").title}
                        description={emptyCopy("documents-recent").sentence}
                      />
                    )
                  )}
                  {list(unpinned(recent))}
                  {recent.length >= recentOffset + 50 && (
                    <Pager
                      noun="recent Documents"
                      onMore={() => setRecentOffset(recentOffset + 50)}
                    />
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {opening && (
        <article className="document-workspace" aria-label="Document reader">
          <header className="document-bar">
            <span className="document-return">
              <Button
                variant="ghost"
                size="sm"
                aria-label={backLabel}
                onClick={() => {
                  openGeneration.current++;
                  setOpening(null);
                  onDocumentClose?.();
                }}
              >
                <ArrowLeft aria-hidden="true" />
                {backLabel.replace(/^Back to /, "")}
              </Button>
            </span>
            <span className="document-crumb-title">Document</span>
          </header>
          {opening.failure ? (
            <FailureState
              failure={opening.failure}
              onRetry={() => open(opening.id)}
            />
          ) : (
            <EmptyState role="status" description="Opening Document…" />
          )}
        </article>
      )}
      {selected && (
        <DocumentEditor
          key={selected.id}
          initial={selected}
          {...(reading && { reading })}
          active={active}
          pinned={pins.some((p) => p.id === selected.id)}
          onTogglePin={() => {
            const pinned = pins.some((p) => p.id === selected.id);
            readerAction(
              pinned ? "unpin the Document" : "pin the Document",
              () => documents.pin(selected.id, !pinned).then(refresh),
            );
          }}
          onOpenDocument={open}
          closeRequest={(listRequest ?? 0) + readerCloseRequest}
          backLabel={backLabel}
          {...(openGraph ? { onOpenGraph: openGraph } : {})}
          onOpenPlan={(id) => {
            setSelected(null);
            onOpenPlan(id);
          }}
          onOpenTicket={(reference) => {
            setSelected(null);
            onOpenTicket(reference);
          }}
          onClose={() => {
            const closedId = selected.id;
            setSelected(null);
            void refresh().then(() => {
              if (navigator.current?.closest("[hidden]")) return;
              const row = [
                ...(navigator.current?.querySelectorAll<HTMLButtonElement>(
                  "[data-document-row]",
                ) ?? []),
              ].find((button) => button.dataset.documentRow === closedId);
              (row ?? searchTrigger.current)?.focus();
            });
            onDocumentClose?.();
          }}
        >
          {({ trashed }) => (
            <>
              {readerError && (
                <FailureAlert
                  size="compact"
                  failure={readerError.failure}
                  onRetry={readerError.retry}
                />
              )}
              {!trashed && selected.origin_brief && !selected.kept && (
                <Button
                  onClick={() =>
                    readerAction("keep it in Documents", () =>
                      documents
                        .keep(selected.id, crypto.randomUUID())
                        .then((doc) => {
                          setSelected(doc);
                          setKeptId(doc.id);
                          refresh();
                        }),
                    )
                  }
                >
                  Keep in Documents
                </Button>
              )}
              {keptId === selected.id && selected.kept && (
                // The Visibility row says it; this only announces the change.
                <p role="status" className="sr-only">
                  Kept in Documents.
                </p>
              )}
            </>
          )}
        </DocumentEditor>
      )}
      {capture && (
        <DocumentEditor
          initial={null}
          currentTicket={currentTicket}
          onClose={() => {
            onCaptureClose();
            refresh();
          }}
        />
      )}
    </div>
  );
}
