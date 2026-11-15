import { useLinkedChats, useChatFeature } from "@/features/chats/use-chats";
import { statusLabel } from "@/features/chats/model";
import { ReminderDateTime } from "@/features/tickets/ReminderDateTime";
import { localInstants, localValue } from "@/features/tickets/reminder-time";
import { reminderPresets } from "@/features/tickets/reminder-presets";
import { Button } from "@/components/ui/button";
import {
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
import { useRef, useState, type RefObject } from "react";
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
import { shortcut, type ShortcutId } from "@/lib/shortcuts";
import { useTicketSearch } from "@/features/tickets/useTicketSearch";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { GoTo } from "./use-command-keys";

const targets = [
  { id: "inbox", label: "Inbox", icon: Inbox, key: "go-inbox" },
  { id: "all", label: "All tickets", icon: ListTodo, key: "go-all" },
  { id: "ready", label: "Ready", icon: CircleCheck, key: "go-ready" },
  { id: "chats", label: "Chats", icon: MessagesSquare, key: "go-chats" },
  { id: "documents", label: "Documents", icon: Files, key: "go-documents" },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "plans", label: "Plans", icon: Layers },
  { id: "settings", label: "Settings", icon: Settings, key: "go-settings" },
  { id: "trash", label: "Trash", icon: Trash2, key: "go-trash" },
] satisfies { id: GoTo; label: string; icon: typeof Inbox; key?: ShortcutId }[];

export function CommandPalette({
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
  create: (kind: "ticket" | "capture" | "chat") => void;
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
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const instants = localInstants(draft);
  const input = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<TicketCommandScope | null>(null);
  const commandsOnly = query.trimStart().startsWith(">");
  const filter = commandsOnly ? query.trimStart().slice(1).trim() : query;
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
                (actions.options.find((option) => option.selected)?.value ||
                  actions.options[0]?.value ||
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
            {actions.error && (
              <p role="alert" className="px-4 py-2 text-sm">
                {actions.error}
              </p>
            )}
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
                    .filter((action) =>
                      action.label
                        .toLowerCase()
                        .includes(filter.trim().toLowerCase()),
                    )
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
                          <span className="flex-1">{action.label}</span>
                          <CommandShortcut>
                            {value} <KeyChords keys={keys.keys} />
                          </CommandShortcut>
                        </CommandItem>
                      );
                    })}
                  {linkedChats?.chats
                    .filter((item) =>
                      `open chat ${item.title}`
                        .toLowerCase()
                        .includes(filter.trim().toLowerCase()),
                    )
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
                  {"copy reference".includes(filter.trim().toLowerCase()) && (
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
                  {search.results.map((result) => (
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
                    ] as const
                  )
                    .filter((item) =>
                      item.label
                        .toLowerCase()
                        .includes(filter.trim().toLowerCase()),
                    )
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
                        <span className="flex-1">{item.label}</span>
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
              {!scope && (
                <CommandGroup heading="Go to">
                  {targets
                    .filter((target) =>
                      target.label
                        .toLowerCase()
                        .includes(filter.trim().toLowerCase()),
                    )
                    .map((target) => {
                      const keys =
                        "key" in target ? shortcut(target.key) : null;
                      return (
                        <CommandItem
                          key={target.id}
                          value={target.id}
                          disabled={target.id === "chats" && !chatsEnabled}
                          onSelect={() => run(() => go(target.id))}
                        >
                          <target.icon aria-hidden="true" />
                          <span className="flex-1">
                            <CommandMatch text={target.label} query={filter} />
                          </span>
                          {target.id === "chats" && !chatsEnabled && (
                            <CommandShortcut>Chat is off</CommandShortcut>
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
                </CommandGroup>
              )}
              <CommandEmpty>
                {actions.error ||
                  search.error ||
                  "No tickets or destinations found."}
              </CommandEmpty>
            </CommandList>
            <div className="ui-palette-footer">
              {scope ? (
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
