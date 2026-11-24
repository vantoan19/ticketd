import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CircleAlert } from "lucide-react";
import type { SourceCounts, Ticket } from "@/lib/api/client";
import { providerName, type RefreshReport } from "@/lib/api/sources";
import { useSourceActivity } from "./source-activity";
import { useSources } from "@/features/settings/sources/use-sources";
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
  const { entries } = useSources();
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
            label: providerName(provider, entries),
            count: counts?.providers[provider] ?? 0,
          })),
          { value: "local", label: "Local", count: counts?.local ?? 0 },
        ]}
      />
    </div>
  );
}

/**
 * Running state and command failures beside the list's Refresh button.
 * Persisted source health stays in the rail and footer; a bridge or workspace
 * error may happen before that health can be recorded.
 */
export function SourceRefresh({
  providers,
  state,
  tickets = [],
}: {
  providers: string[];
  state: {
    running: boolean;
    report: RefreshReport | null;
    error: string;
    errorAt?: string | null;
  };
  /** The listed tickets: a failure about one the source no longer owns is stale. */
  tickets?: Ticket[];
}) {
  const activity = useSourceActivity();
  const { entries } = useSources();
  const name = providers
    .map((provider) => providerName(provider, entries))
    .join(", ");
  const running = activity.refreshing || state.running;
  const failedAt = state.errorAt ? Date.parse(state.errorAt) : null;
  const superseded =
    failedAt !== null &&
    providers.length > 0 &&
    providers.every((provider) => {
      const attempted = activity.sources.find(
        (source) => source.provider === provider,
      )?.last_attempt_at;
      return attempted && Date.parse(attempted) > failedAt;
    });
  if (!running && state.error && !superseded)
    return (
      <span className="source-refresh" role="status">
        <span className="sr-only">
          Could not refresh {name}: {state.error}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${name} refresh failed`}
            >
              <CircleAlert />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end">
            <p>Could not refresh {name}.</p>
            <p className="source-caption">{state.error}</p>
            <p className="source-caption">
              Saved tickets are still available. Try Refresh again.
            </p>
          </PopoverContent>
        </Popover>
      </span>
    );
  // Resting freshness and failures live in the rail and footer. A past report
  // must not become a permanent list banner after takeover or a later sync.
  void tickets;
  return (
    <span className="source-refresh" role="status">
      {running ? `Refreshing ${name}…` : ""}
    </span>
  );
}
