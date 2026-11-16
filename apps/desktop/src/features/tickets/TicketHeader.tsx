import { FollowToggle } from "./Attention";
import { TicketAgentHeader } from "./TicketAgent";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Tooltip } from "@/components/ui/tooltip";
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
import { IconButton } from "@/components/ui/icon-button";
import {
  PaneHeader,
  ReturnCrumb,
  ShellLeading,
} from "@/components/ui/list-header";
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
import { useMarkdownExport } from "@/features/attachments/use-markdown-export";
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
import { type Project, type Ticket } from "@/lib/api/client";
import { useTicketTrash } from "./use-ticket-trash";
import "./ticket-detail.css";

/** The shell command an agent runs to read this ticket's context. */
function contextCommand(reference: string): string {
  return `ticketd context ${reference} --relationships --activities --evidence`;
}

/**
 * The reference, list position, actions menu, and pane controls of a ticket.
 * It keeps one shape in every state: the position slot is reserved ("–" when
 * the ticket has no place in the list), Trash and Restore live in the menu and
 * the document's Trash notice, and outcomes go to the status line.
 */
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
  returnLabel = "All tickets",
  scrolled = false,
  revision = 0,
}: {
  /** The name of the list the ticket was opened from, for the return crumb. */
  returnLabel?: string;
  scrolled?: boolean;
  revision?: number;
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
  /** Opens the ticket's graph; without it the menu leaves the entry out. */
  onOpenGraph?: () => void;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
}) {
  const now = useNow();
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
  /** A dialog opened from the menu hands focus back to the menu's trigger. */
  const returnToActions = () =>
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected)
        actionsTrigger.current?.focus();
    });
  const exporter = useMarkdownExport(
    { kind: "ticket", reference: ticket?.reference ?? "" },
    actionsTrigger,
  );
  // Previous/Next replace the ticket (and, at a page edge, the page), which
  // remounts this group. Remember which one the keyboard used and give it focus
  // back; at the end of the list that button is disabled, so focus moves to its
  // twin, or to the reference, never nowhere.
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
    const button = (label: string) =>
      listPosition.current?.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]:not(:disabled)`,
      );
    const twin =
      wanted.label === "Previous ticket" ? "Next ticket" : "Previous ticket";
    const next = button(wanted.label) ?? button(twin);
    if (next) next.focus();
    else document.getElementById("detail-heading")?.focus();
  }, [selected, ticket, position]);
  const statusLine = useStatusLine();
  const trash = useTicketTrash(updateTicket, refresh);
  // An export that fails says so in the status line, like the menu's copies.
  const exportError = exporter.error;
  useEffect(() => {
    if (!exportError) return;
    statusLine.show({
      tone: "error",
      message: `${exportError.title}. ${exportError.sentence}`,
    });
  }, [exportError, statusLine]);
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
    <>
      <PaneHeader
        title={selected ?? "Ticket details"}
        hideTitle
        variant="ticket"
        leading={
          <div className="detail-title-group">
            {selected && <ShellLeading navOnly />}

            {selected && expanded && (
              // The list it came from, by name (P14), not a hard-coded "All tickets".
              <ReturnCrumb
                origin={returnLabel}
                label="Return to ticket list"
                onReturn={onReturn}
              />
            )}
            {selected && !expanded && (
              <span className="return-to-list">
                <IconButton label="Return to ticket list" onClick={onReturn}>
                  <ArrowLeft size={16} />
                </IconButton>
              </span>
            )}
            <h1
              id="detail-heading"
              tabIndex={-1}
              className={selected ? "detail-reference" : "sr-only"}
            >
              {selected ?? "Ticket details"}
            </h1>
            {selected && (
              <CopyButton
                label="Copy reference"
                text={selected}
                shortcutId="ticket-copy-reference"
              />
            )}
            {scrolled && ticket && (
              <Tooltip content={ticket.title}>
                <span className="ticket-header-title">
                  <span aria-hidden="true">· </span>
                  {ticket.title}
                </span>
              </Tooltip>
            )}
            {!scrolled && ticket?.updated_at && (
              <span className="ticket-header-updated">
                <span aria-hidden="true">·</span>
                <Tooltip content={formatDateTime(ticket.updated_at)}>
                  <time dateTime={ticket.updated_at}>
                    Updated {relativeDateTime(ticket.updated_at, now)}
                  </time>
                </Tooltip>
              </span>
            )}
            {selected && <TicketAgentHeader reference={selected} />}
            {owner && (
              <SourceLink url={owner.url} className="header-source-link">
                <span className="sr-only">Open on {owner.provider_name}: </span>
                <span className="header-source-place">
                  {owner.place.replace("/", " / ")}
                </span>{" "}
                <span className="source-number">{owner.number}</span>
              </SourceLink>
            )}
          </div>
        }
        actions={
          <>
            {ticket && (
              <div className="ticket-personal-actions">
                {onAdjacent && (
                  <div
                    ref={listPosition}
                    className="list-position"
                    role="group"
                    aria-label="Position in the list"
                  >
                    {/* The slot is kept when the ticket has no place in the list, so
                  the icons never move between tickets. */}
                    <span className="list-position-text">
                      {position
                        ? `${position.index} of ${position.total}`
                        : "–"}
                    </span>
                    <IconButton
                      label={
                        returnLabel === "Inbox"
                          ? "Previous entry"
                          : "Previous ticket"
                      }
                      shortcut="K"
                      aria-keyshortcuts="K"
                      disabled={!position || position.index <= 1}
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
                      label={
                        returnLabel === "Inbox" ? "Next entry" : "Next ticket"
                      }
                      shortcut="J"
                      aria-keyshortcuts="J"
                      disabled={!position || position.index >= position.total}
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
                {!ticket.trashed && (
                  <FollowToggle
                    reference={ticket.reference}
                    revision={revision}
                    variant="strip"
                  />
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      ref={actionsTrigger}
                      label="Ticket actions"
                      disabled={trash.pending}
                    >
                      <MoreHorizontal />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
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
                      <DropdownMenuItem
                        disabled={exporter.busy}
                        onSelect={() => void exporter.run()}
                      >
                        Export Markdown with files…
                      </DropdownMenuItem>
                      {/* Only once a source that publishes is set up: without one
                    there is nothing to publish to, so nothing is offered. */}
                      {!ticket.source && target && (
                        <DropdownMenuItem
                          disabled={
                            !preview ||
                            (preview.eligibility.kind !== "eligible" &&
                              preview.eligibility.reason !==
                                "internal_attachments")
                          }
                          onSelect={() => setPublishing(true)}
                          {...(preview &&
                            preview.eligibility.kind !== "eligible" &&
                            preview.eligibility.reason !==
                              "internal_attachments" && {
                              reason: publicationReason(preview),
                            })}
                        >
                          Publish to {preview?.provider_name ?? "GitHub"}…
                        </DropdownMenuItem>
                      )}
                      {!ticket.trashed && (
                        <>
                          <DropdownMenuItem
                            onSelect={() => setDuplicateOpen(true)}
                          >
                            Mark as duplicate…
                          </DropdownMenuItem>
                          {onOpenGraph && (
                            <DropdownMenuItem onSelect={onOpenGraph}>
                              Open graph
                            </DropdownMenuItem>
                          )}
                        </>
                      )}
                      <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                        History…
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      {ticket.trashed ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            void trash.setTrashed(ticket.reference, false)
                          }
                        >
                          Restore
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            void trash.setTrashed(ticket.reference, true)
                          }
                        >
                          Move to Trash
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                {exporter.ui}
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
                <IconButton
                  label="Close ticket details"
                  shortcut="Esc"
                  aria-keyshortcuts="Escape"
                  onClick={onClose}
                >
                  <X />
                </IconButton>
              </div>
            )}
          </>
        }
      />
      {ticket && publishing && target && (
        <PublishDialog
          ticket={ticket}
          provider={target.provider}
          refresh={refresh}
          onOpenChange={(open) => {
            setPublishing(open);
            if (!open) returnToActions();
          }}
        />
      )}
      {ticket && historyOpen && (
        <RecordHistory
          kind="ticket"
          id={ticket.id}
          subtitle={`${ticket.reference} · ${ticket.title}`}
          onClose={() => {
            setHistoryOpen(false);
            returnToActions();
          }}
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
    </>
  );
}
