import { useReminderTime } from "./use-reminder-time";
import "./properties.css";
import { useRef, useState, type ReactNode } from "react";
import { ChoiceList, type Choice } from "@/components/ui/choice-list";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTicketCommands } from "@/app/use-ticket-commands";
import type { TicketCommandScope } from "@/lib/ticket-command-actions";
import type { Project, Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { StatusIcon } from "./StatusIcon";
import { Duplicates } from "./Duplicates";
import { ConfirmLeaveDuplicate } from "./ConfirmLeaveDuplicate";
import { ReminderDateTime } from "./ReminderDateTime";
import { localValue } from "./reminder-time";
import { reminderPresets } from "./reminder-presets";

/** Chip and palette share the same options, mutation, safeguards and Undo controller. */
export function TicketCommandPicker({
  ticket,
  projects,
  plans,
  refresh,
  scope,
  trigger,
  open: controlledOpen,
  onOpenChange,
  anchorOnly = false,
}: {
  ticket: Ticket;
  projects: Project[];
  plans: Plan[];
  refresh: () => Promise<void>;
  scope: TicketCommandScope;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorOnly?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  function setOpen(next: boolean) {
    setOwnOpen(next);
    onOpenChange?.(next);
    if (!next) {
      setQuery("");
      setCustom(false);
    }
  }
  const actions = useTicketCommands({
    reference: ticket.reference,
    initialTicket: ticket,
    open,
    scope,
    query,
    projects,
    plans,
    close: () => setOpen(false),
    refresh,
  });
  const time = useReminderTime(draft, occurrence);
  const instants = time.instants;
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
    } else void actions.apply(value);
  }
  const selected =
    scope === "Status"
      ? ticket.status
      : scope === "Project"
        ? (ticket.project_id ?? "")
        : scope === "Plan"
          ? (ticket.plan_id ?? "")
          : scope === "Tags"
            ? ticket.tags
            : undefined;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <span
          ref={(element) => {
            returnFocus.current = element?.querySelector("button") ?? null;
          }}
          className="ticket-command-anchor"
        >
          {anchorOnly ? (
            <PopoverAnchor asChild>
              <span>{trigger}</span>
            </PopoverAnchor>
          ) : (
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          )}
        </span>
        <PopoverContent
          variant="constrained-list"
          align="start"
          aria-label={`${scope} choices`}
          onFocusOutside={(event) => {
            const target = event.detail.originalEvent.target;
            if (
              anchorOnly &&
              target instanceof Element &&
              target.closest('[role="menu"]')
            )
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus({ preventScroll: true });
          }}
        >
          <span className="sr-only" role="status">
            {scope} of {ticket.reference}
          </span>
          {custom ? (
            <div className="ticket-command-custom">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCustom(false)}
              >
                Back to reminders
              </Button>
              <ReminderDateTime
                reference={ticket.reference}
                draft={draft}
                occurrence={occurrence}
                pending={actions.pending || actions.blocked}
                past={time.past}
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
                  time.past ||
                  instants.length === 0 ||
                  (instants.length > 1 && !occurrence)
                }
                onClick={() => {
                  const selected = time.selectForSubmit();
                  if (selected) void actions.apply("custom", false, selected);
                }}
              >
                Set reminder
              </Button>
            </div>
          ) : (
            <TicketPropertyChoices
              scope={scope}
              selected={selected ?? []}
              disabled={actions.pending || actions.blocked}
              options={actions.options.map((option) => ({
                ...option,
                ...(scope === "Status" && {
                  icon: <StatusIcon status={option.value} decorative />,
                }),
              }))}
              onSelect={choose}
              query={query}
              onQueryChange={setQuery}
              {...(actions.projectHint && {
                empty: (
                  <span>
                    No matches
                    <span className="block text-xs">{actions.projectHint}</span>
                  </span>
                ),
              })}
            />
          )}
          {actions.error && (
            <div className="ticket-command-custom">
              <span role="alert">{actions.error}</span>
              {actions.retry && (
                <Button
                  variant="link"
                  size="xs"
                  disabled={actions.pending || actions.blocked}
                  onClick={actions.retry}
                >
                  Retry
                </Button>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {actions.duplicate && (
        <Duplicates
          ticket={ticket}
          refresh={refresh}
          open
          onOpenChange={actions.setDuplicate}
          title={`Mark ${ticket.reference} as a duplicate`}
          description="Choose the canonical ticket and review what points at this ticket."
          returnFocus={returnFocus}
        />
      )}
      <ConfirmLeaveDuplicate
        canonical={ticket.duplicate_of ?? ""}
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

/** Shared choice presentation for persisted ticket properties and unpublished drafts. */
export function TicketPropertyChoices({
  scope,
  options,
  selected,
  disabled = false,
  onSelect,
  onCreate,
  query,
  onQueryChange,
  notice,
  empty,
}: {
  notice?: ReactNode;
  empty?: ReactNode;
  query?: string;
  onQueryChange?: (query: string) => void;
  scope: string;
  options: Choice[];
  selected: string | readonly string[];
  disabled?: boolean;
  onSelect: (value: string) => void;
  onCreate?: (value: string) => void;
}) {
  const clear = options.find((option) => option.value === "");
  return (
    <ChoiceList
      label={`${scope} choices`}
      {...(notice !== undefined && { notice })}
      {...(empty !== undefined && { empty })}
      searchPlaceholder={`Search ${scope.toLowerCase()}…`}
      selected={selected}
      {...(query !== undefined && { query })}
      {...(onQueryChange && { onQueryChange })}
      groups={options
        .filter((option) => option.value !== "")
        .map((option) => ({
          ...option,
          disabled: disabled || (option.disabled ?? false),
        }))}
      {...(clear && { clear: { ...clear, disabled } })}
      {...(onCreate && { create: onCreate })}
      onSelect={onSelect}
    />
  );
}
