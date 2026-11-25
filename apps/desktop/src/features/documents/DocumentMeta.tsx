import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Reference } from "@/components/ui/reference";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { formatDateTime, listTime } from "@/lib/format";
import type { DocumentSummary } from "./api";

/**
 * The line under a Document's title: what it belongs to (the Plan it is the spec of, its first
 * ticket), when it changed, how long it takes to read and where it is stored; tags follow as
 * chips. One line that wraps. Each part is a span of its own, so a part can be added before the
 * storage state without touching the others.
 */
export function DocumentMeta({
  row,
  updatedAt,
  minutes,
  storage,
  tags,
  tagsLocked,
  onRemoveTag,
  onOpenPlan,
  onOpenTicket,
}: {
  row: Pick<DocumentSummary, "plans" | "tickets"> | null;
  updatedAt: string;
  minutes: number;
  /** The storage state, already a status element. */
  storage: ReactNode;
  tags: readonly string[];
  tagsLocked: boolean;
  onRemoveTag: (tag: string) => void;
  onOpenPlan?: (id: string) => void;
  onOpenTicket?: (reference: string) => void;
}) {
  const spec = row?.plans?.find((plan) => plan.spec);
  const tickets = row?.tickets ?? [];
  const first = tickets[0];
  const updated = listTime(updatedAt);
  const parts: [string, ReactNode][] = [];
  if (spec)
    parts.push([
      "spec",
      <span className="document-meta-part">
        <Button
          variant="link"
          size="inline"
          onClick={() => onOpenPlan?.(spec.id)}
        >
          Spec of <span className="document-meta-name">{spec.name}</span>
        </Button>
      </span>,
    ]);
  if (first)
    parts.push([
      "ticket",
      <span className="document-meta-part">
        <StatusIcon status={first.status} size={14} />
        <Button
          variant="link"
          size="inline"
          aria-label={`Open ${first.reference}`}
          onClick={() => onOpenTicket?.(first.reference)}
        >
          <Reference>{first.reference}</Reference>
        </Button>
        {tickets.length > 1 && <span>+{tickets.length - 1}</span>}
      </span>,
    ]);
  if (updatedAt)
    parts.push([
      "updated",
      <span className="document-meta-part">
        Updated{" "}
        {updated ? (
          <Tooltip content={formatDateTime(updatedAt)}>
            <time dateTime={updatedAt} tabIndex={0}>
              {updated}
            </time>
          </Tooltip>
        ) : (
          updatedAt
        )}
      </span>,
    ]);
  parts.push([
    "read",
    <span className="document-meta-part">{minutes} min read</span>,
  ]);
  if (storage)
    parts.push([
      "storage",
      <span className="document-meta-part">{storage}</span>,
    ]);
  return (
    <div className="document-meta">
      {parts.map(([key, part], index) => (
        <span key={key} className="document-meta-item">
          {index > 0 && (
            <span aria-hidden="true" className="document-meta-sep">
              ·
            </span>
          )}
          {part}
        </span>
      ))}
      {tags.length > 0 && (
        <ul className="document-tags" aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag}>
              {tag}
              <Button
                variant="ghost"
                size="icon-card"
                aria-label={`Remove tag ${tag}`}
                disabled={tagsLocked}
                onClick={() => onRemoveTag(tag)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
