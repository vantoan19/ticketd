import { useContext, useId, useState, type RefObject } from "react";
import { FileText, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { RecordLink } from "@/components/ui/record-link";
import { DocumentNavigation } from "@/features/documents/navigation";
import { DocumentPicker } from "@/features/tickets/DocumentPicker";
import { plansClient, type View } from "@/lib/api/plans";
import { usePlanAction, type PlanViewState } from "./usePlanView";

type PlanDocument = View["documents"][number];
type Actions = Pick<PlanViewState, "apply" | "pending">;

export function PlanDocuments({ view, state }: { view: View; state: Actions }) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const openDocument = useContext(DocumentNavigation);
  const act = usePlanAction(state);
  const { id: planId, name: planName, archived } = view.plan;
  const specId = view.plan.spec_document_id;
  const spec = view.documents.find((doc) => doc.id === specId);
  const documents = spec
    ? [spec, ...view.documents.filter((doc) => doc.id !== spec.id)]
    : view.documents;
  if (!documents.length) return null;
  const shown = expanded ? documents : documents.slice(0, 6);
  const setSpec = (doc: PlanDocument | null) =>
    void act(
      () => plansClient.setSpec(planId, doc?.id ?? null),
      doc ? `use ${doc.heading} as the spec` : "stop using the spec",
      {
        message: doc
          ? `Set ${doc.heading} as the spec`
          : `Stopped using ${spec?.heading ?? "the Document"} as the spec`,
        undo: () => state.apply(() => plansClient.setSpec(planId, specId)),
      },
    );
  const remove = (doc: PlanDocument) =>
    void act(
      () => plansClient.setDocument(planId, doc.id, false),
      `remove ${doc.heading} from ${planName}`,
      {
        message: `Removed ${doc.heading} from ${planName}`,
        undo: () =>
          state.apply(async () => {
            await plansClient.setDocument(planId, doc.id, true);
            if (doc.id === specId) await plansClient.setSpec(planId, doc.id);
          }),
      },
    );
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="plan-overview-section-heading">
        Documents
      </h2>
      <ul className="plan-overview-documents">
        {shown.map((doc) => (
          <li key={doc.id}>
            <RecordLink
              variant="row"
              className="plan-overview-document"
              aria-label={[
                doc.heading,
                doc.id === specId && "Spec",
                doc.trashed && "In Trash",
              ]
                .filter(Boolean)
                .join(", ")}
              onClick={() => openDocument?.(doc.id, `Back to ${planName}`)}
            >
              <FileText size={16} aria-hidden="true" />
              <span>{doc.heading}</span>
              {doc.id === specId && <Badge size="sm">Spec</Badge>}
              {doc.trashed && <Badge size="sm">In Trash</Badge>}
            </RecordLink>
            {!archived && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    label={`Actions for ${doc.heading}`}
                    disabled={state.pending}
                  >
                    <MoreHorizontal />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {doc.id === specId ? (
                    <DropdownMenuItem onSelect={() => setSpec(null)}>
                      Stop using as spec
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      disabled={doc.trashed}
                      onSelect={() => setSpec(doc)}
                    >
                      Set as spec
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => remove(doc)}>
                    Remove from Plan
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
      {documents.length > 6 && (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show fewer" : `Show all ${documents.length}`}
        </Button>
      )}
    </section>
  );
}

export function PlanDocumentPicker({
  view,
  state,
  linking,
  onLinkingChange,
  anchor,
}: {
  view: View;
  state: Actions;
  linking: boolean;
  onLinkingChange: (open: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const { id: planId, name: planName } = view.plan;
  const act = usePlanAction(state);
  return (
    <Popover open={linking} onOpenChange={onLinkingChange}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        align="end"
        variant="list"
        className="plan-document-picker"
        aria-label={`Link a Document to ${planName}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          anchor.current?.focus();
        }}
      >
        <DocumentPicker
          includeSupport
          exclude={view.documents.map((doc) => doc.id)}
          onPick={(doc) => {
            onLinkingChange(false);
            void act(
              () => plansClient.setDocument(planId, doc.id, true),
              `link ${doc.heading} to ${planName}`,
              {
                message: `Linked ${doc.heading} to ${planName}`,
                undo: () =>
                  state.apply(() =>
                    plansClient.setDocument(planId, doc.id, false),
                  ),
              },
            );
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
