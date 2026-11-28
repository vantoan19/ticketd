import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TicketDescription } from "./TicketDescription";
import { withoutBom } from "./mention-passage";
import { useOpenTicket } from "./open-ticket";

export function TicketPeek({
  children,
  onOpen,
  select,
  revision,
}: {
  children: ReactNode;
  onOpen: () => void;
  select: (reference: string) => void;
  revision: number;
}) {
  const { record: ticket } = useOpenTicket();
  return (
    <div className="detail-document">
      <h1 className="detail-title">{ticket.title}</h1>
      {children}
      <div className="editor-body" role="group" aria-label="Description">
        <div className="markdown-preview description-document">
          {ticket.body.trim() ? (
            <TicketDescription
              ticketId={ticket.id}
              source={withoutBom(ticket.body)}
              select={select}
              revision={revision}
              peek
            />
          ) : (
            <p className="ticket-no-description">No description</p>
          )}
        </div>
      </div>
      <TicketPeekFooter onOpen={onOpen} />
    </div>
  );
}

function TicketPeekFooter({ onOpen }: { onOpen: () => void }) {
  const counts = useOpenTicket("peekCounts");
  const evidence = useOpenTicket("evidence");
  const updates = useOpenTicket("activityUpdateCount", true);
  const { value: linkedFiles } = counts;
  const evidenceCount = evidence.value?.total;
  const updateCount = updates.value;
  const loaded =
    linkedFiles !== undefined &&
    evidenceCount !== undefined &&
    updateCount !== undefined;
  const reads = [counts, evidence, updates];
  const failed = reads.some((read) => read.failure);
  return (
    <div className="ticket-peek-footer">
      {loaded ? (
        <p className="text-xs text-muted-foreground">
          {[
            `Linked ${linkedFiles.linked}`,
            `Evidence ${evidenceCount}`,
            `Files ${linkedFiles.files}`,
            `Updates ${updateCount}`,
          ].join(" · ")}
        </p>
      ) : failed ? (
        <Button
          type="button"
          size="compact"
          variant="ghost"
          onClick={() => {
            for (const read of reads) if (read.failure) read.retry();
          }}
        >
          Retry counts
        </Button>
      ) : (
        <Skeleton className="h-4 w-48" />
      )}
      <Button type="button" size="compact" variant="outline" onClick={onOpen}>
        Open ticket
      </Button>
    </div>
  );
}
