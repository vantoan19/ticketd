import { useContext, useState } from "react";
import { FileText, MoreHorizontal, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { DocumentNavigation } from "@/features/documents/navigation";
import { DocumentPicker } from "@/features/tickets/DocumentPicker";
import { plansClient, type View } from "@/lib/api/plans";
import type { PlanViewState } from "./usePlanView";
import "@/features/tickets/ticket-documents.css";

export function PlanDocuments({
  view,
  state,
}: {
  view: View;
  state: PlanViewState;
}) {
  const [adding, setAdding] = useState(false);
  const openDocument = useContext(DocumentNavigation);
  const readOnly = view.plan.archived;
  const spec = view.documents.find(
    (doc) => doc.id === view.plan.spec_document_id,
  );
  const supporting = view.documents.filter((doc) => doc.id !== spec?.id);
  // The named chip is the designated spec. A Plan linked to a single Document
  // that was never designated (`plan document` without `plan spec`) shows that
  // Document as the chip too, labeled "Document:", so context never hides
  // behind a disclosure when there is only one thing to show.
  const featured =
    spec ?? (supporting.length === 1 ? supporting[0] : undefined);
  const rest = supporting.filter((doc) => doc.id !== featured?.id);
  function documentRow(doc: View["documents"][number], chip = false) {
    const isSpec = doc.id === spec?.id;
    return (
      <li key={doc.id} className="plan-document-row">
        {!chip && <FileText aria-hidden="true" size={14} />}
        <button
          type="button"
          className={chip ? "plan-spec-chip" : undefined}
          title={doc.heading}
          onClick={() => openDocument?.(doc.id, `Back to ${view.plan.name}`)}
        >
          {chip && (
            <>
              <FileText aria-hidden="true" size={14} />
              <span className="plan-spec-label">
                {isSpec ? "Spec:" : "Document:"}
              </span>{" "}
            </>
          )}
          <span className={chip ? "plan-spec-title" : undefined}>
            {doc.heading}
            {doc.trashed && " (Trashed)"}
          </span>
        </button>
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                label={`Actions for ${doc.heading}`}
                disabled={state.pending}
              >
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              {isSpec ? (
                <DropdownMenuItem
                  onSelect={() =>
                    void state.run(() =>
                      plansClient.setSpec(view.plan.id, null),
                    )
                  }
                >
                  Stop using as spec
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={doc.trashed}
                  onSelect={() =>
                    void state.run(() =>
                      plansClient.setSpec(view.plan.id, doc.id),
                    )
                  }
                >
                  Set as spec
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() =>
                  void state.run(() =>
                    plansClient.setDocument(view.plan.id, doc.id, false),
                  )
                }
              >
                Remove from Plan
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  }
  return (
    <section className="plan-documents" aria-label="Plan context">
      {rest.length > 0 && (
        <details>
          <summary>
            {rest.length} linked {rest.length === 1 ? "Document" : "Documents"}
          </summary>
          <ul>{rest.map((doc) => documentRow(doc))}</ul>
        </details>
      )}
      {featured && <ul>{documentRow(featured, true)}</ul>}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          <Plus data-icon="inline-start" /> Add context
        </Button>
      )}
      {adding && !readOnly && (
        <div className="plan-document-picker">
          <DocumentPicker
            includeSupport
            exclude={view.documents.map((doc) => doc.id)}
            onPick={(doc) =>
              void state.run(() =>
                plansClient.setDocument(view.plan.id, doc.id, true),
              )
            }
          />
        </div>
      )}
    </section>
  );
}
