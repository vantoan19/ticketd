import { useState, type ReactNode } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Reference } from "@/components/ui/reference";

/** One row of a ChoiceList. */
export type Choice = {
  value: string;
  /** The words; also what the search matches. */
  label: string;
  /** A 16px icon. Give every row of a list one, or none. */
  icon?: ReactNode;
  /** A mono reference before the label (T-FV10). */
  reference?: string;
  /** Trailing 12/16 muted meta or a Kbd, before the check. */
  meta?: ReactNode;
  disabled?: boolean;
  /** Why a disabled row is unavailable; a 12/16 line under the label. */
  reason?: string;
};

/** A titled group of rows ("Linked to this ticket", "Recent"). */
export type ChoiceGroup = { heading?: string; choices: Choice[] };

/**
 * The one choice-list anatomy (DESIGN.md section 11, P3) for every searchable
 * list in a popover or a dialog: an optional 32px search row, 32px rows (36px
 * with `size="tall"` for ticket and record pickers) of [icon] [reference]
 * label · meta · trailing check, a quiet "No matches" row, and an optional
 * "Create “x”" last row.
 *
 * - `selected`: the current value (single choice) or values (multi, such as
 *   tags). Current rows wear a trailing check and the list opens with the
 *   current single value highlighted, so Enter never clears it by accident.
 * - `clear`: the clearing choice ("No project"), drawn last after a separator.
 * - `onQueryChange`: the caller searches (an async picker) and passes the
 *   results in `groups`; without it the list filters its own rows by label.
 * - `rows`: a fixed list height in rows, so results never resize the overlay;
 *   otherwise the list grows up to 320px and then scrolls.
 *
 * Put it in a PopoverContent (a choice list) or a dialog body (a picker).
 */
export function ChoiceList({
  label,
  groups,
  selected,
  onSelect,
  clear,
  searchPlaceholder,
  query: controlledQuery,
  onQueryChange,
  create,
  empty = "No matches",
  notice,
  size = "default",
  rows,
  autoFocus = true,
}: {
  /** Names the list for assistive technology ("Project choices"). */
  label: string;
  groups: ChoiceGroup[] | Choice[];
  selected?: string | readonly string[];
  onSelect: (value: string) => void;
  clear?: Choice;
  /** Shows the search row: "Search {things} by title or reference". */
  searchPlaceholder?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Offers "Create “x”" as the last row while the query matches no label. */
  create?: (query: string) => void;
  /** The empty row's words, or a function of the query ("No tickets match “x”"). */
  empty?: string | ((query: string) => string);
  /** A row-sized line above the rows (a search failure, "Searching…"). */
  notice?: ReactNode;
  size?: "default" | "tall";
  rows?: number;
  autoFocus?: boolean;
}) {
  const [ownQuery, setOwnQuery] = useState("");
  const query = controlledQuery ?? ownQuery;
  const sets: ChoiceGroup[] =
    groups.length > 0 && "choices" in (groups[0] as object)
      ? (groups as ChoiceGroup[])
      : [{ choices: groups as Choice[] }];
  const chosen = (value: string) =>
    typeof selected === "string"
      ? selected === value
      : (selected?.includes(value) ?? false);
  const marks = selected !== undefined;
  const typed = query.trim();
  const exists = sets.some((set) =>
    set.choices.some(
      (choice) => choice.label.toLowerCase() === typed.toLowerCase(),
    ),
  );
  const row = (choice: Choice) => (
    <CommandItem
      key={choice.value}
      value={choice.value}
      keywords={[choice.label, choice.reference ?? ""]}
      size={size}
      disabled={choice.disabled ?? false}
      onSelect={() => onSelect(choice.value)}
      {...(marks && { "aria-checked": chosen(choice.value) })}
    >
      {choice.icon}
      {choice.reference && <Reference>{choice.reference}</Reference>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{choice.label}</span>
        {choice.reason && (
          <span className="text-xs text-muted-foreground">{choice.reason}</span>
        )}
      </span>
      {choice.meta && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {choice.meta}
        </span>
      )}
      {marks && (
        <CheckIcon
          aria-hidden="true"
          className={chosen(choice.value) ? "text-foreground" : "invisible"}
        />
      )}
    </CommandItem>
  );
  const current = typeof selected === "string" ? selected : undefined;
  return (
    <Command
      label={label}
      // Search matches the words and the reference, never an internal ID.
      filter={(_value, search, keywords) =>
        (keywords ?? []).some((word) =>
          word.toLowerCase().includes(search.trim().toLowerCase()),
        )
          ? 1
          : 0
      }
      shouldFilter={!onQueryChange}
      {...(current !== undefined && { defaultValue: current })}
    >
      {searchPlaceholder && (
        <CommandInput
          aria-label={searchPlaceholder}
          placeholder={searchPlaceholder}
          autoFocus={autoFocus}
          value={query}
          onValueChange={(next) => {
            setOwnQuery(next);
            onQueryChange?.(next);
          }}
        />
      )}
      <CommandList
        {...(rows && {
          style: { height: rows * (size === "tall" ? 36 : 32) + 8 },
        })}
      >
        {notice && (
          <div className="flex min-h-8 items-center px-2 text-xs text-muted-foreground">
            {notice}
          </div>
        )}
        <CommandEmpty>
          {typeof empty === "function" ? empty(typed) : empty}
        </CommandEmpty>
        {sets.map((set, index) =>
          set.choices.length === 0 ? null : (
            <CommandGroup
              key={set.heading ?? index}
              {...(set.heading && { heading: set.heading })}
            >
              {set.choices.map(row)}
            </CommandGroup>
          ),
        )}
        {create && typed && !exists && (
          <CommandGroup forceMount>
            <CommandItem
              forceMount
              value={`create:${typed}`}
              size={size}
              onSelect={() => create(typed)}
            >
              <PlusIcon aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Create “{typed}”</span>
            </CommandItem>
          </CommandGroup>
        )}
        {clear && (
          <>
            <CommandSeparator />
            <CommandGroup>{row(clear)}</CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
