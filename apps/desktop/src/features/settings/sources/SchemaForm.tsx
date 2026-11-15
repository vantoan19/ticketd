import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { failureText } from "@/lib/api/describe-failure";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { ChoiceOption, SchemaField } from "@/lib/api/sources";
import type { Draft } from "@/features/settings/sources/config-values";

const SUGGESTION_DELAY_MS = 250;
/** Announces which field opened its suggestions, so the others close. */
const OPENED = "ticketd:suggestions-opened";

type MultiSelect = Extract<SchemaField, { type: "multi_select" }>;

/** The core's `owner_name` rule: two parts of letters, digits, ".", "_" or "-". */
const OWNER_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** Why typed text cannot be added to the field, or "" when it can. */
function formatProblem(field: MultiSelect, text: string) {
  if (field.format === "owner_name" && !OWNER_NAME.test(text))
    return "Use owner/name, for example acme/billing-api.";
  return "";
}

/** Loads dynamic options for a field from the connector, given what was typed. */
export type LoadOptions = (
  field: string,
  query: string,
) => Promise<ChoiceOption[]>;

function FieldNote({
  id,
  field,
  errors,
  pending = "",
  refused = "",
}: {
  id: string;
  field: SchemaField;
  errors: string[];
  /** Text typed into a selector but not yet added to it. */
  pending?: string;
  /** Why Enter did not add the typed text; it replaces the other messages. */
  refused?: string;
}) {
  const messages = fieldMessages(field, errors, pending, refused);
  return (
    <>
      {field.help && (
        <p className="source-field-note" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {/* At the field it describes, never a summary elsewhere (set SR-05). */}
      {messages.length > 0 && (
        <FieldError id={`${id}-error`}>{messages.join(" ")}</FieldError>
      )}
    </>
  );
}

/** What is wrong with the field, in the order it should be fixed. */
function fieldMessages(
  field: SchemaField,
  errors: string[],
  pending: string,
  refused: string,
) {
  if (refused) return [refused];
  const text = pending.trim();
  if (text !== "" && errors.length > 0) {
    const shape =
      field.type === "multi_select" && field.format === "owner_name"
        ? "is not a repository; expected owner/name, then press Enter to add it."
        : "has not been added; press Enter to add it.";
    return [`“${text}” ${shape}`];
  }
  return errors.map((message) => `${field.label} ${message}`);
}

/** The ids that describe a field: its help, then its error when there is one. */
function describedBy(
  id: string,
  field: SchemaField,
  messages: string[],
): string | undefined {
  return (
    [field.help && `${id}-help`, messages.length > 0 && `${id}-error`]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

function MultiSelectField({
  field,
  value,
  errors,
  disabled,
  loadOptions,
  onChange,
}: {
  field: MultiSelect;
  value: string[];
  errors: string[];
  disabled: boolean;
  loadOptions: LoadOptions;
  onChange: (value: string[]) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ChoiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");
  const [refused, setRefused] = useState("");
  const requests = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Inside the field or its suggestions, which render in a portal. */
  const inside = (node: Node | null) =>
    node !== null &&
    (container.current?.contains(node) === true ||
      panel.current?.contains(node) === true);
  const full = value.length >= field.max_items;
  const dynamic = field.options.source === "dynamic";

  // The loader is recreated on every render and sees the current rules (the
  // chosen repositories shape the label options), but typing, not a new
  // loader, is what asks again.
  const load = useEffectEvent((key: string, text: string) =>
    loadOptions(key, text),
  );
  const optionsSource = field.options.source;
  useEffect(() => {
    if (!open || optionsSource !== "dynamic") return;
    const request = ++requests.current;
    const timer = window.setTimeout(() => {
      load(field.key, query.trim())
        .then((options) => {
          if (request !== requests.current) return;
          setSuggestions(options);
          setFailure("");
        })
        .catch((reason: unknown) => {
          if (request !== requests.current) return;
          setSuggestions([]);
          setFailure(failureText(reason, "load suggestions"));
        })
        .finally(() => {
          if (request === requests.current) setLoading(false);
        });
    }, SUGGESTION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, field.key, optionsSource]);

  // One list at a time, and a press anywhere outside the field closes its list
  // (focus alone is not reliable: a pressed button may not take focus).
  useEffect(() => {
    if (!open) return;
    const otherOpened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    const pressed = (event: Event) => {
      const target = event.target as Node;
      if (
        !container.current?.contains(target) &&
        !panel.current?.contains(target)
      )
        setOpen(false);
    };
    window.addEventListener(OPENED, otherOpened);
    document.addEventListener("pointerdown", pressed, true);
    return () => {
      window.removeEventListener(OPENED, otherOpened);
      document.removeEventListener("pointerdown", pressed, true);
    };
  }, [open, id]);

  /** Opens the suggestions; a dynamic list shows a pending state until it loads. */
  function show() {
    window.dispatchEvent(new CustomEvent(OPENED, { detail: id }));
    setOpen(true);
    if (dynamic) setLoading(true);
  }

  function add(item: string) {
    const text = item.trim();
    if (!text || full || value.includes(text)) return;
    // Refused here, keeping the text to correct, rather than sent and turned
    // into a chip that the save would then reject.
    const problem = formatProblem(field, text);
    if (problem) {
      setRefused(problem);
      return;
    }
    setRefused("");
    onChange([...value, text]);
    setQuery("");
    setOpen(false);
  }

  const offered =
    field.options.source === "static"
      ? field.options.options.filter((option) => {
          const needle = query.trim().toLowerCase();
          return (
            option.label.toLowerCase().includes(needle) ||
            option.value.toLowerCase().includes(needle)
          );
        })
      : suggestions;
  const available = offered.filter((option) => !value.includes(option.value));
  const messages = fieldMessages(field, errors, query, refused);
  /** Arrow keys move through the suggestions; they live in a portal. */
  function moveFocus(from: Element | null, step: 1 | -1) {
    const options = Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const at = from ? options.indexOf(from as HTMLButtonElement) : -1;
    const next = at + step;
    if (next < 0) inputRef.current?.focus();
    else options[Math.min(next, options.length - 1)]?.focus();
  }
  return (
    <div
      ref={container}
      className="source-field"
      data-field={field.key}
      onKeyDown={(event) => {
        // Escape closes only the foremost surface: this list, not the page.
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          inputRef.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!inside(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Label htmlFor={id}>
        {field.label}
        {!field.required && <span className="source-required">Optional</span>}
      </Label>
      <Popover open={open && !full}>
        <PopoverAnchor asChild>
          <div className="source-chip-input">
            {value.length > 0 && (
              <ul
                className="source-chips"
                aria-label={`Selected ${field.label}`}
              >
                {value.map((item) => (
                  <li key={item} className="source-chip">
                    <Badge>{item}</Badge>
                    <button
                      type="button"
                      aria-label={`Remove ${item}`}
                      disabled={disabled}
                      onClick={() => onChange(value.filter((v) => v !== item))}
                    >
                      <X aria-hidden="true" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Input
              ref={inputRef}
              id={id}
              value={query}
              disabled={disabled || full}
              placeholder={
                field.key === "repositories"
                  ? value.length > 0
                    ? "Add another repository"
                    : "e.g. acme/billing-api"
                  : field.key === "labels"
                    ? "e.g. bug, payments"
                    : "Search or type, then press Enter"
              }
              aria-describedby={describedBy(id, field, messages)}
              aria-invalid={messages.length > 0 || undefined}
              onFocus={() => {
                if (!open) show();
              }}
              onChange={(event) => {
                setQuery(event.target.value);
                setRefused("");
                show();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (field.allow_custom) add(query);
                } else if (event.key === "ArrowDown" && open) {
                  event.preventDefault();
                  moveFocus(null, 1);
                }
              }}
            />
          </div>
        </PopoverAnchor>
        {/* Portaled with the menu elevation; it flips above rather than run
            under the save bar stuck to the panel's foot (set SR-04). Focus
            stays in the field: the list is reached with the arrow keys. */}
        <PopoverContent
          ref={panel}
          variant="list"
          side="bottom"
          align="start"
          role="group"
          aria-label={`${field.label} suggestions`}
          collisionPadding={{ top: 16, right: 16, bottom: 72, left: 16 }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(
                document.activeElement,
                event.key === "ArrowDown" ? 1 : -1,
              );
            }
          }}
        >
          <div className="source-suggestions">
            {loading && <p className="source-suggestions-note">Searching…</p>}
            {!loading && failure && <FieldError>{failure}</FieldError>}
            {!loading && !failure && available.length === 0 && (
              <p className="source-suggestions-note">
                {query.trim() === ""
                  ? "Start typing to search."
                  : "No suggestions."}
              </p>
            )}
            {!loading && available.length > 0 && (
              <ul>
                {available.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      onClick={() => add(option.value)}
                      aria-label={`Add ${option.label}`}
                    >
                      <span>{option.label}</span>
                      {option.description && (
                        <span className="source-suggestions-meta">
                          {option.description}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {full && (
        <p className="source-field-note">
          {`Up to ${field.max_items} ${field.label.toLowerCase()} can be selected.`}
        </p>
      )}
      <FieldNote
        id={id}
        field={field}
        errors={errors}
        pending={query}
        refused={refused}
      />
    </div>
  );
}

/**
 * Renders a connector's settings schema: text fields and selectors with
 * dynamic options. It holds no provider knowledge; the core validates the
 * result, so desktop and CLI accept the same input.
 */
export function SchemaForm({
  fields,
  draft,
  errors,
  disabled,
  loadOptions,
  onChange,
}: {
  fields: SchemaField[];
  draft: Draft;
  errors: Record<string, string[]>;
  disabled: boolean;
  loadOptions: LoadOptions;
  onChange: (key: string, value: string | string[]) => void;
}) {
  return (
    <div className="source-form">
      {fields.map((field) => {
        const fieldErrors = errors[field.key] ?? [];
        if (field.type === "multi_select") {
          const value = draft[field.key];
          return (
            <MultiSelectField
              key={field.key}
              field={field}
              value={Array.isArray(value) ? value : []}
              errors={fieldErrors}
              disabled={disabled}
              loadOptions={loadOptions}
              onChange={(next) => onChange(field.key, next)}
            />
          );
        }
        return (
          <TextField
            key={field.key}
            field={field}
            value={
              typeof draft[field.key] === "string"
                ? (draft[field.key] as string)
                : ""
            }
            errors={fieldErrors}
            disabled={disabled}
            onChange={(next) => onChange(field.key, next)}
          />
        );
      })}
    </div>
  );
}

function TextField({
  field,
  value,
  errors,
  disabled,
  onChange,
}: {
  field: Extract<SchemaField, { type: "text" }>;
  value: string;
  errors: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="source-field" data-field={field.key}>
      <Label htmlFor={id}>
        {field.label}
        {!field.required && <span className="source-required">Optional</span>}
      </Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={
          field.key === "assignee"
            ? "e.g. octocat"
            : field.placeholder
              ? `e.g. ${field.placeholder}`
              : undefined
        }
        aria-describedby={describedBy(
          id,
          field,
          fieldMessages(field, errors, "", ""),
        )}
        aria-invalid={errors.length > 0 || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldNote id={id} field={field} errors={errors} />
    </div>
  );
}
