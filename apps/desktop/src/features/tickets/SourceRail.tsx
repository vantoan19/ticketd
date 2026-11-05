import { useEffect, useState } from "react";
import { Cloud, LaptopMinimal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { client, type Ticket } from "@/lib/api/client";
import { LocalPublication } from "./PublishToSource";
import { RailSection } from "./RailSection";
import { SourceLink } from "./SourceLink";
import { TakeOwnership } from "./TakeOwnership";
import { useSourceActivity } from "./source-activity";
import { externalSource, freshness } from "./ticket-source";
import { useNow } from "@/lib/use-now";
import { formatDateTime } from "@/lib/format";
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
  const now = useNow();
  const owner = externalSource(ticket);
  const activity = useSourceActivity();
  const sync = useTicketRefresh(ticket.reference, refresh);
  const ownerName = owner ? owner.provider_name : "";
  return (
    <RailSection label="Source">
      {owner ? (
        <div className="rail-source">
          <span className="rail-value rail-source-identity">
            <Cloud aria-hidden="true" />
            <SourceLink url={owner.url} icon={false} title={owner.display}>
              {owner.place && owner.number ? (
                <>
                  <span className="rail-source-place">{owner.place}</span>
                  <span className="rail-source-number">{owner.number}</span>
                </>
              ) : (
                owner.display
              )}
            </SourceLink>
          </span>
          {owner.unavailable ? (
            <>
              <span className="rail-value">
                <StatusDot tone="attention" size={10} />
                Unavailable since {formatDateTime(owner.unavailable.since)}
              </span>
              <small className="rail-note">
                Showing the last synced copy. Nothing in ticketd was deleted or
                completed.
              </small>
            </>
          ) : (
            <>
              <span className="rail-value">
                {sync.running || activity.refreshing ? (
                  `Refreshing ${ownerName}…`
                ) : (
                  <>
                    {owner.last_refreshed_at && (
                      <StatusDot
                        tone={owner.last_error ? "attention" : "positive"}
                        size={10}
                      />
                    )}
                    {freshness(owner, now)}
                  </>
                )}
              </span>
              <small className="rail-note">
                {ownerName} owns the title, description and comments.
              </small>
            </>
          )}
          {!owner.unavailable && owner.last_error && (
            <small className="rail-note">
              The last refresh failed: {owner.last_error.message}
            </small>
          )}
          {owner.origin === "imported" && (
            <small className="rail-note">
              {owner.discovery_matches === false ? (
                "No longer matches discovery. It keeps syncing while you have access."
              ) : (
                <>
                  Found by discovery in{" "}
                  <span className="source-number">{owner.place}</span>.
                </>
              )}
            </small>
          )}
          <div className="rail-source-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={sync.running}
              onClick={() => void sync.run()}
            >
              <RefreshCw data-icon="inline-start" />
              {owner.unavailable ? "Retry" : "Refresh"}
            </Button>
            {owner.unavailable ? (
              <TakeOwnership
                ticket={ticket}
                refresh={refresh}
                variant="ghost"
              />
            ) : (
              <Button variant="link" size="sm" onClick={activity.openSettings}>
                Discovery
              </Button>
            )}
          </div>
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
            <LaptopMinimal aria-hidden="true" />
            Local
          </span>
          <small className="rail-note">
            was <span className="source-number">{ticket.source.display}</span>
          </small>
          <small className="rail-note">
            {ticket.source.ownership_changed_at
              ? `Taken over ${formatDateTime(ticket.source.ownership_changed_at)}. `
              : ""}
            Not syncing.
          </small>
        </div>
      ) : (
        <div className="rail-source">
          <span className="rail-value" title="Created and edited in ticketd">
            <LaptopMinimal aria-hidden="true" />
            Local
          </span>
          <LocalParentNote ticket={ticket} />
          <LocalPublication ticket={ticket} refresh={refresh} />
        </div>
      )}
    </RailSection>
  );
}

function LocalParentNote({ ticket }: { ticket: Ticket }) {
  const reference = ticket.parent?.reference;
  const [parent, setParent] = useState<Ticket | null>(null);
  useEffect(() => {
    if (!reference) return;
    let active = true;
    void client.showTicket(reference).then(
      (found) => {
        if (active) setParent(found);
      },
      () => {
        if (active) setParent(null);
      },
    );
    return () => {
      active = false;
    };
  }, [reference]);
  const owner =
    parent && parent.reference === reference ? externalSource(parent) : null;
  return owner ? (
    <small className="rail-note">
      Its parent <span className="source-number">{reference}</span> belongs to{" "}
      {owner.provider_name}; this ticket stays local unless you publish it on
      its own.
    </small>
  ) : null;
}
