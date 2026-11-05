import { useEffect, useId, useState } from "react";
import { FileText } from "lucide-react";
import { documents, type DocumentSummary } from "@/features/documents/api";
import { Input } from "@/components/ui/input";

/**
 * Find a Document by title. With no query it lists the most recent ones, so
 * picking never requires knowing an ID.
 */
export function DocumentPicker({
  onPick,
  exclude = [],
  autoFocus = true,
  includeSupport = false,
}: {
  onPick: (document: DocumentSummary) => void;
  /** Document IDs already chosen; they are not offered again. */
  exclude?: string[];
  autoFocus?: boolean;
  /** Also offer Activity details, which are Documents that support a ticket. */
  includeSupport?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState("");
  const listId = useId();
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(
      () => {
        const text = query.trim();
        const request = text
          ? documents.search(text, null, 0, includeSupport)
          : documents.recent(0, includeSupport);
        void request
          .then((found) => {
            if (current) {
              setResults(found);
              setError("");
            }
          })
          .catch((reason: unknown) => {
            if (current) setError(String(reason));
          });
      },
      query ? 150 : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, includeSupport]);
  const shown = (results ?? []).filter((item) => !exclude.includes(item.id));
  return (
    <div className="document-picker">
      <Input
        type="search"
        aria-label="Search Documents by title"
        placeholder="Search Documents by title…"
        value={query}
        autoFocus={autoFocus}
        aria-controls={listId}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <ul id={listId} className="document-picker-list" aria-label="Documents">
        {shown.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="document-picker-item"
              onClick={() => {
                onPick(item);
                // The linked Document leaves the list, so a kept query would
                // only show "No Documents match".
                setQuery("");
              }}
            >
              <FileText aria-hidden="true" />
              <span className="document-picker-text">
                <span className="truncate">{item.heading}</span>
                {item.origin_ticket && (
                  <small>{item.origin_ticket} · Activity details</small>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {results !== null && shown.length === 0 && !error && (
        <p className="document-picker-empty" role="status">
          {query.trim() ? "No Documents match." : "No Documents yet."}
        </p>
      )}
    </div>
  );
}
