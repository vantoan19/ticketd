import { useContext, useState } from "react";
import { FileText, MoreHorizontal, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  // The named chip is the designated spec. A Plan with no designated spec
  // shows its first linked Document as the chip, labeled "Document:", so the
  // context is named however many Documents there are; the others sit behind
  // a "+N" popover.
  const featured = spec ?? supporting[0];
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
      {featured && <ul>{documentRow(featured, true)}</ul>}
      {rest.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="plan-documents-more"
              aria-label={`${rest.length} more linked ${rest.length === 1 ? "Document" : "Documents"}`}
            >
              +{rest.length}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="plan-documents-popover"
            aria-label="More linked Documents"
          >
            <ul>{rest.map((doc) => documentRow(doc))}</ul>
          </PopoverContent>
        </Popover>
      )}
      {!readOnly && (
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverTrigger asChild>
            <IconButton label="Add context" className="plan-add-context">
              <Plus />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="plan-document-picker"
            aria-label="Add context"
          >
            <DocumentPicker
              includeSupport
              exclude={view.documents.map((doc) => doc.id)}
              onPick={(doc) =>
                void state.run(() =>
                  plansClient.setDocument(view.plan.id, doc.id, true),
                )
              }
            />
          </PopoverContent>
        </Popover>
      )}
    </section>
  );
}
