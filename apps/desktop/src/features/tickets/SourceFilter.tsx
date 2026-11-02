import { SegmentedControl } from "@/components/ui/segmented-control";
import type { SourceCounts } from "@/lib/api/client";
import type { RefreshReport } from "@/lib/api/sources";
import { useSourceActivity } from "./source-activity";
import { ago, providerName } from "./ticket-source";
import "./ticket-list.css";

/**
 * All, each configured provider, and Local, with counts. It narrows the status
 * groups; it never regroups the list by source.
 */
export function SourceFilter({
  value,
  onChange,
  counts,
  providers,
}: {
  value: string;
  onChange: (value: string) => void;
  counts: SourceCounts | null;
  /** Providers with a saved configuration, so the filter appears before the first import. */
  providers: string[];
}) {
  const known = [
    ...new Set([...providers, ...Object.keys(counts?.providers ?? {})]),
  ].sort();
  const withCount = (label: string, count: number | undefined) =>
    count === undefined ? label : `${label} ${count}`;
  return (
    <SegmentedControl
      className="source-filter"
      aria-label="Ticket source"
      value={value}
      onValueChange={onChange}
      options={[
        { value: "all", label: withCount("All", counts?.all) },
        ...known.map((provider) => ({
          value: provider,
          label: withCount(
            providerName(provider),
            counts?.providers[provider] ?? 0,
          ),
        })),
        { value: "local", label: withCount("Local", counts?.local) },
      ]}
    />
  );
}

/**
 * What the sources did last, beside the list's one Refresh button. Background
 * refreshes are plain text, not announced; only the outcome of a refresh the
 * person started is.
 */
export function SourceRefresh({
  providers,
  state,
}: {
  providers: string[];
  state: { running: boolean; report: RefreshReport | null; error: string };
}) {
  const activity = useSourceActivity();
  const running = state.running || activity.refreshing;
  const synced = activity.sources
    .map((status) => status.last_refreshed_at)
    .filter((time): time is string => Boolean(time))
    .sort()
    .at(-1);
  const name = providers.map(providerName).join(", ");
  const failures = state.report?.failures ?? [];
  return (
    <div className="source-refresh">
      {running && <span>Refreshing {name}…</span>}
      {!running && !state.report && !state.error && synced && (
        <span>Synced {ago(synced)}</span>
      )}
      {!running && state.report && failures.length === 0 && (
        <span role="status">
          {state.report.imported.length} new, {state.report.updated.length}{" "}
          updated
        </span>
      )}
      {!running && failures.length > 0 && (
        <span role="alert">
          Could not refresh {name}: {failures[0]?.message} Saved content is
          unchanged.
        </span>
      )}
      {!running && state.error && (
        <span role="alert">
          Could not refresh {name}: {state.error} Saved content is unchanged.
        </span>
      )}
    </div>
  );
}
