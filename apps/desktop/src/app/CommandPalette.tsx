import { useRef, useState, type RefObject } from "react";
import {
  Inbox,
  ListTodo,
  CircleCheck,
  MessagesSquare,
  Files,
  Layers,
  Settings,
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
  { id: "plans", label: "Plans", icon: Layers },
  { id: "settings", label: "Settings", icon: Settings },
] satisfies { id: GoTo; label: string; icon: typeof Inbox; key?: ShortcutId }[];

export function CommandPalette({
  open,
  onOpenChange,
  go,
  ticket,
  chatsEnabled,
  returnFocus,
}: {
  returnFocus: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  go: (target: GoTo) => void;
  ticket: (reference: string) => void;
  chatsEnabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const navigated = useRef(false);
  const search = useTicketSearch(query, open, () => true);
  const run = (action: () => void) => {
    navigated.current = true;
    onOpenChange(false);
    action();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="palette"
        returnFocus={returnFocus}
        variant="flush"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          navigated.current = false;
          setQuery("");
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (navigated.current) {
            event.preventDefault();
            document.getElementById("main-content")?.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Go anywhere</DialogTitle>
        <DialogDescription className="sr-only">
          Find a Ticket or open a view.
        </DialogDescription>
        <Command
          variant="palette"
          label="Search tickets and destinations"
          shouldFilter={false}
        >
          <CommandInput
            escapeHint
            ref={input}
            value={query}
            onValueChange={setQuery}
            aria-label="Search tickets and destinations"
            placeholder="Search tickets and go anywhere…"
          />
          <CommandList>
            {query.trim() && (
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
            <CommandGroup heading="Go to">
              {targets
                .filter((target) =>
                  target.label
                    .toLowerCase()
                    .includes(query.trim().toLowerCase()),
                )
                .map((target) => {
                  const keys = "key" in target ? shortcut(target.key) : null;
                  return (
                    <CommandItem
                      key={target.id}
                      value={target.id}
                      disabled={target.id === "chats" && !chatsEnabled}
                      onSelect={() => run(() => go(target.id))}
                    >
                      <target.icon aria-hidden="true" />
                      <span className="flex-1">
                        <CommandMatch text={target.label} query={query} />
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
            <CommandEmpty>
              {search.error || "No tickets or destinations found."}
            </CommandEmpty>
          </CommandList>
          <div className="ui-palette-footer">
            <span>
              <Kbd>↑↓</Kbd> Move
            </span>
            <span>
              <Kbd>↵</Kbd> Open
            </span>
            <span className="ml-auto">Search by title or reference</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
