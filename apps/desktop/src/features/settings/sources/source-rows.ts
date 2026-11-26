import type { SourceEntry, SourceStatus } from "@/lib/api/sources";
import { relativeDateTime } from "@/lib/format";

/** The core says these when the account itself is the problem. */
export const SIGNED_OUT: readonly string[] = [
  "unauthenticated",
  "not_signed_in",
  "forbidden",
];

export type SourceRowStatus =
  "Connected" | "Not connected" | "Needs sign-in" | "Unavailable";

export type SourceRow = {
  /** The Settings page id: `source-<id>`. */
  id: string;
  name: string;
  /** "Built in" or "Custom". */
  origin: string;
  development: boolean;
  status: SourceRowStatus;
  signsInWith: string;
  /** What arrives ("3 repositories"), or null before anything is connected. */
  bringsIn: string | null;
  /** "Refreshed 4 min ago", when the source has something to refresh. */
  refreshed: string | null;
  entry: SourceEntry;
};

const BUILT_IN = new Set(["github", "linear"]);

export function withArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "An" : "A"} ${phrase}`;
}

/** Who the source signs in as, in the person's words, from what the connector declares. */
export function signsInWith(entry: SourceEntry): string {
  const { provider, schema } = entry.connector;
  if (provider === "github") return "Your gh login";
  const secret = schema.fields.find((field) => field.type === "secret");
  if (!secret) return "No sign-in";
  const label = secret.label.trim();
  // "Personal API key" reads "An API key"; a label with no key or token stays as it is.
  const kind = label.match(/\b(API )?(key|token)\b/i);
  const phrase = kind
    ? `${kind[1] ? "API " : ""}${kind[2]!.toLowerCase()}`
    : label.charAt(0).toLowerCase() + label.slice(1);
  return withArticle(phrase);
}

export function plural(noun: string, count: number): string {
  if (count === 1) return noun;
  return /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}

/** What the saved configuration brings in, counted in the connector's own noun. */
function bringsIn(entry: SourceEntry): string | null {
  const target = entry.connector.presentation?.target;
  const config = entry.saved?.config;
  if (!target || !config) return null;
  const value = config[target.field];
  const count = Array.isArray(value)
    ? value.length
    : typeof value === "string" && value.trim()
      ? 1
      : 0;
  if (count === 0) return null;
  return `${count} ${plural(target.label.toLowerCase(), count)}`;
}

function statusOf(
  entry: SourceEntry,
  health: SourceStatus | undefined,
): SourceRowStatus {
  if (entry.unavailable) return "Unavailable";
  if (!entry.saved) return "Not connected";
  if (health?.error && SIGNED_OUT.includes(health.error.code))
    return "Needs sign-in";
  return "Connected";
}

/** One row per connection, plus one for each source with no connection yet. */
export function sourceRows(
  entries: readonly SourceEntry[],
  health: readonly SourceStatus[],
  now = Date.now(),
): SourceRow[] {
  return entries.map((entry) => {
    const { saved, connector } = entry;
    const id = saved?.id ?? connector.provider;
    const status = health.find((item) =>
      saved?.id
        ? item.connection_id === saved.id
        : item.provider === connector.provider && !item.connection_id,
    );
    const brings = saved ? bringsIn(entry) : null;
    return {
      id,
      name: saved?.name ?? connector.name,
      origin: BUILT_IN.has(connector.provider) ? "Built in" : "Custom",
      development: entry.development === true,
      status: statusOf(entry, status),
      signsInWith: signsInWith(entry),
      bringsIn: brings,
      refreshed:
        saved && !entry.unavailable
          ? status?.last_refreshed_at
            ? `Refreshed ${relativeDateTime(status.last_refreshed_at, now)}`
            : "Not refreshed yet"
          : null,
      entry,
    };
  });
}
