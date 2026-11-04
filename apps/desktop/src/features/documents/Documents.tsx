import { ContextGraphNavigation } from "./navigation";
import { useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pin, PinOff } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  documents,
  type Document,
  type DocumentSummary,
  type DocumentSearchResult,
} from "./api";
import { DocumentEditor } from "./DocumentEditor";
import "./documents.css";

export function Documents({
  capture,
  active,
  onCaptureClose,
  currentTicket,
  onOpenTicket,
  onOpenPlan,
  target,
  onDocumentClose,
}: {
  capture: boolean;
  active: boolean;
  onCaptureClose: () => void;
  currentTicket: string | null;
  onOpenTicket: (reference: string) => void;
  onOpenPlan: (id: string) => void;
  target: { id: string; key: number } | null;
  onDocumentClose?: () => void;
}) {
  const openGraph = useContext(ContextGraphNavigation);
  const [recent, setRecent] = useState<DocumentSummary[]>([]);
  const [pins, setPins] = useState<DocumentSummary[]>([]);
  const [trash, setTrash] = useState<DocumentSummary[]>([]);
  const [trashOffset, setTrashOffset] = useState(0);
  const [showTrash, setShowTrash] = useState(false);
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
  const [offset, setOffset] = useState(0);
  const [recentOffset, setRecentOffset] = useState(0);
  const [pinOffset, setPinOffset] = useState(0);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    void Promise.all([
      documents.recent(recentOffset, includeSupport),
      documents.pins(pinOffset),
    ])
      .then(([r, p]) => {
        setRecent(r);
        setPins(p);
        setBrowseLoaded(true);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [recentOffset, pinOffset, includeSupport]);
  useEffect(() => {
    if (!active || !showTrash) return;
    const load = () =>
      void documents
        .trash(trashOffset)
        .then((items) => {
          setTrash(items);
          setTrashLoaded(true);
        })
        .catch((e: unknown) => setError(String(e)));
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [active, showTrash, trashOffset]);
  useEffect(() => {
    if (target)
      void Promise.all([documents.open(target.id), documents.tags(target.id)])
        .then(([doc, values]) => {
          setSelected(doc);
          setTags(values);
        })
        .catch((e: unknown) => setError(String(e)));
  }, [target]);
  useEffect(() => {
    if (!active) return;
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [active, capture, refresh]);
  useEffect(() => {
    let current = true;
    if (!query.trim() && !filter.trim()) return;
    const search = () => {
      void documents
        .search(query, filter.trim() || null, offset, includeSupport)
        .then((r) => {
          if (current) {
            setResults(r);
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
    const timer = window.setInterval(search, 5000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [query, filter, offset, includeSupport]);
  const open = (id: string) => {
    void Promise.all([documents.open(id), documents.tags(id)])
      .then(([doc, values]) => {
        setSelected(doc);
        setTags(values);
        refresh();
      })
      .catch((e: unknown) => setError(String(e)));
  };
  const list = (items: DocumentSummary[]) => (
    <ul className="document-list">
      {items.map((doc) => (
        <li key={doc.id}>
          <div className="document-list-content">
            <Button
              variant="ghost"
              className="document-list-open"
              onClick={() => open(doc.id)}
            >
              {doc.heading}
            </Button>
            {doc.origin_ticket && <p>Activity details · {doc.origin_ticket}</p>}
            {"snippet" in doc && typeof doc.snippet === "string" && (
              <p>{doc.snippet}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${pins.some((p) => p.id === doc.id) ? "Unpin" : "Pin"} ${doc.heading}`}
            onClick={() =>
              void documents
                .pin(doc.id, !pins.some((p) => p.id === doc.id))
                .then(refresh)
                .catch((e: unknown) => setError(String(e)))
            }
          >
            {pins.some((p) => p.id === doc.id) ? <PinOff /> : <Pin />}
          </Button>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="documents-page">
      <div hidden={selected !== null}>
        <div className="documents-heading">
          <h1>Documents</h1>
          <Button variant="outline" onClick={() => setShowTrash(!showTrash)}>
            {showTrash ? "Recently opened" : "Trash"}
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
        {showTrash ? (
          <section>
            <h2>Trash</h2>
            {!trashLoaded ? (
              <p role="status">Loading Trash…</p>
            ) : (
              trash.length === 0 && <p>Trash is empty.</p>
            )}
            <ul>
              {trash.map((doc) => (
                <li key={doc.id}>
                  <Button variant="ghost" onClick={() => open(doc.id)}>
                    {doc.heading}
                  </Button>
                </li>
              ))}
            </ul>
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
        ) : (
          <>
            <div className="documents-toolbar">
              <label className="documents-include">
                <input
                  type="checkbox"
                  checked={includeSupport}
                  onChange={(e) => {
                    setIncludeSupport(e.target.checked);
                    setOffset(0);
                    setRecentOffset(0);
                  }}
                />{" "}
                Include Activity details
              </label>
              <div className="documents-filters">
                <label htmlFor="document-search">
                  Search Documents
                  <Input
                    id="document-search"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <label htmlFor="document-tag-filter">
                  Filter by tag
                  <Input
                    id="document-tag-filter"
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                {(query.trim() || filter.trim()) && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setQuery("");
                      setFilter("");
                      setOffset(0);
                    }}
                  >
                    Clear search and filters
                  </Button>
                )}
              </div>
            </div>
            {query.trim() || filter.trim() ? (
              <section>
                <h2>Search results</h2>
                {searchKey !==
                JSON.stringify([query, filter, offset, includeSupport]) ? (
                  <p role="status">Searching Documents…</p>
                ) : results.length === 0 ? (
                  <p>No Documents match your search or filters.</p>
                ) : (
                  list(results)
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
                {(pins.length > 0 || pinOffset > 0) && (
                  <section>
                    <h2>Pinned</h2>
                    {list(pins)}
                    {(pinOffset > 0 || pins.length >= 50) && (
                      <div className="document-pagination">
                        <Button
                          disabled={pinOffset === 0}
                          onClick={() =>
                            setPinOffset(Math.max(0, pinOffset - 50))
                          }
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
                <section>
                  <h2>Recently opened</h2>
                  {!browseLoaded ? (
                    <p role="status">Loading Documents…</p>
                  ) : (
                    recent.length === 0 &&
                    recentOffset === 0 && (
                      <Empty>
                        <EmptyHeader>
                          <EmptyDescription>
                            Your captured thoughts will appear here.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
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
              </>
            )}
          </>
        )}
      </div>
      {selected && (
        <DocumentEditor
          key={selected.id}
          initial={selected}
          onOpenDocument={open}
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
          {selected.origin_brief && !selected.kept && (
            <Button
              onClick={() =>
                void documents
                  .keep(selected.id, crypto.randomUUID())
                  .then((doc) => {
                    setSelected(doc);
                    refresh();
                  })
                  .catch((e: unknown) => setError(String(e)))
              }
            >
              Keep in Documents
            </Button>
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
                onClick={() => setAddingTag(true)}
              >
                Add tag
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
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                />
                <Button type="submit">Add tag</Button>
              </form>
            )}
          </section>
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
