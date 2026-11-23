import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Ticket } from "@/lib/api/client";
import { TakeOwnership } from "./TakeOwnership";
import { useTicketRefresh } from "./useTicketRefresh";
import { SourceLink } from "./SourceLink";
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
    <Alert
      tone="attention"
      role="region"
      aria-label="Source unavailable"
      className="mb-6"
    >
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        {notice.detail.split(source.display).map((part, index) => (
          <span key={index}>
            {index > 0 && <code>{source.display}</code>}
            {part}
          </span>
        ))}
      </AlertDescription>
      <AlertActions>
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => void retry(true)}
        >
          Retry now
        </Button>
        <TakeOwnership ticket={ticket} refresh={refresh} variant="outline" />
        <SourceLink url={source.url}>Open on {name}</SourceLink>
        {retrying && <span role="status">Refreshing {name}…</span>}
        {failure && !retrying && (
          <span role="alert">Still unavailable. {failure.sentence}</span>
        )}
      </AlertActions>
    </Alert>
  );
}
