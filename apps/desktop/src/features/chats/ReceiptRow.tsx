import { Fragment, useContext } from "react";
import { ChevronRight, FileText, MessageSquareText } from "lucide-react";
import { RecordLink } from "@/components/ui/record-link";
import { DocumentNavigation } from "@/features/documents/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { TicketNavigation } from "@/features/tickets/navigation";
import type { RecordChange } from "@/features/chats/client";
import { goneWords } from "@/features/chats/model";

/** Whole sentences shown on the row before the rest folds under `N more`. */
const SHOWN = 2;

/** A status change shows its new status's icon, as ticket history does. */
function ChangeIcon({ change }: { change: RecordChange }) {
  if (change.kind === "status")
    return <StatusIcon status={change.to} size={16} decorative />;
  if (change.kind === "update")
    return <MessageSquareText size={16} aria-hidden />;
  return <FileText size={16} aria-hidden />;
}

/** One verb-first sentence; the record in it opens. */
function Sentence({ change }: { change: RecordChange }) {
  const openTicket = useContext(TicketNavigation);
  const openDocument = useContext(DocumentNavigation);
  if (change.kind === "document" && change.gone)
    return (
      <>
        Created {change.title}
        {goneWords(change.gone)}
      </>
    );
  if (change.kind === "document")
    return (
      <>
        Created{" "}
        <RecordLink onClick={() => openDocument?.(change.document_id)}>
          {change.title}
        </RecordLink>
      </>
    );
  const reference = change.gone ? (
    // No longer there to open: the plain reference, then what became of it.
    <>
      <RecordLink gone reference={change.reference} />
      {goneWords(change.gone)}
    </>
  ) : (
    <RecordLink
      reference={change.reference}
      onClick={() => openTicket?.(change.reference)}
    />
  );
  return change.kind === "status" ? (
    <>
      Moved {reference} to {change.to}
    </>
  ) : (
    <>Posted an update on {reference}</>
  );
}

/**
 * What the agent changed in ticketd during a turn, as one 28px row under the
 * response (after the files row): the first sentence's icon, then verb-first
 * sentences joined by ` · `, at most two, then `N more`, which opens the
 * turn's fold, where every change is a step row. The changes are the host's net
 * list (a ticket's status moves netted into one), so "Moved T-12 to In review"
 * leads, not the step it passed through. Never folded itself, and
 * shown also when the turn failed or was stopped.
 */
export function ReceiptRow({
  changes,
  onMore,
}: {
  /** What the host netted for the turn; not netted again here. */
  changes: RecordChange[];
  /** Opens the turn's fold. */
  onMore: () => void;
}) {
  const first = changes[0];
  if (!first) return null;
  const rest = changes.length - SHOWN;
  return (
    <div className="chat-records">
      <ChangeIcon change={first} />
      <span className="chat-records-items">
        {changes.slice(0, SHOWN).map((change, index) => (
          <Fragment key={index}>
            {index > 0 && " · "}
            <Sentence change={change} />
          </Fragment>
        ))}
      </span>
      {rest > 0 && (
        // Inline text, not a Button: it reads as a link inside the sentence.
        <button
          type="button"
          className="chat-records-ref chat-records-more"
          onClick={onMore}
        >
          {rest} more
          <ChevronRight size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
