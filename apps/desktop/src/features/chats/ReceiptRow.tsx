import { Fragment, useContext, useId, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  MessageSquareText,
} from "lucide-react";
import { DocumentNavigation } from "@/features/documents/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { TicketNavigation } from "@/features/tickets/navigation";
import type { RecordChange } from "@/features/chats/client";

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
  if (change.kind === "document")
    return (
      <>
        Created{" "}
        <button
          type="button"
          className="chat-receipt-ref chat-receipt-name"
          onClick={() => openDocument?.(change.document_id)}
        >
          {change.title}
        </button>
      </>
    );
  const reference = (
    <button
      type="button"
      className="chat-receipt-ref"
      onClick={() => openTicket?.(change.reference)}
    >
      {change.reference}
    </button>
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
 * response (after the files row): the first change's icon, then verb-first
 * sentences joined by ` · `, at most two, then `N more`, which opens the rest
 * as rows. Shown also when the turn failed or was stopped.
 */
export function ReceiptRow({ changes }: { changes: RecordChange[] }) {
  const [open, setOpen] = useState(false);
  const foldId = useId();
  const first = changes[0];
  if (!first) return null;
  const rest = changes.length - SHOWN;
  return (
    <div className="chat-receipt-block">
      <div className="chat-receipt">
        <ChangeIcon change={first} />
        <span className="chat-receipt-items">
          {changes.slice(0, SHOWN).map((change, index) => (
            <Fragment key={index}>
              {index > 0 && " · "}
              <Sentence change={change} />
            </Fragment>
          ))}
        </span>
        {rest > 0 && (
          <button
            type="button"
            className="chat-receipt-ref chat-receipt-more"
            aria-expanded={open}
            aria-controls={foldId}
            onClick={() => setOpen(!open)}
          >
            {rest} more
            {open ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )}
          </button>
        )}
      </div>
      {open && (
        <ul id={foldId} className="chat-receipt-fold">
          {changes.slice(SHOWN).map((change, index) => {
            return (
              <li key={index}>
                <ChangeIcon change={change} />
                <span>
                  <Sentence change={change} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
