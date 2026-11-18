import { emptyCopy } from "@/lib/empty-copy";
import { PaneHeader } from "@/components/ui/list-header";
import { Count } from "@/components/ui/count";
import { NavigatorSearch } from "@/components/ui/navigator";
import { focusNavigatorRow } from "@/lib/navigator";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Pager } from "@/components/ui/pager";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { Item } from "@/components/ui/item";
import { compactAgo, formatDateTime } from "@/lib/format";
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
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { enter } from "@/components/ui/enter";
import {
  ArrowLeft,
  Clock,
  FileText,
  Pin,
  Plus,
  Search,
  SearchX,
  Tag,
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
  type Document,
  type DocumentSummary,
  type DocumentSearchResult,
} from "./api";
import { DocumentEditor } from "./DocumentEditor";
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
/** Wrap case-insensitive occurrences of `query` in <mark>. */
function highlight(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(target, from);
    if (at < 0 || lower.length !== text.length) break;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + target.length)}</mark>);
    from = at + target.length;
  }
  parts.push(text.slice(from));
  return parts;
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
  const [readerCloseRequest, setReaderCloseRequest] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const navigator = useRef<HTMLDivElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const restoreSearchFocus = useRef(false);
  useEffect(() => {
    if (!searchOpen && restoreSearchFocus.current) {
      restoreSearchFocus.current = false;
      searchTrigger.current?.focus();
    }
  }, [searchOpen]);
  const [contexts, setContexts] = useState<Record<string, string | null>>({});
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [groupPins, setGroupPins] = useState<DocumentSummary[]>([]);
  const engaged = useRef(false);
  const pendingBrowse = useRef<{
    recent: DocumentSummary[];
    pins: DocumentSummary[];
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
      pendingBrowse.current = null;
    }
  };
  const [recent, setRecent] = useState<DocumentSummary[]>([]);
  const [pins, setPins] = useState<DocumentSummary[]>([]);
  const [trash, setTrash] = useState<DocumentSummary[]>([]);
  const [trashOffset, setTrashOffset] = useState(0);
  const [view, setView] = useState<"recent" | "all" | "trash">("recent");
  const showTrash = view === "trash";
  const [all, setAll] = useState<DocumentSummary[]>([]);
  const [allOffset, setAllOffset] = useState(0);
  const [allLoaded, setAllLoaded] = useState(false);
  const [selected, setSelected] = useState<Document | null>(null);
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
    return Promise.all([documents.open(id), documents.tags(id)]).then(
      ([doc, values]) => {
        if (request !== openGeneration.current) return false;
        setSelected(doc);
        setTags(values);
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
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [addingTag, setAddingTag] = useState(false);
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
  const refresh = useCallback(() => {
    return Promise.all([
      upTo(recentOffset, (at) => documents.recent(at, includeSupport)),
      upTo(pinOffset, (at) => documents.pins(at)),
    ])
      .then(([r, p]) => {
        setPins(p);
        if (
          navigator.current?.querySelector("[data-document-row]") &&
          (engaged.current ||
            navigator.current?.contains(document.activeElement))
        ) {
          pendingBrowse.current = { recent: r, pins: p };
        } else {
          setRecent(r);
          setGroupPins(p);
        }
        setBrowseLoaded(true);
        setListError(null);
      })
      .catch((reason: unknown) => failLoad(reason, "Documents"));
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
    if (!active || view !== "all") return;
    const load = () =>
      void upTo(allOffset, (at) => documents.all(at, includeSupport))
        .then((items) => {
          setAll(items);
          setAllLoaded(true);
          setListError(null);
        })
        .catch((reason: unknown) => failLoad(reason, "Documents"));
    load();
  }, [
    active,
    view,
    allOffset,
    includeSupport,
    changeVersion,
    attempt,
    failLoad,
  ]);
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
  const visibleRows = showTrash
    ? trash
    : searching
      ? results
      : view === "all"
        ? all
        : [
            ...groupPins,
            ...recent.filter(
              (doc) => !groupPins.some((pin) => pin.id === doc.id),
            ),
          ];
  const visibleIds = visibleRows.map((doc) => doc.id).join(",");
  useEffect(() => {
    if (!active || !visibleIds) return;
    let current = true;
    void Promise.all(
      visibleIds.split(",").map(async (id) => {
        try {
          const links = await documents.links(id);
          const plan = links
            .flat()
            .find(
              (link) =>
                (link.source_kind === "plan" || link.target_kind === "plan") &&
                !link.passage,
            );
          if (!plan) return [id, ""] as const;
          const label =
            plan.source_kind === "plan" ? plan.source_label : plan.target_label;
          return [id, plan.explicit ? label : `Spec of ${label}`] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (current) setContexts(Object.fromEntries(entries));
    });
    return () => {
      current = false;
    };
  }, [active, visibleIds, changeVersion]);
  const tabRow =
    visibleRows.find((doc) => doc.id === focusedRow)?.id ??
    visibleRows.find((doc) => doc.id === selected?.id)?.id ??
    visibleRows[0]?.id;
  const commandId =
    visibleRows.find((doc) => doc.id === focusedRow)?.id ??
    selected?.id ??
    null;
  const commandPinned = pins.some((doc) => doc.id === commandId);
  const searchCommand = useCallback(() => {
    setSearchOpen(true);
    setView((current) => (current === "trash" ? "recent" : current));
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
  const list = (items: DocumentSummary[], mark = "", inTrash = false) => (
    <ul className="document-list">
      {items.map((doc, index) => {
        const pinned = pins.some((p) => p.id === doc.id);
        const date = doc.updated_at ? compactAgo(doc.updated_at) : "";
        const snippet =
          mark && doc.snippet && !sameText(doc.snippet, doc.heading)
            ? doc.snippet
            : "";
        return (
          // A row at ticket density (DL-06): the title, then one meta line
          // (origin, tags, date); the snippet only in search results.
          <Item asChild variant="navigator" key={doc.id}>
            <li
              data-open={selected?.id === doc.id || undefined}
              data-pinned={pinned || undefined}
            >
              <FileText aria-hidden="true" className="document-list-kind" />
              <div className="document-list-content">
                <button
                  type="button"
                  className="document-list-open"
                  aria-current={selected?.id === doc.id || undefined}
                  data-document-row={doc.id}
                  tabIndex={tabRow === doc.id ? 0 : -1}
                  onFocus={() => setFocusedRow(doc.id)}
                  aria-keyshortcuts={
                    ariaKeyShortcuts("documents-move") + " Enter"
                  }
                  onKeyDown={(event) => {
                    if (matchesShortcut(event, "documents-move")) {
                      event.preventDefault();
                      event.stopPropagation();
                      const rows = [
                        ...(navigator.current?.querySelectorAll<HTMLButtonElement>(
                          "[data-document-row]",
                        ) ?? []),
                      ];
                      focusNavigatorRow(rows, event.currentTarget, event.key);
                    } else if (
                      matchesShortcut(event, "documents-pin") &&
                      !inTrash
                    ) {
                      event.preventDefault();
                      listAction(
                        `${pinned ? "unpin" : "pin"} ${doc.heading}`,
                        () => documents.pin(doc.id, !pinned).then(refresh),
                      );
                    } else if (matchesShortcut(event, "documents-time")) {
                      event.preventDefault();
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
                  <span className="truncate">{doc.heading}</span>
                </button>
                <p className="document-list-meta">
                  {contexts[doc.id] ? (
                    <span>{contexts[doc.id]}</span>
                  ) : (
                    !doc.origin_ticket &&
                    !doc.tags?.length && (
                      <span>
                        {contexts[doc.id] === null
                          ? "Links unavailable"
                          : contexts[doc.id] === undefined
                            ? "Loading links…"
                            : "Not linked"}
                      </span>
                    )
                  )}
                  {doc.origin_ticket && (
                    <span className="document-origin">
                      Update details · {doc.origin_ticket}
                    </span>
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
                  <p className="document-snippet">{highlight(snippet, mark)}</p>
                )}
              </div>
              {date && doc.updated_at && (
                <Tooltip content={formatDateTime(doc.updated_at)}>
                  <time
                    className="document-list-date"
                    dateTime={doc.updated_at}
                    tabIndex={-1}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" || event.key === "ArrowLeft") {
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
  const shownCount = showTrash
    ? trash.length
    : searching
      ? results.length
      : view === "all"
        ? all.length
        : recent.length;
  const countKnown = showTrash
    ? trashLoaded
    : searching
      ? searchKey === JSON.stringify([query, filter, offset, includeSupport])
      : view === "all"
        ? allLoaded
        : browseLoaded;
  return (
    // The page stays mounted while another is shown; its entrance (enter.ts)
    // plays again each time it comes back from `hidden`.
    <div
      className="documents-page"
      data-own-entrance=""
      data-reading={selected !== null || opening !== null || undefined}
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
            title="Documents"
            count={countKnown ? <Count>{shownCount}</Count> : undefined}
            titleEditor={
              searchOpen ? (
                <NavigatorSearch
                  aria-label="Search Documents"
                  placeholder="Search Documents…"
                  value={query}
                  onValueChange={(value) => {
                    setQuery(value);
                    setOffset(0);
                  }}
                />
              ) : undefined
            }
            actions={
              <>
                {!searchOpen && (
                  <IconButton
                    ref={searchTrigger}
                    label="Search Documents"
                    shortcut={shortcutLabel("documents-search")}
                    aria-keyshortcuts={ariaKeyShortcuts("documents-search")}
                    onClick={() => {
                      setSearchOpen(true);
                      if (showTrash) setView("recent");
                    }}
                  >
                    <Search />
                  </IconButton>
                )}
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
              </>
            }
          />
        </div>
        {/* One toolbar in every view: it never collapses or moves (DL-01, DL-02). */}
        <div className="documents-toolbar" {...enter(1)}>
          <SegmentedControl
            aria-label="Documents view"
            value={searching && !showTrash ? ("" as typeof view) : view}
            onValueChange={(value) => {
              setView(value);
              setRestored(null);
              if (value === "trash") {
                setQuery("");
                setFilter("");
              }
            }}
            options={[
              { value: "recent", label: "Recent" },
              { value: "all", label: "All" },
              { value: "trash", label: "Trash" },
            ]}
          />
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
        <div {...enter(2)}>
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
                        onClick={() => setView("all")}
                      >
                        Browse Documents
                      </Button>
                    }
                  />
                )
              )}
              {list(trash, "", true)}
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
                      ? "Update details are hidden; turn on Show update details to search them."
                      : "Try another word, or clear the search."
                  }
                />
              ) : (
                <>
                  <p role="status" className="sr-only">
                    {results.length === 1
                      ? "1 result"
                      : `${results.length} results`}
                  </p>
                  {list(results, query)}
                </>
              )}
              {results.length >= offset + 50 && (
                <Pager noun="results" onMore={() => setOffset(offset + 50)} />
              )}
            </section>
          ) : (
            <>
              {view === "recent" && groupPins.length > 0 && (
                <section aria-label="Pinned">
                  <h2 className="documents-group">
                    <Pin aria-hidden="true" />
                    Pinned
                    <Count>{groupPins.length}</Count>
                  </h2>
                  {list(groupPins)}
                  {pins.length >= pinOffset + 50 && (
                    <Pager
                      noun="pinned Documents"
                      onMore={() => setPinOffset(pinOffset + 50)}
                    />
                  )}
                </section>
              )}
              {view === "all" ? (
                <section aria-label="All Documents">
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
                  {list(all)}
                  {all.length >= allOffset + 50 && (
                    <Pager
                      noun="Documents"
                      onMore={() => setAllOffset(allOffset + 50)}
                    />
                  )}
                </section>
              ) : (
                <section aria-label="Recently opened">
                  {groupPins.length > 0 && (
                    <h2 className="documents-group">
                      <Clock aria-hidden="true" />
                      Recent
                      <Count>
                        {
                          recent.filter(
                            (doc) =>
                              !groupPins.some((pin) => pin.id === doc.id),
                          ).length
                        }
                      </Count>
                    </h2>
                  )}
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
                  {list(
                    recent.filter(
                      (doc) => !groupPins.some((p) => p.id === doc.id),
                    ),
                  )}
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
        <label
          className="documents-include"
          data-hidden={showTrash || undefined}
        >
          <Switch
            aria-label="Show update details"
            checked={includeSupport}
            disabled={showTrash}
            onCheckedChange={(checked) => {
              setIncludeSupport(checked);
              setOffset(0);
              setRecentOffset(0);
              setAllOffset(0);
            }}
          />
          Show update details
        </label>
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
              <section aria-label="Document tags">
                <h2>Tags</h2>
                {readerError && (
                  <FailureAlert
                    size="compact"
                    failure={readerError.failure}
                    onRetry={readerError.retry}
                  />
                )}
                <ul className="document-tags">
                  {tags.map((tag) => (
                    <li key={tag}>
                      {tag}{" "}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove tag ${tag}`}
                        disabled={trashed}
                        onClick={() =>
                          readerAction(`remove the tag ${tag}`, () =>
                            documents
                              .tag(selected.id, tag, false)
                              .then(() =>
                                setTags(tags.filter((value) => value !== tag)),
                              ),
                          )
                        }
                      >
                        ×
                      </Button>
                    </li>
                  ))}
                </ul>
                {!addingTag ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={trashed}
                    onClick={() => setAddingTag(true)}
                  >
                    <Tag data-icon="inline-start" aria-hidden="true" />
                    Add tags
                  </Button>
                ) : (
                  <form
                    className="document-tag-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!newTag.trim()) return;
                      const tag = newTag;
                      readerAction(`add the tag ${tag.trim()}`, () =>
                        documents
                          .tag(selected.id, tag, true)
                          .then(() => documents.tags(selected.id))
                          .then((values) => {
                            setTags(values);
                            setNewTag("");
                            setAddingTag(false);
                          }),
                      );
                    }}
                  >
                    <label htmlFor="new-document-tag">Add tag</label>
                    <Input
                      id="new-document-tag"
                      autoFocus
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                    />
                    <Button type="submit">Add tag</Button>
                  </form>
                )}
              </section>
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
