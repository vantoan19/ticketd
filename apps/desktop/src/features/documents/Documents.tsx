import { SectionHeader } from "@/components/ui/section-header";
import { ContextGraphNavigation } from "./navigation";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText, Pin, Plus, Search, Tag, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
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
  const [error, setError] = useState("");
  const [keptId, setKeptId] = useState<string | null>(null);
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
        setError("");
      })
      .catch((e: unknown) => setError(String(e)));
  }, [recentOffset, pinOffset, includeSupport]);
  const loadTrash = useCallback(
    () =>
      void documents
        .trash(trashOffset)
        .then((items) => {
          setTrash(items);
          setTrashLoaded(true);
          setError("");
        })
        .catch((e: unknown) => setError(String(e))),
    [trashOffset],
  );
  useEffect(() => {
    if (!active || !showTrash) return;
    loadTrash();
  }, [active, showTrash, loadTrash, changeVersion]);
  useEffect(() => {
    if (!active || view !== "all") return;
    const load = () =>
      void documents
        .all(allOffset, includeSupport)
        .then((items) => {
          setAll(items);
          setAllLoaded(true);
          setError("");
        })
        .catch((e: unknown) => setError(String(e)));
    load();
  }, [active, view, allOffset, includeSupport, changeVersion]);
  useEffect(() => {
    if (target)
      void Promise.all([documents.open(target.id), documents.tags(target.id)])
        .then(([doc, values]) => {
          setSelected(doc);
          setTags(values);
          setError("");
        })
        .catch((e: unknown) => setError(String(e)));
  }, [target]);
  useEffect(() => {
    if (!active) return;
    refresh();
  }, [active, capture, refresh, changeVersion]);
  useEffect(() => {
    let current = true;
    if (!active || (!query.trim() && !filter.trim())) return;
    const search = () => {
      void documents
        .search(query, filter.trim() || null, offset, includeSupport)
        .then((r) => {
          if (current) {
            setResults(r);
            setError("");
            setSearchKey(
              JSON.stringify([query, filter, offset, includeSupport]),
            );
          }
        })
        .catch((e: unknown) => {
          if (current) setError(String(e));
        });
    };
    search();
    return () => {
      current = false;
    };
  }, [active, query, filter, offset, includeSupport, changeVersion]);
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
        setError("");
        refresh();
      })
      .catch((e: unknown) => setError(String(e)));
  };
  const list = (items: DocumentSummary[], mark = "", inTrash = false) => (
    <ul className="document-list">
      {items.map((doc) => {
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
                aria-label={`Restore ${doc.heading}`}
                onClick={() =>
                  void documents
                    .setTrashed(doc.id, false, crypto.randomUUID())
                    .then(() => {
                      loadTrash();
                      refresh();
                    })
                    .catch((e: unknown) => setError(String(e)))
                }
              >
                Restore
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${pinned ? "Unpin" : "Pin"} ${doc.heading}`}
                onClick={() =>
                  void documents
                    .pin(doc.id, !pinned)
                    .then(refresh)
                    .catch((e: unknown) => setError(String(e)))
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
        {error && <p role="alert">{error}</p>}
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
                onClick={() => setView(value)}
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
        {showTrash ? (
          <section>
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
                  title="Trash is empty"
                  description="Documents you move to Trash wait here until you restore them."
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
                      title="No Documents yet"
                      description="Capture a thought or create a Document to start."
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
                      title="No recent Documents"
                      description="Your captured thoughts will appear here."
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
          onTogglePin={() =>
            void documents
              .pin(selected.id, !pins.some((p) => p.id === selected.id))
              .then(refresh)
              .catch((e: unknown) => setError(String(e)))
          }
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
                    void documents
                      .keep(selected.id, crypto.randomUUID())
                      .then((doc) => {
                        setSelected(doc);
                        setKeptId(doc.id);
                        refresh();
                      })
                      .catch((e: unknown) => setError(String(e)))
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
                {error && <p role="alert">{error}</p>}
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
                          void documents
                            .tag(selected.id, tag, false)
                            .then(() =>
                              setTags(tags.filter((value) => value !== tag)),
                            )
                            .catch((e: unknown) => setError(String(e)))
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
                      void documents
                        .tag(selected.id, newTag, true)
                        .then(() => documents.tags(selected.id))
                        .then((values) => {
                          setTags(values);
                          setNewTag("");
                          setAddingTag(false);
                        })
                        .catch((error: unknown) => setError(String(error)));
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
