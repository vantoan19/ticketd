import { useContext, useState } from "react";
import { FileText, MoreHorizontal, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  function documentRow(doc: View["documents"][number]) {
    const isSpec = doc.id === spec?.id;
    return (
      <li key={doc.id} className="plan-document-row">
        <FileText aria-hidden="true" size={14} />
        <button
          type="button"
          className={isSpec ? "plan-spec-chip" : undefined}
          title={doc.heading}
          onClick={() => openDocument?.(doc.id, `Back to ${view.plan.name}`)}
        >
          {isSpec ? `Spec: ${doc.heading}` : doc.heading}
          {doc.trashed && " (Trashed)"}
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
      {spec && <ul>{documentRow(spec)}</ul>}
      {supporting.length > 0 && (
        <details>
          <summary>
            {supporting.length} linked{" "}
            {supporting.length === 1 ? "Document" : "Documents"}
          </summary>
          <ul>{supporting.map(documentRow)}</ul>
        </details>
      )}
      {!readOnly && (
        <IconButton
          label="Add context"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          <Plus />
        </IconButton>
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
