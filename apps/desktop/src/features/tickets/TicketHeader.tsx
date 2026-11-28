import { useFollow } from "./use-follow";
import { TicketAgentHeader } from "./TicketAgent";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Tooltip } from "@/components/ui/tooltip";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PublishDialog } from "./PublishToSource";
import { useMarkdownExport } from "@/features/attachments/use-markdown-export";
import { ticketExportMarkdown } from "@/lib/api/portable-export";
import { TicketCommandContext } from "@/lib/ticket-command-actions";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import {
  publicationReason,
  usePublishTarget,
  usePublicationPreview,
} from "./use-publication-preview";
import { Duplicates } from "@/features/tickets/Duplicates";
import { RecordHistory } from "@/features/sync-review/RecordHistory";
import { SourceLink } from "@/features/tickets/SourceLink";
import {
  externalSource,
  sourceLocation,
  sourceReference,
} from "@/features/tickets/ticket-source";
import { useChatAboutTicket } from "@/features/chats/use-ticket-chats";
import { type Project, type Ticket } from "@/lib/api/client";
import type { TicketListPosition } from "./useTicketWorkspace";
import { useTicketTrash } from "./use-ticket-trash";
import { useTicketChanged } from "./open-ticket";
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
  position = null,
  outsideResults = false,
  onAdjacent,
  projects = [],
  returnLabel = "All tickets",
  scrolled = false,
  narrow = false,
}: {
  /** The name of the list the ticket was opened from, for the return crumb. */
  returnLabel?: string;
  scrolled?: boolean;
  narrow?: boolean;
  /** For the Project folder a Chat about the ticket is offered. */
  projects?: Project[];
  /** The selected ticket's place in the visible list, across pages. */
  position?: TicketListPosition | null;
  outsideResults?: boolean;
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
}) {
  const now = useNow();
  const chatAbout = useChatAboutTicket(
    ticket,
    projects.find(
      (project) => project.id === ticket?.project_id && !project.archived,
    )?.path ?? null,
  );
  const target = usePublishTarget();
  const preview = usePublicationPreview(ticket, target);
  const [publishing, setPublishing] = useState(false);
  const { copy } = useCopy();
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const openCommand = useContext(TicketCommandContext);
  const followReference = ticket && !ticket.trashed ? ticket.reference : null;
  const follow = useFollow(followReference, true);
  const openReminder = () => {
    if (followReference)
      openCommand?.(
        "Reminder",
        followReference,
        actionsTrigger.current ?? undefined,
      );
  };
  const runHeaderShortcut = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    const pane = actionsTrigger.current?.closest(".ticket-detail");
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      !(target instanceof Element) ||
      !pane?.contains(target) ||
      pane.closest("[hidden], [inert]") ||
      target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]",
      ) ||
      document.querySelector(
        "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-slot=popover-content]",
      )
    )
      return;
    if (matchesShortcut(event, "ticket-follow") && !follow.blocked) {
      event.preventDefault();
      void follow.toggle();
    } else if (
      returnLabel === "Inbox" &&
      matchesShortcut(event, "ticket-reminder") &&
      openCommand
    ) {
      event.preventDefault();
      openReminder();
    }
  });
  useEffect(() => {
    if (!followReference) return;
    const onKey = (event: KeyboardEvent) => runHeaderShortcut(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [followReference]);
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
  const previousLabel =
    returnLabel === "Inbox" ? "Previous entry" : "Previous ticket";
  const nextLabel = returnLabel === "Inbox" ? "Next entry" : "Next ticket";
  // Previous/Next replace the ticket (and, at a page edge, the page), which
  // remounts this group. Remember which one the keyboard used and give it focus
  // back; at the end of the list that button is disabled, so focus moves to its
  // twin, or to the reference, never nowhere.
  const listPosition = useRef<HTMLDivElement>(null);
  const adjacentFocus = useRef<{
    direction: -1 | 1;
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
    const next =
      wanted.direction === -1
        ? (button(previousLabel) ?? button(nextLabel))
        : (button(nextLabel) ?? button(previousLabel));
    if (next) next.focus();
    else document.getElementById("detail-heading")?.focus();
  }, [selected, ticket, position, previousLabel, nextLabel]);
  const statusLine = useStatusLine();
  const changed = useTicketChanged();
  const trash = useTicketTrash(changed);
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
  async function copyFromMenu(label: string, text: string | Promise<string>) {
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
  const group = position?.statusGroup ?? position;
  const groupStatus =
    returnLabel === "Inbox"
      ? null
      : (position?.statusGroup?.status ?? ticket?.status);
  const positionText = group
    ? `${group.index} of ${group.total}${groupStatus ? ` ${groupStatus.toLowerCase()}` : ""}`
    : "–";
  const positionReason = position
    ? undefined
    : outsideResults
      ? "Not in the current results"
      : "No position in the current list";
  const sourceURL = ticket?.source?.url;
  const agentCommand = contextCommand(ticket?.reference ?? "");
  const owner = ticket ? externalSource(ticket) : null;
  const issueReference = owner ? sourceReference(owner) : null;
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
            <h2
              id="detail-heading"
              tabIndex={-1}
              className={selected ? "detail-reference" : "sr-only"}
            >
              {selected ?? "Ticket details"}
            </h2>
            {selected && !narrow && (
              <CopyButton
                label="Copy reference"
                text={selected}
                shortcutId="ticket-copy-reference"
              />
            )}
            {scrolled && ticket && (
              <Tooltip content={ticket.title} overflowOnly>
                <span className="ticket-header-title">
                  <span aria-hidden="true">· </span>
                  {ticket.title}
                </span>
              </Tooltip>
            )}
            {selected && <TicketAgentHeader reference={selected} />}
            {owner && issueReference && (
              <SourceLink
                url={owner.url}
                className="header-source-link"
                label={`Open on ${owner.provider_name}: ${sourceLocation(owner)}`}
                title={sourceLocation(owner)}
              >
                {issueReference.place && (
                  <>
                    <span className="header-source-place">
                      {issueReference.place}
                    </span>{" "}
                  </>
                )}
                <span
                  className={
                    issueReference.place
                      ? "source-number"
                      : "header-source-place"
                  }
                >
                  {issueReference.label}
                </span>
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
                    {!narrow && (
                      <Tooltip content={positionReason}>
                        <span
                          className="list-position-text"
                          tabIndex={positionReason ? 0 : undefined}
                          aria-label={positionReason}
                        >
                          {positionText}
                        </span>
                      </Tooltip>
                    )}
                    <IconButton
                      label={previousLabel}
                      shortcut="K"
                      aria-keyshortcuts="K"
                      disabled={!position || position.index <= 1}
                      onClick={() => {
                        adjacentFocus.current = {
                          direction: -1,
                          from: selected,
                        };
                        onAdjacent(-1);
                      }}
                    >
                      <ChevronUp />
                    </IconButton>
                    <IconButton
                      label={nextLabel}
                      shortcut="J"
                      aria-keyshortcuts="J"
                      disabled={!position || position.index >= position.total}
                      onClick={() => {
                        adjacentFocus.current = {
                          direction: 1,
                          from: selected,
                        };
                        onAdjacent(1);
                      }}
                    >
                      <ChevronDown />
                    </IconButton>
                  </div>
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
                  <DropdownMenuContent
                    align="end"
                    className="w-64 max-w-(--radix-dropdown-menu-content-available-width)"
                  >
                    {ticket.updated_at && (
                      <DropdownMenuLabel>
                        <Tooltip content={formatDateTime(ticket.updated_at)}>
                          <time dateTime={ticket.updated_at}>
                            Updated {relativeDateTime(ticket.updated_at, now)}
                          </time>
                        </Tooltip>
                      </DropdownMenuLabel>
                    )}
                    {narrow && onAdjacent && (
                      <DropdownMenuLabel aria-label={positionReason}>
                        {positionText}
                        {positionReason && <> · {positionReason}</>}
                      </DropdownMenuLabel>
                    )}
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        onSelect={() =>
                          void copyFromMenu("Reference", ticket.reference)
                        }
                      >
                        Copy reference
                      </DropdownMenuItem>
                      {sourceURL && (
                        <DropdownMenuItem
                          onSelect={() => void copyFromMenu("Link", sourceURL)}
                        >
                          Copy link
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() =>
                          void copyFromMenu(
                            "Markdown",
                            ticketExportMarkdown(ticket.reference),
                          )
                        }
                      >
                        Copy as Markdown
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label="Copy for an agent"
                        aria-description={agentCommand}
                        onSelect={() =>
                          void copyFromMenu("Context command", agentCommand)
                        }
                      >
                        <span className="flex min-w-0 flex-col">
                          Copy for an agent
                          <span className="wrap-anywhere font-mono text-xs/4 text-muted-foreground">
                            {agentCommand}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      {!ticket.trashed && (
                        <>
                          <DropdownMenuCheckboxItem
                            aria-label="Follow"
                            aria-keyshortcuts={ariaKeyShortcuts(
                              "ticket-follow",
                            )}
                            aria-description="Updates and approvals reach your Inbox"
                            checked={follow.following}
                            disabled={follow.blocked}
                            keepOpen={false}
                            onCheckedChange={() => void follow.toggle()}
                          >
                            <span className="flex min-w-0 flex-col">
                              Follow
                              <span className="text-xs/4 text-muted-foreground">
                                Updates and approvals reach your Inbox
                              </span>
                            </span>
                            <DropdownMenuShortcut aria-hidden="true">
                              {shortcutLabel("ticket-follow")}
                            </DropdownMenuShortcut>
                          </DropdownMenuCheckboxItem>
                          <DropdownMenuItem
                            aria-label="Remind me…"
                            aria-keyshortcuts={ariaKeyShortcuts(
                              "ticket-reminder",
                            )}
                            onSelect={openReminder}
                          >
                            Remind me…
                            <DropdownMenuShortcut aria-hidden="true">
                              {shortcutLabel("ticket-reminder")}
                            </DropdownMenuShortcut>
                          </DropdownMenuItem>
                        </>
                      )}
                      {chatAbout && (
                        <DropdownMenuItem onSelect={chatAbout}>
                          Chat about this ticket
                        </DropdownMenuItem>
                      )}
                      {!ticket.trashed && onOpenGraph && (
                        <DropdownMenuItem onSelect={onOpenGraph}>
                          Open in graph
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                        History…
                      </DropdownMenuItem>
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
                          Publish to {preview?.provider_name ?? target?.name}…
                        </DropdownMenuItem>
                      )}
                      {!ticket.trashed && (
                        <DropdownMenuItem
                          onSelect={() => setDuplicateOpen(true)}
                        >
                          Mark as duplicate…
                        </DropdownMenuItem>
                      )}
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
          refresh={changed}
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
          onRestored={() => void changed()}
        />
      )}
      {ticket && duplicateOpen && (
        <Duplicates
          ticket={ticket}
          refresh={changed}
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
