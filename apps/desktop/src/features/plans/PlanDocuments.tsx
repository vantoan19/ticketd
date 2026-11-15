import { useContext, type RefObject } from "react";
import { ChevronDown, FileText, MoreHorizontal } from "lucide-react";
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
import { Item } from "@/components/ui/item";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { DocumentNavigation } from "@/features/documents/navigation";
import { DocumentPicker } from "@/features/tickets/DocumentPicker";
import { plansClient, type View } from "@/lib/api/plans";
import { usePlanAction, type PlanViewState } from "./usePlanView";

type PlanDocument = View["documents"][number];

/**
 * The Plan's Documents in its context line: the spec (or, without one, the
 * first linked Document) as one record chip whose menu opens it, sets or stops
 * it as the spec and removes it; the rest behind "+N". "Link a Document…"
 * shows here only while none is linked; otherwise the Plan's "…" menu opens
 * the same picker (`linking`). Removing and unsetting act at once with Undo.
 */
export function PlanDocuments({
  view,
  state,
  linking,
  onLinkingChange,
  returnFocus,
}: {
  view: View;
  state: Pick<PlanViewState, "apply" | "pending">;
  linking: boolean;
  onLinkingChange: (open: boolean) => void;
  /** Where focus goes when the picker closes without its own trigger. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const openDocument = useContext(DocumentNavigation);
  const act = usePlanAction(state);
  const { id: planId, name: planName, archived: readOnly } = view.plan;
  const specId = view.plan.spec_document_id;
  const spec = view.documents.find((doc) => doc.id === specId);
  const featured = spec ?? view.documents[0];
  const rest = view.documents.filter((doc) => doc.id !== featured?.id);
  const open = (doc: PlanDocument) =>
    openDocument?.(doc.id, `Back to ${planName}`);
  const setSpec = (doc: PlanDocument | null) => {
    const previous = specId;
    const shown = doc ?? spec;
    void act(
      () => plansClient.setSpec(planId, doc?.id ?? null),
      doc ? `use ${doc.heading} as the spec` : "stop using the spec",
      {
        message: doc
          ? `Set ${doc.heading} as the spec`
          : `Stopped using ${shown?.heading ?? "the Document"} as the spec`,
        undo: () => state.apply(() => plansClient.setSpec(planId, previous)),
      },
    );
  };
  const remove = (doc: PlanDocument) => {
    const wasSpec = doc.id === specId;
    void act(
      () => plansClient.setDocument(planId, doc.id, false),
      `remove ${doc.heading} from ${planName}`,
      {
        message: `Removed ${doc.heading} from ${planName}`,
        undo: () =>
          state.apply(async () => {
            await plansClient.setDocument(planId, doc.id, true);
            if (wasSpec) await plansClient.setSpec(planId, doc.id);
          }),
      },
    );
  };
  const link = (doc: { id: string; heading: string }) => {
    onLinkingChange(false);
    void act(
      () => plansClient.setDocument(planId, doc.id, true),
      `link ${doc.heading} to ${planName}`,
      {
        message: `Linked ${doc.heading} to ${planName}`,
        undo: () =>
          state.apply(() => plansClient.setDocument(planId, doc.id, false)),
      },
    );
  };
  const title = (doc: PlanDocument) => (
    <>
      <span className="plan-doc-title">
        {doc.id === specId && "Spec · "}
        {doc.heading}
      </span>
      {doc.trashed && <span className="plan-doc-state">In Trash</span>}
    </>
  );
  // Changes for one Document, without Open (the chip's own menu adds it).
  const changes = (doc: PlanDocument) => (
    <>
      {doc.id === specId ? (
        <DropdownMenuItem onSelect={() => setSpec(null)}>
          Stop using as spec
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem disabled={doc.trashed} onSelect={() => setSpec(doc)}>
          Set as spec
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => remove(doc)}>
        Remove from Plan
      </DropdownMenuItem>
    </>
  );
  if (!featured && readOnly) return null;
  const chipName = featured
    ? `${featured.id === specId ? "Spec" : "Document"}: ${featured.heading}`
    : "";
  return (
    <Popover open={linking} onOpenChange={onLinkingChange}>
      <PopoverAnchor asChild>
        <span className="plan-documents">
          {featured &&
            (readOnly ? (
              // Nothing to change in an archived Plan: the chip just opens it.
              <Tooltip content={featured.heading} overflowOnly>
                <Badge variant="record" asChild>
                  <button
                    type="button"
                    aria-label={chipName}
                    onClick={() => open(featured)}
                  >
                    <FileText aria-hidden="true" />
                    {title(featured)}
                  </button>
                </Badge>
              </Tooltip>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Badge variant="record" asChild>
                    <button
                      type="button"
                      aria-label={chipName}
                      disabled={state.pending}
                    >
                      <FileText aria-hidden="true" />
                      {title(featured)}
                      <ChevronDown aria-hidden="true" />
                    </button>
                  </Badge>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => open(featured)}>
                    <FileText /> Open
                  </DropdownMenuItem>
                  {changes(featured)}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          {rest.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="plan-documents-more"
                  aria-label={`${rest.length} more linked ${rest.length === 1 ? "Document" : "Documents"}`}
                >
                  +{rest.length}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                variant="list"
                className="plan-documents-popover"
                aria-label="More linked Documents"
              >
                <ul>
                  {rest.map((doc) => (
                    <Item key={doc.id} asChild>
                      <li>
                        <FileText aria-hidden="true" size={16} />
                        <Tooltip content={doc.heading} overflowOnly>
                          <button type="button" onClick={() => open(doc)}>
                            {doc.heading}
                          </button>
                        </Tooltip>
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
                            <DropdownMenuContent align="end">
                              {changes(doc)}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </li>
                    </Item>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
          {!featured && (
            <PopoverTrigger asChild>
              <Button variant="ghost" size="xs" className="plan-context-action">
                Link a Document…
              </Button>
            </PopoverTrigger>
          )}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        variant="list"
        className="plan-document-picker"
        aria-label={`Link a Document to ${planName}`}
        onCloseAutoFocus={(event) => {
          // Opened from the Plan's menu, there is no trigger to return to.
          if (!featured || !returnFocus?.current) return;
          event.preventDefault();
          returnFocus.current.focus();
        }}
      >
        <DocumentPicker
          includeSupport
          exclude={view.documents.map((doc) => doc.id)}
          onPick={link}
        />
      </PopoverContent>
    </Popover>
  );
}
