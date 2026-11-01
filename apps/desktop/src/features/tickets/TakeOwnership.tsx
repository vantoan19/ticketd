import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { client, type Ticket } from "@/lib/api/client";
import { externalSource, providerName } from "./ticket-source";

/**
 * Take ownership of a ticket whose source is unavailable. It is always a
 * deliberate, confirmed decision: the confirmation says what stays, what changes
 * and that synchronization stops, and a failed or repeated attempt reuses one
 * request id so it can never apply twice.
 */
export function TakeOwnership({
  ticket,
  refresh,
  variant = "outline",
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  variant?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const requestId = useRef<string | null>(null);
  const source = externalSource(ticket);
  if (!source?.unavailable) return null;
  const name = providerName(source.provider);
  async function confirm() {
    requestId.current ??= crypto.randomUUID();
    setPending(true);
    setFailure("");
    try {
      await client.takeOwnership(ticket.reference, requestId.current);
      requestId.current = null;
      setOpen(false);
      await refresh();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        variant={variant}
        size="sm"
        onClick={() => {
          setFailure("");
          setOpen(true);
        }}
      >
        Take ownership…
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Take ownership of {ticket.reference}?</DialogTitle>
            <DialogDescription>
              {ticket.reference} becomes a Local ticket. Nothing is deleted and
              nothing is sent to {name}.
            </DialogDescription>
          </DialogHeader>
          <ul className="take-ownership-effects">
            <li>
              Kept: the title, description and status as last synced from {name}
              .
            </li>
            <li>
              Changes: you can edit the title, description and status here.
            </li>
            <li>
              Stops: {name} changes no longer reach this ticket, even if{" "}
              {source.display} becomes reachable again.
            </li>
            <li>
              Remembered: {source.display} stays as “was {source.display}”, not
              as the owner. Reconnecting later needs an explicit choice.
            </li>
            <li>
              Unchanged: subtickets, dependencies, relationships and notes.
            </li>
          </ul>
          {failure && <p role="alert">Could not take ownership: {failure}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void confirm()}>
              {pending ? "Taking ownership…" : "Take ownership"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
