import { SettingsNavigation } from "@/lib/settings-navigation";
import { searchMatch } from "@/lib/search-match";
import { documents, type DocumentSummary } from "@/features/documents/api";
import {
  DocumentNavigation,
  PlanNavigation,
} from "@/features/documents/navigation";
import { plansClient, type PlanCounts } from "@/lib/api/plans";
import { useInboxAttention } from "@/features/tickets/use-inbox-attention";
import {
  workspaceGraphCommand,
  ContextGraphNavigation,
} from "@/features/documents/navigation";
import { useLinkedChats, useChatFeature } from "@/features/chats/use-chats";
import { statusLabel } from "@/features/chats/model";
import { ReminderDateTime } from "@/features/tickets/ReminderDateTime";
import { localInstants, localValue } from "@/features/tickets/reminder-time";
import { reminderPresets } from "@/features/tickets/reminder-presets";
import { Button } from "@/components/ui/button";
import {
  Bot,
  Cloud,
  Check,
  Circle,
  Folder,
  Tag,
  Bell,
  Copy,
  Layers as PlanIcon,
} from "lucide-react";
import { type Project, type Ticket } from "@/lib/api/client";
import { useTicketCommands } from "./use-ticket-commands";
import {
  ticketCommandActions,
  type TicketCommandScope,
} from "@/lib/ticket-command-actions";
import { matchesShortcut } from "@/lib/shortcuts";
import { Duplicates } from "@/features/tickets/Duplicates";
import { ConfirmLeaveDuplicate } from "@/features/tickets/ConfirmLeaveDuplicate";
import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import {
  Inbox,
  ListTodo,
  CircleCheck,
  MessagesSquare,
  Files,
  Layers,
  Settings,
  Trash2,
  SquarePen,
  NotebookPen,
  MessageSquarePlus,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  CommandMatch,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Reference } from "@/components/ui/reference";
import { KeyChords, Kbd } from "@/components/ui/kbd";
import { SHORTCUTS, shortcut, type ShortcutId } from "@/lib/shortcuts";
import { useTicketSearch } from "@/features/tickets/useTicketSearch";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { GoTo } from "./use-command-keys";

const targets = [
  { id: "inbox", label: "Inbox", icon: Inbox, key: "go-inbox" },
  { id: "all", label: "All tickets", icon: ListTodo, key: "go-all" },
  { id: "ready", label: "Ready", icon: CircleCheck, key: "go-ready" },
  { id: "chats", label: "Chats", icon: MessagesSquare, key: "go-chats" },
  {
    id: "automations",
    label: "Automations",
    icon: Layers,
    key: "go-automations",
  },
  { id: "documents", label: "Documents", icon: Files, key: "go-documents" },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "plans", label: "Plans", icon: Layers },
  { id: "settings", label: "Settings", icon: Settings, key: "go-settings" },
  { id: "trash", label: "Trash", icon: Trash2, key: "go-trash" },
] satisfies { id: GoTo; label: string; icon: typeof Inbox; key?: ShortcutId }[];

export function CommandPalette({
  writeUpdate = null,
  memoryTickets = [],
  readyCount = null,
  automationCount = null,
  documentCommands = null,
  attachmentCommands = null,
  currentPlan = null,
  workspaceGraphActive = false,
  create,
  createDisabledReason,
  open,
  onOpenChange,
  go,
  ticket,
  chatsEnabled,
  returnFocus,
  reference,
  initialScope,
  initialTicket,
  projects,
  plans,
  refresh,
}: {
  writeUpdate?: (() => void) | null;
  memoryTickets?: Ticket[];
  readyCount?: number | null;
  automationCount?: number | null;
  attachmentCommands?: Record<
    "search" | "add" | "open" | "more" | "back",
    (() => void) | null
  > | null;
  documentCommands?: {
    search: () => void;
    pin: (() => void) | null;
    pinned: boolean;
  } | null;
  currentPlan?: string | null;
  workspaceGraphActive?: boolean;
  create: (kind: "ticket" | "capture" | "chat" | "plan") => void;
  createDisabledReason: string | null;
  initialTicket: Ticket | null;
  reference: string | null;
  initialScope: TicketCommandScope | null;
  projects: Project[];
  plans: { id: string; name: string; archived: boolean }[];
  refresh: () => Promise<void>;
  returnFocus: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  go: (target: GoTo) => void;
  ticket: (reference: string) => void;
  chatsEnabled: boolean;
}) {
  const navigateSettings = useContext(SettingsNavigation);
  const openGraph = useContext(ContextGraphNavigation);
  const openDocument = useContext(DocumentNavigation);
  const openPlan = useContext(PlanNavigation);
  const attention = useInboxAttention();
  const [recentDocuments, setRecentDocuments] = useState<DocumentSummary[]>([]);
  const [foundDocuments, setFoundDocuments] = useState<{
    query: string;
    items: DocumentSummary[];
  }>({ query: "", items: [] });
  const [planCounts, setPlanCounts] = useState<Record<string, PlanCounts>>({});
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const instants = localInstants(draft);
  const input = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<TicketCommandScope | null>(null);
  const commandsOnly = query.trimStart().startsWith(">");
  const filter = commandsOnly ? query.trimStart().slice(1).trim() : query;
  const referencesOnly = !commandsOnly && /^t-/i.test(query.trimStart());
  const matches = (label: string) =>
    !referencesOnly && searchMatch(label, filter) !== null;
  useEffect(() => {
    if (!open) return;
    let active = true;
    void documents.recent(0).then(
      (items) => {
        if (active) setRecentDocuments(items);
      },
      () => {},
    );
    void Promise.all(
      plans
        .filter((plan) => !plan.archived)
        .map(async (plan) => {
          try {
            return [plan.id, (await plansClient.show(plan.id)).counts] as const;
          } catch {
            return null;
          }
        }),
    ).then((entries) => {
      if (active)
        setPlanCounts(
          Object.fromEntries(entries.filter((entry) => entry !== null)),
        );
    });
    return () => {
      active = false;
    };
  }, [open, plans]);
  useEffect(() => {
    if (!open || commandsOnly || referencesOnly || !query.trim()) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void documents.search(query.trim(), null, 0).then(
        (items) => {
          if (active) setFoundDocuments({ query, items });
        },
        () => {},
      );
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, commandsOnly, referencesOnly, query]);
  const actions = useTicketCommands({
    reference,
    initialTicket,
    open,
    scope,
    query: scope ? query : "",
    projects,
    plans,
    close: () => onOpenChange(false),
    refresh,
  });
  const chat = useChatFeature();
  const { list: linkedChats } = useLinkedChats(
    open && chatsEnabled && actions.ticket
      ? { kind: "ticket", id: actions.ticket.id }
      : null,
  );
  const icons = {
    Status: Circle,
    Project: Folder,
    Plan: PlanIcon,
    Tags: Tag,
    Reminder: Bell,
  };
  const drill = (next: TicketCommandScope) => {
    setCustom(false);
    setHighlight(undefined);
    setScope(next);
    setQuery("");
  };
  function choose(value: string) {
    if (scope === "Reminder" && value === "custom") {
      setCustom(true);
      setDraft(
        localValue(
          actions.due
            ? new Date(actions.due)
            : reminderPresets(new Date()).find((p) => p.key === "tomorrow")!.at,
        ),
      );
      setOccurrence("");
      return;
    }
    void actions.apply(value);
  }
  const [highlight, setHighlight] = useState<string | undefined>();
  const navigated = useRef(false);
  const search = useTicketSearch(
    query,
    open && !commandsOnly && !scope,
    () => true,
  );
  const ticketResults = [
    ...new Map(
      [
        ...search.results,
        ...memoryTickets.filter(
          (item) =>
            !item.trashed &&
            (referencesOnly
              ? item.reference
                  .toLowerCase()
                  .includes(query.trim().toLowerCase())
              : searchMatch(`${item.reference} ${item.title}`, query) !== null),
        ),
      ]
        .filter(
          (item) =>
            !referencesOnly ||
            item.reference.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .map((item) => [item.id, item]),
    ).values(),
  ].slice(0, 8);
  const documentResults = [
    ...new Map(
      [
        ...(foundDocuments.query === query ? foundDocuments.items : []),
        ...recentDocuments.filter(
          (item) => searchMatch(item.heading, query) !== null,
        ),
      ].map((item) => [item.id, item]),
    ).values(),
  ].slice(0, 8);
  const run = (action: () => void) => {
    navigated.current = true;
    onOpenChange(false);
    action();
  };
  function drillBack() {
    setCustom(false);
    setScope(null);
    setQuery("");
  }
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          size="palette"
          returnFocus={returnFocus}
          variant="flush"
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            navigated.current = false;
            setHighlight(undefined);
            setQuery("");
            setScope(initialScope);
            setCustom(false);
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (navigated.current) {
              event.preventDefault();
              // A create command opens a dialog whose autofocus must win.
              if (
                !document.querySelector(
                  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
                )
              )
                document.getElementById("main-content")?.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            if (event.isComposing) event.preventDefault();
          }}
        >
          <DialogTitle className="sr-only">Go anywhere</DialogTitle>
          <DialogDescription className="sr-only">
            Find a Ticket, open a view or run an action.
          </DialogDescription>
          <Command
            variant="palette"
            label="Search tickets and destinations"
            shouldFilter={false}
            {...(scope && {
              value:
                highlight ??
                ((actions.options.find((option) => option.selected)?.value ??
                  actions.options[0]?.value) ||
                  "none"),
            })}
            onValueChange={setHighlight}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.repeat || custom)
                return;
              if (scope && !custom) {
                if (event.key === "Backspace" && !query) {
                  event.preventDefault();
                  drillBack();
                }
                if (
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  /^[1-9]$/.test(event.key)
                ) {
                  const option = actions.options[Number(event.key) - 1];
                  if (option) {
                    event.preventDefault();
                    choose(option.value);
                  }
                }
              } else if (actions.ticket) {
                const action = !query
                  ? ticketCommandActions.find((action) =>
                      matchesShortcut(event.nativeEvent, action.shortcut),
                    )
                  : undefined;
                if (action) {
                  event.preventDefault();
                  drill(action.scope);
                }
                if (event.key === "Tab" || event.key === "ArrowRight") {
                  const selected = event.currentTarget
                    .querySelector('[aria-selected="true"]')
                    ?.getAttribute("data-value");
                  const selectedAction = ticketCommandActions.find(
                    (action) => action.scope === selected,
                  );
                  if (selectedAction) {
                    event.preventDefault();
                    drill(selectedAction.scope);
                  }
                }
              }
            }}
          >
            <CommandInput
              escapeHint
              scope={
                scope && actions.ticket ? (
                  <span className="ui-palette-scope">
                    <span aria-hidden="true">
                      <Reference>{actions.ticket.reference}</Reference>{" "}
                      {scope === "Status" ? "Change status" : scope}
                    </span>
                    <span className="sr-only" role="status">
                      {scope} of {actions.ticket.reference}
                    </span>
                  </span>
                ) : undefined
              }
              ref={input}
              value={query}
              onValueChange={setQuery}
              aria-label="Search tickets and destinations"
              placeholder={
                scope
                  ? `Search ${scope.toLowerCase()}…`
                  : "Search tickets, Documents and actions"
              }
            />
            {custom && actions.ticket && (
              <div
                className="ui-palette-custom"
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCustom(false)}
                >
                  Back to reminders
                </Button>
                <ReminderDateTime
                  reference={actions.ticket.reference}
                  draft={draft}
                  occurrence={occurrence}
                  pending={actions.pending || actions.blocked}
                  onDraft={(value) => {
                    setDraft(value);
                    setOccurrence("");
                  }}
                  onOccurrence={setOccurrence}
                />
                <Button
                  size="sm"
                  disabled={
                    actions.pending ||
                    actions.blocked ||
                    instants.length === 0 ||
                    (instants.length > 1 && !occurrence)
                  }
                  onClick={() =>
                    void actions.apply(
                      "custom",
                      false,
                      occurrence || instants[0]!.toISOString(),
                    )
                  }
                >
                  Set reminder
                </Button>
              </div>
            )}
            <CommandList hidden={custom}>
              {scope && (
                <CommandGroup>
                  {actions.options.map((option, index) => (
                    <CommandItem
                      key={option.value || "none"}
                      aria-label={option.label}
                      aria-keyshortcuts={
                        index < 9 && option.value !== "Duplicate"
                          ? String(index + 1)
                          : undefined
                      }
                      value={option.value || "none"}
                      disabled={actions.blocked || actions.pending}
                      onSelect={() => choose(option.value)}
                    >
                      {scope === "Status" ? (
                        <StatusIcon status={option.value} decorative />
                      ) : (
                        <span className="size-4" />
                      )}
                      <span className="flex-1">{option.label}</span>
                      <CommandShortcut>
                        {option.selected && <Check aria-hidden="true" />}
                        {index < 9 && option.value !== "Duplicate" && (
                          <Kbd>{index + 1}</Kbd>
                        )}
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {!scope && actions.ticket && (
                <CommandGroup
                  heading={`${actions.ticket.reference} · ${actions.ticket.title}`}
                >
                  {ticketCommandActions
                    .filter((action) => matches(action.label))
                    .map((action) => {
                      const Icon = icons[action.scope];
                      const keys = shortcut(action.shortcut);
                      const value =
                        action.scope === "Status"
                          ? actions.ticket?.status
                          : action.scope === "Plan"
                            ? plans.find(
                                (p) => p.id === actions.ticket?.plan_id,
                              )?.name
                            : action.scope === "Project"
                              ? projects.find(
                                  (p) => p.id === actions.ticket?.project_id,
                                )?.name
                              : undefined;
                      return (
                        <CommandItem
                          key={action.scope}
                          value={action.scope}
                          disabled={actions.blocked}
                          onSelect={() => drill(action.scope)}
                        >
                          {action.scope === "Status" ? (
                            <StatusIcon
                              status={actions.ticket!.status}
                              decorative
                            />
                          ) : (
                            <Icon aria-hidden="true" />
                          )}
                          <span className="flex-1">
                            <CommandMatch text={action.label} query={filter} />
                          </span>
                          <CommandShortcut>
                            {value} <KeyChords keys={keys.keys} />
                          </CommandShortcut>
                        </CommandItem>
                      );
                    })}
                  {writeUpdate &&
                    filter.trim() &&
                    matches("Write an update") && (
                      <CommandItem
                        value="ticket-update"
                        onSelect={() =>
                          run(() => requestAnimationFrame(writeUpdate))
                        }
                      >
                        <SquarePen aria-hidden="true" />
                        <span className="flex-1">
                          <CommandMatch text="Write an update" query={filter} />
                        </span>
                        <CommandShortcut>
                          <KeyChords keys={shortcut("ticket-update").keys} />
                        </CommandShortcut>
                      </CommandItem>
                    )}
                  {linkedChats?.chats
                    .filter((item) => matches(`open chat ${item.title}`))
                    .map((item) => (
                      <CommandItem
                        key={item.id}
                        value={`chat-${item.id}`}
                        onSelect={() =>
                          run(() =>
                            chat.requestChat({
                              kind: "open",
                              chatId: item.id,
                              retention: item.retention,
                              from: actions.ticket!.reference,
                            }),
                          )
                        }
                      >
                        <MessagesSquare aria-hidden="true" />
                        <span className="flex-1">
                          Open its Chat, “{item.title}”
                        </span>
                        <CommandShortcut>
                          {statusLabel(item.status)}
                        </CommandShortcut>
                      </CommandItem>
                    ))}
                  {matches("copy reference") && (
                    <CommandItem
                      value="copy-reference"
                      onSelect={() => {
                        void navigator.clipboard.writeText(
                          actions.ticket!.reference,
                        );
                        onOpenChange(false);
                      }}
                    >
                      <Copy aria-hidden="true" />
                      <span className="flex-1">Copy reference</span>
                      <CommandShortcut>
                        <KeyChords
                          keys={shortcut("ticket-copy-reference").keys}
                        />
                      </CommandShortcut>
                    </CommandItem>
                  )}
                </CommandGroup>
              )}
              {!scope && !commandsOnly && query.trim() && (
                <CommandGroup heading="Tickets">
                  {ticketResults.map((result) => (
                    <CommandItem
                      key={result.reference}
                      value={result.reference}
                      onSelect={() => run(() => ticket(result.reference))}
                    >
                      <StatusIcon status={result.status} decorative />
                      <Reference>
                        <CommandMatch text={result.reference} query={query} />
                      </Reference>
                      <span className="min-w-0 flex-1 truncate">
                        <CommandMatch text={result.title} query={query} />
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {!scope &&
                !commandsOnly &&
                !referencesOnly &&
                query.trim() &&
                documentResults.length > 0 && (
                  <CommandGroup heading="Documents">
                    {documentResults.map((document) => (
                      <CommandItem
                        key={document.id}
                        value={`document-${document.id}`}
                        onSelect={() => run(() => openDocument?.(document.id))}
                      >
                        <Files aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">
                          <CommandMatch
                            text={document.heading || "Untitled"}
                            query={query}
                          />
                        </span>
                        <CommandShortcut>Document</CommandShortcut>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              {!scope && documentCommands && (
                <CommandGroup heading="Documents actions">
                  {matches("Search this Documents list") && (
                    <CommandItem
                      value="documents-search"
                      onSelect={() =>
                        run(() =>
                          requestAnimationFrame(documentCommands.search),
                        )
                      }
                    >
                      <Files aria-hidden="true" />
                      <span className="flex-1">
                        <CommandMatch
                          text="Search this Documents list"
                          query={filter}
                        />
                      </span>
                      <CommandShortcut>
                        <KeyChords keys={shortcut("documents-search").keys} />
                      </CommandShortcut>
                    </CommandItem>
                  )}
                  {matches("Pin or unpin the focused Document") && (
                    <CommandItem
                      value="documents-pin"
                      disabled={!documentCommands.pin}
                      onSelect={() =>
                        run(() =>
                          requestAnimationFrame(() => documentCommands.pin?.()),
                        )
                      }
                    >
                      <Files aria-hidden="true" />
                      <span className="flex-1">
                        {documentCommands.pinned ? "Unpin" : "Pin"} the focused
                        Document
                      </span>
                      <CommandShortcut>
                        <KeyChords keys={shortcut("documents-pin").keys} />
                      </CommandShortcut>
                    </CommandItem>
                  )}
                </CommandGroup>
              )}
              {!scope && attachmentCommands && (
                <CommandGroup heading="Attachments actions">
                  {[
                    {
                      id: "attachments-search",
                      label: "Search files",
                      run: attachmentCommands.search,
                    },
                    {
                      id: "attachments-add",
                      label: "Add files",
                      run: attachmentCommands.add,
                    },
                    {
                      id: "attachments-open",
                      label: "Open file",
                      run: attachmentCommands.open,
                    },
                    {
                      id: "attachments-more",
                      label: "More file actions",
                      run: attachmentCommands.more,
                    },
                    {
                      id: "attachments-back",
                      label: "Back to Attachments",
                      run: attachmentCommands.back,
                    },
                  ]
                    .filter((command) => matches(command.label))
                    .map((command) => (
                      <CommandItem
                        key={command.id}
                        value={command.id}
                        disabled={!command.run}
                        onSelect={() =>
                          run(() =>
                            requestAnimationFrame(() => command.run?.()),
                          )
                        }
                      >
                        <Files aria-hidden="true" />
                        <span className="flex-1">
                          <CommandMatch text={command.label} query={filter} />
                        </span>
                        <CommandShortcut>
                          <KeyChords
                            keys={
                              SHORTCUTS.find((entry) => entry.id === command.id)
                                ?.keys ?? []
                            }
                          />
                        </CommandShortcut>
                      </CommandItem>
                    ))}
                </CommandGroup>
              )}
              {!scope && workspaceGraphActive && (
                <CommandGroup heading="Workspace graph">
                  {(
                    [
                      {
                        id: "workspace-graph-filter",
                        label: "Filter the Workspace graph",
                        command: "filter",
                      },
                      {
                        id: "workspace-graph-view",
                        label: "Switch Graph / List",
                        command: "view",
                      },
                    ] as const
                  )
                    .filter((item) => matches(item.label))
                    .map((item) => (
                      <CommandItem
                        key={item.id}
                        value={item.id}
                        onSelect={() =>
                          run(() => workspaceGraphCommand(item.command))
                        }
                      >
                        <span className="flex-1">
                          <CommandMatch text={item.label} query={filter} />
                        </span>
                        <CommandShortcut>
                          <KeyChords keys={shortcut(item.id).keys} />
                        </CommandShortcut>
                      </CommandItem>
                    ))}
                </CommandGroup>
              )}
              {!scope &&
                currentPlan &&
                openGraph &&
                matches("open the full graph") && (
                  <CommandGroup heading="Plan">
                    <CommandItem
                      value="plan-full-graph"
                      onSelect={() =>
                        run(() =>
                          openGraph(currentPlan, {
                            workspacePlan: currentPlan,
                          }),
                        )
                      }
                    >
                      <PlanIcon aria-hidden="true" />
                      <span className="flex-1">Open the full graph</span>
                      <CommandShortcut>
                        <KeyChords keys={shortcut("flow-full-graph").keys} />
                      </CommandShortcut>
                    </CommandItem>
                  </CommandGroup>
                )}
              {!scope && (
                <CommandGroup heading="Go to">
                  {targets
                    .filter((target) => matches(target.label))
                    .map((target) => {
                      const keys =
                        "key" in target ? shortcut(target.key) : null;
                      return (
                        <CommandItem
                          key={target.id}
                          value={target.id}
                          aria-label={
                            target.id === "automations" && automationCount
                              ? `Automations, ${automationCount} ${automationCount === 1 ? "run needs" : "runs need"} you`
                              : undefined
                          }
                          disabled={
                            (target.id === "chats" ||
                              target.id === "automations") &&
                            !chatsEnabled
                          }
                          onSelect={() => run(() => go(target.id))}
                        >
                          <target.icon aria-hidden="true" />
                          <span className="flex-1">
                            <CommandMatch text={target.label} query={filter} />
                          </span>
                          {(target.id === "chats" ||
                            target.id === "automations") &&
                            !chatsEnabled && (
                              <CommandShortcut>Chat is off</CommandShortcut>
                            )}
                          {target.id === "automations" &&
                            automationCount !== null &&
                            automationCount > 0 && (
                              <CommandShortcut>
                                {automationCount}{" "}
                                {automationCount === 1
                                  ? "run needs"
                                  : "runs need"}{" "}
                                you
                              </CommandShortcut>
                            )}
                          {target.id === "inbox" &&
                            attention &&
                            !attention.loading && (
                              <CommandShortcut>
                                {attention.needsCount} need you
                              </CommandShortcut>
                            )}
                          {target.id === "ready" && readyCount !== null && (
                            <CommandShortcut>
                              {readyCount} tickets
                            </CommandShortcut>
                          )}
                          {keys && (
                            <CommandShortcut>
                              <KeyChords
                                sequenceStyle="compact"
                                keys={keys.keys}
                                sequences={keys.sequences}
                              />
                            </CommandShortcut>
                          )}
                        </CommandItem>
                      );
                    })}
                  {(
                    [
                      {
                        id: "go-agent-skills",
                        section: "agent-skills",
                        label: "Agent skills",
                        icon: Bot,
                      },
                      {
                        id: "go-sync",
                        section: "google-drive",
                        label: "Google Drive sync",
                        icon: Cloud,
                      },
                    ] as const
                  )
                    .filter((target) => matches(target.label))
                    .map((target) => (
                      <CommandItem
                        key={target.id}
                        value={target.id}
                        disabled={!navigateSettings}
                        onSelect={() =>
                          run(() => navigateSettings?.(target.section))
                        }
                      >
                        <target.icon aria-hidden="true" />
                        <span className="flex-1">
                          <CommandMatch text={target.label} query={filter} />
                        </span>
                        <CommandShortcut>
                          <KeyChords keys={shortcut(target.id).keys} />
                        </CommandShortcut>
                      </CommandItem>
                    ))}
                  {plans
                    .filter(
                      (plan) =>
                        !commandsOnly && !plan.archived && matches(plan.name),
                    )
                    .map((plan) => {
                      const counts = planCounts[plan.id];
                      return (
                        <CommandItem
                          key={plan.id}
                          value={`plan-${plan.id}`}
                          onSelect={() => run(() => openPlan?.(plan.id))}
                        >
                          <PlanIcon aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">
                            <CommandMatch text={plan.name} query={filter} />
                          </span>
                          <CommandShortcut>
                            Plan
                            {counts &&
                              ` · ${counts.done} of ${counts.todo + counts.in_progress + counts.in_review + counts.done} done`}
                          </CommandShortcut>
                        </CommandItem>
                      );
                    })}
                </CommandGroup>
              )}
              {!scope && (
                <CommandGroup heading="Create">
                  {(
                    [
                      {
                        id: "ticket",
                        label: "New ticket",
                        icon: SquarePen,
                        key: "new-ticket",
                      },
                      {
                        id: "capture",
                        label: "Capture a thought",
                        icon: NotebookPen,
                        key: "capture",
                      },
                      {
                        id: "chat",
                        label: "New Chat",
                        icon: MessageSquarePlus,
                      },
                      {
                        id: "plan",
                        label: "New Plan",
                        icon: Layers,
                        key: "new-plan",
                      },
                    ] as const
                  )
                    .filter((item) => matches(item.label))
                    .map((item) => (
                      <CommandItem
                        key={item.id}
                        value={`create-${item.id}`}
                        disabled={
                          !!createDisabledReason ||
                          (item.id === "chat" && !chatsEnabled)
                        }
                        onSelect={() => run(() => create(item.id))}
                      >
                        <item.icon aria-hidden="true" />
                        <span className="flex-1">
                          <CommandMatch text={item.label} query={filter} />
                        </span>
                        {createDisabledReason ? (
                          <CommandShortcut>
                            {createDisabledReason}
                          </CommandShortcut>
                        ) : "key" in item ? (
                          <CommandShortcut>
                            <KeyChords keys={shortcut(item.key).keys} />
                          </CommandShortcut>
                        ) : null}
                      </CommandItem>
                    ))}
                </CommandGroup>
              )}
              <CommandEmpty>
                {actions.error ||
                  search.error ||
                  "No tickets or destinations found."}
              </CommandEmpty>
            </CommandList>
            <div className="ui-palette-footer">
              {actions.error ? (
                <span role="alert">{actions.error}</span>
              ) : scope ? (
                <>
                  <span>
                    <Kbd>↵</Kbd> {scope === "Status" ? "Set status" : "Apply"}
                  </span>
                  <span>
                    <Kbd>⌫</Kbd> Back to actions
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <Kbd>↑↓</Kbd> Move
                  </span>
                  <span>
                    <Kbd>↵</Kbd> Run
                  </span>
                  <span>
                    <Kbd>⇥</Kbd> More actions
                  </span>
                  <span className="ml-auto">
                    Type T- for a reference, &gt; for commands
                  </span>
                </>
              )}
            </div>
          </Command>
        </DialogContent>
      </Dialog>
      {actions.duplicate && actions.ticket && (
        <Duplicates
          ticket={actions.ticket}
          refresh={refresh}
          open
          onOpenChange={actions.setDuplicate}
          title={`Mark ${actions.ticket.reference} as a duplicate`}
          description="Choose the canonical ticket and review what points at this ticket."
          returnFocus={returnFocus}
        />
      )}
      <ConfirmLeaveDuplicate
        canonical={actions.ticket?.duplicate_of ?? ""}
        status={actions.leaving}
        returnFocus={returnFocus}
        onCancel={() => actions.setLeaving(null)}
        onConfirm={(status) => {
          actions.setLeaving(null);
          void actions.apply(status, true);
        }}
      />
    </>
  );
}
