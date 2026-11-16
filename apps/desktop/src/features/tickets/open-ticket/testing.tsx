import type { ReactNode } from "react";
import type { Ticket } from "@/lib/api/client";
import type { ChangeSignal } from "@/lib/workspace-reads";
import { TestReads } from "@/lib/workspace-reads/testing";
import { OpenTicket } from "./OpenTicket";

/**
 * An Open Ticket for a test: fresh reads, driven by a fake change signal
 * (keep `signal` to move it), with the record already known so nothing reads
 * the Ticket from the bridge.
 */
export function TestOpenTicket({
  ticket,
  signal,
  hidden = false,
  children,
}: {
  ticket: Ticket;
  signal?: ChangeSignal;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <TestReads {...(signal && { signal })} primed={{ ticket }}>
      <OpenTicket reference={ticket.reference} hidden={hidden}>
        {children}
      </OpenTicket>
    </TestReads>
  );
}
