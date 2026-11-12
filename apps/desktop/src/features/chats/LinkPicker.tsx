import { useContext, useEffect, useState } from "react";
import { FileText, FolderKanban, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Reference } from "@/components/ui/reference";
import { DocumentNavigation } from "@/features/documents/navigation";
import { TicketNavigation } from "@/features/tickets/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { useChatClient, type LinkedRecord } from "@/features/chats/client";

/** The icon, reference and title of a linked ticket, Document or Project. */
export function RecordLabel({ record }: { record: LinkedRecord }) {
  if (record.kind === "project")
    return (
      <>
        <FolderKanban size={14} aria-hidden />
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
        <button
          type="button"
          aria-label={`Open ${name}`}
          onClick={() =>
            record.kind === "ticket"
              ? openTicket?.(record.reference)
              : openDocument?.(record.id, backLabel)
          }
        >
          <RecordLabel record={record} />
        </button>
      )}
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

/** Finds a ticket, Document or Project by name to link; never asks for an ID. */
export function LinkPicker({
  linked,
  onPick,
  withLabel = false,
}: {
  linked: LinkedRecord[];
  onPick: (record: LinkedRecord) => void;
  /** New Chat shows the word beside the plus. */
  withLabel?: boolean;
}) {
  const client = useChatClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LinkedRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    // Search is by name: nothing is listed until something is typed.
    if (!open || !query.trim()) return;
    let current = true;
    client.searchRecords(query).then(
      (found) => {
        if (!current) return;
        setResults(found);
        setError("");
      },
      (reason: unknown) => current && setError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [client, open, query]);
  const typed = query.trim() !== "";
  const shown = (typed ? results : []).filter(
    (record) =>
      !linked.some(
        (known) => known.kind === record.kind && known.id === record.id,
      ),
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
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
      <PopoverContent
        align="start"
        className="w-80"
        aria-label="Link a ticket, Document or Project"
      >
        <div className="flex flex-col gap-2">
          <Input
            className="h-8"
            aria-label="Search tickets, Documents and Projects"
            placeholder="Search tickets, Documents and Projects"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
          {error && (
            <p className="chat-fine" role="alert">
              Search failed: {error}
            </p>
          )}
          <ul className="chat-pick-results" aria-label="Results">
            {shown.map((record) => (
              <li key={`${record.kind}:${record.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(record);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <RecordLabel record={record} />
                </button>
              </li>
            ))}
          </ul>
          {!error && shown.length === 0 && (
            <p className="chat-fine">
              {!typed
                ? "Type part of a name to find it."
                : results.length > 0
                  ? "Everything with that name is already linked."
                  : "No ticket, Document or Project has that in its name."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
