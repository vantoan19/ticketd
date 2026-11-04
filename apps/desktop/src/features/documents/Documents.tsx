import { ContextGraphNavigation } from "./navigation";
import { useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  documents,
  type Document,
  type DocumentSummary,
  type DocumentSearchResult,
} from "./api";
import { DocumentEditor } from "./DocumentEditor";
import "./documents.css";

function heading(document: Document) {
  return (
    document.title?.trim() ||
    document.origin_brief?.trim() ||
    document.body
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ||
    "Untitled"
  );
}
export function Documents({
  capture,
  active,
  onCaptureClose,
  currentTicket,
  onOpenTicket,
  onOpenPlan,
  target,
}: {
  capture: boolean;
  active: boolean;
  onCaptureClose: () => void;
  currentTicket: string | null;
  onOpenTicket: (reference: string) => void;
  onOpenPlan: (id: string) => void;
  target: { id: string; key: number } | null;
}) {
  const openGraph = useContext(ContextGraphNavigation);
  const [recent, setRecent] = useState<DocumentSummary[]>([]);
  const [pins, setPins] = useState<DocumentSummary[]>([]);
  const [trash, setTrash] = useState<Document[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState<Document | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
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
      documents.trash(),
    ])
      .then(([r, p, t]) => {
        setRecent(r);
        setPins(p);
        setTrash(t);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [recentOffset, pinOffset, includeSupport]);
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
          if (current) setResults(r);
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
    <ul>
      {items.map((doc) => (
        <li key={doc.id}>
          <Button variant="ghost" onClick={() => open(doc.id)}>
            {doc.heading}
          </Button>
          {doc.origin_ticket && <p>Activity details · {doc.origin_ticket}</p>}
          {"snippet" in doc && typeof doc.snippet === "string" && (
            <p>{doc.snippet}</p>
          )}
          <Button
            variant="ghost"
            aria-label={`${pins.some((p) => p.id === doc.id) ? "Unpin" : "Pin"} ${doc.heading}`}
            onClick={() =>
              void documents
                .pin(doc.id, !pins.some((p) => p.id === doc.id))
                .then(refresh)
                .catch((e: unknown) => setError(String(e)))
            }
          >
            {pins.some((p) => p.id === doc.id) ? "Unpin" : "Pin"}
          </Button>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="documents-page">
      <h1>Documents</h1>
      {error && <p role="alert">{error}</p>}
      <Button variant="outline" onClick={() => setShowTrash(!showTrash)}>
        {showTrash ? "Recently opened" : "Trash"}
      </Button>
      {showTrash ? (
        <section>
          <h2>Trash</h2>
          {trash.length === 0 && <p>Trash is empty.</p>}
          <ul>
            {trash.map((doc) => (
              <li key={doc.id}>
                <Button variant="ghost" onClick={() => open(doc.id)}>
                  {heading(doc)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <label>
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
          <label htmlFor="document-search">Search Documents</label>
          <Input
            id="document-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
          <label htmlFor="document-tag-filter">Filter by tag</label>
          <Input
            id="document-tag-filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setOffset(0);
            }}
          />
          {query.trim() || filter.trim() ? (
            <section>
              <h2>Search results</h2>
              {list(results)}
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
            </section>
          ) : (
            <>
              {(pins.length > 0 || pinOffset > 0) && (
                <section>
                  <h2>Pinned</h2>
                  {list(pins)}
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
                </section>
              )}
              <section>
                <h2>Recently opened</h2>
                {recent.length === 0 && (
                  <Empty>
                    <EmptyHeader>
                      <EmptyDescription>
                        Your captured thoughts will appear here.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {list(
                  recent.filter((doc) => !pins.some((p) => p.id === doc.id)),
                )}
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
              </section>
            </>
          )}
        </>
      )}
      {selected && (
        <DocumentEditor
          key={selected.id}
          initial={selected}
          onOpenDocument={open}
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
          }}
        >
          {openGraph && (
            <Button variant="outline" onClick={() => openGraph(selected.id)}>
              Context graph
            </Button>
          )}
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
            <ul>
              {tags.map((tag) => (
                <li key={tag}>
                  {tag}{" "}
                  <Button
                    variant="ghost"
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
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!newTag.trim()) return;
                void documents
                  .tag(selected.id, newTag, true)
                  .then(() => documents.tags(selected.id))
                  .then((values) => {
                    setTags(values);
                    setNewTag("");
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
