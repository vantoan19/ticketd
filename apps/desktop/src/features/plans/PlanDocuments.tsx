import { useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { documents, type DocumentSummary } from "@/features/documents/api";
import { DocumentNavigation } from "@/features/documents/navigation";
import { plansClient, type View } from "@/lib/api/plans";
import type { PlanViewState } from "./usePlanView";

export function PlanDocuments({
  view,
  state,
}: {
  view: View;
  state: PlanViewState;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [choices, setChoices] = useState<DocumentSummary[]>([]);
  const [error, setError] = useState("");
  const openDocument = useContext(DocumentNavigation);
  async function find() {
    try {
      setChoices(
        query.trim()
          ? await documents.search(query, null, 0, true)
          : await documents.recent(0, true),
      );
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }
  const spec = view.documents.find(
    (doc) => doc.id === view.plan.spec_document_id,
  );
  const supporting = view.documents.filter((doc) => doc.id !== spec?.id);
  function documentRow(doc: View["documents"][number]) {
    return (
      <li key={doc.id} className="plan-document-row">
        <button type="button" onClick={() => openDocument?.(doc.id)}>
          {doc.heading}
        </button>
        {doc.trashed && " (Trashed)"}
        {doc.id === spec?.id ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={state.pending}
            onClick={() =>
              void state.run(() => plansClient.setSpec(view.plan.id, null))
            }
          >
            Clear spec
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={state.pending || doc.trashed}
            onClick={() =>
              void state.run(() => plansClient.setSpec(view.plan.id, doc.id))
            }
          >
            Set as spec
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={state.pending}
          onClick={() =>
            void state.run(() =>
              plansClient.setDocument(view.plan.id, doc.id, false),
            )
          }
        >
          Remove
        </Button>
      </li>
    );
  }
  return (
    <section className="plan-documents" aria-label="Plan context">
      {spec && (
        <div>
          <p>Primary spec</p>
          <ul>{documentRow(spec)}</ul>
        </div>
      )}
      {supporting.length > 0 && (
        <details>
          <summary>
            {supporting.length} linked{" "}
            {supporting.length === 1 ? "Document" : "Documents"}
          </summary>
          <ul>{supporting.map(documentRow)}</ul>
        </details>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setAdding(!adding);
          if (!adding) void find();
        }}
      >
        Add context
      </Button>
      {adding && (
        <div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void find();
            }}
          >
            <label htmlFor="plan-document-search">Find a Document</label>
            <Input
              id="plan-document-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              Search
            </Button>
          </form>
          {error && <p role="alert">{error}</p>}
          <ul>
            {choices
              .filter(
                (doc) => !view.documents.some((linked) => linked.id === doc.id),
              )
              .map((doc) => (
                <li key={doc.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={state.pending}
                    onClick={() =>
                      void state.run(() =>
                        plansClient.setDocument(view.plan.id, doc.id, true),
                      )
                    }
                  >
                    {doc.heading}
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
