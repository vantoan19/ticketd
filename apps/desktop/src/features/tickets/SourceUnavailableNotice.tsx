import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Ticket } from "@/lib/api/client";
import { TakeOwnership } from "./TakeOwnership";
import { useTicketRefresh } from "./useTicketRefresh";
import { SourceLink } from "./SourceLink";
import { formatDateTime } from "@/lib/format";
import { externalSource, unavailableNotice } from "./ticket-source";

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
        <StatusDot tone="attention" size={10} /> {notice.title}
      </p>
      <p>
        {notice.detail.split(source.display).map((part, index) => (
          <span key={index}>
            {index > 0 && <code>{source.display}</code>}
            {part}
          </span>
        ))}{" "}
        Since {formatDateTime(source.unavailable!.since)}. You’re reading the
        last synced copy
        {source.last_refreshed_at
          ? ` from ${formatDateTime(source.last_refreshed_at)}`
          : ""}
        .
      </p>
      <div className="source-unavailable-actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={retrying}
          onClick={() => void retry()}
        >
          Retry now
        </Button>
        <TakeOwnership ticket={ticket} refresh={refresh} variant="ghost" />
        <SourceLink url={source.url}>Open on {name}</SourceLink>
        {retrying && <span role="status">Refreshing {name}…</span>}
        {failure && !retrying && (
          <span role="alert">Still unavailable: {failure}</span>
        )}
      </div>
    </section>
  );
}
