import { HardDrive, Link2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Ticket } from "@/lib/api/client";
import { LocalPublication } from "./PublishToSource";
import { RailSection } from "./RailSection";
import { SourceLink } from "./SourceLink";
import { TakeOwnership } from "./TakeOwnership";
import { useSourceActivity } from "./source-activity";
import {
  externalSource,
  freshness,
  sourceLocation,
  sourceState,
} from "./ticket-source";
import { useTicketRefresh } from "./useTicketRefresh";

/**
 * The rail's Source section: who owns the ticket, how fresh it is, and the actions
 * that follow from that (refresh, take ownership, or publish a local ticket).
 */
export function SourceRail({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const owner = externalSource(ticket);
  const activity = useSourceActivity();
  const sync = useTicketRefresh(ticket.reference, refresh);
  const ownerName = owner ? owner.provider_name : "";
  return (
    <RailSection label="Source">
      {owner ? (
        <div className="rail-source">
          <span className="rail-value">
            <Link2 aria-hidden="true" />
            <SourceLink url={owner.url}>{sourceLocation(owner)}</SourceLink>
          </span>
          <span className="rail-value">
            {(() => {
              const state = sourceState(owner);
              return (
                <>
                  {state.tone && <StatusDot tone={state.tone} size={8} />}
                  {state.text}
                </>
              );
            })()}
          </span>
          <small className="rail-note">
            {sync.running || activity.refreshing ? (
              <span>Refreshing {ownerName}…</span>
            ) : (
              <>
                {!owner.last_error && owner.last_refreshed_at && (
                  <StatusDot tone="positive" size={6} />
                )}{" "}
                {freshness(owner)}
              </>
            )}
          </small>
          {owner.last_error && (
            <small className="rail-note rail-warning">
              <StatusDot tone="attention" size={6} /> The last refresh failed:{" "}
              {owner.last_error.message} Showing content synced earlier.
            </small>
          )}
          <small className="rail-note">
            {ownerName} owns the title and description. Edit them there.
          </small>
          <Button
            variant="ghost"
            size="sm"
            disabled={sync.running}
            onClick={() => void sync.run()}
          >
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
          <TakeOwnership ticket={ticket} refresh={refresh} variant="ghost" />
          {sync.failure && !sync.running && (
            <small role="alert">
              Could not refresh: {sync.failure} Saved content is unchanged.
            </small>
          )}
        </div>
      ) : ticket.source ? (
        <div className="rail-source">
          <span
            className="rail-value"
            title="Owned in ticketd; the external issue is kept as provenance"
          >
            <HardDrive aria-hidden="true" />
            Local
          </span>
          <small className="rail-note">was {ticket.source.display}</small>
        </div>
      ) : (
        <div className="rail-source">
          <span className="rail-value" title="Created and edited in ticketd">
            <HardDrive aria-hidden="true" />
            Local
          </span>
          <LocalPublication ticket={ticket} refresh={refresh} />
        </div>
      )}
    </RailSection>
  );
}
