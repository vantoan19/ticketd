import { useId, useState } from "react";
import { X } from "lucide-react";
import { cn } from "cn";

/**
 * A text field that turns typed values into removable tokens. Enter or comma
 * adds the draft (duplicates, ignoring case, and blanks are ignored); Backspace on an empty
 * draft removes the last token; each token has its own named remove button.
 * The caller owns `values`.
 */
export function TokenField({
  values,
  onChange,
  label,
  placeholder,
  suggestions = [],
  className,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  /** Accessible name of the text input. */
  label: string;
  placeholder?: string;
  /** Existing values offered in a dropdown under the field while it has focus. */
  suggestions?: string[];
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const needle = draft.trim().toLowerCase();
  const offered = suggestions.filter(
    (tag) =>
      !values.some((v) => v.toLowerCase() === tag.toLowerCase()) &&
      tag.toLowerCase().includes(needle),
  );
  const open = focused && offered.length > 0;
  const current = open && active >= 0 ? offered[active] : undefined;
  function pick(value: string) {
    setDraft("");
    setActive(-1);
    onChange([...values, value]);
  }
  function commit() {
    const value = draft.trim();
    setDraft("");
    setActive(-1);
    if (value && !values.some((v) => v.toLowerCase() === value.toLowerCase()))
      onChange([...values, value]);
  }
  return (
    <div
      data-slot="token-field"
      className={cn(
        "ui-input relative flex min-h-10 flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:outline focus-within:outline-1 focus-within:outline-(--input-focus)",
        className,
      )}
    >
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex h-6 items-center gap-1 rounded-md bg-(--recessed) pr-1 pl-2 text-xs shadow-(--shadow-border-base)"
        >
          {value}
          <button
            type="button"
            aria-label={`Remove ${value}`}
            className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onChange(values.filter((v) => v !== value))}
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={draft}
        {...(values.length === 0 && placeholder ? { placeholder } : {})}
        className="h-6 min-w-24 flex-1 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:outline-none"
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={current ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setActive(-1);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          // An IME confirming a candidate also sends Enter or a comma.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "ArrowDown" && open) {
            e.preventDefault();
            setActive((active + 1) % offered.length);
          } else if (e.key === "ArrowUp" && open) {
            e.preventDefault();
            setActive((active - 1 + offered.length) % offered.length);
          } else if (e.key === "Enter" && current) {
            e.preventDefault();
            pick(current);
          } else if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length)
            onChange(values.slice(0, -1));
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="absolute top-full right-0 left-0 z-10 mt-1 flex max-h-48 flex-col overflow-auto rounded-md bg-popover p-1 text-sm shadow-(--shadow-border-base)"
        >
          {offered.map((tag, index) => (
            <li
              key={tag}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className="cursor-default rounded-sm px-2 py-1.5 aria-selected:bg-accent hover:bg-accent"
              // Keeps focus in the input, whose blur would commit the draft.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(tag)}
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
