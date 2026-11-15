import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { CopyButton } from "@/components/ui/copy-button";
import { useStatusLine } from "@/components/ui/use-status-line";
import { useCopy } from "@/components/ui/use-copy";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PublishDialog } from "./PublishToSource";
import { ExportMarkdownButton } from "@/features/attachments/ExportMarkdown";
import {
  publicationReason,
  usePublishTarget,
  usePublicationPreview,
} from "./use-publication-preview";
import { Duplicates } from "@/features/tickets/Duplicates";
import { RecordHistory } from "@/features/sync-review/RecordHistory";
import { SourceLink } from "@/features/tickets/SourceLink";
import { externalSource } from "@/features/tickets/ticket-source";
import { useChatAboutTicket } from "@/features/chats/use-ticket-chats";
import { client, type Project, type Ticket } from "@/lib/api/client";
import "./ticket-detail.css";

/** The shell command an agent runs to read this ticket's context. */
function contextCommand(reference: string): string {
  return `ticketd context ${reference} --relationships --activities --evidence`;
}

/** The reference, personal actions, actions menu, and pane controls of a ticket. */
export function TicketHeader({
  selected,
  ticket,
  expanded,
  onExpand,
  onReturn,
  onClose,
  onOpenGraph,
  refresh,
  updateTicket,
  position = null,
  onAdjacent,
  projects = [],
}: {
  /** For the Project folder a Chat about the ticket is offered. */
  projects?: Project[];
  /** The selected ticket's place in the visible list, across pages. */
  position?: { index: number; total: number } | null;
  /** Opens the ticket before (-1) or after (1) this one in the list. */
  onAdjacent?: (direction: 1 | -1) => void;
  selected: string | null;
  ticket: Ticket | undefined;
  expanded: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  onOpenGraph: () => void;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
}) {
  const chatAbout = useChatAboutTicket(
    ticket,
    projects.find((project) => project.id === ticket?.project_id)?.path ?? null,
  );
  const target = usePublishTarget();
  const preview = usePublicationPreview(ticket, target);
  const [publishing, setPublishing] = useState(false);
  const { copy } = useCopy();
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // Previous/Next replace the ticket (and, at a page edge, the page), which
  // remounts this group. Remember which one the keyboard used and give it focus back.
  const listPosition = useRef<HTMLDivElement>(null);
  const adjacentFocus = useRef<{
    label: "Previous ticket" | "Next ticket";
    from: string | null;
  } | null>(null);
  useEffect(() => {
    const wanted = adjacentFocus.current;
    // Wait for the neighboring ticket to be the loaded, selected one.
    if (!wanted || !ticket || selected === wanted.from) return;
    adjacentFocus.current = null;
    listPosition.current
      ?.querySelector<HTMLButtonElement>(`button[aria-label="${wanted.label}"]`)
      ?.focus();
  }, [selected, ticket, position]);
  const [pending, setPending] = useState(false);
  const statusLine = useStatusLine();
  /** Moves the ticket to Trash (with Undo) or restores it; outcomes go to the status line. */
  async function setTrashed(value: boolean, reference = ticket?.reference) {
    if (!reference) return;
    setPending(true);
    try {
      updateTicket(await client.setTrashed(reference, value));
      await refresh();
      statusLine.show(
        value
          ? {
              message: `Moved ${reference} to Trash`,
              undo: () => restore(reference),
            }
          : { message: `Restored ${reference}` },
      );
    } catch (reason) {
      statusLine.show({
        tone: "error",
        message: `Couldn't ${value ? "move" : "restore"} ${reference}${value ? " to Trash" : ""}. ${String(reason)}`,
        action: { label: "Retry", run: () => setTrashed(value, reference) },
      });
    } finally {
      setPending(false);
    }
  }
  async function restore(reference: string) {
    updateTicket(await client.setTrashed(reference, false));
    await refresh();
  }
  /** A menu copy: the menu closes, so the status line says what happened. */
  async function copyFromMenu(label: string, text: string) {
    const done = await copy(label, text);
    statusLine.show(
      done
        ? { message: `Copied ${label.toLowerCase()}` }
        : {
            tone: "error",
            message: `Couldn't copy the ${label.toLowerCase()}. Select it and copy it instead.`,
          },
    );
  }
  const owner = ticket ? externalSource(ticket) : null;
  return (
    <div className="detail-header">
      <div className="detail-title-group">
        {selected && expanded && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="breadcrumb-back"
              aria-label="Return to ticket list"
              onClick={onReturn}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              All tickets
            </Button>
            <span className="breadcrumb-separator" aria-hidden="true">
              /
            </span>
          </>
        )}
        {selected && !expanded && (
          <span className="return-to-list">
            <IconButton label="Return to ticket list" onClick={onReturn}>
              <ArrowLeft size={16} />
            </IconButton>
          </span>
        )}
        <h2
          id="detail-heading"
          tabIndex={-1}
          className={selected ? "detail-reference" : "sr-only"}
        >
          {selected ?? "Ticket details"}
        </h2>
        {selected && (
          <span className="copy-reference">
            <CopyButton label="Copy reference" text={selected} />
          </span>
        )}
        {owner && (
          <SourceLink url={owner.url} className="header-source-link">
            <span className="sr-only">Open on {owner.provider_name}: </span>
            <span>{owner.place.replace("/", " / ")}</span>{" "}
            <span className="source-number">{owner.number}</span>
          </SourceLink>
        )}
      </div>
      {ticket && (
        <div className="ticket-personal-actions">
          {position && onAdjacent && (
            <div
              ref={listPosition}
              className="list-position"
              role="group"
              aria-label="Position in the list"
            >
              <span className="list-position-text">
                {position.index} of {position.total}
              </span>
              <IconButton
                label="Previous ticket"
                disabled={position.index <= 1}
                onClick={() => {
                  adjacentFocus.current = {
                    label: "Previous ticket",
                    from: selected,
                  };
                  onAdjacent(-1);
                }}
              >
                <ChevronUp />
              </IconButton>
              <IconButton
                label="Next ticket"
                disabled={position.index >= position.total}
                onClick={() => {
                  adjacentFocus.current = {
                    label: "Next ticket",
                    from: selected,
                  };
                  onAdjacent(1);
                }}
              >
                <ChevronDown />
              </IconButton>
            </div>
          )}
          {ticket.trashed && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() => void setTrashed(false)}
            >
              Restore
            </Button>
          )}
          <ExportMarkdownButton
            compact
            source={{ kind: "ticket", reference: ticket.reference }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                ref={actionsTrigger}
                label="Ticket actions"
                disabled={pending}
              >
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="ticket-actions-menu"
              align="end"
              sideOffset={4}
            >
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onSelect={() =>
                    void copyFromMenu("Reference", ticket.reference)
                  }
                >
                  Copy reference
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void copyFromMenu(
                      "Context command",
                      contextCommand(ticket.reference),
                    )
                  }
                >
                  Copy context command
                </DropdownMenuItem>
                {chatAbout && (
                  <DropdownMenuItem onSelect={chatAbout}>
                    Chat about this ticket
                  </DropdownMenuItem>
                )}
                {!ticket.source && target && (
                  <DropdownMenuItem
                    disabled={
                      !preview ||
                      (preview.eligibility.kind !== "eligible" &&
                        preview.eligibility.reason !== "internal_attachments")
                    }
                    onSelect={() => setPublishing(true)}
                    className="publication-menu-item"
                  >
                    <span>Publish to GitHub…</span>
                    {preview && preview.eligibility.kind !== "eligible" && (
                      <small>{publicationReason(preview)}</small>
                    )}
                  </DropdownMenuItem>
                )}
                {!ticket.trashed && (
                  <>
                    <DropdownMenuItem onSelect={() => setDuplicateOpen(true)}>
                      Mark as duplicate…
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onOpenGraph}>
                      Show in dependency graph
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                  History…
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {ticket.trashed ? (
                  <DropdownMenuItem onSelect={() => void setTrashed(false)}>
                    Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void setTrashed(true)}
                  >
                    Move to Trash
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {selected && (
        <div className="detail-actions">
          {expanded ? (
            <IconButton label="Show beside the list" onClick={onReturn}>
              <Minimize2 />
            </IconButton>
          ) : (
            <span className="expand-ticket">
              <IconButton label="Expand ticket" onClick={onExpand}>
                <Maximize2 />
              </IconButton>
            </span>
          )}
          <IconButton label="Close ticket details" onClick={onClose}>
            <X />
          </IconButton>
        </div>
      )}
      {ticket && publishing && target && (
        <PublishDialog
          ticket={ticket}
          provider={target.provider}
          refresh={refresh}
          onOpenChange={setPublishing}
        />
      )}
      {ticket && historyOpen && (
        <RecordHistory
          kind="ticket"
          id={ticket.id}
          subtitle={`${ticket.reference} · ${ticket.title}`}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => void refresh()}
        />
      )}
      {ticket && duplicateOpen && (
        <Duplicates
          ticket={ticket}
          refresh={refresh}
          open
          onOpenChange={setDuplicateOpen}
          title={`Mark ${ticket.reference} as a duplicate`}
          description={`${ticket.reference} keeps its description and history and becomes Duplicate. Review what points at it.`}
          returnFocus={actionsTrigger}
        />
      )}
    </div>
  );
}
