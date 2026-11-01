import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Ticket } from "@/lib/api/client";
import { sourcesClient } from "@/lib/api/sources";
import {
  externalSource,
  freshness,
  providerName,
  unavailableNotice,
} from "./ticket-source";

/**
 * A recessed notice at the top of the document column while the ticket's source
 * cannot be read. It says what failed and since when, that nothing was deleted or
 * completed, and offers Retry. Taking ownership is a separate decision this notice
 * does not offer.
 */
export function SourceUnavailableNotice({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState("");
  const source = externalSource(ticket);
  const notice = source ? unavailableNotice(source) : null;
  if (!source || !notice) return null;
  const name = providerName(source.provider);
  async function retry() {
    setRetrying(true);
    setFailure("");
    try {
      const report = await sourcesClient.refresh(ticket.reference);
      const first = report.failures[0];
      if (first) setFailure(first.message);
      await refresh();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRetrying(false);
    }
  }
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
        {retrying && <span role="status">Refreshing {name}…</span>}
        {failure && !retrying && (
          <span role="alert">Still unavailable: {failure}</span>
        )}
      </div>
    </section>
  );
}
