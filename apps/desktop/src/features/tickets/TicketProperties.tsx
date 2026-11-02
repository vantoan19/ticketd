import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Folder, Layers, Tag, type LucideIcon } from "lucide-react";
import { SourceRail } from "./SourceRail";
import {
  duplicateTargetText,
  externalDuplicateTarget,
  externalSource,
} from "./ticket-source";
import { Button } from "@/components/ui/button";
import { RailSection } from "./RailSection";
import { ticketStatuses } from "@/lib/statuses";
import { StatusIcon } from "./StatusIcon";
import { Duplicates } from "./Duplicates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  compact = false,
  readOnly = false,
  icon: Icon,
  align = "start",
}: {
  label: string;
  /** Which edge of the trigger the choices line up with. */
  align?: "start" | "end";
  compact?: boolean;
  readOnly?: boolean;
  icon?: LucideIcon;
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
          variant={compact ? "ghost" : "outline"}
          size="sm"
          readOnly={readOnly}
          disabled={disabled}
          aria-label={`${label}: ${value}`}
        >
          {Icon && <Icon data-icon="inline-start" />}
          <span className="truncate">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
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
  onOpenTicket,
  children,
}: {
  ticket: Ticket;
  projects: Project[];
  efforts: Effort[];
  onSaved: (ticket: Ticket) => void;
  refresh: () => Promise<void>;
  /** Sections that follow Tags in the rail, such as Relationships and Attention. */
  children?: ReactNode;
  /** Opens another ticket, such as the canonical ticket of a duplicate. */
  onOpenTicket?: (reference: string) => void;
}) {
  const propertiesRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState("");
  const [duplicateOpen, setDuplicateOpen] = useState(false);
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
        const selector = `[aria-label^="${key}:"]`;
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
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const disabled = ticket.trashed || !!pending;
  const owner = externalSource(ticket);
  const ownerName = owner ? owner.provider_name : "";
  // While the issue is open its Todo, In progress and In review are local;
  // closing states follow the source and cannot be chosen here.
  const statusLocked = Boolean(owner?.status_locked);
  const target = externalDuplicateTarget(ticket);
  const resolvedTarget = target?.kind === "external" ? target.ticket : null;
  // The core says which statuses may be chosen; the current one is always shown.
  const statusChoices = owner
    ? [...new Set([ticket.status, ...owner.status_choices])]
    : ticketStatuses;
  const projectName =
    projects.find((p) => p.id === ticket.project_id)?.name ??
    (ticket.project_id || "Unlinked");
  const effort = efforts.find((e) => e.id === ticket.effort_id);
  const effortName = effort
    ? `${effort.name}${effort.archived ? " (archived)" : ""}`
    : ticket.effort_id || "No Effort";
  function property(label: string, control: ReactNode) {
    return (
      <RailSection label={label}>
        {control}
        {pending === label && <small role="status">Saving…</small>}
        {errors[label] && <small role="alert">{errors[label]}</small>}
      </RailSection>
    );
  }
  return (
    <aside
      ref={propertiesRef}
      className="ticket-properties"
      data-trashed={ticket.trashed || undefined}
      aria-label="Ticket properties"
    >
      {property(
        "Status",
        <>
          <Select
            value={ticket.status}
            disabled={disabled || statusLocked}
            onValueChange={(status) => {
              if (status === ticket.status) return;
              // Duplicate needs a canonical ticket, so it opens the review.
              if (status === "Duplicate") {
                setDuplicateOpen(true);
                return;
              }
              void save("Status", () =>
                client.changeTicket(ticket.reference, { status }),
              );
            }}
          >
            <SelectTrigger
              ref={statusTrigger}
              size="sm"
              variant="ghost"
              readOnly={ticket.trashed}
              aria-label={`Status: ${ticket.status}`}
              title="Status"
            >
              <StatusIcon status={ticket.status} decorative />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {statusChoices.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* The canonical link belongs beside the status, trashed or not. */}
          {ticket.duplicate_of && (
            <Button
              variant="link"
              size="sm"
              className="duplicate-of-link"
              onClick={() => onOpenTicket?.(ticket.duplicate_of!)}
            >
              Duplicate of {ticket.duplicate_of}
            </Button>
          )}
          {target && <small>{duplicateTargetText(target)}</small>}
          {resolvedTarget && (
            <Button
              variant="link"
              size="sm"
              className="duplicate-of-link"
              onClick={() => onOpenTicket?.(resolvedTarget)}
            >
              Open {resolvedTarget}
            </Button>
          )}
          {owner && (
            <small className="rail-note">
              {owner.closure_unrecognized
                ? `${ownerName} closed this issue with a reason ticketd does not recognize, so its status was not changed. Choose Done or Canceled here, or reopen it there.`
                : owner.status_locked
                  ? `Closed on ${ownerName}. Reopen it there to return this ticket to Todo.`
                  : `Progress is kept in ticketd and never sent to ${ownerName}. Closing follows ${ownerName}.`}
            </small>
          )}
        </>,
      )}
      <Dialog open={duplicateOpen} onOpenChange={setDuplicateOpen}>
        <DialogContent
          className="duplicate-dialog"
          onCloseAutoFocus={(event) => {
            // The Status choice that opened this unmounts with its menu, so
            // focus returns to the Status control explicitly.
            event.preventDefault();
            statusTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark as duplicate</DialogTitle>
            <DialogDescription>
              Choose the canonical ticket for {ticket.reference} and review its
              dependencies.
            </DialogDescription>
          </DialogHeader>
          <Duplicates
            ticket={ticket}
            refresh={refresh}
            onDone={() => setDuplicateOpen(false)}
            onCancel={() => setDuplicateOpen(false)}
          />
        </DialogContent>
      </Dialog>
      <SourceRail ticket={ticket} refresh={refresh} />
      {property(
        "Project",
        <PropertyPicker
          compact
          align="end"
          readOnly={ticket.trashed}
          icon={Folder}
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
          compact
          align="end"
          readOnly={ticket.trashed}
          icon={Layers}
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
          compact
          align="end"
          readOnly={ticket.trashed}
          icon={Tag}
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
      {vocabularyError && !ticket.trashed && (
        <small role="status">{vocabularyError}</small>
      )}
      {children}
    </aside>
  );
}
