import { SegmentedControl } from "@/components/ui/segmented-control";
import type { SourceCounts, Ticket } from "@/lib/api/client";
import type { RefreshReport } from "@/lib/api/sources";
import { useSourceActivity } from "./source-activity";
import { providerName } from "./ticket-source";
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

  return (
    <div className="source-filter">
      <SegmentedControl
        aria-label="Ticket source"
        value={value}
        onValueChange={onChange}
        options={[
          { value: "all", label: "All", count: counts?.all ?? 0 },
          ...known.map((provider) => ({
            value: provider,
            label: providerName(provider),
            count: counts?.providers[provider] ?? 0,
          })),
          { value: "local", label: "Local", count: counts?.local ?? 0 },
        ]}
      />
    </div>
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
  tickets = [],
}: {
  providers: string[];
  state: { running: boolean; report: RefreshReport | null; error: string };
  /** The listed tickets: a failure about one the source no longer owns is stale. */
  tickets?: Ticket[];
}) {
  const activity = useSourceActivity();
  const name = providers.map(providerName).join(", ");
  const running = activity.refreshing || state.running;
  // Resting freshness and failures live in the rail and footer. A past report
  // must not become a permanent list banner after takeover or a later sync.
  void tickets;
  return (
    <span className="source-refresh" role="status">
      {running ? `Refreshing ${name}…` : ""}
    </span>
  );
}
