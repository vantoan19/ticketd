import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "cn";

/**
 * A text field that turns typed values into removable tokens. Enter or comma
 * adds the draft (duplicates and blanks are ignored); Backspace on an empty
 * draft removes the last token; each token has its own named remove button.
 * The caller owns `values`.
 */
export function TokenField({
  values,
  onChange,
  label,
  placeholder,
  className,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  /** Accessible name of the text input. */
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  function commit() {
    const value = draft.trim();
    setDraft("");
    if (value && !values.includes(value)) onChange([...values, value]);
  }
  return (
    <div
      data-slot="token-field"
      className={cn(
        "ui-input flex min-h-10 flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:outline focus-within:outline-1 focus-within:outline-(--input-focus)",
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
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length)
            onChange(values.slice(0, -1));
        }}
      />
    </div>
  );
}
