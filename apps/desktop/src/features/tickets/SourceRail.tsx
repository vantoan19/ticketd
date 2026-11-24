import { useEffect, useState } from "react";
import { Cloud, LaptopMinimal, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureDetails } from "@/components/ui/failure-alert";
import { describeFailure } from "@/lib/api/describe-failure";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { SourceIcon } from "@/features/settings/sources/SourceIcon";
import { client, type Ticket } from "@/lib/api/client";
import { LocalPublication } from "./PublishToSource";
import { RailRow, RailSection } from "./RailSection";
import { SourceLink } from "./SourceLink";
import { useSourceActivity } from "./source-activity";
import {
  connectionUnavailableText,
  externalSource,
  freshness,
  sourceReference,
} from "./ticket-source";
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
  chip = false,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  /** A chip that opens the section in a popover, for a narrow pane. */
  chip?: boolean;
}) {
  const now = useNow();
  const owner = externalSource(ticket);
  const issueReference = owner ? sourceReference(owner) : null;
  const activity = useSourceActivity();
  const sync = useTicketRefresh(ticket.reference, refresh);
  const ownerName = owner ? owner.provider_name : "";
  const connectionUnavailable = owner ? connectionUnavailableText(owner) : null;
  const providerIcon = owner?.provider_icon_svg ? (
    <SourceIcon svg={owner.provider_icon_svg} size={16} />
  ) : (
    <Cloud aria-hidden="true" />
  );
  const body = (
    <>
      {owner ? (
        <div className="rail-source">
          <span className="rail-value rail-source-identity">
            {providerIcon}
            <SourceLink url={owner.url} icon={false} title={owner.display}>
              {issueReference?.place ? (
                <>
                  <span className="rail-source-place">{owner.place}</span>
                  <span className="rail-source-number">
                    {issueReference.label}
                  </span>
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
                {connectionUnavailable ??
                  `Unavailable since ${formatDateTime(owner.unavailable.since)}`}
              </span>
              <small className="rail-note">
                {connectionUnavailable
                  ? "Showing the last synced copy."
                  : "Showing the last synced copy. Nothing in ticketd was deleted or completed."}
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
              The last refresh failed.{" "}
              {
                describeFailure(owner.last_error, "refresh this ticket")
                  .sentence
              }
              <FailureDetails
                variant="popover"
                small
                details={owner.last_error.message}
              />
            </small>
          )}
          {owner.origin === "imported" && !connectionUnavailable && (
            <small className="rail-note">
              {owner.discovery_matches === false ? (
                "No longer matches discovery. It keeps syncing while you have access."
              ) : owner.place ? (
                <>
                  Found by discovery in{" "}
                  <span className="source-number">{owner.place}</span>.
                </>
              ) : (
                "Found by discovery."
              )}
            </small>
          )}
          {/* Unavailable, the notice at the top of the document owns Retry and
              Take ownership; the rail only says where things stand. */}
          {!owner.unavailable && !chip && (
            <>
              <RailRow
                icon={<RefreshCw aria-hidden="true" />}
                muted
                disabled={sync.running}
                onClick={() => void sync.run()}
              >
                Refresh
              </RailRow>
              <RailRow
                icon={<Settings2 aria-hidden="true" />}
                muted
                onClick={() => activity.openSettings(owner.provider)}
              >
                Discovery settings
              </RailRow>
            </>
          )}
          {!owner.unavailable && chip && (
            <div className="rail-source-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={sync.running}
                onClick={() => void sync.run()}
              >
                <RefreshCw data-icon="inline-start" />
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => activity.openSettings(owner.provider)}
              >
                Discovery settings
              </Button>
            </div>
          )}
          {sync.failure && !sync.running && (
            <FailureAlert
              size="compact"
              failure={sync.failure}
              onRetry={() => void sync.run(true)}
            />
          )}
        </div>
      ) : ticket.source ? (
        <div className="rail-source">
          <span className="rail-value">
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
          <span className="rail-value">
            <LaptopMinimal aria-hidden="true" />
            Local
          </span>
          <LocalParentNote ticket={ticket} />
          <LocalPublication ticket={ticket} refresh={refresh} />
        </div>
      )}
    </>
  );
  if (!chip) return <RailSection label="Source">{body}</RailSection>;
  const name = owner ? owner.display : "Local";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <RailRow
          aria-label={`Source: ${name}`}
          icon={owner ? providerIcon : <LaptopMinimal aria-hidden="true" />}
        >
          {name}
        </RailRow>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72" aria-label="Source">
        <PopoverHeader>
          <PopoverTitle>Source</PopoverTitle>
        </PopoverHeader>
        {body}
      </PopoverContent>
    </Popover>
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
