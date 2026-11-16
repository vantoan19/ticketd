import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Choice } from "@/components/ui/choice-list";
import { TicketPropertyChoices } from "./TicketCommandPicker";
import { client } from "@/lib/api/client";
import { Ban } from "lucide-react";
import { FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  shortcutLabel,
  matchesShortcut,
  type ShortcutId,
} from "@/lib/shortcuts";

/** An unpublished property: selecting a choice only changes the local draft. */
export function DraftPropertyPicker({
  label,
  display,
  icon,
  selected,
  options,
  disabled,
  onSelect,
  onCreate,
  shortcut,
  query,
  onQueryChange,
  notice,
  empty,
}: {
  notice?: ReactNode;
  empty?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  label: string;
  display: string;
  icon: ReactNode;
  selected: string | readonly string[];
  options: Choice[];
  disabled: boolean;
  onSelect: (value: string) => void;
  onCreate?: (value: string) => void;
  shortcut?: ShortcutId;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!shortcut || disabled) return;
    const handler = (event: KeyboardEvent) => {
      if (
        !matchesShortcut(event, shortcut) ||
        event.isComposing ||
        event.repeat
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable], [cmdk-root]")
      )
        return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcut, disabled]);

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <Tooltip
        content={label}
        {...(shortcut && { shortcut: shortcutLabel(shortcut) })}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="property"
            size="compact"
            disabled={disabled}
            aria-label={`${label}: ${typeof selected !== "string" && selected.length === 0 ? "none" : display}`}
          >
            {icon}
            <span className="min-w-0 truncate">{display}</span>
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="start"
        side="bottom"
        variant="constrained-list"
        aria-label={`${label} choices`}
      >
        <TicketPropertyChoices
          scope={label}
          {...(notice !== undefined && { notice })}
          {...(empty !== undefined && { empty })}
          {...(query !== undefined && { query })}
          {...(onQueryChange && { onQueryChange })}
          selected={selected}
          options={options}
          disabled={disabled}
          onSelect={(value) => {
            onSelect(value);
            if (typeof selected === "string") setOpen(false);
          }}
          {...(onCreate && { onCreate })}
        />
      </PopoverContent>
    </Popover>
  );
}

export function DraftBlockerPicker({
  values,
  disabled,
  onChange,
}: {
  values: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [tickets, setTickets] = useState<
    Awaited<ReturnType<typeof client.searchTickets>>
  >([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void client
        .searchTickets(query, "all", 0)
        .then((items) => {
          if (active) {
            setTickets(items);
            setLoading(false);
            setFailure(null);
          }
        })
        .catch((reason: unknown) => {
          if (active) {
            setLoading(false);
            setFailure(describeFailure(reason, "search blockers"));
          }
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, attempt]);
  return (
    <DraftPropertyPicker
      label="Blocked by"
      query={query}
      onQueryChange={(value) => {
        setLoading(true);
        setFailure(null);
        setQuery(value);
      }}
      empty={loading || failure ? "" : "No matches"}
      notice={
        failure ? (
          <FailureState
            size="inline"
            failure={failure}
            onRetry={() => {
              setLoading(true);
              setFailure(null);
              setAttempt((value) => value + 1);
            }}
          />
        ) : loading ? (
          <span role="status">Searching blockers…</span>
        ) : undefined
      }
      display={values.length ? values.join(", ") : "Blocked by"}
      icon={<Ban aria-hidden="true" />}
      selected={values}
      disabled={disabled}
      options={[
        ...tickets
          .filter((ticket) => !ticket.trashed)
          .map((ticket) => ({
            value: ticket.reference,
            reference: ticket.reference,
            label: ticket.title,
          })),
        ...values
          .filter(
            (value) =>
              !tickets.some(
                (ticket) => ticket.reference === value && !ticket.trashed,
              ),
          )
          .map((value) => ({
            value,
            reference: value,
            label: "Selected blocker",
          })),
      ]}
      onSelect={(value) =>
        onChange(
          values.includes(value)
            ? values.filter((item) => item !== value)
            : [...values, value],
        )
      }
    />
  );
}
