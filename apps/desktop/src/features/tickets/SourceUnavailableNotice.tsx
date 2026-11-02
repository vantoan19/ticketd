import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Ticket } from "@/lib/api/client";
import { TakeOwnership } from "./TakeOwnership";
import { useTicketRefresh } from "./useTicketRefresh";
import { externalSource, freshness, unavailableNotice } from "./ticket-source";

/**
 * A recessed notice at the top of the document column while the ticket's source
 * cannot be read. It says what failed and since when, that nothing was deleted or
 * completed, and offers Retry and Take ownership (a confirmed, separate decision).
 */
export function SourceUnavailableNotice({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const {
    running: retrying,
    failure,
    run: retry,
  } = useTicketRefresh(ticket.reference, refresh);
  const source = externalSource(ticket);
  const notice = source ? unavailableNotice(source) : null;
  if (!source || !notice) return null;
  const name = source.provider_name;
  return (
    <section
      className="source-unavailable-notice"
      aria-label="Source unavailable"
    >
      <p className="source-unavailable-title">
        <StatusDot tone="attention" size={8} /> {notice.title} · {notice.since}
      </p>
      <p>{notice.detail}</p>
      <p>
        Showing {name} content as last synced. {freshness(source)}.
      </p>
      <div className="source-unavailable-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => void retry()}
        >
          Retry
        </Button>
        <TakeOwnership ticket={ticket} refresh={refresh} />
        {retrying && <span role="status">Refreshing {name}…</span>}
        {failure && !retrying && (
          <span role="alert">Still unavailable: {failure}</span>
        )}
      </div>
    </section>
  );
}
