import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { failureText } from "@/lib/api/describe-failure";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type {
  ChoiceOption,
  FieldPresentation,
  SchemaField,
} from "@/lib/api/sources";
import {
  activeFields,
  type Draft,
} from "@/features/settings/sources/config-values";
import { SourceLink } from "@/features/tickets/SourceLink";

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
  presentation,
  target,
  value,
  errors,
  disabled,
  loadOptions,
  onChange,
}: {
  field: MultiSelect;
  presentation: FieldPresentation | undefined;
  target: boolean;
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
  const [choiceLabels, setChoiceLabels] = useState(
    () => new Map<string, string>(),
  );
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

  const rememberSelected = useEffectEvent((options: ChoiceOption[]) => {
    const selected = options.filter((option) => value.includes(option.value));
    if (selected.length === 0) return;
    setChoiceLabels((current) => {
      const labels = new Map(current);
      for (const option of selected) labels.set(option.value, option.label);
      return labels;
    });
  });

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
          rememberSelected(options);
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

  // A reopened form knows the saved IDs. Use one bounded options read to
  // recover their labels for fixed choices without waiting for the list to open.
  const hasUnlabelledChoices =
    dynamic &&
    !field.allow_custom &&
    value.some((item) => !choiceLabels.has(item));
  useEffect(() => {
    if (!hasUnlabelledChoices) return;
    let current = true;
    void load(field.key, "").then(
      (options) => {
        if (current) rememberSelected(options);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [field.key, hasUnlabelledChoices]);

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

  function add(item: string, label?: string) {
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
    if (label !== undefined)
      setChoiceLabels((current) => new Map(current).set(text, label));
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
    <Field
      ref={container}
      className="min-w-0 grow basis-60 data-[target=true]:basis-full"
      data-field={field.key}
      data-target={target || undefined}
      data-invalid={messages.length > 0 || undefined}
      data-disabled={disabled || undefined}
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
      <FieldLabel htmlFor={id}>
        {field.label}
        <span className="source-required" aria-hidden="true">
          {field.required ? "Required" : "Optional"}
        </span>
      </FieldLabel>
      <Popover open={open && !full}>
        <PopoverAnchor asChild>
          <div className="source-chip-input">
            {value.length > 0 && (
              <ul
                className="source-chips"
                aria-label={`Selected ${field.label}`}
              >
                {value.map((item) => {
                  const label =
                    (field.options.source === "static"
                      ? field.options.options.find(
                          (option) => option.value === item,
                        )?.label
                      : choiceLabels.get(item)) ?? item;
                  return (
                    <li key={item} className="source-chip">
                      <Badge>{label}</Badge>
                      <button
                        type="button"
                        aria-label={`Remove ${label}`}
                        disabled={disabled}
                        onClick={() =>
                          onChange(value.filter((v) => v !== item))
                        }
                      >
                        <X aria-hidden="true" size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Input
              ref={inputRef}
              id={id}
              value={query}
              disabled={disabled || full}
              placeholder={
                (value.length > 0
                  ? presentation?.additional_placeholder
                  : undefined) ??
                presentation?.placeholder ??
                field.placeholder ??
                "Search or type, then press Enter"
              }
              aria-describedby={describedBy(id, field, messages)}
              aria-invalid={messages.length > 0 || undefined}
              aria-required={field.required || undefined}
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
                      onClick={() => add(option.value, option.label)}
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
    </Field>
  );
}

/**
 * Renders a connector's settings schema: text fields and selectors with
 * dynamic options. It holds no provider knowledge; the core validates the
 * result, so desktop and CLI accept the same input.
 */
export function SchemaForm({
  fields,
  presentation,
  targetField,
  draft,
  errors,
  formErrors = [],
  storedSecrets = [],
  secretsOnly = false,
  disabled,
  loadOptions,
  onChange,
}: {
  fields: SchemaField[];
  presentation?: Record<string, FieldPresentation> | undefined;
  targetField?: string | undefined;
  draft: Draft;
  errors: Record<string, string[]>;
  formErrors?: string[];
  storedSecrets?: readonly string[];
  secretsOnly?: boolean;
  disabled: boolean;
  loadOptions: LoadOptions;
  onChange: (key: string, value: string | string[]) => void;
}) {
  const advancedId = useId();
  const [expanded, setExpanded] = useState(false);
  const visible = activeFields(fields, draft, storedSecrets).filter(
    (field) => !secretsOnly || field.type === "secret",
  );
  const advanced = secretsOnly ? [] : visible.filter((field) => field.advanced);
  const hasAdvancedErrors = advanced.some((field) => errors[field.key]?.length);
  const showAdvanced = expanded || hasAdvancedErrors;

  function renderField(field: SchemaField) {
    const value = draft[field.key];
    const fieldErrors = Object.hasOwn(errors, field.key)
      ? (errors[field.key] ?? [])
      : [];
    switch (field.type) {
      case "link":
        return <SetupLink key={field.key} field={field} />;
      case "multi_select":
        return (
          <MultiSelectField
            key={field.key}
            field={field}
            presentation={presentation?.[field.key]}
            target={targetField === field.key}
            value={Array.isArray(value) ? value : []}
            errors={fieldErrors}
            disabled={disabled}
            loadOptions={loadOptions}
            onChange={(next) => onChange(field.key, next)}
          />
        );
      case "text":
      case "secret":
        return (
          <TextField
            key={field.key}
            field={field}
            presentation={presentation?.[field.key]}
            target={targetField === field.key}
            value={typeof value === "string" ? value : ""}
            stored={
              field.type === "secret" && storedSecrets.includes(field.key)
            }
            errors={fieldErrors}
            disabled={disabled}
            onChange={(next) => onChange(field.key, next)}
          />
        );
    }
  }

  return (
    <>
      <FieldError errors={formErrors.map((message) => ({ message }))} />
      <FieldGroup className="flex-row flex-wrap">
        {visible
          .filter((field) => secretsOnly || !field.advanced)
          .map(renderField)}
      </FieldGroup>
      {advanced.length > 0 && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            aria-expanded={showAdvanced}
            aria-controls={advancedId}
            disabled={hasAdvancedErrors}
            onClick={() => setExpanded(!expanded)}
          >
            {showAdvanced ? (
              <ChevronDown data-icon="inline-start" />
            ) : (
              <ChevronRight data-icon="inline-start" />
            )}
            Advanced settings
          </Button>
          <div id={advancedId} hidden={!showAdvanced}>
            <FieldGroup className="flex-row flex-wrap">
              {advanced.map(renderField)}
            </FieldGroup>
          </div>
        </>
      )}
    </>
  );
}

function SetupLink({
  field,
}: {
  field: Extract<SchemaField, { type: "link" }>;
}) {
  const url = safeSetupUrl(field.url);
  return (
    <div
      className="flex min-w-0 grow basis-60 flex-col gap-2"
      data-field={field.key}
    >
      {url ? (
        <SourceLink url={url}>{field.label}</SourceLink>
      ) : (
        <span>{field.label}</span>
      )}
      {field.help && <p className="source-field-note">{field.help}</p>}
    </div>
  );
}

function safeSetupUrl(text: string) {
  if (!text.startsWith("https://") || /[\\\s]/u.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function TextField({
  field,
  presentation,
  target,
  value,
  errors,
  stored,
  disabled,
  onChange,
}: {
  field: Extract<SchemaField, { type: "text" | "secret" }>;
  presentation: FieldPresentation | undefined;
  target: boolean;
  value: string;
  errors: string[];
  stored: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field
      className="min-w-0 grow basis-60 data-[target=true]:basis-full"
      data-field={field.key}
      data-target={target || undefined}
      data-invalid={errors.length > 0 || undefined}
      data-disabled={disabled || undefined}
    >
      <FieldLabel htmlFor={id}>
        {field.label}
        <span className="source-required" aria-hidden="true">
          {field.required ? "Required" : "Optional"}
        </span>
      </FieldLabel>
      <Input
        id={id}
        type={field.type === "secret" ? "password" : "text"}
        autoComplete={field.type === "secret" ? "new-password" : undefined}
        value={value}
        disabled={disabled}
        placeholder={
          stored
            ? "Credential saved"
            : (presentation?.placeholder ?? field.placeholder ?? undefined)
        }
        aria-describedby={describedBy(
          id,
          field,
          fieldMessages(field, errors, "", ""),
        )}
        aria-invalid={errors.length > 0 || undefined}
        aria-required={(field.required && !stored) || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldNote id={id} field={field} errors={errors} />
    </Field>
  );
}
