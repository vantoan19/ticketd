import { emptyCopy } from "@/lib/empty-copy";
import { SectionHeader } from "@/components/ui/section-header";
import { ContextGraphNavigation } from "./navigation";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText, Pin, Plus, Search, Tag, Trash2 } from "lucide-react";
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
  const searchInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => {
    void Promise.all([
      documents.recent(recentOffset, includeSupport),
      documents.pins(pinOffset),
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
      void documents
        .trash(trashOffset)
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
      void documents
        .all(allOffset, includeSupport)
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
      void documents
        .search(query, filter.trim() || null, offset, includeSupport)
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
        return (
          <li key={doc.id}>
            <FileText aria-hidden="true" className="document-list-kind" />
            <div className="document-list-content">
              <Button
                variant="ghost"
                className="document-list-open"
                onClick={() => open(doc.id)}
              >
                {doc.heading}
              </Button>
              {doc.origin_ticket && (
                <p className="document-origin">
                  Update details · {doc.origin_ticket}
                </p>
              )}
              {doc.snippet && !sameText(doc.snippet, doc.heading) && (
                <p className="document-snippet">
                  {highlight(doc.snippet, mark)}
                </p>
              )}
              {doc.tags && doc.tags.length > 0 && (
                <p className="document-list-tags">
                  {doc.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      aria-label={`Show Documents tagged ${tag}`}
                      onClick={() => {
                        setFilter(tag);
                        setOffset(0);
                      }}
                    >
                      {tag}
                    </button>
                  ))}
                </p>
              )}
            </div>
            {date && (
              <time className="document-list-date" dateTime={doc.updated_at}>
                {date}
              </time>
            )}
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
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${pinned ? "Unpin" : "Pin"} ${doc.heading}`}
                onClick={() =>
                  listAction(`${pinned ? "unpin" : "pin"} ${doc.heading}`, () =>
                    documents.pin(doc.id, !pinned).then(refresh),
                  )
                }
              >
                <Pin fill={pinned ? "currentColor" : "none"} />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
  const searching = Boolean(query.trim() || filter.trim());
  const captureAction = onCapture && (
    <Button variant="outline" size="sm" onClick={onCapture}>
      <Plus aria-hidden="true" /> Capture
    </Button>
  );
  return (
    <div className="documents-page">
      <div className="documents-list-view" hidden={selected !== null}>
        <SectionHeader
          level={1}
          title="Documents"
          actions={
            onCapture && (
              <Button variant="outline" onClick={onCapture}>
                <Plus aria-hidden="true" /> Capture
              </Button>
            )
          }
        />
        {listError?.kind === "action" && (
          <FailureAlert
            size="compact"
            failure={listError.failure}
            onRetry={listError.retry}
          />
        )}
        <div className="documents-toolbar">
          <div className="documents-tabs">
            {(
              [
                ["recent", "Recently opened"],
                ["all", "All documents"],
                ["trash", "Trash"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={view === value ? "secondary" : "ghost"}
                aria-pressed={view === value}
                onClick={() => {
                  setView(value);
                  setRestored(null);
                }}
              >
                {label}
              </Button>
            ))}
            {!showTrash && (
              <label className="documents-include">
                <input
                  type="checkbox"
                  checked={includeSupport}
                  onChange={(e) => {
                    setIncludeSupport(e.target.checked);
                    setOffset(0);
                    setRecentOffset(0);
                    setAllOffset(0);
                  }}
                />{" "}
                Include update details
              </label>
            )}
            {showTrash && (
              <p role="status" className="documents-include">
                {restored && (
                  <>
                    Restored {restored.heading}.
                    <Button
                      ref={restoredOpen}
                      variant="link"
                      size="sm"
                      onClick={() => open(restored.id)}
                    >
                      Open
                    </Button>
                  </>
                )}
              </p>
            )}
          </div>
          {!showTrash && (
            <div className="documents-search">
              <label htmlFor="document-search" className="sr-only">
                Search Documents
              </label>
              <div className="documents-search-field">
                <Search aria-hidden="true" />
                <Input
                  id="document-search"
                  ref={searchInput}
                  placeholder="Search titles and content…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setOffset(0);
                  }}
                />
              </div>
              {filter.trim() && (
                <span className="documents-tag-filter">
                  Tag: {filter}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove tag filter ${filter}`}
                    onClick={() => {
                      setFilter("");
                      setOffset(0);
                    }}
                  >
                    ×
                  </Button>
                </span>
              )}
              {searching && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setQuery("");
                    setFilter("");
                    setOffset(0);
                    searchInput.current?.focus();
                  }}
                >
                  Clear search and filters
                </Button>
              )}
            </div>
          )}
        </div>
        {listError?.kind === "load" ? (
          <FailureState failure={listError.failure} onRetry={listError.retry} />
        ) : showTrash ? (
          <section ref={trashList}>
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
            {(trashOffset > 0 || trash.length >= 50) && (
              <div className="document-pagination">
                <Button
                  disabled={trashOffset === 0}
                  onClick={() => setTrashOffset(Math.max(0, trashOffset - 50))}
                >
                  Previous trash
                </Button>
                <Button
                  disabled={trash.length < 50}
                  onClick={() => setTrashOffset(trashOffset + 50)}
                >
                  Next trash
                </Button>
              </div>
            )}
          </section>
        ) : searching ? (
          <section>
            <h2>Search results</h2>
            {searchKey !==
            JSON.stringify([query, filter, offset, includeSupport]) ? (
              <p role="status">Searching Documents…</p>
            ) : results.length === 0 ? (
              <p>
                No Documents match{" "}
                {query.trim() ? `“${query.trim()}”` : `tag “${filter.trim()}”`}.
                {!includeSupport &&
                  hiddenMatches &&
                  " Update details are hidden; turn on Include update details to search them."}
              </p>
            ) : (
              <>
                <p role="status" className="documents-count">
                  {results.length >= 50 || offset > 0
                    ? `Showing ${offset + 1}–${offset + results.length}`
                    : `${results.length} ${results.length === 1 ? "result" : "results"}`}
                </p>
                {list(results, query)}
              </>
            )}
            {(offset > 0 || results.length >= 50) && (
              <div className="document-pagination">
                <Button
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Previous
                </Button>
                <Button
                  disabled={results.length < 50}
                  onClick={() => setOffset(offset + 50)}
                >
                  Next
                </Button>
              </div>
            )}
          </section>
        ) : (
          <>
            {view === "recent" && (pins.length > 0 || pinOffset > 0) && (
              <section>
                <h2>Pinned</h2>
                {list(pins)}
                {(pinOffset > 0 || pins.length >= 50) && (
                  <div className="document-pagination">
                    <Button
                      disabled={pinOffset === 0}
                      onClick={() => setPinOffset(Math.max(0, pinOffset - 50))}
                    >
                      Previous pins
                    </Button>
                    <Button
                      disabled={pins.length < 50}
                      onClick={() => setPinOffset(pinOffset + 50)}
                    >
                      Next pins
                    </Button>
                  </div>
                )}
              </section>
            )}
            {view === "all" ? (
              <section>
                <h2>All documents</h2>
                {!allLoaded ? (
                  <EmptyState
                    size="inline"
                    role="status"
                    description="Loading Documents…"
                  />
                ) : (
                  all.length === 0 &&
                  allOffset === 0 && (
                    <EmptyState
                      icon={<FileText />}
                      title={emptyCopy("documents-all").title}
                      description={emptyCopy("documents-all").sentence}
                      action={captureAction}
                    />
                  )
                )}
                {list(all)}
                {(allOffset > 0 || all.length >= 50) && (
                  <div className="document-pagination">
                    <Button
                      disabled={allOffset === 0}
                      onClick={() => setAllOffset(Math.max(0, allOffset - 50))}
                    >
                      Previous
                    </Button>
                    <Button
                      disabled={all.length < 50}
                      onClick={() => setAllOffset(allOffset + 50)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </section>
            ) : (
              <section>
                <h2>Recently opened</h2>
                {!browseLoaded ? (
                  <EmptyState
                    size="inline"
                    role="status"
                    description="Loading Documents…"
                  />
                ) : (
                  recent.length === 0 &&
                  recentOffset === 0 && (
                    <EmptyState
                      icon={<FileText />}
                      title={emptyCopy("documents-recent").title}
                      description={emptyCopy("documents-recent").sentence}
                      action={captureAction}
                    />
                  )
                )}
                {list(
                  recent.filter((doc) => !pins.some((p) => p.id === doc.id)),
                )}
                {(recentOffset > 0 || recent.length >= 50) && (
                  <div className="document-pagination">
                    <Button
                      disabled={recentOffset === 0}
                      onClick={() =>
                        setRecentOffset(Math.max(0, recentOffset - 50))
                      }
                    >
                      Previous recent
                    </Button>
                    <Button
                      disabled={recent.length < 50}
                      onClick={() => setRecentOffset(recentOffset + 50)}
                    >
                      Next recent
                    </Button>
                  </div>
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
