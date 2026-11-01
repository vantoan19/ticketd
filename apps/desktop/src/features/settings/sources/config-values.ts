import type { SchemaField, SourceConfig } from "@/lib/api/sources";

/** What a form holds: text for a text field, a list for a selector. */
export type Draft = Record<string, string | string[]>;

export function draftFromConfig(
  fields: SchemaField[],
  config: SourceConfig | undefined,
): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    const value = config?.[field.key];
    if (field.type === "multi_select")
      draft[field.key] = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    else draft[field.key] = typeof value === "string" ? value : "";
  }
  return draft;
}

/**
 * The configuration a draft stands for: empty fields are left out and text is
 * trimmed, matching how the core normalizes what it saves.
 */
export function configFromDraft(
  fields: SchemaField[],
  draft: Draft,
): SourceConfig {
  const config: SourceConfig = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (Array.isArray(value)) {
      const items = value.map((item) => item.trim()).filter(Boolean);
      if (items.length > 0) config[field.key] = [...new Set(items)];
    } else if (typeof value === "string" && value.trim() !== "") {
      config[field.key] = value.trim();
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
