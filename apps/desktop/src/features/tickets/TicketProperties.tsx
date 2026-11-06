import { LatestUpdate } from "./LatestUpdate";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Folder,
  Layers,
  Lock,
  Tag,
  Trash2,
  type LucideIcon,
} from "lucide-react";
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
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { client, type Project, type Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
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
  plans,
  onSaved,
  refresh,
  onOpenTicket,
  onOpenNote,
  children,
  active = true,
  revision = 0,
}: {
  active?: boolean;
  revision?: number;
  ticket: Ticket;
  projects: Project[];
  plans: Plan[];
  onSaved: (ticket: Ticket) => void;
  refresh: () => Promise<void>;
  /** Sections that follow Tags in the rail, such as Relationships and Attention. */
  children?: ReactNode;
  onOpenNote?: (id: string) => void;
  /** Opens another ticket, such as the canonical ticket of a duplicate. */
  onOpenTicket?: (reference: string) => void;
}) {
  const propertiesRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState("");
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  // Leaving Duplicate drops its link, so the chosen status waits for a yes.
  const [leaving, setLeaving] = useState<string | null>(null);
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

  const target = externalDuplicateTarget(ticket);
  const resolvedTarget = target?.kind === "external" ? target.ticket : null;
  // The core says which statuses may be chosen; the current one is always shown.
  const statusChoices = owner ? owner.status_choices : ticketStatuses;
  const projectName =
    projects.find((p) => p.id === ticket.project_id)?.name ??
    (ticket.project_id || "No project");
  const plan = plans.find((e) => e.id === ticket.plan_id);
  const planName = plan
    ? `${plan.name}${plan.archived ? " (archived)" : ""}`
    : ticket.plan_id || "No Plan";
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
      {ticket.trashed && (
        <p role="note" className="rail-trash-note">
          <Trash2 aria-hidden="true" />
          <span>In Trash. Restore it to edit; its relationships are kept.</span>
          <Lock aria-label="Locked while in Trash" role="img" />
        </p>
      )}
      {property(
        "Status",
        <>
          <Select
            value={ticket.status}
            disabled={disabled}
            onValueChange={(status) => {
              if (status === ticket.status) return;
              // Duplicate needs a canonical ticket, so it opens the review.
              if (status === "Duplicate") {
                setDuplicateOpen(true);
                return;
              }
              if (ticket.status === "Duplicate" && ticket.duplicate_of) {
                setLeaving(status);
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
              <SelectValue>{ticket.status}</SelectValue>
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="end"
              className="status-menu"
              sideOffset={4}
            >
              <SelectGroup>
                {ticketStatuses
                  .filter((status) => !owner || statusChoices.includes(status))
                  .filter((status) => owner || status !== "Duplicate")
                  .map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
              </SelectGroup>
              {owner &&
                ticketStatuses.some(
                  (status) => !statusChoices.includes(status),
                ) && (
                  <>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>
                        {owner.closure_unrecognized
                          ? `The closure reason on ${ownerName} is unknown`
                          : owner.status_locked
                            ? `Closed on ${ownerName}`
                            : `Set by ${ownerName} when the issue closes`}
                      </SelectLabel>
                      {ticketStatuses
                        .filter((status) => !statusChoices.includes(status))
                        .map((status) => (
                          <SelectItem key={status} value={status} disabled>
                            {status}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                    <p className="status-menu-caption">
                      {owner.closure_unrecognized
                        ? `Choose Done or Canceled here, or reopen it on ${ownerName}.`
                        : owner.status_locked
                          ? `Reopen it on ${ownerName} to work on it again; it comes back as Todo.`
                          : `Done, Canceled and Duplicate follow ${ownerName} when the issue closes.`}
                    </p>
                  </>
                )}
              {!owner && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectItem value="Duplicate">
                      Mark as duplicate…
                    </SelectItem>
                  </SelectGroup>
                </>
              )}
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
          {target && target.kind !== "unknown" && (
            <small>{duplicateTargetText(target)}</small>
          )}
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
                  : `Your progress, kept in ticketd. ${ownerName} ${owner.unavailable ? "showed Open at the last sync" : "still shows Open"}.`}
            </small>
          )}
        </>,
      )}
      {(ticket.status === "In progress" || ticket.status === "In review") && (
        <LatestUpdate
          reference={ticket.reference}
          active={active}
          revision={revision}
          onOpen={onOpenNote}
        />
      )}
      <Dialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            statusTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove the duplicate link?</DialogTitle>
            <DialogDescription>
              This removes the duplicate link to {ticket.duplicate_of}.
              Continue?
            </DialogDescription>
          </DialogHeader>
          <div className="settings-actions">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const status = leaving;
                setLeaving(null);
                if (status)
                  void save("Status", () =>
                    client.changeTicket(ticket.reference, { status }),
                  );
              }}
            >
              Change status
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLeaving(null)}
            >
              Keep duplicate
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {duplicateOpen && (
        <Duplicates
          ticket={ticket}
          refresh={refresh}
          open
          onOpenChange={setDuplicateOpen}
          title={`Mark ${ticket.reference} as a duplicate`}
          description={`${ticket.reference} keeps its description and history and becomes Duplicate. Review what points at it.`}
          returnFocus={statusTrigger}
        />
      )}
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
            { value: "", label: "No project" },
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
        "Plan",
        <PropertyPicker
          compact
          align="end"
          readOnly={ticket.trashed}
          icon={Layers}
          label="Plan"
          value={planName}
          disabled={disabled}
          choices={[
            { value: "", label: "No Plan" },
            ...plans
              .filter((e) => !e.archived)
              .map((e) => ({ value: e.id, label: e.name })),
          ]}
          onChoose={(value) =>
            void save("Plan", () =>
              client.setPlan(ticket.reference, value || null),
            )
          }
        />,
      )}
      {property(
        "Tags",
        <>
          <div className="rail-tags">
            {ticket.tags.map((tag) => (
              <span className="rail-tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
          {ticket.trashed ? (
            !ticket.tags.length && <span className="rail-none">No tags</span>
          ) : (
            <PropertyPicker
              compact
              align="end"
              icon={Tag}
              label="Tags"
              value={ticket.tags.length ? "Edit tags" : "Add tags"}
              disabled={disabled}
              allowCreate
              onSearch={setTagQuery}
              choices={[...new Set([...vocabulary, ...ticket.tags])].map(
                (tag) => ({
                  value: tag,
                  label: ticket.tags.includes(tag) ? `✓ ${tag}` : tag,
                }),
              )}
              onChoose={(tag) =>
                void save("Tags", () =>
                  client.changeTag(
                    ticket.tags.includes(tag) ? "remove_tag" : "add_tag",
                    ticket.reference,
                    tag,
                  ),
                )
              }
            />
          )}
        </>,
      )}
      {vocabularyError && !ticket.trashed && (
        <small role="status">{vocabularyError}</small>
      )}
      {children}
    </aside>
  );
}
