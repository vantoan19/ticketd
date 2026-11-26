import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { Document, DocumentSummary } from "./api";

/** The date and the time, in full: Details is where the list's "Wed" is spelled out. */
function DocumentDate({ value }: { value: string }) {
  return <time dateTime={value}>{formatDateTime(value)}</time>;
}

/**
 * The facts the meta line leaves out: when the Document was created and last changed, whether it
 * is listed in Documents, the Plans it supports and the update it came from. Opened from the
 * Document's "…" menu.
 */
export function DocumentDetails({
  document,
  createdAt,
  updatedAt,
  plans,
  onOpenTicket,
}: {
  document: Pick<Document, "origin_brief" | "origin_ticket" | "kept">;
  createdAt: string;
  updatedAt: string;
  plans: NonNullable<DocumentSummary["plans"]>;
  onOpenTicket?: (reference: string) => void;
}) {
  const supporting = plans.filter((plan) => !plan.spec);
  return (
    <dl className="document-details">
      <dt>Created</dt>
      <dd>
        <DocumentDate value={createdAt} />
      </dd>
      <dt>Updated</dt>
      <dd>
        <DocumentDate value={updatedAt} />
      </dd>
      <dt>Visibility</dt>
      <dd>
        {document.origin_brief
          ? document.kept
            ? "Kept in Documents"
            : "Hidden with its update"
          : "Shown in Documents"}
      </dd>
      {supporting.length > 0 && (
        <>
          <dt>Supporting Document of</dt>
          <dd>{supporting.map((plan) => plan.name).join(", ")}</dd>
        </>
      )}
      {document.origin_ticket && (
        <>
          <dt>Origin</dt>
          <dd>
            <Button
              variant="link"
              size="inline"
              onClick={() => onOpenTicket?.(document.origin_ticket ?? "")}
            >
              {document.origin_ticket} · Update details
            </Button>
          </dd>
        </>
      )}
    </dl>
  );
}
