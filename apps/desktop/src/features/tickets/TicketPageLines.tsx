import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Check } from "lucide-react";
import { RecordLink } from "@/components/ui/record-link";
import { Tooltip } from "@/components/ui/tooltip";
import type { Ticket } from "@/lib/api/client";
import { historyClient } from "@/lib/api/history";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { read, skip, useRead } from "@/lib/workspace-reads";
import { SourceLink } from "./SourceLink";
import { useOpenTicket } from "./open-ticket";
import { externalSource } from "./ticket-source";

export function TicketParentLine({
  parent,
  select,
  onRemove,
}: {
  parent: NonNullable<Ticket["parent"]>;
  select: (reference: string) => void;
  onRemove?: () => void;
}) {
  const link = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="ticket-parent-line">
          <RecordLink
            ref={link}
            role="link"
            variant="context"
            aria-label={`${parent.reference} ${parent.title}${parent.trashed ? ", in Trash" : ""}`}
            onClick={() => select(parent.reference)}
            onContextMenu={(event) => {
              if (!onRemove) return;
              event.preventDefault();
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (
                !onRemove ||
                (event.key !== "ContextMenu" &&
                  !(event.shiftKey && event.key === "F10"))
              )
                return;
              event.preventDefault();
              setOpen(true);
            }}
          >
            <span aria-hidden="true">↰ </span>
            {parent.reference} {parent.title}
          </RecordLink>
        </div>
      </PopoverAnchor>
      {onRemove && (
        <PopoverContent
          aria-label="Parent actions"
          align="start"
          className="w-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            link.current?.focus({ preventScroll: true });
          }}
        >
          <Button
            variant="ghost"
            size="compact"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            Remove parent
          </Button>
        </PopoverContent>
      )}
    </Popover>
  );
}

const doneTime = read({
  key: "ticket-done-time",
  async call(reference: string) {
    const history = await historyClient.list(reference);
    return (
      history
        .reverse()
        .find((entry) => entry.kind === "status" && entry.to_value === "Done")
        ?.timestamp ?? null
    );
  },
  failure: "load the completion time",
});

export function TicketClosingLine() {
  const { record: ticket } = useOpenTicket();
  const now = useNow();
  const closed = externalSource(ticket)?.closed_at;
  const timestamp = useRead(doneTime, closed ? skip : ticket.reference);
  const evidence = useOpenTicket("evidence");
  const time = closed ?? timestamp.value;
  const pr = evidence.value?.proof.find((item) => item.kind === "pull_request");
  const number =
    pr?.value.match(
      /\/(?:pull|pull-requests|merge_requests)\/(\d+)(?:[/?#]|$)/,
    )?.[1] ??
    pr?.name.match(/#(\d+)\b/)?.[1] ??
    pr?.value.match(/^#?(\d+)$/)?.[1];
  return (
    <p className="ticket-closing-line text-muted-foreground">
      <Check className="size-4" aria-hidden="true" />
      <span>
        Done
        {time && (
          <>
            {" "}
            <Tooltip content={formatDateTime(time)}>
              <time dateTime={time}>{relativeDateTime(time, now)}</time>
            </Tooltip>
          </>
        )}
      </span>
      {pr && (
        <>
          <span aria-hidden="true">·</span>
          <SourceLink url={pr.value}>
            {number ? `PR ${number}` : pr.name}
          </SourceLink>
        </>
      )}
    </p>
  );
}
