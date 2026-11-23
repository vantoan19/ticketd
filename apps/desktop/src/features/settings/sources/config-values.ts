import type { SchemaField, SourceConfig } from "@/lib/api/sources";

/** What a form holds: text for a text field, a list for a selector. */
export type Draft = Record<string, string | string[]>;

export function draftFromConfig(
  fields: SchemaField[],
  config: SourceConfig | undefined,
): Draft {
  const draft: Draft = Object.create(null) as Draft;
  for (const field of fields) {
    const value = config?.[field.key];
    if (field.type === "multi_select")
      draft[field.key] = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    else if (field.type === "text")
      draft[field.key] = typeof value === "string" ? value : "";
    else if (field.type === "secret") draft[field.key] = "";
  }
  return draft;
}

/** A chained condition only applies when each preceding input has a value. */
export function activeFields(
  fields: SchemaField[],
  draft: Draft,
  storedSecrets: readonly string[] = [],
) {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return fields.filter((field) => {
    const seen = new Set([field.key]);
    let dependency = field.show_if;
    while (dependency) {
      const value = draft[dependency];
      const parent = byKey.get(dependency);
      if (!parent || seen.has(dependency)) return false;
      const populated =
        (parent.type === "secret" && storedSecrets.includes(dependency)) ||
        (Array.isArray(value)
          ? value.some((item) => item.trim() !== "")
          : typeof value === "string" && value.trim() !== "");
      if (!populated) return false;
      seen.add(dependency);
      dependency = parent.show_if;
    }
    return true;
  });
}

/**
 * The configuration a draft stands for: empty fields are left out and text is
 * trimmed, matching how the core normalizes what it saves.
 */
export function configFromDraft(
  fields: SchemaField[],
  draft: Draft,
  storedSecrets: readonly string[] = [],
): SourceConfig {
  const config: SourceConfig = Object.create(null) as SourceConfig;
  for (const field of activeFields(fields, draft, storedSecrets)) {
    const value = draft[field.key];
    if (field.type === "multi_select" && Array.isArray(value)) {
      const items = value.map((item) => item.trim()).filter(Boolean);
      if (items.length > 0) config[field.key] = [...new Set(items)];
    } else if (
      (field.type === "text" || field.type === "secret") &&
      typeof value === "string" &&
      value.trim() !== ""
    ) {
      config[field.key] = field.type === "secret" ? value : value.trim();
    }
  }
  return config;
}

/** A stable text form of a configuration, for comparing drafts to saved values. */
export function configKey(config: SourceConfig): string {
  return JSON.stringify(
    Object.keys(config)
      .sort()
      .map((key) => [key, config[key]]),
  );
}
