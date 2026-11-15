import { emptyCopy } from "@/lib/empty-copy";
import { PaneHeader } from "@/components/ui/list-header";
import { Count } from "@/components/ui/count";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Pager } from "@/components/ui/pager";
import { IconButton } from "@/components/ui/icon-button";
import { Badge, FilterChip } from "@/components/ui/badge";
import { ContextGraphNavigation } from "./navigation";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, FileText, Pin, Plus, SearchX, Tag, Trash2 } from "lucide-react";
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

/** Today and Yesterday read naturally; anything older is a short calendar date. */
function relativeDate(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) /
      86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
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
}: {
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
  const focusAfterRestore = useRef<number | null>(null);
  const trashList = useRef<HTMLElement>(null);
  const restoredOpen = useRef<HTMLButtonElement>(null);
  // Only mention hidden Activity details when including them would actually find something.
  const [hiddenProbe, setHiddenProbe] = useState({ key: "", found: false });
  const refresh = useCallback(() => {
    void Promise.all([
      upTo(recentOffset, (at) => documents.recent(at, includeSupport)),
      upTo(pinOffset, (at) => documents.pins(at)),
    ])
      .then(([r, p]) => {
        setRecent(r);
        setPins(p);
        setBrowseLoaded(true);
        setListError(null);
      })
      .catch((reason: unknown) => failLoad(reason, "Documents"));
  }, [recentOffset, pinOffset, includeSupport, failLoad]);
  const loadTrash = useCallback(
    () =>
      void upTo(trashOffset, (at) => documents.trash(at))
        .then((items) => {
          setTrash(items);
          setTrashLoaded(true);
          setListError(null);
        })
        .catch((reason: unknown) => failLoad(reason, "Trash")),
    [trashOffset, failLoad],
  );
  useEffect(() => {
    if (!active || !showTrash) return;
    loadTrash();
    // `attempt` reloads after Retry.
  }, [active, showTrash, loadTrash, changeVersion, attempt]);
  useEffect(() => {
    const index = focusAfterRestore.current;
    if (index === null) return;
    focusAfterRestore.current = null;
    // The row that took the restored one's place, else the one above, else Open.
    const buttons = [
      ...(trashList.current?.querySelectorAll<HTMLButtonElement>(
        "[data-restore]",
      ) ?? []),
    ];
    (
      buttons[Math.min(index, buttons.length - 1)] ?? restoredOpen.current
    )?.focus();
  }, [trash]);
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
    if (target)
      void Promise.all([documents.open(target.id), documents.tags(target.id)])
        .then(([doc, values]) => {
          setSelected(doc);
          setTags(values);
          setListError(null);
          setReaderError(null);
        })
        .catch((reason: unknown) => failLoad(reason, "the Document"));
  }, [target, attempt, failLoad]);
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
    void Promise.all([documents.open(id), documents.tags(id)])
      .then(([doc, values]) => {
        setSelected(doc);
        setTags(values);
        setListError(null);
        setReaderError(null);
        refresh();
      })
      .catch((reason: unknown) =>
        setListError({
          failure: describeFailure(reason, "open the Document"),
          kind: "action",
          retry: () => open(id),
        }),
      );
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
  const restore = (doc: DocumentSummary, index: number) =>
    listAction(`restore ${doc.heading}`, () =>
      documents.setTrashed(doc.id, false, crypto.randomUUID()).then(() => {
        setRestored(doc);
        focusAfterRestore.current = index;
        loadTrash();
        refresh();
      }),
    );
  const list = (items: DocumentSummary[], mark = "", inTrash = false) => (
    <ul className="document-list">
      {items.map((doc, index) => {
        const pinned = pins.some((p) => p.id === doc.id);
        const date = relativeDate(doc.updated_at);
        const snippet =
          mark && doc.snippet && !sameText(doc.snippet, doc.heading)
            ? doc.snippet
            : "";
        return (
          // A row at ticket density (DL-06): the title, then one meta line
          // (origin, tags, date); the snippet only in search results.
          <li
            key={doc.id}
            data-open={selected?.id === doc.id || undefined}
            data-pinned={pinned || undefined}
          >
            <FileText aria-hidden="true" className="document-list-kind" />
            <div className="document-list-content">
              <button
                type="button"
                className="document-list-open"
                aria-current={selected?.id === doc.id || undefined}
                onClick={() => open(doc.id)}
              >
                <span className="truncate">{doc.heading}</span>
              </button>
              <p className="document-list-meta">
                {doc.origin_ticket && (
                  <span className="document-origin">
                    Update details · {doc.origin_ticket}
                  </span>
                )}
                {doc.tags?.map((tag) => (
                  <Badge key={tag} size="sm" asChild>
                    <button
                      type="button"
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
                {date && (
                  <time
                    className="document-list-date"
                    dateTime={doc.updated_at}
                  >
                    {date}
                  </time>
                )}
              </p>
              {snippet && (
                <p className="document-snippet">{highlight(snippet, mark)}</p>
              )}
            </div>
            {inTrash ? (
              <Button
                variant="outline"
                size="sm"
                data-restore
                aria-label={`Restore ${doc.heading}`}
                onClick={() => restore(doc, index)}
              >
                Restore
              </Button>
            ) : (
              <span className="document-list-pin">
                <IconButton
                  label={`${pinned ? "Unpin" : "Pin"} ${doc.heading}`}
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
        );
      })}
    </ul>
  );
  const searching = Boolean(query.trim() || filter.trim());
  const shownCount = showTrash
    ? trash.length
    : searching
      ? results.length
      : view === "all"
        ? all.length
        : recent.length;
  return (
    <div
      className="documents-page"
      data-reading={selected !== null || undefined}
    >
      <div className="documents-list-view">
        <PaneHeader
          title="Documents"
          count={<Count>{shownCount}</Count>}
          actions={
            onCapture && (
              <Button size="sm" onClick={onCapture}>
                <Plus aria-hidden="true" />
                New Document
              </Button>
            )
          }
        />
        {/* One toolbar in every view: it never collapses or moves (DL-01, DL-02). */}
        <div className="documents-toolbar">
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
          <SearchInput
            aria-label="Search Documents"
            placeholder="Search Documents…"
            disabled={showTrash}
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setOffset(0);
            }}
          />
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
        {listError?.kind === "action" && (
          <FailureAlert
            size="compact"
            failure={listError.failure}
            onRetry={listError.retry}
          />
        )}
        {listError?.kind === "load" ? (
          <FailureState failure={listError.failure} onRetry={listError.retry} />
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
            {view === "recent" && pins.length > 0 && (
              <section aria-label="Pinned">
                <h2 className="documents-group">
                  <Pin aria-hidden="true" />
                  Pinned
                  <Count>{pins.length}</Count>
                </h2>
                {list(pins)}
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
                {pins.length > 0 && (
                  <h2 className="documents-group">
                    <Clock aria-hidden="true" />
                    Recent
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
                  recent.filter((doc) => !pins.some((p) => p.id === doc.id)),
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
          closeRequest={listRequest ?? 0}
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
            setSelected(null);
            refresh();
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
