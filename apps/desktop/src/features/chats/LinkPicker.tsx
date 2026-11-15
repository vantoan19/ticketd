import { useContext, useRef, useState } from "react";
import { FileText, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Reference } from "@/components/ui/reference";
import { DocumentNavigation } from "@/features/documents/navigation";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import { TicketNavigation } from "@/features/tickets/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { useChatClient, type LinkedRecord } from "@/features/chats/client";
import { RecordPicker, type PickRecord } from "@/features/tickets/RecordPicker";

/** The icon, reference and title of a linked ticket, Document or Project. */
export function RecordLabel({ record }: { record: LinkedRecord }) {
  if (record.kind === "project")
    return (
      <>
        <ProjectIcon project={record} />
        <span className="chat-chip-title">{record.title}</span>
      </>
    );
  return record.kind === "ticket" ? (
    <>
      <StatusIcon status={record.status} size={14} decorative />
      <Reference>{record.reference}</Reference>
      <span className="chat-chip-title">{record.title}</span>
    </>
  ) : (
    <>
      <FileText size={14} aria-hidden />
      <span className="chat-chip-title">{record.title}</span>
    </>
  );
}

/** A linked record: opens it, with a small button to remove the link. */
export function RecordChip({
  record,
  backLabel,
  onRemove,
}: {
  record: LinkedRecord;
  /** Names where a Document reader returns to. */
  backLabel?: string;
  onRemove: () => void;
}) {
  const openTicket = useContext(TicketNavigation);
  const openDocument = useContext(DocumentNavigation);
  const name =
    record.kind === "ticket"
      ? `${record.reference} ${record.title}`
      : record.kind === "project"
        ? `the Project ${record.title}`
        : `the Document ${record.title}`;
  return (
    <span className="chat-chip">
      {record.kind === "project" ? (
        // A Project is context for the agent; it has no page to open from here.
        <span className="chat-chip-label">
          <RecordLabel record={record} />
        </span>
      ) : (
        // The chip's own label, not a Button: the chip is the control's frame.
        <button
          type="button"
          aria-label={`Open ${name}`}
          onKeyDown={(event) => {
            if (event.key === "Delete") {
              event.preventDefault();
              onRemove();
            }
          }}
          onClick={() =>
            record.kind === "ticket"
              ? openTicket?.(record.reference)
              : openDocument?.(record.id, backLabel)
          }
        >
          <RecordLabel record={record} />
        </button>
      )}
      {/* The chip's 14px remove mark; an IconButton (32px) does not fit inside it. */}
      <button
        type="button"
        aria-label={`Remove the link to ${name}`}
        onClick={onRemove}
      >
        <X size={14} aria-hidden />
      </button>
    </span>
  );
}

const key = (record: { kind: string; id: string }) =>
  `${record.kind}:${record.id}`;

/**
 * Finds a ticket, Document or Project by name or reference to link; never
 * asks for an ID. The RecordPicker in a list popover: recent records under
 * "Recent" before anything is typed, an exact reference first.
 */
export function LinkPicker({
  linked,
  onPick,
  withLabel = false,
  open: openFromOutside,
  onOpenChange,
  anchorClassName,
}: {
  /**
   * Opened from elsewhere, where the picker is anchored: the Chat header
   * passes a box over the whole header, so the picker opens under it at its
   * end and never covers Expand or Close (CH-09).
   */
  anchorClassName?: string;
  linked: LinkedRecord[];
  onPick: (record: LinkedRecord) => void;
  /** New Chat shows the word beside the plus. */
  withLabel?: boolean;
  /**
   * Opened from elsewhere (the Chat actions menu): the picker then has no
   * button of its own and opens where it is placed.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const client = useChatClient();
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = openFromOutside !== undefined;
  const open = openFromOutside ?? ownOpen;
  const setOpen = (next: boolean) =>
    controlled ? onOpenChange?.(next) : setOwnOpen(next);
  const found = useRef(new Map<string, LinkedRecord>());
  // Results that exist but are all linked already: not the same as no match.
  const [allLinked, setAllLinked] = useState(false);
  const exclude = linked.map(key);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {controlled ? (
        <PopoverAnchor asChild>
          <span className={anchorClassName} />
        </PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>
          {withLabel ? (
            <Button
              variant="ghost"
              size="xs"
              aria-label="Link a ticket, Document or Project"
            >
              <Plus aria-hidden /> Link
            </Button>
          ) : (
            <IconButton label="Link a ticket, Document or Project">
              <Plus aria-hidden />
            </IconButton>
          )}
        </PopoverTrigger>
      )}
      <PopoverContent
        align={controlled ? "end" : "start"}
        variant="list"
        aria-label="Link a ticket, Document or Project"
      >
        <RecordPicker
          things="tickets, Documents and Projects"
          exclude={exclude}
          search={async (query) => {
            // The client puts a typed ticket reference first (chat CH-47).
            const records = await client.searchRecords(query);
            for (const record of records)
              found.current.set(key(record), record);
            setAllLinked(
              records.length > 0 &&
                records.every((record) => exclude.includes(key(record))),
            );
            return [
              {
                ...(!query && { heading: "Recent" }),
                records: records.map((record): PickRecord =>
                  record.kind === "ticket"
                    ? { ...record, key: key(record) }
                    : {
                        kind: record.kind,
                        key: key(record),
                        title: record.title,
                      },
                ),
              },
            ];
          }}
          onPick={(picked) => {
            const record = found.current.get(picked.key);
            if (!record) return;
            onPick(record);
            setOpen(false);
          }}
          empty={(query) =>
            allLinked
              ? query
                ? "Everything with that name is already linked."
                : "Everything recent is already linked."
              : query
                ? "No ticket, Document or Project has that in its name."
                : "Type part of a name or a reference to find it."
          }
        />
      </PopoverContent>
    </Popover>
  );
}
