import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ChoiceOption, SchemaField } from "@/lib/api/sources";
import type { Draft } from "@/features/settings/sources/config-values";

const SUGGESTION_DELAY_MS = 250;

type MultiSelect = Extract<SchemaField, { type: "multi_select" }>;

/** Loads dynamic options for a field from the connector, given what was typed. */
export type LoadOptions = (
  field: string,
  query: string,
) => Promise<ChoiceOption[]>;

function FieldNote({
  id,
  field,
  errors,
}: {
  id: string;
  field: SchemaField;
  errors: string[];
}) {
  return (
    <>
      {field.help && (
        <p className="settings-hint" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {errors.map((message) => (
        <p key={message} role="alert" className="settings-failure">
          {field.label} {message}
        </p>
      ))}
    </>
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
  const requests = useRef(0);
  const full = value.length >= field.max_items;
  const dynamic = field.options.source === "dynamic";

  useEffect(() => {
    if (!open) return;
    if (field.options.source === "static") {
      const needle = query.trim().toLowerCase();
      setSuggestions(
        field.options.options.filter(
          (option) =>
            option.label.toLowerCase().includes(needle) ||
            option.value.toLowerCase().includes(needle),
        ),
      );
      return;
    }
    const request = ++requests.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      loadOptions(field.key, query.trim())
        .then((options) => {
          if (request !== requests.current) return;
          setSuggestions(options);
          setFailure("");
        })
        .catch((reason: unknown) => {
          if (request !== requests.current) return;
          setSuggestions([]);
          setFailure(
            reason instanceof Error
              ? reason.message
              : "Could not load suggestions.",
          );
        })
        .finally(() => {
          if (request === requests.current) setLoading(false);
        });
    }, SUGGESTION_DELAY_MS);
    return () => window.clearTimeout(timer);
    // The options source and loader are stable for a field; re-query on typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, field.key]);

  function add(item: string) {
    const text = item.trim();
    if (!text || full || value.includes(text)) return;
    onChange([...value, text]);
    setQuery("");
  }

  const available = suggestions.filter(
    (option) => !value.includes(option.value),
  );
  return (
    <div
      className="source-field"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="source-required"> (required)</span>}
      </Label>
      {value.length > 0 && (
        <ul className="source-chips" aria-label={`Selected ${field.label}`}>
          {value.map((item) => (
            <li key={item} className="source-chip">
              <span>{item}</span>
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
        id={id}
        value={query}
        disabled={disabled || full}
        placeholder={
          field.allow_custom
            ? dynamic
              ? "Search or type, then press Enter"
              : "Type, then press Enter"
            : "Search"
        }
        aria-describedby={field.help ? `${id}-help` : undefined}
        aria-invalid={errors.length > 0 || undefined}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (field.allow_custom) add(query);
          } else if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {full && (
        <p className="settings-hint">
          {`Up to ${field.max_items} ${field.label.toLowerCase()} can be selected.`}
        </p>
      )}
      {open && !full && (
        <div
          className="source-suggestions"
          aria-label={`${field.label} suggestions`}
        >
          {loading && <p className="settings-hint">Searching…</p>}
          {!loading && failure && (
            <p role="alert" className="settings-failure">
              {failure}
            </p>
          )}
          {!loading && !failure && available.length === 0 && (
            <p className="settings-hint">
              {query.trim() === ""
                ? "Start typing to search."
                : "No suggestions."}
            </p>
          )}
          {!loading && (
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
                      <span className="settings-hint">
                        {option.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <FieldNote id={id} field={field} errors={errors} />
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
    <div className="source-field">
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="source-required"> (required)</span>}
      </Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={field.placeholder ?? undefined}
        aria-describedby={field.help ? `${id}-help` : undefined}
        aria-invalid={errors.length > 0 || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldNote id={id} field={field} errors={errors} />
    </div>
  );
}
