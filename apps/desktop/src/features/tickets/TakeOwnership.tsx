import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FailureAlert } from "@/components/ui/failure-alert";
import { client, type Ticket } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { externalSource } from "./ticket-source";

/**
 * Take ownership of a ticket whose source is unavailable. It is always a
 * deliberate, confirmed decision: the confirmation says what stays, what changes
 * and that synchronization stops, and a failed or repeated attempt reuses one
 * request id so it can never apply twice.
 */
export function TakeOwnership({
  ticket,
  refresh,
  variant = "ghost",
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  variant?: "outline" | "ghost";
}) {
  const heading = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const requestId = useRef<string | null>(null);
  const source = externalSource(ticket);
  if (!source?.unavailable) return null;
  const name = source.provider_name;
  async function confirm() {
    requestId.current ??= crypto.randomUUID();
    setPending(true);
    setFailure(null);
    try {
      await client.takeOwnership(ticket.reference, requestId.current);
      requestId.current = null;
      setOpen(false);
      await refresh();
    } catch (reason) {
      setFailure(
        describeFailure(reason, `take ownership of ${ticket.reference}`),
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Popover open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <PopoverTrigger asChild>
        <Button variant={variant} size="sm" onClick={() => setFailure(null)}>
          Take ownership…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="take-ownership-popover"
        align="start"
        side="bottom"
        sideOffset={8}
        aria-labelledby={heading}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus({ preventScroll: true });
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h3 id={heading} className="take-ownership-title">
          Take ownership of{" "}
          <span className="source-number">{ticket.reference}</span>?
        </h3>
        <p className="source-caption">
          This becomes a Local ticket. Nothing is deleted and nothing is sent to{" "}
          {name}.
        </p>
        <ul className="take-ownership-effects">
          <li>
            Kept: the last synced title, description and status; subtickets,
            dependencies, relationships and activities.
          </li>
          <li>
            Changes: the owner becomes Local. You can edit the title,
            description and status here.
          </li>
          <li>
            Stops: {name} changes no longer reach this ticket. It never
            reconnects by itself.
          </li>
        </ul>
        <p className="source-caption">
          <span className="source-number">{source.display}</span> stays as
          provenance. GitHub comments stay as a read-only archive.
        </p>
        {failure && <FailureAlert size="compact" failure={failure} />}
        <div className="take-ownership-actions">
          <Button
            ref={cancel}
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={pending} onClick={() => void confirm()}>
            {pending ? "Taking ownership…" : "Take ownership"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
