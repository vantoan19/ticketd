import type { GithubIntegration } from "@/lib/api/github";
import { lastGithubRefresh } from "./github-repositories";
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
  entry: SourceEntry | null;
};

const BUILT_IN = new Set(["github", "linear"]);

/** "example-tracker" reads "Example tracker": the program's ID is all that is known before it runs. */
export function nameOfId(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function withArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "An" : "A"} ${phrase}`;
}

/** GitHub signs in through the person's `gh` login, as long as its connector asks for no secret of its own. */
export function signsInWithGh(entry: SourceEntry): boolean {
  const { provider, schema } = entry.connector;
  return (
    provider === "github" &&
    !schema.fields.some(({ type }) => type === "secret")
  );
}

/** Who the source signs in as, in the person's words, from what the connector declares. */
export function signsInWith(entry: SourceEntry): string {
  const { schema } = entry.connector;
  if (signsInWithGh(entry)) return "Your gh login";
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

function githubRow(
  integration: GithubIntegration | null,
  now: number,
): SourceRow {
  const repositories = integration?.repositories ?? [];
  const hosts = integration?.hosts ?? [];
  const repoHosts = new Set(
    repositories.map((row) => row.repository.split("/")[0]?.toLowerCase()),
  );
  const relevant = hosts.filter(({ host }) =>
    repoHosts.has(host.toLowerCase()),
  );
  const logins = [
    ...new Set(hosts.flatMap(({ login }) => (login ? [login] : []))),
  ];
  let status: SourceRowStatus = "Not connected";
  if (relevant.some(({ state }) => state === "not_signed_in"))
    status = "Needs sign-in";
  else if (
    relevant.some(
      ({ state }) => state === "unavailable" || state === "not_installed",
    )
  )
    status = "Unavailable";
  else if (relevant.some(({ state }) => state === "connected"))
    status = "Connected";
  const latest = lastGithubRefresh(repositories);
  return {
    id: "github",
    name: "GitHub",
    origin: "Built in",
    development: false,
    status,
    signsInWith: (!repositories.length && logins.join(", ")) || "Your gh login",
    bringsIn: repositories.length
      ? `${repositories.length} ${plural("repository", repositories.length)}`
      : null,
    refreshed: latest
      ? `Refreshed ${relativeDateTime(latest, now)}`
      : "Not refreshed yet",
    entry: null,
  };
}

/** GitHub has one integration. Other sources show each saved connection. */
export function sourceRows(
  entries: readonly SourceEntry[],
  health: readonly SourceStatus[],
  github: GithubIntegration | null,
  now = Date.now(),
): SourceRow[] {
  const rows: SourceRow[] = entries
    .filter(({ connector }) => connector.provider !== "github")
    .map((entry) => {
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
  if (
    github ||
    entries.some(({ connector }) => connector.provider === "github")
  )
    rows.unshift(githubRow(github, now));
  return rows;
}
