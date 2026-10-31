import { useEffect, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { client, type Project, type Ticket } from "@/lib/api/client";
import type { Effort } from "@/lib/api/efforts";
import "./properties.css";

type Choice = { value: string; label: string };
export function PropertyPicker({
  label,
  value,
  choices,
  disabled,
  onChoose,
  allowCreate = false,
  onSearch,
}: {
  label: string;
  value: string;
  choices: Choice[];
  disabled: boolean;
  onChoose: (value: string) => void;
  allowCreate?: boolean;
  onSearch?: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  function choose(next: string) {
    setOpen(false);
    setQuery("");
    onSearch?.("");
    onChoose(next);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`${label}: ${value}`}
        >
          {value}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="property-popover"
        aria-label={`${label} choices`}
      >
        <Command shouldFilter={!onSearch}>
          <CommandInput
            aria-label={`Search ${label}`}
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              onSearch?.(next);
            }}
          />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {choices.map((choice) => (
                <CommandItem
                  key={choice.value}
                  value={choice.label}
                  onSelect={() => choose(choice.value)}
                >
                  {choice.label}
                </CommandItem>
              ))}
              {allowCreate &&
                query.trim() &&
                !choices.some(
                  (choice) => choice.value === query.trim().toLowerCase(),
                ) && (
                  <CommandItem
                    value={`Add ${query}`}
                    onSelect={() => choose(query.trim())}
                  >
                    Add “{query.trim()}”
                  </CommandItem>
                )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function TicketProperties({
  ticket,
  projects,
  efforts,
  onSaved,
  refresh,
}: {
  ticket: Ticket;
  projects: Project[];
  efforts: Effort[];
  onSaved: (ticket: Ticket) => void;
  refresh: () => Promise<void>;
}) {
  const propertiesRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [vocabularyError, setVocabularyError] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void client
        .searchTags(tagQuery)
        .then((tags) => {
          if (active) {
            setVocabulary(tags);
            setVocabularyError("");
          }
        })
        .catch((reason: unknown) => {
          if (active)
            setVocabularyError(
              `Tag suggestions unavailable: ${String(reason)}. You can still enter a tag.`,
            );
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [tagQuery]);
  async function save(key: string, action: () => Promise<Ticket>) {
    const returnFocus =
      document.activeElement instanceof HTMLElement &&
      (document.activeElement.closest('[role="dialog"]') !== null ||
        document.activeElement.closest('[role="menu"]') !== null ||
        propertiesRef.current?.contains(document.activeElement));
    function restoreFocus() {
      if (!returnFocus) return;
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return;
        const selector =
          key === "Action"
            ? '[aria-label="Ticket actions"]'
            : key === "Status"
              ? '[aria-label="Status"]'
              : `[aria-label^="${key}:"]`;
        propertiesRef.current?.querySelector<HTMLElement>(selector)?.focus();
      });
    }
    setPending(key);
    setErrors((old) => ({ ...old, [key]: "" }));
    let updated: Ticket;
    try {
      updated = await action();
    } catch (reason) {
      setErrors((old) => ({
        ...old,
        [key]: `Could not save ${key.toLowerCase()}: ${String(reason)}`,
      }));
      setPending("");
      restoreFocus();
      return;
    }
    onSaved(updated);
    try {
      await refresh();
    } catch (reason) {
      setErrors((old) => ({
        ...old,
        [key]: `Saved, but refresh failed: ${String(reason)}`,
      }));
    } finally {
      setPending("");
      restoreFocus();
    }
  }
  const disabled = ticket.trashed || !!pending;
  const projectName =
    projects.find((p) => p.id === ticket.project_id)?.name ??
    (ticket.project_id || "Unlinked");
  const effort = efforts.find((e) => e.id === ticket.effort_id);
  const effortName = effort
    ? `${effort.name}${effort.archived ? " (archived)" : ""}`
    : ticket.effort_id || "No Effort";
  function property(label: string, control: React.ReactNode) {
    return (
      <div className="ticket-property">
        <span>{label}</span>
        {control}
        {pending === label && <small role="status">Saving…</small>}
        {errors[label] && <small role="alert">{errors[label]}</small>}
      </div>
    );
  }
  return (
    <div
      ref={propertiesRef}
      className="ticket-properties"
      aria-label="Ticket properties"
    >
      {property(
        "Status",
        <Select
          value={ticket.status}
          disabled={disabled}
          onValueChange={(status) =>
            void save("Status", () =>
              client.changeTicket(ticket.reference, { status }),
            )
          }
        >
          <SelectTrigger size="sm" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {["Todo", "In progress", "In review", "Done", "Canceled"].map(
                (status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ),
              )}
            </SelectGroup>
          </SelectContent>
        </Select>,
      )}
      {property(
        "Project",
        <PropertyPicker
          label="Project"
          value={projectName}
          disabled={disabled}
          choices={[
            { value: "", label: "Unlinked" },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChoose={(value) =>
            void save("Project", () =>
              client.changeTicket(ticket.reference, {
                project_id: value || null,
              }),
            )
          }
        />,
      )}
      {property(
        "Effort",
        <PropertyPicker
          label="Effort"
          value={effortName}
          disabled={disabled}
          choices={[
            { value: "", label: "No Effort" },
            ...efforts
              .filter((e) => !e.archived)
              .map((e) => ({ value: e.id, label: e.name })),
          ]}
          onChoose={(value) =>
            void save("Effort", () =>
              client.setEffort(ticket.reference, value || null),
            )
          }
        />,
      )}
      {property(
        "Tags",
        <PropertyPicker
          label="Tags"
          value={ticket.tags.length ? ticket.tags.join(", ") : "No tags"}
          disabled={disabled}
          allowCreate
          onSearch={setTagQuery}
          choices={[...new Set([...vocabulary, ...ticket.tags])].map((tag) => ({
            value: tag,
            label: ticket.tags.includes(tag) ? `✓ ${tag}` : tag,
          }))}
          onChoose={(tag) =>
            void save("Tags", () =>
              client.changeTag(
                ticket.tags.includes(tag) ? "remove_tag" : "add_tag",
                ticket.reference,
                tag,
              ),
            )
          }
        />,
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Ticket actions"
            disabled={!!pending}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={4}>
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={() =>
                void save("Action", () =>
                  client.setTrashed(ticket.reference, !ticket.trashed),
                )
              }
            >
              {ticket.trashed ? "Restore" : "Move to trash"}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {vocabularyError && !ticket.trashed && (
        <small role="status">{vocabularyError}</small>
      )}
      {pending === "Action" && <small role="status">Saving…</small>}
      {errors.Action && <small role="alert">{errors.Action}</small>}
    </div>
  );
}
